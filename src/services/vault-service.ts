// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
import fs from "node:fs";
import path from "node:path";
import { vaultRoot as resolveVaultRoot } from "./kb-paths.js";

/**
 * vault-service — 读取 Obsidian 资料库（白名单目录）
 *
 * 白名单：知识库根下的课题研究 / 课题文献库 / AI科研指令包V2-Obsidian
 * 提供：目录树 + 文件正文。服务端读取（前端不直接碰文件系统）。
 *
 * 路径解析统一走 kb-paths: VAULT_ROOT 优先, 未配置回退 <数据根>/kb/vault。
 * 必须是**每次调用时解析** —— 测试会临时改 VAULT_ROOT 来隔离目录。
 */

/** 白名单子目录名（相对知识库根） */
const WHITELIST_NAMES = [
  "课题研究",
  "课题文献库（CSSCI、北大核心、CSCD、AMI、WJCI）",
  "AI科研指令包V2-Obsidian"
];

function whitelistDirs(): string[] {
  const root = resolveVaultRoot();
  return WHITELIST_NAMES.map((dir) => path.join(root, dir));
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
/**
 * 目录树里会列出的**非 Markdown** 扩展名。
 *
 * ⚠ 2026-10-02 扩充: 原先只有 pdf/图片/Office/txt —— 于是 `.drawio` / `.geojson` /
 *   `.csv` / `.kml` 这些**在前端已经能预览**的格式, 在资料库树里**压根不显示**
 *   (buildTree 会把它们跳过)。我给预览器加了格式却忘了这里, 结果是"功能做了但够不着":
 *   实测放进去的 4 个文件在树里一个都看不到。
 *   (与"kind 静默降级"同型 —— 白名单不报错, 只是把东西悄悄藏起来。)
 *
 * 判据: 只要前端 `web/src/lib/file-kind.ts` 能认, 这里就要放行。
 *   两边靠**这个注释**保持同步, 没有编译期约束 —— 改一边记得看另一边。
 */
const BINARY_EXTENSIONS = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".avif",
  ".doc", ".docx", ".xls", ".xlsx", ".xlsm", ".ppt", ".pptx", ".epub", ".txt",
  // 表格与数据
  ".csv", ".tsv", ".json", ".jsonl", ".log", ".tex", ".bib", ".rtf",
  // 图形
  ".drawio", ".xml",
  // 空间数据
  ".geojson", ".topojson", ".kml", ".gpx",
]);

export interface VaultTreeNode {
  name: string;
  type: "dir" | "file";
  path: string;
  children?: VaultTreeNode[];
}

export interface VaultFileRecord {
  path: string;
  name: string;
  content: string;
  size: number;
  modifiedAt: string;
}

function isAllowedRoot(absolutePath: string): boolean {
  const normalized = path.resolve(absolutePath);
  return whitelistDirs().some((dir) => normalized === path.resolve(dir) || normalized.startsWith(path.resolve(dir) + path.sep));
}

function buildTree(dir: string, depth: number): VaultTreeNode[] | null {
  if (depth > 6) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const nodes: VaultTreeNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(dir, entry.name);
    if (!isAllowedRoot(entryPath)) continue;
    if (entry.isDirectory()) {
      const children = buildTree(entryPath, depth + 1);
      nodes.push({
        name: entry.name,
        type: "dir",
        path: entryPath,
        children: children ?? []
      });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (MARKDOWN_EXTENSIONS.has(ext) || BINARY_EXTENSIONS.has(ext)) {
        nodes.push({
          name: entry.name,
          type: "file",
          path: entryPath
        });
      }
    }
  }

  nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "zh-CN") : a.type === "dir" ? -1 : 1));
  return nodes;
}

function getVaultTree(): { root: string; nodes: VaultTreeNode[] } {
  const root = resolveVaultRoot();
  const nodes: VaultTreeNode[] = [];
  for (const dir of whitelistDirs()) {
    if (!fs.existsSync(dir)) continue;
    const children = buildTree(dir, 1) ?? [];
    nodes.push({
      name: path.basename(dir),
      type: "dir",
      path: dir,
      children
    });
  }
  return { root, nodes };
}

function getVaultFile(filePath: string): VaultFileRecord | null {
  const resolved = path.resolve(filePath);
  if (!isAllowedRoot(resolved)) {
    throw new VaultError("VAULT_ACCESS_DENIED", "路径不在白名单目录内");
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  const stat = fs.statSync(resolved);
  const content = fs.readFileSync(resolved, "utf-8");
  return {
    path: resolved,
    name: path.basename(resolved),
    content,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString()
  };
}

/** 二进制文件（PDF/图片等）读取，供浏览器预览/下载 */
function getVaultBinary(filePath: string): { name: string; data: Buffer; size: number } | null {
  const resolved = path.resolve(filePath);
  if (!isAllowedRoot(resolved)) {
    throw new VaultError("VAULT_ACCESS_DENIED", "路径不在白名单目录内");
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  const stat = fs.statSync(resolved);
  const data = fs.readFileSync(resolved);
  return { name: path.basename(resolved), data, size: stat.size };
}

/** 文件扩展名 → MIME 类型 */
function mimeForFile(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".epub": "application/epub+zip",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };
  return map[ext] || "application/octet-stream";
}

class VaultError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ═══════ V383: Obsidian 学习联动 — 资料搜索 + 学习记录 ═══════

/** 在 Obsidian 库中按关键词搜索 markdown 资料（标题/正文匹配，返回路径+标题+摘要） */
function searchVault(keyword: string, limit = 8): Array<{ path: string; name: string; snippet: string }> {
  const results: Array<{ path: string; name: string; snippet: string }> = [];
  const kw = keyword.trim();
  if (!kw) return results;
  try {
    for (const rootDir of whitelistDirs()) {
      if (!fs.existsSync(rootDir)) continue;
      const walk = (dir: string) => {
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          if (results.length >= limit) return;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) { walk(full); continue; }
          if (!MARKDOWN_EXTENSIONS.has(path.extname(ent.name).toLowerCase())) continue;
          try {
            const content = fs.readFileSync(full, "utf-8").substring(0, 2000);
            if (ent.name.includes(kw) || content.includes(kw)) {
              const idx = content.indexOf(kw);
              const snippet = idx >= 0 ? content.substring(Math.max(0, idx - 40), idx + 80).replace(/\n+/g, " ") : "";
              results.push({ path: full, name: ent.name.replace(/\.md$/, ""), snippet });
            }
          } catch { /* 跳过不可读文件 */ }
        }
      };
      walk(rootDir);
    }
  } catch { /* 搜索失败不阻塞 */ }
  return results.slice(0, limit);
}

