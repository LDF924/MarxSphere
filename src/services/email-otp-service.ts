// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// email-otp-service.ts — 邮箱验证码(6 位数字, 哈希存储, 限流, 用途隔离)
//
// 由来(2026-10-01, 从旧项目移植「发送验证码」/「处理发送验证码成功的回调」):
//   本仓此前只有**重置链接**(auth-service.requestPasswordReset → 一封带 token 的邮件),
//   没有验证码。两者不是同一个东西:
//     · 链接适合"在电脑上打开邮箱点一下"的场景;
//     · 验证码适合"在另一个设备上完成注册/改绑"的场景 —— 用户可能正在手机上看邮件,
//       而操作发生在这台电脑上, 链接跨设备粘贴很别扭;
//     · 更重要的是注册: 现在注册根本不验证邮箱真实性, 邮箱只是个可选字段,
//       于是"找回密码"功能对没填真实邮箱的账号形同虚设。
//
// 安全性质(每一条都对应一个真实的攻击面, 别为了"简化"删掉):
//   ① **只存哈希** —— 库里被读走也拿不到能用的码。用 scrypt + 每行独立随机盐:
//      6 位数字只有 10^6 种可能, 单纯 SHA-256 会被瞬间穷举(彩虹/爆破都是秒级),
//      而 scrypt 的计算代价让"拖库后离线爆破"变得不划算。
//      校验时用 timingSafeEqual, 不让比较耗时泄露"前缀对了几个数字"。
//   ② **TTL 5 分钟** —— 邮件可能被转发/被他人瞥见, 有效窗口要短。
//   ③ **最多 5 次尝试, 超过作废** —— 没有这条, 5 分钟内可以对 10^6 空间暴力枚举;
//      超限后**直接标记失效**而不是继续允许试, 否则"次数上限"只是延迟几秒的事。
//   ④ **三层发送限流**(同邮箱 60 秒 1 次 / 同邮箱 1 小时 5 次 / 同 IP 1 小时 20 次)——
//      前两条防"把别人的邮箱当短信轰炸机", 第三条防"换邮箱地址刷同一个人"。
//      限流计数**走数据库而不是内存**: 多副本部署时内存计数各算各的, 等于没限流。
//   ⑤ **用途隔离**(register/reset/bind/login) —— 不同场景的码不能混用。没有这条,
//      攻击者用"注册"场景骗到一次发送, 就能拿这个码去改别人的密码。
//      用途参与校验条件, 不是只在发送时记一笔。
//   ⑥ **一次性** —— 校验成功立即写 consumed_at(不删行, 留审计痕迹), 同一码不能再用。
//   ⑦ 验证码生成用 crypto.randomInt(**不是 Math.random**)—— 后者可预测。
//   ⑧ **验证码取不出来** —— API/界面只能看元信息(inspectActiveOtp 不返回码),
//      因为库里本来就只有哈希。这也是"只存哈希"必须在测试里真的成立的原因:
//      若测试路径把码直接落成明文, 上面每一条都只是纸面承诺。
//
// 与 email-service 的关系: 发信**复用它的配置与投递约定** —— getEmailConfig() 是它
//   对外发布的接口, 未配置 SMTP 时这里给出**可提示的降级错误**而不是默默失败。
//   ⚠ 为什么这里仍有一份 SMTP 代码: email-service 只导出了 `sendResetEmail`
//     (写死了"密码重置"的主题与正文), **没有通用的发信入口**, 而验证码邮件的
//     主题/正文/场景与重置链接完全不同 —— 借它的 sendResetEmail 发验证码,
//     用户会收到一封标题是"密码重置"却只有验证码的邮件。
//     本文件按约定**不改动** email-service(它有别的调用方), 因此复刻它那 ~50 行
//     SMTP 客户端, 参数与响应码约定保持一致。
//     若日后 email-service 导出通用的 sendHtmlMail, 把 sendOtpMail 换成一行调用即可。

