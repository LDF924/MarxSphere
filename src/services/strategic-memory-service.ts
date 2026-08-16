// strategic-memory-service.ts — V391(P1-4): 战略记忆
// 项目级长期目标/决策历史/约束 — 每次 Agent 会话开始加载, 避免会话间上下文重建
import { pool } from "../db/pool.js";

export type StrategicKind = "goal" | "decision" | "constraint" | "milestone";

export interface StrategicMemoryRecord {
  id: number;
  projectId?: string;
  kind: StrategicKind;
  content: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

/** 记录战略记忆（项目级; projectId 缺省=全局） */
export async function recordStrategicMemory(input: {
  projectId?: string;
  kind: StrategicKind;
  content: string;
  source?: "user" | "agent" | "system";
}): Promise<StrategicMemoryRecord> {
  const r = await pool.query(
    `insert into strategic_memory (project_id, kind, content, source)
     values ($1, $2, $3, $4) returning *`,
    [input.projectId ?? null, input.kind, input.content.trim(), input.source ?? "agent"]
  );
  return mapRow(r.rows[0]);
}

/** 加载项目战略上下文（目标+约束+最近决策+里程碑, 用于会话注入） */
export async function loadStrategicContext(projectId?: string): Promise<string> {
  const r = await pool.query(
    `select kind, content, source, created_at from strategic_memory
     where ($1::uuid is null or project_id = $1)
     order by created_at desc limit 30`,
    [projectId ?? null]
  );
  if (r.rows.length === 0) return "";
  const goals = r.rows.filter((x) => x.kind === "goal");
  const constraints = r.rows.filter((x) => x.kind === "constraint");
  const decisions = r.rows.filter((x) => x.kind === "decision").slice(0, 5);
  const parts: string[] = [];
  if (goals.length > 0) parts.push("【项目目标】\n" + goals.map((g) => "- " + g.content).join("\n"));
  if (constraints.length > 0) parts.push("【项目约束】\n" + constraints.map((c) => "- " + c.content).join("\n"));
  if (decisions.length > 0) parts.push("【近期决策】\n" + decisions.map((d) => `- (${new Date(d.created_at).toLocaleDateString("zh-CN")}) ${d.content}`).join("\n"));
  return parts.join("\n\n");
}

/** 列出战略记忆（管理端/前端展示） */
export async function listStrategicMemory(projectId?: string): Promise<StrategicMemoryRecord[]> {
  const r = await pool.query(
    `select * from strategic_memory
     where ($1::uuid is null or project_id = $1)
     order by created_at desc limit 50`,
    [projectId ?? null]
  );
  return r.rows.map(mapRow);
}

/** 删除一条战略记忆 */
export async function deleteStrategicMemory(id: number): Promise<boolean> {
  const r = await pool.query("delete from strategic_memory where id = $1", [id]);
  return (r.rowCount ?? 0) > 0;
}

/** V391: 从用户消息中提炼战略记忆（Agent 在会话中自动调用; 目标/约束类声明） */
export async function extractStrategicFromMessage(projectId: string | undefined, message: string): Promise<{ recorded: boolean; kind?: StrategicKind }> {
  // 目标声明: "目标是/我们要/项目目标/打算实现"
  const goalMatch = message.match(/(?:目标是|项目目标|我们要|打算实现|要完成)[：:\s]*([^\n。；;]{5,80})/);
  if (goalMatch) {
    await recordStrategicMemory({ projectId, kind: "goal", content: goalMatch[1].trim(), source: "user" });
    return { recorded: true, kind: "goal" };
  }
  // 约束声明: "注意/限制/不能/必须/要求"
  const constraintMatch = message.match(/(?:注意|限制条件|要求|切记|不能忘记)[：:\s]*([^\n。；;]{5,80})/);
  if (constraintMatch) {
    await recordStrategicMemory({ projectId, kind: "constraint", content: constraintMatch[1].trim(), source: "user" });
    return { recorded: true, kind: "constraint" };
  }
  return { recorded: false };
}

function mapRow(row: any): StrategicMemoryRecord {
  return {
    id: Number(row.id),
    projectId: row.project_id,
    kind: row.kind,
    content: row.content,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const strategicMemoryService = {
  recordStrategicMemory,
  loadStrategicContext,
  listStrategicMemory,
  deleteStrategicMemory,
  extractStrategicFromMessage,
};
