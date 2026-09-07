// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// BillingPanel.tsx — 商业化计费面板（V389+）
// 余额/充值/订阅计划/账单/用量（JWT 认证）
// V390 UI修复: 输入框深色背景(原白底白字看不清) + 错误提示醒目 + 账单滚动可删 + 用量空态demo
import { useEffect, useState, type FC } from "react";
// SocialSci P0-8: 积分卡图标
import { Coffee, Coins, Gift, Loader2, RefreshCw, Wallet, CreditCard, History, Gauge, KeyRound, Building2, UserPlus, Trash2, Sparkles } from "lucide-react";
import { cn } from "../lib/utils";

interface Balance {
  balanceCents: number; plan: string; quotaTokens: number; usedTokens: number; remaining: number;
}
interface BillRecord { id?: string; type: string; amount_cents: string; tokens_used: string | null; description: string; created_at: string; }
interface Usage { endpoint: string; tin: string; tout: string; cost: string; day: string; }
interface LlmConfig { provider: "platform" | "byok"; hasKey: boolean; }

const PLANS = [
  { id: "free", name: "免费版", price: "0 元", quota: "5万 token/月" },
  { id: "pro", name: "Pro", price: "39 元/月", quota: "200万 token/月" },
  { id: "enterprise", name: "企业版", price: "199 元/月", quota: "2000万 token/月" },
];

// V390: 深色输入框（原默认白底+浅字看不清）
const inputCls = "w-full rounded-md border border-white/10 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-primary/50 focus:outline-none";

