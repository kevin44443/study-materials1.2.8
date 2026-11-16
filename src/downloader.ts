import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";

/** 一次下载请求（Rust 侧按队列顺序执行） */
export type EnqueueItem = { video_id: number; ep: number; url: string; title: string; cover?: string };

/** 把若干集交给后台下载队列，立刻返回，不阻塞界面。
 *  取播放地址按 6 条一批并行，拿到一批就入队一批 —— 集数很多时也能马上开始下。 */
export async function enqueueEpisodes(videoId: number, title: string, eps: number[], cover = "") {
  if (!eps.length) return { queued: 0, skipped: 0 };
  let queued = 0;
  let skipped = 0;
  let sent = 0;
  const CHUNK = 6;
  for (let i = 0; i < eps.length; i += CHUNK) {
    const batch = eps.slice(i, i + CHUNK);
    const got = await Promise.all(batch.map(async (ep): Promise<EnqueueItem | null> => {
      try {
        const info = await api.play(videoId, ep);
        return info?.video_url ? { video_id: videoId, ep, url: info.video_url, title, cover } : null;
      } catch {
        return null;
      }
    }));
    const items = got.filter((x): x is EnqueueItem => !!x);
    if (!items.length) continue;
    sent += items.length;
    const r = await invoke<{ queued?: number; skipped?: number }>("dl_enqueue", { items });
    queued += r?.queued || 0;
    skipped += r?.skipped || 0;
  }
  if (!sent) throw new Error("暂无可下载的播放地址");
  return { queued, skipped };
}

/** 一键下载整部剧：先取详情拿全部集数，再整体入队 */
export async function enqueueVideo(videoId: number, title?: string) {
  const d = await api.video(videoId);
  const eps = (d?.episodes || []).map((e) => e.ep_num).filter((n) => Number.isFinite(n));
  if (!eps.length) throw new Error("该剧暂无剧集");
  return enqueueEpisodes(videoId, d?.title || title || "", eps, d?.cover || "");
}

export const dlMb = (n?: number) => {
  const v = n || 0;
  return v >= 1024 * 1024 ? `${(v / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(v / 1024))} KB`;
};
