// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// translation-service.ts — 论文翻译（2026-08-27, Agentero 对照）
// 能力: 全局论文翻译 / 划词并排对照（结合上下文统一术语）
// 实现: 调 LLM（复用 callLlm, 模型中立）, 分块翻译长文
import { callLlm } from "../ai/llm-common.js";

/** 全局翻译（长文分块） */
export async function translateText(text: string, targetLang = "中文"): Promise<{ ok: boolean; translated?: string; error?: string }> {
  const CHUNK = 3000;
  if (text.length > 50_000) return { ok: false, error: "文本过长（>50K 字符）" };
  try {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += CHUNK) {
      chunks.push(text.slice(i, i + CHUNK));
    }
    const translated: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const resp = await callLlm({
        messages: [
          { role: "system", content: `你是学术翻译专家。把以下论文内容翻译成${targetLang}。要求：术语准确统一、保留学术语气、不遗漏段落结构。只输出译文。` },
          { role: "user", content: chunks[i] },
        ],
        temperature: 0.2,
        maxTokens: 4000,
      });
      translated.push((resp?.text || "").trim());
    }
    return { ok: true, translated: translated.join("\n\n") };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 划词并排对照（原文片段 + 译文, 结合上下文术语统一） */
export async function translateSnippet(snippet: string, context?: string, targetLang = "中文"): Promise<{ ok: boolean; original?: string; translated?: string; error?: string }> {
  if (snippet.length > 5000) return { ok: false, error: "片段过长" };
  try {
    const resp = await callLlm({
      messages: [
        { role: "system", content: `你是学术翻译专家。把下面选中的片段翻译成${targetLang}。${
          context ? "参考全文上下文统一术语。" : ""}只输出译文。` },
        { role: "user", content: (context ? `【上下文】\n${context.slice(0, 2000)}\n\n` : "") + `【选中片段】\n${snippet}` },
      ],
      temperature: 0.2,
      maxTokens: 2000,
    });
    return { ok: true, original: snippet, translated: (resp?.text || "").trim() };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

export const translationService = {
  translateText,
  translateSnippet,
};