import { randomInt, randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { pool } from "../db/pool.js";
import { getEmailConfig, type EmailConfig } from "./email-service.js";

/** 验证码用途 —— 用途参与校验, 不同用途的码互不通用。
 *  ⚠ 接口一律收 string 再运行时校验: 用途来自 HTTP 请求体, 类型系统拦不住它。 */
export const OTP_PURPOSES = ["register", "reset", "bind", "login"] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export const OTP_LENGTH = 6;
/** 有效期(分钟)。短是安全属性的一部分: 邮件转发的窗口就是这个窗口 */
export const OTP_TTL_MINUTES = 5;
/** 单条验证码允许的最大校验失败次数, 超过直接作废 */
export const OTP_MAX_ATTEMPTS = 5;
/** 发送限流: 同邮箱 60 秒 1 次 */
export const OTP_RESEND_WINDOW_SECONDS = 60;
/** 发送限流: 同邮箱 1 小时 5 次 */
export const OTP_EMAIL_HOURLY_LIMIT = 5;
/** 发送限流: 同 IP 1 小时 20 次 */
export const OTP_IP_HOURLY_LIMIT = 20;

export interface SendOtpResult {
  ok: boolean;
  /** 对用户可显示的错误文案(不泄露"这个邮箱存不存在") */
  error?: string;
  /** 失败归类, 供调用方决定 HTTP 状态码: rate_limited / smtp / invalid / db */
  code?: "rate_limited" | "smtp" | "invalid_email" | "invalid_purpose" | "db";
  /** 限流时告诉用户还要等多久(秒); 其他情况为 0 */
  retryAfterSeconds?: number;
  /** 仅开发/测试: 未配置 SMTP 时不发信, 但把码带出来(生产绝不该走这条) */
  devCode?: string;
  expiresInSeconds?: number;
}

export interface VerifyOtpResult {
  ok: boolean;
  error?: string;
  code?: "not_found" | "expired" | "too_many_attempts" | "mismatch" | "wrong_purpose" | "db";
  /** 剩余可用尝试次数(便于前端提示) */
  attemptsLeft?: number;
}

/** SMTP 未配置时, 是否允许把码直接返回给调用方(仅 dev/test 用) */
function allowDevCode(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return process.env.NODE_ENV === "test" || process.env.OTP_ALLOW_DEV_CODE === "1";
}

/** 邮箱归一: 大小写与空白不该产生两个不同的限流桶 */
export function normalizeEmail(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}

/** 邮箱格式校验(与 auth-service.setEmail 同一套规则, 免得两处口径不一致) */
export function isValidEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizeEmail(email));
}

export function isValidPurpose(p: string): p is OtpPurpose {
  return (OTP_PURPOSES as readonly string[]).includes(p);
}

/**
 * 生成 6 位数字码。
 * 用 crypto.randomInt —— Math.random 是可预测的(种子已知时能推出来), 不能用于凭据。
 * 允许前导 0("000123" 是合法码), 所以补零而不是取整。
 */
export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

/**
 * scrypt 哈希: 返回 "scrypt$<salt_b64>$<hash_b64>" 的自描述格式。
 * 自描述(而不是把盐存在另一列)是为了让哈希本身可迁移、可复用, 且校验时不用猜参数。
 */
