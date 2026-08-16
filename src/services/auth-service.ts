// auth-service.ts — 商业化阶段1: 用户认证(注册/登录/JWT) + 租户 + admin角色
// V388+ 多用户商业化
// 密码: bcrypt 哈希 | 会话: JWT (jsonwebtoken)
// admin: 持有 admin 角色 → 可远程管理(替代仅本机)
import { randomUUID, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../db/pool.js";

// V389修复: JWT_SECRET 无默认公开值 — 未设时用随机生成(防伪造admin token), 提示显式设置
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const rnd = randomUUID() + randomUUID() + randomUUID();
  console.error("[auth] 警告: JWT_SECRET 未设置, 已用随机密钥(重启后会话失效) — 生产环境必须设置 JWT_SECRET");
  return rnd;
})();
const JWT_EXPIRES = "7d";
const PUBLIC_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const ADMIN_USER_ID = "00000000-0000-0000-0000-000000000002";

export interface AuthUser {
  id: string;
  username: string;
  role: "user" | "admin";
  tenantId: string;
  plan: string;
  balanceCents: number;
  llmProvider: "platform" | "byok";
}

export interface SessionPayload {
  uid: string;
  username: string;
  role: string;
  tenantId: string;
}

// ─── 注册（单用户租户） ───
export async function register(username: string, password: string, email?: string): Promise<{ ok: boolean; error?: string; user?: AuthUser }> {
  const name = (username || "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,30}$/.test(name)) return { ok: false, error: "用户名需3-30位字母数字下划线" };
  if (!password || password.length < 6) return { ok: false, error: "密码至少6位" };
  const mail = (email || "").trim().toLowerCase();
  if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return { ok: false, error: "邮箱格式不正确" };
  const hash = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 创建单用户租户
    const tenantId = randomUUID();
    await client.query("insert into tenants (id, type, name, owner_user_id) values ($1, 'single', $2, null)", [tenantId, name]);
    const userId = randomUUID();
    await client.query(
      "insert into users (id, username, password_hash, role, tenant_id, plan, llm_provider, email) values ($1,$2,$3,'user',$4,'free','platform',$5)",
      [userId, name, hash, tenantId, mail || null]
    );
    await client.query("update tenants set owner_user_id = $1 where id = $2", [userId, tenantId]);
    await client.query("COMMIT");
    return { ok: true, user: { id: userId, username: name, role: "user", tenantId, plan: "free", balanceCents: 0, llmProvider: "platform" } };
  } catch (e: any) {
    await client.query("ROLLBACK");
    if (String(e?.message || "").includes("duplicate")) return { ok: false, error: "用户名已存在" };
    return { ok: false, error: "注册失败: " + String(e?.message || e).substring(0, 100) };
  } finally { client.release(); }
}

// ─── 登录 ───
export async function login(username: string, password: string): Promise<{ ok: boolean; error?: string; token?: string; user?: AuthUser }> {
  const name = (username || "").trim().toLowerCase();
  const r = await pool.query("select id, username, password_hash, role, tenant_id, plan, balance_cents, llm_provider, status from users where username = $1", [name]);
  if (r.rows.length === 0) return { ok: false, error: "用户名或密码错误" };
  const row = r.rows[0];
  // admin 初始化密码处理
  if (row.password_hash === "INIT_PENDING") {
    if (password === (process.env.ADMIN_INIT_PASSWORD || "")) {
      await pool.query("update users set password_hash = $1 where id = $2", [await bcrypt.hash(password, 10), row.id]);
    } else {
      return { ok: false, error: "管理员初始密码未设置(需 ADMIN_INIT_PASSWORD 环境变量)" };
    }
  }
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return { ok: false, error: "用户名或密码错误" };
  // V390: 禁用用户拒绝登录
  if (row.status === "disabled") return { ok: false, error: "账号已被禁用，请联系管理员" };
  const payload: SessionPayload = { uid: row.id, username: row.username, role: row.role, tenantId: row.tenant_id };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  return {
    ok: true, token,
    user: { id: row.id, username: row.username, role: row.role, tenantId: row.tenant_id, plan: row.plan, balanceCents: Number(row.balance_cents), llmProvider: row.llm_provider },
  };
}

// ─── JWT 验证 ───
export function verifyToken(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as SessionPayload;
    return decoded;
  } catch { return null; }
}

// ─── 按用户ID取用户（供中间件挂上下文） ───
export async function getUserById(userId: string): Promise<AuthUser | null> {
  const r = await pool.query("select id, username, role, tenant_id, plan, balance_cents, llm_provider from users where id = $1", [userId]);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return { id: row.id, username: row.username, role: row.role, tenantId: row.tenant_id, plan: row.plan, balanceCents: Number(row.balance_cents), llmProvider: row.llm_provider };
}

