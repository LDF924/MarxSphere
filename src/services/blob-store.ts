// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// blob-store.ts — 字节产物的存储抽象（本地盘 / 共享卷 / S3 兼容对象存储）
//
// 由来(2026-09-11 上云审计): storage-paths.ts 解决的是"路径统一", 前提是**共享卷**
// (NFS / K8s PVC)。换对象存储时那个前提不成立 —— 对象没有目录, `path.join` 拼出来的
// 东西根本不是 key。所以真正的边界不在"路径"而在"字节读写", 这里就是那层抽象。
//
// 用法:
//   const buf = await getObject(key);        // key 形如 user-files/<uid>/<id>.bin
//   await putObject(key, buffer);
//   const url = await objectUrl(key);        // 本地返回文件路径, 对象存储返回 URL(未配 CDN 时为 null)
//
// 驱动选择: BLOB_DRIVER=local(默认) | s3
//   local: key → <DATA_DIR>/<key>, 与既有 data/user-files/... 布局逐字节兼容
//   s3   : 任意 S3 兼容服务(AWS S3 / 阿里云 OSS S3 端点 / MinIO / 腾讯云 COS),
//          手写 SigV4 签名, 不引新的 SDK 依赖
//
// 注意: 这里只管**跨副本必须一致的字节**(用户上传、图表产物)。
// 工作区/缓存/临时任务目录(spill、agent_workspace、jupyter 任务)仍走 storage-paths ——
// 那些本来就是节点本地暂存, 放对象存储既慢又错。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHmac, createHash } from "node:crypto";
import { dataRoot } from "./storage-paths.js";

export interface BlobDriver {
  readonly name: string;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  del(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** 列出前缀下的对象名(相对数据根, 含前缀) */
  list(prefix: string): Promise<string[]>;
  /** 可直接给浏览器用的地址; 本地驱动返回 null(由 API 路由流式回传) */
  publicUrl(key: string): string | null;
}

/**
 * key 规范化: 去掉前导分隔符、去掉历史遗留的 `data/` 前缀、拒绝上跳。
 * 与 storage-paths.resolveStoredRel 同一套规则 —— 库里既有 `data/user-files/...`
 * 也有 `user-files/...`, 两种都必须能取到同一个对象。
 */
export function normalizeKey(key: string): string {
  const clean = String(key ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^data\//, "");
  const parts = clean.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error(`非法对象 key: ${key}`);
  return parts.join("/");
}

// ───────────────────────── 本地驱动(默认) ─────────────────────────

class LocalBlobDriver implements BlobDriver {
  readonly name = "local";
  private root = dataRoot();

  private abs(key: string): string {
    const full = path.join(this.root, normalizeKey(key));
    // 双保险: 归一化后必须仍在数据根内
    const rel = path.relative(this.root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`对象 key 越界: ${key}`);
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.abs(key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, data);
  }

  async get(key: string): Promise<Buffer | null> {
    const full = this.abs(key);
    try {
      return await fsp.readFile(full);
    } catch {
      return null;
    }
  }

  async del(key: string): Promise<void> {
    await fsp.rm(this.abs(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      return fs.existsSync(this.abs(key));
    } catch {
      return false;
    }
  }

  /** 递归列出前缀下的文件, 返回相对数据根的 key */
  async list(prefix: string): Promise<string[]> {
    const clean = normalizeKey(prefix).replace(/\/+$/, "");
    const base = this.abs(clean);
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else out.push(path.relative(this.root, full).replace(/\\/g, "/"));
      }
    };
    walk(base);
    return out;
  }

  publicUrl(): string | null {
    return null; // 本地由 API 路由带鉴权回传, 不暴露文件系统路径
  }

  /** 本地绝对路径(仅本地驱动有; 供 Python 进程等需要真实路径的场景) */
  localPath(key: string): string {
    return this.abs(key);
  }
}

// ───────────────────────── S3 兼容驱动 ─────────────────────────

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  forcePathStyle?: boolean;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf-8").digest();
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** URI 编码: S3 要求对 key 逐段编码, 但保留 `/` */
function uriEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SignedRequestParts {
  authorization: string;
  amzDate: string;
  payloadHash: string;
}

/**
 * AWS SigV4 签名(S3 用)。抽成纯函数便于用官方测试向量做已知答案校验 ——
 * 签名错一个字节, 真实对象存储只会回 403 SignatureDoesNotMatch, 很难现场排查。
 */
export function signS3Request(input: {
  method: string;
  /** 已编码的路径(以 / 开头) */
  canonicalUri: string;
  /** 已按字典序编码的查询串(无 ?) */
  canonicalQuery: string;
  /** 参与签名的 headers(小写名), 必须含 host 与 x-amz-date */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 形如 20150830T123600Z */
  amzDate: string;
}): SignedRequestParts {
  const headerNames = Object.keys(input.headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = headerNames.map((h) => `${h}:${String(input.headers[h]).trim()}\n`).join("");
  const signedHeaders = headerNames.join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.canonicalUri,
    input.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf-8").digest("hex");

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate: input.amzDate,
    payloadHash: input.payloadHash,
  };
}

/** 时间戳: 20260830T123600Z */
function amzTimestamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

class S3BlobDriver implements BlobDriver {
  readonly name = "s3";

