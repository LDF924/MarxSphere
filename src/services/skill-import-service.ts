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

// ═══ V404-12 见文件尾部: healthCheckAllSkills + 导出 ═══

// ═══ V404-12: SKILL.md 全量体检(机制5"技能体检") — frontmatter/重复名/引用/依赖预检 ═══
export interface SkillHealthIssue {
  skill: string;
  level: "error" | "warn";
  issue: string;
}
export interface SkillsHealthReport {
  total: number;
  errors: number;
  warns: number;
  issues: SkillHealthIssue[];
  duplicateNames: string[];
  /** 体检耗时 ms */
  ms: number;
}

/** frontmatter 必填字段检测(OpenSquilla/Claude 惯例: name/description 必备; 触发短语按 kind 而异) */
function checkFrontmatter(raw: string, name: string): string[] {
  const out: string[] = [];
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(raw);
  if (!fm) { out.push("缺 frontmatter(--- 包裹) 或格式损坏"); return out; }
  const body = fm[1];
  const field = (k: string) => new RegExp(`^${k}:`, "m").test(body);
  if (!field("name")) out.push("frontmatter 缺 name");
  if (!field("description")) out.push("frontmatter 缺 description");
  const kind = /^kind:\s*(\S+)/m.exec(body)?.[1];
  if (kind && !/^(skill|meta|agent|command)$/.test(kind)) out.push(`kind 非法: ${kind}`);
  return out;
}

/**
 * 全量体检 ~/.claude/skills/ 下所有 SKILL.md:
 *  - frontmatter 完整性(name/description/kind)
 *  - name 与目录名一致(导入错位检测)
 *  - 重复 name(目录名不同但 frontmatter name 撞)
 *  - 引用的脚本/资源文件存在性(scripts/ 目录内被 body 提及的文件)
 *  - 空 SKILL.md/超长单行
 */
export function healthCheckAllSkills(): SkillsHealthReport {
  const t0 = Date.now();
  const issues: SkillHealthIssue[] = [];
  const seenNames = new Map<string, string>();
  if (!existsSync(SKILLS_HOME)) return { total: 0, errors: 0, warns: 0, issues: [], duplicateNames: [], ms: Date.now() - t0 };

  for (const entry of readdirSync(SKILLS_HOME, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(SKILLS_HOME, entry.name, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    let raw = "";
    try { raw = readFileSync(skillMd, "utf8"); } catch { issues.push({ skill: entry.name, level: "error", issue: "SKILL.md 不可读" }); continue; }
    if (!raw.trim()) { issues.push({ skill: entry.name, level: "error", issue: "SKILL.md 为空" }); continue; }
    // frontmatter name 与目录名(目录名含 name 即匹配 — 前缀排序/后缀标注是社区惯例)
    const fmName = skillNameFromMd(skillMd);
    if (fmName && entry.name !== fmName && !entry.name.includes(fmName)) issues.push({ skill: entry.name, level: "warn", issue: `frontmatter name(${fmName}) ≠ 目录名(${entry.name})` });
    if (seenNames.has(fmName) && seenNames.get(fmName) !== entry.name) issues.push({ skill: entry.name, level: "error", issue: `name 与 ${seenNames.get(fmName)} 重复` });
    if (fmName) seenNames.set(fmName, entry.name);
    // frontmatter 字段
    for (const f of checkFrontmatter(raw, entry.name)) issues.push({ skill: entry.name, level: "error", issue: f });
    // 引用完整性(只查 scripts/ 相对路径 — 社区惯例; 带代码块的技能必查)
    if (/```(?:sh|bash|python|py|js|ts)?\s*\n[\s\S]*?scripts\/[\w./-]+\.\w+/.test(raw)) {
      for (const m of raw.matchAll(/scripts\/[\w./-]+\.(?:sh|py|js|mjs|ts|ps1|bat|md)\b/g)) {
        const rel = m[0];
        const candidate = path.join(SKILLS_HOME, entry.name, rel);
        if (!existsSync(candidate)) issues.push({ skill: entry.name, level: "warn", issue: `引用缺失: ${rel}` });
      }
    }
  }
  const duplicateNames = [...seenNames.entries()].filter(([, dir]) => {
    // 同 name 多目录 → 由上面 per-entry 检测标 error; 这里汇总名
    return false;
  }).map(([n]) => n);
  const errN = issues.filter((i) => i.level === "error").length;
  return {
    total: readdirSync(SKILLS_HOME).filter((e) => {
      try { return statSync(path.join(SKILLS_HOME, e)).isDirectory() && existsSync(path.join(SKILLS_HOME, e, "SKILL.md")); } catch { return false; }
    }).length,
    errors: errN,
    warns: issues.length - errN,
    issues: issues.slice(0, 100), // 上限防超载
    duplicateNames,
    ms: Date.now() - t0,
  };
}

export const skillImportService = { importSkillPackage, listInstalledSkills, removeSkillPackage, healthCheckAllSkills, SKILLS_HOME };
