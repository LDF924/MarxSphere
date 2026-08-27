// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// reader-ai-service.ts — PDF 选中文本 AI 卡片（2026-08-28, Agentero 对照）
// 能力: 解释 / 总结 / 翻译 / 追问 — 选中文本 → LLM → 卡片浮窗返回
// 实现: 复用 callLlm（模型中立）, 按 action 分发提示词
import { callLlm } from "../ai/llm-common.js";

export type ReaderAiAction = "explain" | "summarize" | "translate" | "ask";

const SYSTEM_PROMPTS: Record<ReaderAiAction, string> = {
  explain: "你是学术文献阅读助手。用通俗且准确的中文解释下面选中的文本片段——它想表达什么、关键概念的含义、在论证中的作用。分点输出，每点一行。",
  summarize: "你是学术文献阅读助手。用中文概括下面选中片段的核心内容。先一句话概括，再列出 2-4 个要点。",
  translate: "你是学术翻译专家。把下面选中的片段翻译成中文。要求：术语准确统一、保留学术语气。只输出译文。",
  ask: "你是学术文献阅读助手。基于下面选中的片段，回答用户的问题。回答要基于片段内容，标注不确定处。",
};

/** 选中文本 AI 卡片（explain/summarize/translate/ask） */
export async function readerAiAction(input: {
  action: ReaderAiAction;
  snippet: string;
  context?: string;
  question?: string;
}): Promise<{ ok: boolean; result?: string; error?: string }> {
  const { action, snippet, context, question } = input;
  if (snippet.length > 5000) return { ok: false, error: "片段过长（>5000 字符）" };
  try {
    const userContent =
      (context ? `【上下文】\n${context.slice(0, 1500)}\n\n` : "") +
      (question ? `【用户问题】\n${question}\n\n` : "") +
      `【选中片段】\n${snippet}`;
    const resp = await callLlm({
      messages: [
        { role: "system", content: SYSTEM_PROMPTS[action] },
        { role: "user", content: userContent },
      ],
      temperature: 0.3,
      maxTokens: 1500,
    });
    const result = (resp?.text || "").trim();
    if (!result) return { ok: false, error: "AI 无返回" };
    return { ok: true, result };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

export const readerAiService = { readerAiAction };