/** 保存学习记录到 Obsidian（写 课题研究/学习记录/ 目录）——白名单保护，只允许写学习记录子目录 */
function saveStudyNote(input: { title: string; content: string; subject?: string }): { path: string; name: string } | null {
  try {
    const root = resolveVaultRoot();
    const studyDir = path.join(root, "课题研究", "学习记录");
    if (!path.resolve(studyDir).startsWith(path.resolve(root))) return null;
    fs.mkdirSync(studyDir, { recursive: true });
    const safeSubject = (input.subject || "通用").replace(/[\\/:*?"<>|]/g, "_");
    const safeTitle = (input.title || "学习记录").replace(/[\\/:*?"<>|]/g, "_").substring(0, 60);
    const timestamp = new Date().toISOString().slice(0, 10);
    const fileName = `${timestamp}_${safeSubject}_${safeTitle}.md`;
    const filePath = path.join(studyDir, fileName);
    const body = `# ${input.title}\n\n> 记录时间：${new Date().toLocaleString("zh-CN")}\n> 科目：${input.subject || "通用"}\n\n${input.content}\n`;
    fs.writeFileSync(filePath, body, "utf-8");
    return { path: filePath, name: fileName };
  } catch { return null; }
}

/**
 * 网页归档 → 资料库(2026-10-03)。
 *
 * ⚠ 安全边界与 saveStudyNote **完全一样**: 只写 `课题研究/网页归档/` 这一个子目录,
 *   文件名做去污, 且写入前再校验一次解析后的路径确实在该目录下。
 *   为什么另开一个目录而不是塞进"学习记录": 学习记录是**我自己写的**, 网页归档是
 *   **外部抓来的** —— 两者的可信度不同, 混在一起会让"哪些内容有出处"这件事变模糊。
 *
 * 放在 vault 里的意义: 它立刻出现在资料库树里、能被 /api/vault/search 检索到、
 *   能被写作舱当素材引用 —— 这就是"归档联动资料库"。
 */
function saveWebArchive(input: {
  title: string; url: string; markdown: string; fetchedAt: string; quality?: Record<string, unknown>;
}): { path: string; name: string } | null {
  try {
    const root = resolveVaultRoot();
    const dir = path.join(root, "课题研究", "网页归档");
    // 二次校验: 解析后必须在 vault 根下(防 .. 之类)
    if (!path.resolve(dir).startsWith(path.resolve(root))) return null;
    fs.mkdirSync(dir, { recursive: true });

    const safe = (x: string) => String(x || "").replace(/[\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
    const day = String(input.fetchedAt || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
    const base = safe(input.title).slice(0, 60) || "未命名页面";
    const fileName = `${day}_${base}.md`;
    const filePath = path.join(dir, fileName);

    const q = input.quality ?? {};
    const body = [
      `# ${input.title || "（无标题）"}`,
      "",
      `> 来源：${input.url}`,
      `> 归档时间：${input.fetchedAt}`,
      q.label ? `> 抽取质量：${q.label}（分 ${q.score ?? "?"}，${q.chars ?? 0} 字）` : "",
      "",
      "---",
      "",
      input.markdown,
    ].filter((x) => x !== "").join("\n");
    fs.writeFileSync(filePath, body, "utf-8");
    return { path: filePath, name: fileName };
  } catch { return null; }
}

/** V383: 删除 Obsidian 文件（白名单保护 + 只允许删学习记录目录） */
function deleteVaultFile(filePath: string): boolean {
  try {
    const resolved = path.resolve(filePath);
    // 安全边界：只允许删除 学习记录 目录下的文件
    const studyDir = path.resolve(path.join(resolveVaultRoot(), "课题研究", "学习记录"));
    if (!resolved.startsWith(studyDir + path.sep) && resolved !== studyDir) return false;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;
    fs.unlinkSync(resolved);
    return true;
  } catch { return false; }
}

export const vaultService = {
  getTree: getVaultTree,
  getFile: getVaultFile,
  getBinary: getVaultBinary,
  mimeFor: mimeForFile,
  isAllowedRoot,
  // V383: 学习联动
  searchVault,
  saveStudyNote,
  saveWebArchive,
  deleteVaultFile,
};
