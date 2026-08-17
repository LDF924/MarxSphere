// AuthGate.tsx — 商业化登录门（V389+）
// 可选启用: 后端 AUTH_ENABLED=true 时前端要求登录（JWT 存 localStorage）
// 关闭时直接放行（兼容本地单机使用）
// V390: 忘记密码（邮箱重置链接）+ 重置密码页 + 注册可带邮箱
// V399: AuthContext 导出 — header 登录按钮 / 用户菜单接入
import { createContext, useContext, useEffect, useState, type FC, type ReactNode } from "react";
import { cn } from "../lib/utils";

/** V399: 安全 localStorage（隐私模式/沙箱禁用时降级内存，不崩页面） */
const safeStorage = {
  get(key: string): string | null {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string): void {
    try { window.localStorage.setItem(key, value); } catch { /* 忽略 */ }
  },
  remove(key: string): void {
    try { window.localStorage.removeItem(key); } catch { /* 忽略 */ }
  }
};

interface AuthState {
  enabled: boolean;
  user: { username: string; role: string; plan: string; balanceCents: number } | null;
}

interface AuthContextValue {
  enabled: boolean;
  user: AuthState["user"];
  /** V399: 打开登录模态（header 登录按钮触发） */
  openLogin: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  enabled: false,
  user: null,
  openLogin: () => {},
  logout: () => {}
});

/** V399: 读取登录状态（header 按钮/用户菜单用） */
export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

export const AuthGate: FC<{ children: ReactNode }> = ({ children }) => {
  const [auth, setAuth] = useState<AuthState>({ enabled: false, user: null });
  // V399: 登录模态开关（认证未启用时 header 登录按钮也可打开）
  const [loginOpen, setLoginOpen] = useState(false);
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
        if (resp.status === 401 && safeStorage.get("sag_token")) {
          const url = String(input);
          // 认证接口的 401 由自身流程处理(登录失败/未登录), 业务接口 401 才视为 token 失效
          if (!url.includes("/api/auth/")) {
            safeStorage.remove("sag_token");
            // V399: token 失效 → 回本地模式（不跳全屏登录页）
            setAuth({ enabled: false, user: null });
          }
        }
        return resp;
      });
    };
    return () => { window.fetch = origFetch; };
  }, []);

  // 启动检查: 是否有会话
  useEffect(() => {
    const token = safeStorage.get("sag_token");
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
        // V390: token 失效 → 清 token 回本地模式（V399: 不跳全屏登录页）
        safeStorage.remove("sag_token");
        setAuth({ enabled: false, user: null });
      })
      .catch(() => setAuth({ enabled: false, user: null }));
  }, []);

  // 后端认证状态（启用标志）— V399: 已登录用户不被 enabled=false 清空
  // （本地单机认证未启用也可登录；刷新后保持登录态）
  useEffect(() => {
    fetch("/api/auth/status").then((r) => r.json()).then((s) => {
      if (s?.enabled === false && !safeStorage.get("sag_token")) {
        setAuth({ enabled: false, user: null });
      }
    }).catch(() => {});
  }, []);

  // V399: 登录成功统一处理（认证启用/未启用共用）
  const handleAuthSuccess = (d: { token?: string; user: AuthState["user"] }) => {
    if (d.token) safeStorage.set("sag_token", d.token);
    setAuth({ enabled: true, user: d.user });
    setLoginOpen(false);
  };

  const logout = () => {
    safeStorage.remove("sag_token");
    // V399: 退出同时关闭登录模态 — 否则 user=null 后模态仍显示（loginOpen 未清），
    // 用户看到"点了退出没反应"
    setLoginOpen(false);
    // V399: 登出回本地模式（enabled:false）— 原 enabled:true+user:null 会触发
    // 「!auth.enabled || auth.user」条件为 false → 强制渲染全屏登录页（认证未启用时不该出现）
    setAuth({ enabled: false, user: null });
  };

  const contextValue: AuthContextValue = {
    enabled: auth.enabled,
    user: auth.user,
    openLogin: () => { setMode("login"); setError(""); setResetView("none"); setLoginOpen(true); },
    logout
  };

  // V399: doSubmit/doForgot/doReset 必须在首个 return 之前声明 —
  // 模态（首个 return 内）引用它们，声明在 return 后则 TDZ 未初始化，点击无反应
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
      // V399: 统一登录成功处理（关模态）
      handleAuthSuccess(d);
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

  if (!auth.enabled || auth.user) {
    // V399: 正常放行 — 登录状态经 context 暴露（header 登录按钮/用户菜单）
    return (
      <AuthContext.Provider value={contextValue}>
        {children}
        {/* V399: 登录模态（认证未启用时 header 按钮触发；启用时整页登录） */}
        {loginOpen && !auth.user ? (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setLoginOpen(false)}>
            <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-4 text-center">
                <div className="text-xl font-bold">MarxSphere</div>
                <div className="mt-1 text-xs text-muted-foreground">马研星环 · 科研智能中枢</div>
              </div>
              <div className="mb-4 flex rounded-lg bg-muted/60 p-1">
                {(["login", "register"] as const).map((m) => (
                  <button key={m} type="button" onClick={() => { setMode(m); setError(""); setResetView("none"); }}
                    className={cn("flex-1 rounded-md py-1.5 text-sm", mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
                    {m === "login" ? "登录" : "注册"}
                  </button>
                ))}
              </div>
              <div className="space-y-3">
                <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="用户名"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="密码（至少6位）"
                  onKeyDown={(e) => e.key === "Enter" && void doSubmit()}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                {mode === "register" && (
                  <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="邮箱（选填，用于找回密码）"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                )}
                {error && <div className="text-xs text-red-400">{error}</div>}
                {/* V399: 登录在左、退出登录在右 */}
                <div className="flex gap-2">
                  <button type="button" onClick={() => void doSubmit()} disabled={busy || !username || !password}
                    className="flex-1 rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40">
                    {busy ? "处理中…" : mode === "login" ? "登录" : "注册"}
                  </button>
                  <button type="button" onClick={logout}
                    className="flex-1 rounded-lg border border-red-400/40 bg-red-500/10 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/20">
                    退出登录
                  </button>
                </div>
                {mode === "login" ? (
                  <button type="button" onClick={() => { setResetView("forgot"); setError(""); }} className="w-full text-xs text-muted-foreground hover:text-foreground">
                    忘记密码？
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </AuthContext.Provider>
    );
  }

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