  constructor(private cfg: S3Config) {}

  /** key → 对象存储里的完整对象名(含前缀) */
  private objectKey(key: string): string {
    const k = normalizeKey(key);
    const prefix = (this.cfg.prefix ?? "").replace(/^\/+|\/+$/g, "");
    return prefix ? `${prefix}/${k}` : k;
  }

  /** 构造已签名的请求(含 URL 与 headers) */
  private async signedRequest(method: string, key: string, body?: Buffer): Promise<{ url: string; headers: Record<string, string> }> {
    const objectName = this.objectKey(key);
    const endpoint = this.cfg.endpoint.replace(/\/+$/, "");
    const pathStyle = this.cfg.forcePathStyle !== false;
    const segments = objectName.split("/").map(uriEncode);
    const canonicalUri = pathStyle
      ? `/${uriEncode(this.cfg.bucket)}/${segments.join("/")}`
      : `/${segments.join("/")}`;
    const host = new URL(endpoint).host;
    const url = pathStyle
      ? `${endpoint}${canonicalUri}`
      : `${endpoint}${canonicalUri}`;

    const payload = body ?? Buffer.alloc(0);
    const payloadHash = sha256Hex(payload);
    const amzDate = amzTimestamp(new Date());
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (body) headers["content-length"] = String(body.length);

    const signed = signS3Request({
      method,
      canonicalUri,
      canonicalQuery: "",
      headers,
      payloadHash,
      region: this.cfg.region,
      service: "s3",
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      amzDate,
    });
    headers.Authorization = signed.authorization;
    return { url, headers };
  }

