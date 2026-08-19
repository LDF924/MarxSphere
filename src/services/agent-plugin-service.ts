// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-plugin-service.ts — V395-4: Agent 插件体系
// 插件 = 可插拔工具包: agent_plugins 表（迁移 058）声明 entry 模块
// → buildAgentTools 动态加载启用插件的工具（合并进工具清单, LLM 可选择）
// API: 注册(upsert)/启用/禁用/列表/删除
import { pool } from "../db/pool.js";
import type { AgentToolDef } from "./agent-tool-router.js";

export interface AgentPluginRecord {
  id: string;
  name: string;
  description: string;
  entry: string;
  enabled: boolean;
  /** 插件提供的工具声明 [{name, label, description, params, risk}]（注册时从 entry 导出 tools 采集） */
  tools: Array<{ name: string; label: string; description: string; params?: Record<string, unknown>; risk?: string }>;
  createdAt: Date;
  updatedAt: Date;
}

/** 插件入口模块导出约定: { tools: AgentToolDef[], name?, description? } */
export interface AgentPluginModule {
  tools: AgentToolDef[];
  name?: string;
  description?: string;
}

function mapRow(row: any): AgentPluginRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    entry: row.entry,
    enabled: row.enabled,
    tools: Array.isArray(row.tools) ? row.tools : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 插件列表（可按 enabled 过滤） */
export async function listAgentPlugins(enabledOnly = false): Promise<AgentPluginRecord[]> {
  const r = enabledOnly
    ? await pool.query("select * from agent_plugins where enabled = true order by updated_at desc")
    : await pool.query("select * from agent_plugins order by updated_at desc");
  return r.rows.map(mapRow);
}

/** 注册插件（存在则更新）— id 唯一; entry 必填 */
export async function registerAgentPlugin(input: {
  id: string;
  name: string;
  description?: string;
  entry: string;
  tools?: Array<{ name: string; label: string; description: string; params?: Record<string, unknown>; risk?: string }>;
}): Promise<AgentPluginRecord> {
  const id = input.id.trim();
  if (!id) throw new Error("插件 id 必填");
  if (!input.entry?.trim()) throw new Error("插件入口 entry 必填");
  // V396-13: 工具定义哈希 — 防篡改检测(内容变更→哈希变化→需重新审批)
  const defHash = computePluginHash(input.entry, input.tools || []);
  const r = await pool.query(
    `insert into agent_plugins (id, name, description, entry, tools, version, def_hash, updated_at)
     values ($1, $2, $3, $4, $5::jsonb, '1.0.0', $6, now())
     on conflict (id) do update set
       name = excluded.name, description = excluded.description,
       entry = excluded.entry, tools = excluded.tools, version = agent_plugins.version, updated_at = now()
     returning *`,
    [id, input.name?.trim() || id, (input.description || "").slice(0, 500), input.entry.trim(), JSON.stringify(input.tools || []), defHash]
  );
  return mapRow(r.rows[0]);
}

/** V396-13: 工具定义哈希（entry + tools JSON 摘要 → SHA-256 前 16 位） */
function computePluginHash(entry: string, tools: unknown[]): string {
  const crypto = require("node:crypto") as typeof import("node:crypto");
  return crypto.createHash("sha256").update(entry + JSON.stringify(tools)).digest("hex").slice(0, 16);
}

/** V396-13: 审批过期验证 — 插件启用超过 N 天未重新审批 → 返回过期需重新启用 */
export async function checkPluginApprovalExpiry(id: string, maxDays = 90): Promise<{ ok: boolean; expiresAt?: Date; reason?: string }> {
  const r = await pool.query(
    "select approval_expires_at from agent_plugins where id = $1",
    [id]
  );
  if (r.rows.length === 0) return { ok: false, reason: "插件不存在" };
  const expiresAt = r.rows[0].approval_expires_at;
  if (!expiresAt) {
    // 未设置过期 → 启用时设置 90 天
    await pool.query("update agent_plugins set approval_expires_at = now() + ($2 || ' days')::interval where id = $1", [id, String(maxDays)]);
    return { ok: true, expiresAt: new Date(Date.now() + maxDays * 86400000) };
  }
  const expired = new Date(expiresAt) < new Date();
  return { ok: !expired, expiresAt: new Date(expiresAt), reason: expired ? "插件审批已过期, 需重新启用" : undefined };
}