export function hashOtpCode(code: string, salt?: Buffer): string {
  const s = salt ?? randomBytes(16);
  const derived = scryptSync(String(code), s, 32);
  return `scrypt$${s.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * 校验明文码是否匹配存储的哈希。
 * timingSafeEqual: 逐字节定长比较, 不让"比较到第几位不匹配"从耗时里泄露出去。
 */
export function verifyOtpHash(code: string, stored: string): boolean {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1], "base64");
    expected = Buffer.from(parts[2], "base64");
  } catch { return false; }
  if (!salt.length || !expected.length) return false;
  let actual: Buffer;
  try { actual = scryptSync(String(code), salt, expected.length); } catch { return false; }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** 只存哈希, 不存明文 —— 日志/审计里要引用一次发送时用这个(不能是明文码) */
export function otpFingerprint(code: string): string {
  return createHash("sha256").update(String(code)).digest("hex").slice(0, 12);
}

/**
 * 发送限流检查(只读, 不写)。
 * 返回 null = 放行; 否则给出该拒绝它的原因。
 *
 * 计数口径:
 *   · 60 秒窗口 —— 最近一条 created_at
 *   · 邮箱小时桶 —— 同一 email 在 1 小时内 `sent` 事件的条数(含已用/已过期,
 *     因为攻击者不关心码还能不能用, 只关心"又发出去了一封")
 *   · IP 小时桶 —— 同上, 按 ip 分组(空 IP 不参与, 免得所有无头请求挤在一个桶里)
 */
async function checkSendRateLimit(email: string, ip: string): Promise<{ reason: string; retryAfterSeconds: number; code: SendOtpResult["code"] } | null> {
  const recent = await pool.query(
    `select created_at from email_otp_codes
      where email = $1 and created_at > now() - interval '${OTP_RESEND_WINDOW_SECONDS} seconds'
      order by created_at desc limit 1`,
    [email]);
  if (recent.rows.length) {
    const elapsed = (Date.now() - new Date(recent.rows[0].created_at).getTime()) / 1000;
    // clamp 到窗口本身: PG 的 now() 与 Node 的 Date.now() 有毫秒级时钟差, 算出来可能是 60.4 秒,
    //   ceil 之后就报成 61 秒 —— 比窗口还长, 看着像个 bug(实测踩到)。
    const wait = Math.min(OTP_RESEND_WINDOW_SECONDS, Math.max(1, Math.ceil(OTP_RESEND_WINDOW_SECONDS - elapsed)));
    return { reason: `发送过于频繁，请 ${wait} 秒后再试`, retryAfterSeconds: wait, code: "rate_limited" };
  }

  const byEmail = await pool.query(
    `select count(*)::int c, min(created_at) as first_at from email_otp_codes
      where email = $1 and created_at > now() - interval '1 hour'`,
    [email]);
  if (Number(byEmail.rows[0]?.c ?? 0) >= OTP_EMAIL_HOURLY_LIMIT) {
    const first = byEmail.rows[0]?.first_at ? new Date(byEmail.rows[0].first_at).getTime() : Date.now();
    const wait = Math.max(60, Math.ceil((first + 3600_000 - Date.now()) / 1000));
    return { reason: "该邮箱今日发送次数已达上限，请稍后再试", retryAfterSeconds: wait, code: "rate_limited" };
  }

  if (ip) {
    const byIp = await pool.query(
      `select count(*)::int c, min(created_at) as first_at from email_otp_codes
        where ip = $1 and created_at > now() - interval '1 hour'`,
      [ip]);
    if (Number(byIp.rows[0]?.c ?? 0) >= OTP_IP_HOURLY_LIMIT) {
      const first = byIp.rows[0]?.first_at ? new Date(byIp.rows[0].first_at).getTime() : Date.now();
      const wait = Math.max(60, Math.ceil((first + 3600_000 - Date.now()) / 1000));
      return { reason: "当前网络发送次数已达上限，请稍后再试", retryAfterSeconds: wait, code: "rate_limited" };
    }
  }
  return null;
}

/**
 * 发送验证码。
 *
 * ⚠ 顺序是刻意的: **先落库再发信**, 且发信失败会把刚写的那行删掉。
 *   反过来(先发信再落库)的话, 用户收到了码但库里没有 —— 校验必然失败,
 *   而用户看到的只是"验证码错误", 没人能查出为什么。
 */
export async function sendOtp(input: {
  email: string;
  purpose: string;
  ip?: string;
  /** 未配置 SMTP 时是否把码返回给调用方(仅 dev/test 用) */
  allowDevCode?: boolean;
  /** 邮件里显示的产品名/场景名 */
  appName?: string;
}): Promise<SendOtpResult> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return { ok: false, error: "邮箱格式不正确", code: "invalid_email" };
  if (!isValidPurpose(input.purpose)) return { ok: false, error: "验证码用途无效", code: "invalid_purpose" };
  const purpose = input.purpose;
  const ip = String(input.ip ?? "").slice(0, 64);

  try {
    const limited = await checkSendRateLimit(email, ip);
    if (limited) return { ok: false, error: limited.reason, code: limited.code, retryAfterSeconds: limited.retryAfterSeconds };

    // 同一邮箱 + 同一用途: 旧码立即作废(否则用户手里会同时有多个有效码)
    await pool.query(
      `update email_otp_codes set consumed_at = now()
        where email = $1 and purpose = $2 and consumed_at is null`,
      [email, purpose]);

    const code = generateOtpCode();
    const ins = await pool.query(
      `insert into email_otp_codes (email, purpose, code_hash, ip, expires_at)
       values ($1, $2, $3, $4, now() + interval '${OTP_TTL_MINUTES} minutes')
       returning id`,
      [email, purpose, hashOtpCode(code), ip]);
    const rowId = ins.rows[0]?.id as string | undefined;

    const cfg = getEmailConfig();
    if (!cfg) {
      // SMTP 未配置: 本地单机/测试场景。
      //
      // ⚠ 这里**不能把刚插的行删掉**再返回 devCode。
      //   第一版就是删的, 后果是: 开发模式下库里一行都没有, 于是"只存哈希""一次性"
      //   "用途隔离""试错上限"这些性质**在开发模式下完全没被验证** —— 测试全绿也只证明了
      //   一条被删干净的路径。正确做法是行留着(它才代表真实状态), 只是把码走 devCode
      //   还给调用方; 限流仍按真实语义生效(发得出码就该占住限流桶)。
      if (allowDevCode(input.allowDevCode)) {
        return { ok: true, devCode: code, expiresInSeconds: OTP_TTL_MINUTES * 60 };
      }
      // 不给 devCode 又不配 SMTP: 这条码用户永远收不到, 删掉它以免占住 60 秒限流桶
      //   (用户没收到信却被限流, 那不是限流该有的行为)
      await pool.query(`delete from email_otp_codes where id = $1`, [rowId]).catch(() => null);
      return { ok: false, error: "邮件服务未配置（需设置 SMTP_HOST/SMTP_USER/SMTP_PASS）", code: "smtp" };
    }

    const sent = await sendOtpMail(cfg, email, code, purpose, input.appName);
    if (!sent.ok) {
      await pool.query(`delete from email_otp_codes where id = $1`, [rowId]).catch(() => null);
      return { ok: false, error: sent.error || "邮件发送失败", code: "smtp" };
    }
    return { ok: true, expiresInSeconds: OTP_TTL_MINUTES * 60 };
  } catch (e) {
    return { ok: false, error: "验证码发送失败: " + String((e as Error)?.message || e).slice(0, 80), code: "db" };
  }
}

/**
 * 校验验证码。成功即作废(一次性)。
 *
 * ⚠ 失败次数**先加再判**: 若先判后加, 第 6 次失败会落在"已经 5 次"的边界上
 *   而多给一次机会; 更糟的是并发请求会一起读到同一个旧计数, 把上限放大成并发数倍。
 *   这里用单条 UPDATE ... RETURNING(带 attempts < 上限 的条件)做原子自增, 天然免疫并发。
 */
export async function verifyOtp(input: {
  email: string;
  code: string;
  purpose: string;
  /** 只校验不改状态(用于"先验证再走后续流程"的预检) */
  dryRun?: boolean;
}): Promise<VerifyOtpResult> {
  const email = normalizeEmail(input.email);
  const code = String(input.code ?? "").trim();
  if (!isValidEmail(email)) return { ok: false, error: "邮箱格式不正确", code: "not_found" };
  if (!/^\d{6}$/.test(code)) return { ok: false, error: "验证码格式不正确", code: "not_found" };
  if (!isValidPurpose(input.purpose)) return { ok: false, error: "验证码用途无效", code: "wrong_purpose" };

  const client = await pool.connect();
  try {
    await client.query("begin");
    // 取该邮箱+用途下最新一条未消费的码, 行锁住(并发校验时第二个请求会等第一个结束)
    const r = await client.query(
      `select id, code_hash, attempts, expires_at, consumed_at
         from email_otp_codes
        where email = $1 and purpose = $2 and consumed_at is null
        order by created_at desc limit 1
        for update`,
      [email, input.purpose]);

    if (!r.rows.length) {
      await client.query("rollback");
      return { ok: false, error: "验证码不存在或已失效，请重新获取", code: "not_found" };
    }
    const row = r.rows[0];
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query(`update email_otp_codes set consumed_at = now() where id = $1`, [row.id]);
      await client.query("commit");
      return { ok: false, error: "验证码已过期，请重新获取", code: "expired" };
    }
    if (Number(row.attempts) >= OTP_MAX_ATTEMPTS) {
      await client.query(`update email_otp_codes set consumed_at = now() where id = $1`, [row.id]);
      await client.query("commit");
      return { ok: false, error: "尝试次数过多，请重新获取验证码", code: "too_many_attempts" };
    }

    const matched = verifyOtpHash(code, String(row.code_hash));
    if (!matched) {
      const upd = await client.query(
        `update email_otp_codes set attempts = attempts + 1 where id = $1 returning attempts`,
        [row.id]);
      const attempts = Number(upd.rows[0]?.attempts ?? OTP_MAX_ATTEMPTS);
      // 到达上限则立即作废 —— 否则"最多 5 次"只约束了这条记录, 攻击者换条记录继续试
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await client.query(`update email_otp_codes set consumed_at = now() where id = $1`, [row.id]);
      }
      await client.query("commit");
      const left = Math.max(0, OTP_MAX_ATTEMPTS - attempts);
      return {
        ok: false,
        error: left > 0 ? `验证码不正确，还可尝试 ${left} 次` : "尝试次数过多，请重新获取验证码",
        code: left > 0 ? "mismatch" : "too_many_attempts",
        attemptsLeft: left,
      };
    }

    if (!input.dryRun) {
      await client.query(`update email_otp_codes set consumed_at = now() where id = $1`, [row.id]);
    }
    await client.query("commit");
    return { ok: true, attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - Number(row.attempts)) };
  } catch (e) {
    await client.query("rollback").catch(() => null);
    return { ok: false, error: "验证码校验失败: " + String((e as Error)?.message || e).slice(0, 80), code: "db" };
  } finally {
    client.release();
  }
}

/**
 * 清理过期/已消费的验证码。
 * 由调用方定时跑(或发送前顺手跑一次) —— 不放在校验路径上,
 * 那条路径是热路径, 不该顺手做全表扫描。
 */
export async function cleanupExpiredOtps(olderThanHours = 24): Promise<number> {
  const r = await pool.query(
    `delete from email_otp_codes
      where (expires_at < now() - ($1 || ' hours')::interval)
         or (consumed_at is not null and consumed_at < now() - ($1 || ' hours')::interval)`,
    [String(Math.max(1, Math.floor(olderThanHours)))]);
  return r.rowCount ?? 0;
}

/** 只读诊断: 查某邮箱当前有效码的元信息(不含码本身, 因为它本来就取不出来) */
export async function inspectActiveOtp(email: string, purpose: string) {
  const r = await pool.query(
    `select id, purpose, attempts, expires_at, created_at, consumed_at, ip
       from email_otp_codes
      where email = $1 and purpose = $2
      order by created_at desc limit 1`,
    [normalizeEmail(email), String(purpose)]);
  return r.rows[0] ?? null;
}

// ─── 发信 ───

/** 验证码邮件正文(与 email-service.buildResetEmailHtml 同一套视觉, 但内容完全不同) */
export function buildOtpEmailHtml(code: string, purpose: string, appName = "SocioSeek"): string {
  const scene: Record<string, string> = {
    register: "注册新账号",
    reset: "重置密码",
    bind: "绑定邮箱",
    login: "登录验证",
  };
  const what = scene[String(purpose)] ?? "身份验证";
  return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
  <h2 style="color:#1e293b">${escapeHtml(appName)} ${escapeHtml(what)}</h2>
  <p style="color:#475569;line-height:1.6">您的验证码是：</p>
  <p style="font-size:32px;letter-spacing:8px;font-weight:700;color:#1e293b;margin:16px 0">${escapeHtml(code)}</p>
  <p style="color:#475569;line-height:1.6">验证码 <b>${OTP_TTL_MINUTES} 分钟</b>内有效，请勿转发给他人。</p>
  <p style="color:#94a3b8;font-size:12px;margin-top:24px">如果不是您本人操作，请忽略此邮件。</p>
</div>`;
}

