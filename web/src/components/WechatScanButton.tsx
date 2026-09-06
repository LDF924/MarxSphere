// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// WechatScanButton.tsx — SocialSci P0-8: 微信扫码登录(mock/真实双模式)
// 流程: 点"微信登录"→ 后端建 ticket(无 appid 时 mock 模式) → 轮询 status(2s, 3min TTL)
//   mock: 弹"模拟扫码"按钮(演示模式 UI 标注) → scanned → 免注册新号 → 返回 token 完成登录
// 用法: <WechatScanButton onAuthed={(token, user) => ...} />
import { useEffect, useRef, useState } from "react";
import { Loader2, QrCode, ScanLine, X } from "lucide-react";

async function j<T = unknown>(url: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(url, { ...opts, headers: { "Content-Type": "application/json", ...((opts.headers as Record<string, string>) ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string })?.error || `请求失败 ${r.status}`);
  return body as T;
}

export function WechatScanButton({ onAuthed, dark }: { onAuthed: (token: string, user: unknown) => void; dark?: boolean }) {
  const [open, setOpen] = useState(false);
  const [ticket, setTicket] = useState("");
  const [isMock, setIsMock] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => () => stopPoll(), []);

  const start = async () => {
    setBusy(true); setErr("");
    try {
      const r = await j<{ success: boolean; data: { ticket: string; mock: boolean; qrPayload: string } }>("/api/auth/wechat/qr", { method: "POST", body: "{}" });
      if (!r.success) throw new Error("创建二维码失败");
      setTicket(r.data.ticket); setIsMock(r.data.mock); setStatus("pending"); setOpen(true);
      // 轮询(2s, 后端 3min TTL)
      pollRef.current = setInterval(async () => {
        try {
          const s = await j<{ success: boolean; data: { status: string; userId?: string } }>(`/api/auth/wechat/status?ticket=${r.data.ticket}`);
          const st = s.data?.status;
          setStatus(st ?? "");
          if (st === "scanned") {
            // 免注册新号(登录场景默认新建; 绑定场景可另处理)
            const b = await j<{ success: boolean; token: string; user: unknown }>("/api/auth/wechat/bind", {
              method: "POST", body: JSON.stringify({ ticket: r.data.ticket, mode: "new" }),
            });
            if (b.success && b.token) { stopPoll(); setStatus("done"); onAuthed(b.token, b.user); setOpen(false); }
          } else if (st === "expired") { stopPoll(); setStatus("expired"); }
        } catch { /* 轮询失败重试 */ }
      }, 2000);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const mockScan = async () => {
    setBusy(true); setErr("");
    try {
      const r = await j<{ success: boolean }>("/api/auth/wechat/mock-scan", { method: "POST", body: JSON.stringify({ ticket }) });
      if (!r.success) throw new Error("模拟扫码失败");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const btnCls = dark
    ? "w-full rounded-lg border border-emerald-400/30 bg-emerald-500/10 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20"
    : "flex-1 rounded-lg border border-emerald-300 bg-emerald-50 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-100";

  return (
    <>
      {!open ? (
        <button type="button" onClick={() => void start()} disabled={busy}
          className={btnCls + " disabled:opacity-50"}>
          {busy ? <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" /> : <QrCode className="mr-1 inline h-3.5 w-3.5" />}
          微信扫码登录
        </button>
      ) : (
        <div className={dark ? "rounded-lg border border-white/10 bg-white/5 p-3" : "rounded-lg border border-border bg-muted/30 p-3"}>
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">微信扫码登录</p>
            <button type="button" onClick={() => { setOpen(false); stopPoll(); }} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
          </div>
          {status === "done" ? (
            <p className="py-3 text-center text-sm text-green-500">登录成功</p>
          ) : (
            <div className="py-3 text-center">
              {isMock ? (
                <>
                  <div className="mx-auto mb-2 flex h-24 w-24 items-center justify-center rounded-lg border border-dashed border-emerald-400/40 bg-emerald-500/5">
                    <ScanLine className="h-8 w-8 text-emerald-500/50" />
                  </div>
                  <p className="mb-2 text-[10px] text-amber-400/80">演示模式(未配置公众号) · 模拟扫码</p>
                  <button type="button" onClick={() => void mockScan()} disabled={busy || status === "expired"}
                    className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs text-white hover:bg-emerald-500 disabled:opacity-50">
                    {busy ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : null}模拟扫码
                  </button>
                  {status === "expired" && <p className="mt-1 text-[10px] text-red-400">二维码已过期, 关闭重试</p>}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">请用微信扫描二维码… <Loader2 className="ml-1 inline h-3 w-3 animate-spin" /></p>
              )}
            </div>
          )}
        </div>
      )}
      {err && <p className="mt-1 text-[10px] text-red-400">{err}</p>}
    </>
  );
}
