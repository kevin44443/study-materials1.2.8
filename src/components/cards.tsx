import React, { useState } from "react";
import { cover, fmt } from "../api";
import type { VideoCard } from "../types";
import { ICheck, IDownload, IFireF, IHeartF, IPlayF } from "../icons";
import { Img } from "./ui";
import { useStore } from "../store";
import { enqueueVideo } from "../downloader";

/** 卡片左下角「一键下载整部剧」：带文字标签，入队后变「已加入」 */
function CardDownload({ id, title, small = false }: { id: number; title: string; small?: boolean }) {
  const { toast } = useStore();
  const [state, setState] = useState<"idle" | "busy" | "ok">("idle");
  const h = small ? 20 : 22;
  return (
    <button
      type="button"
      aria-label="一键下载该剧"
      title="一键下载该剧"
      onClick={async (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (state !== "idle") return;
        setState("busy");
        try {
          const r = await enqueueVideo(id, title);
          setState("ok");
          toast(r.queued ? `已加入下载队列 ${r.queued} 集` : "该剧已全部下载", "ok");
          window.setTimeout(() => setState("idle"), 2400);
        } catch (err) {
          setState("idle");
          toast((err as Error).message || "下载失败", "info");
        }
      }}
      className="rounded-full flex items-center justify-center gap-1 shrink-0 pressable px-1.5"
      style={{
        height: h,
        background: state === "ok" ? "var(--p-primary)" : "rgba(0,0,0,.52)",
        color: state === "ok" ? "var(--p-on-primary)" : "#fff",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,.22)",
        backdropFilter: "blur(10px)",
      }}>
      {state === "busy" ? (
        <span className="w-3 h-3 spinner" style={{ borderWidth: 2 }} />
      ) : state === "ok" ? (
        <ICheck size={small ? 9 : 10} strokeWidth={2.6} />
      ) : (
        <IDownload size={small ? 9 : 10} strokeWidth={2.4} />
      )}
      <span className="text-[9px] font-semibold leading-none whitespace-nowrap">
        {state === "busy" ? "加入中" : state === "ok" ? "已加入" : "下载"}
      </span>
    </button>
  );
}

/* ——— 瀑布流卡片 ——— */
export function WaterfallCard({ v, onOpen }: { v: VideoCard; onOpen: () => void }) {
  const ratio = 1.32;
  return (
    <div role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="relative w-full overflow-hidden text-left bg-s1 elev-1 pressable block rounded-(--r-sm) cursor-pointer"
      style={{ paddingTop: `${ratio * 100}%` }}>
      <Img src={v.cover} />
      <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
      <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[9px] font-bold brand-grad elev-1">
        {v.is_finished ? "已完结" : `更新至${v.episode_count}集`}
      </span>
      <span className="absolute top-1.5 right-1.5 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-black/45 backdrop-blur-sm text-[9px] font-semibold text-white/90">
        <IPlayF size={9} />{fmt(v.hot)}
      </span>
      <div className="absolute inset-x-0 bottom-0 p-2">
        <div className="text-[11.5px] font-medium text-white leading-snug clamp-2 tsh">{v.title}</div>
        <div className="flex items-center justify-between gap-1.5 mt-1">
          <span className="flex items-center gap-1.5 min-w-0">
            {/* 左下角：一键下载该剧 */}
            <CardDownload id={v.id} title={v.title} />
            <span className="text-[9.5px] text-white/65 truncate">{v.author?.name || "黄果短剧"}</span>
          </span>
          <span className="flex items-center gap-0.5 text-[9.5px] text-white/75 shrink-0"><IHeartF size={10} className="text-white/70" />{fmt(v.like_count)}</span>
        </div>
      </div>
    </div>
  );
}

/* ——— 瀑布流（卡片间留出呼吸间距）——— */
export function Masonry({ videos, onOpen, wide = false, gap = "gap-2.5" }: {
  videos: VideoCard[]; onOpen: (v: VideoCard) => void; wide?: boolean; gap?: string;
}) {
  const mb = gap === "gap-1" ? "mb-1" : gap === "gap-2.5" ? "mb-2.5" : "mb-1.5";
  return (
    <div className={`${wide ? "columns-3 xl:columns-4" : "columns-2"} ${gap} [column-fill:balance]`}>
      {videos.map((v) => (
        <div key={v.id} className={`break-inside-avoid ${mb}`}>
          <WaterfallCard v={v} onOpen={() => onOpen(v)} />
        </div>
      ))}
    </div>
  );
}