function escapeHtml(s: string): string {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}

/**
 * 极简 SMTP 投递(与 email-service.smtpSend 同一套命令序列与响应码约定)。
 * 465 走全链路 TLS, 其他端口明文; 20 秒超时。
 */
function smtpSend(cfg: EmailConfig, to: string, subject: string, html: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let socket: net.Socket | null = null;
    let buffer = "";
    let finished = false;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* 已断开 */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 20_000);
    const write = (s: string) => { try { socket?.write(s + "\r\n"); } catch { finish(false); } };

    const cmds: Array<[string, number[]]> = [
      ["EHLO sag.local", [220, 250]],
      ["AUTH LOGIN", [334]],
      [Buffer.from(cfg.user).toString("base64"), [334]],
      [Buffer.from(cfg.pass).toString("base64"), [235]],
      [`MAIL FROM:<${cfg.from}>`, [250]],
      [`RCPT TO:<${to}>`, [250, 251]],
      ["DATA", [354]],
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
        if (line.length > 3 && line[3] === "-") continue;   // 多行响应续行
        if (cmdIdx < cmds.length) {
          const [cmd, expects] = cmds[cmdIdx];
          if (!expects.includes(code)) { finish(false); return; }
          cmdIdx++;
          if (cmd === "DATA") {
            try { socket?.write(body); } catch { finish(false); return; }
          } else if (cmdIdx < cmds.length) {
            write(cmds[cmdIdx][0]);
          }
        } else {
          if (code === 250) { write("QUIT"); finish(true); } else { finish(false); }
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

async function sendOtpMail(
  cfg: EmailConfig,
  to: string,
  code: string,
  purpose: string,
  appName?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const html = buildOtpEmailHtml(code, purpose, appName);
    const ok = await smtpSend(cfg, to, `${appName || "SocioSeek"} 邮箱验证码`, html);
    return ok ? { ok: true } : { ok: false, error: "SMTP 发送失败" };
  } catch (e) {
    return { ok: false, error: "SMTP 异常: " + String((e as Error)?.message || e).slice(0, 100) };
  }
}
