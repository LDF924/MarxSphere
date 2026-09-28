// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ServiceTokensPanel.tsx — V418: 外部服务密钥（有效期 + 到期提醒）
//
// 由来(2026-09-28 用户要求): MinerU 的 OCR token 在 2026-09-16 悄悄过期, 11 天后才被发现。
//   中间那段时间扫描版 PDF 上传不上来, 但报错里没有一个字提到密钥 —— 只能靠人猜。
//   用户的原话是「弄个有效期和提醒这些」。
//
// ## 三条设计取舍(每条都是踩过的坑)
//
// ① **不回显密钥**。填过的密钥一律显示成 `••••••{末6位}`, 输入框留空 = 不改。
//    想改的人才需要重新粘贴。这与 SettingsPanel 的 AI 密钥约定一致(App.tsx:4754 那一带)。
//
// ② **到期日只是"声明", 校验才是"事实"**。实测: 一枚载荷写着 09-16 到期的密钥,
//    远端确实拒了; 而另一枚新密钥日期还早、远端也通。反过来说, 只看日期分不出
//    "还剩 10 天"与"已被吊销"。所以面板上有独立的「校验」按钮, 它**真的打一次远端接口**
//    (POST 空 body, 请求在校验之后建任务之前就被拒掉, 不会在对方账号下留任务)。
//
// ③ **提醒走既有告警中心, 不另造**。后端每日巡检写 `category: "token"` 的告警,
//    前端顶部 toast 与「告警中心」都已经认识它。这里只显示"距上次校验多久"。
import { useState, useEffect, type FC } from "react";
import { KeyRound, Loader2, RefreshCw, ShieldCheck, AlertTriangle, ExternalLink, Trash2, CheckCircle2, HelpCircle, Save } from "lucide-react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { useI18n } from "../i18n";

interface ServiceTokenView {
  service: string;
  label: string;
  purpose: string;
  applyUrl: string;
  shapeHint: string;
  configured: boolean;
  source: "db" | "env" | "none";
  tail: string;
  issuedAt: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  status: "unconfigured" | "unknown" | "ok" | "expiring" | "expired";
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckNote: string;
  note: string;
  updatedAt: string | null;
}

/** 状态 → 文案 + 配色。**未知也是单独一档**: 没有到期日时不能显示成"正常" */
const STATUS_META: Record<ServiceTokenView["status"], { text: string; cls: string; icon: FC<{ className?: string }> }> = {
  unconfigured: { text: "未配置", cls: "bg-muted text-muted-foreground", icon: HelpCircle },
  unknown: { text: "到期日未知", cls: "bg-amber-500/15 text-amber-600", icon: HelpCircle },
  ok: { text: "有效", cls: "bg-green-500/15 text-green-600", icon: CheckCircle2 },
  expiring: { text: "临近到期", cls: "bg-amber-500/15 text-amber-600", icon: AlertTriangle },
  expired: { text: "已过期", cls: "bg-red-500/15 text-red-600", icon: AlertTriangle },
};

/** ISO → 本地日期(只到天)。空值显示破折号, 不显示空串让人以为是坏了 */
function day(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("zh-CN");
}

