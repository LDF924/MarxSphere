// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// oa-fallback-service.ts — V399: 英文文献 OA 回退获取 (Rimagination/instsci 提炼)
// 复用 instsci 的 unpaywall + arxiv 源 (纯 requests, 零重依赖):
//   - check_oa(doi): Unpaywall 查 DOI 的开放获取版本 (pdf/html URL)
//   - arxiv_search(query): arXiv API 检索
//   - arxiv_metadata(id): arXiv 元数据
// 用途: Ask 检索链对英文文献(尤其政治经济学/制度经济学)的 DOI 补全文,
//       与 sciverse(知网/万方中文)互补, 构成"中英双源"外部文献发现层。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OA_SCRIPT = join(process.env.SAG_ROOT || process.cwd(), "vendor", "instsci-oa", "oa_fallback.py");
const PYTHON = process.env.MINERU_GO_PYTHON || process.env.EMPIRICAL_PYTHON || process.env.COGNEE_PYTHON || "python";

function runOa(args: string[], timeoutMs = 30_000): { ok: boolean; data?: any; error?: string } {
  if (!existsSync(OA_SCRIPT)) return { ok: false, error: `oa_fallback.py 缺失: ${OA_SCRIPT}` };
  try {
    const out = execFileSync(PYTHON, [OA_SCRIPT, ...args], { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return { ok: true, data: JSON.parse(out) };
  } catch (e: any) {
    return { ok: false, error: String(e?.stderr || e?.message || e).slice(0, 300) };
  }
}

/** Unpaywall: DOI → OA 全文 (pdf/html URL) */
export function checkOa(doi: string): { ok: boolean; data?: any; error?: string } {
  return runOa(["oa", doi]);
}

/** arXiv: 关键词检索 */
export function arxivSearch(query: string, max = 5): { ok: boolean; data?: any; error?: string } {
  return runOa(["search", query, String(max)]);
}

/** OpenAlex: 关键词检索 (国内可达; 含 OA 标记/DOI/被引) */
export function openalexSearch(query: string, max = 5): { ok: boolean; data?: any; error?: string } {
  return runOa(["openalex", query, String(max)]);
}

/** arXiv: ID → 元数据 + PDF URL */
export function arxivMetadata(id: string): { ok: boolean; data?: any; error?: string } {
  return runOa(["meta", id]);
}

export const oaFallbackService = { checkOa, arxivSearch, openalexSearch, arxivMetadata };
