import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, type Page, type Tab } from "./store";
import { isMobile, selfTest } from "./api";
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { runBack } from "./back";
import Home from "./pages/Home";
import Search, { RankPage } from "./pages/Search";
import Category, { ChannelPage } from "./pages/Category";
import Profile from "./pages/Profile";
import SettingsPage from "./pages/Settings";
import OfflinePage from "./pages/Offline";
import Feed from "./components/Feed";
import { PostsPage, PostDetail } from "./pages/Posts";
import { ToastHost } from "./components/ui";
import { DesktopRail, DesktopTitleBar } from "./components/DesktopChrome";
import ResizeHandles from "./components/ResizeHandles";
import { tracePlayback } from "./playbackDiagnostics";
import { IGrid, IGridF, IHome, IHomeF, ISearch, IUser, IUserF, Logo } from "./icons";

/* ============ 底部标签栏（Android）—— 图标 + 文字、选中胶囊高亮 ============ */
function TabBar() {
  const { tab, setTab, theme } = useStore();
  const items: { k: Tab; label: string; I: (p: { size?: number; strokeWidth?: number }) => React.ReactElement; IF?: (p: { size?: number; strokeWidth?: number }) => React.ReactElement }[] = [
    { k: "home", label: "首页", I: IHome, IF: IHomeF },
    { k: "search", label: "搜索", I: ISearch },
    { k: "category", label: "分类", I: IGrid, IF: IGridF },
    { k: "profile", label: "我的", I: IUser, IF: IUserF },
  ];
  /* 首页已是内容页（卡片流）→ 底栏跟主题走；播放页作为栈页打开时会整页盖住底栏。
     选中项：图标套主色胶囊 + 图标切换实底形态，一眼可辨。 */
  const lightBar = theme === "light";
  return (
    <nav className="hg-tabbar absolute bottom-0 inset-x-0 z-30"
      style={{
        paddingBottom: "var(--sab, 0px)",
        background: lightBar ? "rgba(252, 251, 250, .96)" : "rgba(14, 13, 12, .93)",
        backdropFilter: "blur(22px)",
        borderTop: lightBar ? "1px solid rgba(0,0,0,.07)" : "1px solid rgba(255,255,255,.08)",
        boxShadow: lightBar ? "0 -2px 14px rgba(0,0,0,.05)" : "none",
      }}>
      <div className="h-[56px] flex items-stretch px-2">
        {items.map(({ k, label, I, IF }) => {
          const on = tab === k;
          const Ink = (on && IF) ? IF : I;
          return (
            <button key={k} onClick={() => setTab(k)}
              className="flex-1 flex flex-col items-center justify-center gap-[3px] pressable"
              aria-selected={on}>
              <span className="flex items-center justify-center h-[25px] min-w-[52px] px-[13px] rounded-full transition-colors duration-200"
                style={{ background: on ? "var(--p-tint)" : "transparent" }}>
                <Ink size={20} strokeWidth={on ? 2.3 : 1.9} />
              </span>
              <span className="text-[10.5px] leading-none font-semibold tracking-wide transition-colors duration-200"
                style={{
                  color: on
                    ? "var(--p-primary)"
                    : lightBar ? "rgba(0,0,0,.42)" : "rgba(255,255,255,.55)",
                }}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/* ============ 手势导航层：向左滑后退，向右滑前进 ============
   只拦截一次有效的横向滑动；输入框内打字、竖向滚动、播放器手势都不受影响。 */
function SwipeNav({ enabled, onBack, onFwd, children }: {
  enabled: boolean; onBack: () => void; onFwd: () => void; children: React.ReactNode;
}) {
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  return (
    <div
      className="absolute inset-0"
      style={{ touchAction: "pan-y" }}
      onTouchStart={(e) => {
        if (!enabled || e.touches.length !== 1) { start.current = null; return; }
        const t = e.touches[0];
        const el = t.target as HTMLElement;
        // 输入框 / 文本域 / 明确禁用手势的区域不触发
        if (el?.closest?.("input, textarea, [data-no-swipe]")) { start.current = null; return; }
        start.current = { x: t.clientX, y: t.clientY, t: Date.now() };
      }}
      onTouchMove={(e) => {
        if (!start.current) return;
        const t = e.touches[0];
        // 竖向位移明显就放弃，避免和上下滚动打架
        if (Math.abs(t.clientY - start.current.y) > 48) start.current = null;
      }}
      onTouchEnd={(e) => {
        const s = start.current;
        start.current = null;
        if (!s) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - s.x;
        const dy = t.clientY - s.y;
        if (Date.now() - s.t > 700 || Math.abs(dx) < 76 || Math.abs(dy) > 52) return;
        if (Math.abs(dx) < Math.abs(dy) * 1.4) return;
        if (dx < 0) onBack(); else onFwd();
      }}>
      {children}
    </div>
  );
}

/* ============ 堆栈页面 ============ */
function StackPage({ page, onBack, wide, top, bottomInset }: {
  page: Page; onBack: () => void; wide: boolean; top: boolean; bottomInset: number;
}) {
  if (page.kind === "feed") {
    return (
      <Feed videoIds={page.videoIds} startIndex={page.index} title={page.title} kind={page.feedKind || "video"}
        startEp={page.startEp} startTime={page.startTime}
        mode="context" active={top} bottomInset={bottomInset} onBack={onBack} />
    );
  }
  if (page.kind === "channel") return <ChannelPage cate={page.cate} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "ranks") return <RankPage onBack={onBack} wide={wide} />;
  if (page.kind === "settings") return <SettingsPage onBack={onBack} wide={wide} />;
  if (page.kind === "downloads") return <OfflinePage onBack={onBack} wide={wide} />;
  if (page.kind === "posts") return <PostsPage onBack={onBack} wide={wide} />;
  if (page.kind === "post") return <PostDetail id={page.id} onBack={onBack} active={top} />;
  return null;
}

/* ============ 应用主体 ============ */
function AppBody() {
  const { platform, tab, setTab, stack, pop, fwd, canFwd, fs, clean } = useStore();
  const isMobile = platform === "android" || platform === "ios";
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(!isMobile);
  const [collapsed, setCollapsed] = useState(false);
  /* 主 tab 页手势：左划后退=上一个 tab，右划前进=下一个 tab */
  const TAB_ORDER: Tab[] = ["home", "search", "category", "profile"];
  const tabSwipe = {
    back: () => { const i = TAB_ORDER.indexOf(tab); if (i > 0) setTab(TAB_ORDER[i - 1]); },
    fwd: () => { const i = TAB_ORDER.indexOf(tab); if (i < TAB_ORDER.length - 1) setTab(TAB_ORDER[i + 1]); },
  };

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  /* 全局键盘 */
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.key === "Escape") { if (stack.length) pop(); return; }
      if (e.key === "/") { e.preventDefault(); setTab("search"); return; }
      if (["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
        setTab((["home", "search", "category", "profile"] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, setTab]);

  const vis = (k: Tab) => (tab === k ? "absolute inset-0" : "absolute inset-0 invisible pointer-events-none");
  const pageActive = stack.length === 0;
  /* 栈页（从搜索/分类/我的进入的播放页、图文页）没有底栏，
     底部只让出安全区。之前多留了 20px，视频底边会露出一条
     「底栏」似的窄缝（底部的压暗渐变到不了屏幕最底）。 */
  const stackInset = isMobile ? 0 : 14;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      {!isMobile && <DesktopRail collapsed={collapsed} />}
      <div ref={mainRef} className="relative flex-1 min-w-0 overflow-hidden win-main">
        <div className={vis("home")}><Home active={pageActive && tab === "home"} /></div>
        {isMobile ? (
          <>
            <div className={vis("search")}>
              <SwipeNav enabled={pageActive} onBack={tabSwipe.back} onFwd={tabSwipe.fwd}>
                <Search active={pageActive && tab === "search"} wide={wide} />
              </SwipeNav>
            </div>
            <div className={vis("category")}>
              <SwipeNav enabled={pageActive} onBack={tabSwipe.back} onFwd={tabSwipe.fwd}>
                <Category wide={wide} active={pageActive && tab === "category"} />
              </SwipeNav>
            </div>
            <div className={vis("profile")}>
              <SwipeNav enabled={pageActive} onBack={tabSwipe.back} onFwd={tabSwipe.fwd}>
                <Profile wide={wide} />
              </SwipeNav>
            </div>
          </>
        ) : (
          <>
            <div className={vis("search")}><Search active={pageActive && tab === "search"} wide={wide} /></div>
            <div className={vis("category")}><Category wide={wide} active={pageActive && tab === "category"} /></div>
            <div className={vis("profile")}><Profile wide={wide} /></div>
          </>
        )}

        {stack.map((p, i) => (
          <div key={p.key} className="absolute inset-0 z-30 bg-bg a-page-in" style={{ boxShadow: "-18px 0 40px rgba(0,0,0,.5)" }}>
            {isMobile && p.kind !== "feed" ? (
              <SwipeNav enabled={i === stack.length - 1} onBack={pop}
                onFwd={canFwd ? fwd : () => {
                  /* 已无前进记录 = 到了最末级：右滑改为切到下一个标签页 */
                  const idx = TAB_ORDER.indexOf(tab);
                  if (idx < TAB_ORDER.length - 1) setTab(TAB_ORDER[idx + 1]);
                  else pop();
                }}>
                <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={stackInset} />
              </SwipeNav>
            ) : (
              <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={stackInset} />
            )}
          </div>
        ))}

        {isMobile && !fs && !clean && stack.length === 0 && <TabBar />}
      </div>
    </div>
  );
}

/* ============ 桌面窗口壳（Windows / macOS）============ */
function DesktopShell() {
  const [collapsed, setCollapsed] = useState(false);
  const { theater, platform } = useStore();
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas win-root plat-${platform}`}>
      <DesktopTitleBar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="relative flex-1 min-h-0">
        <ShellInner collapsed={collapsed || theater} theater={theater} />
      </div>
      {/* 边缘缩放热区只对无边框窗口（Windows）有效，macOS 走原生窗口边框 */}
      {platform === "windows" && <ResizeHandles />}
    </div>
  );
}

function ShellInner({ collapsed, theater }: { collapsed: boolean; theater: boolean }) {
  const { stack, pop, tab, setTab, platform } = useStore();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.key === "Escape") { if (stack.length) pop(); return; }
      if (e.key === "/") { e.preventDefault(); setTab("search"); return; }
      if (["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
        setTab((["home", "search", "category", "profile"] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, setTab]);

  const vis = (k: Tab) => (tab === k ? "absolute inset-0" : "absolute inset-0 invisible pointer-events-none");
  const pageActive = stack.length === 0;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      {!theater && <DesktopRail collapsed={collapsed} />}
      <div ref={mainRef} className={`relative flex-1 min-w-0 overflow-hidden win-main ${theater ? "is-theater-main" : ""}`}>
        <div className={vis("home")}><Home active={pageActive && tab === "home"} /></div>
        <div className={vis("search")}><Search active={pageActive && tab === "search"} wide={wide} /></div>
        <div className={vis("category")}><Category wide={wide} active={pageActive && tab === "category"} /></div>
        <div className={vis("profile")}><Profile wide={wide} /></div>
        {stack.map((p, i) => (
          <div key={p.key} className="absolute inset-0 z-30 bg-bg win-page-in" style={{ boxShadow: "-18px 0 40px rgba(0,0,0,.5)" }}>
            <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={14} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============ 移动端（无壳） ============ */
function MobileShell() {
  const { platform } = useStore();
  /* 安卓：WebView 不一定上报 env(safe-area-inset-bottom)，MIUI 手势条/三键导航
     会盖住底部 UI，给出较大的最小预留把菜单栏托起来。 */
  const sabMin = platform === "android" ? 44 : 16;
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas plat-${platform}`}
      style={{ "--sat": "max(env(safe-area-inset-top), 12px)", "--sab": `max(env(safe-area-inset-bottom), ${sabMin}px)` } as React.CSSProperties}>
      <div className="relative flex-1 min-h-0">
        <AppBody />
      </div>
    </div>
  );
}

/* ============ 入口 ============ */
export default function App() {
  const { platform, tab, setTab, stack, pop, fs, setFs } = useStore();
  useEffect(() => {
    tracePlayback("navigation.change", { tab, stack: stack.map(p => ({ page: p.kind, key: p.key })) });
  }, [tab, stack]);

  /* —— 安卓硬件返回键 ——
     层级：全屏 → 面板/弹层 → 页面栈 → 回首页 → 退出应用。
     不注册这个监听，Tauri 会直接 webView.goBack() 或退出，表现就是「任意页面返回都回桌面」。 */
  const backRef = useRef<() => void>(() => {});
  backRef.current = () => {
    if (fs) { setFs(false); return; }                        // 沉浸全屏
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (runBack()) return;                                  // 播放器的选集/评论/图文面板
    if (stack.length) { pop(); return; }
    if (tab !== "home") { setTab("home"); return; }
    invoke("plugin:app|exit", { code: 0 }).catch(() => {});
  };

  useEffect(() => {
    if (platform !== "android") return undefined;
    let disposed = false;
    let handle: { unregister: () => Promise<void> } | null = null;
    addPluginListener("app", "back-button", () => backRef.current())
      .then((l) => { if (disposed) l.unregister().catch(() => {}); else handle = l; })
      .catch(() => { /* 非安卓宿主忽略 */ });
    return () => {
      disposed = true;
      handle?.unregister().catch(() => {});
    };
  }, [platform]);

  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", prevent);
    return () => document.removeEventListener("contextmenu", prevent);
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const t = window.setTimeout(() => {
      selfTest().then((r) => { invoke("debug_log", { msg: r }).catch(() => {}); }).catch(() => {});
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <>
      {isMobile ? <MobileShell /> : <DesktopShell />}
      <ToastHost />
    </>
  );
}
