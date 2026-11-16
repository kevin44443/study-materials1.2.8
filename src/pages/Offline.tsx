import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import { useStore } from "../store";
import { Empty, Img } from "../components/ui";
import { dlMb } from "../downloader";
import { IBack, ICheck, IDownload, IPauseF, IPlayF, IRefresh, ITrash } from "../icons";

/* 离线视频：按剧名归类（一部剧一张卡），下载中 / 已完成分区；
   支持多选后批量暂停、继续、删除。数据来自 Rust 侧 downloads 模块
   （dl_list 会合并内存里正在跑的进度，自动预缓存的条目已过滤）。
   每集都带缩略图（下载时把剧集封面存进 meta.cover）。 */
type DlRow = {
  key: string;
  video_id: number;
  ep: number;
  title?: string;
  cover?: string;
  status: string;
  done?: number;
  total?: number;
  size?: number;
  error?: string;
  auto?: boolean;
};

type Group = {
  videoId: number;
  title: string;
  cover?: string;
  rows: DlRow[];
  doneCount: number;
  size: number;
};

const isDone = (r: DlRow) => r.status === "done";

export default function Offline({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, toast } = useStore();
  const [rows, setRows] = useState<DlRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const r = await invoke<{ items?: DlRow[] }>("dl_list");
      /* auto=true 是「播放过半自动预缓存下一集」，不属于用户下载，不在这里露出 */
      setRows((r?.items || []).filter((x) => x && x.video_id && x.auto !== true));
    } catch { /* 未绑定目录时忽略 */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    let off: (() => void) | null = null;
    listen("dl-progress", () => { void refresh(); })
      .then((fn) => { off = () => { void fn(); }; })
      .catch(() => {});
    const t = window.setInterval(() => { void refresh(); }, 3000);
    return () => { off?.(); window.clearInterval(t); };
  }, [refresh]);

  /* 旧版本下载的记录没有存封面：按 video_id 补一次（结果写进 localStorage，
     下次断网也能显示）。失败就保持占位图，不影响任何操作。 */
  const [extraCover, setExtraCover] = useState<Record<number, string>>({});
  const triedCover = useRef<Set<number>>(new Set());
  useEffect(() => {
    const miss = [...new Set(rows.filter((r) => !r.cover).map((r) => r.video_id))]
      .filter((id) => !triedCover.current.has(id));
    if (!miss.length) return;
    let alive = true;
    (async () => {
      const next: Record<number, string> = {};
      for (const id of miss) {
        const cached = (() => { try { return localStorage.getItem(`hghub.cover.${id}`) || ""; } catch { return ""; } })();
        if (cached) { next[id] = cached; continue; }
        triedCover.current.add(id);
        try {
          const d = await api.video(id);
          if (d?.cover) {
            next[id] = d.cover;
            try { localStorage.setItem(`hghub.cover.${id}`, d.cover); } catch { /* 忽略配额 */ }
          }
        } catch { /* 离线或内容已下线 */ }
      }
      if (alive && Object.keys(next).length) setExtraCover((m) => ({ ...m, ...next }));
    })();
    return () => { alive = false; };
  }, [rows]);

  /* 分「下载中」与「已完成」，各自按剧名归类 */
  const { running, done } = useMemo(() => {
    const run = new Map<string, Group>();
    const fin = new Map<string, Group>();
    rows.forEach((r) => {
      const bucket = isDone(r) ? fin : run;
      const key = `${r.video_id}`;
      let g = bucket.get(key);
      if (!g) {
        g = { videoId: r.video_id, title: r.title || `视频 ${r.video_id}`, cover: r.cover, rows: [], doneCount: 0, size: 0 };
        bucket.set(key, g);
      }
      if (!g.title && r.title) g.title = r.title;
      if (!g.cover && (r.cover || extraCover[r.video_id])) g.cover = r.cover || extraCover[r.video_id];
      g.rows.push(r);
      g.size += r.size || 0;
      if (isDone(r)) g.doneCount += 1;
    });
    const arr = [...run.values()].concat([...fin.values()]);
    arr.forEach((g) => g.rows.sort((a, b) => a.ep - b.ep));
    return { running: [...run.values()], done: [...fin.values()] };
  }, [rows, extraCover]);

  const totalBytes = rows.filter(isDone).reduce((n, r) => n + (r.size || 0), 0);
  const allRows = useMemo(() => [...running, ...done].flatMap((g) => g.rows), [running, done]);
  const selRows = allRows.filter((r) => selected.has(r.key));

  const act = async (row: DlRow, kind: "pause" | "resume" | "remove") => {
    setBusy(row.key);
    try {
      if (kind === "pause") await invoke("dl_pause", { videoId: row.video_id, ep: row.ep });
      else if (kind === "resume") await invoke("dl_resume", { videoId: row.video_id, ep: row.ep });
      else await invoke("dl_remove", { videoId: row.video_id, ep: row.ep });
      if (kind === "remove") toast("已删除该集", "ok");
      await refresh();
    } catch (e) {
      toast((e as Error).message || "操作失败", "info");
    } finally {
      setBusy(null);
    }
  };

  /* —— 批量操作：暂停 / 继续 / 删除所选 —— */
  const batch = async (kind: "pause" | "resume" | "remove") => {
    const list = kind === "pause"
      ? selRows.filter((r) => r.status === "downloading" || r.status === "queued")
      : kind === "resume"
        ? selRows.filter((r) => r.status === "paused" || r.status === "failed" || r.status === "queued")
        : selRows;
    if (!list.length) { toast("所选剧集当前不支持该操作", "info"); return; }
    setBusy("batch");
    let ok = 0;
    for (const r of list) {
      try {
        if (kind === "pause") await invoke("dl_pause", { videoId: r.video_id, ep: r.ep });
        else if (kind === "resume") await invoke("dl_resume", { videoId: r.video_id, ep: r.ep });
        else await invoke("dl_remove", { videoId: r.video_id, ep: r.ep });
        ok += 1;
      } catch { /* 单条失败继续 */ }
    }
    setBusy(null);
    setSelected(new Set());
    toast(`${kind === "pause" ? "已暂停" : kind === "resume" ? "已继续" : "已删除"} ${ok} 集`, "ok");
    await refresh();
  };

  const toggleSel = (key: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const toggleGroup = (g: Group) => setSelected((s) => {
    const n = new Set(s);
    const all = g.rows.every((r) => n.has(r.key));
    g.rows.forEach((r) => { if (all) n.delete(r.key); else n.add(r.key); });
    return n;
  });

  const clearDone = async () => {
    setBusy("all");
    try {
      for (const g of done) for (const r of g.rows) await invoke("dl_remove", { videoId: r.video_id, ep: r.ep });
      toast("已清空下载完成的视频", "ok");
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const play = (row: DlRow) => {
    push({
      kind: "feed", videoIds: [row.video_id], index: 0,
      title: row.title || "离线视频", startEp: row.ep, startTime: 0,
    });
  };

  /* 全选 / 取消全选（跨剧生效） */
  const allSelected = allRows.length > 0 && allRows.every((r) => selected.has(r.key));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(allRows.map((r) => r.key)));

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 relative overflow-hidden bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(90% 120% at 100% 0%, var(--p-pc) 0%, transparent 60%)", opacity: 0.32 }} />
        <div className="relative px-3 pt-2 pb-4">
          <div className="flex items-center gap-2">
            <button onClick={onBack}
              className="h-9 pl-1.5 pr-3 rounded-full flex items-center gap-1 text-on bg-s3 pressable">
              <IBack size={17} /><span className="text-[12px] font-semibold">返回</span>
            </button>
            <button onClick={() => void refresh()} disabled={busy === "refresh"}
              className="ml-auto h-9 px-3 rounded-full bg-s3 flex items-center gap-1 text-mut pressable disabled:opacity-50">
              <IRefresh size={15} /><span className="text-[12px] font-semibold">刷新</span>
            </button>
            <button onClick={() => { setSelecting((v) => !v); setSelected(new Set()); }}
              className={`h-9 px-3.5 rounded-full text-[12px] font-semibold pressable ${selecting ? "bg-primary text-on-primary" : "bg-s3 text-mut"}`}>
              {selecting ? "退出多选" : "多选"}
            </button>
          </div>
          <div className="px-2 mt-2 flex items-end justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="w-9 h-9 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><IDownload size={20} /></span>
                <span className="text-[24px] font-bold tracking-wide text-on">离线视频</span>
              </div>
              <div className="text-[11px] text-mut mt-1">
                {running.reduce((n, g) => n + g.rows.length, 0)} 集下载中 · {done.reduce((n, g) => n + g.rows.length, 0)} 集已完成
                {totalBytes ? ` · 占用 ${dlMb(totalBytes)}` : ""}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 scroll-y px-4 pt-2" style={{ paddingBottom: selecting ? 104 : 40 }}>
        <div className={wide ? "max-w-[720px] mx-auto" : ""}>
          {loading ? (
            <div className="flex justify-center py-14"><div className="w-8 h-8 spinner" /></div>
          ) : !rows.length ? (
            <Empty icon={<IDownload size={26} />} title="还没有离线视频"
              sub="在播放页打开「选集」，切到「下载」模式点一集，或直接一键全集下载；卡片左下角的下载按钮也能一键存整部剧" />
          ) : (
            <>
              {/* 下载中 */}
              <div className="flex items-center gap-2 px-1 mt-2 mb-2">
                <span className="text-[10.5px] font-semibold text-dim tracking-wide">下载中</span>
                <span className="text-[10.5px] text-dim">{running.length} 部剧</span>
                {!!running.length && rows.some((r) => r.status === "downloading" || r.status === "queued") && (
                  <button
                    onClick={async () => {
                      for (const r of rows.filter((x) => x.status === "downloading" || x.status === "queued")) {
                        await invoke("dl_pause", { videoId: r.video_id, ep: r.ep }).catch(() => {});
                      }
                      toast("已全部暂停", "info");
                      await refresh();
                    }}
                    className="ml-auto text-[11px] text-primary pressable">全部暂停</button>
                )}
              </div>
              {running.length ? running.map((g) => (
                <GroupCard key={`run-${g.videoId}`} g={g} selecting={selecting} selected={selected}
                  busy={busy} onToggle={toggleSel} onToggleGroup={() => toggleGroup(g)}
                  onPause={(r) => void act(r, "pause")} onResume={(r) => void act(r, "resume")}
                  onRemove={(r) => void act(r, "remove")} onPlay={play} />
              )) : (
                <div className="rounded-(--r-md) bg-s2/60 px-3.5 py-3 text-[11.5px] text-dim">暂无正在下载的内容</div>
              )}

              {/* 已完成（按剧名归类） */}
              <div className="flex items-center gap-2 px-1 mt-5 mb-2">
                <span className="text-[10.5px] font-semibold text-dim tracking-wide">已完成</span>
                <span className="text-[10.5px] text-dim">{done.length} 部剧 · {done.reduce((n, g) => n + g.rows.length, 0)} 集{totalBytes ? ` · ${dlMb(totalBytes)}` : ""}</span>
                {!!done.length && (
                  <button onClick={() => void clearDone()} disabled={busy === "all"}
                    className="ml-auto text-[11px] text-danger pressable disabled:opacity-50">清空已完成</button>
                )}
              </div>
              {done.length ? done.map((g) => (
                <GroupCard key={`done-${g.videoId}`} g={g} selecting={selecting} selected={selected}
                  busy={busy} onToggle={toggleSel} onToggleGroup={() => toggleGroup(g)}
                  onPause={(r) => void act(r, "pause")} onResume={(r) => void act(r, "resume")}
                  onRemove={(r) => void act(r, "remove")} onPlay={play} />
              )) : (
                <div className="rounded-(--r-md) bg-s2/60 px-3.5 py-3 text-[11.5px] text-dim">暂无下载完成的视频</div>
              )}
              <div className="text-center text-[10px] text-dim mt-5">离线视频只保存在本机，卸载 App 会一并清除</div>
            </>
          )}
        </div>
      </div>

      {/* 多选操作条：每个按钮都写清功能（暂停所选 / 继续所选 / 删除所选） */}
      {selecting && (
        <div className="shrink-0 px-4 py-2.5 bg-s2/95 backdrop-blur-md elev-up" style={{ paddingBottom: "calc(var(--sab, 0px) + 10px)" }}>
          <div className="flex items-center gap-2">
            <button onClick={toggleAll}
              className="h-8 px-3 rounded-full bg-s3 text-on text-[11.5px] font-semibold pressable">
              {allSelected ? "取消全选" : "全选"}
            </button>
            <span className="text-[11.5px] text-mut">已选 <b className="text-on tabular-nums">{selected.size}</b> 集</span>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <button onClick={() => void batch("pause")} disabled={busy === "batch" || !selected.size}
              className="h-10 rounded-(--r-ctl) bg-s3 text-on text-[12px] font-semibold flex items-center justify-center gap-1.5 pressable disabled:opacity-45">
              <IPauseF size={13} />暂停所选
            </button>
            <button onClick={() => void batch("resume")} disabled={busy === "batch" || !selected.size}
              className="h-10 rounded-(--r-ctl) bg-primary/15 text-primary text-[12px] font-semibold flex items-center justify-center gap-1.5 pressable disabled:opacity-45">
              <IPlayF size={13} />继续所选
            </button>
            <button onClick={() => void batch("remove")} disabled={busy === "batch" || !selected.size}
              className="h-10 rounded-(--r-ctl) bg-danger/15 text-danger text-[12px] font-semibold flex items-center justify-center gap-1.5 pressable disabled:opacity-45">
              <ITrash size={13} />删除所选
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ——— 一部剧一张卡：封面 + 标题 + 集数统计 + 每一集（带缩略图与文字按钮） ——— */
function GroupCard({ g, selecting, selected, busy, onToggle, onToggleGroup, onPause, onResume, onRemove, onPlay }: {
  g: Group; selecting: boolean; selected: Set<string>; busy: string | null;
  onToggle: (key: string) => void; onToggleGroup: () => void;
  onPause: (r: DlRow) => void; onResume: (r: DlRow) => void; onRemove: (r: DlRow) => void;
  onPlay: (r: DlRow) => void;
}) {
  const allOn = g.rows.every((r) => selected.has(r.key));
  return (
    <div className="rounded-(--r-md) bg-s2 overflow-hidden mb-3 elev-1">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <div className="relative w-9 h-12 rounded-(--r-sm) overflow-hidden bg-s3 shrink-0">
          {g.cover ? <Img src={g.cover} /> : (
            <span className="absolute inset-0 flex items-center justify-center text-mut"><IDownload size={15} /></span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-on truncate">{g.title}</div>
          <div className="text-[10.5px] text-mut mt-1 tabular-nums">
            共 {g.rows.length} 集{g.doneCount ? ` · 已完成 ${g.doneCount}` : ""} · {dlMb(g.size)}
          </div>
        </div>
        <button onClick={onToggleGroup}
          className="text-[11px] font-semibold text-primary px-2 h-7 rounded-full bg-primary/10 pressable shrink-0">
          {allOn ? "取消全选" : "全选"}
        </button>
      </div>
      <div className="divide-y divide-s3 border-t border-s3">
        {g.rows.map((r) => {
          const total = r.total || 0;
          const doneN = r.done || 0;
          const pct = total > 0 ? Math.min(100, Math.round((doneN / total) * 100)) : null;
          const paused = r.status === "paused";
          const failed = r.status === "failed";
          const queued = r.status === "queued";
          const on = selected.has(r.key);
          return (
            <div key={r.key} className="flex items-center gap-2.5 px-3 py-2.5">
              {selecting && (
                <button onClick={() => onToggle(r.key)}
                  className={`w-6 h-6 rounded-[7px] flex items-center justify-center shrink-0 pressable ${on ? "bg-primary text-on-primary" : "border border-mut/60 text-transparent"}`}>
                  <ICheck size={12} strokeWidth={2.6} />
                </button>
              )}
              {/* 每集缩略图（用该剧封面，带集数角标） */}
              <div className="relative w-[52px] h-[68px] rounded-(--r-sm) overflow-hidden bg-s3 shrink-0">
                {r.cover || g.cover ? <Img src={(r.cover || g.cover) as string} /> : (
                  <span className="absolute inset-0 flex items-center justify-center text-mut"><IDownload size={14} /></span>
                )}
                <span className="absolute bottom-0 inset-x-0 py-0.5 text-center text-[9px] font-bold text-white"
                  style={{ background: "linear-gradient(0deg, rgba(0,0,0,.82), rgba(0,0,0,0))" }}>
                  第{r.ep}集
                </span>
                {isDone(r) && (
                  <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-primary text-on-primary flex items-center justify-center">
                    <ICheck size={9} strokeWidth={3} />
                  </span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-semibold text-on">
                  第 {r.ep} 集
                  {paused && <span className="ml-1.5 text-[10px] font-normal text-accent">已暂停</span>}
                  {queued && <span className="ml-1.5 text-[10px] font-normal text-mut">排队中</span>}
                  {failed && <span className="ml-1.5 text-[10px] font-normal text-danger">下载失败</span>}
                </div>
                <div className="text-[10.5px] text-mut mt-0.5 tabular-nums">
                  {failed ? (r.error ? "点「重试」重新下载" : "下载失败")
                    : isDone(r) ? `已下载 · ${dlMb(r.size)}`
                    : paused ? `已暂停${pct != null ? ` · ${pct}%` : ""}`
                    : queued ? "排队中，稍后自动开始"
                    : pct != null ? `下载中 ${pct}%` : "准备中…"}
                </div>
                {!isDone(r) && !paused && !failed && !queued && (
                  <div className="mt-1.5 h-1 rounded-full overflow-hidden bg-s3 max-w-[200px]">
                    <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${pct ?? 4}%` }} />
                  </div>
                )}
                {failed && r.error && (
                  <div className="text-[9.5px] text-danger/80 mt-0.5 truncate" title={r.error}>
                    {r.error.length > 32 ? `${r.error.slice(0, 32)}…` : r.error}
                  </div>
                )}
              </div>
              {/* 操作按钮：都带文字，不用猜图标 */}
              {!selecting && (
                <div className="flex flex-col items-end gap-1 shrink-0">
                  {isDone(r) ? (
                    <button onClick={() => onPlay(r)}
                      className="h-7 px-2.5 rounded-full bg-primary/15 text-primary text-[10.5px] font-semibold flex items-center gap-1 pressable">
                      <IPlayF size={11} />播放
                    </button>
                  ) : failed ? (
                    <button onClick={() => onResume(r)} disabled={busy === r.key}
                      className="h-7 px-2.5 rounded-full bg-primary/15 text-primary text-[10.5px] font-semibold flex items-center gap-1 pressable disabled:opacity-50">
                      <IRefresh size={11} />重试
                    </button>
                  ) : paused || queued ? (
                    <button onClick={() => onResume(r)} disabled={busy === r.key}
                      className="h-7 px-2.5 rounded-full bg-primary/15 text-primary text-[10.5px] font-semibold flex items-center gap-1 pressable disabled:opacity-50">
                      <IPlayF size={11} />继续
                    </button>
                  ) : (
                    <button onClick={() => onPause(r)} disabled={busy === r.key}
                      className="h-7 px-2.5 rounded-full bg-s3 text-on/85 text-[10.5px] font-semibold flex items-center gap-1 pressable disabled:opacity-50">
                      <IPauseF size={11} />暂停
                    </button>
                  )}
                  <button onClick={() => onRemove(r)} disabled={busy === r.key}
                    className="h-7 px-2.5 rounded-full bg-s3 text-danger text-[10.5px] font-semibold flex items-center gap-1 pressable disabled:opacity-50">
                    <ITrash size={11} />删除
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
