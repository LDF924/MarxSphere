// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// NotificationsPanel.tsx — 用户通知中心(2026-10-02)
//
// 由来: 本仓的通知此前只有**全局 alerts**(没有 user_id), 由此产生的三个真实缺陷:
//   · `agent-task-service.ts` 的任务完成通知写 alerts(level=info) → AlertToast
//     明确过滤 info, **永远弹不出来**;
//   · `rss-service.ts` 的 RSS 推送同型;
//   · `AlertsPanel.tsx` 的 CATEGORY_LABELS 没有 `agent` 键 → 显示裸英文。
// 根因是只有一张全局表。175 迁移补了带 user_id 的 notifications, 本面板是它的读取端。
//
// ⚠ 与「告警中心」(AlertsPanel)是**两个东西**, 不要合并:
//   告警中心 = 运维事实(推理降级/熔断/巡检失败), 全站一份, 谁看都一样;
//   通知中心 = 给我的消息(我的任务完成了/我的积分到账了), 每人一份。
import { useEffect, useState, useCallback } from "react";
import { Bell, CheckCheck, Trash2, ListTodo, Coins, CreditCard, Newspaper, Info, BellOff, SlidersHorizontal } from "lucide-react";
import { PanelHeader, PanelCard, PanelButton, PanelEmpty, PillGroup } from "./PanelShell";
import { api } from "../lib/api";
import { cn } from "../lib/utils";

interface Notification {
  id: string; category: string; level: string; title: string; body: string;
  link: Record<string, unknown>; readAt: string | null; createdAt: string;
}

/** 类别 → 图标与中文名。
 *  ⚠ 新增 category 必须在这里登记 —— AlertsPanel 漏登 `agent` 导致显示裸英文键名,
 *    那是"改了后端忘了前端"的典型。 */
const CATEGORY: Record<string, { label: string; icon: typeof Bell }> = {
  task: { label: "任务", icon: ListTodo },
  points: { label: "积分", icon: Coins },
  payment: { label: "支付", icon: CreditCard },
  digest: { label: "速递", icon: Newspaper },
  system: { label: "系统", icon: Info },
};

const LEVEL_CLS: Record<string, string> = {
  info: "border-l-sky-400/60",
  success: "border-l-emerald-400/60",
  warning: "border-l-amber-400/60",
  error: "border-l-red-400/60",
};

