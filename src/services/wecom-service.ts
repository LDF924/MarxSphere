// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// wecom-service.ts — 企业微信接入(自建应用双向 + 群机器人 webhook)
// 协议参照: 企业微信官方文档(developer.work.weixin.qq.com 90968 加密/90930 签名)
//   + OpenSquilla channels/wecom.py 与 _wecom_crypto.py(思路对齐, TS 自实现, 零依赖)
// 自建应用:
//   发送: corpid+corpsecret → GET /cgi-bin/gettoken(access_token, 7200s TTL, 缓存) → POST /cgi-bin/message/send
//   接收: 回调 XML 含 Encrypt(AES-256-CBC: random16||len4BE||msg||corpid, PKCS7 32字节块, iv=key[:16])
//         msg_signature = sha1(sorted(token,timestamp,nonce,encrypt)) 恒时比对
//   群机器人 webhook(可选): 同飞书/钉钉 单向推送, 填 webhook 即用
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

// ─── AES-256-CBC 加解密(腾讯 32 字节块 PKCS7) ─────────────────────

const BLOCK = 32;

function pkcs7Pad(data: Buffer): Buffer {
  const padLen = BLOCK - (data.length % BLOCK);
  return Buffer.concat([data, Buffer.alloc(padLen, padLen)]);
}
function pkcs7Unpad(data: Buffer): Buffer {
  if (data.length === 0) throw new Error("wecom: empty plaintext");
  const padLen = data[data.length - 1];
  if (padLen < 1 || padLen > BLOCK) throw new Error(`wecom: invalid PKCS7 pad ${padLen}`);
  return data.subarray(0, data.length - padLen);
}
function decodeAesKey(encodingAesKey: string): Buffer {
  const padded = encodingAesKey.endsWith("=") ? encodingAesKey : encodingAesKey + "=";
  const key = Buffer.from(padded, "base64");
  if (key.length !== 32) throw new Error(`wecom: EncodingAESKey must be 32 bytes, got ${key.length}`);
  return key;
}
function aesKeyIv(key: string): { key: Buffer; iv: Buffer } {
  const k = decodeAesKey(key);
  return { key: k, iv: k.subarray(0, 16) };
}

/** 解密回调 Encrypt 字段 → 内部 XML 消息体 */
export function wecomDecrypt(encodingAesKey: string, encryptB64: string, receiverId: string): string {
  const { key, iv } = aesKeyIv(encodingAesKey);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const padded = Buffer.concat([decipher.update(Buffer.from(encryptB64, "base64")), decipher.final()]);
  const plain = pkcs7Unpad(padded);
  if (plain.length < 20) throw new Error("wecom: plaintext too short");
  const msgLen = plain.readUInt32BE(16);
  const msg = plain.subarray(20, 20 + msgLen).toString("utf-8");
  const receiver = plain.subarray(20 + msgLen).toString("utf-8");
  if (receiver !== receiverId) throw new Error(`wecom: receiver mismatch (got ${receiver})`);
  return msg;
}

/** 加密回复 XML → 带签名的完整回调响应 XML */
export function wecomEncryptReply(encodingAesKey: string, token: string, receiverId: string, replyXml: string, nonce: string): string {
  const { key, iv } = aesKeyIv(encodingAesKey);
  const msgBuf = Buffer.from(replyXml, "utf-8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const payload = Buffer.concat([randomBytes(16), lenBuf, msgBuf, Buffer.from(receiverId, "utf-8")]);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(pkcs7Pad(payload)), cipher.final()]);
  const encryptB64 = ciphertext.toString("base64");
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = wecomSignature(token, ts, nonce, encryptB64);
  return `<xml><Encrypt><![CDATA[${encryptB64}]]></Encrypt><MsgSignature><![CDATA[${sig}]]></MsgSignature><TimeStamp>${ts}</TimeStamp><Nonce><![CDATA[${nonce}]]></Nonce></xml>`;
}

/** msg_signature = sha1(sorted([token, timestamp, nonce, encrypt])) */
export function wecomSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  const parts = [token, timestamp, nonce, encrypt].sort();
  return createHash("sha1").update(parts.join("")).digest("hex");
}

