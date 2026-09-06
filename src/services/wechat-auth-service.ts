// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// wechat-auth-service.ts — SocialSci P0-8: 微信扫码登录(ticket 轮询) + 绑定
// 形态对齐(闭源产品交互语义, 原创实现): config→createQrTicket→轮询status→绑定/免注册登录
//   dev/mock 模式: 无 appid/secret 时返回假 ticket, 前端"模拟扫码"按钮走通全流程(UI 标注)
// 安全: ticket 32hex 随机 + 3min TTL; openid 绑定 user 后 ticket 即失效
import { randomUUID, createHash } from "node:crypto";
import { pool } from "../db/pool.js";

export interface WechatConfig { appId: string; appSecret: string; baseUrl: string; enabled: boolean; }

let cachedConfig: WechatConfig | null = null;
async function loadConfig(): Promise<WechatConfig> {
  if (cachedConfig) return cachedConfig;
  let conf: WechatConfig = {
    appId: process.env.WECHAT_APP_ID ?? "",
    appSecret: process.env.WECHAT_APP_SECRET ?? "",
    baseUrl: process.env.WECHAT_BASE_URL ?? "",
    enabled: !!(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET),
  };
  try {
    const r = await pool.query(
      `select value from ai_provider_settings where key='wechat_mp'`);
    if (r.rows[0]?.value) {
      conf = { appId: "", appSecret: "", baseUrl: "", enabled: false, ...(typeof r.rows[0].value === "string" ? JSON.parse(r.rows[0].value) : r.rows[0].value) };
    }
  } catch { /* 表未就绪 */ }
  cachedConfig = conf;
  return conf;
}

export async function setConfig(config: WechatConfig) {
  await pool.query(
    `insert into ai_provider_settings (key, value) values ('wechat_mp', $1)
     on conflict (key) do update set value=$1`,
    [JSON.stringify(config)]);
  cachedConfig = config;
  return { ok: true };
}

export async function getMpConfig(admin = false) {
  const c = await loadConfig();
  return admin ? c : { appId: c.appId, enabled: c.enabled, baseUrl: c.baseUrl, isMock: !c.enabled };
}

export function isMockMode() {
  return !cachedConfig?.enabled;
}

function newTicket(): string { return randomUUID().replace(/-/g, "").slice(0, 32); }

/** 创建扫码 ticket(3min TTL) */
export async function createQrTicket() {
  const cfg = await loadConfig();
  const ticket = newTicket();
  const scene = `qr_${ticket.slice(0, 8)}`;
  await pool.query(
    `insert into wx_login_tickets (ticket, qr_scene) values ($1,$2)`, [ticket, scene]);
  return {
    ticket,
    scene,
    mock: !cfg.enabled,               // 无配置=mock 演示模式
    expiresIn: 180,
    // mock 二维码: 内容即 ticket(前端可用 qrcode 渲染或直接按钮模拟)
    qrPayload: `wxmp-login:${ticket}`,
  };
}

export async function getTicket(ticket: string) {
  const r = await pool.query(
    `select * from wx_login_tickets where ticket=$1 and expires_at > now()`, [ticket]);
  return r.rows[0] ?? null;
}

/** 模拟扫码(仅 mock 模式; 真实模式由微信回调/公众号事件触发) */
export async function mockScan(ticket: string, mockOpenid = "") {
  const t = await getTicket(ticket);
  if (!t) return { ok: false, error: "ticket 无效或已过期" };
  const openid = mockOpenid || `mock_wx_${createHash("sha256").update(ticket + Date.now()).digest("hex").slice(0, 16)}`;
  await pool.query(
    `update wx_login_tickets set status='scanned', openid_tmp=$2 where ticket=$1`, [ticket, openid]);
  return { ok: true, openid };
}

/** 轮询状态 */
export async function pollStatus(ticket: string) {
  const t = await getTicket(ticket);
  if (!t) return { status: "expired" };
  if (t.status === "pending") return { status: "pending" };
  if (t.status === "scanned") {
    // 该 openid 是否已有绑定 → 登录
    const bind = await pool.query(
      `select user_id from user_wechat where openid=$1`, [t.openid_tmp]);
    return { status: "scanned", openid: t.openid_tmp, bound: !!bind.rows.length };
  }
  if (t.status === "bound") {
    const bind = await pool.query(
      `select user_id from user_wechat where openid=$1`, [t.openid_tmp]);
    return { status: "bound", userId: bind.rows[0]?.user_id ?? null, openid: t.openid_tmp };
  }
  return { status: t.status };
}

/** 扫码确认: 绑定到既有账号(登录态) */
export async function bindExisting(ticket: string, userId: string, nickname = "") {
  const t = await getTicket(ticket);
  if (!t) return { ok: false, error: "ticket 无效或已过期" };
  if (t.status !== "scanned" && t.status !== "pending") return { ok: false, error: "ticket 状态异常" };
  const openid = t.openid_tmp || `wx_${createHash("sha256").update(ticket).digest("hex").slice(0, 16)}`;
  await pool.query(
    `insert into user_wechat (openid, user_id, nickname, bound_at) values ($1,$2,$3,now())
     on conflict (openid) do update set user_id=$2, bound_at=now()`,
    [openid, userId, nickname || ""]);
  await pool.query(
    `update wx_login_tickets set status='bound', openid_tmp=$2 where ticket=$1`, [ticket, openid]);
  return { ok: true, openid };
}

/** 免注册登录(扫码新用户): 建账号 username=wx_xxxx, 随机口令; 返回可签发 JWT 的 user */
export async function bindNewUser(ticket: string, nickname = "") {
  const t = await getTicket(ticket);
  if (!t) return { ok: false, error: "ticket 无效或已过期" };
  const openid = t.openid_tmp || `wx_${createHash("sha256").update(ticket).digest("hex").slice(0, 16)}`;
  const uname = `wx_${openid.replace(/^mock_wx_/, "").slice(0, 8)}`;
  const r = await pool.query(
    `insert into users (username, password_hash, role, tenant_id)
     select $1, 'WECHAT_LOGIN', 'user', id from tenants where type='single' limit 1
     on conflict (username) do nothing returning id, role, tenant_id`, [uname]);
  let user = r.rows[0];
  if (!user) {
    const ex = await pool.query(`select id, role, tenant_id from users where username=$1`, [uname]);
    user = ex.rows[0];
  }
  await pool.query(
    `insert into user_wechat (openid, user_id, nickname, bound_at) values ($1,$2,$3,now())
     on conflict (openid) do update set user_id=$2, bound_at=now()`,
    [openid, user.id, nickname || ""]);
  await pool.query(`update wx_login_tickets set status='bound', openid_tmp=$2 where ticket=$1`, [ticket, openid]);
  return { ok: true, user };
}

export async function getBoundWechat(userId: string) {
  const r = await pool.query(`select openid, nickname, bound_at from user_wechat where user_id=$1`, [userId]);
  return r.rows[0] ?? null;
}
