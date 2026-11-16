import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, APP_VERSION, fmtTime, isMobile, platform } from "../api";
import type { Detail } from "../types";
import { SKINS, useStore } from "../store";
import { Avatar, Empty, Img } from "../components/ui";
import { ICheck, IChevR, IClock, IDownload, ISettings, IStar } from "../icons";

/* 我的：结构固定（本地资料卡 + 皮肤 + 离线视频 + 观看历史 / 我的收藏）。
   已移除账号体系：收藏、历史、点赞全部保存在本地，可到设置里导出备份。 */
export default function Profile({ wide }: { wide: boolean }) {
  const { history, favs, clearHistory, push, likes, skin, setSkin, toast } = useStore();
  const [tab, setTab] = useState<"fav" | "history">("history");
  const [cards, setCards] = useState<Detail[]>([]);
  const [loading, setLoading] = useState(false);
  /* 离线视频：正在下载 / 已完成数量（我的页入口上直接显示） */
  const [dlCount, setDlCount] = useState({ run: 0, done: 0 });
  useEffect(() => {
    let alive = true;
    const pull = () => invoke<{ items?: { status: string; auto?: boolean }[] }>("dl_list")
      .then((r) => {
        if (!alive) return;
        /* 自动预缓存的条目不算「下载」，不在这里计数 */
        const it = (r?.items || []).filter((x) => x.auto !== true);
        setDlCount({
          run: it.filter((x) => x.status !== "done").length,
          done: it.filter((x) => x.status === "done").length,
        });
      })
      .catch(() => {});
    void pull();
    const t = window.setInterval(pull, 4000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  const ids = tab === "fav" ? favs : history.map((h) => h.id);
  /** 观看记录里这条的进度（收藏页没有） */
  const progressOf = (id: number) => (tab === "history" ? history.find((h) => h.id === id) : undefined);

  useEffect(() => {
    let alive = true;
    if (!ids.length) { setCards([]); return; }
    setLoading(true);
    Promise.allSettled(ids.slice(0, 12).map((id) => api.video(id)))
      .then((rs) => {
        if (!alive) return;
        setCards(rs.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<Detail>).value));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [ids.join(",")]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 px-4 pb-2 flex items-center" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
        <div className="text-[24px] font-bold text-on leading-none">我的</div>
        {isMobile && (
          <button onClick={() => push({ kind: "settings" })} aria-label="设置"
            className="ml-auto h-9 pl-2 pr-3 rounded-full bg-s3 flex items-center gap-1 text-mut pressable">
            <ISettings size={16} strokeWidth={1.7} /><span className="text-[12px] font-semibold">设置</span>
          </button>
        )}
      </div>

      <div className="flex-1 scroll-y px-4 pt-2 pb-28">
        {/* 资料卡：本地模式 */}
        <div className="rounded-(--r-lg) bg-s1 p-4 elev-1 flex items-center gap-3.5 a-rise">
          <Avatar size={56} name="本地用户" hue={150} ring />
          <div className="flex-1 min-w-0">
            <div className="text-[16px] font-bold text-on">本地用户</div>
            <div className="text-[11px] text-mut mt-0.5">数据保存在本机 · 可在设置中导出备份</div>
            <div className="flex gap-3 mt-2 text-[10.5px] text-mut">
              <span>收藏 <b className="text-on">{favs.length}</b></span>
              <span>喜欢 <b className="text-on">{likes.length}</b></span>
              <span>观看 <b className="text-on">{history.length}</b></span>
            </div>
          </div>
        </div>

        {/* 离线视频入口 */}
        <button onClick={() => push({ kind: "downloads" })}
          className="mt-3 w-full rounded-(--r-md) bg-s2 px-3.5 py-3 flex items-center gap-3 text-left pressable elev-1">
          <span className="w-9 h-9 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0"><IDownload size={17} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-on">离线视频</div>
            <div className="text-[10.5px] text-mut mt-0.5">
              下载中 {dlCount.run} 集 · 已完成 {dlCount.done} 集 · 可暂停 / 继续 / 删除
            </div>
          </div>
          {dlCount.run > 0 && (
            <span className="px-1.5 h-5 rounded-full bg-primary text-on-primary text-[10px] font-bold flex items-center">{dlCount.run}</span>
          )}
          <IChevR size={15} className="text-mut" />
        </button>

        {/* 皮肤：5 套流行配色，点一下立即生效 */}
        <div className="mt-3 rounded-(--r-md) bg-s2 px-3.5 py-3 elev-1">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-semibold text-on">皮肤</span>
            <span className="text-[10px] text-mut">点击立即更换 · 全 App 生效</span>
            <span className="ml-auto text-[10px] text-primary">{SKINS.find((s) => s.id === skin)?.name}</span>
          </div>
          <div className="mt-2.5 grid grid-cols-5 gap-2">
            {SKINS.map((s) => {
              const on = s.id === skin;
              return (
                <button key={s.id} onClick={() => { setSkin(s.id); toast(`已切换到「${s.name}」皮肤`, "ok"); }}
                  aria-pressed={on} className="flex flex-col items-center gap-1.5 pressable">
                  <span className="relative w-10 h-10 rounded-full flex items-center justify-center"
                    style={{
                      background: `radial-gradient(circle at 32% 28%, ${s.dot}, ${s.dot}55 70%)`,
                      boxShadow: on ? `0 0 0 2px var(--p-bg), 0 0 0 4px ${s.dot}` : "inset 0 0 0 1px rgba(255,255,255,.12)",
                    }}>
                    {on && <ICheck size={15} strokeWidth={2.6} className="text-black/70" />}
                  </span>
                  <span className={`text-[10px] font-semibold ${on ? "text-on" : "text-mut"}`}>{s.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 我的内容：观看历史在前，我的收藏在后 */}
        <div className="flex bg-s3 rounded-(--r-ctl) p-1 mt-4">
          {([["history", "观看历史"], ["fav", "我的收藏"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex-1 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${tab === k ? "tonal text-on-sec" : "text-mut"}`}
              style={tab === k ? { background: "var(--p-sec)", color: "var(--p-primary)" } : undefined}>{l}</button>
          ))}
        </div>

        <div className="mt-3">
          {loading ? (
            <div className="flex justify-center py-8"><div className="w-7 h-7 spinner" /></div>
          ) : cards.length ? (
            <div className="grid grid-cols-3 gap-2">
              {cards.map((c) => {
                const p = progressOf(c.id);
                return (
                <button key={c.id} onClick={() => push({
                  kind: "feed", videoIds: cards.map((x) => x.id), index: cards.findIndex((x) => x.id === c.id),
                  title: tab === "fav" ? "我的收藏" : "观看历史",
                  startEp: p?.ep, startTime: p?.t,
                })}
                  className="relative rounded-(--r-sm) overflow-hidden bg-s1 elev-1 pressable" style={{ paddingTop: "133%" }}>
                  <Img src={c.cover} />
                  {!!p && (
                    <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-full bg-black/65 text-[9.5px] text-white/90 leading-none">
                      第 {p.ep} 集{p.t > 3 ? ` · ${fmtTime(p.t)}` : ""}
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-1.5">
                    <div className="text-[10.5px] text-white clamp-2 leading-tight">{c.title}</div>
                  </div>
                </button>
                );
              })}
            </div>
          ) : (
            <Empty icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />}
              title={tab === "fav" ? "还没有收藏" : "还没有观看记录"}
              sub={tab === "fav" ? "在剧集页点收藏，之后就能在这里找到" : "看过的剧集会出现在这里"}
              action="去逛逛" onAction={() => push({ kind: "ranks" })} />
          )}
          {cards.length > 0 && tab === "history" && (
            <button onClick={clearHistory} className="mt-3 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-mut pressable">清空观看历史</button>
          )}
        </div>

        <div className="text-center text-[10px] text-dim mt-5">HGhub {APP_VERSION} · {platform === "android" ? "Android" : platform === "ios" ? "iOS" : platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows"} 客户端</div>
      </div>
    </div>
  );
}