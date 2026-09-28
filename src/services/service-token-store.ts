// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// service-token-store.ts — V418: 外部服务密钥的存取与到期判断
//
// 由来(2026-09-28 用户要求): "做个前端, 弄个有效期和提醒这些"。
//   MinerU 的 OCR token 在 2026-09-16 过期, 11 天后才被发现 —— 因为**没有任何地方
//   记录它什么时候到期**。值躺在 .env 里, 界面上看不见、也问不出"还剩几天";
//   唯一的检查方式是发生一次真实调用, 也就是等它坏掉。
//
// 这个文件管三件事:
//   ① 存 —— 值 + 签发/到期 + 上次校验结果(表 service_tokens, 迁移 162);
//   ② 取 —— 服务端代码要用的**全量值**(只在这里拿得到, 不出 API);
//   ③ 判 —— 距今剩几天、处于哪一档(正常 / 临近到期 / 已过期 / 未知)。
//
// ## 安全约定(与 agent-credentials 一致)
//   · 任何 API 只返回**脱敏视图**(`viewOf`), 全量值永不出库;
//   · 对外只暴露末 6 位(`token_tail`), 够辨认"换没换过", 不够还原;
//   · 提示词/日志里连末 6 位都不给 —— 那里只需要知道"配没配"。
//
// ## 与 .env 的关系(容易搞混, 写清楚)
//   真源是**数据库**; .env 是部署时的初始值, 也是 DB 里没有记录时的兜底。
//   所以 `effectiveToken()` 先查 DB 再查 env, 并且**写入时会把值同步进
//   process.env** —— 因为下游(mineru-go-adapter)是同步读 env 的, 它读不到 DB。
//   这一步不做的话, 会出现"界面上显示已配置, 实际调用还用着旧值"这种最难查的分叉。
import { readFileSync } from "node:fs";
import { pool } from "../db/pool.js";

/** 目前已接入的服务。新增一个服务时要同时给: 环境变量名、申请地址、默认提醒阈值 */
export interface ServiceDef {
  key: string;
  /** 界面上显示的名字 */
  label: string;
  /** 这个密钥是干什么的 —— 用"坏掉时用户看到什么"来描述, 不是复述产品名 */
  purpose: string;
  /** 兜底读的环境变量名(按顺序) */
  envNames: string[];
  /** 去哪申请/续期 */
  applyUrl: string;
  /** 密钥形态提示(界面上填之前先让人确认自己复制对了东西) */
  shapeHint: string;
  /**
   * 校验用的端点。**实测过的判据**(2026-09-28 打了一次真实接口):
   *   · 有效 token + 空 body → HTTP 200 + `{code:-10002, msg:"file list is empty"}`;
   *   · 无效 / 已过期 token  → **HTTP 401**(两者都是 401, 所以远端分不出"过期"还是"填错了");
   *   · 所以: 200 = 通, 401/403 = 被拒, 其余(网络/5xx) = 探不到。
   * 用 POST `{}` 是刻意的 —— 请求在校验之后、建任务之前就被拒掉, **不会在对方账号下留下任务**。
   */
  verifyUrl: string;
}

export const SERVICES: readonly ServiceDef[] = Object.freeze([
  {
    key: "mineru",
    label: "MinerU OCR",
    purpose: "扫描版 PDF 的文字提取。没配或过期时，图片型 PDF 上传后抽不出正文。",
    envNames: ["MINERU_TOKEN", "MINERU_API_TOKEN", "MINERU_API_KEY"],
    applyUrl: "https://mineru.net/apiManage/docs?openApplyModal=true",
    shapeHint: "sk- 开头，约 60 位；有效期 90 天，可无限次续签",
    verifyUrl: "https://mineru.net/api/v4/file-urls/batch",
  },
]);

export function serviceDef(key: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.key === key);
}

/** 判"临近到期"的阈值: 剩这么多天就开始提醒。14 天 ≈ 两个工作周, 够排进日程 */
export const EXPIRING_SOON_DAYS = 14;

export type TokenStatus = "unconfigured" | "unknown" | "ok" | "expiring" | "expired";

export interface ServiceTokenView {
  service: string;
  label: string;
  purpose: string;
  applyUrl: string;
  shapeHint: string;
  /** 有没有可用的值(DB 有, 或 env 有) */
  configured: boolean;
  /** 值从哪来 —— 'db' 表示界面上换过, 'env' 表示还在用部署时写的那个 */
  source: "db" | "env" | "none";
  /** 末 6 位。值为空串 = 拿不到(没配) */
  tail: string;
  issuedAt: string | null;
  expiresAt: string | null;
  /** 距今天数(向上取整)。负 = 已过期。null = 到期日未知 */
  daysLeft: number | null;
  status: TokenStatus;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckNote: string;
  note: string;
  updatedAt: string | null;
}