/** 启用/禁用插件 */
export async function setAgentPluginEnabled(id: string, enabled: boolean): Promise<AgentPluginRecord | null> {
  const r = await pool.query(
    "update agent_plugins set enabled = $2, updated_at = now() where id = $1 returning *",
    [id, enabled]
  );
  return r.rows.length > 0 ? mapRow(r.rows[0]) : null;
}

/** 删除插件 */
export async function deleteAgentPlugin(id: string): Promise<boolean> {
  const r = await pool.query("delete from agent_plugins where id = $1", [id]);
  return (r.rowCount ?? 0) > 0;
}

/** 解析插件入口为可导入路径（相对路径基于 src/services/ 解析; tsx 下 .js→.ts 兼容） */
async function resolvePluginEntry(entry: string): Promise<string> {
  if (!entry.startsWith("./") && !entry.startsWith("../")) return entry;
  const { pathToFileURL } = await import("node:url");
  // 相对 src/services/ 目录解析（本文件所在目录）
  const base = new URL(".", import.meta.url);
  const candidates = [entry, entry.replace(/\.js$/, ".ts"), `${entry}.ts`, `${entry}.js`];
  for (const c of candidates) {
    const u = new URL(c, base);
    try {
      const fs = await import("node:fs");
      if (fs.existsSync(u)) return u.href;  // 已存在的文件直接返回 file URL
    } catch { /* 继续尝试 */ }
  }
  // 都不存在 → 返回第一个候选（import 失败由调用方 catch）
  return new URL(candidates[0], base).href;
}

/** 加载插件模块（入口不存在/导出非法 → 返回 null） */
async function importPluginModule(entry: string): Promise<Partial<AgentPluginModule> | null> {
  try {
    const resolved = await resolvePluginEntry(entry);
    return (await import(resolved)) as unknown as Partial<AgentPluginModule>;
  } catch (e: any) {
    console.warn(`[agent-plugin] 入口加载失败 ${entry}: ${String(e?.message || e).slice(0, 120)}`);
    return null;
  }
}

/** 加载插件工具（注册时采集 entry 模块 tools 声明, 供 buildAgentTools 合并） */
async function loadPluginModule(plugin: AgentPluginRecord): Promise<AgentToolDef[]> {
  const mod = await importPluginModule(plugin.entry);
  const tools = Array.isArray(mod?.tools) ? mod.tools : [];
  // 工具名加插件前缀防冲突（保留原 run 执行器）
  return tools.map((t) => ({
    ...t,
    name: `${plugin.id}__${t.name}`,
    label: `[${plugin.name}]${t.label || t.name}`,
    description: `${t.description}（插件: ${plugin.name}）`,
    risk: (t.risk ?? "safe") as AgentToolDef["risk"],
  }));
}

/** 收集所有启用插件的工具（buildAgentTools 调用, 失败不影响主工具） */
export async function collectPluginTools(): Promise<AgentToolDef[]> {
  try {
    const plugins = await listAgentPlugins(true);
    const all: AgentToolDef[] = [];
    for (const p of plugins) {
      const tools = await loadPluginModule(p);
      all.push(...tools);
    }
    return all;
  } catch { return []; }
}

/** 注册时自动采集 entry 模块的工具声明（若未显式传 tools） */
export async function scanPluginTools(entry: string): Promise<Array<{ name: string; label: string; description: string; params?: Record<string, unknown>; risk?: string }>> {
  const mod = await importPluginModule(entry);
  return (Array.isArray(mod?.tools) ? mod.tools : []).map((t) => ({
    name: t.name,
    label: t.label || t.name,
    description: t.description || "",
    params: t.params as Record<string, unknown> | undefined,
    risk: t.risk,
  }));
}

export const agentPluginService = {
  listAgentPlugins,
  registerAgentPlugin,
  setAgentPluginEnabled,
  deleteAgentPlugin,
  collectPluginTools,
  scanPluginTools,
  // V396-13: 插件治理
  checkPluginApprovalExpiry,
};
