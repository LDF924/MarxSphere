// openviking-memory.ts — SAG × OpenViking 长期记忆桥（V368）
// OpenViking 作为 MarxSphere Agent 的外部长期记忆层（对话侧）
// 作用: 用户偏好 / 会话经验 / 历史交互记忆，不替代知识库检索（文献仍走三库）
// 三个钩子（基于 OpenViking v0.4 真实 REST API）:
//   1. recallMemory(query)      请求前: POST /api/v1/search/recall 召回记忆 → 注入上下文
//   2. commitSession(messages)  对话结束: 创建 session + POST /commit 提交会话 → 记忆抽取
//   3. remember(content)        显式模式: 写会话消息 + commit（Agent 手动存重要内容）
import { recordAlert } from "./alert-service.js";

const OV_URL = process.env.OPENVIKING_URL || "http://127.0.0.1:1933";
const OV_TIMEOUT_MS = parseInt(process.env.OPENVIKING_TIMEOUT_MS || "15000", 10);

/** REST 调用 OpenViking——失败静默降级（记忆不可用不阻塞主流程） */
async function ovFetch(path: string, body?: unknown, method?: string): Promise<any | null> {
  try {
    const res = await fetch(`${OV_URL}${path}`, {
      method: method ?? (body ? "POST" : "GET"),
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(OV_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } catch { return null; }
}

/** 创建一个会话（OpenViking 侧）——响应 {status, result: {session_id}} */
async function createSession(): Promise<string | null> {
  const r = await ovFetch("/api/v1/sessions", { title: "sag-agent-session" });
  return r?.result?.session_id ?? r?.session_id ?? null;
}

/**
 * 请求前钩子：召回记忆注入上下文
 * 用 /api/v1/search/find（返回完整 abstract 内容）——recall 只给 uri/score 且 text 为空
 */
export async function recallMemory(query: string, topK = 5, minScore = 0.1): Promise<Array<{ content: string; score: number; uri: string }>> {
  try {
    const r = await ovFetch("/api/v1/search/find", {
      query,
      limit: topK,
      score_threshold: minScore,
    });
    if (!r) return [];
    // find 响应: {result: {memories: [{uri, score, abstract}], resources, skills}}
    const entries = r?.result?.memories ?? r?.memories ?? [];
    if (!entries.length) return [];
    return entries.map((h: any) => ({
      content: h.abstract ?? h.content ?? h.text ?? "",
      score: h.score ?? h.similarity ?? 0,
      uri: h.uri ?? h.path ?? "",
    })).filter((h: any) => h.content && h.content.length > 10);
  } catch { return []; }
}

/**
 * 对话结束钩子：提交会话 → OpenViking 记忆抽取
 * 创建 session → POST /messages/batch 写入消息 → POST /commit 触发记忆抽取
 */
export async function commitSession(messages: Array<{ role: string; content: string }>): Promise<boolean> {
  if (messages.length === 0) return false;
  try {
    const sessionId = await createSession();
    if (!sessionId) { recordAlert({ level: "warning", category: "failure", message: "OpenViking 会话创建失败", taskType: "memory" }); return false; }
    // 写入最近 20 条消息
    const batch = await ovFetch(`/api/v1/sessions/${sessionId}/messages/batch`, {
      messages: messages.slice(-20).map((m) => ({ role: m.role, content: m.content })),
    });
    if (!batch?.result && !batch?.added) { recordAlert({ level: "warning", category: "failure", message: "OpenViking 消息写入失败", taskType: "memory" }); return false; }
    // 提交 → 记忆抽取（keep_recent_count=0 强制归档触发抽取）
    const commit = await ovFetch(`/api/v1/sessions/${sessionId}/commit`, { keep_recent_count: 0 });
    const commitStatus = commit?.result?.status;
    if (!commit || commitStatus === "skipped") { recordAlert({ level: "warning", category: "failure", message: "OpenViking 会话提交跳过（记忆抽取未触发）", taskType: "memory" }); return false; }
    return commitStatus === "accepted" || commitStatus === "completed";
  } catch {
    recordAlert({ level: "warning", category: "failure", message: "OpenViking 会话提交异常", taskType: "memory" });
    return false;
  }
}

/**
 * 显式模式：Agent 手动存重要内容（避免噪声记忆）
 * 用户偏好/项目决策/使用习惯 → 写入会话并提交（触发记忆抽取）
 */
export async function remember(content: string): Promise<boolean> {
  if (!content || content.length < 5) return false;
  return commitSession([
    { role: "user", content: "【重要记忆】请记住以下内容（存入长期记忆）：" + content },
    { role: "assistant", content: "已记住：" + content },
  ]);
}

/** 记忆服务健康检查 */
export async function memoryHealth(): Promise<{ ok: boolean; version?: string }> {
  const r = await ovFetch("/health");
  return { ok: !!r, version: r?.version };
}

export const openvikingMemory = {
  recallMemory, commitSession, remember, memoryHealth,
  rememberCategorized, rememberUser, rememberSession, rememberEntity, saveReasoningConclusion, recordUserFeedback,
};

// ═══ 分类记忆增强（V369）——按你的记忆分类体系 ═══

export type MemoryCategory = "user" | "session" | "entity";

/** 分类 → OpenViking 记忆目录 */
const CATEGORY_DIRS: Record<MemoryCategory, string> = {
  user: "viking://user/default/memories/user",
  session: "viking://user/default/memories/session",
  entity: "viking://user/default/memories/entity",
};

/**
 * 分类化 remember：按类别写入长期记忆
 * OpenViking 的 memories 是专用抽取目录（不走 resources API）——
 * 通过会话消息 + commit 写入，分类作为结构化标签注入内容（抽取时保留）
 * @param content 记忆内容
 * @param category user(用户画像/偏好/约束) | session(会话结论/决策/参数) | entity(自定义实体/个人解读)
 * @param subType 子类型标签（如 "preference"/"constraint"/"conclusion"/"decision"/"component"）
 */
export async function rememberCategorized(
  content: string,
  category: MemoryCategory = "user",
  subType?: string
): Promise<boolean> {
  if (!content || content.length < 5) return false;
  // 结构化标签：让 OpenViking 抽取时识别分类
  const tagged = `[${category}${subType ? `:${subType}` : ""}] ${content}`;
  return commitSession([
    { role: "user", content: `【重要记忆·${category === "user" ? "用户" : category === "session" ? "会话" : "实体"}】请记住：${tagged}` },
    { role: "assistant", content: `已记住（${category}${subType ? `/${subType}` : ""}）：${content}` },
  ]);
}

/** 用户侧记忆（画像/偏好/约束/项目背景/自定义设定） */
export async function rememberUser(content: string, subType?: "preference" | "constraint" | "project" | "custom" | "output-format"): Promise<boolean> {
  return rememberCategorized(content, "user", subType);
}

/** 会话&推理过程记忆（结论/取舍/框架/参数/工具结果/约定） */
export async function rememberSession(content: string, subType?: "conclusion" | "decision" | "framework" | "parameter" | "tool-result" | "convention"): Promise<boolean> {
  return rememberCategorized(content, "session", subType);
}

/** 实体-上下文记忆（内部组件/变量/路径/个人解读） */
export async function rememberEntity(content: string, subType?: "component" | "variable" | "path" | "interpretation"): Promise<boolean> {
  return rememberCategorized(content, "entity", subType);
}

/** 推理结论自动沉淀（推理完成时调用，把关键结论写入会话记忆） */
export async function saveReasoningConclusion(query: string, conclusion: string, confidence?: number): Promise<boolean> {
  if (!conclusion || conclusion.length < 20) return false;
  return rememberCategorized(
    `问题：${query}\n结论：${conclusion.substring(0, 500)}${confidence !== undefined ? `\n置信度：${confidence.toFixed(2)}` : ""}`,
    "session",
    "conclusion"
  );
}

// ═══ 用户反馈闭环（V375）═══

/**
 * 用户反馈写入长期记忆：点赞（强化偏好）/ 踩（纠正/改进）
 * @param feedback "up" | "down"
 * @param query 用户问题
 * @param answer 回答内容（摘要）
 * @param note 用户备注（可选）
 */
export async function recordUserFeedback(
  feedback: "up" | "down",
  query: string,
  answer: string,
  note?: string
): Promise<boolean> {
  if (!query || query.length < 3) return false;
  const answerSummary = (answer || "").substring(0, 300);
  if (feedback === "up") {
    // 点赞：记录"用户认可的回答风格"（强化偏好）
    return rememberCategorized(
      `用户对问题「${query}」的回答表示认可。回答要点：${answerSummary}${note ? `\n用户备注：${note}` : ""}\n→ 保持此类回答风格（相关性/深度/引用方式）`,
      "user",
      "preference"
    );
  } else {
    // 踩：记录"用户不满意的点"（纠正方向）
    return rememberCategorized(
      `用户对问题「${query}」的回答不满意。原回答要点：${answerSummary}${note ? `\n用户反馈：${note}` : "（未注明原因，需改进相关性/准确性/完整性）"}\n→ 下次回答同类问题避免此问题`,
      "user",
      "constraint"
    );
  }
}