/** 末 6 位。密钥短于 6 位时原样返回(短密钥本身就不是密钥) */
function tailOf(token: string): string {
  const t = token.trim();
  return t.length <= 6 ? t : t.slice(-6);
}

/**
 * 从 JWT 载荷里读 `exp` —— MinerU 的密钥是 HS512 签名的 JWT, 到期日**写在里面**。
 *
 * ⚠ 这是**便利**, 不是判据: 签发方换了密钥形态(不再是 JWT)就必须回到"到期日未知"。
 *   所以解析失败返回 null, 让调用方**不猜** —— 拿签发日 +90 天冒充到期日,
 *   在签发方改policy 之后会静默算错, 而算错的后果是"以为还早, 实际早就过期了"。
 */
export function decodeJwtExpiry(token: string): Date | null {
  const parts = token.trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    if (typeof payload?.exp !== "number" || !Number.isFinite(payload.exp)) return null;
    return new Date(payload.exp * 1000);
  } catch {
    return null;
  }
}

/** 从 JWT 载荷里读 `iat`(签发时间)。同上, 读不到就 null */
export function decodeJwtIssuedAt(token: string): Date | null {
  const parts = token.trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    if (typeof payload?.iat !== "number" || !Number.isFinite(payload.iat)) return null;
    return new Date(payload.iat * 1000);
  } catch {
    return null;
  }
}

/** 距今整天数, 向上取整(剩 0.4 天 → 1, 好过显示 0 让人以为还有一天)。null 透传 */
export function daysUntil(when: Date | string | null | undefined, now = new Date()): number | null {
  if (!when) return null;
  const t = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(t.getTime())) return null;
  return Math.ceil((t.getTime() - now.getTime()) / 86_400_000);
}

/**
 * 分档。**顺序有意义**: 先看有没有值, 再看有没有到期日, 最后才比天数。
 *   · 没值          → unconfigured(界面要引导去配, 不是报错)
 *   · 有值无到期日  → unknown(诚实: 不知道。界面给"去校验"而不是编一个日期)
 *   · 已过期        → expired
 *   · 剩 ≤ 阈值     → expiring
 *   · 其余          → ok
 */
export function statusOf(daysLeft: number | null, configured: boolean): TokenStatus {
  if (!configured) return "unconfigured";
  if (daysLeft === null) return "unknown";
  if (daysLeft < 0) return "expired";
  if (daysLeft <= EXPIRING_SOON_DAYS) return "expiring";
  return "ok";
}

