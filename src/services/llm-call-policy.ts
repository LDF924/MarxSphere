// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// llm-call-policy.ts — 恢复分级升级（BOOK-GAP-ROADMAP P0-12）
// 书中 Ch5: ①静默重试(前台) vs 失败即弃(后台) ②降级接续(主模型过载→备用模型) ③错误扣留(恢复成功前端无感知)
// 统一 LLM 调用入口：前台走 classifyError 重试映射表，后台单次 + 失败静默

import { classifyError, type Classification } from "./error-recovery-map.js";
import { getRoleModel, type LlmRole } from "./llm-model-registry.js";

export type CallPolicy = "front" | "background";

export interface LlmCallOptions {
  role?: LlmRole;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** 前台重试上限（默认 2） */
  maxRetries?: number;
}

export interface LlmCallResult {
  ok: boolean;
  text: string;
  model: string;
  classification?: Classification;
  /** 错误扣留：失败时错误信息（供最终一次性呈现） */
  error?: string;
}

const DS_URL = process.env.DS_BASE_URL || "https://api.deepseek.com/v1/chat/completions";

/** 降级模型顺序（主模型失败 ≥2 次 → 下一个） */
const FALLBACK_MODELS: Record<string, string[]> = {
  "deepseek-v4-flash": ["qwen3.7-max", "deepseek-v4-pro"],
  "deepseek-v4-pro": ["qwen3.7-max"],
  "qwen3.7-max": ["deepseek-v4-flash"],
};

/** 剥离 DeepSeek 私有格式（reasoning_content 等不传给异源模型） */
export function stripPrivateFields(messages: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

async function callOnce(model: string, opts: LlmCallOptions): Promise<{ text: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
    try {
      const res = await fetch(DS_URL, {
        method: "POST",
        headers: { "Authorization": "Bearer " + process.env.DEEPSEEK_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: stripPrivateFields(opts.messages),
          temperature: opts.temperature ?? 0,
          max_tokens: opts.maxTokens ?? 2000,
          thinking: { type: "disabled" },  // 结构化输出稳定
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).substring(0, 100));
      const raw: any = await res.json();
      const text = raw.choices?.[0]?.message?.content?.trim() || "";
      if (!text) throw new Error("empty content");
      return { text };
    } finally { clearTimeout(timer); }
  } catch (e: any) {
    throw e;
  }
}

/**
 * 统一 LLM 调用入口：
 * - front（前台）: classifyError 驱动重试（可重试类别退避重试）+ 主模型失败降级备用模型
 * - background（后台）: 单次调用，失败静默返回 { ok: false }（不重试不告警）
 */
export async function callLlmWithPolicy(opts: LlmCallOptions, policy: CallPolicy = "front"): Promise<LlmCallResult> {
  const role = opts.role ?? "reason";
  const baseModel = getRoleModel(role);
  const maxRetries = opts.maxRetries ?? (policy === "front" ? 2 : 0);

  // 后台：单次 + 失败静默
  if (policy === "background") {
    try {
      const r = await callOnce(baseModel, opts);
      return r ? { ok: true, text: r.text, model: baseModel } : { ok: false, text: "", model: baseModel, error: "empty" };
    } catch (e: any) {
      return { ok: false, text: "", model: baseModel, classification: classifyError(e), error: String(e).substring(0, 120) };
    }
  }

  // 前台：重试 + 降级
  const fallbacks = FALLBACK_MODELS[baseModel] || [];
  const modelChain = [baseModel, ...fallbacks];

  for (let mi = 0; mi < modelChain.length; mi++) {
    const model = modelChain[mi];
    let consecutiveFail = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const r = await callOnce(model, opts);
        return { ok: true, text: r!.text, model };
      } catch (e: any) {
        consecutiveFail++;
        const cls = classifyError(e);
        // 不可重试 → 直接降级或失败
        if (!cls.retryable) break;
        if (attempt < maxRetries) {
          const s = cls.strategy;
          if (s.kind === "retry_backoff") {
            await new Promise((r) => setTimeout(r, s.baseMs + Math.random() * s.jitterMs));
          }
        }
      }
    }
    // 主模型连续失败 ≥2 → 降级下一个模型
    if (consecutiveFail >= 2 && mi < modelChain.length - 1) {
      console.warn(`[llm-policy] ${model} 连续失败 ${consecutiveFail} 次, 降级 → ${modelChain[mi + 1]}`);
    }
  }
  return { ok: false, text: "", model: baseModel, error: "全部模型失败" };
}
