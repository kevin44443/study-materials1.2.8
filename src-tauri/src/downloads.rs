//! 离线缓存（缓冲下载 / 一键下载）。
//!
//! 设计：以「videoId_ep」为单位把一集下载成目录：
//! - `seg_NNNNN.ts`   分片（按 m3u8 顺序编号）
//! - `key_N.bin`      AES-128 key（如上游用到）
//! - `video.mp4`      非 m3u8 直链时整文件
//! - `index.m3u8`     本地播放列表（分片/key 地址已改写为 `hg://…/file?k=`）
//! - `meta.json`      元数据与进度
//!
//! 播放器优先从本地取（`dl_get` 命中即离线可播）；正在播放时前端会静默把当前集
//! 与下一集加入缓冲（`auto: true`），「一键下载」则逐集完整下载全部剧集。

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

static DL_DIR: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

struct Task {
    status: &'static str, // downloading / paused / done / failed / cancelled
    done: usize,
    total: usize,
    cancel: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
}

static TASKS: Lazy<Mutex<std::collections::HashMap<String, Task>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

/// 批量下载队列：单 worker 顺序执行，避免几十集同时拉流把手机带宽与解码器挤爆。
static QUEUE: Lazy<Mutex<VecDeque<(i64, i64, String, String)>>> =
    Lazy::new(|| Mutex::new(VecDeque::new()));
static WORKER_RUNNING: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

/// 自动预缓存（播放过半缓存下一集）的保留上限：超过就按 updated_at 淘汰最旧的 auto 条目。
const AUTO_KEEP: usize = 6;

pub fn bind(dir: &Path) {
    let d = dir.join("downloads");
    let _ = std::fs::create_dir_all(&d);
    *DL_DIR.lock().unwrap() = Some(d);
}

fn dir() -> PathBuf {
    DL_DIR
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| std::env::temp_dir().join("hghub-downloads"))
}

pub fn key_of(video_id: i64, ep: i64) -> String {
    format!("{}_{}", video_id, ep)
}

fn meta_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(key).join("meta.json")
}