/** "3 天前" / "就在刚才" —— 比一个绝对时间戳更容易判断"这个结论还新不新" */
function ago(iso: string | null): string {
  if (!iso) return "从未";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "从未";
  const m = Math.floor(ms / 60000);
  if (m < 2) return "就在刚才";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function ServiceTokensPanel() {
  const { t } = useI18n();
  const [tokens, setTokens] = useState<ServiceTokenView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>("");          // 正在忙哪个服务
  /** 每个服务各自的输入框草稿(留空 = 不修改现有密钥) */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [expiryDraft, setExpiryDraft] = useState<Record<string, string>>({});
  /** 校验结果: 服务 → {ok, msg}。只活在本页 —— 落库的那份在 lastCheck* 字段(刷新后还在) */
  const [verdict, setVerdict] = useState<Record<string, { ok: boolean; msg: string }>>({});

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/service-tokens");
      const j = (await r.json()) as { tokens?: ServiceTokenView[] };
      setTokens(j.tokens ?? []);
    } catch {
      setTokens([]);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const save = async (svc: string) => {
    setBusy(svc);
    try {
      const body: Record<string, unknown> = {};
      const v = (draft[svc] ?? "").trim();
      if (v) body.token = v;                                  // 空 = 只改日期, 不动密钥
      const exp = (expiryDraft[svc] ?? "").trim();
      if (exp) body.expiresAt = new Date(exp + "T23:59:59").toISOString();
      const r = await fetch(`/api/service-tokens/${encodeURIComponent(svc)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) { setVerdict((p) => ({ ...p, [svc]: { ok: false, msg: j.error ?? "保存失败" } })); return; }
      setDraft((p) => ({ ...p, [svc]: "" }));
      setExpiryDraft((p) => ({ ...p, [svc]: "" }));
      await load();
      setVerdict((p) => ({ ...p, [svc]: { ok: true, msg: t("已保存", "Saved") } }));
    } catch (e) {
      setVerdict((p) => ({ ...p, [svc]: { ok: false, msg: String((e as Error).message) } }));
    } finally {
      setBusy("");
    }
  };

  /** 校验当前生效的那个(不带 token → 后端会把结论落库, 刷新后仍看得到) */
  const verify = async (svc: string) => {
    setBusy(svc);
    try {
      const r = await fetch(`/api/service-tokens/${encodeURIComponent(svc)}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const j = (await r.json()) as { ok?: boolean; status?: string; message?: string; error?: string };
      setVerdict((p) => ({ ...p, [svc]: { ok: !!j.ok, msg: j.message ?? j.error ?? "?" } }));
      await load();
    } catch (e) {
      setVerdict((p) => ({ ...p, [svc]: { ok: false, msg: String((e as Error).message) } }));
    } finally {
      setBusy("");
    }
  };

  /** 先测再存: 拿输入框里那个值直接打远端, 通了再让人点保存 */
  const testDraft = async (svc: string) => {
    const v = (draft[svc] ?? "").trim();
    if (!v) { setVerdict((p) => ({ ...p, [svc]: { ok: false, msg: t("请先粘贴密钥再测", "Paste a key first") } })); return; }
    setBusy(svc);
    try {
      const r = await fetch(`/api/service-tokens/${encodeURIComponent(svc)}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: v }),
      });
      const j = (await r.json()) as { ok?: boolean; message?: string; error?: string };
      setVerdict((p) => ({ ...p, [svc]: { ok: !!j.ok, msg: j.message ?? j.error ?? "?" } }));
    } catch (e) {
      setVerdict((p) => ({ ...p, [svc]: { ok: false, msg: String((e as Error).message) } }));
    } finally {
      setBusy("");
    }
  };

  const clear = async (svc: string) => {
    if (!window.confirm(t("清除后，系统会回退到 .env 里部署时写的那份（若有）。确定？", "Clear this stored key and fall back to .env?"))) return;
    await fetch(`/api/service-tokens/${encodeURIComponent(svc)}`, { method: "DELETE" }).catch(() => {});
    await load();
    setVerdict((p) => ({ ...p, [svc]: { ok: true, msg: t("已清除", "Cleared") } }));
  };

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-sky-500" />
          <h3 className="text-sm font-semibold">{t("外部服务密钥", "External service keys")}</h3>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
          {t("刷新", "Refresh")}
        </Button>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        {t(
          "平台调用外部付费接口所需的密钥。密钥只显示末 6 位、不回显明文；到期前 14 天会在告警中心提醒。「校验」会真实调用一次远端接口 —— 到期日只是签发时写的声明，以校验结果为准。",
          "Keys for external paid APIs. Values are never echoed; the last 6 chars identify them. Expiry warnings appear 14 days ahead. Verify really calls the remote API — the expiry date is only a claim.",
        )}
      </p>

      {loading && tokens.length === 0 ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("加载中…", "Loading…")}
        </div>
      ) : null}

      {tokens.map((tk) => {
        const meta = STATUS_META[tk.status];
        const Icon = meta.icon;
        const v = verdict[tk.service];
        return (
          <div key={tk.service} className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold">{tk.label}</span>
              <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`}>
                <Icon className="h-3 w-3" />
                {meta.text}
              </span>
              {tk.configured ? (
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  ••••••{tk.tail}
                </span>
              ) : null}
              {tk.source === "env" ? (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {t("来自 .env", "from .env")}
                </span>
              ) : null}
              {tk.daysLeft !== null ? (
                <span className="text-[10px] text-muted-foreground">
                  {tk.daysLeft < 0
                    ? t(`已过期 ${Math.abs(tk.daysLeft)} 天`, `expired ${Math.abs(tk.daysLeft)}d ago`)
                    : t(`还剩 ${tk.daysLeft} 天`, `${tk.daysLeft}d left`)}
                  （{day(tk.expiresAt)}）
                </span>
              ) : null}
            </div>

            <p className="mt-1.5 text-[11px] text-muted-foreground">{tk.purpose}</p>

            {/* 上次校验: 结论 + 多久以前。⚠ "从未校验"要显式说出来 —— 空白会让人以为验过且通过 */}
            <p className="mt-1 text-[10px] text-muted-foreground">
              {t("上次校验：", "Last checked: ")}
              {tk.lastCheckedAt ? (
                <>
                  <span className={tk.lastCheckOk ? "text-green-600" : "text-amber-600"}>
                    {tk.lastCheckOk ? t("通过", "passed") : t("未通过", "failed")}
                  </span>
                  {" · "}
                  {ago(tk.lastCheckedAt)}
                  {tk.lastCheckNote ? ` · ${tk.lastCheckNote}` : ""}
                </>
              ) : (
                <span className="text-amber-600">{t("从未校验过", "never")}</span>
              )}
            </p>

            {/*
              V418: 配了值却问不到到期日时, **必须推着人去填**。
              这不是可有可无的提示 —— 「密钥在但不知道什么时候失效」正是本次事故的形态
              (2026-09-16 静默过期, 11 天后才发现)。只显示一个"到期日未知"的灰标签,
              用户会当成正常状态划过去。
              ⚠ 新型密钥(非 JWT)读不出到期日, 这是设计上的"不猜", 不是 bug —— 所以给的是
              "请填一下"而不是报错。
            */}
            {tk.configured && tk.expiresAt === null ? (
              <p className="mt-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-600">
                {t(
                  "这类密钥本身不带到期日，平台无从得知。请在右边填一个到期日期 —— 填了才会在到期前 14 天提醒你。",
                  "This key format carries no expiry. Set one on the right so you get warned 14 days ahead.",
                )}
              </p>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="password"
                autoComplete="off"
                value={draft[tk.service] ?? ""}
                onChange={(e) => setDraft((p) => ({ ...p, [tk.service]: e.target.value }))}
                placeholder={tk.configured ? t("留空 = 不修改现有密钥", "Leave blank to keep the current key") : tk.shapeHint}
                className="min-w-[240px] flex-1 rounded border border-border bg-background px-2 py-1 text-[11px]"
              />
              <input
                type="date"
                value={expiryDraft[tk.service] ?? ""}
                onChange={(e) => setExpiryDraft((p) => ({ ...p, [tk.service]: e.target.value }))}
                title={t("到期日（留空 = 从密钥本身读取，读不到就显示“到期日未知”）", "Expiry date (blank = read from the key itself)")}
                className="rounded border border-border bg-background px-2 py-1 text-[11px]"
              />
              <Button size="sm" variant="outline" onClick={() => void testDraft(tk.service)} disabled={busy === tk.service || !(draft[tk.service] ?? "").trim()}>
                {t("先测一下", "Test")}
              </Button>
              <Button size="sm" onClick={() => void save(tk.service)} disabled={busy === tk.service}>
                {busy === tk.service ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
                {t("保存", "Save")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void verify(tk.service)} disabled={busy === tk.service || !tk.configured}>
                <ShieldCheck className="mr-1 h-3.5 w-3.5" /> {t("校验", "Verify")}
              </Button>
              {tk.source === "db" ? (
                <Button size="sm" variant="ghost" onClick={() => void clear(tk.service)} title={t("清除后回退到 .env", "Fall back to .env")}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>

            {v ? (
              <p className={`mt-1.5 text-[11px] ${v.ok ? "text-green-600" : "text-amber-600"}`}>{v.msg}</p>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
              <a href={tk.applyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline">
                {t("去签发 / 续期", "Get or renew this key")} <ExternalLink className="h-3 w-3" />
              </a>
              <span>{t("密钥形态：", "Format: ")}{tk.shapeHint}</span>
              {tk.note ? <span>{t("备注：", "Note: ")}{tk.note}</span> : null}
            </div>
          </div>
        );
      })}

      {!loading && tokens.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">{t("后端没有注册任何外部服务。", "No external services registered.")}</p>
      ) : null}
    </Card>
  );
}
