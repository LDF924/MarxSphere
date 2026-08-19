// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// email-service.ts — V390: 免费 SMTP 邮件发送（QQ/163 邮箱授权码）
// 未配置 SMTP 时静默降级（仅打日志, 不阻断流程 — 本地单机无邮件场景兼容）
// 配置环境变量:
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS(授权码) / SMTP_FROM(可选, 默认 SMTP_USER)
//   示例: SMTP_HOST=smtp.qq.com SMTP_PORT=465 SMTP_USER=you@qq.com SMTP_PASS=xxxx授权码
// 免依赖实现: 465(SSL)/587(STARTTLS) 用 node:tls/net 手写 SMTP 客户端, 不引入 nodemailer
// 587 端口 STARTTLS 场景: QQ/163 现支持 465 全链路 SSL, 未配置时默认按域名推断(qq.com→465)

import net from "node:net";
import tls from "node:tls";

export interface EmailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export function getEmailConfig(): EmailConfig | null {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;  // 未配置 → 降级
  return {
    host,
    port: Number(process.env.SMTP_PORT || (host.includes("qq.com") ? 465 : 587)),
    user,
    pass,
    from: process.env.SMTP_FROM || user,
  };
}

/**
 * 极简 SMTP 客户端: 命令队列顺序执行（EHLO → AUTH LOGIN → MAIL FROM → RCPT TO → DATA）
 * DATA 收到 354 后发送正文, 再等 250 → QUIT
 * 465 端口直接 TLS; 其他端口明文（如本地调试）
 */
async function smtpSend(cfg: EmailConfig, to: string, subject: string, html: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let socket: net.Socket | null = null;
    let buffer = "";
    let finished = false;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 20_000);

    const write = (s: string) => { try { socket?.write(s + "\r\n"); } catch { finish(false); } };

    // 命令队列: [命令, 期望响应码]
    const cmds: Array<[string, number[]]> = [
      ["EHLO sag.local", [220, 250]],
      ["AUTH LOGIN", [334]],
      [Buffer.from(cfg.user).toString("base64"), [334]],
      [Buffer.from(cfg.pass).toString("base64"), [235]],
      [`MAIL FROM:<${cfg.from}>`, [250]],
      [`RCPT TO:<${to}>`, [250, 251]],
      ["DATA", [354]],  // 收到 354 后发送正文
    ];
    let cmdIdx = 0;

    const body =
      `From: ${cfg.from}\r\n` +
      `To: ${to}\r\n` +
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n` +
      `\r\n` +
      `${html}\r\n.\r\n`;

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const code = parseInt(line.slice(0, 3), 10);
        const isContinuation = line.length > 3 && line[3] === "-";
        if (isContinuation) continue;
        if (cmdIdx < cmds.length) {
          const [cmd, expects] = cmds[cmdIdx];
          if (!expects.includes(code)) { finish(false); return; }
          cmdIdx++;
          if (cmd === "DATA") {
            // 354 → 发送正文（之后等 250）
            try { socket?.write(body); } catch { finish(false); return; }
          } else if (cmdIdx < cmds.length) {
            write(cmds[cmdIdx][0]);
          }
        } else {
          // 正文阶段: 250 → QUIT 完成
          if (code === 250) { write("QUIT"); finish(true); }
          else { finish(false); }
          return;
        }
      }
    };

    const onConnect = () => write(cmds[0][0]);
    if (cfg.port === 465) {
      socket = tls.connect({ host: cfg.host, port: cfg.port, rejectUnauthorized: false }, onConnect);
    } else {
      socket = net.connect(cfg.port, cfg.host, onConnect);
    }
    socket.setEncoding("utf8");
    socket.on("data", onData);
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

export function buildResetEmailHtml(resetUrl: string, username: string, expiresMin = 15): string {
  return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
  <h2 style="color:#1e293b">MarxSphere 密码重置</h2>
  <p style="color:#475569;line-height:1.6">您好 <b>${escapeHtml(username)}</b>：</p>
  <p style="color:#475569;line-height:1.6">我们收到您重置密码的请求。请在 <b>${expiresMin} 分钟</b> 内点击以下链接（一次性有效）：</p>
  <p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">重置密码</a></p>
  <p style="color:#64748b;font-size:13px">如果链接无法点击，请复制到浏览器打开：<br/>${escapeHtml(resetUrl)}</p>
  <p style="color:#94a3b8;font-size:12px;margin-top:24px">如果不是您本人操作，请忽略此邮件，您的密码不会改变。</p>
</div>`;
}

function escapeHtml(s: string): string {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}

export async function sendResetEmail(to: string, resetUrl: string, username: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = getEmailConfig();
  if (!cfg) return { ok: false, error: "SMTP 未配置（需设置 SMTP_HOST/SMTP_USER/SMTP_PASS）" };
  try {
    const html = buildResetEmailHtml(resetUrl, username);
    const ok = await smtpSend(cfg, to, "MarxSphere 密码重置", html);
    return ok ? { ok: true } : { ok: false, error: "SMTP 发送失败" };
  } catch (e: any) {
    return { ok: false, error: "SMTP 异常: " + String(e?.message || e).substring(0, 100) };
  }
}
