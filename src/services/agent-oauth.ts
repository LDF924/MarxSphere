// agent-oauth.ts — 架构B: OAuth2 授权流（对齐 Codex/DSH 外部服务集成）
// authorization_code 流: 开始授权→跳转→回调→存 token（AES 加密）→刷新
// 首个适配器: GitHub（读公开仓库/issue）; 接口可扩展 feishu/notion 等
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { pool } from "../db/pool.js";

// ═══ token 加密（AES-256-GCM; 密钥来自 AGENT_OAUTH_SECRET 或派生）═══
function oauthKey(): Buffer {
  const secret = process.env.AGENT_OAUTH_SECRET || "sag-agent-oauth-dev-secret-change-me";
  return Buffer.from(secret.padEnd(32, "x").slice(0, 32));
}

export function encryptToken(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", oauthKey(), iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

export function decryptToken(value: string): string {
  const [ivB, tagB, dataB] = value.split(".");
  const decipher = createDecipheriv("aes-256-gcm", oauthKey(), Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB, "base64")), decipher.final()]).toString("utf8");
}

// ═══ Provider 配置 ═══
export interface OAuthProviderConfig {
  id: string;
  label: string;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  /** 从用户信息 API 提取账号标识 */
  accountFrom: (userInfo: any) => string;
  /** 授权后是否拉取用户信息（验证 token） */
  userInfoUrl?: string;
}

const providers = new Map<string, OAuthProviderConfig>();

/** 注册 provider（适配器模式: 新服务=新 config） */
export function registerOAuthProvider(config: OAuthProviderConfig): void {
  providers.set(config.id, config);
}

// GitHub 适配器（默认注册; AGENT_GITHUB_CLIENT_ID/SECRET 配置）
if (process.env.AGENT_GITHUB_CLIENT_ID) {
  registerOAuthProvider({
    id: "github", label: "GitHub",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientId: process.env.AGENT_GITHUB_CLIENT_ID,
    clientSecret: process.env.AGENT_GITHUB_CLIENT_SECRET || "",
    scope: "repo read:user",
    userInfoUrl: "https://api.github.com/user",
    accountFrom: (u) => String(u?.login || "unknown"),
  });
}

// 飞书适配器（自建应用; AGENT_FEISHU_APP_ID/APP_SECRET 配置）
// 坑: 飞书回调需要 redirect_uri 精确匹配应用配置
if (process.env.AGENT_FEISHU_APP_ID) {
  registerOAuthProvider({
    id: "feishu", label: "飞书",
    authUrl: "https://open.feishu.cn/open-apis/authen/v1/authorize",
    tokenUrl: "https://open.feishu.cn/open-apis/authen/v1/oidc/access_token",
    clientId: process.env.AGENT_FEISHU_APP_ID,
    clientSecret: process.env.AGENT_FEISHU_APP_SECRET || "",
    scope: "contact:user.base:readonly",
    userInfoUrl: "https://open.feishu.cn/open-apis/authen/v1/user_info",
    accountFrom: (u) => String(u?.data?.name || u?.name || u?.en_name || "unknown"),
  });
}

// Notion 适配器（标准 OAuth2; AGENT_NOTION_CLIENT_ID/SECRET 配置）
if (process.env.AGENT_NOTION_CLIENT_ID) {
  registerOAuthProvider({
    id: "notion", label: "Notion",
    authUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    clientId: process.env.AGENT_NOTION_CLIENT_ID,
    clientSecret: process.env.AGENT_NOTION_CLIENT_SECRET || "",
    scope: "",
    userInfoUrl: "https://api.notion.com/v1/users/me",
    accountFrom: (u) => String(u?.name || u?.id || "unknown"),
  });
}

/** 开始授权: 返回授权 URL（含 state 防 CSRF） */
export async function startOAuthFlow(providerId: string, redirectBase: string): Promise<{ url: string; state: string } | null> {
  const p = providers.get(providerId);
  if (!p) return null;
  const state = randomBytes(16).toString("hex");
  // state 暂存内存（回调校验; 生产可用 DB/会话）
  pendingStates.set(state, { providerId, redirectBase });
  const params = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: `${redirectBase}/api/agent/oauth/${providerId}/callback`,
    scope: p.scope,
    state,
    response_type: "code",
  });
  return { url: `${p.authUrl}?${params}`, state };
}

const pendingStates = new Map<string, { providerId: string; redirectBase: string }>();