/* ——— 分类横向卡片 ——— */
export function RowCard({ v, onOpen }: { v: VideoCard; onOpen: () => void }) {
  return (
    <div role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="w-[104px] shrink-0 text-left snap-start pressable group cursor-pointer">
      <div className="relative w-full rounded-(--r-sm) overflow-hidden bg-s1 elev-1" style={{ paddingTop: "133%" }}>
        <Img src={v.cover} />
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/75 to-transparent" />
        <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[8.5px] font-bold brand-grad">
          {v.is_finished ? "完结" : `${v.episode_count}集`}
        </span>
        <span className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 text-[9px] font-semibold text-white/90 tsh"><IPlayF size={9} />{fmt(v.hot)}</span>
        <span className="absolute bottom-1.5 left-1.5 z-10" onClick={(e) => e.stopPropagation()}>
          <CardDownload id={v.id} title={v.title} small />
        </span>
      </div>
      <div className="mt-1.5 text-[11.5px] font-medium text-on clamp-1 leading-tight">{v.title}</div>
      <div className="text-[10px] text-mut clamp-1 mt-0.5">{v.tags?.slice(0, 2).join(" · ")}</div>
    </div>
  );
}

/* ——— 排行榜卡片（双列）——— */
export function RankCard({ item, onOpen, metricMax }: {
  item: { rank: number; video_id: number; title: string; cover: string; tags: string[]; score: number; metric_value: number; metric_label: string;
    episode_count?: number; is_finished?: boolean };
  onOpen: () => void; metricMax: number;
}) {
  const i = item.rank - 1;
  const epText = item.is_finished
    ? (item.episode_count ? `已完结 · 共 ${item.episode_count} 集` : "已完结")
    : (item.episode_count ? `更新至第 ${item.episode_count} 集` : "");
  return (
    <div role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className={`w-full text-left rounded-(--r-md) overflow-hidden bg-s2 elev-1 pressable a-rise cursor-pointer ${i < 3 ? "ring-1 ring-primary/35" : ""}`}
      style={{ animationDelay: `${Math.min(i * 35, 300)}ms` }}>
      <div className="relative w-full" style={{ paddingTop: "136%" }}>
        <Img src={item.cover} />
        <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" />
        {/* 名次 */}
        <span className={`absolute top-1.5 left-1.5 min-w-[22px] h-[22px] px-1.5 rounded-full flex items-center justify-center text-[11.5px] font-bold tabular-nums elev-1 ${i === 0 ? "bg-primary text-on-primary" : i < 3 ? "bg-pc text-on-pc" : "bg-black/55 text-white/90 backdrop-blur-sm"}`}>
          {item.rank}
        </span>
        {/* 热度 */}
        <span className="absolute top-1.5 right-1.5 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-black/45 backdrop-blur-sm text-[9px] font-semibold text-white/90">
          <IPlayF size={9} />{fmt(item.metric_value)}
        </span>
        {/* 集数角标 */}
        <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[9px] font-bold text-white/95"
          style={{ background: "rgba(0,0,0,.55)" }}>
          {item.is_finished ? `全${item.episode_count || 0}集` : `${item.episode_count || 0}集`}
        </span>
      </div>
      <div className="p-2">
        <div className="text-[11.5px] font-medium text-on clamp-2 leading-snug">{item.title}</div>
        <div className="flex items-center justify-between mt-1">
          <span className="flex items-center gap-1.5 min-w-0">
            <span onClick={(e) => e.stopPropagation()}><CardDownload id={item.video_id} title={item.title} small /></span>
            <span className="text-[9.5px] text-mut truncate">{item.tags?.slice(0, 1).join("")}</span>
          </span>
          <span className="flex items-center gap-0.5 text-[10px] font-bold text-primary shrink-0"><IFireF size={9} />{fmt(item.metric_value)}</span>
        </div>
        {epText && <div className="text-[9.5px] text-mut mt-1">{epText}</div>}
        <div className="mt-1.5 h-[3px] rounded-full bg-s4 overflow-hidden">
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(6, Math.round((item.metric_value / Math.max(1, metricMax)) * 100))}%` }} />
        </div>
      </div>
    </div>
  );
}