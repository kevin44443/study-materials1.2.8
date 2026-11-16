import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, fmt, cover as imageCover } from "../api";
import { handleArticleClick, sanitizeHtml } from "../html";
import type { Comment, CommentPage, Episode } from "../types";
import { useStore } from "../store";
import { Avatar, Empty } from "./ui";
import { ICheck, IClose, IDownload, IHeart, ISendF } from "../icons";

/* ================= 选集 ================= */
type DlItem = { done: number; total: number; status: string; auto?: boolean };

export function EpisodesPanel({ videoId, episodes, current, onPick, onClose, bare = false, layout = "grid",
  dlState, downloadAll, dlAllRunning, onDownloadEps, onPauseEp, onResumeEp }: {
  videoId: number; episodes: Episode[]; current: number; onPick: (ep: number) => void; onClose: () => void;
  /** 嵌在双栏抽屉里时，隐藏自带的标题栏与底注 */
  bare?: boolean;
  /** rows3：靠下三行、左右滑动（手机底部弹层用）；grid：四列宫格（桌面） */
  layout?: "grid" | "rows3";
  /** 缓冲下载状态（videoId:ep → 进度）与一键下载入口 */
  dlState?: Record<string, DlItem>;
  downloadAll?: () => void;
  dlAllRunning?: boolean;
  /** 批量下载勾选的剧集（下载模式：勾选 → 下载所选） */
  onDownloadEps?: (eps: number[]) => void;
  onPauseEp?: (ep: number) => void;
  onResumeEp?: (ep: number) => void;
}) {
  const [asc, setAsc] = useState(true);
  /** 选集：点即播放；下载：勾选要下载的剧集，再点「下载所选」 */
  const [mode, setMode] = useState<"pick" | "dl">("pick");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const list = asc ? episodes : [...episodes].reverse();
  const railRef = useRef<HTMLDivElement>(null);
  /* 本机已缓存条目（打开面板时查一次），与实时进度合并 */
  const [cached, setCached] = useState<Record<string, DlItem>>({});

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      invoke<{ items?: (DlItem & { video_id?: number; ep?: number })[] }>("dl_list")
        .then((r) => {
          if (!alive) return;
          const map: Record<string, DlItem> = {};
          (r?.items || []).forEach((it) => {
            if (it.video_id === videoId && it.ep != null && it.auto !== true) {
              map[`${videoId}:${it.ep}`] = { done: it.done || 0, total: it.total || 0, status: it.status };
            }
          });
          setCached(map);
        })
        .catch(() => {});
    };
    refresh();
    const t = window.setInterval(refresh, 2500);
    return () => { alive = false; window.clearInterval(t); };
  }, [videoId, dlAllRunning]);

  const merged = useMemo(() => ({ ...cached, ...(dlState || {}) }), [cached, dlState]);
  const epState = (ep: number): DlItem | undefined => merged[`${videoId}:${ep}`];
  const doneCount = episodes.filter((e) => epState(e.ep_num)?.status === "done").length;
  const runningCount = episodes.filter((e) => {
    const s = epState(e.ep_num)?.status;
    return s === "downloading" || s === "paused";
  }).length;
  const allDone = episodes.length > 0 && doneCount === episodes.length;

  /** 下载模式的操作行：下载所选(N) + 一键全集下载 + 全选/清空 */
  const DlActions = ({ compact = false }: { compact?: boolean }) => (
    <div className={`flex items-center ${compact ? "gap-1.5" : "gap-2"} shrink-0`}>
      <button
        onClick={() => {
          const eps = [...selected].filter((ep) => epState(ep)?.status !== "done");
          if (eps.length) { onDownloadEps?.(eps); setSelected(new Set()); }
        }}
        disabled={!selected.size}
        className={`rounded-full font-bold pressable flex items-center gap-1 whitespace-nowrap disabled:opacity-45 bg-primary text-on-primary ${compact ? "h-7 px-2.5 text-[10.5px]" : "h-8 px-3.5 text-[12px]"}`}>
        <IDownload size={compact ? 12 : 14} />下载所选{selected.size ? `(${selected.size})` : ""}
      </button>
      <button
        onClick={() => downloadAll?.()}
        disabled={dlAllRunning || allDone || !episodes.length}
        className={`rounded-full font-semibold pressable flex items-center gap-1 whitespace-nowrap disabled:opacity-55 bg-primary/15 text-primary ${compact ? "h-7 px-2.5 text-[10.5px]" : "h-8 px-3 text-[12px]"}`}>
        {allDone ? <><ICheck size={compact ? 12 : 13} />已全部下载</>
          : dlAllRunning ? <><span className="w-3 h-3 spinner" />下载中…</>
          : <>一键全集下载</>}
      </button>
      <button
        onClick={() => setSelected((s) => (s.size >= episodes.filter((e) => epState(e.ep_num)?.status !== "done").length ? new Set() : new Set(episodes.filter((e) => epState(e.ep_num)?.status !== "done").map((e) => e.ep_num))))}
        disabled={!episodes.length || allDone}
        className={`rounded-full bg-s3 text-mut pressable ${compact ? "h-7 px-2 text-[10.5px]" : "h-8 px-2.5 text-[12px]"}`}>
        全选
      </button>
    </div>
  );

  const epBadge = (ep: number) => {
    const s = epState(ep);
    if (!s) return null;
    if (s.status === "done") return <ICheck size={10} className="text-primary" />;
    if (s.status === "downloading" && s.total > 0) {
      return <span className="text-[8.5px] text-primary tabular-nums">{Math.round((s.done / s.total) * 100)}%</span>;
    }
    if (s.status === "downloading") return <span className="w-2.5 h-2.5 spinner" />;
    if (s.status === "queued") return <span className="text-[8.5px] text-mut">排队</span>;
    if (s.status === "paused") return <span className="text-[8.5px] text-accent tabular-nums">暂停</span>;
    if (s.status === "failed") return <span className="text-[8.5px] text-danger">重试</span>;
    return null;
  };

  /** 点一集：选集模式切集播放；下载模式勾选 / 取消勾选 */
  const tapEp = (ep: number) => {
    if (mode === "pick") { onPick(ep); return; }
    if (epState(ep)?.status === "done") return;
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(ep)) { n.delete(ep); } else { n.add(ep); }
      return n;
    });
  };

  const toggleMode = () => {
    setMode((m) => {
      if (m === "dl") setSelected(new Set());
      return m === "dl" ? "pick" : "dl";
    });
  };

  /* 打开时把当前集滚到可视区域中间 */
  useEffect(() => {
    if (layout !== "rows3") return;
    const box = railRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-ep="${current}"]`);
    if (!box || !el) return;
    const br = box.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    box.scrollLeft += er.left - br.left - box.clientWidth / 2 + er.width / 2;
  }, [layout, current, episodes.length, asc]);

  if (layout === "rows3") {
    return (
      <div className="flex flex-col pb-3">
        <div className="shrink-0 flex items-center gap-2 px-5 pb-2">
          <button onClick={toggleMode} disabled={!onDownloadEps}
            className={`h-8 px-3 rounded-full text-[12px] font-bold pressable disabled:opacity-70 flex items-center gap-1 ${mode === "dl" ? "bg-primary text-on-primary" : "bg-s3 text-on"}`}>
            {mode === "dl" ? <><IDownload size={13} />下载</> : "选集"}
          </button>
          <span className="text-[11px] text-mut truncate">
            共 {episodes.length} 集
            {doneCount ? ` · 已下载 ${doneCount}` : ""}
            {runningCount ? ` · 下载中 ${runningCount}` : ""}
          </span>
          <button onClick={() => setAsc((v) => !v)}
            className="ml-auto h-8 px-3 rounded-full bg-s3 text-[11.5px] font-semibold text-primary pressable shrink-0">
            {asc ? "倒序" : "正序"}
          </button>
        </div>
        {mode === "dl" && (
          <div className="shrink-0 px-5 pb-3 overflow-x-auto scroll-x">
            <DlActions compact />
          </div>
        )}
        {episodes.length ? (
          <div ref={railRef} className="scroll-x px-5 pb-2">
            <div className="grid grid-flow-col grid-rows-3 gap-2.5 w-max pr-2">
              {list.map((e) => {
                const st = epState(e.ep_num)?.status;
                const done = st === "done";
                const on = mode === "dl" && selected.has(e.ep_num);
                const marked = mode === "dl" && !!st && !done;
                const cur = e.ep_num === current && mode === "pick";
                return (
                  <button key={e.ep_num} data-ep={e.ep_num} onClick={() => tapEp(e.ep_num)}
                    className={`relative w-[72px] h-[52px] rounded-(--r-md) text-[14px] font-bold tabular-nums pressable flex items-center justify-center ring-1 ${on ? "bg-primary text-on-primary ring-primary" : marked ? "bg-primary/15 text-primary ring-primary/40" : cur ? "bg-primary text-on-primary ring-primary" : "bg-s3 text-on/85 ring-transparent"}`}>
                    <span className="-mt-1">{e.ep_num}</span>
                    {mode === "dl" && !done && (
                      <span className={`absolute top-1 right-1 w-[17px] h-[17px] rounded-full flex items-center justify-center ${on ? "bg-on-primary text-primary" : "bg-s2/80 text-mut ring-1 ring-mut/50"}`}>
                        {on && <ICheck size={10} strokeWidth={3} />}
                      </span>
                    )}
                    {st && (
                      <span className="absolute inset-x-0 bottom-1 text-center text-[8.5px] font-semibold leading-none">
                        {epBadge(e.ep_num)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="text-center text-[11.5px] text-dim py-6">暂无剧集</div>
        )}
        <div className="px-5 pt-2 text-[10.5px] text-dim leading-relaxed">
          {mode === "dl" ? "勾选想下载的剧集，点「下载所选」；也可「一键全集下载」" : "点数字切换剧集 · 切到「下载」可勾选下载"}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {bare ? (
        <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
          <button onClick={toggleMode} disabled={!onDownloadEps}
            className={`h-7 px-2.5 rounded-full text-[11px] font-bold pressable flex items-center gap-1 ${mode === "dl" ? "bg-primary text-on-primary" : "bg-s3 text-on/85"}`}>
            {mode === "dl" ? <><IDownload size={11} />下载</> : "选集"}
          </button>
          <span className="text-[10.5px] text-mut">共 {episodes.length} 集 · 已下载 {doneCount}{runningCount ? ` · 下载中 ${runningCount}` : ""}</span>
          <button onClick={() => setAsc((v) => !v)} className="ml-auto text-[11px] text-primary pressable">{asc ? "倒序" : "正序"}</button>
        </div>
      ) : (
        <div className="shrink-0 flex items-center gap-2 px-4 h-12">
          <button onClick={toggleMode} disabled={!onDownloadEps}
            className={`h-7 px-2.5 rounded-full text-[11.5px] font-bold pressable flex items-center gap-1 ${mode === "dl" ? "bg-primary text-on-primary" : "bg-s3 text-on/85"}`}>
            {mode === "dl" ? <><IDownload size={11} />下载</> : "选集"}
          </button>
          <span className="text-[10.5px] text-mut">共 {episodes.length} 集{doneCount ? ` · 已下载 ${doneCount}` : ""}{runningCount ? ` · 下载中 ${runningCount}` : ""}</span>
          <button onClick={() => setAsc((v) => !v)} className="ml-auto text-[11px] text-primary pressable">{asc ? "倒序" : "正序"}</button>
          <button onClick={onClose} className="h-8 px-2.5 rounded-full bg-s3 flex items-center gap-1 text-mut pressable shrink-0">
            <IClose size={12} /><span className="text-[11px] font-semibold">关闭</span>
          </button>
        </div>
      )}
      {mode === "dl" && (
        <div className="shrink-0 px-4 pb-2 overflow-x-auto scroll-x">
          <DlActions />
        </div>
      )}
      <div className="flex-1 scroll-y px-5 pb-5">
        <div className="grid grid-cols-4 gap-2.5">
          {list.map((e) => {
            const st = epState(e.ep_num)?.status;
            const done = st === "done";
            const on = mode === "dl" && selected.has(e.ep_num);
            const marked = mode === "dl" && !!st && !done;
            const cur = e.ep_num === current && mode === "pick";
            return (
              <button key={e.ep_num} onClick={() => tapEp(e.ep_num)}
                className={`relative h-12 rounded-(--r-md) text-[13.5px] font-bold tabular-nums pressable flex items-center justify-center ring-1 ${on ? "bg-primary text-on-primary ring-primary" : marked ? "bg-primary/15 text-primary ring-primary/40" : cur ? "bg-primary text-on-primary ring-primary" : "bg-s3 text-on/85 ring-transparent"}`}>
                <span className="-mt-1">{e.ep_num}</span>
                {mode === "dl" && !done && (
                  <span className={`absolute top-1 right-1 w-[17px] h-[17px] rounded-full flex items-center justify-center ${on ? "bg-on-primary text-primary" : "bg-s2/80 text-mut ring-1 ring-mut/50"}`}>
                    {on && <ICheck size={10} strokeWidth={3} />}
                  </span>
                )}
                {st && <span className="absolute inset-x-0 bottom-1 text-center text-[8.5px] font-semibold leading-none">{epBadge(e.ep_num)}</span>}
              </button>
            );
          })}
        </div>
        {!episodes.length && <div className="text-center text-[11.5px] text-dim py-8">暂无剧集</div>}
      </div>
      {!bare && <div className="shrink-0 px-4 py-2.5 text-[10.5px] text-dim bg-s2/60">剧集 ID {videoId} · {mode === "dl" ? "勾选剧集 → 下载所选 / 一键全集下载" : "点选即切换播放"}</div>}
    </div>
  );
}

/* ================= 评论 ================= */
export function CommentsPanel({ videoId, ep, total, kind = "video", onClose }: {
  videoId: number; ep: number; total: number; kind?: "video" | "post"; onClose: () => void;
}) {
  const { toast } = useStore();
  const [items, setItems] = useState<Comment[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async (p: number) => {
    setLoading(true);
    try {
      const res: CommentPage | null = kind === "post"
        ? await api.postComments(videoId, p, 20)
        : await api.comments(videoId, ep, p, 20);
      setItems((prev) => {
        const base = p === 1 ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(p);
      setPages(res?.pagination?.pages || 1);
    } catch {
      if (p === 1) setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(1); /* eslint-disable-next-line */ }, [videoId, ep, kind]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setSending(true);
    try {
      await api.commentSend(videoId, ep, t);
      setText("");
      toast("评论已提交，审核通过后展示", "ok");
      load(1);
    } catch (e) {
      toast((e as Error).message || "评论失败", "info");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 h-12">
        <span className="text-[13.5px] font-bold text-on">评论</span>
        <span className="text-[10.5px] text-mut">{fmt(total)} · 第 {ep} 集</span>
        <button onClick={onClose} className="ml-auto h-8 px-3 rounded-full bg-s3 flex items-center gap-1 text-mut pressable">
          <IClose size={12} /><span className="text-[11.5px] font-semibold">关闭</span>
        </button>
      </div>

      <div className="flex-1 scroll-y px-4">
        {items.length ? items.map((c) => (
          <div key={c.id} className="flex gap-2.5 py-3 border-b border-s3 last:border-0">
            <Avatar size={32} name={c.nickname} hue={(c.user_id * 37) % 360} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[11.5px] font-semibold text-on/90">{c.nickname}</span>
                <span className="text-[10px] text-dim">{c.time}</span>
              </div>
              <p className="text-[12.5px] text-on/80 mt-1 leading-relaxed whitespace-pre-wrap">{c.text}</p>
              <div className="flex items-center gap-3 mt-1.5 text-[10.5px] text-dim">
                <span className="flex items-center gap-1"><IHeart size={11} />{c.like_count || 0}</span>
                {c.reply_count > 0 && <span>{c.reply_count} 条回复</span>}
              </div>
            </div>
          </div>
        )) : loading ? (
          <div className="flex justify-center py-10"><div className="w-7 h-7 spinner" /></div>
        ) : (
          <Empty icon={<IHeart size={22} />} title="还没有评论" sub="来抢第一个沙发" />
        )}
        {items.length > 0 && (
          <div className="flex justify-center py-4">
            {loading ? <div className="w-5 h-5 spinner" />
              : page < pages ? (
                <button onClick={() => load(page + 1)} className="px-4 h-8 rounded-(--r-ctl) bg-s3 text-[11.5px] text-on/80 pressable">查看更多</button>
              ) : <span className="text-[10.5px] text-dim">— 到底啦 —</span>}
          </div>
        )}
      </div>

      <form className="shrink-0 flex items-center gap-2 px-3 py-2.5 bg-s2/70" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <Avatar size={30} name="我" hue={322} />
        <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="说点什么…"
          className="flex-1 min-w-0 h-9 rounded-(--r-ctl) bg-s4 px-3.5 text-[12.5px] text-on placeholder-dim outline-none focus:bg-s3" />
        <button type="submit" disabled={!text.trim() || sending}
          className={`w-9 h-9 rounded-full flex items-center justify-center pressable ${text.trim() ? "brand-grad glow-neon" : "bg-s3 text-dim"}`}>
          {sending ? <span className="w-4 h-4 spinner" /> : <ISendF size={16} />}
        </button>
      </form>
    </div>
  );
}
/* ================= 图文正文（吃瓜） ================= */
export function ArticlePanel({ title, html, cover, hot, onClose }: {
  title: string; html: string; cover?: string; hot?: number; onClose: () => void;
}) {
  const { toast, strictSecurity } = useStore();
  const safeHtml = useMemo(() => sanitizeHtml(html), [html, strictSecurity]);
  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      navigator.clipboard?.writeText(url).then(() => toast("链接已复制", "ok")).catch(() => {});
    });
  };
  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 h-12">
        <span className="text-[13.5px] font-bold text-on">图文详情</span>
        {hot ? <span className="text-[10.5px] text-mut">{fmt(hot)} 热度</span> : null}
        <button onClick={onClose} className="ml-auto h-8 px-3 rounded-full bg-s3 flex items-center gap-1 text-mut pressable">
          <IClose size={12} /><span className="text-[11.5px] font-semibold">关闭</span>
        </button>
      </div>
      <div className="flex-1 scroll-y px-4 pb-6">
        {cover && <img src={imageCover(cover)} alt="" className="w-full rounded-(--r-md) mb-3 object-cover" />}
        <h2 className="text-[16px] font-bold text-on leading-snug">{title}</h2>
        <div className="article-body mt-3" onClick={(e) => handleArticleClick(e, openSafeLink)} dangerouslySetInnerHTML={{ __html: safeHtml }} />
        {!safeHtml && <p className="text-[12px] text-dim mt-4">这篇内容没有正文，可能只有图片或视频。</p>}
      </div>
    </div>
  );
}
