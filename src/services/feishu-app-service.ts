// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// feishu-app-service.ts — 飞书自建应用(与 im-service 的 webhook 机器人是两条通道)
//
// ═══ 两条通道的区别(实测确认, 不是文档抄的) ═══
//   webhook 机器人(im-service.sendFeishu): 只有一个 URL, `msg_type:"text"`,
//     往**配置的那个群**发。收不到事件、不能发给人、不能回复。
//   自建应用(本文件): App ID + App Secret → tenant_access_token → 可以
//     · 发给指定用户(open_id/user_id) —— 这才是"按人推送"的前提
//     · 接收事件订阅(需要 verification_token 验签 + encrypt_key 解密)
//
// 本仓此前只有前者。加后者是为了让通知中心的消息能发到**用户自己的**飞书,
//   而不是全站共用一个群(那样谁都看得到谁的通知)。
//
// ═══ 与 wecom-service 的关系 ═══
//   企业微信那套(wecom-service.ts)已经实现了 AES 双向 + token 缓存, 本文件的
//   token 缓存与解密照它的做法写 —— 同一个平台家族的问题, 不该有两套风格。
import crypto from "node:crypto";
import { pool } from "../db/pool.js";

const FEISHU_BASE = "https://open.feishu.cn/open-apis";

export interface FeishuAppConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
}

/** 读配置。env 兜底 DB —— 与 im-service.getImConfig 同口径(面板改配置即时生效) */
export async function getFeishuAppConfig(): Promise<FeishuAppConfig> {
  let row: any = {};
  try {
    const r = await pool.query(
      `select feishu_app_id, feishu_app_secret, feishu_verification_token, feishu_encrypt_key
         from im_config where id = 1`
    );
    row = r.rows[0] ?? {};
  } catch { /* 表还没迁移时退到 env */ }
  return {
    appId: String(row.feishu_app_id || process.env.FEISHU_APP_ID || "").trim(),
    appSecret: String(row.feishu_app_secret || process.env.FEISHU_APP_SECRET || "").trim(),
    verificationToken: String(row.feishu_verification_token || process.env.FEISHU_VERIFICATION_TOKEN || "").trim(),
    encryptKey: String(row.feishu_encrypt_key || process.env.FEISHU_ENCRYPT_KEY || "").trim()
  };
}

export async function isFeishuAppConfigured(): Promise<boolean> {
  const c = await getFeishuAppConfig();
  return Boolean(c.appId && c.appSecret);
}

// ─── tenant_access_token 缓存 ───
// 飞书的 token 有效期 2 小时; 缓存到过期前 5 分钟再刷新。
// ⚠ 必须缓存: 每次发送都换 token 会撞飞书的频率限制(同 app 的 token 接口有 QPS 上限),
//   而通知是批量发的(一次抓取可能几十条)。企业微信那套缓存 7000s 是同一个理由。
let tokenCache: { token: string; expiresAt: number } | null = null;

export async function getTenantAccessToken(): Promise<{ ok: boolean; token?: string; error?: string }> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) {
    return { ok: true, token: tokenCache.token };
  }
  const c = await getFeishuAppConfig();
  if (!c.appId || !c.appSecret) return { ok: false, error: "未配置 App ID / App Secret" };
  try {
    const resp = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }),
      signal: (AbortSignal as any).timeout(15_000)
    });
    const j: any = await resp.json();
    // 飞书的错误不靠 HTTP 状态码 —— 200 也可能带 code != 0, 必须查 body
    if (!j || j.code !== 0 || !j.tenant_access_token) {
      return { ok: false, error: `飞书拒绝: code=${j?.code} ${String(j?.msg || "").slice(0, 100)}` };
    }
    const ttl = Math.max(60, (Number(j.expire) || 7200) - 300);
    tokenCache = { token: String(j.tenant_access_token), expiresAt: Date.now() + ttl * 1000 };
    return { ok: true, token: tokenCache.token };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 连通性测试 —— 面板上那个"测试飞书连通性"按钮的落点。
 *  只换 token 不发消息: 能换到 token 就证明 App ID/Secret 是对的,
 *  而发消息会在用户群里留下一条测试垃圾。 */