fn read_meta(dir: &Path, key: &str) -> Option<Value> {
    let raw = std::fs::read_to_string(meta_path(dir, key)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_meta(dir: &Path, key: &str, meta: &Value) {
    let p = meta_path(dir, key);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(p, serde_json::to_string(meta).unwrap_or_default());
}

fn set_status(key: &str, status: &'static str, done: usize, total: usize) {
    let mut m = TASKS.lock().unwrap();
    let t = m.entry(key.to_string()).or_insert(Task {
        status: "downloading",
        done: 0,
        total: 0,
        cancel: Arc::new(AtomicBool::new(false)),
        pause: Arc::new(AtomicBool::new(false)),
    });
    t.status = status;
    t.done = done;
    t.total = total;
}

/// 开始/继续一个任务：清掉上一次的暂停与取消标记，返回两个控制句柄。
fn begin_task(key: &str) -> (Arc<AtomicBool>, Arc<AtomicBool>) {
    let mut m = TASKS.lock().unwrap();
    let t = m.entry(key.to_string()).or_insert(Task {
        status: "downloading",
        done: 0,
        total: 0,
        cancel: Arc::new(AtomicBool::new(false)),
        pause: Arc::new(AtomicBool::new(false)),
    });
    t.status = "downloading";
    t.cancel = Arc::new(AtomicBool::new(false));
    t.pause = Arc::new(AtomicBool::new(false));
    (t.cancel.clone(), t.pause.clone())
}

fn emit_progress(app: &AppHandle, key: &str, status: &str, done: usize, total: usize, auto: bool) {
    let (video_id, ep) = key.split_once('_').unwrap_or((key, "0"));
    let _ = app.emit(
        "dl-progress",
        json!({
            "key": key,
            "video_id": video_id.parse::<i64>().unwrap_or(0),
            "ep": ep.parse::<i64>().unwrap_or(0),
            "status": status,
            "done": done,
            "total": total,
            /* auto=true 是「播放过半自动预缓存下一集」，前端不当作下载展示 */
            "auto": auto,
        }),
    );
}

/// 绝对化 m3u8 内的相对地址。
fn absolutize(base: &str, target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    if let Ok(b) = url::Url::parse(base) {
        if let Ok(j) = b.join(target) {
            return j.to_string();
        }
    }
    target.to_string()
}

fn enc(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

async fn fetch_m3u8_text(url: &str) -> Result<String, String> {
    let (ctype, bytes) = crate::net::fetch_bytes(url).await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "播放列表不是 UTF-8".to_string())?;
    let text = text.trim_start_matches('\u{feff}').to_string();
    if !text.starts_with("#EXTM3U") {
        return Err("响应不是 HLS 播放列表".to_string());
    }
    // 主清单 → 取第一个子清单再取一层
    if text.contains("#EXT-X-STREAM-INF") {
        let variant = text
            .lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .find(|l| !l.trim().is_empty())
            .map(|l| absolutize(url, l.trim()));
        if let Some(v) = variant {
            let nested_is_pl = ctype
                .as_deref()
                .map(|c| c.to_ascii_lowercase().contains("mpegurl"))
                .unwrap_or(true);
            if nested_is_pl {
                return Box::pin(fetch_m3u8_text(&v)).await;
            }
        }
    }
    Ok(text)
}

async fn run_download(
    app: AppHandle,
    key: String,
    video_id: i64,
    ep: i64,
    url: String,
    title: String,
    auto: bool,
) {
    let root = dir();
    let d = root.join(&key);
    let (cancel, pause) = begin_task(&key);

    /* 开跑就先落一份 meta：离线视频页/选集面板在没下完时也能看到条目与标题 */
    {
        let mut meta = read_meta(&root, &key).unwrap_or(json!({}));
        meta["video_id"] = json!(video_id);
        meta["ep"] = json!(ep);
        meta["title"] = json!(title);
        meta["url"] = json!(url);
        meta["status"] = json!("downloading");
        meta["auto"] = json!(auto);
        meta["done"] = meta.get("done").cloned().unwrap_or(json!(0));
        meta["total"] = meta.get("total").cloned().unwrap_or(json!(0));
        meta["updated_at"] = json!(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs()).unwrap_or(0));
        write_meta(&root, &key, &meta);
    }
    emit_progress(
        &app,
        &key,
        "downloading",
        read_meta(&root, &key).and_then(|m| m.get("done").and_then(|v| v.as_u64())).unwrap_or(0) as usize,
        read_meta(&root, &key).and_then(|m| m.get("total").and_then(|v| v.as_u64())).unwrap_or(0) as usize,
        auto,
    );

    let result: Result<(usize, u64), String> = async {
        std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        let local_origin = crate::media::LOCAL_ORIGIN;
        let mut total_size: u64 = 0;

        if !url.to_ascii_lowercase().contains(".m3u8") {
            // 直链（mp4 等）：整文件下载
            let (_, bytes) = crate::net::fetch_bytes(&url).await?;
            total_size = bytes.len() as u64;
            std::fs::write(d.join("video.mp4"), &bytes).map_err(|e| e.to_string())?;
            let pl = format!(
                "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:3600\n{}/file?k={}/video.mp4\n#EXT-X-ENDLIST\n",
                local_origin, key
            );
            std::fs::write(d.join("index.m3u8"), pl).map_err(|e| e.to_string())?;
            return Ok((1, total_size));
        }

        let text = fetch_m3u8_text(&url).await?;
        let mut lines: Vec<String> = Vec::new();
        let mut segs: Vec<String> = Vec::new();
        let mut keys: Vec<String> = Vec::new(); // 有序去重的 key 地址

        for raw in text.lines() {
            let line = raw.trim_end().to_string();
            if line.is_empty() {
                continue;
            }
            if line.starts_with('#') {
                if line.contains("URI=\"") {
                    // KEY / MAP 等：绝对化后登记下载，稍后改写为本地地址
                    if let Some(i) = line.find("URI=\"") {
                        let rest = &line[i + 5..];
                        if let Some(end) = rest.find('"') {
                            let uri = absolutize(&url, &rest[..end]);
                            if line.starts_with("#EXT-X-KEY") && !keys.contains(&uri) {
                                keys.push(uri.clone());
                            }
                            let idx = keys.iter().position(|k| k == &uri).unwrap_or(0);
                            let rewritten =
                                format!("{}URI=\"{}/file?k={}/key_{}.bin\"", &line[..i], local_origin, key, idx);
                            lines.push(rewritten);
                            continue;
                        }
                    }
                }
                lines.push(line);
            } else {
                segs.push(absolutize(&url, line.trim()));
            }
        }

        // 下载 key
        for (i, ku) in keys.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err("__cancelled__".to_string());
            }
            if pause.load(Ordering::Relaxed) {
                return Err("__paused__".to_string());
            }
            let (ctype, bytes) = crate::net::fetch_bytes(ku).await?;
            let _ = ctype;
            total_size += bytes.len() as u64;
            std::fs::write(d.join(format!("key_{}.bin", i)), &bytes).map_err(|e| e.to_string())?;
        }

        // 逐片下载（顺序进行，避免挤占播放带宽；断点续传：已存在的分片直接跳过）
        let total = segs.len();
        let mut already = 0usize;
        for i in 0..total {
            if d.join(format!("seg_{:05}.ts", i)).exists() {
                already += 1;
            }
        }
        set_status(&key, "downloading", already, total);
        for (i, su) in segs.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err("__cancelled__".to_string());
            }
            if pause.load(Ordering::Relaxed) {
                return Err("__paused__".to_string());
            }
            let name = format!("seg_{:05}.{}", i, "ts");
            if d.join(&name).exists() {
                // 上次下到这里被暂停/中断，直接续上
                let mut m = TASKS.lock().unwrap();
                if let Some(t) = m.get_mut(&key) {
                    t.done = i + 1;
                    t.total = total;
                }
                drop(m);
                emit_progress(&app, &key, "downloading", i + 1, total, auto);
                continue;
            }
            let (ctype, bytes) = crate::net::fetch_bytes(su).await?;
            /* CDN 的 Content-Type 五花八门：实测为 binary/octet-stream，
             * 播放路径（media::load_segment）不做类型校验，这里保持同样宽容：
             * 只拒绝明显是防盗链/错误页的 html / json / xml 文本响应。 */
            let mime = ctype.unwrap_or_else(|| "video/mp2t".to_string());
            let low = mime.to_ascii_lowercase();
            if low.contains("text/html") || low.contains("json") || low.contains("xml") {
                return Err(format!("第 {} 片返回异常类型 {}", i + 1, mime));
            }
            std::fs::write(d.join(&name), &bytes).map_err(|e| e.to_string())?;
            total_size += bytes.len() as u64;

            let mut m = TASKS.lock().unwrap();
            if let Some(t) = m.get_mut(&key) {
                t.done = i + 1;
                t.total = total;
            }
            drop(m);
            emit_progress(&app, &key, "downloading", i + 1, total, auto);
        }

        // 生成 index.m3u8：原始行 + 分片替换成本地地址
        let mut out = String::with_capacity(text.len() + 1024);
        let mut seg_i = 0usize;
        for raw in text.lines() {
            let line = raw.trim_end();
            if line.is_empty() {
                continue;
            }
            if line.starts_with('#') {
                if line.contains("URI=\"") {
                    if let Some(i) = line.find("URI=\"") {
                        let rest = &line[i + 5..];
                        if let Some(end) = rest.find('"') {
                            let uri = absolutize(&url, &rest[..end]);
                            let idx = keys.iter().position(|k| k == &uri).unwrap_or(0);
                            out.push_str(&format!(
                                "{}URI=\"{}/file?k={}/key_{}.bin\"\n",
                                &line[..i], local_origin, key, idx
                            ));
                            continue;
                        }
                    }
                }
                if line.starts_with("#EXT-X-MAP") {
                    // MAP 分片头暂不落地，指向远程（经 seg 代理），保证兼容
                    let absolute = absolutize(&url, line);
                    out.push_str(&format!(
                        "{}/seg?u={}\n",
                        local_origin,
                        enc(&absolute)
                    ));
                    continue;
                }
                out.push_str(line);
                out.push('\n');
            } else {
                out.push_str(&format!("{}/file?k={}/seg_{:05}.ts\n", local_origin, key, seg_i));
                seg_i += 1;
            }
        }
        std::fs::write(d.join("index.m3u8"), out).map_err(|e| e.to_string())?;
        Ok((total, total_size))
    }
    .await;

    match result {
        Ok((total, size)) => {
            let meta = json!({
                "video_id": video_id, "ep": ep, "title": title, "url": url,
                "status": "done", "done": total, "total": total,
                "size": size, "auto": auto,
                "updated_at": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs()).unwrap_or(0),
            });
            write_meta(&root, &key, &meta);
            set_status(&key, "done", total, total);
            emit_progress(&app, &key, "done", total, total, auto);
            if auto {
                evict_auto(&root);
            }
        }
        Err(e) => {
            if e == "__paused__" {
                /* 暂停：保留已下分片，记下进度，之后可续传 */
                let (done, total) = TASKS
                    .lock()
                    .unwrap()
                    .get(&key)
                    .map(|t| (t.done, t.total))
                    .unwrap_or((0, 0));
                let mut meta = read_meta(&root, &key).unwrap_or(json!({
                    "video_id": video_id, "ep": ep, "title": title, "url": url,
                }));
                meta["status"] = json!("paused");
                meta["done"] = json!(done);
                meta["total"] = json!(total);
                meta["size"] = json!(dir_size(&d));
                meta["updated_at"] = json!(std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs()).unwrap_or(0));
                write_meta(&root, &key, &meta);
                set_status(&key, "paused", done, total);
                emit_progress(&app, &key, "paused", done, total, auto);
                return;
            }
            let status = if e == "__cancelled__" { "cancelled" } else { "failed" };
            if status == "cancelled" {
                let _ = std::fs::remove_dir_all(root.join(&key));
                let _ = std::fs::remove_file(meta_path(&root, &key));
            } else {
                let mut meta = read_meta(&root, &key).unwrap_or(json!({
                    "video_id": video_id, "ep": ep, "title": title, "url": url,
                }));
                meta["status"] = json!(status);
                meta["error"] = json!(e);
                meta["updated_at"] = json!(std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs()).unwrap_or(0));
                write_meta(&root, &key, &meta);
            }
            set_status(&key, if status == "cancelled" { "cancelled" } else { "failed" }, 0, 0);
            emit_progress(&app, &key, status, 0, 0, auto);
        }
    }
}

