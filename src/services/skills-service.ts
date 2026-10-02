// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * skills-service — 扫描 ~/.claude/skills 目录下各 SKILL.md，解析 frontmatter 生成注册表
 *
 * 规范（用户 marx-* 系列统一格式）：
 *   name: kebab-case
 *   description: 版本+日期+数据规模+评测值密集摘要
 *   triggers: [中文触发词]
 *   notTriggers: [反触发]
 */

const execFileAsync = promisify(execFile);

export interface SkillRecord {
  name: string;
  description: string;
  triggers: string[];
  notTriggers: string[];
  path: string;
  skillMdPath: string;
  hasHealthcheck: boolean;
  healthcheckPath?: string;
  /** 中文名（来自 _中文说明/xxx.zh-CN.md 标题） */
  zhName?: string;
  /** 分类（来自 _中文说明/xxx.zh-CN.md 分类行） */
  zhCategory?: string;
  /** 中文用途（来自 _中文说明/xxx.zh-CN.md 用途段） */
  zhDescription?: string;
  // ── 云端分发元数据（2026-10-02）──
  // 对照 Respal: 它每个技能的 frontmatter 都带 cloudSource/cloudId/cloudUpdated,
  // 用来做"这个技能是从广场装的、服务端编号 26、上次更新于 …"。本仓此前为 0 个。
  // 三者**可独立为空**: 本地自建技能就是三个都没有, 不该被当成异常。
  /** 来源: public(广场公开) / private / ''(本地自建) */
  cloudSource?: string;
  /** 服务端编号 */
  cloudId?: string;
  /** 服务端上次更新时刻(epoch 秒, 与 Respal 同口径存字符串) */
  cloudUpdated?: string;
}

interface Frontmatter {
  name?: string;
  description?: string;
  triggers?: string[];
  notTriggers?: string[];
  titleZh?: string;
  categoryZh?: string;
  cloudSource?: string;
  cloudId?: string;
  cloudUpdated?: string;
}

