// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// api-token-service.ts — 对外 API 令牌管理（MarxSphere 对外接入基建）
// 对标 Sciverse sv_xxx 模式: 创建时返回明文一次, 库中只存 sha256 hash
// 用途: Claude Code / Codex / 外部客户端通过 Bearer Token 调用 SAG API
// V381+: 权限模型从 3 个扩到 26+ 个 — 每个工作台 tab 一个权限, 设置页可精确勾选
import { createHash, randomBytes } from "node:crypto";
import { pool } from "../db/pool.js";

// ─── 功能权限(与工作台 tab 一一对应) ───
// 兼容旧权限: reason/search/ingest 保留(旧令牌不受影响)
export type TokenPermission =
  | "admin"        // V388: 管理员(远程管理 eval/ai-execute/settings/tokens, 替代仅本机)
  | "reason"       // 推理/对话/Ask 核心(SAG 推理链)
  | "search"       // 检索(兼容旧权限)
  | "ingest"       // 入库(兼容旧权限)
  | "chat"         // 对话
  | "ask"          // Ask检索
  | "literature"   // 文献库
  | "sciverse"     // 外部检索
  | "scenarios"    // 场景
  | "education"    // 教育
  | "empirical"    // 实证研究
  | "truth"        // 知识页
  | "memory"       // 记忆
  | "documents"    // PG入库
  | "graphiti"     // Graphiti入库
  | "cognee"       // Cognee入库
  | "graph"        // 图谱
  | "sources"      // 数据源
  | "policy"       // 政策库
  | "vault"        // 资料库
  | "skills"       // 技能
  | "mcp"          // MCP
  | "docs"         // 文档中心
  | "jobs"         // Jobs
  | "tasks"        // 任务
  | "trace"        // Trace
  | "eval"         // 评测
  | "alerts"       // 告警
  | "inbox"        // Inbox
  | "p2o"          // V395-11: PDF2Obsidian
  | "agent";       // V395-11: Agent控制台/任务

export interface ApiTokenRecord {
  id: string;
  name: string;
  prefix: string;
  permissions: TokenPermission[];
  revoked: boolean;
  last_used_at: string | null;
  created_at: string;
}

// 权限中文名(设置页展示用)
export const PERMISSION_LABELS: Record<string, string> = {
  admin: "管理员(远程管理)", reason: "推理/对话/Ask(核心)", search: "检索(兼容)", ingest: "入库(兼容)",
  chat: "对话", ask: "Ask检索", literature: "文献库", sciverse: "外部检索",
  scenarios: "场景", education: "教育", empirical: "实证研究", truth: "知识页",
  memory: "记忆", documents: "PG入库", graphiti: "Graphiti入库", cognee: "Cognee入库",
  graph: "图谱", sources: "数据源", policy: "政策库", vault: "资料库",
  skills: "技能", mcp: "MCP", docs: "文档中心", jobs: "Jobs", tasks: "任务",
  trace: "Trace", eval: "评测", alerts: "告警", inbox: "Inbox",
};

// 全部可选权限(设置页勾选列表)
export const ALL_PERMISSIONS: TokenPermission[] = [
  "admin", "reason", "search", "ingest", "chat", "ask", "literature", "sciverse", "scenarios",
  "education", "empirical", "truth", "memory", "documents", "graphiti", "cognee",
  "graph", "sources", "policy", "vault", "skills", "mcp", "docs", "jobs", "tasks",
  "trace", "eval", "alerts", "inbox",
  "p2o", "agent",  // V395-11: 导航对齐 — PDF2Obsidian / Agent控制台+任务
];

const VALID_PERMISSIONS = new Set<TokenPermission>(ALL_PERMISSIONS);

/** 生成新令牌: 返回 { token(明文, 仅此一次), record } */
export async function createApiToken(
  name: string,
  permissions: TokenPermission[]
): Promise<{ token: string; record: ApiTokenRecord }> {
  const validPerms = permissions.filter((p) => VALID_PERMISSIONS.has(p));
  if (validPerms.length === 0) validPerms.push("reason");
  const raw = "sag_" + randomBytes(24).toString("hex"); // 48 hex chars
  const hash = sha256(raw);
  const prefix = raw.slice(0, 12) + "..."; // sag_xxxx1234
  const r = await pool.query(
    `insert into api_tokens (name, token_hash, prefix, permissions)
     values ($1, $2, $3, $4) returning id, name, prefix, permissions, revoked, last_used_at, created_at`,
    [name, hash, prefix, validPerms]
  );
  return { token: raw, record: mapRow(r.rows[0]) };
}

/** 列出所有令牌（不含明文） */
export async function listApiTokens(): Promise<ApiTokenRecord[]> {
  const r = await pool.query(
    `select id, name, prefix, permissions, revoked, last_used_at, created_at
     from api_tokens order by created_at desc`
  );
  return r.rows.map(mapRow);
}

/** 撤销令牌 */
export async function revokeApiToken(id: string): Promise<boolean> {
  const r = await pool.query(
    `update api_tokens set revoked = true, updated_at = now() where id = $1 and revoked = false`,
    [id]
  );
  return (r.rowCount ?? 0) > 0;
}

/** 删除令牌（物理删除） */
export async function deleteApiToken(id: string): Promise<boolean> {
  const r = await pool.query(`delete from api_tokens where id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/** 校验 Bearer token: 返回权限列表; 无效返回 null */
export async function validateApiToken(
  bearer: string
): Promise<{ tokenId: string; permissions: TokenPermission[] } | null> {
  const token = bearer.replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith("sag_")) return null;
  const hash = sha256(token);
  const r = await pool.query(
    `select id, permissions, revoked from api_tokens where token_hash = $1`,
    [hash]
  );
  const row = r.rows[0];
  if (!row || row.revoked) return null;
  // 更新 last_used_at（失败不阻塞）
  pool.query(`update api_tokens set last_used_at = now() where id = $1`, [row.id]).catch(() => {});
  return { tokenId: String(row.id), permissions: row.permissions ?? [] };
}

/** 检查是否有指定权限 */
export function hasPermission(perms: TokenPermission[], required: TokenPermission): boolean {
  return perms.includes(required);
}

/** sha256 hex */
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function mapRow(row: any): ApiTokenRecord {
  return {
    id: String(row.id),
    name: row.name,
    prefix: row.prefix,
    permissions: row.permissions ?? [],
    revoked: !!row.revoked,
    last_used_at: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
  };
}

export const apiTokenService = {
  createApiToken,
  listApiTokens,
  revokeApiToken,
  deleteApiToken,
  validateApiToken,
  hasPermission,
};
