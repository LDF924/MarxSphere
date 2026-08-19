// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// alias.ts — 别名消解（GBrain 第 11 步 alias）
// 用 entity_norm_dict.json 对查询词做别名归一，提升实体召回质量。
// 例："资本下乡（工商资本）" → normDict 命中 → "资本下乡" 统一
import fs from "node:fs";
import path from "node:path";

let normDict: Record<string, string> | null = null;

export function loadNormDict(): Record<string, string> {
  if (normDict) return normDict;
  try {
    const candidates = [
      path.join(process.env.SAG_ROOT || process.cwd(), "entity_norm_dict.json"),
      path.join(process.env.SAG_ROOT || process.cwd(), "..", "entity_norm_dict.json")
    ];
    for (const file of candidates) {
      if (fs.existsSync(file)) {
        normDict = JSON.parse(fs.readFileSync(file, "utf-8"));
        return normDict!;
      }
    }
  } catch {
    // 字典加载失败不阻塞检索
  }
  normDict = {};
  return normDict;
}

/**
 * 对查询词做别名消解：
 * 1. 整词查 normDict（"资本下乡（工商资本）" → "资本下乡"）
 * 2. 逐 token 查（拆出的实体词命中则替换）
 * @returns 归一后的查询 + 命中的别名替换数（诊断用）
 */
export function aliasNormalize(query: string): { normalized: string; replacements: Array<{ from: string; to: string }> } {
  const dict = loadNormDict();
  const replacements: Array<{ from: string; to: string }> = [];

  if (!query.trim() || Object.keys(dict).length === 0) {
    return { normalized: query, replacements };
  }

  let result = query;
  // 1. 整词直接命中（最常见：查询本身是别名）
  if (dict[result]) {
    const to = dict[result];
    if (to.length >= 2) {
      replacements.push({ from: result, to });
      result = to;
    }
  }

  // 2. 查询含括号别名形式，如 "x（别名）" → 尝试归一
  const parenMatch = result.match(/^([^（(]+)（([^）]+)）$/);
  if (parenMatch) {
    const base = parenMatch[1].trim();
    const alias = parenMatch[2].trim();
    if (dict[alias] && dict[alias] === base) {
      replacements.push({ from: result, to: base });
      result = base;
    } else if (dict[base]) {
      const to = dict[base];
      if (to.length >= 2) {
        replacements.push({ from: result, to });
        result = to;
      }
    }
  }

  return { normalized: result, replacements };
}

/** 供诊断：返回字典规模 */
export function aliasDictSize(): number {
  return Object.keys(loadNormDict()).length;
}
