// empirical-guards.ts — 实证工作台守卫工具（V380+）
// 反 hallucinate 核心: 变量白名单校验在 TS 服务端强制, 不依赖 LLM 提示词自觉
// assertColumns: LLM 建议变量不在数据列中 → 抛带候选列的 400 错误
// assertGate: 闸门状态检查（写入前置条件）
import { pool } from "../db/pool.js";

export class GuardError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 校验变量全部在 columns 白名单内; 失败抛 400 VARIABLE_NOT_IN_DATA 列出候选列 */
export function assertColumns(vars: string[], columns: string[], ctx = "变量"): void {
  const set = new Set(columns);
  const bad = vars.filter((v) => !set.has(v));
  if (bad.length > 0) {
    const cands = columns.slice(0, 40).join(", ");
    throw new GuardError(
      "VARIABLE_NOT_IN_DATA",
      `${ctx} ${bad.join(", ")} 不在数据列中, 请从数据版本列中选择: ${cands}`
    );
  }
}

/** 校验变量名合法（小写下划线） */
export function assertVarName(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new GuardError("INVALID_VAR_NAME", `变量名 ${name} 不合法, 需匹配 ^[a-z_][a-z0-9_]*$`);
  }
}

/** 从全列中挑出数值/分类列（供 LLM 建议变量时提示候选） */
export function pickColumns(
  columns: string[],
  n = 30
): { numeric: string[]; categorical: string[]; all: string[] } {
  return { numeric: columns.slice(0, n), categorical: columns.slice(0, n), all: columns };
}

/** 读取闸门状态; 不存在返回 null */
export async function getGate(
  projectId: string,
  node: string
): Promise<{ id: string; status: string; content: Record<string, unknown> } | null> {
  const r = await pool.query(
    `select id, status, content from empirical_gates where project_id = $1 and node = $2`,
    [projectId, node]
  );
  if (r.rows.length === 0) return null;
  return {
    id: String(r.rows[0].id),
    status: String(r.rows[0].status),
    content: (r.rows[0].content ?? {}) as Record<string, unknown>,
  };
}

/** 校验闸门已 confirmed; 否则抛 400 GATE_LOCKED */
export async function assertGateConfirmed(projectId: string, node: string, ctx = "该操作"): Promise<void> {
  const gate = await getGate(projectId, node);
  if (!gate || gate.status !== "confirmed") {
    throw new GuardError(
      "GATE_LOCKED",
      `${ctx}需要闸门「${node}」通过(confirmed), 当前状态: ${gate?.status ?? "未创建"}`
    );
  }
}

/** 校验闸门处于指定状态之一 */
export async function assertGateStatus(projectId: string, node: string, allowed: string[], ctx = "该操作"): Promise<void> {
  const gate = await getGate(projectId, node);
  if (!gate || !allowed.includes(gate.status)) {
    throw new GuardError(
      "GATE_LOCKED",
      `${ctx}需要闸门「${node}」状态为 ${allowed.join("/")}, 当前: ${gate?.status ?? "未创建"}`
    );
  }
}

/** 表达式 token 白名单校验（genvars 同款, 防 LLM 引用未知列 + 防注入） */
export function assertExprVars(expr: string, columns: string[], ctx = "表达式"): void {
  // 防注入: 拦截语句分隔符/注释符/属性访问/魔术方法
  if (/[;\n\r]|__|\bimport\b|\bexec\b|\beval\b|\bsystem\b|\bopen\b|\bcompile\b|@|%|`/.test(expr)) {
    throw new GuardError(
      "INVALID_EXPRESSION",
      `${ctx}包含不允许的字符或语句(; 换行 __ import exec eval system open @ %), 仅支持算术/比较/逻辑表达式`
    );
  }
  const tokens = expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const set = new Set(columns);
  // 常见内置常量/函数放行
  const builtins = new Set(["log", "exp", "sqrt", "abs", "min", "max", "sum", "mean", "nan", "inf"]);
  const bad = tokens.filter((t) => !set.has(t) && !builtins.has(t) && !/^\d+$/.test(t));
  if (bad.length > 0) {
    throw new GuardError(
      "VARIABLE_NOT_IN_DATA",
      `${ctx}引用未知列 ${bad.join(", ")}; 可用列: ${columns.slice(0, 30).join(", ")}`
    );
  }
}
