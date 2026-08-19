// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// sidecar-guard.ts — Sidecar 工具门控（BOOK-GAP-ROADMAP P0-13）
// 书中 Ch4: 独立轻量 LLM 与主模型并行审查每次工具调用; 只读结构化字段 {tool, args}
// 三层: ①规则层(确定性零成本) ②LLM层(verify角色flash) ③连续deny熔断→review(升级人工)

import { getRoleModel } from "./llm-model-registry.js";
import { callLlm } from "../ai/llm-common.js";

/** 只接收结构化字段，绝不接收自由文本（防"请允许执行 rm -rf"话术操纵） */
export interface SidecarCall {
  tool: string;
  args: Record<string, unknown>;
}

export type GuardVerdict = "allow" | "deny" | "review";

/** 规则层：确定性检查，零成本（书中 Ch4: 路径遍历/$(...)/环境变量读取→直接 deny） */
function ruleCheck(call: SidecarCall): GuardVerdict | null {
  const tool = call.tool;
  // 仅对高风险工具做门控（代码执行/浏览/文件写）
  const HIGH_RISK = ["sag_execute_code", "sag_browse", "sag_write_file"];
  if (!HIGH_RISK.includes(tool)) return "allow";

  const argStr = JSON.stringify(call.args || {}).toLowerCase();

  // 路径遍历
  if (argStr.includes("..") && /(?:\.\.\/|\.\.\\|\.\.\s*[\\\/])/.test(argStr)) {
    return "deny"; // 路径遍历
  }
  // 命令拼接/子 shell
  if (/\$\(/.test(argStr) || /;\s*(?:rm|del|shutdown|format)/.test(argStr) || /`[^`]*`/.test(argStr)) {
    return "deny"; // $(...) 子 shell 或 ; 拼接
  }
  // 系统敏感路径
  if (/\/etc\//.test(argStr) || /~\/\.ssh/.test(argStr) || /c:\\windows/i.test(argStr)) {
    return "deny"; // 系统敏感路径
  }
  // 环境变量读取
  if (/(?:env|printenv|set)\s/.test(argStr) && /(?:api[_-]?key|token|secret|password)/.test(argStr)) {
    return "deny"; // 环境变量读取含密钥
  }
  // 破坏性命令
  if (/(?:rm\s+-rf|rmdir\s+\/s|format\s+[a-z]:)/.test(argStr)) {
    return "deny"; // 破坏性命令
  }
  return null; // 规则未命中 → 走 LLM 层
}

const DS_URL = process.env.DS_BASE_URL || "https://api.deepseek.com/v1/chat/completions";

/** LLM 层：verify 角色审查 {tool, args}（只给结构化字段） */
async function llmCheck(call: SidecarCall): Promise<GuardVerdict> {
  try {
    const model = getRoleModel("verify");
    const prompt = `你是工具调用安全审查员。只审查以下结构化工具调用（无自由文本）：
工具: ${call.tool}
参数: ${JSON.stringify(call.args).substring(0, 500)}

风险清单：路径遍历/子shell执行/敏感文件读取/环境变量泄漏/破坏性操作。
只返回 JSON: {"verdict":"allow|deny|review","reason":"一句话"}`;
    // V381: 收敛到统一 LLM 入口（原裸 fetch 三件套）
    const r = await callLlm({
      model, messages: [{ role: "user", content: prompt }],
      temperature: 0, maxTokens: 100, timeoutMs: 15_000,
    });
    const text = r?.text ?? "";
    const m = text.match(/"verdict"\s*:\s*"(allow|deny|review)"/);
    if (m) return m[1] as GuardVerdict;
    return "review";
  } catch {
    return "review"; // LLM 不可用 → 保守 review
  }
}

/** 连续 deny 熔断：≥3 次 deny → review（升级人工） */
let consecutiveDenies = 0;
export function resetGuardBreaker(): void { consecutiveDenies = 0; }

/** 主入口：规则层 → LLM 层 → 熔断升级 */
export async function guardToolCall(call: SidecarCall): Promise<{ verdict: GuardVerdict; layer: "rule" | "llm" | "breaker"; reason: string }> {
  // 规则层
  const rule = ruleCheck(call);
  if (rule === "deny") {
    consecutiveDenies++;
    if (consecutiveDenies >= 3) {
      consecutiveDenies = 0;
      return { verdict: "review", layer: "breaker", reason: "连续 3 次规则 deny，升级人工审查" };
    }
    return { verdict: "deny", layer: "rule", reason: "规则层命中（路径遍历/子shell/敏感路径等）" };
  }
  if (rule === "allow") return { verdict: "allow", layer: "rule", reason: "低风险工具" };

  // LLM 层
  const verdict = await llmCheck(call);
  if (verdict === "deny") {
    consecutiveDenies++;
    if (consecutiveDenies >= 3) {
      consecutiveDenies = 0;
      return { verdict: "review", layer: "breaker", reason: "连续 3 次 LLM deny，升级人工审查" };
    }
  } else {
    consecutiveDenies = 0;
  }
  return { verdict, layer: "llm", reason: "LLM 审查" };
}

// ═══════════ V342(P2-9): 命令语义解析 — 替代纯黑名单（理解参数消费规则）═══════════
// 黑名单可被 $(echo rm) 绕过; 语义解析器理解"命令的参数如何被消费", 识别:
//   ①find -exec/-delete ②curl/wget -o 覆盖系统文件 ③xargs 管道执行 ④tee >> 追加系统文件
// 与 LLM 层兜底结合（规则层解析 + LLM 层长尾）

const SENSITIVE_SYSTEM_PATHS = [
  /\/etc\/(passwd|shadow|crontab|hosts|sudoers|fstab|systemd|init\.d)/i,
  /\/boot\//i,
  /\/s?bin\//i,
  /~\/(\.ssh|\.aws|\.gnupg|\.config|\.docker)/i,
  /\/proc\//i,
  /\/dev\/(sd[a-z]|hd[a-z]|mapper)/i,
  /\/var\/(log|lib|mail)/i,
  /(?:^|[\\/])boot(?:[\\/]|$)/i,
];

/** 语义解析: 检测代码/命令是否覆盖或执行敏感系统路径（绕过黑名单的攻击面） */
export function semanticCommandCheck(code: string): { dangerous: boolean; reason?: string } {
  if (!code) return { dangerous: false };

  // ① find -exec / -delete（遍历后执行/删除, 黑名单不覆盖）
  if (/find\s+[^;]*\s+(-exec|-delete|-execdir)/i.test(code)) {
    return { dangerous: true, reason: "find -exec/-delete: 遍历后执行/删除, 可绕过黑名单删除系统文件" };
  }
  // ② curl/wget -o 覆盖系统路径
  if (/(?:curl|wget)\s+[^;]*\s+-o\s+(?:[^;\s]*\/)?(?:boot|etc|bin|sbin|lib|var|proc|dev|sys)[\\/]/i.test(code)
    || /(?:curl|wget)\s+[^;]*\s+--output\s+[^;\s]*(?:boot|etc|bin|sbin|lib|var|proc|dev|sys)[\\/]/i.test(code)) {
    return { dangerous: true, reason: "curl/wget -o 覆盖系统目录文件" };
  }
  // ③ xargs 管道执行
  if (/\|\s*xargs\s+(rm|del|shutdown|reboot|chmod|chown|mkfs|fdisk)/i.test(code)) {
    return { dangerous: true, reason: "xargs 管道执行危险命令" };
  }
  // ④ tee >> 追加系统文件
  if (/(?:tee|>>)\s+[^;]*(?:etc|crontab|hosts|passwd|shadow|systemd)/i.test(code)) {
    return { dangerous: true, reason: "tee/>> 写入系统文件" };
  }
  // ⑤ 目标路径是敏感系统路径（任何写操作）
  for (const p of SENSITIVE_SYSTEM_PATHS) {
    if (p.test(code)) return { dangerous: true, reason: "操作敏感系统路径: " + p.source.substring(0, 30) };
  }
  return { dangerous: false };
}