/// auto 条目超出上限时淘汰最旧的。
fn evict_auto(root: &Path) {
    let mut autos: Vec<(String, u64)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let k = e.file_name().to_string_lossy().to_string();
            if let Some(meta) = read_meta(root, &k) {
                if meta.get("auto").and_then(|v| v.as_bool()).unwrap_or(false) {
                    autos.push((
                        k,
                        meta.get("updated_at").and_then(|v| v.as_u64()).unwrap_or(0),
                    ));
                }
            }
        }
    }
    if autos.len() <= AUTO_KEEP {
        return;
    }
    autos.sort_by_key(|(_, at)| *at);
    let excess = autos.len() - AUTO_KEEP;
    for (k, _) in autos.into_iter().take(excess) {
        let _ = std::fs::remove_dir_all(root.join(&k));
        let _ = std::fs::remove_file(meta_path(root, &k));
    }
}

/* ───────────────────────── 本地文件服务 ───────────────────────── */

/// `<LOCAL>/file?k=<相对路径>`：只允许 `目录名/文件名` 形式，防目录穿越。
pub fn serve_file(query: &str) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::Response;
    let bad = |code: u16, msg: &str| {
        Response::builder()
            .status(code)
            .header("Content-Type", "text/plain")
            .body(msg.as_bytes().to_vec())
            .unwrap_or_else(|_| Response::new(Vec::new()))
    };
    let k = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("k="))
        .map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().to_string())
        .unwrap_or_default();
    let parts: Vec<&str> = k.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() != 2 || parts.iter().any(|p| *p == ".." || *p == ".") {
        return bad(400, "bad k");
    }
    let root = dir();
    let p = root.join(parts[0]).join(parts[1]);
    match std::fs::read(&p) {
        Ok(bytes) => {
            let lower = parts[1].to_ascii_lowercase();
            let ctype = if lower.ends_with(".m3u8") {
                "application/vnd.apple.mpegurl"
            } else if lower.ends_with(".ts") {
                "video/mp2t"
            } else if lower.ends_with(".mp4") || lower.ends_with(".m4s") {
                "video/mp4"
            } else if lower.ends_with(".bin") {
                "application/octet-stream"
            } else {
                "application/octet-stream"
            };
            Response::builder()
                .status(200)
                .header("Content-Type", ctype)
                .header("Content-Length", bytes.len().to_string())
                .header("Accept-Ranges", "bytes")
                .header("Cache-Control", "public, max-age=3600")
                .header("Access-Control-Allow-Origin", "*")
                .body(bytes)
                .unwrap_or_else(|_| Response::new(Vec::new()))
        }
        Err(_) => bad(404, "not found"),
    }
}