/** 读环境变量。先看 process.env, 再依次读几个 .env 文件 —— 与 mineru-go-adapter 同一套兜底 */
function readEnv(names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  // 静态 import fs: 这个模块可能在启动早期被同步调用, 动态 require 在 ESM 下不可用
  for (const f of [".env", ".env.local"]) {
    try {
      for (const line of readFileSync(f, "utf-8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)$/);
        if (m && names.includes(m[1])) return m[2].trim().replace(/^["']|["']$/g, "");
      }
    } catch { /* 文件不存在/不可读 → 跳过, 不代表密钥没有 */ }
  }
  return undefined;
}

/**
 * 服务端要用的**全量值**。DB 优先, env 兜底。
 * ⚠ 只有服务端内部调用它 —— 不要在路由的返回值里带上它。
 */
export async function effectiveToken(service: string): Promise<string | null> {
  try {
    const r = await pool.query("select token from service_tokens where service = $1", [service]);
    const v = r.rows[0]?.token;
    if (typeof v === "string" && v.trim()) return v.trim();
  } catch {
    // 表还没建(首次启动早于迁移) → 落到 env, 不让"迁移没跑"表现为"密钥丢了"
  }
  const def = serviceDef(service);
  return (def ? readEnv(def.envNames) : undefined) ?? null;
}

/**
 * 启动时把 DB 里的值灌回 process.env。
 *
 * 为什么必须做: 下游 `mineru-go-adapter` 是**同步读 env** 的(它要在 execFileSync 前
 * 拿到 token, 整条调用链是同步的)。不灌的话, 用户在界面上换了 token, 界面显示新的、
 * 实际调用还用 .env 里那个旧的 —— 这是最耗时的一类分叉, 因为两边"看起来都正常"。
 */
export async function restoreServiceTokens(): Promise<string[]> {
  const restored: string[] = [];
  for (const def of SERVICES) {
    const v = await effectiveToken(def.key);
    if (!v) continue;
    // 只灌第一个变量名 —— 下游按同样顺序查, 保证拿到的是同一个值
    const primary = def.envNames[0];
    if (process.env[primary] !== v) {
      process.env[primary] = v;
      restored.push(def.key);
    }
  }
  return restored;
}

/**
 * 落一条/更新一条。`token` 传空字符串 = **只改日期与备注**, 不动值
 * (已经配好的人只想补个到期日, 不该被逼着再贴一遍密钥)。
 */
export async function saveServiceToken(input: {
  service: string;
  token?: string;
  issuedAt?: string | null;
  expiresAt?: string | null;
  note?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const def = serviceDef(input.service);
  if (!def) return { ok: false, error: `未知服务: ${input.service}` };

  const raw = (input.token ?? "").trim();
  const writable = raw.length > 0;
  if (!writable) {
    // 只改元数据: 表里没有行就没什么可改的(说明还没配过), 明确报错而不是静默建空行
    const cur = await pool.query("select token from service_tokens where service = $1", [def.key]);
    if (!cur.rows[0]) return { ok: false, error: "还没配过这个密钥, 请先填入值" };
  }

  // 到期日: 显式传了就认; 没传且这次贴了新值 → 尝试从密钥本身读; 都拿不到就保持原样(null)
  let expiresAt: string | null = input.expiresAt ?? null;
  let issuedAt: string | null = input.issuedAt ?? null;
  if (writable && !expiresAt) {
    const d = decodeJwtExpiry(raw);
    if (d) expiresAt = d.toISOString();
  }
  if (writable && !issuedAt) {
    const d = decodeJwtIssuedAt(raw);
    if (d) issuedAt = d.toISOString();
  }

  if (writable) {
    await pool.query(
      `insert into service_tokens (service, token, token_tail, issued_at, expires_at, note, updated_at)
       values ($1,$2,$3,$4,$5,$6, now())
       on conflict (service) do update set
         token = excluded.token,
         token_tail = excluded.token_tail,
         issued_at = excluded.issued_at,
         expires_at = excluded.expires_at,
         note = excluded.note,
         -- 换了值 ⇒ 上次的校验结论作废(那是上一个密钥的结论)
         last_checked_at = null, last_check_ok = null, last_check_note = '',
         updated_at = now()`,
      [def.key, raw, tailOf(raw), issuedAt, expiresAt, input.note ?? ""]
    );
    // 同步进 env, 见 restoreServiceTokens 的说明
    process.env[def.envNames[0]] = raw;
  } else {
    await pool.query(
      `update service_tokens set
         issued_at = coalesce($2, issued_at),
         expires_at = coalesce($3, expires_at),
         note = $4,
         updated_at = now()
       where service = $1`,
      [def.key, issuedAt, expiresAt, input.note ?? ""]
    );
  }
  return { ok: true };
}

/** 记一次校验结果 */
export async function recordTokenCheck(service: string, ok: boolean, note: string): Promise<void> {
  try {
    await pool.query(
      `update service_tokens set last_checked_at = now(), last_check_ok = $2, last_check_note = $3, updated_at = now()
       where service = $1`,
      [service, ok, note.slice(0, 300)]
    );
  } catch { /* 校验结论落库失败不影响本次校验的返回 */ }
}

/**
 * 现场打一次远端接口, 判断这个密钥**现在还能不能用**。
 *
 * 为什么值得单独做: 到期日是**声明**, 校验是**事实**。实测存在两者不一致的情况 ——
 *   走本文件的路径读到的 2026-06-18 那枚密钥, 载荷里写着 09-16 到期(以为 11 天前失效了),
 *   打过去远端却回「user token expired」; 而换一枚新密钥后同样的调用才 200。
 *   只看日期的话, "还剩 10 天"和"实际已被吊销"长得一模一样。
 *
 * ⚠ 判定依据是**状态码**, 不是 body 里的中文 msg —— msg 会随对方改动措辞
 *   (同一枚有效密钥, 一次回 `file list is empty`、一次回 `type mismatch for field "files"`)。
 *
 * @param token 不给就用当前生效的那个; 给了就**只校验、不落库**(表单里点"先测一下再保存")
 */
export async function verifyServiceToken(
  service: string,
  token?: string,
): Promise<{ ok: boolean; status: "ok" | "rejected" | "unreachable" | "not_configured"; message: string }> {
  const def = serviceDef(service);
  if (!def) return { ok: false, status: "not_configured", message: `未知服务: ${service}` };

  const t = (token ?? "").trim() || (await effectiveToken(service));
  if (!t) return { ok: false, status: "not_configured", message: "还没配置密钥" };

  // 表单里临时测的情况不写库 —— 写了会让"上次校验结论"对应到一个还没保存的密钥
  const persist = !token;
  try {
    const res = await fetch(def.verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      // 空 body: 请求在校验之后、建任务之前被拒 — 不会在对方账号下留下任务
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
    const ok = res.ok;
    const status = ok ? "ok" : res.status === 401 || res.status === 403 ? "rejected" : "unreachable";
    const message =
      status === "ok"
        ? "密钥可用"
        : status === "rejected"
          ? `远端拒绝（HTTP ${res.status}）—— 密钥已过期或填错了。到期日只说明签发方当初怎么写的，以这个结果为准。`
          : `探不到远端（HTTP ${res.status}）—— 可能网络不通或对方在维护，不代表密钥坏了。`;
    if (persist) await recordTokenCheck(service, status === "ok", message);
    return { ok: status === "ok", status, message };
  } catch (e: any) {
    const message = `探不到远端：${String(e?.message || e).slice(0, 160)}`;
    if (persist) await recordTokenCheck(service, false, message);
    return { ok: false, status: "unreachable", message };
  }
}

/** 删掉 DB 里的记录(env 兜底随之重新生效) */
export async function clearServiceToken(service: string): Promise<boolean> {
  try {
    const r = await pool.query("delete from service_tokens where service = $1", [service]);
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * 脱敏视图 —— 这是**唯一**允许出 API 的形状。
 * 加字段时先问一句: 这个字段能不能反推出密钥? 能, 就不加。
 */
export async function listServiceTokens(): Promise<ServiceTokenView[]> {
  const rows = new Map<string, Record<string, any>>();
  try {
    const r = await pool.query("select * from service_tokens");
    for (const row of r.rows) rows.set(String(row.service), row);
  } catch { /* 表不存在时仍然要能列出(显示为"未配置"), 而不是整页报错 */ }

  return SERVICES.map((def) => {
    const row = rows.get(def.key);
    const envVal = readEnv(def.envNames);
    const configured = !!row || !!envVal;
    const raw = row?.token ?? envVal ?? "";
    /**
     * ⚠ **必须显式转 ISO**。pg 对 `timestamptz` 返回的是 `Date` 对象; 而 `row` 是
     *   `Record<string, any>`, TS 不会拦住"把 Date 塞进标注成 string 的字段"。
     *   这个不一致在 API 里**看不出来** —— `JSON.stringify` 会自动把 Date 转成 ISO,
     *   响应长得完全正常; 只有**服务端内部**再碰这个字段才炸。
     *   实测踩过: 巡检里 `v.expiresAt.slice(0,10)` 抛 "slice is not a function",
     *   而同一时刻接口返回的 expiresAt 是一串好好的 ISO 时间。
     */
    const expiresAt: string | null = row?.expires_at ? new Date(row.expires_at).toISOString() : null;
    const days = daysUntil(expiresAt);
    return {
      service: def.key,
      label: def.label,
      purpose: def.purpose,
      applyUrl: def.applyUrl,
      shapeHint: def.shapeHint,
      configured,
      source: row ? "db" : envVal ? "env" : "none",
      // ⚠ DB 里没记录但 env 有值时, tail 由**服务端现场算**, 不落库 ——
      //   落库就要把 .env 里的值复制一份进 DB, 那才是真的多一份可泄露的副本
      tail: tailOf(raw),
      issuedAt: row?.issued_at ? new Date(row.issued_at).toISOString() : null,
      expiresAt,
      daysLeft: days,
      status: statusOf(days, configured),
      lastCheckedAt: row?.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
      lastCheckOk: typeof row?.last_check_ok === "boolean" ? row.last_check_ok : null,
      lastCheckNote: String(row?.last_check_note ?? ""),
      note: String(row?.note ?? ""),
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  });
}

export const serviceTokenStore = {
  SERVICES,
  serviceDef,
  effectiveToken,
  restoreServiceTokens,
  saveServiceToken,
  recordTokenCheck,
  clearServiceToken,
  listServiceTokens,
  verifyServiceToken,
  decodeJwtExpiry,
  daysUntil,
  statusOf,
};