/** 回调: 换 token → 存库（加密）→ 拉用户信息确认账号 */
export async function handleOAuthCallback(providerId: string, code: string, state: string, userId?: string): Promise<{ ok: boolean; account?: string; error?: string }> {
  const inputUserId = userId ?? null;
  const pending = pendingStates.get(state);
  pendingStates.delete(state);
  const p = providers.get(providerId);
  if (!p) return { ok: false, error: "provider 未注册" };
  if (!pending) return { ok: false, error: "state 校验失败（CSRF 防护）" };
  try {
    // 换 token（GitHub 需 Accept: application/json）
    const tokenRes = await fetch(p.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: p.clientId, client_secret: p.clientSecret,
        code, state, redirect_uri: `${pending.redirectBase}/api/agent/oauth/${providerId}/callback`,
      }),
    });
    const t = await tokenRes.json();
    if (!t.access_token) return { ok: false, error: `换 token 失败: ${t.error_description || t.error || "未知"}` };
    // 拉用户信息 → 账号标识
    let account = "unknown";
    if (p.userInfoUrl) {
      const userRes = await fetch(p.userInfoUrl, { headers: { Authorization: `Bearer ${t.access_token}` } });
      const userInfo = await userRes.json().catch(() => ({}));
      account = p.accountFrom(userInfo);
    }
    const expiresAt = t.expires_in ? new Date(Date.now() + Number(t.expires_in) * 1000) : null;
    await pool.query(
      `insert into agent_oauth_tokens (provider, account, access_token, refresh_token, expires_at, scope, user_id, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7, now())
       on conflict (provider, account, user_id) do update set
         access_token = excluded.access_token, refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at, scope = excluded.scope, updated_at = now()`,
      [providerId, account, encryptToken(String(t.access_token)), t.refresh_token ? encryptToken(String(t.refresh_token)) : null, expiresAt, String(t.scope || p.scope), inputUserId]
    );
    return { ok: true, account };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 取 token（自动刷新; 服务端内部用; userId 隔离: 传 userId 只取该用户 token） */
export async function getOAuthToken(providerId: string, account?: string, userId?: string): Promise<{ accessToken: string; account: string } | null> {
  try {
    const r = userId
      ? account
        ? await pool.query(`select * from agent_oauth_tokens where provider = $1 and account = $2 and user_id = $3`, [providerId, account, userId])
        : await pool.query(`select * from agent_oauth_tokens where provider = $1 and user_id = $2 order by updated_at desc limit 1`, [providerId, userId])
      : account
        ? await pool.query(`select * from agent_oauth_tokens where provider = $1 and account = $2`, [providerId, account])
        : await pool.query(`select * from agent_oauth_tokens where provider = $1 order by updated_at desc limit 1`, [providerId]);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    // 过期且可刷新 → 刷新
    if (row.expires_at && new Date(row.expires_at) < new Date() && row.refresh_token) {
      const p = providers.get(providerId);
      if (p) {
        try {
          const refreshRes = await fetch(p.tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              client_id: p.clientId, client_secret: p.clientSecret,
              grant_type: "refresh_token", refresh_token: decryptToken(row.refresh_token),
            }),
          });
          const rt = await refreshRes.json();
          if (rt.access_token) {
            await pool.query(
              `update agent_oauth_tokens set access_token = $3, refresh_token = $4, expires_at = $5, updated_at = now()
               where provider = $1 and account = $2`,
              [providerId, row.account, encryptToken(String(rt.access_token)), rt.refresh_token ? encryptToken(String(rt.refresh_token)) : row.refresh_token,
               rt.expires_in ? new Date(Date.now() + Number(rt.expires_in) * 1000) : null]
            );
            return { accessToken: String(rt.access_token), account: row.account };
          }
        } catch { /* 刷新失败 → 用旧 token（调用方会收到 401） */ }
      }
    }
    return { accessToken: decryptToken(row.access_token), account: row.account };
  } catch { return null; }
}

/** 已授权账号列表（脱敏; userId 隔离过滤） */
export async function listOAuthAccounts(userId?: string): Promise<Array<{ provider: string; account: string; scope?: string; expiresAt?: Date; userId?: string }>> {
  try {
    const r = userId
      ? await pool.query(`select provider, account, scope, expires_at, user_id from agent_oauth_tokens where user_id = $1 order by provider, account`, [userId])
      : await pool.query(`select provider, account, scope, expires_at, user_id from agent_oauth_tokens order by provider, account`);
    return r.rows.map((row: any) => ({ provider: row.provider, account: row.account, scope: row.scope, expiresAt: row.expires_at, userId: row.user_id }));
  } catch { return []; }
}

/** 登出（删除 token; userId 隔离） */
export async function revokeOAuthAccount(providerId: string, account: string, userId?: string): Promise<boolean> {
  const r = userId
    ? await pool.query(`delete from agent_oauth_tokens where provider = $1 and account = $2 and user_id = $3`, [providerId, account, userId])
    : await pool.query(`delete from agent_oauth_tokens where provider = $1 and account = $2`, [providerId, account]);
  return (r.rowCount || 0) > 0;
}

export const agentOAuthService = {
  registerOAuthProvider, startOAuthFlow, handleOAuthCallback,
  getOAuthToken, listOAuthAccounts, revokeOAuthAccount,
};