/* ───────────────────────── Tauri 命令 ───────────────────────── */

/// 下载一集（await 到完成；已在缓存则直接返回）。前端自动缓冲不 await，即后台执行。
#[tauri::command]
pub async fn dl_start(
    app: AppHandle,
    video_id: i64,
    ep: i64,
    url: String,
    title: String,
    auto: bool,
    /* 剧集封面（上游原图地址）：离线页每集缩略图用它。老前端不传也不影响 */
    cover: Option<String>,
) -> Result<Value, String> {
    let key = key_of(video_id, ep);
    let root = dir();
    /* 先把封面写进 meta，run_download 会保留已有字段 */
    if let Some(c) = cover.as_deref().filter(|c| !c.is_empty()) {
        let mut meta = read_meta(&root, &key).unwrap_or(json!({}));
        meta["cover"] = json!(c);
        write_meta(&root, &key, &meta);
    }
    if let Some(mut meta) = read_meta(&root, &key) {
        if meta.get("status").and_then(|v| v.as_str()) == Some("done")
            && root.join(&key).join("index.m3u8").exists()
        {
            /* 之前只是自动预缓存的，用户现在明确要下载：转正，让它出现在离线视频里 */
            if !auto && meta.get("auto").and_then(|v| v.as_bool()).unwrap_or(false) {
                meta["auto"] = json!(false);
                meta["title"] = json!(title);
                write_meta(&root, &key, &meta);
            }
            return Ok(json!({"key": key, "skipped": true, "status": "done"}));
        }
    }
    /* 已经在下载 / 已在队列里排队就不重复起任务（反复点一键下载不会堆叠） */
    {
        let m = TASKS.lock().unwrap();
        if let Some(t) = m.get(&key) {
            if t.status == "downloading" || t.status == "queued" {
                return Ok(json!({"key": key, "skipped": true, "status": t.status}));
            }
        }
    }
    run_download(app, key.clone(), video_id, ep, url, title, auto).await;
    let meta = read_meta(&root, &key).unwrap_or(json!({"status": "failed"}));
    Ok(json!({"key": key, "status": meta.get("status").cloned().unwrap_or(json!("failed"))}))
}

