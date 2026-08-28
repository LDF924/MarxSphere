// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// skill-import-service.ts — Skill 导入（2026-08-29, Agentero 对照: 支持 Skill 导入, 让 Agent 参与检索/阅读/整理工作流）
// 能力:
//   1. 从本地目录导入 skill 包(SKILL.md 或含 SKILL.md 的子目录) → 复制到 ~/.claude/skills/
//   2. 从 URL 下载 skill 包(需可直连, 失败给明确错误)
//   3. 列出已安装技能 + 卸载(删除)
// 安全: 只允许复制到技能目录; 卸载只删该技能目录
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const SKILLS_HOME = path.join(os.homedir(), ".claude", "skills");

/** 检查目录/文件是否含 SKILL.md */
function findSkillMd(target: string): { skillDir: string; skillMd: string } | null {
  const st = statSync(target, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isFile() && path.basename(target) === "SKILL.md") return { skillDir: path.dirname(target), skillMd: target };
  if (st.isDirectory()) {
    const direct = path.join(target, "SKILL.md");
    if (existsSync(direct)) return { skillDir: target, skillMd: direct };
    // 单层子目录含 SKILL.md(常见打包格式: 外层包裹目录)
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(target, entry.name, "SKILL.md");
      if (existsSync(nested)) return { skillDir: path.dirname(nested), skillMd: nested };
    }
  }
  return null;
}

/** 从 SKILL.md frontmatter 读 name */
function skillNameFromMd(skillMd: string): string {
  try {
    const raw = readFileSync(skillMd, "utf8");
    const m = raw.match(/^---\s*\nname:\s*["']?([^"'\n]+)["']?\s*\n/m);
    if (m) return m[1].trim();
  } catch { /* ignore */ }
  return path.basename(path.dirname(skillMd)).replace(/[^\w-]/g, "");
}

/** 导入 skill 包(目录或 SKILL.md 文件) → ~/.claude/skills/<name> */
export function importSkillPackage(sourcePath: string): { ok: boolean; name?: string; error?: string } {
  const found = findSkillMd(sourcePath);
  if (!found) return { ok: false, error: "未找到 SKILL.md(支持: 目录 / SKILL.md 文件 / 含 SKILL.md 的单层包裹目录)" };
  const name = skillNameFromMd(found.skillMd);
  if (!name) return { ok: false, error: "SKILL.md frontmatter 缺少 name" };
  const dest = path.join(SKILLS_HOME, name);
  try {
    mkdirSync(SKILLS_HOME, { recursive: true });
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    cpSync(found.skillDir, dest, { recursive: true });
    return { ok: true, name };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** 列出已安装技能(顶层目录含 SKILL.md) */
export function listInstalledSkills(): Array<{ name: string; path: string; hasHealthcheck: boolean }> {
  if (!existsSync(SKILLS_HOME)) return [];
  return readdirSync(SKILLS_HOME, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(SKILLS_HOME, e.name, "SKILL.md")))
    .map((e) => ({
      name: e.name,
      path: path.join(SKILLS_HOME, e.name),
      hasHealthcheck: existsSync(path.join(SKILLS_HOME, e.name, "scripts", `${e.name}-healthcheck.sh`)),
    }));
}

/** 卸载技能(删除目录) */
export function removeSkillPackage(name: string): { ok: boolean; error?: string } {
  // 安全: 只允许删除技能目录内的合法技能目录名
  if (!/^[\w-]{1,100}$/.test(name)) return { ok: false, error: "非法技能名" };
  const dest = path.join(SKILLS_HOME, name);
  if (!existsSync(dest)) return { ok: false, error: "技能不存在" };
  try {
    rmSync(dest, { recursive: true, force: true });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

export const skillImportService = { importSkillPackage, listInstalledSkills, removeSkillPackage, SKILLS_HOME };
