// AdminPanel.tsx — 运营管理面板（V389+, 仅 admin 可见）
// 用户列表/用量汇总/审计日志/改用户计划
// V390增强: 用户启禁用/调余额/重置密码 + 用量趋势 + 邮箱/状态展示
import { useEffect, useState, type FC } from "react";
import { Users, BarChart3, ScrollText, ShieldCheck, ShieldOff, Sparkles } from "lucide-react";

interface AdminUser { id: string; username: string; email: string | null; role: string; plan: string; status: string; balance_cents: string; llm_provider: string; created_at: string; total_cost_cents: string; }
interface AuditLog { username: string; method: string; path: string; status_code: number; duration_ms: number; tokens_used: number; ip: string; created_at: string; }
interface UsageDay { day: string; requests: string; tokens: string; cost_cents: string; }

export const AdminPanel: FC = () => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [usage, setUsage] = useState<UsageDay[]>([]);
  const [msg, setMsg] = useState("");
  const [forbidden, setForbidden] = useState(false);
  // 弹窗: 重置密码/调余额
  const [target, setTarget] = useState<AdminUser | null>(null);
  const [modal, setModal] = useState<"balance" | "password" | null>(null);
  const [inputVal, setInputVal] = useState("");
  // V393: 演示模式（沙箱不调 API）
  const [demoOn, setDemoOn] = useState(false);
  const [demoPlaying, setDemoPlaying] = useState(false);

  const playDemo = () => {
    setDemoPlaying(true);
    setDemoOn(true);
    const now = new Date().toISOString();
    setUsers([
      { id: "d1", username: "admin", email: null, role: "admin", plan: "free", status: "active", balance_cents: "0", llm_provider: "platform", created_at: now, total_cost_cents: "0" },
      { id: "d2", username: "张三", email: "zhangsan@example.com", role: "user", plan: "pro", status: "active", balance_cents: "18600", llm_provider: "platform", created_at: now, total_cost_cents: "1280" },
      { id: "d3", username: "李四", email: "lisi@example.com", role: "user", plan: "free", status: "disabled", balance_cents: "500", llm_provider: "byok", created_at: now, total_cost_cents: "0" },
      { id: "d4", username: "王五", email: "wangwu@example.com", role: "user", plan: "enterprise", status: "active", balance_cents: "52000", llm_provider: "platform", created_at: now, total_cost_cents: "8600" },
    ]);
    setLogs([
      { username: "张三", method: "POST", path: "/api/reason/query", status_code: 201, duration_ms: 12400, tokens_used: 11300, ip: "192.168.1.10", created_at: now },
      { username: "张三", method: "GET", path: "/api/billing/balance", status_code: 200, duration_ms: 8, tokens_used: 0, ip: "192.168.1.10", created_at: now },
      { username: "王五", method: "POST", path: "/api/agent/tasks", status_code: 200, duration_ms: 3200, tokens_used: 860, ip: "192.168.1.22", created_at: now },
      { username: "李四", method: "GET", path: "/api/search", status_code: 403, duration_ms: 4, tokens_used: 0, ip: "192.168.1.33", created_at: now },
      { username: "admin", method: "GET", path: "/api/admin/users", status_code: 200, duration_ms: 12, tokens_used: 0, ip: "127.0.0.1", created_at: now },
    ]);
    setUsage([
      { day: "08-02", requests: "85", tokens: "420000", cost_cents: "180" },
      { day: "08-04", requests: "120", tokens: "650000", cost_cents: "260" },
      { day: "08-06", requests: "96", tokens: "510000", cost_cents: "210" },
      { day: "08-08", requests: "150", tokens: "820000", cost_cents: "340" },
      { day: "08-10", requests: "132", tokens: "700000", cost_cents: "290" },
      { day: "08-12", requests: "175", tokens: "910000", cost_cents: "380" },
      { day: "08-14", requests: "198", tokens: "1050000", cost_cents: "430" },
    ]);
    setTimeout(() => setDemoPlaying(false), 1200);
  };

  const token = () => localStorage.getItem("sag_token") || "";

  const load = async () => {
    const h = { Authorization: `Bearer ${token()}` };
    try {
      const u = await (await fetch("/api/admin/users", { headers: h }));
      if (u.status === 403) { setForbidden(true); return; }
      setForbidden(false);
      setUsers((await u.json()).users || []);
      const l = await (await fetch("/api/admin/audit?limit=50", { headers: h })).json();
      setLogs(l.logs || []);
      const us = await (await fetch("/api/admin/usage?days=14", { headers: h })).json();
      setUsage(us.usage || []);
    } catch {}
  };
  useEffect(() => { void load(); }, []);

  const setPlan = async (id: string, plan: string) => {
    const r = await fetch(`/api/admin/user/${id}/plan`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ plan }),
    });
    const d = await r.json();
    setMsg(d.ok ? "已更新" : d.error || "失败");
    void load();
  };
  const setStatus = async (id: string, status: "active" | "disabled") => {
    const r = await fetch(`/api/admin/user/${id}/status`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ status }),
    });
    const d = await r.json();
    setMsg(d.ok ? (status === "disabled" ? "已禁用" : "已启用") : d.error || "失败");
    void load();
  };
  const doAdjust = async () => {
    const delta = Number(inputVal) || 0;
    if (!target || !delta) return;
    const r = await fetch(`/api/admin/user/${target.id}/balance`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ deltaCents: Math.round(delta * 100) }),
    });
    const d = await r.json();
    setMsg(d.ok ? `已调整，余额 ${(d.balanceCents / 100).toFixed(2)} 元` : d.error || "失败");
    setTarget(null); setModal(null); setInputVal("");
    void load();
  };
  const doResetPwd = async () => {
    if (!target) return;
    const r = await fetch(`/api/admin/user/${target.id}/reset-password`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ newPassword: inputVal }),
    });
    const d = await r.json();
    setMsg(d.ok ? "密码已重置" : d.error || "失败");
    setTarget(null); setModal(null); setInputVal("");
  };

  const fmtDate = (s: string) => new Date(s).toLocaleDateString("zh-CN");
  const maxUsage = Math.max(1, ...usage.map((u) => Number(u.requests || 0)));

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="w-full space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">运营管理</h2>
            <span className="text-xs text-muted-foreground">仅管理员可见</span>
          </div>
          <div className="flex items-center gap-1.5">
            {demoOn && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] text-amber-700">演示数据</span>}
            <button type="button" onClick={playDemo} disabled={demoPlaying}
              className="flex items-center gap-1 rounded-md border border-dashed border-primary/40 px-2.5 py-1 text-[11px] text-primary hover:bg-primary/5 disabled:opacity-50"
              title="播放演示：用户列表/审计日志/用量趋势（沙箱 · 不消耗 API）">
              <Sparkles className="h-3 w-3" />
              {demoPlaying ? "演示中…" : "播放演示"}
            </button>
          </div>
        </div>
        {msg && <div className="rounded border border-primary/30 bg-primary/5 px-3 py-2 text-sm">{msg}</div>}
        {forbidden && (
          <div className="rounded-lg border border-red-400/40 bg-red-500/15 px-4 py-6 text-center">
            <div className="text-sm font-medium text-red-500">需要管理员权限</div>
            <div className="mt-1 text-xs text-muted-foreground">运营管理仅管理员账号可查看，请联系管理员。</div>
          </div>
        )}

        {/* 概览统计 */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">注册用户</div>
            <div className="mt-1 text-2xl font-bold text-primary">{users.length}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">免费用户</div>
            <div className="mt-1 text-2xl font-bold">{users.filter((u) => u.plan === "free").length}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">付费用户 (Pro/企业)</div>
            <div className="mt-1 text-2xl font-bold">{users.filter((u) => u.plan !== "free").length}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">平台累计收入</div>
            <div className="mt-1 text-xl font-bold text-emerald-500">¥{users.reduce((a, u) => a + (Number(u.total_cost_cents) || 0), 0) / 100}</div>
          </div>
        </div>

        {/* 用量趋势（近14天） */}
        <div className="rounded-lg border p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium"><BarChart3 className="h-4 w-4" /> 用量趋势（近14天）</div>
            {usage.length === 0 && <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] text-primary">演示数据</span>}
          </div>
          {usage.length === 0 ? (
            <>
              {/* V390: 无真实数据时展示演示数据（有用户请求后自动切换真实数据） */}
              <div className="flex h-32 items-end gap-1">
                {[3, 5, 2, 7, 4, 6, 8, 5, 9, 7, 12, 10, 15, 11].map((v, i) => (
                  <div key={i} className="flex flex-1 flex-col items-center gap-1">
                    <div className="w-full rounded-t bg-primary/60" style={{ height: `${(v / 15) * 96}px` }} />
                    <span className="text-[10px] text-muted-foreground">08-{String(i + 1).padStart(2, "0")}</span>
                  </div>
                ))}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                演示: 用户请求量走势（有 JWT 用户请求后自动切换为真实数据）。用户登录后每次推理/检索会在此记录请求数、token 与成本。
              </div>
            </>
          ) : (
            <>
              <div className="flex h-32 items-end gap-1">
                {usage.slice().reverse().map((u, i) => (
                  <div key={i} className="flex flex-1 flex-col items-center gap-1" title={`${u.day} · ${Number(u.requests)} 请求 · ${(Number(u.cost_cents) / 100).toFixed(2)}元`}>
                    <div className="w-full rounded-t bg-primary/60" style={{ height: `${Math.max(4, (Number(u.requests) / maxUsage) * 96)}px` }} />
                    <span className="text-[10px] text-muted-foreground">{u.day.slice(5)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                <span>总请求: {usage.reduce((a, u) => a + Number(u.requests || 0), 0)}</span>
                <span>总 token: {usage.reduce((a, u) => a + Number(u.tokens || 0), 0).toLocaleString()}</span>
                <span>总成本: {usage.reduce((a, u) => a + Number(u.cost_cents || 0), 0) / 100} 元</span>
              </div>
            </>
          )}
        </div>

        {/* 用户管理 */}
        <div className="rounded-lg border p-4">
          <div className="mb-3 flex items-center gap-2 font-medium"><Users className="h-4 w-4" /> 用户列表</div>
          <div className="space-y-1">
            {users.length === 0 && <div className="text-sm text-muted-foreground">暂无用户</div>}
            {users.map((u) => (
              <div key={u.id} className={`flex flex-wrap items-center gap-2 rounded px-2 py-2 text-sm odd:bg-muted/30 ${u.status === "disabled" ? "opacity-50" : ""}`}>
                <span className="min-w-0 flex-1 truncate">
                  <b>{u.username}</b>
                  {u.status === "disabled" && <span className="ml-2 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-500">已禁用</span>}
                  <span className="ml-2 text-xs text-muted-foreground">[{u.role}] {u.llm_provider === "byok" ? "BYOK" : "平台key"}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{u.email || "无邮箱"}</span>
                  <span className="ml-2 text-xs text-muted-foreground">注册于 {fmtDate(u.created_at)}</span>
                </span>
                <span className="text-xs text-muted-foreground">余额 {(Number(u.balance_cents) / 100).toFixed(2)}元 · 累计 {(Number(u.total_cost_cents) / 100).toFixed(2)}元</span>
                <select value={u.plan} onChange={(e) => void setPlan(u.id, e.target.value)}
                  className="rounded border px-2 py-1 text-xs">
                  <option value="free">free</option><option value="pro">pro</option><option value="enterprise">enterprise</option>
                </select>
                <button type="button" onClick={() => { setTarget(u); setModal("balance"); setInputVal(""); }}
                  className="rounded bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20">调余额</button>
                <button type="button" onClick={() => { setTarget(u); setModal("password"); setInputVal(""); }}
                  className="rounded bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20">重置密码</button>
                {u.status === "disabled" ? (
                  <button type="button" onClick={() => void setStatus(u.id, "active")}
                    className="flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-1 text-xs text-emerald-500 hover:bg-emerald-500/20">
                    <ShieldCheck className="h-3 w-3" /> 启用
                  </button>
                ) : (
                  <button type="button" onClick={() => void setStatus(u.id, "disabled")}
                    className="flex items-center gap-1 rounded bg-red-500/10 px-2 py-1 text-xs text-red-500 hover:bg-red-500/20">
                    <ShieldOff className="h-3 w-3" /> 禁用
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 审计日志 */}
        <div className="rounded-lg border p-4">
          <div className="mb-3 flex items-center gap-2 font-medium"><ScrollText className="h-4 w-4" /> 审计日志（最近50条）</div>
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {logs.length === 0 && <div className="text-sm text-muted-foreground">暂无日志（JWT 用户请求才会记录）</div>}
            {logs.map((l, i) => (
              <div key={i} className="flex items-center gap-2 rounded px-2 py-1 text-xs odd:bg-muted/30">
                <span className="font-mono">{l.username || "-"}</span>
                <span className="rounded bg-muted px-1">{l.method}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{l.path}</span>
                <span className={l.status_code >= 400 ? "text-red-600" : "text-green-600"}>{l.status_code}</span>
                <span className="text-muted-foreground">{l.duration_ms}ms</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 操作弹窗 */}
      {target && modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => { setTarget(null); setModal(null); }}>
          <div className="w-full max-w-sm rounded-xl border bg-background p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 text-sm font-medium">
              {modal === "balance" ? `调整 ${target.username} 的余额（元，正=加负=减）` : `重置 ${target.username} 的密码`}
            </div>
            <input value={inputVal} onChange={(e) => setInputVal(e.target.value)}
              placeholder={modal === "balance" ? "如 50 或 -10" : "新密码（至少6位）"}
              className="w-full rounded-md border px-3 py-2 text-sm" />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => { setTarget(null); setModal(null); }}
                className="rounded-md bg-muted px-4 py-2 text-sm hover:opacity-80">取消</button>
              <button type="button" onClick={() => void (modal === "balance" ? doAdjust() : doResetPwd())}
                className="rounded-md bg-primary px-4 py-2 text-sm text-white hover:opacity-90">确认</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