#[derive(serde::Deserialize)]
pub struct EnqueueItem {
    pub video_id: i64,
    pub ep: i64,
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub cover: String,
}

/// 批量入队：一次点击把整套剧集排进队列，后台顺序下载（不阻塞前端）。
#[tauri::command]
pub fn dl_enqueue(app: AppHandle, items: Vec<EnqueueItem>) -> Value {
    let root = dir();
    let mut added = 0usize;
    let mut skipped = 0usize;
    for it in items {
        if it.url.is_empty() {
            skipped += 1;
            continue;
        }
        let key = key_of(it.video_id, it.ep);
        // 已下载完成：跳过（若是自动预缓存来的，顺手「转正」成用户下载）
        if let Some(mut meta) = read_meta(&root, &key) {
            if meta.get("status").and_then(|v| v.as_str()) == Some("done")
                && root.join(&key).join("index.m3u8").exists()
            {
                if meta.get("auto").and_then(|v| v.as_bool()).unwrap_or(false) {
                    meta["auto"] = json!(false);
                    meta["title"] = json!(it.title);
                    write_meta(&root, &key, &meta);
                }
                skipped += 1;
                continue;
            }
        }
        // 已在下载 / 已在队列：跳过
        {
            let m = TASKS.lock().unwrap();
            if let Some(t) = m.get(&key) {
                if t.status == "downloading" {
                    skipped += 1;
                    continue;
                }
            }
        }
        if QUEUE.lock().unwrap().iter().any(|q| q.0 == it.video_id && q.1 == it.ep) {
            skipped += 1;
            continue;
        }
        // 先落一份排队中的 meta，离线视频页立刻能看到这一集
        let mut meta = read_meta(&root, &key).unwrap_or(json!({}));
        meta["video_id"] = json!(it.video_id);
        meta["ep"] = json!(it.ep);
        meta["title"] = json!(it.title);
        meta["url"] = json!(it.url);
        if !it.cover.is_empty() {
            meta["cover"] = json!(it.cover);
        }
        meta["status"] = json!("queued");
        meta["auto"] = json!(false);
        meta["done"] = meta.get("done").cloned().unwrap_or(json!(0));
        meta["total"] = meta.get("total").cloned().unwrap_or(json!(0));
        meta["updated_at"] = json!(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0));
        write_meta(&root, &key, &meta);
        set_status(&key, "queued", 0, 0);
        QUEUE
            .lock()
            .unwrap()
            .push_back((it.video_id, it.ep, it.url, it.title));
        added += 1;
    }
    start_worker(app);
    json!({ "ok": true, "queued": added, "skipped": skipped })
}