/** 恒时校验签名 */
export function wecomVerifySignature(token: string, timestamp: string, nonce: string, encrypt: string, signature: string): boolean {
  const expected = wecomSignature(token, timestamp, nonce, encrypt);
  try {
    return timingSafeEqual(Buffer.from(expected, "utf-8"), Buffer.from(signature, "utf-8"));
  } catch { return false; }
}

// ─── XML 解析(极简, 仅取 CDATA 字段) ─────────────────────────────

export function extractXmlCdata(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`));
  return m ? m[1] : "";
}
export function extractXmlText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : "";
}

// ─── access_token 缓存 + 发送 ────────────────────────────────────

interface TokenCache { token: string; expiresAt: number }
let _tokenCache: TokenCache | null = null;

/** 取 access_token(缓存 7000s < 官方 7200s TTL) */
export async function wecomGetToken(corpId: string, corpSecret: string): Promise<string> {
  if (_tokenCache && _tokenCache.expiresAt > Date.now()) return _tokenCache.token;
  const resp = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`,
    { signal: AbortSignal.timeout(15000) }
  );
  const j: any = await resp.json().catch(() => null);
  if (!j || j.errcode !== 0 || !j.access_token) {
    throw new Error(`wecom gettoken failed: ${j?.errcode} ${j?.errmsg || ""}`.slice(0, 120));
  }
  _tokenCache = { token: j.access_token, expiresAt: Date.now() + 7000 * 1000 };
  return j.access_token;
}

export interface WeComSendResult { ok: boolean; error?: string }

/** 自建应用发文本(需 touser/toparty/totag 之一) */
export async function wecomSendText(input: {
  corpId: string; corpSecret: string; agentId: string;
  content: string; touser?: string; toparty?: string; totag?: string;
}): Promise<WeComSendResult> {
  try {
    const token = await wecomGetToken(input.corpId, input.corpSecret);
    const payload: any = { msgtype: "text", agentid: Number(input.agentId), text: { content: input.content }, safe: 0 };
    if (input.touser) payload.touser = input.touser;
    if (input.toparty) payload.toparty = input.toparty;
    if (input.totag) payload.totag = input.totag;
    if (!payload.touser && !payload.toparty && !payload.totag) {
      return { ok: false, error: "需指定 touser/toparty/totag 之一" };
    }
    const resp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const j: any = await resp.json().catch(() => null);
    if (j?.errcode === 0) return { ok: true };
    // 42001 token 过期 → 清缓存重试一次
    if (j?.errcode === 42001) {
      _tokenCache = null;
      const token2 = await wecomGetToken(input.corpId, input.corpSecret);
      const resp2 = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token2}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
      });
      const j2: any = await resp2.json().catch(() => null);
      return j2?.errcode === 0 ? { ok: true } : { ok: false, error: `${j2?.errcode} ${j2?.errmsg || ""}`.slice(0, 120) };
    }
    return { ok: false, error: `${j?.errcode} ${j?.errmsg || ""}`.slice(0, 120) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/** 群机器人 webhook 推送(text) */
export async function wecomWebhookSend(webhook: string, content: string): Promise<boolean> {
  try {
    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content } }),
      signal: AbortSignal.timeout(15000),
    });
    const j: any = await resp.json().catch(() => null);
    return resp.ok && j?.errcode === 0;
  } catch { return false; }
}

// ─── 回调消息解析(自建应用接收) ──────────────────────────────────

export interface WeComCallbackMessage {
  platform: "wecom";
  text: string;
  from: string;   // 发送者 userid
  msgId?: string;
}

/** 解密并解析回调 XML → 文本消息(仅 text 消息; 其它类型/事件返回 null)
 * 企业微信回调 XML 字段均在 CDATA 内 — 统一用 CDATA 提取 */
export function parseWeComCallback(xml: string): WeComCallbackMessage | null {
  const msgType = extractXmlCdata(xml, "MsgType");
  if (msgType !== "text") return null;
  const text = extractXmlCdata(xml, "Content");
  return {
    platform: "wecom",
    text: String(text || ""),
    from: extractXmlCdata(xml, "FromUserName") || "",
    msgId: extractXmlCdata(xml, "MsgId") || undefined,
  };
}
