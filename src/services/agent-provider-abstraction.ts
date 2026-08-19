// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-provider-abstraction.ts — 架构A2: 服务抽象层
// LlmProvider / SandboxProvider 接口 — 新实现可替换默认（无需改调用方）
// 当前默认实现 = 现有服务（兼容层, 无行为变化）
import type { SandboxProfile, ExecuteCodeResult } from "./code-sandbox-service.js";

// ═══ LlmProvider 接口 ═══
export interface LlmMessage { role: string; content: string }
export interface LlmCallInput {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  onStream?: (delta: string) => void;
}
export interface LlmCallResult { text: string; error?: string }

export interface LlmProvider {
  readonly id: string;
  readonly label: string;
  call(input: LlmCallInput): Promise<LlmCallResult>;
}

/** 默认 LLM Provider（包装 callLlm; 兼容层） */
export const defaultLlmProvider: LlmProvider = {
  id: "default", label: "默认（callLlm 统一入口）",
  async call(input) {
    const { callLlm } = await import("../ai/llm-common.js");
    const r = await callLlm({
      messages: input.messages,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      jsonMode: input.jsonMode,
      onStream: input.onStream,
    });
    return { text: r?.text || "", error: r?.error };
  },
};

// ═══ SandboxProvider 接口 ═══
export interface SandboxExecInput {
  language: "python" | "javascript";
  code: string;
  timeoutMs?: number;
  profile?: SandboxProfile;
}

export interface SandboxProvider {
  readonly id: string;
  readonly label: string;
  exec(input: SandboxExecInput): Promise<ExecuteCodeResult>;
}

/** 默认 Sandbox Provider（包装 executeCode; 兼容层） */
export const defaultSandboxProvider: SandboxProvider = {
  id: "default", label: "默认（code-sandbox 3级沙箱）",
  async exec(input) {
    const { executeCode } = await import("./code-sandbox-service.js");
    return executeCode(input);
  },
};

// ═══ Provider 注册表（可替换; 环境变量 AGENT_LLM_PROVIDER/AGENT_SANDBOX_PROVIDER 选实现）═══
const llmProviders = new Map<string, LlmProvider>([[defaultLlmProvider.id, defaultLlmProvider]]);
const sandboxProviders = new Map<string, SandboxProvider>([[defaultSandboxProvider.id, defaultSandboxProvider]]);

export function registerLlmProvider(p: LlmProvider): void { llmProviders.set(p.id, p); }
export function registerSandboxProvider(p: SandboxProvider): void { sandboxProviders.set(p.id, p); }

export function getLlmProvider(id?: string): LlmProvider {
  const selected = id || process.env.AGENT_LLM_PROVIDER || "default";
  return llmProviders.get(selected) || defaultLlmProvider;
}
export function getSandboxProvider(id?: string): SandboxProvider {
  const selected = id || process.env.AGENT_SANDBOX_PROVIDER || "default";
  return sandboxProviders.get(selected) || defaultSandboxProvider;
}

/** Provider 状态（诊断/前端展示） */
export function providerStatus(): { llm: Array<{ id: string; label: string; active: boolean }>; sandbox: Array<{ id: string; label: string; active: boolean }> } {
  const activeLlm = getLlmProvider().id;
  const activeSb = getSandboxProvider().id;
  return {
    llm: [...llmProviders.values()].map((p) => ({ id: p.id, label: p.label, active: p.id === activeLlm })),
    sandbox: [...sandboxProviders.values()].map((p) => ({ id: p.id, label: p.label, active: p.id === activeSb })),
  };
}

export const agentProviderService = {
  registerLlmProvider, registerSandboxProvider, getLlmProvider, getSandboxProvider, providerStatus,
};