export const BillingPanel: FC = () => {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [records, setRecords] = useState<BillRecord[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [rechargeAmt, setRechargeAmt] = useState(100);
  const [msg, setMsg] = useState<{ text: string; type: "ok" | "err" } | null>(null);
  const [llmCfg, setLlmCfg] = useState<LlmConfig>({ provider: "platform", hasKey: false });
  const [byokKey, setByokKey] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [inviteUser, setInviteUser] = useState("");
  const [members, setMembers] = useState<any[]>([]);
  const [pendingInvites, setPendingInvites] = useState<any[]>([]);
  // V393: 演示模式（沙箱不调 API）
  const [demoOn, setDemoOn] = useState(false);
  const [demoPlaying, setDemoPlaying] = useState(false);

  const playDemo = () => {
    setDemoPlaying(true);
    setDemoOn(true);
    setBalance({ balanceCents: 23500, plan: "pro", quotaTokens: 2000000, usedTokens: 385600, remaining: 1614400 });
    setRecords([
      { id: "d1", type: "subscription", amount_cents: "-3900", tokens_used: null, description: "订阅 pro 月费", created_at: new Date().toISOString() },
      { id: "d2", type: "recharge", amount_cents: "-20000", tokens_used: null, description: "充值 200.00 元", created_at: new Date().toISOString() },
      { id: "d3", type: "usage", amount_cents: "86", tokens_used: "21500", description: "LLM超额扣费(deepseek-v4-flash) 21500 tokens", created_at: new Date().toISOString() },
      { id: "d4", type: "usage", amount_cents: "42", tokens_used: "10500", description: "LLM超额扣费(deepseek-v4-flash) 10500 tokens", created_at: new Date().toISOString() },
    ]);
    setUsage([
      { endpoint: "/api/reason/query", tin: "8200", tout: "3100", cost: "42", day: "08-15" },
      { endpoint: "/api/search", tin: "5600", tout: "1800", cost: "28", day: "08-15" },
      { endpoint: "/api/reason/query", tin: "7400", tout: "2900", cost: "38", day: "08-14" },
      { endpoint: "/api/scenarios", tin: "4300", tout: "1500", cost: "21", day: "08-13" },
    ]);
    setTimeout(() => setDemoPlaying(false), 1200);
  };

  const token = () => localStorage.getItem("sag_token") || "";

  const load = async () => {
    const h = { Authorization: `Bearer ${token()}` };
    try {
      const b = await (await fetch("/api/billing/balance", { headers: h })).json();
      setBalance(b);
      const r = await (await fetch("/api/billing/records", { headers: h })).json();
      setRecords(r.records || []);
      const u = await (await fetch("/api/billing/usage", { headers: h })).json();
      setUsage(u.usage || []);
      const c = await (await fetch("/api/user/llm-config", { headers: h })).json();
      setLlmCfg(c);
      const m = await (await fetch("/api/enterprise/members", { headers: h })).json();
      setMembers(m.members || []);
      const i = await (await fetch("/api/enterprise/invites", { headers: h })).json();
      setPendingInvites(i.invites || []);
    } catch {}
  };
  useEffect(() => { void load(); }, []);

  const doRecharge = async () => {
    const r = await fetch("/api/billing/recharge", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ amountCents: rechargeAmt * 100 }),
    });
    const d = await r.json();
    if (d.ok) setMsg({ text: `充值成功，余额 ${(d.balanceCents / 100).toFixed(2)} 元`, type: "ok" });
    else setMsg({ text: "充值失败", type: "err" });
    void load();
  };
  const doSubscribe = async (plan: string) => {
    const r = await fetch("/api/billing/subscribe", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ plan }),
    });
    const d = await r.json();
    if (d.ok) setMsg({ text: `已升级 ${plan}`, type: "ok" });
    else setMsg({ text: d.error || "订阅失败", type: "err" });  // V390: 余额不足等错误醒目提示
    void load();
  };

  const doSetLlm = async (provider: "platform" | "byok") => {
    if (provider === "byok" && !byokKey.trim()) {
      setMsg({ text: "请先输入你的 API Key 再切换", type: "err" });  // V390: 缺key提示
      return;
    }
    const r = await fetch("/api/user/llm-config", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ provider, apiKey: byokKey }),
    });
    const d = await r.json();
    if (d.ok) setMsg({ text: `已切换为 ${provider === "byok" ? "自带 Key" : "平台 Key"}`, type: "ok" });
    else setMsg({ text: d.error || "设置失败", type: "err" });
    setByokKey("");
    void load();
  };

  const doRegisterEnterprise = async () => {
    const r = await fetch("/api/enterprise/register", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ companyName }),
    });
    const d = await r.json();
    if (d.ok) setMsg({ text: "企业注册成功", type: "ok" });
    else setMsg({ text: d.error || "失败", type: "err" });
    void load();
  };
  const doInvite = async () => {
    const r = await fetch("/api/enterprise/invite", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ username: inviteUser }),
    });
    const d = await r.json();
    if (d.ok) setMsg({ text: `已邀请 ${inviteUser}`, type: "ok" });
    else setMsg({ text: d.error || "失败", type: "err" });
    setInviteUser("");
    void load();
  };
  const doAcceptInvite = async (id: string) => {
    const r = await fetch(`/api/enterprise/invite/${id}/accept`, {
      method: "POST", headers: { Authorization: `Bearer ${token()}` },
    });
    const d = await r.json();
    if (d.ok) setMsg({ text: "已加入企业", type: "ok" });
    else setMsg({ text: d.error || "失败", type: "err" });
    void load();
  };

  // V390: 删除账单记录（仅充值/调整类可删, 用量扣费记录保留追溯）
  const doDeleteRecord = async (id: string) => {
    const r = await fetch(`/api/billing/records/${id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${token()}` },
    });
    const d = await r.json();
    if (d.ok) setMsg({ text: "已删除", type: "ok" });
    else setMsg({ text: d.error || "删除失败", type: "err" });
    void load();
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="w-full space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">账户与计费</h2>
            <span className="text-xs text-muted-foreground">订阅 + 按量 · 余额扣费</span>
          </div>
          <div className="flex items-center gap-1.5">
            {demoOn && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] text-amber-700">演示数据</span>}
            <button type="button" onClick={playDemo} disabled={demoPlaying}
              className="flex items-center gap-1 rounded-md border border-dashed border-primary/40 px-2.5 py-1 text-[11px] text-primary hover:bg-primary/5 disabled:opacity-50"
              title="播放演示：余额/账单/用量（沙箱 · 不消耗 API）">
              <Sparkles className="h-3 w-3" />
              {demoPlaying ? "演示中…" : "播放演示"}
            </button>
          </div>
        </div>

        {/* 余额卡片 */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">账户余额</div>
            <div className="mt-1 text-xl font-bold text-primary">{((balance?.balanceCents ?? 0) / 100).toFixed(2)} 元</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">当前计划</div>
            <div className="mt-1 text-xl font-bold">{balance?.plan || "free"}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">本月额度</div>
            <div className="mt-1 text-xl font-bold">{(balance?.quotaTokens ?? 0) / 10000}万</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">已用 / 剩余</div>
            <div className="mt-1 text-sm font-bold">{(balance?.usedTokens ?? 0) / 10000}万 / {(balance?.remaining ?? 0) / 10000}万</div>
          </div>
        </div>

        {msg && (
          <div className={cn("rounded border px-3 py-2 text-sm", msg.type === "ok" ? "border-primary/30 bg-primary/5" : "border-red-500/40 bg-red-500/10 text-red-400")}>
            {msg.text}
          </div>
        )}

        {/* 充值 */}
        <div className="rounded-lg border p-4">
          <div className="mb-3 flex items-center gap-2 font-medium"><CreditCard className="h-4 w-4" /> 充值</div>
          <div className="flex items-center gap-2">
            <input type="number" value={rechargeAmt} min={1} onChange={(e) => setRechargeAmt(Number(e.target.value))}
              className={cn(inputCls, "w-32")} />
            <span className="text-sm text-muted-foreground">元</span>
            <button type="button" onClick={() => void doRecharge()}
              className="rounded-md bg-primary px-4 py-2 text-sm text-white hover:opacity-90">立即充值</button>
          </div>
          <div className="mt-2 text-xs text-muted-foreground">注: 当前为手动模拟充值（支付渠道接入后自动入账）</div>
        </div>

        {/* 订阅计划 */}
        <div className="rounded-lg border p-4">
          <div className="mb-3 font-medium">订阅计划</div>
          <div className="grid gap-3 md:grid-cols-3">
            {PLANS.map((p) => (
              <div key={p.id} className={cn("rounded-lg border p-4", balance?.plan === p.id && "border-primary ring-1 ring-primary/30")}>
                <div className="font-medium">{p.name}</div>
                <div className="mt-1 text-lg font-bold">{p.price}</div>
                <div className="mt-1 text-xs text-muted-foreground">{p.quota}</div>
                <button type="button" disabled={balance?.plan === p.id} onClick={() => void doSubscribe(p.id)}
                  className="mt-3 w-full rounded-md bg-primary/10 py-1.5 text-sm text-primary hover:bg-primary/20 disabled:opacity-40">
                  {balance?.plan === p.id ? "当前计划" : "升级"}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* LLM Key 配置（BYOK） */}
        <div className="rounded-lg border p-4">
          <div className="mb-3 flex items-center gap-2 font-medium"><KeyRound className="h-4 w-4" /> LLM Key 配置</div>
          <div className="text-xs text-muted-foreground mb-2">
            当前: {llmCfg.provider === "byok" ? `自带 Key（${llmCfg.hasKey ? "已配置" : "未配置"}）· LLM 费用由你自付` : "平台 Key（平台代付，按订阅/余额计费）"}
          </div>
          {llmCfg.provider === "byok" && (
            <input type="password" value={byokKey} onChange={(e) => setByokKey(e.target.value)} placeholder="输入你的 DeepSeek/MAAS API Key"
              className={cn(inputCls, "mb-2")} />
          )}
          <div className="flex gap-2">
            {llmCfg.provider !== "byok" && (
              <button type="button" onClick={() => void doSetLlm("byok")}
                className="rounded-md bg-primary/10 px-4 py-2 text-sm text-primary hover:bg-primary/20">切换为自带 Key</button>
            )}
            {llmCfg.provider === "byok" && (
              <>
                <button type="button" disabled={!byokKey} onClick={() => void doSetLlm("byok")}
                  className="rounded-md bg-primary px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40">保存 Key</button>
                <button type="button" onClick={() => void doSetLlm("platform")}
                  className="rounded-md bg-muted px-4 py-2 text-sm hover:opacity-80">切回平台 Key</button>
              </>
            )}
          </div>
          {llmCfg.provider !== "byok" && <div className="mt-2 text-xs text-muted-foreground">切换后需输入自己的 API Key（DeepSeek/MAAS），LLM 费用由你直接支付</div>}
        </div>

        {/* 企业团队 */}
        <div className="rounded-lg border p-4">
          <div className="mb-3 flex items-center gap-2 font-medium"><Building2 className="h-4 w-4" /> 企业团队</div>
          {members.length === 0 ? (
            <>
              <div className="text-xs text-muted-foreground mb-2">当前为个人账户。注册企业后可邀请成员共享租户资源。</div>
              <div className="flex items-center gap-2">
                <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="企业名称"
                  className={cn(inputCls, "flex-1")} />
                <button type="button" onClick={() => void doRegisterEnterprise()}
                  className="rounded-md bg-primary px-4 py-2 text-sm text-white hover:opacity-90">注册企业</button>
              </div>
            </>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <UserPlus className="h-3 w-3" /> 邀请成员（需对方已注册）
              </div>
              <div className="mb-3 flex items-center gap-2">
                <input value={inviteUser} onChange={(e) => setInviteUser(e.target.value)} placeholder="用户名"
                  className={cn(inputCls, "flex-1")} />
                <button type="button" disabled={!inviteUser} onClick={() => void doInvite()}
                  className="rounded-md bg-primary/10 px-4 py-2 text-sm text-primary hover:bg-primary/20 disabled:opacity-40">邀请</button>
              </div>
              <div className="space-y-1">
                {members.map((m, i) => (
                  <div key={i} className="flex items-center justify-between rounded px-2 py-1 text-sm odd:bg-muted/30">
                    <span>{m.username}</span>
                    <span className="text-xs text-muted-foreground">{m.member_role}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {pendingInvites.length > 0 && (
            <div className="mt-3 border-t pt-2">
              <div className="mb-1 text-xs text-muted-foreground">待接受的企业邀请：</div>
              {pendingInvites.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between rounded px-2 py-1 text-sm odd:bg-muted/30">
                  <span>{inv.company}</span>
                  <button type="button" onClick={() => void doAcceptInvite(inv.id)}
                    className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary hover:bg-primary/20">接受</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 账单 */}
        <div className="rounded-lg border p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium"><History className="h-4 w-4" /> 账单记录</div>
            <span className="text-xs text-muted-foreground">可滚动 · 充值/调整记录可删除（扣费记录保留追溯）</span>
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {records.length === 0 && <div className="text-sm text-muted-foreground">暂无记录</div>}
            {records.map((r, i) => (
              <div key={r.id || i} className="flex items-center justify-between rounded px-2 py-1 text-sm odd:bg-muted/30">
                <span className="min-w-0 flex-1 truncate">{r.description}</span>
                <span className={cn("font-mono", Number(r.amount_cents) > 0 ? "text-red-600" : "text-green-600")}>
                  {Number(r.amount_cents) > 0 ? "-" : "+"}{(Math.abs(Number(r.amount_cents)) / 100).toFixed(2)}元
                </span>
                {r.id && r.type !== "usage" && (
                  <button type="button" onClick={() => void doDeleteRecord(r.id!)} title="删除该记录"
                    className="ml-2 rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-500">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 用量 */}
        <div className="rounded-lg border p-4">
          <div className="mb-3 flex items-center gap-2 font-medium"><Gauge className="h-4 w-4" /> 用量明细（近7天）</div>
          {usage.length === 0 ? (
            <div className="rounded-md border border-dashed border-white/10 bg-muted/20 px-4 py-6 text-center">
              <div className="text-sm text-muted-foreground">暂无用量数据</div>
              <div className="mt-1 text-xs text-muted-foreground/70">每次推理/检索会按模型单价记录 token 用量与费用，之后会显示在这里</div>
            </div>
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
              {usage.map((u, i) => (
                <div key={i} className="flex items-center justify-between rounded px-2 py-1 text-xs odd:bg-muted/30">
                  <span className="font-mono">{u.day} · {u.endpoint}</span>
                  <span>{Number(u.tin) + Number(u.tout)} tokens · {(Number(u.cost) / 100).toFixed(3)}元</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* SocialSci P0-8: 积分卡(签到/兑换/流水/冻结 — 与余额解耦, 计 feature 级消费) */}
      <PointsCard />
    </section>
  );
};

/** 积分卡(签到 +20/兑换码/流水) */
function PointsCard() {
  const [data, setData] = useState<{ balance: number; frozen: number; signedToday: boolean; rewardPoints: number; todayCheckin: { streak: number } | null; dailyUsage: Array<{ kind: string; count: number; cost: number }>; ledger: Array<{ type: string; amount: number; freeze_amount: number; settle_amount: number; ref_type: string; note: string; created_at: string }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [redeemInput, setRedeemInput] = useState("");

  const load = async () => {
    try {
      const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
      const r = await fetch("/api/points/me", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const d = await r.json();
      if (d.success) setData(d.data);
    } catch { /* 接口未就绪静默 */ }
  };
  useEffect(() => { void load(); }, []);

  const doCheckin = async () => {
    setBusy(true); setErr("");
    try {
      const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
      const r = await fetch("/api/points/checkin", { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: "{}" });
      const d = await r.json();
      if (d.success) { await load(); }
      else setErr(d.error || "签到失败");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const doRedeem = async () => {
    if (!redeemInput.trim()) return;
    setBusy(true); setErr("");
    try {
      const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
      const r = await fetch("/api/points/redeem", { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ code: redeemInput.trim() }) });
      const d = await r.json();
      if (d.success) { setRedeemInput(""); await load(); }
      else setErr(d.error || "兑换失败");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const typeCn: Record<string, string> = {
    checkin: "text-amber-300", grant: "text-green-300", admin_adjust: "text-green-300",
    redeem: "text-cyan-300", freeze: "text-slate-400", settle: "text-rose-300",
    refund: "text-emerald-300", invite_bonus: "text-purple-300",
  };

  return (
    <div className="rounded-lg border border-white/10 bg-muted/10 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <Coins className="h-4 w-4 text-amber-400" /> 积分
        </span>
        <button onClick={load} className="text-xs text-muted-foreground hover:text-foreground"><RefreshCw className="h-3.5 w-3.5" /></button>
      </div>
      {err && <p className="mb-1.5 text-xs text-red-400">{err}</p>}

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md bg-muted/20 p-2">
          <p className="text-lg font-bold text-amber-300">{data?.balance ?? "—"}</p>
          <p className="text-[10px] text-muted-foreground">可用积分</p>
        </div>
        <div className="rounded-md bg-muted/20 p-2">
          <p className="text-lg font-bold text-slate-300">{data?.frozen ?? 0}</p>
          <p className="text-[10px] text-muted-foreground">冻结中</p>
        </div>
        <div className="rounded-md bg-muted/20 p-2">
          <p className="text-lg font-bold text-cyan-300">{data?.todayCheckin?.streak ? `${data.todayCheckin.streak} 天` : "—"}</p>
          <p className="text-[10px] text-muted-foreground">连签</p>
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        {!data?.signedToday ? (
          <button onClick={doCheckin} disabled={busy}
            className="flex items-center gap-1 rounded-lg bg-amber-500/20 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/30 disabled:opacity-50">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Coffee className="h-3 w-3" />} 每日签到 +{data?.rewardPoints ?? 20}
          </button>
        ) : (
          <span className="flex items-center gap-1 rounded-lg bg-green-500/15 px-3 py-1.5 text-xs text-green-300"><Gift className="h-3 w-3" /> 今日已签到</span>
        )}
        <div className="ml-auto flex flex-1 items-center gap-1.5">
          <input value={redeemInput} onChange={(e) => setRedeemInput(e.target.value)} placeholder="兑换码"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-muted/30 px-2 py-1.5 text-xs placeholder:text-muted-foreground" />
          <button onClick={doRedeem} disabled={busy || !redeemInput.trim()}
            className="rounded-md bg-cyan-500/20 px-2.5 py-1.5 text-xs text-cyan-300 hover:bg-cyan-500/30 disabled:opacity-50">兑换</button>
        </div>
      </div>

      {data?.dailyUsage && data.dailyUsage.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {data.dailyUsage.map((u) => (
            <span key={u.kind} className="rounded bg-muted/20 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {u.kind}: {u.count}次/{u.cost}分
            </span>
          ))}
        </div>
      )}

      {data?.ledger && data.ledger.length > 0 && (
        <div className="mt-2 max-h-36 space-y-0.5 overflow-y-auto pr-1">
          {data.ledger.slice(0, 20).map((l, i) => (
            <div key={i} className="flex items-center justify-between rounded px-2 py-0.5 text-[11px] odd:bg-muted/20">
              <span className={typeCn[l.type] ?? "text-muted-foreground"}>{l.note || l.type}</span>
              <span className="font-mono">{l.amount > 0 ? `+${l.amount}` : l.amount}分</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
