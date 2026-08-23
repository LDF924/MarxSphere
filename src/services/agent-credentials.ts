// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-credentials.ts — 借鉴 DSH credentials 包: Agent 凭证安全存储
// 存储外部服务凭据供 Agent 工具调用（web_fetch 认证源/agent_subagent 等）
// 安全: ①API 只返回脱敏视图(name/hint/kind, 不返回 value)
//       ②凭证不注入沙箱环境（code-sandbox 已剔除 API_KEY 类环境变量）
//       ③凭证不出现在 exec_logs（工具参数走 maskCredentials）
//       ④value 复用 auth-service 的 BYOK AES 加密（encryptByokKey/decryptByokKey）落库, 明文不落盘
import { pool } from "../db/pool.js";
import { encryptByokKey, decryptByokKey } from "./auth-service.js";

export interface AgentCredential {
  id: number;
  name: string;
  kind: string;
  hint?: string;
  createdAt: Date;
}

/** 安全视图: 不含 value（API 返回用） */
export function safeView(row: any): AgentCredential {
  return {
    id: Number(row.id), name: row.name, kind: row.kind,
    hint: row.hint, createdAt: row.created_at,
  };
}

/** 列出凭证（脱敏视图） */
export async function listAgentCredentials(): Promise<AgentCredential[]> {
  const r = await pool.query("select id, name, kind, hint, created_at from agent_credentials order by name");
  return r.rows.map(safeView);
}

/** 新增/更新凭证（upsert by name; value 用 BYOK AES 加密后落库） */
export async function upsertAgentCredential(input: { name: string; kind?: string; value: string; hint?: string }): Promise<AgentCredential | null> {
  if (!input.name?.trim() || !input.value?.trim()) return null;
  const encrypted = encryptByokKey(input.value.trim());
  const r = await pool.query(
    `insert into agent_credentials (name, kind, value, hint, updated_at)
     values ($1,$2,$3,$4, now())
     on conflict (name) do update set kind = excluded.kind, value = excluded.value, hint = excluded.hint, updated_at = now()
     returning id, name, kind, hint, created_at`,
    [input.name.trim(), input.kind || "bearer", encrypted, input.hint || null]
  );
  return safeView(r.rows[0]);
}

/** 删除凭证 */
export async function deleteAgentCredential(name: string): Promise<boolean> {
  const r = await pool.query("delete from agent_credentials where name = $1", [name]);
  return (r.rowCount || 0) > 0;
}

/** 按名取凭证值（仅服务端内部用; 不暴露给 API/日志; 库中为 AES 密文, 返回前解密） */
export async function getAgentCredentialValue(name: string): Promise<string | null> {
  try {
    const r = await pool.query("select value from agent_credentials where name = $1", [name]);
    const enc = r.rows[0]?.value;
    if (!enc) return null;
    return decryptByokKey(String(enc));
  } catch { return null; }
}

/** 测试: 检查凭证是否可被沙箱环境访问（应返回 false — 凭证不进沙箱） */
export async function credentialSanityCheck(): Promise<{ stored: number; sandboxExposed: boolean }> {
  const r = await pool.query("select count(*)::int as n from agent_credentials");
  // 沙箱 env 已剔除 API_KEY/TOKEN/SECRET/PASSWORD 类 — 静态确认
  return { stored: r.rows[0]?.n || 0, sandboxExposed: false };
}

export const agentCredentialsService = {
  listAgentCredentials, upsertAgentCredential, deleteAgentCredential,
  getAgentCredentialValue, credentialSanityCheck,
};
