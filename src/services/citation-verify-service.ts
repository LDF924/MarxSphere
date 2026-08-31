// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// citation-verify-service.ts — V399: 引文三维核验 (Rimagination/citation-lab 移植)
// 三维核验 (验证优先, 不轻信引用):
//   ① 元数据真伪: Crossref/OpenAlex 多源查证标题/年份/作者
//   ② 语境相关性: 引用上下文 vs 官方摘要 语义相似度 + 意图分类
//   ③ 断言支持度: 断言 vs 摘要 关键词覆盖率 + 方向性/否定冲突检测
// 与 validate-bib(格式层)互补: 本服务做语义层核验。
// 设计对齐 citation-lab: 状态绿/黄/白/红, 得分 0-1, 证据句提取, 冲突列表。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const VERIFY_SCRIPT = join(process.env.SAG_ROOT || process.cwd(), "vendor", "citation-lab", "verify_claim.py");
const PYTHON = process.env.EMPIRICAL_PYTHON || process.env.COGNEE_PYTHON || "python";

export interface VerifyClaimInput {
  claim: string;
  referenceTitle?: string;
  referenceDoi?: string;
  referenceText?: string;
  context?: string;
}

export interface VerifyClaimResult {
  ok: boolean;
  dimensions?: {
    metadata: { status: string; label: string; score: number; reason: string };
    relevance: { status: string; label: string; score: number; reason: string };
    support: { status: string; label: string; score: number; reason: string };
  };
  overall?: { status: string; score: number };
  error?: string;
}

/**
 * 引文三维核验
 * @param input.claim 论文中的断言句(引用所在句)
 * @param input.referenceTitle 参考文献标题(用于元数据查证)
 * @param input.referenceDoi 参考文献 DOI(优先)
 * @param input.referenceText 官方摘要/全文(可选; 缺省由 OpenAlex 拉取)
 * @param input.context 引用所在段落上下文(可选; 用于语境相关性)
 */
export function verifyClaim(input: VerifyClaimInput): VerifyClaimResult {
  if (!existsSync(VERIFY_SCRIPT)) {
    return { ok: false, error: `verify_claim.py 缺失: ${VERIFY_SCRIPT}` };
  }
  try {
    const args = [VERIFY_SCRIPT, input.claim.slice(0, 3000)];
    if (input.referenceDoi) args.push("--doi", input.referenceDoi);
    if (input.referenceTitle) args.push("--title", input.referenceTitle.slice(0, 300));
    if (input.referenceText) args.push("--text", input.referenceText.slice(0, 8000));
    if (input.context) args.push("--context", input.context.slice(0, 3000));
    const out = execFileSync(PYTHON, args, { encoding: "utf-8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const data = JSON.parse(out);
    if (!data.ok) return { ok: false, error: data.error || "核验脚本返回失败" };
    return { ok: true, dimensions: data.dimensions, overall: data.overall };
  } catch (e: any) {
    return { ok: false, error: String(e?.stderr || e?.message || e).slice(0, 300) };
  }
}

export const citationVerifyService = { verifyClaim };
