import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { RankItem, VideoCard } from "../types";
import { useStore } from "../store";
import { Masonry } from "../components/cards";
import { Empty } from "../components/ui";
import { IFireF, IClock, IGrid } from "../icons";

/** 首页频道：AI成人短剧卡片瀑布流 */
const HOME_CATE = { cate: "ai-duanju", name: "AI成人短剧", desc: "高能反转 · 一口气看完" };

/** 排序：最受欢迎（热度榜）/ 最近更新（分类按上新时间） */
type Sort = "hot" | "new";

/** 热度榜条目 → 瀑布流卡片 */
const rankToCard = (r: RankItem): VideoCard => ({
  id: r.video_id,
  title: r.title,
  cover: r.cover,
  tags: r.tags || [],
  score: r.score || 0,
  episode_count: r.episode_count || 0,
  total_episodes: r.episode_count || 0,
  hot: r.metrics?.play || r.metric_value || 0,
  like_count: r.metrics?.like || 0,
  collect_count: r.metrics?.collect || 0,
  comment_count: r.metrics?.comment || 0,
  is_finished: !!r.is_finished,
  is_original: 0,
});

export default function Home({ active }: { active: boolean; bottomInset?: number }) {
  const { push, prefetchNext } = useStore();
  const [sort, setSort] = useState<Sort>("hot");
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /** 热度榜没有分页：拉到就整份展示，避免滚动中反复插队 */
  const [rankOnly, setRankOnly] = useState(false);
  const busy = useRef(false);
  const loadedSort = useRef<Sort | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  /* 页面预缓存：已提前拉好的下一页数据，滚动到底直接无缝衔接 */
  const cache = useRef<Record<number, VideoCard[]>>({});
  const prefetching = useRef<Set<number>>(new Set());

  const append = (list: VideoCard[]) => {
    setItems((prev) => {
      const seen = new Set(prev.map((x) => x.id));
      return [...prev, ...list.filter((x) => !seen.has(x.id))];
    });
  };

  /* 分类分页（最近更新 / 热度榜拉取失败时的兜底） */
  const loadPage = useCallback(async (p: number) => {
    if (busy.current || p > pages) return;
    const hit = cache.current[p];
    if (hit?.length) {
      delete cache.current[p];
      append(hit);
      setPage(p);
      return;
    }
    busy.current = true;
    setLoading(true);
    setError("");
    try {
      const res = await api.category(HOME_CATE.cate, p, 12);
      append(res?.items || []);
      setPage(p);
      setPages(res?.pagination?.pages || p);
    } catch (e) {
      setError((e as Error).message || "加载失败");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [pages]);

  /* 最受欢迎：直接取官方热度榜，整份展示 */
  const loadRank = useCallback(async () => {
    busy.current = true;
    setLoading(true);
    setError("");
    try {
      const res = await api.rank("hot");
      const list = (res?.items || []).map(rankToCard);
      if (list.length) {
        setItems(list);
        setRankOnly(true);
        setPage(1);
        setPages(1);
      } else {
        /* 榜单为空：退回分类按热度排序 */
        setRankOnly(false);
        await loadPage(1);
      }
    } catch {
      setRankOnly(false);
      await loadPage(1);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [loadPage]);

  /* 切换排序：换源重新拉，保证首屏就是该排序的头几名 */
  useEffect(() => {
    if (!active) return;
    if (loadedSort.current === sort) return;
    loadedSort.current = sort;
    setItems([]);
    setPage(0);
    setPages(1);
    setError("");
    if (sort === "hot") void loadRank();
    else void loadPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sort]);

  /* 当前页出现后，后台静默预取下一页（可在设置里关闭） */
  useEffect(() => {
    if (sort !== "new" || !prefetchNext || !page || page >= pages) return;
    const next = page + 1;
    if (cache.current[next] || prefetching.current.has(next)) return;
    prefetching.current.add(next);
    let alive = true;
    api.category(HOME_CATE.cate, next, 12)
      .then((res) => {
        if (alive && res?.items?.length) cache.current[next] = res.items;
      })
      .catch(() => {})
      .finally(() => { prefetching.current.delete(next); });
    return () => { alive = false; };
  }, [sort, page, pages, prefetchNext]);

  /* 无限滚动（热度榜一次性给全，不再翻页） */
  useEffect(() => {
    const el = sentinel.current;
    if (!el || rankOnly) return;
    const io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting && !error && page < pages) void loadPage(page + 1);
    }, { rootMargin: "500px" });
    io.observe(el);
    return () => io.disconnect();
  }, [page, pages, error, loadPage, rankOnly]);

  /* 最近更新：按上新时间排（上游基本已按此序，这里保证稳定） */
  const view = useMemo(() => {
    if (sort === "hot") return items;
    const at = (v: VideoCard) =>
      Number(v.new_at || v.last_ep_at || 0) || (v.created_at ? Date.parse(v.created_at) || 0 : 0);
    return [...items].sort((a, b) => at(b) - at(a));
  }, [items, sort]);

  const switchSort = (k: Sort) => {
    if (k === sort) return;
    setSort(k);
  };

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      {/* 页头 */}
      <div className="shrink-0 px-4 pb-1" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
        <div className="flex items-end gap-2.5">
          <span className="text-[24px] font-bold text-on leading-none">{HOME_CATE.name}</span>
          <span className="text-[11px] text-mut pb-0.5">{HOME_CATE.desc}</span>
        </div>
        {/* 排序：最受欢迎 / 最近更新 */}
        <div className="flex items-center gap-2 mt-3">
          <button onClick={() => switchSort("hot")}
            className={`h-8 px-3 rounded-full text-[12px] font-semibold flex items-center gap-1 pressable ${sort === "hot" ? "bg-primary text-on-primary" : "bg-s3 text-mut"}`}>
            <IFireF size={12} />最受欢迎
          </button>
          <button onClick={() => switchSort("new")}
            className={`h-8 px-3 rounded-full text-[12px] font-semibold flex items-center gap-1 pressable ${sort === "new" ? "bg-primary text-on-primary" : "bg-s3 text-mut"}`}>
            <IClock size={12} />最近更新
          </button>
          <span className="ml-auto text-[10px] text-dim text-right leading-tight">
            {sort === "hot" ? (rankOnly ? "热度榜 · 全站最热" : "按播放热度") : "按上新时间"}
          </span>
        </div>
      </div>

      <div className="flex-1 scroll-y px-4 pt-2 pb-28">
        {view.length ? (
          <>
            <Masonry videos={view} onOpen={(v) => push({ kind: "feed", videoIds: view.map((x) => x.id), index: view.findIndex((x) => x.id === v.id), title: HOME_CATE.name })} />
            <div ref={sentinel} className="h-8" />
            <div className="flex justify-center py-3">
              {loading ? <div className="w-6 h-6 spinner" />
                : rankOnly ? (
                  <span className="text-[10.5px] text-dim">— 已展示热度榜全部内容 —</span>
                ) : page < pages ? (
                  <button onClick={() => void loadPage(page + 1)} className="px-5 h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-on/85 pressable">加载更多</button>
                ) : (
                  <span className="text-[10.5px] text-dim">— 已经到底啦 —</span>
                )}
            </div>
          </>
        ) : loading ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
        ) : error ? (
          <Empty icon={<IGrid size={26} />} title="首页加载失败" sub={error} action="重试"
            onAction={() => { if (sort === "hot") void loadRank(); else void loadPage(1); }} />
        ) : (
          <Empty icon={<IGrid size={26} />} title="暂无内容" sub="稍后再来看看" />
        )}
      </div>
    </div>
  );
}