fn start_worker(app: AppHandle) {
    {
        let mut running = WORKER_RUNNING.lock().unwrap();
        if *running {
            return;
        }
        *running = true;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let next = { QUEUE.lock().unwrap().pop_front() };
            let Some((video_id, ep, url, title)) = next else {
                // 队列空了也不立刻退出：稍等一下再确认，避免与并发入队擦肩而过
                tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                if QUEUE.lock().unwrap().is_empty() {
                    *WORKER_RUNNING.lock().unwrap() = false;
                    break;
                }
                continue;
            };
            let key = key_of(video_id, ep);
            run_download(app.clone(), key, video_id, ep, url, title, false).await;
        }
    });
}

/// 查询单集缓存状态；done=true 时返回可播放的 key。
#[tauri::command]
pub fn dl_get(video_id: i64, ep: i64) -> Value {    let root = dir();
    let key = key_of(video_id, ep);
    match read_meta(&root, &key) {
        Some(meta) => {
            let done = meta.get("status").and_then(|v| v.as_str()) == Some("done")
                && root.join(&key).join("index.m3u8").exists();
            json!({"key": key, "exists": true, "done": done, "meta": meta})
        }
        None => json!({"key": key, "exists": false, "done": false}),
    }
}

/// 全部缓存列表（含大小与实时进度）。
#[tauri::command]
pub fn dl_list() -> Value {
    let root = dir();
    let mut items: Vec<Value> = Vec::new();
    /* 先把内存状态拷出来，统计目录大小可能很慢，不能一直占着 TASKS 锁 */
    let live: std::collections::HashMap<String, (&'static str, usize, usize)> = {
        let tasks = TASKS.lock().unwrap();
        tasks
            .iter()
            .map(|(k, t)| (k.clone(), (t.status, t.done, t.total)))
            .collect()
    };
    if let Ok(rd) = std::fs::read_dir(&root) {
        for e in rd.flatten() {
            let k = e.file_name().to_string_lossy().to_string();
            if let Some(mut meta) = read_meta(&root, &k) {
                let size = dir_size(&root.join(&k));
                meta["size"] = json!(size);
                meta["key"] = json!(k);
                /* 正在跑/暂停中的任务以内存状态为准（meta 里的进度可能滞后） */
                if let Some((status, done, total)) = live.get(&k) {
                    if *status == "downloading" || *status == "paused" {
                        meta["status"] = json!(status);
                        meta["done"] = json!(done);
                        meta["total"] = json!(total);
                    }
                }
                items.push(meta);
            }
        }
    }
    items.sort_by_key(|m| {
        -(m.get("updated_at").and_then(|v| v.as_u64()).unwrap_or(0) as i64)
    });
    json!({ "dir": root.to_string_lossy(), "items": items })
}

#[tauri::command]
pub fn dl_cancel(video_id: i64, ep: i64) -> Value {
    let key = key_of(video_id, ep);
    if let Some(t) = TASKS.lock().unwrap().get(&key) {
        t.cancel.store(true, Ordering::Relaxed);
        t.pause.store(false, Ordering::Relaxed);
    }
    json!({"ok": true})
}

