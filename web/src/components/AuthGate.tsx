// AuthGate.tsx — 商业化登录门（V389+）
// 可选启用: 后端 AUTH_ENABLED=true 时前端要求登录（JWT 存 localStorage）
// 关闭时直接放行（兼容本地单机使用）
// V390: 忘记密码（邮箱重置链接）+ 重置密码页 + 注册可带邮箱
import { useEffect, useState, type FC, type ReactNode } from "react";
import { cn } from "../lib/utils";

interface AuthState {
  enabled: boolean;
  user: { username: string; role: string; plan: string; balanceCents: number } | null;
}

// V390: 用户菜单 — 用户名/角色/余额/登出（右上角浮动, 全局可见）
function UserMenu({ user, onLogout }: { user: NonNullable<AuthState["user"]>; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    const token = localStorage.getItem("sag_token");
    if (!token) return;
    fetch("/api/billing/balance", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d && typeof d.balanceCents === "number") setBalance(d.balanceCents); })
      .catch(() => {});
  }, []);
  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  const roleLabel = user.role === "admin" ? "管理员" : user.role === "user" ? "普通用户" : user.role;
  const planLabel = { free: "免费版", pro: "专业版", enterprise: "企业版" }[user.plan] || user.plan;
  return (
    <div className="fixed bottom-4 left-4 z-[100]">
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white backdrop-blur transition-colors hover:border-primary/40 hover:bg-white/10">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white">
          {user.username.charAt(0).toUpperCase()}
        </span>
        <span className="max-w-28 truncate">{user.username}</span>
        <svg className="h-3.5 w-3.5 text-slate-400" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" /></svg>
      </button>
      {open && (
        <div className="absolute bottom-11 left-0 w-56 overflow-hidden rounded-xl border border-white/10 bg-slate-900/95 text-white shadow-2xl backdrop-blur" onClick={(e) => e.stopPropagation()}>
          <div className="border-b border-white/10 px-4 py-3">
            <div className="text-sm font-medium">{user.username}</div>
            <div className="mt-0.5 text-xs text-slate-400">
              {roleLabel} · {planLabel}
            </div>
            <div className="mt-1.5 text-xs">
              余额: <span className="font-mono font-medium text-emerald-400">{balance === null ? "—" : "¥" + (balance / 100).toFixed(2)}</span>
            </div>
          </div>
          <div className="py-1">
            <button type="button" onClick={() => { setOpen(false); onLogout(); }}
              className="block w-full px-4 py-2 text-left text-sm text-red-400 transition-colors hover:bg-white/5">
              退出登录
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export const AuthGate: FC<{ children: ReactNode }> = ({ children }) => {
  const [auth, setAuth] = useState<AuthState>({ enabled: false, user: null });
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // V390: 忘记密码视图（forgot 申请 / reset 重置）
  const [resetView, setResetView] = useState<"none" | "forgot" | "reset">("none");
  const [resetToken, setResetToken] = useState("");
  const [resetMsg, setResetMsg] = useState("");

  // V390: 重置链接直达: /reset-password?token=xxx
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tok = params.get("token");
    if (tok) { setResetToken(tok); setResetView("reset"); }
  }, []);

  // V390: 全局 401 拦截 — token 失效(服务重启/密钥轮换)时清 token 回登录页
  // 避免各面板静默 401 显示"已登录"假象
  useEffect(() => {
    const origFetch = window.fetch;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      return origFetch(input, init).then((resp) => {
        if (resp.status === 401 && localStorage.getItem("sag_token")) {
          const url = String(input);
          // 认证接口的 401 由自身流程处理(登录失败/未登录), 业务接口 401 才视为 token 失效
          if (!url.includes("/api/auth/")) {
            localStorage.removeItem("sag_token");
            setAuth((a) => ({ enabled: a.enabled, user: null }));
          }
        }
        return resp;
      });
    };
    return () => { window.fetch = origFetch; };
  }, []);

  // 启动检查: 是否有会话
  useEffect(() => {
    const token = localStorage.getItem("sag_token");
    if (!token) {
      // 查后端是否启用认证
      fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token || ""}` } })
        .then((r) => {
          if (r.status === 401) {
            // 401 可能是未登录(启用) 或接口不存在(未启用)
            fetch("/api/auth/status").then((r2) => r2.json()).then((s) => setAuth({ enabled: !!s?.enabled, user: null })).catch(() => setAuth({ enabled: false, user: null }));
          } else if (r.ok) {
            r.json().then((d) => setAuth({ enabled: true, user: d.user }));
          } else {
            setAuth({ enabled: false, user: null });
          }
        })
        .catch(() => setAuth({ enabled: false, user: null }));
      return;
    }
    fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (r.ok) return r.json().then((d) => setAuth({ enabled: true, user: d.user }));
        // V390: token 失效 → 清 token 回登录页（原仅 removeItem, 页面停留"已登录"假象）
        localStorage.removeItem("sag_token");
        setAuth((a) => ({ enabled: a.enabled, user: null }));
      })
      .catch(() => setAuth({ enabled: false, user: null }));
  }, []);

  // 后端认证状态（启用标志）
  useEffect(() => {
    fetch("/api/auth/status").then((r) => r.json()).then((s) => {
      if (s?.enabled === false) setAuth({ enabled: false, user: null });
    }).catch(() => {});
  }, []);

  if (!auth.enabled || auth.user) {
    // V390: 已登录 → 悬浮用户菜单（所有视图可见）
    return (
      <>
        {children}
        {auth.enabled && auth.user ? <UserMenu user={auth.user} onLogout={() => { localStorage.removeItem("sag_token"); setAuth({ enabled: true, user: null }); }} /> : null}
      </>
    );
  }

  const doSubmit = async () => {
    setBusy(true); setError("");
    try {
      const url = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, ...(mode === "register" && email ? { email } : {}) }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || "操作失败"); return; }
      if (d.token) localStorage.setItem("sag_token", d.token);
      setAuth({ enabled: true, user: d.user });
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  // V390: 忘记密码申请（邮箱 → 发重置链接）
  const doForgot = async () => {
    setBusy(true); setError(""); setResetMsg("");
    try {
      const r = await fetch("/api/auth/forgot-password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || "操作失败"); return; }
      if (d.smtpError) { setResetMsg("已提交。提示: 服务器 SMTP 未配置（" + d.smtpError + "），请联系管理员开启邮件服务。"); return; }
      setResetMsg("如果该邮箱已注册，重置链接已发送，请查收（15分钟内有效）。");
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  // V390: 重置密码提交
  const doReset = async () => {
    setBusy(true); setError(""); setResetMsg("");
    try {
      const r = await fetch("/api/auth/reset-password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: resetToken, newPassword: password }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || "操作失败"); return; }
      setResetMsg("密码已重置，请用新密码登录。");
      setPassword("");
      setTimeout(() => {
        setResetView("none");
        setMode("login");
        const url = new URL(window.location.href);
        url.search = "";
        window.history.replaceState({}, "", url.toString());
      }, 1500);
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-8 shadow-2xl backdrop-blur">
        <div className="mb-6 text-center">
          <div className="text-2xl font-bold text-white">MarxSphere</div>
          <div className="mt-1 text-xs text-slate-400">马研星环 · 科研智能中枢</div>
        </div>
        <div className="mb-4 flex rounded-lg bg-white/5 p-1">
          {(["login", "register"] as const).map((m) => (
            <button key={m} type="button" onClick={() => { setMode(m); setError(""); setResetView("none"); }}
              className={cn("flex-1 rounded-md py-1.5 text-sm", mode === m ? "bg-primary text-white" : "text-slate-400")}>
              {m === "login" ? "登录" : "注册"}
            </button>
          ))}
        </div>
        {resetView === "forgot" ? (
          <div className="space-y-3">
            <div className="text-sm text-slate-300">输入注册时绑定的邮箱，我们将发送密码重置链接。</div>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="邮箱"
              onKeyDown={(e) => e.key === "Enter" && void doForgot()}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500" />
            {error && <div className="text-xs text-red-400">{error}</div>}
            {resetMsg && <div className="text-xs text-emerald-400">{resetMsg}</div>}
            <button type="button" onClick={() => void doForgot()} disabled={busy || !email}
              className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40">
              {busy ? "处理中…" : "发送重置链接"}
            </button>
            <button type="button" onClick={() => { setResetView("none"); setError(""); }} className="w-full text-xs text-slate-400 hover:text-slate-200">
              返回登录
            </button>
          </div>
        ) : resetView === "reset" ? (
          <div className="space-y-3">
            <div className="text-sm text-slate-300">设置新密码（至少6位）。</div>
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="新密码"
              onKeyDown={(e) => e.key === "Enter" && void doReset()}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500" />
            {error && <div className="text-xs text-red-400">{error}</div>}
            {resetMsg && <div className="text-xs text-emerald-400">{resetMsg}</div>}
            <button type="button" onClick={() => void doReset()} disabled={busy || !password}
              className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40">
              {busy ? "处理中…" : "重置密码"}
            </button>
          </div>
        ) : (
        <div className="space-y-3">
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="用户名"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500" />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="密码（至少6位）"
            onKeyDown={(e) => e.key === "Enter" && void doSubmit()}
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500" />
          {mode === "register" && (
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="邮箱（选填，用于找回密码）"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500" />
          )}
          {error && <div className="text-xs text-red-400">{error}</div>}
          <button type="button" onClick={() => void doSubmit()} disabled={busy || !username || !password}
            className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40">
            {busy ? "处理中…" : mode === "login" ? "登录" : "注册"}
          </button>
          {mode === "login" && (
            <button type="button" onClick={() => { setResetView("forgot"); setError(""); }}
              className="w-full text-xs text-slate-400 hover:text-slate-200">
              忘记密码？
            </button>
          )}
        </div>
        )}
      </div>
    </div>
  );
};
