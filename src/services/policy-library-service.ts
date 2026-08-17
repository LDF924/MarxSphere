// policy-library-service.ts — 政策资料库服务
// 浏览课题研究政策目录（已有 317 文件）+ gov.cn 检索 + 保存政策到库
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 脱敏: 个人盘符路径改为 os.homedir() 相对（POLICY_DIR env 可覆盖）
const POLICY_DIR = process.env.POLICY_DIR || path.join(os.homedir(), "1.Obsidian Vault", "课题研究", "1.农业农村现代化进程中规范与引导工商资本路径研究", "著作、政策、会议");

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
  if (!fs.existsSync(POLICY_DIR)) {
    return { root: POLICY_DIR, nodes: [] };
  }
  return { root: POLICY_DIR, nodes: buildTree(POLICY_DIR, 0) };
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
  const categoryDir = path.join(POLICY_DIR, category);

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
  policyDir: POLICY_DIR
};