  async put(key: string, data: Buffer): Promise<void> {
    const { url, headers } = await this.signedRequest("PUT", key, data);
    const res = await fetch(url, { method: "PUT", headers, body: new Uint8Array(data) });
    if (!res.ok) {
      throw new Error(`对象存储写入失败 ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const { url, headers } = await this.signedRequest("GET", key);
    const res = await fetch(url, { method: "GET", headers });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`对象存储读取失败 ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async del(key: string): Promise<void> {
    const { url, headers } = await this.signedRequest("DELETE", key);
    const res = await fetch(url, { method: "DELETE", headers });
    if (!res.ok && res.status !== 404) {
      throw new Error(`对象存储删除失败 ${res.status}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    const { url, headers } = await this.signedRequest("HEAD", key);
    const res = await fetch(url, { method: "HEAD", headers });
    return res.ok;
  }

  /** ListObjectsV2(分页拉全); 返回相对数据根的 key(去掉对象前缀) */
  async list(prefix: string): Promise<string[]> {
    const objectPrefix = this.objectKey(prefix);
    const fullPrefix = objectPrefix ? `${objectPrefix}/` : "";
    const pathStyle = this.cfg.forcePathStyle !== false;
    const endpoint = this.cfg.endpoint.replace(/\/+$/, "");
    const bucketPath = pathStyle ? `/${uriEncode(this.cfg.bucket)}` : "";
    const host = new URL(endpoint).host;

    const out: string[] = [];
    let token: string | undefined;
    // 上限兜底: 目录被塞爆时不至于无限翻页
    for (let page = 0; page < 100; page++) {
      const q: Array<[string, string]> = [
        ["continuation-token", token ?? ""],
        ["list-type", "2"],
        ["prefix", fullPrefix],
      ].filter(([k, v]) => k !== "continuation-token" || v !== "") as Array<[string, string]>;
      // SigV4 要求查询参数按键名字典序
      q.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const canonicalQuery = q.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");
      const payloadHash = sha256Hex("");
      const amzDate = amzTimestamp(new Date());
      const headers: Record<string, string> = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
      const signed = signS3Request({
        method: "GET",
        canonicalUri: `${bucketPath}/`,
        canonicalQuery,
        headers,
        payloadHash,
        region: this.cfg.region,
        service: "s3",
        accessKeyId: this.cfg.accessKeyId,
        secretAccessKey: this.cfg.secretAccessKey,
        amzDate,
      });
      const res = await fetch(`${endpoint}${bucketPath}/?${canonicalQuery}`, {
        method: "GET",
        headers: { ...headers, Authorization: signed.authorization },
      });
      if (!res.ok) throw new Error(`对象存储列举失败 ${res.status}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
        const full = decodeXml(m[1]);
        // 前缀是部署细节, 对调用方不可见 —— 去掉它, 与 local 驱动的 key 语义保持一致
        const rel = this.cfg.prefix && full.startsWith(`${this.cfg.prefix.replace(/^\/+|\/+$/g, "")}/`)
          ? full.slice(this.cfg.prefix.replace(/^\/+|\/+$/g, "").length + 1)
          : full;
        out.push(rel);
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      if (!truncated) break;
      const next = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1];
      if (!next) break;
      token = decodeXml(next);
    }
    return out;
  }

  /** 直链: 仅当配了 CDN/公开读才有意义; 否则返回 null 走 API 回源 */
  publicUrl(key: string): string | null {
    const base = process.env.BLOB_PUBLIC_BASE;
    if (!base) return null;
    return `${base.replace(/\/+$/, "")}/${this.objectKey(key).split("/").map(uriEncode).join("/")}`;
  }
}

/** XML 实体解码(对象 key 里可能有 & < > 等) */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// ───────────────────────── 驱动选择 ─────────────────────────

let cached: BlobDriver | null = null;

/** 从环境变量构造驱动; BLOB_DRIVER=s3 但配置不全时**抛错**(不静默退回本地 —— 那会把数据写散) */
export function buildBlobDriver(): BlobDriver {
  const kind = (process.env.BLOB_DRIVER || "local").toLowerCase();
  if (kind === "local" || kind === "") return new LocalBlobDriver();
  if (kind !== "s3") throw new Error(`未知的 BLOB_DRIVER: ${kind}（可选 local / s3）`);

  const missing = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]
    .filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`BLOB_DRIVER=s3 但缺少配置: ${missing.join(", ")}（不静默退回本地盘, 否则数据会写散到各副本）`);
  }
  return new S3BlobDriver({
    endpoint: process.env.S3_ENDPOINT!,
    bucket: process.env.S3_BUCKET!,
    region: process.env.S3_REGION || "us-east-1",
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    prefix: process.env.S3_PREFIX || "",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "0",
  });
}

function driver(): BlobDriver {
  if (!cached) cached = buildBlobDriver();
  return cached;
}

/** 当前驱动名(启动自检/诊断用) */
export function blobDriverName(): string {
  try {
    return driver().name;
  } catch {
    return "invalid";
  }
}

/** 测试用: 重置驱动缓存(改环境变量后重新解析) */
export function resetBlobDriver(): void {
  cached = null;
}

export async function putObject(key: string, data: Buffer): Promise<void> {
  return driver().put(key, data);
}

/** 读不到时返回 null(不抛) —— 调用方按"文件已丢失"处理 */
export async function getObject(key: string): Promise<Buffer | null> {
  try {
    return await driver().get(key);
  } catch (e) {
    console.error("[blob] 读取失败", normalizeKey(key), String((e as Error)?.message || e).slice(0, 160));
    return null;
  }
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await driver().del(key);
  } catch (e) {
    console.error("[blob] 删除失败", normalizeKey(key), String((e as Error)?.message || e).slice(0, 160));
  }
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    return await driver().exists(key);
  } catch {
    return false;
  }
}

/** 列出前缀下的对象名(含前缀, 相对数据根); 失败返回空数组 */
export async function listObjects(prefix: string): Promise<string[]> {
  try {
    return await driver().list(prefix);
  } catch (e) {
    console.error("[blob] 列举失败", prefix, String((e as Error)?.message || e).slice(0, 160));
    return [];
  }
}

export function objectPublicUrl(key: string): string | null {
  try {
    return driver().publicUrl(key);
  } catch {
    return null;
  }
}

/**
 * 本地绝对路径(仅 local 驱动可用)。给需要把文件交给 Python 子进程的场景 ——
 * 对象存储驱动下返回 null, 调用方必须改成"先落临时文件"。
 */
export function objectLocalPath(key: string): string | null {
  const d = driver();
  return d instanceof LocalBlobDriver ? d.localPath(key) : null;
}
