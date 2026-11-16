import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, fmtTime, platform as envPlatform } from "./api";
import { isStrictSecurity, setStrictSecurity as setHtmlStrictSecurity } from "./html";

export type Platform = "android" | "ios" | "windows" | "macos" | "linux";
export type Theme = "dark" | "light";
export type Tab = "home" | "search" | "category" | "profile";
/** 皮肤：主色 + 色调（在「我的」里自由更换） */
export type Skin = "warm" | "ocean" | "violet" | "sakura" | "forest";

export const SKINS: { id: Skin; name: string; desc: string; dot: string }[] = [
  { id: "warm", name: "暖橙", desc: "默认 · 黄果暖色", dot: "#ff9440" },
  { id: "ocean", name: "深海蓝", desc: "冷静 · 通透蓝", dot: "#38bdf8" },
  { id: "violet", name: "霓虹紫", desc: "潮酷 · 电光紫", dot: "#a78bfa" },
  { id: "sakura", name: "樱粉", desc: "柔和 · 少女粉", dot: "#fb7185" },
  { id: "forest", name: "森绿", desc: "自然 · 青翠绿", dot: "#34d399" },
];

/** 播放页上下文：ids 是来源列表，index 是当前条目。 */
export type FeedContext = {
  kind: "feed";
  key: string;
  videoIds: number[];
  index: number;
  title: string;
  source: string;
  feedKind?: "video" | "post";
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
};

export type Page =
  | FeedContext
  | { kind: "channel"; key: string; cate: string; name: string }
  | { kind: "ranks"; key: string }
  | { kind: "settings"; key: string }
  | { kind: "posts"; key: string }
  | { kind: "downloads"; key: string }
  | { kind: "post"; key: string; id: number };

export type PageInput =
  | { kind: "feed"; videoIds: number[]; index: number; title: string; source?: string; feedKind?: "video" | "post"; startEp?: number; startTime?: number }
  | { kind: "channel"; cate: string; name: string }
  | { kind: "ranks" }
  | { kind: "settings" }
  | { kind: "posts" }
  | { kind: "downloads" }
  | { kind: "post"; id: number };

export type Toast = { id: number; msg: string; icon?: "ok" | "heart" | "star" | "info" };

/** 观看记录：看到第几集、第几秒（`dur` 用来判断是否已看完） */
export type WatchProgress = { id: number; ep: number; t: number; dur: number; at: number };

type Persist = {
  likes: number[];
  favs: number[];
  history: WatchProgress[];
  follows: number[];
  muted: boolean;
  muteOnStartup: boolean;
  volume: number;
  searchHist: string[];
  /** 页面预缓存：瀑布流当前页出现时预先拉取下一页 */
  prefetchNext: boolean;
};

const LS = "hghub_app_v1";
const DEFAULTS: Persist = {
  likes: [], favs: [], history: [], follows: [],
  muted: true, muteOnStartup: true, volume: 0.7, searchHist: [], prefetchNext: true,
};

/** 旧版本 history 是 number[]，读出来时升级成带进度的结构 */
function normalizeHistory(raw: unknown): WatchProgress[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchProgress[] = [];
  raw.forEach((item, i) => {
    if (typeof item === "number") {
      out.push({ id: item, ep: 1, t: 0, dur: 0, at: Date.now() - i });
      return;
    }
    const h = item as Partial<WatchProgress> | null;
    if (h && typeof h.id === "number") {
      out.push({ id: h.id, ep: Number(h.ep) || 1, t: Number(h.t) || 0, dur: Number(h.dur) || 0, at: Number(h.at) || Date.now() - i });
    }
  });
  return out;
}

function loadPersist(): Persist {
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return DEFAULTS;
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persist>) };
    // 只在启动时应用；本次使用中取消静音不会关闭此偏好。
    const muteOnStartup = p.muteOnStartup !== false;
    return { ...p, muteOnStartup, muted: muteOnStartup || p.muted === true, history: normalizeHistory(p.history) };
  } catch {
    return DEFAULTS;
  }
}

