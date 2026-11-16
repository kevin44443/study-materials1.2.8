import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api, cover, fmt, fmtTime, isMobile, LOCAL } from "../api";
import type { Detail, Episode, Post, VideoCard } from "../types";
import { useStore } from "../store";
import { Avatar, Img, Sheet } from "./ui";
import VideoSurface, { type VideoHandle } from "./VideoSurface";
import PlayerControls from "./PlayerControls";
import PlaybackLock from "./PlaybackLock";
import { ArticlePanel, CommentsPanel, EpisodesPanel } from "./Panels";
import { setBackHandler } from "../back";
import { enqueueEpisodes } from "../downloader";
import {
  IBack, IBoltF, IChevR, IChevronDown, IChevronUp, IClose, ICommentF, ICompress, IExpand, IFileText, IHeart, IHeartF,
  IInfo, ILink, IList, ILockF, IPauseF, IPlayF, ISearch, IStar, IStarF, IVol, IVolMute,
} from "../icons";

/** 预设倍速档位（含 3x / 4x），倍速面板里另有 0.25-6 自定义 */
const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

type Props = {
  videoIds: number[];
  startIndex?: number;
  title?: string;
  mode: "home" | "context";
  kind?: "video" | "post";
  active: boolean;
  bottomInset: number;
  onBack?: () => void;
  onNearEnd?: () => void;
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
};