export function NotificationsPanel() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [filter, setFilter] = useState<"all" | "unread">("unread");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  /** 静音偏好 —— 服务端存(users.notification_muted), 见迁移 179 的说明 */
  const [muted, setMuted] = useState<string[]>([]);
  const [showPrefs, setShowPrefs] = useState(false);

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const r = await api.notificationsList({ unread: filter === "unread" }) as { notifications: Notification[] };
      setItems(r.notifications);
      const u = await api.notificationsUnread() as { unread: number };
      setUnread(u.unread);
    } catch (e) {
      setErr((e as Error).message || "加载失败");
    } finally { setBusy(false); }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/notifications/settings", {
          headers: { Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` },
        }).then((x) => x.json());
        if (Array.isArray(r?.muted)) setMuted(r.muted.map(String));
      } catch { /* 拉不到就按"都没静音"显示, 不阻断面板 */ }
    })();
  }, []);

  async function toggleMute(cat: string) {
    const next = muted.includes(cat) ? muted.filter((c) => c !== cat) : [...muted, cat];
    setMuted(next); // 乐观更新 —— 开关类控件等一个来回会显得卡
    try {
      const r = await fetch("/api/notifications/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` },
        body: JSON.stringify({ muted: next }),
      }).then((x) => x.json());
      // 服务端会丢掉非法分类名, 以它返回的为准回写 —— 否则界面会显示一个实际没生效的开关
      if (Array.isArray(r?.muted)) setMuted(r.muted.map(String));
    } catch (e) { setErr((e as Error).message || "保存失败"); void load(); }
  }

  async function markAll() {
    try { await api.notificationsRead([]); await load(); } catch (e) { setErr((e as Error).message || "标记失败"); }
  }
  async function markOne(id: string) {
    try { await api.notificationsRead([id]); await load(); } catch { /* 单条失败不打断 */ }
  }
  async function clearRead() {
    try { await api.notificationsClear(); await load(); } catch (e) { setErr((e as Error).message || "清理失败"); }
  }

  return (
    <div className="space-y-3">
      <PanelHeader icon={<Bell className="h-4 w-4" />} title="通知中心" accent="sky" />

      {err && <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{err}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <PillGroup
          value={filter}
          onChange={(v) => setFilter(v as "all" | "unread")}
          options={[
            { value: "unread", label: unread > 0 ? `未读 (${unread})` : "未读" },
            { value: "all", label: "全部" },
          ]}
        />
        <PanelButton onClick={() => void markAll()} disabled={unread === 0} data-control="notifications:mark-all">
          <CheckCheck className="h-3 w-3" />全部已读
        </PanelButton>
        <PanelButton onClick={() => void clearRead()} data-control="notifications:clear-read">
          <Trash2 className="h-3 w-3" />清理已读
        </PanelButton>
        <PanelButton onClick={() => setShowPrefs((v) => !v)} data-control="notifications:prefs">
          <SlidersHorizontal className="h-3 w-3" />{showPrefs ? "收起设置" : "分类设置"}
          {muted.length > 0 ? <span className="ml-1 rounded bg-amber-400/20 px-1 text-[10px] text-amber-300">{muted.length} 类已静音</span> : null}
        </PanelButton>
      </div>

      {showPrefs ? (
        <PanelCard>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium">
            <BellOff className="h-3.5 w-3.5" />不想收哪几类？
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(CATEGORY).map(([key, c]) => {
              const CatIcon = c.icon;
              const on = muted.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => void toggleMute(key)}
                  data-control={`notifications:mute-${key}`}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                    on ? "border-amber-400/40 bg-amber-400/10 text-amber-300" : "border-border text-muted-foreground hover:bg-accent"
                  )}
                  title={on ? `恢复接收「${c.label}」` : `静音「${c.label}」`}
                >
                  <CatIcon className="h-3 w-3" />
                  {c.label}
                  <span className="opacity-70">{on ? "已静音" : "接收中"}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground/70">
            静音在服务端生效：被静音的分类根本不会写入通知表（不是写了再隐藏），换设备也一样。
          </div>
        </PanelCard>
      ) : null}

      {busy && items.length === 0 && <div className="text-xs text-muted-foreground">加载中…</div>}

      {!busy && items.length === 0 && (
        <PanelEmpty>
          {filter === "unread" ? "没有未读通知。" : "还没有通知。任务完成、积分变动、速递更新都会出现在这里。"}
        </PanelEmpty>
      )}

      <div className="space-y-1.5">
        {items.map((n) => {
          const cat = CATEGORY[n.category] || CATEGORY.system;
          const Icon = cat.icon;
          const view = typeof n.link?.view === "string" ? (n.link.view as string) : "";
          return (
            <PanelCard key={n.id}>
              <div className={cn("border-l-2 pl-2.5", LEVEL_CLS[n.level] || LEVEL_CLS.info)}>
                <div className="flex items-start gap-2">
                  <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className={cn("text-sm leading-snug", !n.readAt && "font-medium")}>{n.title}</div>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{cat.label}</span>
                    </div>
                    {n.body && <div className="mt-0.5 text-xs text-muted-foreground">{n.body}</div>}
                    <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
                      <span>{n.createdAt.slice(0, 19).replace("T", " ")}</span>
                      {view && (
                        <button
                          className="text-sky-300 hover:underline"
                          onClick={() => {
                            // 跳转交给 hash 路由(与 App.tsx 的 workspaceView 同一套),
                            // 不在这里 import 路由 —— 面板不该知道宿主怎么切视图
                            location.hash = `#${view}`;
                          }}
                        >查看</button>
                      )}
                      {!n.readAt && (
                        <button className="hover:underline" onClick={() => void markOne(n.id)}>标为已读</button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </PanelCard>
          );
        })}
      </div>
    </div>
  );
}