/// 暂停下载：当前分片下完后停下，进度与已下分片保留，可继续。
#[tauri::command]
pub fn dl_pause(app: AppHandle, video_id: i64, ep: i64) -> Value {
    let key = key_of(video_id, ep);
    /* 还在队列里没开跑：直接从队列摘掉，标成暂停 */
    {
        let mut q = QUEUE.lock().unwrap();
        if let Some(pos) = q.iter().position(|x| x.0 == video_id && x.1 == ep) {
            q.remove(pos);
            set_status(&key, "paused", 0, 0);
            let root = dir();
            let mut is_auto = false;
            if let Some(mut meta) = read_meta(&root, &key) {
                is_auto = meta.get("auto").and_then(|v| v.as_bool()).unwrap_or(false);
                meta["status"] = json!("paused");
                write_meta(&root, &key, &meta);
            }
            emit_progress(&app, &key, "paused", 0, 0, is_auto);
            return json!({"ok": true});
        }
    }
    let running = {
        let m = TASKS.lock().unwrap();
        m.get(&key).map(|t| t.status == "downloading").unwrap_or(false)
    };
    if running {
        if let Some(t) = TASKS.lock().unwrap().get(&key) {
            t.pause.store(true, Ordering::Relaxed);
        }
    } else {
        /* 没有活动任务：直接把 meta 标成 paused，界面立刻反映 */
        let root = dir();
        if let Some(mut meta) = read_meta(&root, &key) {
            meta["status"] = json!("paused");
            write_meta(&root, &key, &meta);
            let done = meta.get("done").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let total = meta.get("total").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let is_auto = meta.get("auto").and_then(|v| v.as_bool()).unwrap_or(false);
            emit_progress(&app, &key, "paused", done, total, is_auto);
        }
    }
    json!({"ok": true})
}

/// 继续下载：从 meta 里取回地址，已下过的分片自动跳过（断点续传）。
#[tauri::command]
pub fn dl_resume(app: AppHandle, video_id: i64, ep: i64) -> Result<Value, String> {
    let key = key_of(video_id, ep);
    let root = dir();
    /* 如果它还在队列里排队，先摘掉，避免续传与队列 worker 同时跑同一集 */
    QUEUE
        .lock()
        .unwrap()
        .retain(|x| !(x.0 == video_id && x.1 == ep));
    let meta = read_meta(&root, &key).ok_or_else(|| "找不到该集的下载记录".to_string())?;
    let url = meta.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if url.is_empty() {
        return Err("缺少下载地址，请重新下载".to_string());
    }
    let title = meta.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let auto = meta.get("auto").and_then(|v| v.as_bool()).unwrap_or(false);
    tauri::async_runtime::spawn(async move {
        run_download(app, key, video_id, ep, url, title, auto).await;
    });
    Ok(json!({"ok": true, "status": "downloading"}))
}

#[tauri::command]
pub fn dl_remove(video_id: i64, ep: i64) -> Value {
    let root = dir();
    let key = key_of(video_id, ep);
    /* 排队中的也一并摘掉 */
    QUEUE
        .lock()
        .unwrap()
        .retain(|x| !(x.0 == video_id && x.1 == ep));
    {
        let mut m = TASKS.lock().unwrap();
        if let Some(t) = m.get(&key) {
            t.cancel.store(true, Ordering::Relaxed);
        }
        m.remove(&key);
    }
    let _ = std::fs::remove_dir_all(root.join(&key));
    let _ = std::fs::remove_file(meta_path(&root, &key));
    json!({"ok": true})
}

#[tauri::command]
pub fn dl_clear() -> Value {
    let root = dir();
    {
        let m = TASKS.lock().unwrap();
        for t in m.values() {
            t.cancel.store(true, Ordering::Relaxed);
        }
    }
    TASKS.lock().unwrap().clear();
    QUEUE.lock().unwrap().clear();
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::create_dir_all(&root);
    json!({"ok": true})
}

fn dir_size(p: &Path) -> u64 {
    let mut n = 0u64;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            if let Ok(t) = e.metadata() {
                if t.is_file() {
                    n += t.len();
                } else if t.is_dir() {
                    n += dir_size(&e.path());
                }
            }
        }
    }
    n
}

/// 写系统剪贴板（Android WebView 默认拒绝 navigator.clipboard.writeText，
/// 报「Write permission denied」；由 Rust 侧通过 clipboard-manager 插件代写）。
#[tauri::command]
pub fn copy_text(app: AppHandle, text: String) -> Result<bool, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(&text)
        .map(|_| true)
        .map_err(|e| e.to_string())
}

/// 把文本保存到应用数据目录 backups/（导出备份兜底；Android 剪贴板被拒时仍有文件可取）。
#[tauri::command]
pub fn save_text(app: AppHandle, file_name: String, text: String) -> Result<String, String> {
    let safe: String = file_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join(if safe.is_empty() { "backup.txt".to_string() } else { safe });
    std::fs::write(&p, text).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().to_string())
}