function readTheme(): Theme {
  try {
    return localStorage.getItem("hghub_theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("theme-light", theme === "light");
  document.documentElement.style.colorScheme = theme;
}

function readSkin(): Skin {
  try {
    const v = localStorage.getItem("hghub_skin");
    if (v && SKINS.some((s) => s.id === v)) return v as Skin;
  } catch { /* ignore */ }
  return "warm";
}

function applySkin(skin: Skin) {
  document.documentElement.dataset.skin = skin;
}

type Store = {
  platform: Platform;
  theme: Theme; setTheme: (t: Theme) => void;
  skin: Skin; setSkin: (s: Skin) => void;
  tab: Tab; setTab: (t: Tab) => void;
  stack: Page[]; push: (p: PageInput) => void; pop: () => void;
  /** 前进栈：pop 下来的页面，手势右滑（前进）可放回 */
  fwd: () => void; canFwd: boolean;
  likes: number[]; favs: number[]; history: WatchProgress[]; follows: number[];
  isLiked: (id: number) => boolean; isFav: (id: number) => boolean;
  toggleLikeLocal: (id: number) => boolean;
  toggleFavLocal: (id: number) => boolean;
  /** 记一条观看记录；`ep/t/dur` 省略时保留原进度，`ep` 变了就把进度归零 */
  addHistory: (id: number, ep?: number, t?: number, dur?: number) => void;
  clearHistory: () => void;
  toggleFollowLocal: (uid: number) => boolean;
  /** 导出本地数据快照（收藏/历史/偏好），供备份 */
  exportBackup: () => Persist;
  /** 导入备份数据：本地字段做并集合并，返回导入的条目数 */
  importBackup: (raw: string) => { ok: boolean; msg: string };
  theater: boolean; setTheater: (v: boolean | ((p: boolean) => boolean)) => void;
  fs: boolean; setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  /** 清屏模式（单击屏幕消除所有控件，只保留纯视频内容） */
  clean: boolean; setClean: (v: boolean | ((p: boolean) => boolean)) => void;
  muted: boolean; setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  muteOnStartup: boolean; setMuteOnStartup: (on: boolean) => void;
  /** 页面预缓存开关 */
  prefetchNext: boolean; setPrefetchNext: (on: boolean) => void;
  volume: number; setVolume: (v: number) => void;
  searchHist: string[]; addSearch: (q: string) => void; clearSearchHist: () => void;
  strictSecurity: boolean; strictSecurityReady: boolean; securityPending: boolean; cliRelaxed: boolean; setStrictSecurity: (on: boolean) => Promise<void>;
  toasts: Toast[]; toast: (msg: string, icon?: Toast["icon"]) => void;
};

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
let seq = 0;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [p, setP] = useState<Persist>(loadPersist);
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [skin, setSkinState] = useState<Skin>(() => { const s = readSkin(); applySkin(s); return s; });
  const [tab, setTabRaw] = useState<Tab>("home");
  const [stack, setStack] = useState<Page[]>([]);
  const [forward, setForward] = useState<Page[]>([]);
  const forwardRef = useRef<Page[]>([]);
  forwardRef.current = forward;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theater, setTheaterState] = useState(false);
  const [fs, setFsState] = useState(false);
  const [clean, setCleanState] = useState(false);
  const [strictSecurity, setStrictSecurityState] = useState<boolean>(isStrictSecurity);
  const [cliRelaxed, setCliRelaxed] = useState(false);
  const [strictSecurityReady, setStrictSecurityReady] = useState(false);
  const [securityPending, setSecurityPending] = useState(false);
  const toastSeq = useRef(0);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem("hghub_theme", theme); } catch { /* ignore */ }
  }, [theme]);

  /* 皮肤：写到 <html data-skin>，由 index.css 覆盖主色变量 */
  useEffect(() => {
    applySkin(skin);
    try { localStorage.setItem("hghub_skin", skin); } catch { /* ignore */ }
  }, [skin]);

  const setSkin = useCallback((s: Skin) => setSkinState(s), []);

  useEffect(() => {
    try { localStorage.setItem(LS, JSON.stringify(p)); } catch { /* ignore */ }
  }, [p]);

  useEffect(() => {
    api.boot()
      .then((r) => {
        if (typeof r.strict_security === "boolean") {
          setStrictSecurityState(r.strict_security);
          setHtmlStrictSecurity(r.strict_security);
          setStrictSecurityReady(true);
        }
        setCliRelaxed(!!r.cli_relaxed);
      })
      .catch(() => { /* 离线也能用 */ });
  }, []);

  const setStrictSecurity = useCallback(async (on: boolean) => {
    if (!strictSecurityReady) throw new Error("安全设置尚未读取，请重新启动应用");
    setSecurityPending(true);
    try {
      const saved = await api.securitySet(on);
      setHtmlStrictSecurity(saved);
      setStrictSecurityState(saved);
    } finally {
      setSecurityPending(false);
    }
  }, [strictSecurityReady]);

  const toast = useCallback((msg: string, icon?: Toast["icon"]) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-2), { id, msg, icon }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2200);
  }, []);

  const setTab = useCallback((t: Tab) => { setTabRaw(t); setStack([]); setForward([]); setCleanState(false); }, []);
  /* push 时读取最新 history（避免闭包过期），给所有视频入口注入续播位置 */
  const pRef = useRef(p);
  pRef.current = p;
  const push = useCallback((pg: PageInput) => {
    setCleanState(false);
    let final = pg;
    if (pg.kind === "feed" && pg.feedKind !== "post" && pg.startEp === undefined && pg.startTime === undefined) {
      const h = pRef.current.history.find((x) => x.id === pg.videoIds[pg.index]);
      // 看过 5 秒以上且没看到片尾才续播
      if (h && h.t > 5 && (!h.dur || h.t < h.dur - 5)) {
        final = { ...pg, startEp: h.ep, startTime: h.t };
        setToasts((t) => [...t.slice(-2), { id: ++toastSeq.current, msg: `继续播放：第 ${h.ep} 集 · ${fmtTime(h.t)}`, icon: "info" }]);
        window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== toastSeq.current)), 2200);
      }
    }
    setStack((s) => [...s, { ...final, key: `p${++seq}` } as Page]);
    setForward([]);
  }, []);
  const pop = useCallback(() => {
    setCleanState(false);
    setStack((s) => {
      if (!s.length) return s;
      const top = s[s.length - 1];
      // 弹出的页面进入前进栈，供「右滑前进」放回（保留最近 10 条）
      setForward((f) => [...f.slice(-9), top]);
      return s.slice(0, -1);
    });
  }, []);
  const fwd = useCallback(() => {
    setCleanState(false);
    const f = forwardRef.current;
    const top = f[f.length - 1];
    if (!top) return;
    setForward(f.slice(0, -1));
    setStack((s) => [...s, { ...top, key: `p${++seq}` } as Page]);
  }, []);

  const toggleLikeLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      on = !s.likes.includes(id);
      return { ...s, likes: on ? [id, ...s.likes] : s.likes.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const toggleFavLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      on = !s.favs.includes(id);
      return { ...s, favs: on ? [id, ...s.favs] : s.favs.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const toggleFollowLocal = useCallback((uid: number) => {
    let on = false;
    setP((s) => {
      on = !s.follows.includes(uid);
      return { ...s, follows: on ? [uid, ...s.follows] : s.follows.filter((x) => x !== uid) };
    });
    return on;
  }, []);
  const addHistory = useCallback((id: number, ep?: number, t?: number, dur?: number) => {
    if (!id) return;
    setP((s) => {
      const prev = s.history.find((x) => x.id === id);
      const epChanged = ep !== undefined && prev !== undefined && prev.ep !== ep;
      const entry: WatchProgress = {
        id,
        ep: ep ?? prev?.ep ?? 1,
        t: epChanged ? 0 : (t ?? prev?.t ?? 0),
        dur: dur ?? prev?.dur ?? 0,
        at: Date.now(),
      };
      return { ...s, history: [entry, ...s.history.filter((x) => x.id !== id)].slice(0, 80) };
    });
  }, []);
  const clearHistory = useCallback(() => setP((s) => ({ ...s, history: [] })), []);
  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, []);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), []);

  /* ── 本地备份：导出 / 导入（替代原账号云同步） ── */
  const exportBackup = useCallback(() => pRef.current, []);

  const importBackup = useCallback((raw: string) => {
    try {
      const data = JSON.parse(raw) as Partial<Persist>;
      const normHist = normalizeHistory(data.history);
      const idsOf = (arr: unknown) => (Array.isArray(arr) ? arr.filter((x): x is number => typeof x === "number") : []);
      let counts = { likes: 0, favs: 0, history: 0, follows: 0 };
      setP((s) => {
        const likes = [...new Set([...s.likes, ...idsOf(data.likes)])];
        const favs = [...new Set([...s.favs, ...idsOf(data.favs)])];
        const follows = [...new Set([...s.follows, ...idsOf(data.follows)])];
        const histMap = new Map(s.history.map((h) => [h.id, h]));
        normHist.forEach((h) => {
          const prev = histMap.get(h.id);
          // 取两边更"新"的进度（时间戳大的赢）
          if (!prev || h.at >= prev.at) histMap.set(h.id, h);
        });
        const searchHist = [...new Set([...(Array.isArray(data.searchHist) ? data.searchHist.filter((x): x is string => typeof x === "string") : []), ...s.searchHist])].slice(0, 12);
        counts = { likes: likes.length - s.likes.length, favs: favs.length - s.favs.length, history: histMap.size - s.history.length, follows: follows.length - s.follows.length };
        return {
          ...s,
          likes, favs, follows, searchHist,
          history: [...histMap.values()].sort((a, b) => b.at - a.at).slice(0, 80),
          // 偏好类以备份为准（有值才覆盖）
          muted: typeof data.muted === "boolean" ? data.muted : s.muted,
          muteOnStartup: typeof data.muteOnStartup === "boolean" ? data.muteOnStartup : s.muteOnStartup,
          volume: typeof data.volume === "number" ? data.volume : s.volume,
        };
      });
      return { ok: true, msg: `导入完成：收藏 +${Math.max(0, counts.favs)} · 历史 +${Math.max(0, counts.history)}` };
    } catch (e) {
      return { ok: false, msg: `导入失败：${(e as Error).message?.slice(0, 60) || "文件格式不正确"}` };
    }
  }, []);

  const setTheater = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTheaterState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setFs = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setFsState((prev) => {
      const next = typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v;
      if (!next) {
        invoke("set_orientation", { landscape: false }).catch(() => {});
        try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
      }
      return next;
    });
  }, []);

  const setClean = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setCleanState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setMuted = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setP((s) => ({ ...s, muted: typeof v === "function" ? v(s.muted) : v }));
  }, []);
  const setMuteOnStartup = useCallback((on: boolean) => {
    setP((s) => ({ ...s, muteOnStartup: on }));
  }, []);
  const setPrefetchNext = useCallback((on: boolean) => {
    setP((s) => ({ ...s, prefetchNext: on }));
  }, []);
  const setVolume = useCallback((v: number) => {
    const volume = Math.max(0, Math.min(1, v));
    setP((s) => ({ ...s, volume, muted: volume === 0 }));
  }, []);

  const value = useMemo<Store>(() => ({
    platform: envPlatform,
    theme, setTheme: setThemeState,
    skin, setSkin,
    tab, setTab, stack, push, pop, fwd, canFwd: forward.length > 0,
    likes: p.likes, favs: p.favs, history: p.history, follows: p.follows,
    isLiked: (id) => p.likes.includes(id),
    isFav: (id) => p.favs.includes(id),
    toggleLikeLocal, toggleFavLocal, toggleFollowLocal, addHistory, clearHistory,
    exportBackup, importBackup,
    muted: p.muted, setMuted, volume: p.volume, setVolume,
    theater, setTheater, fs, setFs, clean, setClean,
    muteOnStartup: p.muteOnStartup, setMuteOnStartup,
    prefetchNext: p.prefetchNext !== false, setPrefetchNext,
    searchHist: p.searchHist, addSearch, clearSearchHist,
    strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast,
  }), [theme, tab, setTab, stack, push, pop, fwd, forward,
    skin, setSkin,
    p, toggleLikeLocal, toggleFavLocal, toggleFollowLocal, addHistory, clearHistory, exportBackup, importBackup,
    setMuted, setMuteOnStartup, setPrefetchNext, setVolume, addSearch, clearSearchHist, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast, theater, setTheater, fs, setFs, clean, setClean]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