export { PUBLIC_TENANT_ID, ADMIN_USER_ID, JWT_SECRET };

// ─── V389: 企业租户（企业注册/邀请成员/成员共享） ───
/** 注册企业租户（企业版: 建 enterprise 租户 + 当前用户为 owner） */
export async function registerEnterprise(userId: string, companyName: string): Promise<{ ok: boolean; error?: string; tenantId?: string }> {
  if (!companyName || companyName.trim().length < 2) return { ok: false, error: "企业名称至少2字" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 用户必须是 single 租户才能升级为企业（一个用户不能属于两个租户）
    const u = await client.query("select tenant_id, plan from users where id = $1 for update", [userId]);
    if (u.rows.length === 0) { await client.query("ROLLBACK"); return { ok: false, error: "用户不存在" }; }
    const oldTenant = u.rows[0].tenant_id;
    const tenantId = randomUUID();
    await client.query("insert into tenants (id, type, name, owner_user_id) values ($1, 'enterprise', $2, $3)", [tenantId, companyName.trim(), userId]);
    await client.query("insert into tenant_members (tenant_id, user_id, role) values ($1, $2, 'owner')", [tenantId, userId]);
    await client.query("update users set tenant_id = $1 where id = $2", [tenantId, userId]);
    // 原 single 租户清理
    await client.query("delete from tenants where id = $1", [oldTenant]);
    await client.query("COMMIT");
    return { ok: true, tenantId };
  } catch (e: any) {
    await client.query("ROLLBACK");
    return { ok: false, error: String(e?.message || e).substring(0, 80) };
  } finally { client.release(); }
}

