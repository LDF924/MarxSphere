// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// policy-library-service.ts — 政策资料库服务
// 浏览课题研究政策目录（已有 317 文件）+ gov.cn 检索 + 保存政策到库
// 路径解析统一走 kb-paths (POLICY_DIR 优先, 未配置回退 <数据根>/kb/policy), 每次调用时解析
import fs from "node:fs";
import path from "node:path";
import { policyDir } from "./kb-paths.js";

export interface PolicyTreeNode {
  name: string;
  type: "dir" | "file";
  path: string;
  children?: PolicyTreeNode[];
}

export interface SavedPolicy {
  ok: boolean;
  path?: string;
  error?: string;
  existed?: boolean;
}

function buildTree(dir: string, depth: number): PolicyTreeNode[] {
  if (depth > 4) return [];
  if (!fs.existsSync(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: PolicyTreeNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const children = buildTree(entryPath, depth + 1);
      nodes.push({ name: entry.name, type: "dir", path: entryPath, children });
    } else if (entry.isFile() && /\.(pdf|md|docx?)$/i.test(entry.name)) {
      nodes.push({ name: entry.name, type: "file", path: entryPath });
    }
  }
  nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "zh-CN") : a.type === "dir" ? -1 : 1));
  return nodes;
}

function getPolicyTree(): { root: string; nodes: PolicyTreeNode[] } {
  const root = policyDir();
  if (!fs.existsSync(root)) {
    return { root, nodes: [] };
  }
  return { root, nodes: buildTree(root, 0) };
}

/**
 * 保存 gov.cn 检索到的政策到库：追加到指定子目录的索引 md
 * @param title 政策标题
 * @param url 政策原文 URL
 * @param date 发布日期
 * @param summary 摘要
 * @param category 目标子目录（默认 abeedata-资本相关政策）
 */
function savePolicy(input: {
  title: string;
  url: string;
  date?: string;
  summary?: string;
  category?: string;
}): SavedPolicy {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "标题为空" };

  const category = input.category?.trim() || "abeedata-资本相关政策";
  const categoryDir = path.join(policyDir(), category);

  try {
    fs.mkdirSync(categoryDir, { recursive: true });
  } catch (error) {
    return { ok: false, error: `无法创建目录: ${error instanceof Error ? error.message : String(error)}` };
  }

  // 索引文件名：用标题规范化
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 50);
  const indexPath = path.join(categoryDir, "gov-cn-检索索引.md");

  const entry = [
    `## ${title}`,
    `- **日期**：${input.date || "未知"}`,
    `- **来源**：gov.cn 检索保存（2026-08-02）`,
    input.summary ? `- **摘要**：${input.summary.slice(0, 300)}` : "",
    `- **原文**：${input.url}`,
    ""
  ].join("\n");

  // 追加（已存在则检查是否重复标题）
  const existed = fs.existsSync(indexPath) && fs.readFileSync(indexPath, "utf-8").includes(title);
  if (existed) {
    return { ok: true, path: indexPath, existed: true };
  }
  fs.appendFileSync(indexPath, entry, "utf-8");
  return { ok: true, path: indexPath, existed: false };
}

export const policyLibraryService = {
  getTree: getPolicyTree,
  savePolicy,
  /** 当前政策库根(每次读取, 反映 POLICY_DIR 的实时配置) */
  get policyDir(): string { return policyDir(); }
};
