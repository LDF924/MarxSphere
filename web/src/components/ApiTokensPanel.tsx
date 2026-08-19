// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ApiTokensPanel.tsx — 对外 API 访问令牌管理 + 配额治理仪表盘（MarxSphere 对外接入）
// 对标 Sciverse 模式: 生成 sag_xxx 令牌 → 交给 Claude Code / Codex / 外部客户端
// 创建时明文只显示一次; 库中只存 hash; 支持权限选择、撤销、配额配置与用量仪表盘
import { useState, useEffect, type FC } from "react";
import { KeyRound, Plus, Copy, Check, Loader2, Trash2, ShieldCheck, Clock, X, Gauge, BarChart3 } from "lucide-react";
import { apiTokens, type ApiTokenRecord, type TokenQuotaStatus, type DailyUsagePoint } from "../lib/api";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { useI18n } from "../i18n";

// V381: 26 个工作台 tab 功能权限
const PERM_LABELS: Record<string, string> = {
  reason: "推理/对话/Ask",
  search: "检索(兼容)",
  ingest: "入库(兼容)",
  chat: "对话",
  ask: "Ask检索",
  literature: "文献库",
  sciverse: "外部检索",
  scenarios: "场景",
  education: "教育",
  empirical: "实证研究",
  truth: "知识页",
  memory: "记忆",
  documents: "PG入库",
  graphiti: "Graphiti入库",
  cognee: "Cognee入库",
  graph: "图谱",
  sources: "数据源",
  policy: "政策库",
  vault: "资料库",
  skills: "技能",
  mcp: "MCP",
  docs: "文档中心",
  jobs: "Jobs",
  tasks: "任务",
  trace: "Trace",
  eval: "评测",
  alerts: "告警",
  inbox: "Inbox",
  p2o: "PDF2Obsidian",  // V395-11: 导航对齐
  agent: "Agent控制台/任务",  // V395-11: 导航对齐
};

// 分组展示(对应顶栏 tab 分组)
const PERM_GROUPS: { group: string; keys: string[] }[] = [
  { group: "核心对话/推理", keys: ["reason", "chat", "ask", "search"] },
  { group: "文献/检索", keys: ["literature", "sciverse", "scenarios", "education", "empirical"] },
  { group: "知识/数据", keys: ["truth", "memory", "documents", "graphiti", "cognee", "graph", "sources"] },
  { group: "政策/资料", keys: ["policy", "vault"] },
  { group: "技能/工具", keys: ["skills", "mcp"] },
  { group: "文档/后台", keys: ["docs", "jobs", "tasks", "trace", "eval", "alerts", "inbox", "ingest"] },
  // V395-11: 导航对齐
  { group: "Agent/PDF", keys: ["agent", "p2o"] },
];

/** 标签页容器（对齐 EducationPanel 的 Tabs 风格） */
function Tabs({ tabs }: { tabs: Array<{ id: string; label: string; content: React.ReactNode }> }) {
  const [active, setActive] = useState(tabs[0]?.id);
  if (!tabs.length) return null;
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1 border-b border-border pb-1.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${active === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div>{tabs.find((t) => t.id === active)?.content}</div>
    </div>
  );
}

/** 进度条（剩余配额占比） */
function QuotaBar({ label, value, max, over, unit }: { label: string; value: number; max: number; over: boolean; unit?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const color = over ? "bg-red-500" : pct > 80 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 truncate text-[10px] text-muted-foreground">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-24 shrink-0 text-right text-[10px] text-muted-foreground">
        {value.toLocaleString()}{max > 0 ? ` / ${max.toLocaleString()}` : "（不限）"}{unit ?? ""}
      </span>
    </div>
  );
}

/** 近 7 天调用曲线（手写 SVG polyline，无第三方库） */
function UsageCurve({ points }: { points: DailyUsagePoint[] }) {
  const W = 260, H = 72, PAD = 4;
  const maxV = Math.max(1, ...points.map((p) => Math.max(p.searches, p.ingestBytes)));
  const x = (i: number) => PAD + (i / Math.max(1, points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - (v / maxV) * (H - PAD * 2);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.searches).toFixed(1)}`).join(" ");
  const ingestLine = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.ingestBytes).toFixed(1)}`).join(" ");
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--border)" strokeWidth="1" />
        <polyline points={line} fill="none" stroke="var(--primary)" strokeWidth="1.5" />
        <polyline points={ingestLine} fill="none" stroke="var(--amber-500, #f59e0b)" strokeWidth="1.5" strokeDasharray="3 2" />
        {points.map((p, i) => (
          <text key={p.date} x={x(i)} y={H - 2} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 8 }}>
            {p.date.slice(5)}
          </text>
        ))}
      </svg>
      <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-3 bg-primary" /> 搜索</span>
        <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-3 bg-amber-500" /> 入库MB</span>
      </div>
    </div>
  );
}

