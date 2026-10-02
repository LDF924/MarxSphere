// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// wechat-auth-service.ts — SocialSci P0-8: 微信扫码登录(ticket 轮询) + 绑定
// 形态对齐(参考产品交互语义, 原创实现): config→createQrTicket→轮询status→绑定/免注册登录
//   dev/mock 模式: 无 appid/secret 时返回假 ticket, 前端"模拟扫码"按钮走通全流程(UI 标注)
// 安全: ticket 32hex 随机 + 3min TTL; openid 绑定 user 后 ticket 即失效
import { randomUUID, createHash } from "node:crypto";
import { pool } from "../db/pool.js";

export interface WechatConfig { appId: string; appSecret: string; baseUrl: string; enabled: boolean; }

let cachedConfig: WechatConfig | null = null;
/**
 * 2026-10-02 修正: 原读写的是 `ai_provider_settings(key, value)` —— **本表没有这两列**。
 *   它建表时是 `id text primary key default 'global'` + 固定列(003 迁移), 没有任何
 *   key/value 字段。所以 `select value ... where key='wechat_mp'` 永远抛
 *   `column "value" does not exist`, 被下面的 catch 吞掉 → 表现为"保存了但一直是 mock",
 *   而保存那侧(insert into (key,value))更是直接 500 —— **管理面板的微信配置从来没生效过**。
 *   同型缺陷在 wechat-pay-service 的读侧(那里没有写侧, 所以只是永远读不到)。
 *
 *   改为存进**已有**的 metadata jsonb —— 同一张表的 openaiKeys / appConfig 就是这么放的
 *   (server.ts:13282、13317), 跟着既有约定走比新开一张表好。
 */
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
      `select metadata->'wechatMp' as cfg from ai_provider_settings where id='global'`);
    const v = r.rows[0]?.cfg;
    if (v) {
      conf = { appId: "", appSecret: "", baseUrl: "", enabled: false, ...(typeof v === "string" ? JSON.parse(v) : v) };
    }
  } catch { /* 表未就绪 */ }
  cachedConfig = conf;
  return conf;
}

export async function setConfig(config: WechatConfig) {
  await pool.query(
    `update ai_provider_settings
        set metadata = jsonb_set(coalesce(metadata,'{}'), '{wechatMp}', $1::jsonb), updated_at = now()
      where id = 'global'`,
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

/**
 * 微信公众号连通性自检(2026-10-02)。
 *
 * 由来: 管理面板此前只有一个「已启用 / mock 演示」徽标, 而那个徽标读的是
 *   `wxConf.enabled` —— 那是**配置齐不齐**, 不是**通不通**。appid/secret 填错、
 *   被停用、IP 白名单没加、access_token 已被别的进程刷新掉, 这四种情况下
 *   徽标照样显示"已启用", 用户要到真去扫码时才发现是坏的。
 *
 * 做两件事, 而且**分开报告**:
 *   ① 能不能换到 access_token(这一步就能覆盖上面四种故障)
 *   ② 能不能拉一次用户标签列表(证明 token 确实有权限, 不只是格式对)
 *   ②失败但①成功是**有意义的结果**: token 拿到了但账号没有该接口权限, 报出来比笼统说"失败"有用。
 */
export async function testWechatConnectivity(): Promise<{
  ok: boolean;
  configured: boolean;
  baseUrl: string;
  appId: string;
  mode: "mock" | "live";
  tokenOk: boolean;
  apiOk: boolean;
  steps: Array<{ name: string; ok: boolean; detail: string }>;
}> {
  const cfg = await loadConfig();
  const steps: Array<{ name: string; ok: boolean; detail: string }> = [];
  const configured = Boolean(cfg.appId && cfg.appSecret && cfg.baseUrl);

  if (!configured) {
    steps.push({ name: "配置", ok: false, detail: "未配置 AppID / AppSecret / 接口基址 —— 当前运行在 mock 演示模式，扫码登录走的是本地假票据。" });
    return { ok: false, configured: false, baseUrl: cfg.baseUrl, appId: cfg.appId, mode: "mock", tokenOk: false, apiOk: false, steps };
  }
  steps.push({ name: "配置", ok: true, detail: `AppID ${cfg.appId}，接口基址 ${cfg.baseUrl}` });

  // ① 换 access_token —— 微信公众号这一步就能同时验证 appid/secret 是否匹配、IP 是否在白名单
  let token = "";
  let tokenOk = false;
  try {
    const url = `${cfg.baseUrl.replace(/\/$/, "")}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cfg.appId)}&secret=${encodeURIComponent(cfg.appSecret)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const d = await r.json() as { access_token?: string; errcode?: number; errmsg?: string };
    if (d.access_token) {
      token = d.access_token;
      tokenOk = true;
      steps.push({ name: "获取 access_token", ok: true, detail: "已换到 access_token，凭据有效。" });
    } else {
      // errcode 要原样带出来 —— 40164(IP 不在白名单) 与 40001(secret 错) 的处置完全不同,
      // 只报"失败"会让用户去改错的地方
      steps.push({ name: "获取 access_token", ok: false, detail: `微信返回 errcode=${d.errcode ?? "?"} ${d.errmsg ?? ""}`.trim() });
    }
  } catch (e) {
    steps.push({ name: "获取 access_token", ok: false, detail: `请求失败: ${String((e as Error).message).slice(0, 140)}` });
  }

  // ② 拿 token 调一个只读接口 —— 证明它有权限, 不只是拿到了一个字符串
  let apiOk = false;
  if (tokenOk) {
    try {
      const r = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/cgi-bin/tags/get?access_token=${encodeURIComponent(token)}`,
        { signal: AbortSignal.timeout(8000) });
      const d = await r.json() as { tags?: unknown[]; errcode?: number; errmsg?: string };
      if (Array.isArray(d.tags)) {
        apiOk = true;
        steps.push({ name: "调用只读接口", ok: true, detail: `标签列表可读（${d.tags.length} 个标签）。` });
      } else {
        steps.push({ name: "调用只读接口", ok: false, detail: `errcode=${d.errcode ?? "?"} ${d.errmsg ?? ""} —— token 有效但该接口不可用，检查账号类型与接口权限。`.trim() });
      }
    } catch (e) {
      steps.push({ name: "调用只读接口", ok: false, detail: `请求失败: ${String((e as Error).message).slice(0, 140)}` });
    }
  }

  return {
    ok: tokenOk,
    configured: true,
    baseUrl: cfg.baseUrl,
    // 只回前 6 位 —— 面板要展示"测的是哪个号", 但 AppSecret 这类东西不进日志/响应
    appId: cfg.appId.slice(0, 6) + (cfg.appId.length > 6 ? "…" : ""),
    mode: "live",
    tokenOk,
    apiOk,
    steps,
  };
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