export default function Feed({ videoIds, startIndex = 0, title = "", mode, kind = "video", active, bottomInset, onBack, onNearEnd, startEp, startTime }: Props) {
  const store = useStore();
  const { isLiked, isFav, toggleLikeLocal, toggleFavLocal, toggleFollowLocal, muted, setMuted, volume, setVolume, toast, addHistory } = store;
  const isDesktop = !isMobile;

  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoHandle>(null);
  const [index, setIndex] = useState(startIndex);
  const [epMap, setEpMap] = useState<Record<number, number>>(() => (startEp ? { [videoIds[startIndex]]: startEp } : {}));
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const [playUrls, setPlayUrls] = useState<Record<string, string>>({});
  const [cards] = useState<Record<number, VideoCard>>({});
  const [posts, setPosts] = useState<Record<number, Post>>({});

  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [vsize, setVsize] = useState({ w: 0, h: 0 });
  const [buffered, setBuffered] = useState(0);
  const [paused, setPaused] = useState(false);
  const [controlsLocked, setControlsLocked] = useState(false);
  const [rate, setRate] = useState(1);
  const [waiting, setWaiting] = useState(false);
  const [err, setErr] = useState("");
  /* 取播放地址失败后手动重试：递增即重新触发拉取 */
  const [playTry, setPlayTry] = useState(0);
  const [panel, setPanel] = useState<"episodes" | "comments" | "article" | "detail" | null>(null);
  const [descOpen, setDescOpen] = useState(false);
  /* 续播：拿到时长后再 seek 一次（只对进入时那一条生效） */
  const resumeRef = useRef<{ key: string; t: number } | null>(
    startTime && startTime > 1 ? { key: `${videoIds[startIndex]}:${startEp || 1}`, t: startTime } : null,
  );
  /* 观看进度：onTime 里节流写回 store，卸载时再兜一次 */
  const liveRef = useRef({ id: 0, ep: 1, dur: 0, t: 0 });
  const lastSaveRef = useRef(0);
  const theater = store.theater;
  const setTheater = store.setTheater;
  const fs = store.fs;
  const setFs = store.setFs;
  const clean = store.clean;
  const setClean = store.setClean;

  /* 全屏：手指触碰屏幕呼出「顶部剧名/集数/总进度 + 底部控制条」，3.2 秒后自动隐藏 */
  const [fsUi, setFsUi] = useState(false);
  const fsUiTimer = useRef<number | null>(null);
  const showFsUi = useCallback(() => {
    setFsUi(true);
    if (fsUiTimer.current) window.clearTimeout(fsUiTimer.current);
    fsUiTimer.current = window.setTimeout(() => {
      fsUiTimer.current = null;
      setFsUi(false);
    }, 3200);
  }, []);
  useEffect(() => {
    if (fs) showFsUi();
    else {
      setFsUi(false);
      if (fsUiTimer.current) { window.clearTimeout(fsUiTimer.current); fsUiTimer.current = null; }
    }
  }, [fs, showFsUi]);
  useEffect(() => () => { if (fsUiTimer.current) window.clearTimeout(fsUiTimer.current); }, []);

  /* 追踪手机视口是否已处于物理/系统横屏状态（window.innerWidth > window.innerHeight） */
  const [vpLandscape, setVpLandscape] = useState(
    () => typeof window !== "undefined" && window.innerWidth > window.innerHeight,
  );

  /* 单击清屏 vs 双击暂停计时器 */
  const lastTapRef = useRef<{ time: number; timer: number | null }>({ time: 0, timer: null });
  const clearTapTimer = () => {
    if (lastTapRef.current.timer) {
      window.clearTimeout(lastTapRef.current.timer);
      lastTapRef.current.timer = null;
    }
  };

  /* 桌面：鼠标闲置 2.8s 自动隐藏播放器 UI（沉浸） */
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2800);
  }, []);
  useEffect(() => {
    if (!isDesktop) return undefined;
    wake();
    return () => window.clearTimeout(idleTimer.current);
  }, [isDesktop, wake]);
  useEffect(() => {
    if (paused) { setIdle(false); window.clearTimeout(idleTimer.current); }
  }, [paused]);
  const [fullscreen, setFullscreen] = useState(false);
  const [heartBurst, setHeartBurst] = useState(0);
  /* —— 移动端手势 & 竖屏横片缩放 —— */
  const [holdSpeed, setHoldSpeed] = useState(false);
  const [speedLock, setSpeedLock] = useState(false);
  /* 倍速面板：预设含 3x/4x，另支持 0.25-6 自定义 */
  const [speedPanel, setSpeedPanel] = useState(false);
  const [customRateOpen, setCustomRateOpen] = useState(false);
  const [customRateVal, setCustomRateVal] = useState("");
  /* 倍速悬浮球：按住上下滑动调倍率（每 80px ≈ 1x，0.25-6）；
     长按 420ms 进入「拖动摆放」模式，可拖到左手拇指顺手的位置，位置本地持久化 */
  const [rateDrag, setRateDrag] = useState<{ y0: number; base: number; cur: number } | null>(null);
  const RATE_PER_PX = 1 / 80;
  /* v2：默认位置改到「左下四分之一」处，旧版本记住的中间位置一次作废 */
  const RATE_POS_KEY = "hghub.rateBall.pos.v2";
  const defaultRatePos = () => ({
    x: 6,
    y: Math.round((window.innerHeight || 640) * 0.72),
  });
  const [ratePos, setRatePos] = useState<{ x: number; y: number }>(() => {
    try {
      const raw = localStorage.getItem("hghub.rateBall.pos.v2");
      if (raw) {
        const p = JSON.parse(raw) as { x?: number; y?: number };
        if (typeof p?.x === "number" && typeof p?.y === "number") return { x: p.x, y: p.y };
      }
    } catch { /* ignore */ }
    return defaultRatePos();
  });
  const [rateMoving, setRateMoving] = useState(false);
  /* 长条倍速条：手指触碰显示，松手 3 秒后自动隐藏；拖动摆放/调速期间常显 */
  const [rateShown, setRateShown] = useState(false);
  const rateHideTimer = useRef<number | null>(null);
  const showRateBar = useCallback(() => {
    if (rateHideTimer.current) { window.clearTimeout(rateHideTimer.current); rateHideTimer.current = null; }
    setRateShown(true);
  }, []);
  const scheduleHideRateBar = useCallback(() => {
    if (rateHideTimer.current) window.clearTimeout(rateHideTimer.current);
    rateHideTimer.current = window.setTimeout(() => {
      rateHideTimer.current = null;
      setRateShown(false);
    }, 3000);
  }, []);
  useEffect(() => () => { if (rateHideTimer.current) window.clearTimeout(rateHideTimer.current); }, []);
  const rateGesture = useRef<{
    x0: number; y0: number; baseRate: number; posX: number; posY: number; timer: number | null; moved: boolean;
  } | null>(null);
  const [lockArmed, setLockArmed] = useState(false);
  const holdRef = useRef(false);
  const lockArmedRef = useRef(false);
  const [scrub, setScrub] = useState<{ pct: number; target: number } | null>(null);
  const scrubTarget = useRef<number | null>(null);
  /* 竖屏下横屏视频适应模式 + 双指无级缩放/平移 */
  const [portraitFit, setPortraitFit] = useState<"contain" | "cover">("contain");
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0, gesturing: false });
  const pinchRef = useRef<{
    dist0: number; midX0: number; midY0: number; scale0: number; x0: number; y0: number;
  } | null>(null);
  /* 进度条拖动 */
  const barScrub = useRef(false);
  const [barPct, setBarPct] = useState<number | null>(null);
  const gesture = useRef<{
    x: number; y: number; startX: number; startY: number; t: number; timer: number | null;
    mode: "idle" | "hold" | "scrub" | "pan"; base: number; width: number; playing: boolean;
  } | null>(null);

  const curId = videoIds[index];
  const detail = details[curId];
  const curEp = epMap[curId] || 1;
  const playKey = `${curId}:${curEp}`;
  const playUrl = playUrls[playKey] || "";
  useEffect(() => { videoRef.current?.trace("page.active", { active, view: mode, video_id: curId, episode: curEp }); }, [active, mode, curId, curEp]);
  const episodes = detail?.episodes || [];
  const post = posts[curId];

  /* 观看进度：onTime 里每 5 秒落一次；拖动进度条期间忽略底层 timeupdate 防止进度条回跳 */
  const onTimeTick = (t: number) => {
    liveRef.current = { id: curId, ep: curEp, dur: duration, t };
    if (!barScrub.current && gesture.current?.mode !== "scrub") {
      setTime(t);
    }
    /* 播到一半：静默预缓存下一集（只缓存，不算「下载」） */
    if (duration > 0 && t >= duration * 0.5) void prefetchNextEp(curId, curEp);
    const now = Date.now();
    if (duration > 0 && now - lastSaveRef.current > 5000) {
      lastSaveRef.current = now;
      addHistory(curId, curEp, t, duration);
    }
  };

  /* 拿到时长后再续播：只对进入时那一条生效，且不跳到片尾 */
  const onDurationTick = (d: number) => {
    setDuration(d);
    liveRef.current = { ...liveRef.current, dur: d };
    const r = resumeRef.current;
    if (r && r.key === playKey && r.t > 1 && (!d || r.t < d - 3)) {
      resumeRef.current = null;
      videoRef.current?.seek(r.t, "history_resume");
      setTime(r.t);
    }
  };

  /** 统一视图模型：短剧与吃瓜帖子共用同一套播放界面 */
  const meta = kind === "post"
    ? {
        title: post?.title || "",
        cover: post?.cover || "",
        desc: post?.content || post?.desc || "",
        author: "黄果吃瓜",
        authorId: -1,
        tags: post?.tags || [],
        score: 0,
        like: 0,
        comment: 0,
        collect: 0,
        episodes: [] as Episode[],
      }
    : {
        title: detail?.title || cards[curId]?.title || "",
        cover: detail?.cover || cards[curId]?.cover || "",
        desc: detail?.description || "",
        author: detail?.author?.name || "黄果短剧",
        authorId: detail?.author?.id || -1,
        tags: detail?.tags || [],
        score: detail?.score || 0,
        like: detail?.counts?.like ?? cards[curId]?.like_count ?? 0,
        comment: detail?.counts?.comment ?? cards[curId]?.comment_count ?? 0,
        collect: detail?.counts?.collect ?? cards[curId]?.collect_count ?? 0,
        episodes: detail?.episodes || [],
      };

  const posterUrl = cover(meta.cover, 900);
  const hasVideo = kind === "video" || !!post?.video_url;
  const articleHtml = kind === "post" && !hasVideo ? (post?.content || "") : "";

  /* 分享：复制播放链接 */
  const shareLink = () => {
    const u = kind === "post" ? (posts[curId]?.video_url || meta.title) : `https://huangguoai.com/video/${curId}/`;
    navigator.clipboard?.writeText(u).then(() => toast("链接已复制", "ok")).catch(() => {});
  };

  /* 倍速：长按 / 锁定 → 2.0x，否则用基准倍速 */
  const effRate = holdSpeed || speedLock ? 2 : rate;
  /* 进度条显示百分比（拖动时用拖动值） */
  const barProgress = barPct ?? (duration ? time / duration : 0);
  /* 是否为横屏视频（16:9 等宽大于高） */
  const isLandscapeVideo = vsize.w > vsize.h && vsize.h > 0;
  /* 仅当「全屏 + 横屏视频 + 手机系统视口尚未横过来 (!vpLandscape)」时才用 CSS 旋转 90° 兜底；
     一旦系统屏幕已经横过来了 (vpLandscape === true)，不再叠加 CSS 旋转，彻底解决手机横置后视频反而竖过去的问题！ */
  const rotated = !isDesktop && fs && isLandscapeVideo && !vpLandscape;

  /* 借鉴 stclock1988/hghub-ios (PlayerView.swift keepPlayingThroughTransition)：
     iOS 在横竖屏几何旋转或全屏视图层级切换期间，系统底层 AVPlayer / WebKit 视频层可能被短暂挂起暂停。
     在过渡窗口期内分批重申 play()，确保旋转/全屏切换不中断播放。 */
  const keepPlayingTimers = useRef<number[]>([]);
  const keepPlayingThroughTransition = useCallback(() => {
    keepPlayingTimers.current.forEach((id) => window.clearTimeout(id));
    keepPlayingTimers.current = [];
    const el = videoRef.current?.el();
    const shouldPlay = el ? !el.paused : !paused;
    if (!shouldPlay) return;
    for (const delay of [50, 150, 300, 500, 800, 1200]) {
      const tid = window.setTimeout(() => {
        const v = videoRef.current?.el();
        if (v && v.paused && !v.ended) {
          videoRef.current?.play();
        }
      }, delay);
      keepPlayingTimers.current.push(tid);
    }
  }, [paused]);

  useEffect(() => () => {
    keepPlayingTimers.current.forEach((id) => window.clearTimeout(id));
  }, []);

  /* 监听手机屏幕横竖屏变化：物理横置手机时自动进入全屏，竖回时自动退出全屏 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const onViewportChange = () => {
      const isLand = window.innerWidth > window.innerHeight;
      setVpLandscape((prev) => {
        if (prev !== isLand && active) {
          setFs(isLand);
          keepPlayingThroughTransition();
        }
        return isLand;
      });
    };
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("orientationchange", onViewportChange);
    };
  }, [isDesktop, active, setFs, keepPlayingThroughTransition]);

  /* 进入 / 退出全屏：对横屏视频直接调用原生屏幕方向切换，让手机系统界面真正横过来 */
  const enterFs = useCallback(() => {
    keepPlayingThroughTransition();
    setClean(false);
    setFs(true);
    if (isLandscapeVideo) {
      invoke("set_orientation", { landscape: true }).catch(() => {});
      try {
        (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.("landscape")?.catch(() => {});
      } catch { /* ignore */ }
    }
  }, [isLandscapeVideo, setClean, setFs, keepPlayingThroughTransition]);

  const exitFs = useCallback(() => {
    keepPlayingThroughTransition();
    setClean(false);
    setFs(false);
    invoke("set_orientation", { landscape: false }).catch(() => {});
    try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
  }, [setClean, setFs, keepPlayingThroughTransition]);

  /* 全屏状态下若视频宽高刚加载出来且为横屏，自动补发一次横屏指令 */
  useEffect(() => {
    if (!isDesktop && fs && isLandscapeVideo) {
      invoke("set_orientation", { landscape: true }).catch(() => {});
    }
  }, [isDesktop, fs, isLandscapeVideo]);

  /* 全屏切换或视口旋转后校准滚动容器 scrollTop：
     - 进入全屏时非当前项已隐藏，当前项位于顶部 scrollTop = 0；
     - 退出全屏回到竖屏列表时，立即将 scrollTop 重新对齐到 index * clientHeight，防止错位到其它视频封面。 */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    if (fs) {
      el.scrollTop = 0;
      return undefined;
    }
    const syncScroll = () => {
      const box = boxRef.current;
      if (!box || fs) return;
      box.scrollTop = index * (box.clientHeight || 1);
    };
    syncScroll();
    const raf = requestAnimationFrame(syncScroll);
    const t1 = window.setTimeout(syncScroll, 120);
    const t2 = window.setTimeout(syncScroll, 350);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [fs, vpLandscape, index]);

  /* 滚动定位（全屏或缩放手势期间锁定索引，避免容器尺寸变化误触发翻页） */
  const onScroll = useCallback(() => {
    if (fs || pinchRef.current) return;
    const el = boxRef.current;
    if (!el) return;
    const h = el.clientHeight || 1;
    const i = Math.max(0, Math.min(videoIds.length - 1, Math.round(el.scrollTop / h)));
    setIndex((prev) => (prev === i ? prev : i));
    if (onNearEnd && i >= videoIds.length - 3) onNearEnd();
  }, [videoIds.length, onNearEnd, fs]);

  const go = useCallback((delta: number) => {
    const el = boxRef.current;
    if (!el) return;
    const next = Math.max(0, Math.min(videoIds.length - 1, index + delta));
    el.scrollTo({ top: next * el.clientHeight, behavior: "smooth" });
  }, [index, videoIds.length]);

  /* 初始定位 */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = startIndex * (el.clientHeight || 1);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 拉详情（当前 + 邻接预取） */
  useEffect(() => {
    let alive = true;
    const need = [videoIds[index], videoIds[index + 1], videoIds[index - 1]].filter(Boolean);
    need.forEach((id) => {
      if (details[id]) return;
      api.video(id).then((d) => { if (alive) setDetails((m) => ({ ...m, [id]: d })); }).catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, videoIds]);

  /* 吃瓜帖子：直接拿帖子详情（含 video_url） */
  useEffect(() => {
    if (kind !== "post") return;
    let alive = true;
    [videoIds[index], videoIds[index + 1], videoIds[index - 1]].filter(Boolean).forEach((id) => {
      if (posts[id]) return;
      api.post(id).then((p) => { if (alive) setPosts((m) => ({ ...m, [id]: p })); }).catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, index, videoIds]);

  /* 拉播放地址：先查离线缓存（下载过的直接本地播），否则走上游。
     不再自动整集下载；播放过半时只静默预缓存「下一集」，减少切集等待。 */
  const episodesRef = useRef(episodes);
  episodesRef.current = episodes;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  /* 已触发过预缓存的集，避免 timeupdate 高频重复调用 */
  const prefetchRef = useRef<Set<string>>(new Set());
  const prefetchNextEp = useCallback(async (vid: number, ep: number) => {
    const key = `${vid}:${ep + 1}`;
    if (prefetchRef.current.has(key)) return;
    if (!episodesRef.current.some((e) => e.ep_num === ep + 1)) return;
    prefetchRef.current.add(key);
    try {
      const st = await invoke<{ done?: boolean; meta?: { status?: string } }>("dl_get", { videoId: vid, ep: ep + 1 });
      const s = st?.meta?.status;
      if (st?.done || s === "downloading" || s === "queued" || s === "paused") return;
      const info = await api.play(vid, ep + 1);
      if (!info?.video_url) return;
      // auto=true：只做播放缓存，不在「离线视频」里作为下载展示
      void invoke("dl_start", {
        videoId: vid, ep: ep + 1, url: info.video_url,
        title: detailRef.current?.title || "", auto: true,
        cover: detailRef.current?.cover || "",
      }).catch(() => {});
    } catch { /* 预缓存失败不影响播放 */ }
  }, []);
  useEffect(() => {
    if (!curId) return;
    if (playUrls[playKey]) return;
    let alive = true;
    invoke("dl_get", { videoId: curId, ep: curEp })
      .then((r) => {
        const hit = r && (r as { done?: boolean; key?: string }).done && (r as { key?: string }).key;
        if (!alive) return;
        if (hit) {
          setPlayUrls((m) => ({ ...m, [playKey]: `${LOCAL}/file?k=${(r as { key: string }).key}/index.m3u8` }));
          addHistory(curId, curEp);
          return;
        }
        throw new Error("miss");
      })
      .catch(() => {
        api.play(curId, curEp)
          .then((info) => {
            if (!alive) return;
            if (!info?.video_url) throw new Error("暂无播放地址");
            setPlayUrls((m) => ({ ...m, [playKey]: info.video_url }));
            addHistory(curId, curEp);
          })
          .catch((e) => { if (alive) setErr((e as Error).message || "取播放地址失败"); });
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId, curEp, playTry]);

  /* 切换条目/集数时重置播放与缩放状态 */
  useEffect(() => {
    setTime(0); setDuration(0); setBuffered(0); setErr(""); setWaiting(true); setPaused(false); setDescOpen(false);
    setVsize({ w: 0, h: 0 });
    setPortraitFit("contain");
    setZoom({ scale: 1, x: 0, y: 0, gesturing: false });
  }, [playKey]);

  /* 进出全屏时复位双指缩放并校准滚动条位置 */
  useEffect(() => {
    setZoom({ scale: 1, x: 0, y: 0, gesturing: false });
    if (!fs && boxRef.current) {
      const el = boxRef.current;
      requestAnimationFrame(() => {
        el.scrollTop = index * (el.clientHeight || 1);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs]);

  /* 全屏黑屏兜底：切到全屏后若视频层迟迟没有出帧（readyState < 2），
     说明渲染/解码在视口变化时被挂起了，主动重新起播一次。 */
  useEffect(() => {
    if (!fs) return undefined;
    const t = window.setTimeout(() => {
      const v = videoRef.current?.el();
      if (v && v.readyState < 2) videoRef.current?.reload();
    }, 800);
    return () => window.clearTimeout(t);
  }, [fs]);

  /* 音量/静音同步 */
  useEffect(() => { videoRef.current?.mute(muted); }, [muted]);
  useEffect(() => { videoRef.current?.volume(volume); }, [volume]);
  /* 倍速同步（长按 2x / 锁定 2x / 基准倍速） */
  useEffect(() => { videoRef.current?.rate(effRate); }, [effRate, playKey]);

  /* 离开播放页时把最后位置落盘并清理计时器 */
  useEffect(() => () => {
    clearTapTimer();
    const s = liveRef.current;
    if (s.id && s.dur) addHistory(s.id, s.ep, s.t, s.dur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 键盘 */
  useEffect(() => {
    if (!active || controlsLocked) return;
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (panel) { if (e.key === "Escape") setPanel(null); return; }
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); go(1); break;
        case "ArrowUp": e.preventDefault(); go(-1); break;
        case " ": e.preventDefault(); videoRef.current?.toggle(); break;
        case "ArrowLeft": e.preventDefault(); videoRef.current?.seek(Math.max(0, time - 5), "keyboard_shortcut"); break;
        case "ArrowRight": e.preventDefault(); videoRef.current?.seek(time + 5, "keyboard_shortcut"); break;
        case "f": case "F": toggleFull(); break;
        case "t": case "T": setTheater((v) => !v); break;
        case "m": case "M": setMuted((v) => !v); break;
        case "l": case "L": onLike(); break;
        case "s": case "S": onFav(); break;
        case "c": case "C": setPanel("comments"); break;
        case "e": case "E": setPanel("episodes"); break;
        default: break;
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, controlsLocked, panel, time, index]);

  /* 安卓返回键：面板打开时先关面板 */
  useEffect(() => {
    if (!panel) { setBackHandler(null); return undefined; }
    setBackHandler(() => { setPanel(null); return true; });
    return () => setBackHandler(null);
  }, [panel]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFull = () => {
    const el = boxRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };

  /* —— 双指捏合缩放 & 平移（Pinch-to-Zoom & Pan） —— */
  const cancelSingleGesture = () => {
    clearTapTimer();
    const g = gesture.current;
    if (g?.timer) window.clearTimeout(g.timer);
    gesture.current = null;
    if (holdRef.current) {
      holdRef.current = false;
      setHoldSpeed(false);
    }
    lockArmedRef.current = false;
    setLockArmed(false);
    setScrub(null);
    scrubTarget.current = null;
  };

  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked) return;
    if (e.touches.length === 2) {
      cancelSingleGesture();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist0 = Math.max(12, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
      const midX0 = (t0.clientX + t1.clientX) / 2;
      const midY0 = (t0.clientY + t1.clientY) / 2;
      pinchRef.current = {
        dist0,
        midX0,
        midY0,
        scale0: zoom.scale,
        x0: zoom.x,
        y0: zoom.y,
      };
    }
  };

  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked) return;
    if (e.touches.length === 2 && pinchRef.current) {
      const p = pinchRef.current;
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist = Math.max(12, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
      const midX = (t0.clientX + t1.clientX) / 2;
      const midY = (t0.clientY + t1.clientY) / 2;
      const nextScale = Math.max(0.85, Math.min(3.5, p.scale0 * (dist / p.dist0)));
      const rawDx = midX - p.midX0;
      const rawDy = midY - p.midY0;
      const dx = rotated ? rawDy : rawDx;
      const dy = rotated ? -rawDx : rawDy;
      const maxX = Math.max(0, (nextScale - 1) * window.innerWidth * 0.55);
      const maxY = Math.max(0, (nextScale - 1) * window.innerHeight * 0.55);
      const nextX = Math.max(-maxX, Math.min(maxX, p.x0 + dx));
      const nextY = Math.max(-maxY, Math.min(maxY, p.y0 + dy));
      setZoom({ scale: nextScale, x: nextX, y: nextY, gesturing: true });
    }
  };

  const onTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isDesktop) return;
    if (pinchRef.current && e.touches.length < 2) {
      pinchRef.current = null;
      setZoom((prev) =>
        prev.scale < 1.08
          ? { scale: 1, x: 0, y: 0, gesturing: false }
          : { ...prev, gesturing: false },
      );
    }
  };

  /* —— 长按 2x（上滑锁定） / 横拖定位 / 单击清屏 / 双击暂停 —— */
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked || !active || !e.isPrimary || pinchRef.current || gesture.current || e.button !== 0) return;
    /* 手指触碰画面即呼出倍速条，松手 3 秒后自动隐藏 */
    if (!rateMoving && !rateDrag) showRateBar();
    /* 全屏时触碰即呼出顶部剧名/集数/总进度与控制条 */
    if (fs) showFsUi();
    const el = e.currentTarget;
    const span = rotated ? (el.clientHeight || window.innerHeight || 1) : (el.clientWidth || 1);
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const g = {
      x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
      t: Date.now(), base: time, width: span,
      playing: videoRef.current?.el()?.paused === false,
      mode: "idle" as "idle" | "hold" | "scrub" | "pan",
      timer: window.setTimeout(() => {
        const cur = gesture.current;
        if (!cur || cur.mode !== "idle" || pinchRef.current) return;
        clearTapTimer();
        cur.mode = "hold";
        holdRef.current = true;
        setHoldSpeed(true);
        setLockArmed(false);
        lockArmedRef.current = false;
        try { navigator.vibrate?.(25); } catch { /* ignore */ }
      }, 380) as unknown as number,
    };
    gesture.current = g;
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pinchRef.current) {
      cancelSingleGesture();
      return;
    }
    const g = gesture.current;
    if (!g || isDesktop || !e.isPrimary) return;
    const rawDx = e.clientX - g.x;
    const rawDy = e.clientY - g.y;
    const dx = rotated ? rawDy : rawDx;
    const dy = rotated ? -rawDx : rawDy;

    /* 长按中：上滑 64px 进入「松开即锁定」 */
    if (g.mode === "hold") {
      const upDist = rotated ? (e.clientX - g.startX) : (g.startY - e.clientY);
      const armed = upDist > 64;
      if (armed !== lockArmedRef.current) {
        lockArmedRef.current = armed;
        setLockArmed(armed);
      }
      return;
    }

    if (g.mode === "idle") {
      if (Math.abs(dx) > 16 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        clearTapTimer();
        if (g.timer) window.clearTimeout(g.timer);
        g.mode = "scrub";
      } else if (Math.abs(dy) > 16) {
        clearTapTimer();
        if (g.timer) window.clearTimeout(g.timer);
        g.mode = "pan";
      }
      return;
    }

    if (g.mode === "scrub") {
      const total = duration || 0;
      if (!total) return;
      const target = Math.max(0, Math.min(total - 0.2, g.base + (dx / g.width) * total));
      scrubTarget.current = target;
      setScrub({ pct: (target / total) * 100, target });
    }
  };

  const onUp = (e?: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (pinchRef.current) return;
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.timer) window.clearTimeout(g.timer);
    /* 手指离开画面：倍速条 3 秒后自动隐藏 */
    scheduleHideRateBar();

    if (g.mode === "hold") {
      holdRef.current = false;
      setHoldSpeed(false);
      if (!cancelled && lockArmedRef.current) {
        setSpeedLock(true);
        toast("已锁定 2.0x 倍速 · 点顶部标签解除", "info");
      }
      lockArmedRef.current = false;
      setLockArmed(false);
      return;
    }
    if (g.mode === "scrub") {
      const target = scrubTarget.current;
      setScrub(null);
      scrubTarget.current = null;
      if (!cancelled && target != null) {
        setErr("");
        setTime(target);
        videoRef.current?.seek(target, "mobile_gesture");
      }
      if (g.playing && active) videoRef.current?.play();
      return;
    }

    if (cancelled || g.mode !== "idle") return;
    const moveDist = e ? Math.hypot(e.clientX - g.x, e.clientY - g.y) : 0;
    if (Date.now() - g.t < 260 && moveDist < 16) {
      const now = Date.now();
      if (now - lastTapRef.current.time < 280) {
        // 双击屏幕：切换暂停 / 播放
        clearTapTimer();
        lastTapRef.current.time = 0;
        videoRef.current?.toggle();
      } else {
        // 单击屏幕：全屏时呼出顶部信息/控制条；非全屏切换清屏模式
        lastTapRef.current.time = now;
        clearTapTimer();
        lastTapRef.current.timer = window.setTimeout(() => {
          lastTapRef.current.timer = null;
          if (fs) {
            showFsUi();
          } else {
            setClean((c) => !c);
          }
        }, 250) as unknown as number;
      }
    }
  };

  useEffect(() => {
    if (!active || controlsLocked) onUp(undefined, true);
    // Cancel pending gestures when the page is hidden or controls are locked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, controlsLocked]);

  useEffect(() => () => {
    if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
    gesture.current = null;
  }, [playKey]);

  const lockControls = () => { setPanel(null); setControlsLocked(true); };

  /* 长按倍速 / 双指缩放 / 全屏期间禁止外层列表原生滚动 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const fn = (e: TouchEvent) => {
      if (holdRef.current || pinchRef.current || fs || e.touches.length >= 2) {
        e.preventDefault();
      }
    };
    el.addEventListener("touchmove", fn, { passive: false });
    return () => el.removeEventListener("touchmove", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, videoIds.length, fs]);

  /* —— 进度条拖动（直接用当前触发元素的 BoundingRect，旋转舞台下按 Y 轴换算） —— */
  const barPctAt = (barEl: HTMLElement | null, clientX: number, clientY: number) => {
    const r = barEl?.getBoundingClientRect();
    if (!r) return null;
    const span = rotated ? r.height : r.width;
    if (!span) return null;
    const raw = rotated ? (clientY - r.top) / span : (clientX - r.left) / span;
    return Math.max(0, Math.min(1, raw));
  };
  const barSeekTo = (barEl: HTMLElement | null, clientX: number, clientY: number) => {
    const pct = barPctAt(barEl, clientX, clientY);
    if (pct == null) return null;
    setBarPct(pct);
    return pct;
  };
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    videoRef.current?.trace("seek.input.down", { input: "mobile_bar" });
    barScrub.current = true;
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    barSeekTo(el, e.clientX, e.clientY);
  };
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    e.stopPropagation();
    videoRef.current?.trace("seek.input.move", { input: "mobile_bar" });
    barSeekTo(e.currentTarget as HTMLElement, e.clientX, e.clientY);
  };
  const onBarUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    barScrub.current = false;
    e.stopPropagation();
    const pct = barPctAt(e.currentTarget as HTMLElement, e.clientX, e.clientY) ?? barPct;
    setBarPct(null);
    if (pct != null && duration > 0) {
      const target = Math.max(0, Math.min(duration - 0.15, pct * duration));
      setErr("");
      setTime(target);
      videoRef.current?.trace("seek.input.up", { input: "mobile_bar", target });
      videoRef.current?.seek(target, "mobile_bar");
    }
  };

  const togglePip = async () => {
    try {
      const v = videoRef.current?.el();
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v && document.pictureInPictureEnabled) await v.requestPictureInPicture();
      else toast("当前环境不支持画中画", "info");
    } catch { toast("画中画开启失败", "info"); }
  };

  /* 已移除账号体系：点赞 / 收藏 / 关注全部只存本地 */

  const onLike = () => {
    if (!curId) return;
    const on = toggleLikeLocal(curId);
    setHeartBurst((n) => n + 1);
    toast(on ? "已加入喜欢" : "已取消喜欢", on ? "heart" : "info");
  };

  const onFav = () => {
    if (!curId) return;
    const on = toggleFavLocal(curId);
    toast(on ? "已收藏" : "已取消收藏", on ? "star" : "info");
  };

  const onFollow = () => {
    const uid = meta.authorId > 0 ? meta.authorId : undefined;
    if (!uid) return;
    const on = toggleFollowLocal(uid);
    toast(on ? `已关注 ${detail?.author?.name}` : "已取消关注", on ? "ok" : "info");
  };

  /* —— 缓冲下载：进度监听 + 一键下载全部剧集 —— */
  type DlItem = { done: number; total: number; status: string };
  const [dlState, setDlState] = useState<Record<string, DlItem>>({});
  const [dlAllRunning, setDlAllRunning] = useState(false);
  useEffect(() => {
    if (!active) return;
    let off: (() => void) | null = null;
    listen<DlItem & { key?: string; video_id?: number; ep?: number; auto?: boolean }>("dl-progress", (e) => {
      const p = e.payload;
      /* 自动预缓存的进度不算「下载」，不在选集的集数上显示角标 */
      if (p.auto) return;
      const key = p.key ?? (p.video_id && p.ep ? `${p.video_id}:${p.ep}` : "");
      if (!key) return;
      setDlState((m) => ({ ...m, [key.replace("_", ":")]: { done: p.done || 0, total: p.total || 0, status: p.status } }));
    })
      .then((fn) => { off = () => { void fn(); }; })
      .catch(() => {});
    return () => { off?.(); };
  }, [active]);

  /* —— 勾选下载：取好地址后整体入队（后台顺序下载，不阻塞界面） —— */
  const downloadSelected = async (eps: number[]) => {
    if (!eps.length || kind !== "video") return;
    setDlAllRunning(true);
    try {
      const r = await enqueueEpisodes(curId, meta.title || title, eps, meta.cover || "");
      toast(r.queued ? `已加入下载队列 ${r.queued} 集${r.skipped ? ` · 跳过 ${r.skipped} 集` : ""}` : "所选剧集已下载过", "ok");
    } catch (e) {
      toast((e as Error).message || "下载失败", "info");
    } finally {
      setDlAllRunning(false);
    }
  };

  const downloadAll = () => downloadSelected(episodes.map((e) => e.ep_num));
  const pauseEp = (ep: number) => {
    void invoke("dl_pause", { videoId: curId, ep }).catch(() => {});
    setDlState((m) => ({ ...m, [`${curId}:${ep}`]: { ...(m[`${curId}:${ep}`] || { done: 0, total: 0 }), status: "paused" } }));
    toast(`第 ${ep} 集已暂停`, "info");
  };
  const resumeEp = (ep: number) => {
    void invoke("dl_resume", { videoId: curId, ep }).catch(() => {});
    setDlState((m) => ({ ...m, [`${curId}:${ep}`]: { ...(m[`${curId}:${ep}`] || { done: 0, total: 0 }), status: "downloading" } }));
    toast(`第 ${ep} 集继续下载`, "ok");
  };

  const pickEp = (ep: number) => {
    setEpMap((m) => ({ ...m, [curId]: ep }));
    setPanel(null);
  };

  /* —— 悬浮倍速条手势：短滑调速 / 长按拖动摆放 —— */
  const clampRatePos = (x: number, y: number) => {
    const w = window.innerWidth || 360;
    const h = window.innerHeight || 640;
    const bw = 64;
    const bh = 116;
    return {
      x: Math.max(4, Math.min(w - bw - 4, x)),
      y: Math.max(64, Math.min(h - bh - 140, y)),
    };
  };

  /* 记下的位置在转屏/换机后可能越界：渲染时按当前视口实时收拢，不改动已保存的值 */
  const shownRatePos = ratePos ? clampRatePos(ratePos.x, ratePos.y) : null;

  const onRatePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (rateMoving) return;
    e.preventDefault();
    e.stopPropagation();
    showRateBar();
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const r = el.getBoundingClientRect();
    const pos = shownRatePos ?? { x: r.left, y: r.top };
    rateGesture.current = {
      x0: e.clientX, y0: e.clientY, baseRate: rate, posX: pos.x, posY: pos.y, moved: false,
      timer: window.setTimeout(() => {
        const g = rateGesture.current;
        if (!g || g.moved) return;
        g.timer = null;
        setRateDrag(null);
        setRatePos({ x: g.posX, y: g.posY });
        setRateMoving(true);
        try { navigator.vibrate?.(30); } catch { /* ignore */ }
      }, 420) as unknown as number,
    };
  };

  const onRatePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = rateGesture.current;
    if (!g) return;
    e.stopPropagation();
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;

    /* 拖动摆放中：直接跟手移动（不调速） */
    if (rateMoving) {
      setRatePos(clampRatePos(g.posX + dx, g.posY + dy));
      return;
    }

    /* 先动起来就取消长按计时，转为调速手势 */
    if (!g.moved && Math.hypot(dx, dy) > 8) {
      g.moved = true;
      if (g.timer) { window.clearTimeout(g.timer); g.timer = null; }
    }
    if (!g.moved) return;
    const next = Math.min(6, Math.max(0.25, Math.round((g.baseRate - dy * RATE_PER_PX) * 100) / 100));
    setRateDrag((prev) => (prev && prev.cur === next ? prev : { y0: g.y0, base: g.baseRate, cur: next }));
  };

  const onRatePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = rateGesture.current;
    rateGesture.current = null;
    if (g?.timer) window.clearTimeout(g.timer);
    if (!g) return;
    e.stopPropagation();

    if (rateMoving) {
      setRateMoving(false);
      setRatePos((p) => {
        if (p) { try { localStorage.setItem(RATE_POS_KEY, JSON.stringify(p)); } catch { /* ignore */ } }
        return p;
      });
      toast("倍速按钮位置已保存", "ok");
      scheduleHideRateBar();
      return;
    }

    const cur = rateDrag?.cur;
    setRateDrag(null);
    if (cur != null && cur !== g.baseRate) {
      setRate(cur);
      videoRef.current?.rate(cur);
      toast(`倍速已调至 ${cur}x`, "info");
    }
    scheduleHideRateBar();
  };

  const likeCount = useMemo(() => {
    const base = meta.like;
    return base + (isLiked(curId) ? 1 : 0);
  }, [meta.like, curId, isLiked]);

  if (!videoIds.length) {
    return <div className="absolute inset-0 bg-black flex items-center justify-center"><div className="w-9 h-9 spinner" /></div>;
  }

  const effectiveFit: "contain" | "cover" = isDesktop
    ? "contain"
    : isLandscapeVideo
      ? (fs || vpLandscape ? "contain" : portraitFit)
      : (vpLandscape ? "contain" : "cover");

  return (
    <div
      className={`hg-player-ui absolute inset-0 overflow-hidden bg-black player-root ${controlsLocked ? "is-locked" : ""} ${isDesktop ? "player-surface" : ""} ${theater ? "is-theater" : ""} ${isDesktop && idle ? "is-idle" : ""}`}
      onPointerMove={() => { if (isDesktop) wake(); }}>
      <div className="absolute inset-0" inert={controlsLocked}>
      {/* 氛围背景（全屏时隐藏，避免透出封面底图） */}
      {!fs && (
        <div className="absolute inset-0 scale-110 blur-3xl opacity-25 pointer-events-none">
          {posterUrl && <img src={posterUrl} alt="" className="w-full h-full object-cover" />}
        </div>
      )}

      <div ref={boxRef} onScroll={onScroll}
        className={fs ? "fs-stage no-bar" : "absolute inset-y-0 left-0 no-bar overflow-y-scroll snap-y snap-mandatory overscroll-y-contain"}
        style={{ right: fs ? 0 : (isDesktop && panel ? 372 : 0), transition: "right .3s cubic-bezier(.2,0,0,1)" }}>
        {videoIds.map((vid, i) => {
          const isActive = i === index;
          return (
            <section
              key={vid}
              style={!isActive && fs ? { display: "none" } : undefined}
              className={`relative w-full h-full snap-start snap-always ${fs && isActive ? "" : "overflow-hidden"}`}>
              {isActive && playUrl ? (
                <div className={rotated ? "fs-landscape" : (!isDesktop && fs ? "fs-immersive" : "absolute inset-0")}>
                  <div
                    className="absolute inset-0 overflow-hidden"
                    style={{ touchAction: fs || zoom.scale > 1.05 ? "none" : "pan-y" }}
                    onTouchStart={onTouchStart}
                    onTouchMove={onTouchMove}
                    onTouchEnd={onTouchEnd}
                    onTouchCancel={onTouchEnd}
                    onPointerDown={onDown}
                    onPointerMove={onMove}
                    onPointerUp={(e) => onUp(e, false)}
                    onPointerCancel={(e) => onUp(e, true)}
                    onLostPointerCapture={(e) => onUp(e, true)}>
                    <VideoSurface
                      ref={videoRef}
                      src={playUrl}
                      poster={fs ? undefined : posterUrl}
                      autoPlay
                      active={active}
                      diagnosticContext={{ active, view: mode, kind, video_id: curId, episode: curEp }}
                      muted={muted}
                      volume={volume}
                      rate={effRate}
                      fit={effectiveFit}
                      scale={zoom.scale}
                      panX={zoom.x}
                      panY={zoom.y}
                      isGesturing={zoom.gesturing}
                      onClick={() => { if (isDesktop) videoRef.current?.toggle(); }}
                      onTime={onTimeTick}
                      onDuration={onDurationTick}
                      onSize={(w, h) => setVsize({ w, h })}
                      onPlaying={() => { setPaused(false); setWaiting(false); setErr(""); }}
                      onPause={() => setPaused(true)}
                      onWaiting={() => setWaiting(true)}
                      onEnded={() => { const next = episodes.find((e) => e.ep_num === curEp + 1); if (next) pickEp(next.ep_num); }}
                      onError={(m) => setErr(m)}
                    />
                  </div>

                  {/* 悬浮倍速条（磨砂长条）：手指触碰显示、松手 3 秒自动隐藏；
                      按住上下滑动调速，长按可拖动摆放（位置本地记住） */}
                  {!isDesktop && !clean && !controlsLocked && (rateShown || rateMoving || rateDrag || rate !== 1) && (
                    <div
                      className="absolute z-40 select-none"
                      style={{
                        left: shownRatePos ? shownRatePos.x : 6,
                        top: shownRatePos ? shownRatePos.y : Math.round((window.innerHeight || 640) * 0.72),
                        touchAction: "none",
                      }}
                      onPointerDown={onRatePointerDown}
                      onPointerMove={onRatePointerMove}
                      onPointerUp={onRatePointerUp}
                      onPointerCancel={onRatePointerUp}>
                      <div className="relative">
                        <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 whitespace-nowrap">
                          {rateMoving ? (
                            <div className="hg-chip-strong backdrop-blur-md px-2.5 py-1 rounded-full text-[10.5px] font-bold elev-2 hg-ink-2">
                              拖动摆放 · 松手保存
                            </div>
                          ) : rateDrag ? (
                            <div className="hg-chip-strong backdrop-blur-md px-3 py-1.5 rounded-full text-[15px] font-bold tabular-nums elev-2 hg-ink-2">
                              {rateDrag.cur}x
                            </div>
                          ) : null}
                        </div>
                        <div
                          aria-label="倍速调节（上下滑动调速，长按拖动）"
                          className={`w-16 h-[116px] rounded-[26px] flex flex-col items-center justify-center gap-1 elev-2 transition-colors ${rateMoving ? "ring-2 ring-primary" : ""}`}
                          style={{
                            background: rateMoving ? "rgba(0,0,0,.42)" : "rgba(255,255,255,.14)",
                            backdropFilter: "blur(22px) saturate(1.4)",
                            WebkitBackdropFilter: "blur(22px) saturate(1.4)",
                            boxShadow: "inset 0 0 0 1px rgba(255,255,255,.22), 0 8px 24px rgba(0,0,0,.3)",
                          }}>
                          <IBoltF size={20} className={rate !== 1 || rateMoving ? "text-primary" : "hg-ink-2"} />
                          <span className={`text-[26px] leading-none font-black tabular-nums ${rate !== 1 || rateMoving ? "text-primary" : "hg-ink"}`}>
                            {rateDrag ? rateDrag.cur : rate}
                          </span>
                          <span className="text-[10.5px] font-semibold hg-ink-3">{rateMoving ? "拖动" : "倍速"}</span>
                        </div>
                      </div>
                    </div>
                  )}
                  {!isDesktop && scrub && (
                    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none" style={{ background: "rgba(0,0,0,.25)" }}>
                      <span className="text-[26px] font-bold hg-ink tabular-nums hg-ov-shadow">{fmtTime(scrub.target)}</span>
                      <span className="text-[11px] hg-ink-4 mt-1 tabular-nums">/ {fmtTime(duration)}</span>
                      <div className="mt-4 w-[62%] h-[3px] rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,.25)" }}>
                        <div className="h-full bg-white" style={{ width: `${scrub.pct}%` }} />
                      </div>
                    </div>
                  )}

                  {/* 暂停 / 缓冲 / 报错恢复 */}
                  {paused && !err && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                      <span className="w-[66px] h-[66px] rounded-full flex items-center justify-center backdrop-blur-md"
                        style={{ background: "rgba(0,0,0,.55)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.12)" }}>
                        <IPlayF size={28} className="hg-ink ml-0.5" />
                      </span>
                    </div>
                  )}
                  {waiting && !err && !paused && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"><div className="w-9 h-9 spinner" /></div>
                  )}
                  {err && (
                    <div className="absolute inset-0 z-30 flex items-center justify-center">
                      <div className="rounded-xl p-5 flex flex-col items-center gap-3 text-[13px] hg-ink-2" style={{ background: "rgba(0,0,0,.74)" }}>
                        <span>视频暂时无法加载</span>
                        <span className="text-[10.5px] hg-ink-4 max-w-[240px] text-center break-all">{err}</span>
                        <button className="px-4 py-1.5 rounded-full hg-chip-strong hg-link text-[12.5px] font-semibold pressable"
                          onClick={() => { setErr(""); setWaiting(true); videoRef.current?.reload(); }}>
                          重新加载
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 移动端：倍速状态 / 锁定提示（全屏时让位给顶部信息条） */}
                  {!isDesktop && !fs && (!clean || holdSpeed) && (holdSpeed || speedLock || rate !== 1) && (
                    <button
                      onClick={() => {
                        if (speedLock) { setSpeedLock(false); toast("已解除倍速锁定", "info"); }
                        else if (rate !== 1 && !holdSpeed) setRate(1);
                      }}
                      className={`absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-3.5 h-8 rounded-full backdrop-blur-md text-[12px] font-bold elev-2 pressable ${speedLock ? "bg-primary text-on-primary" : "hg-chip hg-gold"}`}
                      style={{ top: rotated || vpLandscape ? 14 : "calc(var(--sat, 0px) + 54px)" }}>
                      <IBoltF size={13} />
                      {effRate}x {speedLock ? "已锁定 · 点按解除" : holdSpeed ? "倍速中 · 松开恢复" : "倍速"}
                    </button>
                  )}
                  {!isDesktop && holdSpeed && (
                    <div
                      className={`absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-4 h-10 rounded-xl backdrop-blur-md elev-2 transition-all duration-200 ${lockArmed ? "bg-primary text-on-primary scale-110" : "hg-chip-strong hg-ink-2"}`}
                      style={{ top: "38%" }}>
                      <ILockF size={16} />
                      <span className="text-[12.5px] font-bold">{lockArmed ? "松开锁定 2.0x" : "上滑到此锁定倍速"}</span>
                    </div>
                  )}

                  {/* 移动端：沉浸全屏顶部信息（触摸画面呼出，3.2s 自动隐藏） */}
                  {!isDesktop && fs && !clean && !controlsLocked && fsUi && (
                    <div className="absolute inset-x-0 top-0 z-40 px-4 pb-3 pointer-events-none"
                      style={{
                        paddingTop: rotated || vpLandscape ? 12 : "calc(var(--sat, 0px) + 10px)",
                        background: "linear-gradient(180deg, rgba(0,0,0,.78) 0%, rgba(0,0,0,.35) 62%, transparent 100%)",
                      }}>
                      <div className="flex items-start gap-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] font-semibold hg-ink truncate hg-ov-shadow">
                            {meta.title || title || "播放中"}
                          </div>
                          <div className="mt-0.5 text-[10.5px] hg-ink-3 tabular-nums hg-ov-shadow">
                            第 {curEp}{episodes.length ? ` / ${episodes.length}` : ""} 集
                            {duration > 0 ? ` · ${fmtTime(time)} / ${fmtTime(duration)}` : ""}
                          </div>
                        </div>
                        <button onClick={lockControls} aria-label="锁定播放控制" title="锁定播放控制" aria-pressed={false}
                          className="hg-chip-strong h-8 pl-2 pr-2.5 rounded-full backdrop-blur-md flex items-center gap-1 pressable elev-1 pointer-events-auto shrink-0">
                          <ILockF size={15} /><span className="text-[11px] font-semibold hg-ink">锁定</span>
                        </button>
                      </div>
                      {/* 总进度线 */}
                      <div className="mt-2.5 h-[3px] rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,.22)" }}>
                        <div className="h-full rounded-full bg-white" style={{ width: `${Math.max(0, Math.min(100, barProgress * 100))}%`, transition: barPct !== null ? "none" : "width .25s linear" }} />
                      </div>
                    </div>
                  )}

                  {/* 移动端：沉浸全屏控制栏（清屏 clean 模式下隐藏，触摸画面呼出，3.2s 自动收起） */}
                  {!isDesktop && fs && !clean && !controlsLocked && fsUi && (
                    <>
                      {zoom.scale > 1.05 && (
                        <button
                          onClick={() => setZoom({ scale: 1, x: 0, y: 0, gesturing: false })}
                          className="hg-chip-strong absolute left-4 z-40 px-3 h-8 rounded-full backdrop-blur-md text-[11.5px] font-semibold flex items-center gap-1 pressable elev-1"
                          style={{ top: rotated || vpLandscape ? 14 : "calc(var(--sat, 0px) + 8px)" }}>
                          还原画面 ({zoom.scale.toFixed(1)}x)
                        </button>
                      )}
                      {/* 退出全屏：放左下角，左手单手拇指直接够到 */}
                      <button onClick={exitFs} aria-label="退出全屏"
                        className="hg-chip-strong absolute left-4 z-40 h-11 pl-2.5 pr-3.5 rounded-full backdrop-blur-md flex items-center gap-1.5 pressable elev-2"
                        style={{ bottom: rotated || vpLandscape ? 100 : "calc(var(--sab, 0px) + 100px)" }}>
                        <ICompress size={18} /><span className="text-[12px] font-semibold hg-ink">退出全屏</span>
                      </button>
                      <div className="absolute inset-x-0 z-30 px-4" style={{ bottom: rotated || vpLandscape ? 46 : "calc(var(--sab, 0px) + 52px)", height: 26 }}>
                        <div className="relative h-full" style={{ touchAction: "none" }}
                          onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
                          <div className={`absolute inset-x-0 bottom-[10px] rounded-full transition-all ${barPct !== null ? "h-[5px]" : "h-[3px]"}`}
                            style={{ background: "rgba(255,255,255,.3)" }}>
                            <div className="h-full rounded-full bg-white" style={{ width: `${barProgress * 100}%` }} />
                          </div>
                          {barPct !== null && (
                            <div className="absolute left-1/2 -translate-x-1/2 -top-8 px-2.5 py-1 rounded-md hg-chip-strong backdrop-blur-md text-[12px] font-bold tabular-nums whitespace-nowrap">
                              {fmtTime(barPct * (duration || 0))} / {fmtTime(duration)}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="absolute inset-x-0 z-40 flex items-center gap-3 px-4"
                        style={{ bottom: rotated || vpLandscape ? 10 : "calc(var(--sab, 0px) + 10px)" }}>
                        <button onClick={() => videoRef.current?.toggle()}
                          className="hg-chip shrink-0 h-9 pl-2 pr-3 rounded-full flex items-center gap-1 pressable">
                          {paused ? <IPlayF size={16} /> : <IPauseF size={15} />}
                          <span className="text-[11.5px] font-semibold hg-ink">{paused ? "播放" : "暂停"}</span>
                        </button>
                        <span className="shrink-0 text-[11.5px] font-semibold hg-ink-2 tabular-nums">{fmtTime(time)}</span>
                        <button
                          onClick={() => {
                            if (speedLock) { setSpeedLock(false); toast("已解除倍速锁定", "info"); return; }
                            setSpeedPanel(v => !v);
                          }}
                          className={`ml-auto shrink-0 flex items-center gap-1 px-2.5 h-8 rounded-full text-[12px] font-bold pressable ${effRate !== 1 ? "bg-primary text-on-primary" : "hg-chip hg-ink-2"}`}>
                          <IBoltF size={12} />{effRate}x
                        </button>
                        <span className="shrink-0 text-[11.5px] hg-ink-4 tabular-nums">{fmtTime(duration)}</span>
                      </div>
                      {/* 倍速面板：预设 0.5-4x + 自定义（0.25-6） */}
                      {speedPanel && (
                        <div className="absolute right-4 z-50 rounded-2xl hg-chip-strong backdrop-blur-md elev-3 p-3 w-[220px]"
                          style={{ bottom: rotated || vpLandscape ? 52 : "calc(var(--sab, 0px) + 52px)" }}
                          onPointerDown={(e) => e.stopPropagation()}>
                          <div className="text-[11px] font-semibold hg-ink-3 mb-2 px-0.5">播放速度</div>
                          <div className="grid grid-cols-4 gap-1.5">
                            {SPEED_PRESETS.map((v) => (
                              <button key={v}
                                onClick={() => { setRate(v); videoRef.current?.rate(v); setSpeedPanel(false); setCustomRateOpen(false); }}
                                className={`h-9 rounded-full text-[12.5px] font-bold pressable ${rate === v ? "bg-primary text-on-primary" : "hg-chip hg-ink-2"}`}>
                                {v === 1 ? "正常" : `${v}x`}
                              </button>
                            ))}
                          </div>
                          {customRateOpen ? (
                            <form className="flex items-center gap-2 mt-2 px-0.5"
                              onSubmit={(e) => {
                                e.preventDefault();
                                const v = Number(customRateVal);
                                if (!isFinite(v) || v < 0.25 || v > 6) { toast("倍速范围 0.25 - 6", "info"); return; }
                                const r = Math.round(v * 100) / 100;
                                setRate(r); videoRef.current?.rate(r);
                                setCustomRateOpen(false); setSpeedPanel(false);
                              }}>
                              <input autoFocus type="number" min={0.25} max={6} step={0.05} value={customRateVal}
                                placeholder="0.25-6" aria-label="自定义倍速" inputMode="decimal"
                                onChange={(e) => setCustomRateVal(e.target.value)}
                                className="flex-1 min-w-0 h-9 px-3 rounded-full hg-chip hg-ink-2 text-[12.5px] outline-none" />
                              <button type="submit" className="h-9 px-4 rounded-full bg-primary text-on-primary text-[12.5px] font-bold pressable">确定</button>
                            </form>
                          ) : (
                            <button onClick={() => { setCustomRateVal(String(rate)); setCustomRateOpen(true); }}
                              className="w-full h-9 mt-1.5 rounded-full hg-chip hg-ink-2 text-[12.5px] font-semibold pressable">
                              {!SPEED_PRESETS.includes(rate) ? `${rate}x（自定义）` : "自定义倍速"}
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <div className="absolute inset-0">
                  <Img src={cards[vid]?.cover || posts[vid]?.cover || details[vid]?.cover || (isActive ? detail?.cover : "") || ""} eager={Math.abs(i - index) <= 1} />
                  <div className="absolute inset-0" style={{ background: "rgba(0,0,0,.25)" }} />
                </div>
              )}

              {/* 取不到播放地址时播放器不会创建，错误提示要放在播放器外面，否则只会停在封面 */}
              {isActive && kind === "video" && !playUrl && !!err && (
                <div className="absolute inset-0 z-30 flex items-center justify-center">
                  <div className="rounded-xl p-5 flex flex-col items-center gap-3 text-[13px] hg-ink-2" style={{ background: "rgba(0,0,0,.74)" }}>
                    <span>视频暂时无法加载</span>
                    <span className="text-[10.5px] hg-ink-4 max-w-[240px] text-center break-all">{err}</span>
                    <button className="px-4 py-1.5 rounded-full hg-chip-strong hg-link text-[12.5px] font-semibold pressable"
                      onClick={() => { setErr(""); setWaiting(true); setPlayTry((n) => n + 1); }}>
                      重新加载
                    </button>
                  </div>
                </div>
              )}

              {/* 图文帖：没有视频就给个正文入口 */}
              {isActive && kind === "post" && !!post && !post.video_url && (
                <div className="absolute inset-0 z-10 flex items-center justify-center">
                  <button type="button" onClick={() => setPanel("article")}
                    className="flex items-center gap-2 h-11 px-5 rounded-full text-[13.5px] font-semibold pressable elev-3"
                    style={{ background: "rgba(255,255,255,.94)", color: "#0b0e15" }}>
                    <IFileText size={17} />查看图文详情
                  </button>
                </div>
              )}

              {/* 渐变压暗，保证文字可读（清屏模式下不加压暗遮罩，只显示纯视频内容） */}
              {!fs && !clean && (
                <div className="absolute inset-0 pointer-events-none"
                  style={{ background: "linear-gradient(0deg, rgba(8,11,15,.86) 0, rgba(11,14,20,.18) 26%, transparent 48%)" }} />
              )}

              {/* 竖屏下观看横屏视频：快捷「放大铺满 / 完整显示 / 全屏横屏」与双指缩放复位胶囊 */}
              {isActive && !fs && !clean && !isDesktop && (isLandscapeVideo || zoom.scale > 1.05) && (
                <div
                  className="absolute left-1/2 -translate-x-1/2 z-20 flex items-center gap-2"
                  style={{ top: "64%" }}>
                  {isLandscapeVideo && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          if (zoom.scale > 1.05) {
                            setZoom({ scale: 1, x: 0, y: 0, gesturing: false });
                            setPortraitFit("contain");
                          } else {
                            setPortraitFit((f) => (f === "contain" ? "cover" : "contain"));
                          }
                        }}
                        className="hg-chip-strong backdrop-blur-md px-3 h-7 rounded-full text-[11.5px] font-semibold flex items-center gap-1.5 pressable elev-1">
                        {zoom.scale > 1.05
                          ? `还原缩放 (${zoom.scale.toFixed(1)}x)`
                          : portraitFit === "contain"
                            ? "放大铺满"
                            : "完整适应"}
                      </button>
                      <button
                        type="button"
                        onClick={enterFs}
                        className="hg-chip-strong backdrop-blur-md px-3 h-7 rounded-full text-[11.5px] font-semibold flex items-center gap-1 pressable elev-1">
                        <IExpand size={12} />横屏全屏
                      </button>
                    </>
                  )}
                  {!isLandscapeVideo && zoom.scale > 1.05 && (
                    <button
                      type="button"
                      onClick={() => setZoom({ scale: 1, x: 0, y: 0, gesturing: false })}
                      className="hg-chip-strong backdrop-blur-md px-3 h-7 rounded-full text-[11.5px] font-semibold flex items-center gap-1 pressable elev-1">
                      还原画面 ({zoom.scale.toFixed(1)}x)
                    </button>
                  )}
                </div>
              )}

              {/* 顶部 */}
              {!fs && !clean && mode === "context" ? (
                isDesktop ? (
                  <div className="desktop-context-header">
                    <button onClick={onBack} aria-label="返回"><IBack size={17} /></button>
                    <span>{title}</span>
                    <small>{index + 1} / {videoIds.length}</small>
                  </div>
                ) : (
                  <div className="absolute inset-x-0 z-20 flex items-center gap-2 px-2.5" style={{ top: "calc(var(--sat, 0px) + 8px)", paddingRight: 148 }}>
                    <button onClick={onBack} aria-label="返回" className="hg-chip h-9 pl-2 pr-3 rounded-full flex items-center gap-1 pressable elev-1">
                      <IBack size={18} /><span className="text-[12px] font-semibold hg-ink">返回</span>
                    </button>
                    <span className="text-[14.5px] font-semibold hg-ink hg-ov-shadow truncate">{title}</span>
                    <span className="ml-auto px-2 py-0.5 rounded-full hg-chip text-[11px] font-semibold" style={{ color: "rgba(255,255,255,.9)" }}>{index + 1} / {videoIds.length}</span>
                  </div>
                )
              ) : null}

              {/* 右侧操作栏（移动端）：只保留 收藏 / 全屏
                  颜色写死不跟主题走：浅色主题下这些字必须仍是白色 */}
              {!fs && !clean && !isDesktop && (
                <div className="absolute right-3 z-20 flex flex-col items-center gap-[16px]"
                  style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset + 92}px)` }}>
                  <button onClick={onFav} className="flex flex-col items-center gap-1 pressable" aria-pressed={isFav(curId)} aria-label="收藏">
                    {isFav(curId) ? <IStarF size={27} className="hg-gold" /> : <IStar size={27} className="hg-ink hg-ov-shadow" />}
                    <span className="text-[10.5px] hg-ink-2 hg-ov-shadow">收藏</span>
                  </button>
                  <button onClick={enterFs} className="flex flex-col items-center gap-1 pressable" aria-label="全屏">
                    <IExpand size={26} className="hg-ink hg-ov-shadow" />
                    <span className="text-[10.5px] hg-ink-2 hg-ov-shadow">全屏</span>
                  </button>
                </div>
              )}

              {/* 右侧操作栏（桌面） */}
              {!fs && isDesktop && (
              <div className="absolute z-20 flex flex-col items-center desktop-social">
                <div className="desktop-browse-inline">
                  <button onClick={() => go(-1)} disabled={index === 0} aria-label="上一个" title="上一个 ↑">
                    <IChevronUp size={19} strokeWidth={1.8} />
                  </button>
                  <button onClick={() => go(1)} disabled={index >= videoIds.length - 1} aria-label="下一个" title="下一个 ↓">
                    <IChevronDown size={19} strokeWidth={1.8} />
                  </button>
                  <small>{String(index + 1).padStart(2, "0")} / {String(videoIds.length).padStart(2, "0")}</small>
                </div>

                {kind === "video" && (
                  <>
                    <button onClick={onLike} className="flex flex-col items-center gap-1 pressable" aria-pressed={isLiked(curId)}>
                      <span key={heartBurst} className={heartBurst ? "a-pop" : ""}>
                        {isLiked(curId) ? <IHeartF size={30} className="text-neon" /> : <IHeart size={30} className="text-white tsh" />}
                      </span>
                      <span className="text-[10.5px] text-white/90 tabular-nums">{fmt(likeCount)}</span>
                    </button>

                    <button onClick={() => setPanel("comments")} className="flex flex-col items-center gap-1 pressable">
                      <ICommentF size={27} className="text-white tsh" />
                      <span className="text-[10.5px] text-white/90 tabular-nums">{fmt(meta.comment)}</span>
                    </button>

                    <button onClick={onFav} className="flex flex-col items-center gap-1 pressable" aria-pressed={isFav(curId)}>
                      {isFav(curId) ? <IStarF size={27} className="hg-gold" /> : <IStar size={27} className="hg-ink hg-ov-shadow" />}
                      <span className="text-[10.5px] text-white/90 tabular-nums">{fmt(meta.collect)}</span>
                    </button>

                    <button onClick={() => setPanel("episodes")} className="flex flex-col items-center gap-1 pressable">
                      <IList size={26} className="text-white tsh" />
                      <span className="text-[10.5px] text-white/90">选集</span>
                    </button>
                  </>
                )}

                <button onClick={shareLink} className="flex flex-col items-center gap-1 pressable">
                  <ILink size={25} className="text-white tsh" />
                  <span className="text-[10.5px] text-white/90">分享</span>
                </button>
              </div>
              )}

              {/* 桌面：左下信息 */}
              {!fs && isDesktop && (
              <div className="desktop-video-meta">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-bold text-white tsh truncate">@{meta.author}</span>
                  {episodes.length > 0 && (
                    <span className="shrink-0 px-1.5 py-px rounded-md text-[10px] font-bold text-white"
                      style={{ background: "rgba(255,255,255,.16)" }}>
                      第 {curEp}/{episodes.length} 集
                    </span>
                  )}
                  {!!meta.score && (
                    <span className="shrink-0 text-[11px] font-bold hg-gold hg-ov-shadow">{meta.score.toFixed(1)} 分</span>
                  )}
                </div>

                <p className="mt-1 text-[13.5px] leading-snug hg-ink-2 hg-ov-shadow clamp-2">{meta.title}</p>

                {/* 描述（单行，点开展开） */}
                <button onClick={() => setDescOpen((v) => !v)} className="mt-1 text-left w-full pressable group">
                  <p className={`text-[11.5px] leading-relaxed hg-ink-4 ${descOpen ? "" : "clamp-1"}`}>
                    {meta.desc || "暂无简介"}
                  </p>
                  <span className="text-[10.5px] hg-link font-semibold">{descOpen ? "收起" : "展开简介"}</span>
                </button>
              </div>
              )}

              {/* 移动端：标题 + 详情标签 + 进度线（清屏 clean 模式下隐藏） */}
              {!fs && !clean && !isDesktop && (
                <div className="absolute inset-x-0 z-20" style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset}px)` }}>
                  <div className="absolute inset-x-0 bottom-0 h-[190px] pointer-events-none"
                    style={{ background: "linear-gradient(0deg, rgba(0,0,0,.82) 0%, rgba(0,0,0,.42) 45%, transparent 100%)" }} />
                  <p className="relative px-4 pb-2 text-[14px] font-semibold leading-snug hg-ink hg-ov-shadow clamp-2">{meta.title}</p>
                  <div className="relative pt-1.5 pb-2">
                    {/* 左下角两项：选集（第一个）/ 详情（第二个）——都贴屏幕底部，单手拇指可达 */}
                    <div className="px-4 flex items-center gap-2">
                      <button onClick={() => setPanel("episodes")}
                        className="flex items-center gap-1 h-7 pl-3 pr-2 rounded-full hg-chip text-[11px] font-semibold hg-ink pressable">
                        <IList size={12} />
                        <span className="tabular-nums">选集 · 第 {curEp}{episodes.length ? `/${episodes.length}` : ""} 集</span>
                        <IChevR size={11} />
                      </button>
                      <button onClick={() => setPanel("detail")}
                        className="flex items-center gap-1 h-7 pl-3 pr-2 rounded-full hg-chip text-[11px] font-semibold hg-ink pressable">
                        <IInfo size={12} />详情<IChevR size={11} />
                      </button>
                    </div>
                    {isActive && (
                      <div className="mx-4 mt-1.5 relative" style={{ height: 22, touchAction: "none" }}
                        onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
                        <div className={`absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-full transition-all ${barPct !== null ? "h-[5px]" : "h-[2.5px]"}`}
                          style={{ background: "rgba(255,255,255,.3)" }}>
                          <div className="h-full rounded-full bg-white"
                            style={{ width: `${barProgress * 100}%`, transition: barPct !== null ? "none" : "width .25s linear" }} />
                        </div>
                        {barPct !== null && (
                          <div className="absolute left-1/2 -translate-x-1/2 -top-8 px-2.5 py-1 rounded-md hg-chip-strong backdrop-blur-md text-[12px] font-bold tabular-nums whitespace-nowrap">
                            {fmtTime(barPct * (duration || 0))} / {fmtTime(duration)}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* 桌面控制条 */}
      {isDesktop && (
        <PlayerControls
          paused={paused} time={time} duration={duration} buffered={buffered} rate={rate}
          muted={muted} volume={volume} theater={theater} fullscreen={fullscreen}
          visible={active && !idle}
          seekEnabled={active && !controlsLocked}
          seekKey={playKey}
          nextDisabled={!episodes.some((e) => e.ep_num === curEp + 1) && index >= videoIds.length - 1}
          nextTitle={episodes.some((e) => e.ep_num === curEp + 1) ? "下一集 E" : "下一部 ↓"}
          onToggle={() => videoRef.current?.toggle()}
          onSeek={(t, source) => { videoRef.current?.seek(t, source); setTime(t); }}
          onSeekInteraction={(phase, input, target, pointerTarget) => videoRef.current?.trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget })}
          onRate={(r) => { setRate(r); videoRef.current?.rate(r); }}
          onMute={() => setMuted((m) => !m)}
          onVolume={(v) => setVolume(v)}
          onPip={togglePip}
          onLock={lockControls}
          onTheater={() => setTheater((v) => !v)}
          onFullscreen={toggleFull}
          onNext={() => {
            const nx = episodes.find((e) => e.ep_num === curEp + 1);
            if (nx) pickEp(nx.ep_num);
            else go(1);
          }}
        />
      )}

      {/* 选集 / 评论：桌面停靠在右侧（画面让位），移动端底部弹层 */}
      {isDesktop ? (
        <div className={`desktop-dock-panel ${panel ? "is-open" : ""}`}>
          <div className="desktop-dock-inner">
            {panel === "episodes" ? (
              <EpisodesPanel videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)}
                dlState={dlState} downloadAll={downloadAll} dlAllRunning={dlAllRunning}
                onDownloadEps={downloadSelected} />
            ) : panel === "comments" ? (
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            ) : null}
          </div>
        </div>
      ) : (
        <>
          {/* 评论：移动端底部弹层（右侧操作栏「评论」入口） */}
          <Sheet open={panel === "comments"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "72vh" }}>
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            </div>
          </Sheet>

          {/* 吃瓜图文正文 */}
          <Sheet open={panel === "article"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "78vh" }}>
              <ArticlePanel title={meta.title} html={articleHtml} cover={meta.cover} hot={post?.hot} onClose={() => setPanel(null)} />
            </div>
          </Sheet>

          {/* 选集：靠下三行排列，放不下的集数左右滑动 */}
          <Sheet open={panel === "episodes"} onClose={() => setPanel(null)}>
            <EpisodesPanel layout="rows3" videoId={curId} episodes={episodes} current={curEp}
              onPick={pickEp} onClose={() => setPanel(null)}
              dlState={dlState} downloadAll={downloadAll} dlAllRunning={dlAllRunning}
              onDownloadEps={downloadSelected} />
          </Sheet>

          {/* 详情：同样是靠下的紧凑面板 */}
          <Sheet open={panel === "detail"} onClose={() => setPanel(null)}>
            <div className="flex flex-col pb-3" style={{ maxHeight: "66vh" }}>
              <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
                <span className="text-[13.5px] font-bold text-on">详情</span>
                {episodes.length > 0 && <span className="text-[10.5px] text-mut">共 {episodes.length} 集</span>}
                <button onClick={() => setPanel(null)} aria-label="关闭"
                  className="ml-auto w-7 h-7 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
                  <IClose size={13} />
                </button>
              </div>
              <div className="scroll-y px-4 pb-2">
                {/* 封面 / 标题 / 评分 / 数据 */}
                <div className="flex gap-3">
                  <div className="relative w-[84px] shrink-0 rounded-(--r-sm) overflow-hidden bg-s3" style={{ aspectRatio: "3 / 4" }}>
                    <Img src={meta.cover} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13.5px] font-bold text-on leading-snug clamp-2">{meta.title}</div>
                    <div className="flex items-center gap-2 mt-1.5">
                      {!!meta.score && <span className="text-[12px] font-bold text-amber">{meta.score.toFixed(1)} 分</span>}
                      {episodes.length > 0 && <span className="text-[10.5px] text-mut">共 {episodes.length} 集</span>}
                    </div>
                    <div className="flex gap-3 mt-2 text-[10.5px] text-mut">
                      <span>点赞 {fmt(meta.like)}</span>
                      <span>收藏 {fmt(meta.collect)}</span>
                      <span>评论 {fmt(meta.comment)}</span>
                    </div>
                  </div>
                </div>

                {/* 作者 */}
                <div className="mt-3.5 flex items-center gap-2.5 rounded-(--r-md) bg-s2 p-2.5">
                  <Avatar size={34} name={meta.author} hue={220} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-semibold text-on truncate">{meta.author}</div>
                    <div className="text-[10px] text-mut">作者</div>
                  </div>
                  {meta.authorId > 0 && (
                    <button onClick={onFollow}
                      className={`h-7 px-3 rounded-full text-[11px] font-semibold pressable ${store.follows.includes(meta.authorId) ? "bg-s3 text-mut" : "bg-primary text-on-primary"}`}>
                      {store.follows.includes(meta.authorId) ? "已关注" : "+ 关注"}
                    </button>
                  )}
                </div>

                {/* 简介 */}
                <div className="mt-3.5">
                  <div className="text-[11px] font-semibold text-dim mb-1.5">简介</div>
                  <p className="text-[11.5px] leading-relaxed text-mut whitespace-pre-wrap">{meta.desc || "暂无简介"}</p>
                </div>
              </div>
            </div>
          </Sheet>
        </>
      )}
      </div>
      {!isDesktop && !fs && !clean && !controlsLocked && active && (
        <div className="absolute right-3 z-40 flex items-center gap-2" style={{ top: "calc(var(--sat, 0px) + 6px)" }}>
          <button onClick={() => setMuted(m => !m)} aria-label={muted ? "取消静音" : "静音"}
            className="hg-chip h-8 pl-2 pr-2.5 rounded-full flex items-center gap-1 pressable elev-1">
            {muted ? <IVolMute size={15} /> : <IVol size={15} />}
            <span className="text-[11px] font-semibold hg-ink">{muted ? "开声音" : "静音"}</span>
          </button>
          <button onClick={lockControls} aria-label="锁定播放控制" title="锁定播放控制" aria-pressed={false}
            className="hg-chip h-8 pl-2 pr-2.5 rounded-full flex items-center gap-1 pressable elev-1">
            <ILockF size={15} /><span className="text-[11px] font-semibold hg-ink">锁定</span>
          </button>
          <button onClick={() => store.setTab("search")} aria-label="搜索"
            className="hg-chip h-8 pl-2 pr-2.5 rounded-full flex items-center gap-1 pressable elev-1">
            <ISearch size={15} /><span className="text-[11px] font-semibold hg-ink">搜索</span>
          </button>
        </div>
      )}
      {controlsLocked && <PlaybackLock active={active} onUnlock={() => { setControlsLocked(false); wake(); }} />}
    </div>
  );
}