/** 配额表单（Tab2） */
function QuotaEditor({ token }: { token: ApiTokenRecord }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<TokenQuotaStatus | null>(null);
  const [usage, setUsage] = useState<DailyUsagePoint[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({ dailySearchLimit: "", dailyIngestBytesLimit: "", monthlyCostLimitUsd: "", rateLimitPerMin: "", dailyP2oLimit: "" });

  const load = () => {
    void apiTokens.quota.get(token.id).then((r) => {
      setStatus(r.status);
      setForm({
        dailySearchLimit: String(r.status.dailySearchLimit),
        dailyIngestBytesLimit: String(r.status.dailyIngestBytesLimit),
        monthlyCostLimitUsd: String(r.status.monthlyCostLimitUsd),
        rateLimitPerMin: String(r.status.rateLimitPerMin),
        dailyP2oLimit: String((r.status as any).dailyP2oLimit ?? 20),  // V395-11
      });
    }).catch(() => {});
    void apiTokens.quota.usage(token.id, 7).then((r) => setUsage(r.days)).catch(() => {});
  };
  useEffect(() => { load(); }, [token.id]);

  const save = async () => {
    setBusy(true);
    try {
      await apiTokens.quota.update(token.id, {
        dailySearchLimit: parseInt(form.dailySearchLimit, 10) || 0,
        dailyIngestBytesLimit: parseInt(form.dailyIngestBytesLimit, 10) || 0,
        monthlyCostLimitUsd: parseFloat(form.monthlyCostLimitUsd) || 0,
        rateLimitPerMin: parseInt(form.rateLimitPerMin, 10) || 0,
        dailyP2oLimit: parseInt(form.dailyP2oLimit, 10) || 0,  // V395-11
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      load();
    } catch { /* 保持表单 */ }
    setBusy(false);
  };

  const numInput = (key: keyof typeof form, label: string, hint: string) => (
    <label className="block">
      <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{label}</span>
      <input
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        placeholder={hint}
        className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
      />
    </label>
  );

  return (
    <div className="space-y-3">
      <div className="rise-stagger grid grid-cols-2 gap-2">
        {numInput("dailySearchLimit", t("每日搜索上限", "Daily search limit"), "如 1000（0=不限）")}
        {numInput("dailyIngestBytesLimit", t("每日入库上限(MB)", "Daily ingest MB"), "如 100（0=不限）")}
        {numInput("monthlyCostLimitUsd", t("每月成本上限($)", "Monthly cost limit"), "如 10（0=不限）")}
        {numInput("rateLimitPerMin", t("每分钟限流", "Rate per min"), "如 60（0=默认）")}
        {numInput("dailyP2oLimit", t("每日PDF导入上限", "Daily PDF imports"), "如 20（0=不限）")}  {/* V395-11 */}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void save()} disabled={busy}>
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1 h-3.5 w-3.5" />}
          {saved ? t("已保存", "Saved") : t("保存配额", "Save quota")}
        </Button>
        <span className="text-[10px] text-muted-foreground">{t("0 = 不限制", "0 = unlimited")}</span>
      </div>

      {status && (
        <div className="space-y-1.5 rounded-lg border p-2.5">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold">
            <Gauge className="h-3.5 w-3.5 text-violet-500" /> {t("用量状态", "Usage")}
            <span className="ml-auto text-[10px] font-normal text-muted-foreground">
              {t("本月成本", "Cost this month")}: <span className="font-mono font-medium">${typeof status.costThisMonth === "number" ? status.costThisMonth.toFixed(4) : "0.0000"}</span>
              {status.monthlyCostLimitUsd > 0 && <span className="font-mono"> / ${status.monthlyCostLimitUsd}</span>}
            </span>
          </div>
          <QuotaBar label={t("今日搜索", "Searches today")} value={status.searchesToday} max={status.dailySearchLimit} over={status.overSearchQuota} />
          <QuotaBar label={t("今日入库", "Ingest today")} value={Math.round(status.ingestBytesToday / 1048576)} max={Math.round(status.dailyIngestBytesLimit / 1048576)} over={status.overIngestQuota} unit="MB" />
          <QuotaBar label={t("今日PDF导入", "PDF imports today")} value={(status as any).p2oTasksToday ?? 0} max={(status as any).dailyP2oLimit ?? 0} over={(status as any).overP2oQuota} />  {/* V395-11 */}
          <QuotaBar label={t("本月成本", "Cost month")} value={status.costThisMonth} max={status.monthlyCostLimitUsd} over={status.overCostQuota} unit="$" />
          {status.retryAfterSec > 0 && (
            <div className="rounded bg-red-50 px-2 py-1 text-[10px] text-red-700">
              {t("配额已用完，约", "Quota exhausted, retry in about")} {Math.ceil(status.retryAfterSec / 60)}{t("分钟后重置", "min")}
            </div>
          )}
        </div>
      )}

      <div className="rounded-lg border p-2.5">
        <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold">
          <BarChart3 className="h-3.5 w-3.5 text-violet-500" /> {t("近7天调用", "Last 7 days")}
        </div>
        <UsageCurve points={usage} />
      </div>
    </div>
  );
}

export function ApiTokensPanel() {
  const { t } = useI18n();
  const [tokens, setTokens] = useState<ApiTokenRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<string[]>(["reason"]);
  // 创建时可选的配额配置 (留空 = 服务端默认)
  const [createQuota, setCreateQuota] = useState({ dailySearchLimit: "", dailyIngestBytesLimit: "", monthlyCostLimitUsd: "", rateLimitPerMin: "" });
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    void apiTokens.list().then(setTokens).catch(() => setTokens([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    setBusy(true);
    try {
      const quota = {
        dailySearchLimit: parseInt(createQuota.dailySearchLimit, 10) || 0,
        dailyIngestBytesLimit: parseInt(createQuota.dailyIngestBytesLimit, 10) || 0,
        monthlyCostLimitUsd: parseFloat(createQuota.monthlyCostLimitUsd) || 0,
        rateLimitPerMin: parseInt(createQuota.rateLimitPerMin, 10) || 0,
      };
      // 全部留空 → 不传 quota (服务端默认)
      const hasQuota = Object.values(quota).some((v) => v > 0);
      const r = await apiTokens.create(name.trim() || t("未命名令牌", "Untitled token"), perms, hasQuota ? quota : undefined);
      setCreatedToken(r.token);
      setShowCreate(false);
      setName("");
      setCreateQuota({ dailySearchLimit: "", dailyIngestBytesLimit: "", monthlyCostLimitUsd: "", rateLimitPerMin: "" });
      load();
    } catch { /* 失败保持表单 */ }
    setBusy(false);
  };

  const copyToken = async () => {
    if (!createdToken) return;
    try { await navigator.clipboard.writeText(createdToken); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* 剪贴板不可用忽略 */ }
  };

  const revoke = async (id: string) => {
    if (!window.confirm(t("确定撤销该令牌？撤销后立即失效，不可恢复。", "Revoke this token? It takes effect immediately and cannot be recovered."))) return;
    await apiTokens.revoke(id).catch(() => {});
    load();
  };

  const remove = async (id: string) => {
    if (!window.confirm(t("确定删除该令牌记录？", "Delete this token record?"))) return;
    await apiTokens.remove(id).catch(() => {});
    load();
  };

  const selected = tokens.find((x) => x.id === selectedId) ?? tokens[0] ?? null;

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-violet-500" />
          <h3 className="text-sm font-semibold">{t("对外 API 令牌", "API Tokens")}</h3>
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowCreate((v) => !v)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> {t("新建令牌", "New token")}
        </Button>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        {t(
          "生成 sag_xxx 令牌后，可配置到 Claude Code（.mcp.json）/ Codex（config.toml）调用 MarxSphere 推理与检索能力。令牌明文仅创建时显示一次，服务端只存哈希。配额按令牌独立治理（每日搜索/入库/月成本），本机操作豁免。",
          "Generate sag_xxx tokens for Claude Code (.mcp.json) / Codex (config.toml) to call MarxSphere. Plaintext shown once, server stores hash only. Quotas (daily search/ingest/monthly cost) are per-token; local requests are exempt."
        )}
      </p>

      {showCreate && (
        <div className="mb-3 rounded-lg border p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium">{t("新建令牌", "New token")}</span>
            <button onClick={() => setShowCreate(false)} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("令牌名称（如 claude-code-prod）", "Token name (e.g. claude-code-prod)")}
            className="mb-2 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          />
          <div className="mb-2 max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
            {PERM_GROUPS.map((g) => (
              <div key={g.group}>
                <div className="mb-0.5 text-[10px] font-semibold text-muted-foreground">{g.group}</div>
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                  {g.keys.map((key) => (
                    <label key={key} className="flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] hover:bg-accent">
                      <input
                        type="checkbox"
                        checked={perms.includes(key)}
                        onChange={(e) => {
                          const next = e.target.checked ? [...perms, key] : perms.filter((p) => p !== key);
                          setPerms(next.length ? next : ["reason"]);
                        }}
                      />
                      {PERM_LABELS[key] ?? key}
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <div className="text-[9px] text-muted-foreground">勾选的功能, 外部令牌可调用; 未勾选 → 403 拒绝。本机访问不受限。</div>
          </div>
          <div className="mb-2 grid grid-cols-4 gap-2">
            {([
              ["dailySearchLimit", t("每日搜索", "Search/day"), "如1000"],
              ["dailyIngestBytesLimit", t("每日入库MB", "Ingest MB/day"), "如100"],
              ["monthlyCostLimitUsd", t("月成本$", "Cost/month"), "如10"],
              ["rateLimitPerMin", t("限流/分", "Rate/min"), "如60"],
            ] as const).map(([key, label, hint]) => (
              <label key={key} className="block">
                <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{label}</span>
                <input
                  value={createQuota[key]}
                  onChange={(e) => setCreateQuota((f) => ({ ...f, [key]: e.target.value }))}
                  placeholder={hint}
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                />
              </label>
            ))}
          </div>
          <div className="mb-2 text-[10px] text-muted-foreground">{t("配额留空 = 服务端默认（宽松）", "Leave quota blank for server defaults")}</div>
          <Button size="sm" disabled={busy} onClick={() => void create()}>
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1 h-3.5 w-3.5" />}
            {t("生成", "Generate")}
          </Button>
        </div>
      )}

      {createdToken && (
        <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <div className="mb-1 text-xs font-semibold text-amber-600">{t("令牌已生成（仅显示一次，请立即保存）", "Token generated (shown once, save now)")}</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-amber-500/15 px-2 py-1 font-mono text-xs text-amber-600">{createdToken}</code>
            <Button size="sm" variant="outline" onClick={() => void copyToken()}>
              {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreatedToken(null)}><X className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("加载中...", "Loading...")}</div>
      ) : tokens.length === 0 ? (
        <div className="py-4 text-center text-xs text-muted-foreground">{t("暂无令牌。创建后即可接入 Claude Code / Codex。", "No tokens yet. Create one to integrate with Claude Code / Codex.")}</div>
      ) : (
        <Tabs
          tabs={[
            {
              id: "list",
              label: t("令牌列表", "Tokens"),
              content: (
                <div className="space-y-2">
                  {tokens.map((tkn) => {
                    const qs = tkn.quotaStatus;
                    const over = qs?.overSearchQuota || qs?.overCostQuota;
                    return (
                      <div
                        key={tkn.id}
                        className={`flex items-center justify-between rounded-lg border p-2.5 text-sm ${tkn.revoked ? "opacity-50" : ""} ${selectedId === tkn.id ? "border-violet-400/60 bg-violet-500/5" : ""}`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{tkn.name}</span>
                            {tkn.revoked && <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700">{t("已撤销", "Revoked")}</span>}
                            {over && !tkn.revoked && <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700">{t("配额超限", "Quota exceeded")}</span>}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 font-mono text-xs text-muted-foreground">
                            {tkn.prefix}
                            <span className="flex gap-1">
                              {tkn.permissions.map((p) => (
                                <span key={p} className="rounded bg-muted px-1 py-0.5 text-[10px]">{PERM_LABELS[p] ?? p}</span>
                              ))}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                            <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{new Date(tkn.created_at).toLocaleString()}</span>
                            {qs && (
                              <span className="flex gap-2">
                                <span className={qs.overSearchQuota ? "text-red-600" : ""}>{t("今日", "today")} {qs.searchesToday}/{qs.dailySearchLimit || "∞"}</span>
                                <span className={qs.overCostQuota ? "text-red-600" : ""}>${qs.costThisMonth.toFixed(4)}{qs.monthlyCostLimitUsd > 0 ? `/${qs.monthlyCostLimitUsd}` : ""}</span>
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button size="sm" variant="ghost" className={selectedId === tkn.id ? "text-violet-600" : "text-muted-foreground"} onClick={() => setSelectedId(tkn.id === selectedId ? null : tkn.id)}>
                            <Gauge className="h-3.5 w-3.5" />
                          </Button>
                          {!tkn.revoked && (
                            <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => void revoke(tkn.id)}>{t("撤销", "Revoke")}</Button>
                          )}
                          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => void remove(tkn.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ),
            },
            {
              id: "quota",
              label: t("配额与用量", "Quota & usage"),
              content: selected ? (
                <QuotaEditor token={selected} />
              ) : (
                <div className="py-4 text-center text-xs text-muted-foreground">{t("请选择令牌", "Select a token")}</div>
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}
