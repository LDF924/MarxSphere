import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * vault-service — 读取 Obsidian 政策资料库（用户主目录白名单目录）
 *
 * 白名单：~/1.Obsidian Vault 下的课题研究 / 课题文献库 / AI科研指令包V2-Obsidian
 * 提供：目录树 + 文件正文。服务端读取（前端不直接碰文件系统）。
 */

// 脱敏: 个人盘符路径改为 os.homedir() 相对（VAULT_ROOT env 可覆盖）
const VAULT_ROOT = process.env.VAULT_ROOT || path.join(os.homedir(), "1.Obsidian Vault");

const WHITELIST_DIRS = [
  "课题研究",
  "课题文献库（CSSCI、北大核心、CSCD、AMI、WJCI）",
  "AI科研指令包V2-Obsidian"
].map((dir) => path.join(VAULT_ROOT, dir));

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const BINARY_EXTENSIONS = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".epub", ".txt"
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
  return WHITELIST_DIRS.some((dir) => normalized === path.resolve(dir) || normalized.startsWith(path.resolve(dir) + path.sep));
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
  const nodes: VaultTreeNode[] = [];
  for (const dir of WHITELIST_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const children = buildTree(dir, 1) ?? [];
    nodes.push({
      name: path.basename(dir),
      type: "dir",
      path: dir,
      children
    });
  }
  return { root: VAULT_ROOT, nodes };
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
    for (const rootDir of WHITELIST_DIRS) {
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
    const studyDir = path.join(VAULT_ROOT, "课题研究", "学习记录");
    if (!path.resolve(studyDir).startsWith(path.resolve(VAULT_ROOT))) return null;
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

/** V383: 删除 Obsidian 文件（白名单保护 + 只允许删学习记录目录） */
function deleteVaultFile(filePath: string): boolean {
  try {
    const resolved = path.resolve(filePath);
    // 安全边界：只允许删除 学习记录 目录下的文件
    const studyDir = path.resolve(path.join(VAULT_ROOT, "课题研究", "学习记录"));
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
  deleteVaultFile,
};