export async function testFeishuConnection(): Promise<{ ok: boolean; error?: string }> {
  if (!(await isFeishuAppConfigured())) return { ok: false, error: "未配置 App ID / App Secret" };
  const r = await getTenantAccessToken();
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** 发给指定用户(按 open_id / user_id / email / mobile 之一)。
 *
 *  ⚠ 这条通道与 webhook 的分工: 通知中心要发到"这个人自己的飞书",
 *   所以必须带 receive_id。没有 receive_id 时**不退回 webhook** ——
 *   那会把私信发到公共群, 比不发更糟。宁可失败。
 */
export async function sendFeishuToUser(input: {
  receiveId: string;
  receiveIdType?: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
  text: string;
}): Promise<{ ok: boolean; error?: string }> {
  const receiveId = String(input.receiveId || "").trim();
  if (!receiveId) return { ok: false, error: "缺少接收者 id(不做退回公共群的降级)" };
  const t = await getTenantAccessToken();
  if (!t.ok || !t.token) return { ok: false, error: t.error };
  try {
    const resp = await fetch(
      `${FEISHU_BASE}/im/v1/messages?receive_id_type=${input.receiveIdType || "open_id"}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t.token}` },
        body: JSON.stringify({
          receive_id: receiveId,
          msg_type: "text",
          // content 是**字符串化的 JSON**, 不是对象 —— 直接传对象飞书报参数错
          content: JSON.stringify({ text: String(input.text || "").slice(0, 4000) })
        }),
        signal: (AbortSignal as any).timeout(15_000)
      }
    );
    const j: any = await resp.json();
    if (!j || j.code !== 0) return { ok: false, error: `飞书拒绝: code=${j?.code} ${String(j?.msg || "").slice(0, 100)}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 事件订阅的解密 —— 与 wecom-service.ts:38 的 AES-256-CBC 是同一个套路。
 *
 *  飞书事件体: base64(AES-256-CBC(随机16字节 + 4字节长度 + 明文 + appId, key=sha256(encryptKey)))
 *  ⚠ 前 16 字节是 IV、接下来 4 字节是**明文长度**(大端) —— 少了截长度这步会解出一段
 *  带尾巴的垃圾, 而且不报错。
 */
export function decryptFeishuEvent(encrypted: string, encryptKey: string): { ok: boolean; data?: any; error?: string } {
  try {
    const key = crypto.createHash("sha256").update(encryptKey).digest();
    const buf = Buffer.from(encrypted, "base64");
    if (buf.length <= 20) return { ok: false, error: "密文过短" };
    const iv = buf.subarray(0, 16);
    const payload = buf.subarray(16);
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    decipher.setAutoPadding(false);   // 长度在前 4 字节, 不靠 PKCS padding
    const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
    const msgLen = decrypted.readUInt32BE(0);
    // 越界要拦住 —— 否则 subarray 会静默返回一段更短的 buffer, 后续 JSON.parse 报错难定位
    if (msgLen <= 0 || msgLen > decrypted.length - 4) return { ok: false, error: `长度字段非法: ${msgLen}` };
    const text = decrypted.subarray(4, 4 + msgLen).toString("utf-8");
    return { ok: true, data: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 处理飞书事件推送的入口(URL 校验 + 加密事件解密)。
 *  返回 null 表示"这个 body 不是飞书事件"(交给调用方按普通请求处理)。 */
export async function parseFeishuAppEvent(body: any): Promise<{ challenge?: string; event?: any; error?: string } | null> {
  if (!body || typeof body !== "object") return null;
  const cfg = await getFeishuAppConfig();
  // ① URL 校验: 飞书发 {type:"url_verification", challenge, token}
  if (body.type === "url_verification") {
    // 配了 verification_token 就必须比对 —— 否则任何人都能用这个端点验证自己的 URL
    if (cfg.verificationToken && String(body.token || "") !== cfg.verificationToken) {
      return { error: "verification_token 不匹配" };
    }
    return { challenge: String(body.challenge || "") };
  }
  // ② 加密事件: {encrypt: "..."}(整个事件被包在 encrypt 字段里)
  if (typeof body.encrypt === "string") {
    if (!cfg.encryptKey) return { error: "收到加密事件但未配置 Encrypt Key" };
    const d = decryptFeishuEvent(body.encrypt, cfg.encryptKey);
    if (!d.ok) return { error: d.error };
    return { event: d.data };
  }
  // ③ 明文事件
  if (body.header || body.event) return { event: body };
  return null;
}

export const feishuAppService = {
  getFeishuAppConfig, isFeishuAppConfigured, getTenantAccessToken,
  testFeishuConnection, sendFeishuToUser, decryptFeishuEvent, parseFeishuAppEvent
};