/** 邀请成员（企业 owner/admin 才能邀请, 被邀请者需已注册） */
export async function inviteMember(inviterUserId: string, inviteeUsername: string, role = "member"): Promise<{ ok: boolean; error?: string }> {
  const name = (inviteeUsername || "").trim().toLowerCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inviter = await client.query("select tm.tenant_id, tm.role from tenant_members tm where tm.user_id = $1", [inviterUserId]);
    if (inviter.rows.length === 0) { await client.query("ROLLBACK"); return { ok: false, error: "无权操作" }; }
    if (!["owner", "admin"].includes(inviter.rows[0].role)) { await client.query("ROLLBACK"); return { ok: false, error: "仅企业管理员可邀请" }; }
    const tenantId = inviter.rows[0].tenant_id;
    const invitee = await client.query("select id from users where username = $1", [name]);
    if (invitee.rows.length === 0) { await client.query("ROLLBACK"); return { ok: false, error: "被邀请用户不存在（需先注册）" }; }
    await client.query(
      "insert into tenant_invites (tenant_id, inviter_user_id, invitee_username, role) values ($1,$2,$3,$4)",
      [tenantId, inviterUserId, name, role]
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (e: any) {
    await client.query("ROLLBACK");
    return { ok: false, error: String(e?.message || e).substring(0, 80) };
  } finally { client.release(); }
}

/** 待接受的邀请列表（用户视角） */
export async function listPendingInvites(username: string): Promise<any[]> {
  const r = await pool.query(
    `select ti.id, ti.tenant_id, t.name as company, ti.role from tenant_invites ti
     join tenants t on t.id = ti.tenant_id
     where ti.invitee_username = $1 and ti.status = 'pending'`,
    [username]
  );
  return r.rows;
}

/** 接受邀请（加入企业租户） */
export async function acceptInvite(userId: string, username: string, inviteId: string): Promise<{ ok: boolean; error?: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inv = await client.query("select tenant_id, role from tenant_invites where id = $1 and invitee_username = $2 and status = 'pending'", [inviteId, username]);
    if (inv.rows.length === 0) { await client.query("ROLLBACK"); return { ok: false, error: "邀请不存在或已处理" }; }
    const { tenant_id, role } = inv.rows[0];
    const u = await client.query("select tenant_id from users where id = $1", [userId]);
    const oldTenant = u.rows[0].tenant_id;
    await client.query("update users set tenant_id = $1 where id = $2", [tenant_id, userId]);
    await client.query("insert into tenant_members (tenant_id, user_id, role) values ($1,$2,$3) on conflict do nothing", [tenant_id, userId, role]);
    await client.query("update tenant_invites set status = 'accepted' where id = $1", [inviteId]);
    await client.query("delete from tenants where id = $1", [oldTenant]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (e: any) {
    await client.query("ROLLBACK");
    return { ok: false, error: String(e?.message || e).substring(0, 80) };
  } finally { client.release(); }
}

/** 企业成员列表 */
export async function listTenantMembers(tenantId: string): Promise<any[]> {
  const r = await pool.query(
    `select u.username, u.role, tm.role as member_role from tenant_members tm
     join users u on u.id = tm.user_id where tm.tenant_id = $1`,
    [tenantId]
  );
  return r.rows;
}

// ─── BYOK: 用户自带 LLM key 的 AES 加密存储 ───
const BYOK_SECRET = process.env.BYOK_ENCRYPTION_KEY || (JWT_SECRET + "-byok");
const BYOK_IV = createHash("sha256").update(BYOK_SECRET).digest().subarray(0, 16);

export function encryptByokKey(plain: string): string {
  const cipher = createCipheriv("aes-256-cbc", createHash("sha256").update(BYOK_SECRET).digest(), BYOK_IV);
  return cipher.update(plain, "utf8", "hex") + cipher.final("hex");
}
export function decryptByokKey(encrypted: string): string | null {
  try {
    const decipher = createDecipheriv("aes-256-cbc", createHash("sha256").update(BYOK_SECRET).digest(), BYOK_IV);
    return decipher.update(encrypted, "hex", "utf8") + decipher.final("utf8");
  } catch { return null; }
}

/** 设置用户的 BYOK key（加密存储 + 切换 llm_provider） */
export async function setByokKey(userId: string, apiKey: string, provider: "platform" | "byok"): Promise<{ ok: boolean; error?: string }> {
  if (provider === "byok" && (!apiKey || apiKey.trim().length < 10)) return { ok: false, error: "API Key 无效" };
  const encrypted = provider === "byok" ? encryptByokKey(apiKey.trim()) : null;
  await pool.query("update users set byok_key_encrypted = $2, llm_provider = $3 where id = $1", [userId, encrypted, provider]);
  return { ok: true };
}

/** 获取用户的 LLM 端点配置（BYOK 用户返回用户 key, 否则 null 表示用平台 key） */
export async function getUserLlmConfig(userId: string): Promise<{ provider: "platform" | "byok"; apiKey: string | null }> {
  const r = await pool.query("select llm_provider, byok_key_encrypted from users where id = $1", [userId]);
  if (r.rows.length === 0) return { provider: "platform", apiKey: null };
  const row = r.rows[0];
  if (row.llm_provider === "byok" && row.byok_key_encrypted) {
    return { provider: "byok", apiKey: decryptByokKey(row.byok_key_encrypted) };
  }
  return { provider: row.llm_provider || "platform", apiKey: null };
}

// ─── V390: 运营管理 — admin 用户操作（禁用/调余额/重置密码） ───

/** 启用/禁用用户（admin 操作; 禁用后登录被拒, 已签发 token 不失效） */
export async function setUserStatus(adminUserId: string, targetUserId: string, status: "active" | "disabled"): Promise<{ ok: boolean; error?: string }> {
  if (targetUserId === adminUserId) return { ok: false, error: "不能禁用自己" };
  if (targetUserId === ADMIN_USER_ID) return { ok: false, error: "不能操作系统管理员" };
  await pool.query("update users set status = $1 where id = $2", [status, targetUserId]);
  return { ok: true };
}

/** admin 调整用户余额（分, 可正可负） */
export async function adminAdjustBalance(adminUserId: string, targetUserId: string, deltaCents: number): Promise<{ ok: boolean; error?: string; balanceCents?: number }> {
  if (targetUserId === adminUserId) return { ok: false, error: "不能给自己调余额" };
  if (targetUserId === ADMIN_USER_ID) return { ok: false, error: "不能操作系统管理员" };
  if (!Number.isFinite(deltaCents) || deltaCents === 0) return { ok: false, error: "调整金额需非零" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query("select id from users where id = $1 for update", [targetUserId]);
    if (u.rows.length === 0) { await client.query("ROLLBACK"); return { ok: false, error: "用户不存在" }; }
    const r = await client.query("update users set balance_cents = balance_cents + $1 where id = $2 returning balance_cents", [deltaCents, targetUserId]);
    await client.query(
      `insert into billing_records (user_id, type, amount_cents, description) values ($1, 'admin_adjust', $2, $3)`,
      [targetUserId, -deltaCents, `管理员调整余额 ${(Math.abs(deltaCents) / 100).toFixed(2)} 元`]
    );
    await client.query("COMMIT");
    return { ok: true, balanceCents: Number(r.rows[0]?.balance_cents || 0) };
  } catch (e: any) {
    await client.query("ROLLBACK");
    return { ok: false, error: String(e?.message || e).substring(0, 80) };
  } finally { client.release(); }
}

/** admin 重置用户密码（免旧密码; 记录审计在调用方） */
export async function adminResetPassword(adminUserId: string, targetUserId: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
  if (targetUserId === ADMIN_USER_ID) return { ok: false, error: "不能操作系统管理员" };
  if (!newPassword || newPassword.length < 6) return { ok: false, error: "密码至少6位" };
  await pool.query("update users set password_hash = $1 where id = $2", [await bcrypt.hash(newPassword, 10), targetUserId]);
  return { ok: true };
}

// ─── V390: 邮箱找回密码 ───
// 流程: 绑定邮箱(注册后设置) → 忘记密码申请(发邮件重置链接) → 重置密码(token 一次性, 15分钟)
// 邮件经 email-service 免费 SMTP 发送; 未配置 SMTP 时返回可提示的降级错误

/** 绑定/更新邮箱（JWT 用户调用, 需登录后设置） */
export async function setEmail(userId: string, email: string): Promise<{ ok: boolean; error?: string }> {
  const mail = (email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return { ok: false, error: "邮箱格式不正确" };
  try {
    await pool.query("update users set email = $1 where id = $2", [mail, userId]);
    return { ok: true };
  } catch (e: any) {
    if (String(e?.message || "").includes("duplicate") || String(e?.message || "").includes("unique")) {
      return { ok: false, error: "该邮箱已被其他账号使用" };
    }
    return { ok: false, error: "绑定失败: " + String(e?.message || e).substring(0, 80) };
  }
}

/** 申请密码重置：查邮箱 → 生成一次性 token → 发重置邮件（防枚举: 邮箱不存在也返回 ok 不泄露） */
export async function requestPasswordReset(email: string, baseUrl: string): Promise<{ ok: boolean; error?: string; smtpError?: string }> {
  const mail = (email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return { ok: false, error: "邮箱格式不正确" };
  const r = await pool.query("select id, username, email from users where email = $1", [mail]);
  if (r.rows.length === 0) return { ok: true };  // 防枚举: 不暴露邮箱是否存在
  const user = r.rows[0];
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  // 同一用户旧 token 全部作废（同一时间只保留一个有效 token）
  await pool.query("update password_reset_tokens set used_at = now() where user_id = $1 and used_at is null", [user.id]);
  await pool.query(
    "insert into password_reset_tokens (user_id, token_hash, expires_at) values ($1,$2, now() + interval '15 minutes')",
    [user.id, tokenHash]
  );
  const resetPath = `/reset-password?token=${token}`;
  const resetUrl = (baseUrl || "http://localhost:4173") + resetPath;
  const { sendResetEmail } = await import("./email-service.js");
  const sent = await sendResetEmail(mail, resetUrl, user.username);
  if (!sent.ok) return { ok: false, smtpError: sent.error };
  return { ok: true };
}

/** 校验 token 并重置密码（成功即作废, 一次性） */
export async function resetPassword(token: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
  if (!token || token.length < 32) return { ok: false, error: "重置链接无效" };
  if (!newPassword || newPassword.length < 6) return { ok: false, error: "密码至少6位" };
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `select user_id from password_reset_tokens
       where token_hash = $1 and used_at is null and expires_at > now()
       order by created_at desc limit 1`,
      [tokenHash]
    );
    if (r.rows.length === 0) { await client.query("ROLLBACK"); return { ok: false, error: "重置链接无效或已过期（请重新申请）" }; }
    const userId = r.rows[0].user_id;
    await client.query("update users set password_hash = $1 where id = $2", [await bcrypt.hash(newPassword, 10), userId]);
    await client.query("update password_reset_tokens set used_at = now() where token_hash = $1", [tokenHash]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (e: any) {
    await client.query("ROLLBACK");
    return { ok: false, error: "重置失败: " + String(e?.message || e).substring(0, 80) };
  } finally { client.release(); }
}

// ─── V389: 租户数据隔离（MVP） ───// 校验: 用户请求的 sourceId 是否可访问（公共共享租户 或 用户自己租户）
export async function verifySourceAccess(userId: string, sourceId: string): Promise<{ allowed: boolean; tenantId: string | null }> {
  // 非 UUID 的 sourceId（系统内置/兼容）→ 放行
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceId)) {
    return { allowed: true, tenantId: null };
  }
  // 查 source 归属租户
  const s = await pool.query("select tenant_id from sources where id = $1", [sourceId]);
  if (s.rows.length === 0) {
    // source 不存在 — 可能是系统内置 source（放行, 兼容现有评测/内部）
    return { allowed: true, tenantId: null };
  }
  const srcTenant = s.rows[0].tenant_id;
  // 公共共享租户 → 所有用户可访问
  if (srcTenant === PUBLIC_TENANT_ID) return { allowed: true, tenantId: srcTenant };
  // 用户自己租户 → 可访问
  const u = await pool.query("select tenant_id from users where id = $1", [userId]);
  if (u.rows.length > 0 && u.rows[0].tenant_id === srcTenant) return { allowed: true, tenantId: srcTenant };
  return { allowed: false, tenantId: srcTenant };
}
