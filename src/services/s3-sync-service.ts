// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// s3-sync-service.ts — S3 云同步（2026-08-27, Agentero 对照: 云同步）
// 能力: 文献库内容同步到 S3 兼容存储（AWS S3 / MinIO / 阿里 OSS / 腾讯 COS）
// 免依赖: 手写 AWS Signature V4（fetch + crypto）
// 安全: 凭证只存 .env, 不落库; 同步需显式触发
import { createHmac, createHash } from "node:crypto";
import { pool } from "../db/pool.js";

const S3_ENDPOINT = process.env.S3_ENDPOINT || "";
const S3_REGION = process.env.S3_REGION || "us-east-1";
const S3_BUCKET = process.env.S3_BUCKET || "";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "";

export function s3Configured(): boolean {
  return !!(S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY && S3_SECRET_KEY);
}

/** AWS Signature V4 签名 */
function signV4(method: string, path: string, payload: string, query = ""): { auth: string; date: string } {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash("sha256").update(payload).digest("hex");
  const canonicalUri = path.split("?")[0].split("/").map((seg) => encodeURIComponent(seg)).join("/");
  const canonicalQuerystring = query;
  const canonicalHeaders = `host:${new URL(S3_ENDPOINT).host}\n`;
  const signedHeaders = "host";
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const hmac = (key: string, data: string) => createHmac("sha256", key).update(data).digest();
  const kDate = hmac("AWS4" + S3_SECRET_KEY, dateStamp);
  const kRegion = hmac(kDate as any, S3_REGION);
  const kService = hmac(kRegion as any, "s3");
  const kSigning = hmac(kService as any, "aws4_request");
  const signature = createHmac("sha256", kSigning as any).update(stringToSign).digest("hex");
  return { auth: `AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, date: amzDate };
}

/** S3 请求（签名 + fetch） */
async function s3Request(method: string, key: string, body?: string): Promise<{ ok: boolean; status?: number; text?: string; error?: string }> {
  if (!s3Configured()) return { ok: false, error: "S3 未配置 (S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY)" };
  try {
    const path = `/${S3_BUCKET}/${encodeURIComponent(key)}`;
    const url = `${S3_ENDPOINT}${path}`;
    const sig = signV4(method, path, body || "");
    const resp = await fetch(url, {
      method,
      headers: { "x-amz-date": sig.date, Authorization: sig.auth, "Content-Type": "application/octet-stream" },
      body: body || undefined,
      signal: (AbortSignal as any).timeout(30_000),
    });
    const text = await resp.text();
    return resp.ok ? { ok: true, status: resp.status, text } : { ok: false, status: resp.status, text, error: text.slice(0, 200) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 导出文献库快照 → S3（JSON, 含哈希指纹） */
export async function syncToS3(): Promise<{ ok: boolean; error?: string; exported?: number }> {
  try {
    const r = await pool.query(
      `select title, external_id, metadata, content_hash from documents
       where archived_at is null and content_hash is not null order by created_at`
    );
    const snapshot = {
      exportedAt: new Date().toISOString(),
      count: r.rows.length,
      documents: r.rows.map((x: any) => ({
        title: x.title, externalId: x.external_id, metadata: x.metadata, contentHash: x.content_hash,
      })),
    };
    const body = JSON.stringify(snapshot, null, 2);
    const res = await s3Request("PUT", `sag-sync/literature-${new Date().toISOString().slice(0, 10)}.json`, body);
    return res.ok ? { ok: true, exported: r.rows.length } : { ok: false, error: res.error };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 列出 S3 里的同步文件 */
export async function listS3Backups(): Promise<{ ok: boolean; files?: string[]; error?: string }> {
  const path = `/${S3_BUCKET}?list-type=2&prefix=sag-sync/`;
  try {
    const url = `${S3_ENDPOINT}${path}`;
    const sig = signV4("GET", `/${S3_BUCKET}`, "", "list-type=2&prefix=sag-sync/");
    const resp = await fetch(url, {
      method: "GET",
      headers: { "x-amz-date": sig.date, Authorization: sig.auth },
      signal: (AbortSignal as any).timeout(30_000),
    });
    const xml = await resp.text();
    if (!resp.ok) return { ok: false, error: xml.slice(0, 150) };
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    return { ok: true, files: keys };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

export const s3SyncService = {
  s3Configured,
  syncToS3,
  listS3Backups,
};