function parseFrontmatter(raw: string): Frontmatter {
  const result: Frontmatter = {};
  const start = raw.indexOf("---");
  if (start !== 0) return result;
  const end = raw.indexOf("---", start + 3);
  if (end === -1) return result;
  const block = raw.slice(start + 3, end);

  // name / description (简单值 + YAML 多行折叠 >- / |)
  const nameMatch = block.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m);
  if (nameMatch) result.name = nameMatch[1].trim();

  // 固化的中文字段（title_zh / category_zh，由固化脚本写入 SKILL.md frontmatter）
  const titleZhMatch = block.match(/^title_zh:\s*(.+)$/m);
  if (titleZhMatch) result.titleZh = titleZhMatch[1].trim().replace(/^["']|["']$/g, "");
  const categoryZhMatch = block.match(/^category_zh:\s*(.+)$/m);
  if (categoryZhMatch) result.categoryZh = categoryZhMatch[1].trim().replace(/^["']|["']$/g, "");

  // 云端分发元数据（2026-10-02）—— 与 title_zh/category_zh 同一套正则, 保持解析风格一致
  const cloudSourceMatch = block.match(/^cloudSource:\s*(.+)$/m);
  if (cloudSourceMatch) result.cloudSource = cloudSourceMatch[1].trim().replace(/^["']|["']$/g, "");
  const cloudIdMatch = block.match(/^cloudId:\s*(.+)$/m);
  if (cloudIdMatch) result.cloudId = cloudIdMatch[1].trim().replace(/^["']|["']$/g, "");
  const cloudUpdatedMatch = block.match(/^cloudUpdated:\s*(.+)$/m);
  if (cloudUpdatedMatch) result.cloudUpdated = cloudUpdatedMatch[1].trim().replace(/^["']|["']$/g, "");

  const descMatch = block.match(/^description:\s*(.+)$/m);
  if (descMatch) {
    const firstLine = descMatch[1].trim();
    const foldMatch = firstLine.match(/^([>|])-?\s*$/);
    if (foldMatch) {
      // 多行折叠：收集后续所有缩进行
      const startIdx = (descMatch.index ?? 0) + descMatch[0].length;
      const rest = block.slice(startIdx);
      const lines: string[] = [];
      let seenContent = false;
      for (const line of rest.split("\n")) {
        const trimmed = line.trim();
        if (!seenContent && trimmed === "") continue;
        if (/^[a-zA-Z_]+:/.test(trimmed) && !seenContent) break;
        if (trimmed === "" || /^[a-zA-Z_]+:/.test(trimmed)) break;
        seenContent = true;
        lines.push(trimmed);
      }
      result.description = lines.join(" ").replace(/^["']|["']$/g, "");
    } else {
      result.description = firstLine.replace(/^["']|["']$/g, "");
    }
  }

  // triggers / notTriggers（YAML 数组，支持 [a, b] 或 - item 两种形式）
  const parseArray = (key: string): string[] | undefined => {
    const arrMatch = block.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m"));
    if (arrMatch) {
      return arrMatch[1]
        .split(",")
        .map((item) => item.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
    const listMatch = block.match(new RegExp(`^${key}:\\s*$`, "m"));
    if (listMatch) {
      const rest = block.slice(block.indexOf(key) + key.length);
      const items = rest
        .split("\n")
        .filter((line) => line.trim().startsWith("- "))
        .map((line) => line.trim().slice(2).trim())
        .filter(Boolean);
      if (items.length > 0) return items;
    }
    return undefined;
  };

  result.triggers = parseArray("triggers");
  result.notTriggers = parseArray("notTriggers");
  return result;
}

function extractFrontmatter(raw: string): Frontmatter {
  return parseFrontmatter(raw);
}

/** 递归收集目录下的 SKILL.md 技能（含嵌套：合集包 research/x/SKILL.md、_skills/x/SKILL.md）
 * V395-19: 跟随 symlink（顶层快捷方式指向深层嵌套）+ 深度放宽到 5 层 — 修复 16 个 symlink 技能未被审计
 * 返回 [{name, dir, skillMdPath}]；name 用相对路径（如 "kthorn/searching-literature"）避免顶层重名 */
function collectSkillMds(root: string): Array<{ name: string; dir: string; skillMdPath: string }> {
  const out: Array<{ name: string; dir: string; skillMdPath: string }> = [];
  const seen = new Set<string>();  // 防 symlink 环/重复
  const stack: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: "", depth: 0 }];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try { entries = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      // V395-19: isSymbolicLink 也视为目录（顶层快捷方式指向深层 _skills/ 技能）
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name === "_中文说明" || entry.name === "__pycache__" || entry.name === ".git" || entry.name === "node_modules") continue;
      const childDir = path.join(cur.dir, entry.name);
      const resolved = fs.realpathSync(childDir);  // 解析 symlink 防环
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      const childRel = cur.rel ? `${cur.rel}/${entry.name}` : entry.name;
      const nestedMd = path.join(childDir, "SKILL.md");
      if (fs.existsSync(nestedMd)) {
        out.push({ name: childRel, dir: childDir, skillMdPath: nestedMd });
      } else if (cur.depth < 4) {
        // 继续往下找（最多 5 层, 覆盖 _skills/analysis/xxx 4 层深）
        stack.push({ dir: childDir, rel: childRel, depth: cur.depth + 1 });
      }
    }
  }
  return out;
}

export function listSkills(): SkillRecord[] {
  // V413: 同时读用户 skills（~/.claude/skills）+ 随包自带（SAG_ROOT/skills）
  const dirs: string[] = [path.join(os.homedir(), ".claude", "skills")];
  if (process.env.SAG_ROOT) dirs.push(path.join(process.env.SAG_ROOT, "skills"));

  const records: SkillRecord[] = [];
  for (const skillsDir of dirs) {
    if (!fs.existsSync(skillsDir)) continue;

    // 中文说明目录：_中文说明/{skillName}.zh-CN.md
    const zhDocsDir = path.join(skillsDir, "_中文说明");

  // 第一遍：顶层技能（原有逻辑）
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    // Windows junction 对 isDirectory() 返回 false，需用 isSymbolicLink() 兜底（嵌套技能链接到顶层）
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === "_中文说明" || entry.name === "__pycache__") continue;
    const skillDir = path.join(skillsDir, entry.name);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const raw = fs.readFileSync(skillMdPath, "utf-8");
      const fm = extractFrontmatter(raw);
      const healthcheckDir = path.join(skillDir, "scripts");
      let healthcheckPath: string | undefined;
      if (fs.existsSync(healthcheckDir)) {
        const scripts = fs.readdirSync(healthcheckDir).filter((f) => f.endsWith("-healthcheck.sh"));
        if (scripts.length > 0) {
          healthcheckPath = path.join(healthcheckDir, scripts[0]);
        }
      }

      // 中文名/分类：只读固化的 SKILL.md frontmatter（title_zh/category_zh）
      // 固化脚本已把中文元数据写入每个纯英文技能自身，不依赖外部文件
      const zhName = fm.titleZh;
      const zhCategory = fm.categoryZh;
      let zhDescription: string | undefined;
      if (zhName) {
        const zhDocPath = path.join(zhDocsDir, `${entry.name}.zh-CN.md`);
        if (fs.existsSync(zhDocPath)) {
          const zhDoc = fs.readFileSync(zhDocPath, "utf-8");
          const useMatch = zhDoc.split("## 用途")[1]?.split(/\n## /)[0];
          if (useMatch) {
            zhDescription = useMatch.replace(/^[\s"']+|["'\s]+$/g, "").slice(0, 300);
          }
        }
      }

      records.push({
        // 注册名优先用目录名（kebab-case，与 Claude Code 调用名一致）；
        // 仅当 frontmatter name 是合法 kebab-case 且非空时才采用（05 包等 frontmatter 带空格名不用）
        name: fm.name && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name) ? fm.name : entry.name,
        description: fm.description || "",
        triggers: fm.triggers || [],
        notTriggers: fm.notTriggers || [],
        path: skillDir,
        skillMdPath,
        hasHealthcheck: Boolean(healthcheckPath),
        healthcheckPath,
        zhName,
        zhCategory,
        zhDescription,
        cloudSource: fm.cloudSource,
        cloudId: fm.cloudId,
        cloudUpdated: fm.cloudUpdated
      });
    } catch {
      // 跳过解析失败的 skill
    }
  }

  // 第二遍：嵌套技能（合集包内 research/*/SKILL.md、_skills/*/SKILL.md 等）
  // name 用相对路径（如 "kthorn/searching-literature"），零文件移动、不破坏合集包结构
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === "_中文说明" || entry.name === "__pycache__") continue;
    const pkgDir = path.join(skillsDir, entry.name);
    if (fs.existsSync(path.join(pkgDir, "SKILL.md"))) continue; // 顶层已有 SKILL.md 的跳过
    for (const nested of collectSkillMds(pkgDir)) {
      try {
        const raw = fs.readFileSync(nested.skillMdPath, "utf-8");
        const fm = extractFrontmatter(raw);
        // 嵌套技能的 healthcheck 在同级 scripts/
        let healthcheckPath: string | undefined;
        const hcDir = path.join(nested.dir, "scripts");
        if (fs.existsSync(hcDir)) {
          const scripts = fs.readdirSync(hcDir).filter((f) => f.endsWith("-healthcheck.sh"));
          if (scripts.length > 0) healthcheckPath = path.join(hcDir, scripts[0]);
        }
        records.push({
          name: `${entry.name}/${(fm.name && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name) ? fm.name : nested.name)}`,
          description: fm.description || "",
          triggers: fm.triggers || [],
          notTriggers: fm.notTriggers || [],
          path: nested.dir,
          skillMdPath: nested.skillMdPath,
          hasHealthcheck: Boolean(healthcheckPath),
          healthcheckPath,
          zhName: fm.titleZh,
          zhCategory: fm.categoryZh,
          cloudSource: fm.cloudSource,
          cloudId: fm.cloudId,
          cloudUpdated: fm.cloudUpdated,
        });
      } catch {
        // 跳过解析失败的嵌套 skill
      }
    }
  }
  }

  records.sort((a, b) => a.name.localeCompare(b.name));
  return records;
}

/** 技能详情：SKILL.md 全文 + 中文说明 + 目录结构 */
export function getSkillDetail(name: string): {
  name: string;
  skillMd: string;
  skillMdPath: string;
  zhDoc?: string;
  files: string[];
} | null {
  const skillsDir = path.join(os.homedir(), ".claude", "skills");
  // 支持嵌套技能名（"pkg/nested" → skillsDir/pkg/nested/SKILL.md）
  const isNested = name.includes("/");
  const skillDir = isNested
    ? path.join(skillsDir, name.split("/")[0], ...name.split("/").slice(1))
    : path.join(skillsDir, name);
  let skillMdPath = path.join(skillDir, "SKILL.md");
  // V399: 目录名 ≠ frontmatter name 时按 name 模糊匹配（如 searchSkill 返回 causal-inference-mixtape，
  // 实际目录 10-Jill0099-causal-inference-mixtape）— 递归一层模糊查找
  if (!fs.existsSync(skillMdPath) && !isNested) {
    let matchedDir: string | null = null;
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(skillsDir, entry.name, "SKILL.md");
      if (!fs.existsSync(candidate)) continue;
      const head = fs.readFileSync(candidate, "utf8").slice(0, 500);
      if (head.includes(`name: ${name}`) || head.includes(`name: "${name}"`) || entry.name.includes(name)) {
        matchedDir = path.join(skillsDir, entry.name);
        break;
      }
    }
    if (matchedDir) skillMdPath = path.join(matchedDir, "SKILL.md");
  }
  if (!fs.existsSync(skillMdPath)) return null;

  const skillMd = fs.readFileSync(skillMdPath, "utf-8");
  const zhDocPath = path.join(skillsDir, "_中文说明", `${name}.zh-CN.md`);
  const zhDoc = fs.existsSync(zhDocPath) ? fs.readFileSync(zhDocPath, "utf-8") : undefined;

  // 目录结构（一层）— 用实际存在的 skillDir（name 模糊匹配后可能是不同目录）
  const actualSkillDir = path.dirname(skillMdPath);
  const files: string[] = [];
  if (fs.existsSync(actualSkillDir)) {
    for (const entry of fs.readdirSync(actualSkillDir, { withFileTypes: true })) {
      files.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
    }
  }
  return { name, skillMd, skillMdPath, zhDoc, files };
}

/**
 * 技能**捆绑的可执行资产** —— 技能目录下 `scripts/` 里的文件（绝对路径）。
 *
 * 由来(2026-10-01): 在此之前, 平台对技能的使用**只到"把 SKILL.md 读成文本"为止**
 *   (`view_skill_run` 就是这么实现的), 技能自带的脚本一个都没被用过。
 *   而这批脚本恰恰是技能作者沉淀下来的**确定性资产** —— 例如
 *   `nature-paper2ppt/scripts/audit_pptx_quality.py` 会去查"文字是否溢出画布"
 *   "元素是否差几 pt 没对齐", 正是它自己在 `output-and-quality.md` 里定的交付标准。
 *
 *   实测: 平台生成的 pptx 丢给它一跑, `high=20` —— 几乎每页都溢出。
 *   **标准写在文档里、产物没人验**, 这就是"技能只当上下文"的具体代价。
 *
 * 只列 `scripts/` 一层, 不递归: 技能目录里还有 static/references/agents 等
 * 纯文档目录, 混在一起会让调用方分不清哪些能执行。
 */
export function skillScripts(name: string): string[] {
  try {
    const d = getSkillDetail(name);
    if (!d) return [];
    const scriptDir = path.join(path.dirname(d.skillMdPath), "scripts");
    if (!fs.existsSync(scriptDir)) return [];
    return fs.readdirSync(scriptDir)
      .filter((f) => !f.startsWith(".") && !f.startsWith("__"))
      .map((f) => path.join(scriptDir, f));
  } catch {
    return [];
  }
}

/**
 * 技能里可作为**产物质检**用途的脚本。
 *
 * ⚠ 排除 `generic-healthcheck`: 那是每个技能都带的**环境自检**(检查依赖是否装好),
 *   不是"检查这次产出好不好"。2026-10-01 实测若不排除, `scholar-slides` 会挑中它,
 *   于是模型拿到的"自检脚本"是查环境的 —— 而真正该跑的是 `qa_report.mjs` /
 *   `validate_deck.mjs` 那几个。
 *
 * 排序按"像不像在查产物质量"排: 名字里带 pptx/deck/slide 且带 qa/audit/validate/verify
 * 的最靠前, 只带通用词的靠后。返回**全部**候选(不是只给第一个) —— 让调用方自己挑,
 * 也便于诊断时看清技能到底提供了什么。
 */
export function skillVerifierScripts(name: string): string[] {
  const rank = (p: string): number => {
    const b = path.basename(p).toLowerCase();
    if (b.includes("generic-healthcheck")) return 99;          // 环境自检, 与产物质量无关
    const isProduct = /(pptx|deck|slide|presentation)/.test(b);
    const isCheck = /(audit|qa|check|verify|validate)/.test(b);
    return isProduct && isCheck ? 0 : isCheck ? 1 : 2;
  };
  return skillScripts(name)
    .map((p) => ({ p, r: rank(p) }))
    // 只留**校验类**(r<2): r=2 是构建/处理脚本(如 build_deck.mjs、crop_figure.py) ——
    //   它们是"生产"不是"检查", 混进这个函数名会误导调用方
    .filter((x) => x.r < 2 && /\.(py|mjs|js|cjs|ts|sh)$/.test(x.p))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.p);
}

export async function runSkillHealthcheck(name: string): Promise<{  name: string;
  exists: boolean;
  status: string;
  output: string;
  exitCode: number | null;
}> {
  const records = listSkills();
  const record = records.find((skill) => skill.name === name);
  if (!record || !record.healthcheckPath) {
    return {
      name,
      exists: Boolean(record),
      status: record?.hasHealthcheck ? "no_script" : "not_found",
      output: record?.hasHealthcheck ? "skill 无 healthcheck 脚本" : "skill 不存在",
      exitCode: null
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync("bash", [record.healthcheckPath], {
      timeout: 30_000,
      env: { ...process.env, PATH: process.env.PATH || "" }
    });
    return {
      name,
      exists: true,
      status: "ok",
      output: stdout.trim() || stderr.trim(),
      exitCode: 0
    };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return {
      name,
      exists: true,
      status: "error",
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || String(error),
      exitCode: err.code ?? null
    };
  }
}

export const skillsService = {
  listSkills,
  runSkillHealthcheck,
  getSkillDetail,
  skillify,
  searchSkill,          // V331(P1-3): 技能语义搜索
  indexSkillsEmbeddings, // V317(P1-3): 建技能语义索引
  auditSkillsLive,      // V332: 实时审计
};

// ─── Skillify: 把成功工作流固化为可复用 skill ───

export interface SkillifyInput {
  name: string;
  title: string;
  description?: string;
  triggers?: string[];
  notTriggers?: string[];
  steps: string[];
  checklist?: string[];
  recipes?: string[];
}

export async function skillify(input: SkillifyInput): Promise<{
  ok: boolean;
  path?: string;
  error?: string;
}> {
  const name = input?.name?.trim();
  if (!name || !/^[a-z0-9-]+$/.test(name)) {
    return { ok: false, error: "skill 名必须是小写字母数字连字符" };
  }
  if (!input?.steps || input.steps.length === 0) {
    return { ok: false, error: "至少需要一个执行步骤" };
  }

  const skillsDir = path.join(os.homedir(), ".claude", "skills");
  const targetDir = path.join(skillsDir, name);
  const skillMdPath = path.join(targetDir, "SKILL.md");

  if (fs.existsSync(skillMdPath)) {
    return { ok: false, error: `SKILL.md 已存在: ${skillMdPath}，拒绝覆盖` };
  }

  const now = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${name}`);
  lines.push(`description: "${input.description || ""} (Skillify 固化 ${now})"`);
  if (input.triggers?.length) lines.push(`triggers: [${input.triggers.join(", ")}]`);
  if (input.notTriggers?.length) lines.push(`notTriggers: [${input.notTriggers.join(", ")}]`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${input.title || name}（Skillify 固化技能）`);
  lines.push("");
  lines.push(`> **Skillify**: ${now} 由 SAG 记录的成功工作流固化生成。`);
  lines.push("");
  lines.push("## 何时使用");
  lines.push("");
  lines.push(`- ${input.description || "（无描述）"}`);
  lines.push("");
  lines.push("## 执行步骤");
  lines.push("");
  input.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  lines.push("");
  if (input.recipes?.length) {
    lines.push("## Recipes");
    lines.push("");
    input.recipes.forEach((recipe) => lines.push(`- ${recipe}`));
    lines.push("");
  }
  lines.push("## Checklist（Skillify 固化）");
  lines.push("");
  input.checklist?.forEach((item) => lines.push(`- [ ] ${item}`));
  lines.push("");
  lines.push("## 备注");
  lines.push("");
  lines.push("- 本 skill 由 Skillify 机制自动生成，可人工修改完善。");
  lines.push("- 遵守学术诚信：产出必须人工核实，引用须真实。");

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(skillMdPath, lines.join("\n"), "utf-8");
    return { ok: true, path: skillMdPath };
  } catch (error) {
    return { ok: false, error: `写入失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ═══════════ P1-3 主动工具发现：技能语义索引 + 搜索（2026-08-08）═══════════
// 书中 Ch4 MCP-Zero 模式: 技能嵌入检索, 模型不确定用哪个技能时语义搜索
// skill_embeddings 表存 187 技能的 description+正文向量; searchSkill 余弦相似度 top-5
import { embeddingClient } from "../ai/embedding-client.js";
import { pool } from "../db/pool.js";

/** 建技能语义索引：遍历技能, description+前500字正文 → embedding 存表 */
export async function indexSkillsEmbeddings(): Promise<{ indexed: number; failed: number }> {
  const skills = listSkills();
  let indexed = 0, failed = 0;
  for (const skill of skills) {
    try {
      // 提取 description（frontmatter）+ 正文前 500 字
      const raw = fs.readFileSync(skill.skillMdPath, "utf-8");
      const fm = extractFrontmatter(raw);
      const desc = fm.description || skill.name;
      const body = raw.replace(/^---\s*\n[\s\S]*?\n---\s*/, "").substring(0, 500);
      const text = `${desc}\n${body}`.substring(0, 1000);
      const vec = await embeddingClient.generate(text);
      if (!vec || vec.length === 0) { failed++; continue; }
      await pool.query(
        `insert into skill_embeddings (skill_name, embedding, source, updated_at)
         values ($1, $2, 'description+body', now())
         on conflict (skill_name) do update set embedding = $2, source = 'description+body', updated_at = now()`,
        [skill.name, JSON.stringify(vec)]
      );
      indexed++;
    } catch { failed++; }
  }
  return { indexed, failed };
}

/** 语义搜索技能: query → embedding → 余弦相似度 top-N; 相似度 < 阈值返回 found:false */
export async function searchSkill(query: string, topN = 5, minSimilarity = 0.5): Promise<{ found: boolean; candidates: Array<{ skillName: string; similarity: number }> }> {
  try {
    const qVec = await embeddingClient.generate(query);
    if (!qVec || qVec.length === 0) return { found: false, candidates: [] };
    const qNorm = Math.sqrt(qVec.reduce((s, v) => s + v * v, 0));
    if (qNorm === 0) return { found: false, candidates: [] };

    const r = await pool.query("select skill_name, embedding from skill_embeddings");
    const scored: Array<{ skillName: string; similarity: number }> = r.rows
      .map((row: any) => {
        // pgvector 返回字符串格式 [-0.01,0.02,...]（合法 JSON 数组文本）
        let e: number[] | null = null;
        if (Array.isArray(row.embedding)) e = row.embedding;
        else if (typeof row.embedding === "string") { try { const p = JSON.parse(row.embedding); if (Array.isArray(p)) e = p; } catch {} }
        else if (row.embedding instanceof Buffer) { try { const p = JSON.parse(row.embedding.toString()); if (Array.isArray(p)) e = p; } catch {} }
        if (!e || e.length === 0) return null;
        const eNorm = Math.sqrt(e.reduce((s: number, v: number) => s + v * v, 0));
        const dot = qVec.reduce((s: number, v: number, i: number) => s + v * (e[i] || 0), 0);
        const sim = qNorm > 0 && eNorm > 0 ? dot / (qNorm * eNorm) : 0;
        return { skillName: row.skill_name, similarity: sim };
      })
      .filter((x): x is { skillName: string; similarity: number } => x !== null)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topN);
    const candidates = scored.filter((x) => x.similarity >= minSimilarity);
    return { found: candidates.length > 0, candidates };
  } catch (e: any) {
    console.warn("[skills] searchSkill FAIL:", e?.message?.substring(0, 80));
    return { found: false, candidates: [] };
  }
}

// ═══════════ V332: 技能描述实时审计（P1-2 前端实时同步）═══════════
// 复用 parseFrontmatter（正确处理 >- 折叠块 desc），实时扫描技能目录
// 后端缓存 60 秒（技能很少变, 避免每次请求全量扫描）
let auditCache: { at: number; result: { total: number; complete: number; gaps: Array<{ gap: string; count: number }> } } | null = null;

function auditSingleSkill(mdPath: string): { complete: boolean; missing: string[] } {
  try {
    const content = fs.readFileSync(mdPath, "utf-8");
    const fm = extractFrontmatter(content);
    const desc = fm.description || "";
    const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*/, "");
    const missing: string[] = [];
    // 触发: triggers 字段 / desc / 正文
    const hasTrigger = (fm.triggers && fm.triggers.length > 0) || /(?:use when|当|适用|触发|用于|场景|时机)/i.test(desc + body.substring(0, 800));
    if (!hasTrigger) missing.push("触发时机");
    // 边界: notTriggers 字段 / desc / 正文
    const hasBoundary = (fm.notTriggers && fm.notTriggers.length > 0) || /(?:don'?t use|never|不要|不适用|避免|切勿|not for)/i.test(desc + body.substring(0, 800));
    if (!hasBoundary) missing.push("边界反例");
    if (!/(?:示例|例如|e\.g\.|比如|如：|例如：|参数值)/i.test(desc + body.substring(0, 1500))) missing.push("具体示例");
    if (!/(?:耗时|分钟|秒|token|费用|成本|\$\d|分钟级|秒级)/i.test(desc + body.substring(0, 1500))) missing.push("执行代价");
    return { complete: missing.length === 0, missing };
  } catch {
    return { complete: false, missing: ["无法读取"] };
  }
}

/** 实时审计全部技能（60 秒缓存） */
export async function auditSkillsLive(): Promise<{ total: number; complete: number; gaps: Array<{ gap: string; count: number }> }> {
  const now = Date.now();
  if (auditCache && now - auditCache.at < 60_000) return auditCache.result;
  const skillsDir = path.join(os.homedir(), ".claude", "skills");
  const skills = collectSkillMds(skillsDir);
  let complete = 0;
  const gapCount: Record<string, number> = {};
  for (const s of skills) {
    const r = auditSingleSkill(s.skillMdPath);
    if (r.complete) complete++;
    for (const g of r.missing) gapCount[g] = (gapCount[g] || 0) + 1;
  }
  const result = {
    total: skills.length,
    complete,
    gaps: Object.entries(gapCount).map(([gap, count]) => ({ gap, count })).sort((a, b) => b.count - a.count),
  };
  auditCache = { at: now, result };
  return result;
}
