// skills-update-service.ts — 技能自动更新检测
// 基线比对：本地改动 / 新技能 / GitHub 上游更新
// 基线存 data/skills-baseline.json（原子写 tmp+rename）
// 只读 SKILL.md + stat 目录，绝不递归遍历（marx-graphiti 803MB 会爆）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.env.SAG_ROOT || process.cwd(), "data");
const BASELINE_PATH = path.join(DATA_DIR, "skills-baseline.json");
const STATE_PATH = path.join(DATA_DIR, "skills-update-state.json");

// ─── 类型 ───

interface SkillBaselineEntry {
  name: string;
  skillMdHash: string;       // SKILL.md 内容 sha256 16 位截断
  skillMdMtimeMs: number;
  dirMtimeMs: number;
  category?: string;
  sourceUrl?: string;        // .source 标记里的 GitHub URL
  upstreamVersion?: string;  // 上次查到的上游版本
  checkedAt?: string;        // 上次上游检查时间
  addedAt: string;
}

interface BaselineFile {
  version: number;
  createdAt: string;
  skills: Record<string, SkillBaselineEntry>;
}

interface UpdateState {
  lastVersion: number;
}

export interface ModifiedSkill {
  name: string;
  kind: "content" | "files";
  since: string;
}

export interface NewSkill {
  name: string;
  category: string;
  detectedAt: string;
}

export interface UpstreamUpdate {
  name: string;
  url: string;
  localVersion: string;
  latestVersion: string;
}

export interface SkillUpdateResult {
  baselineVersion: number;
  newSkills: NewSkill[];
  modifiedSkills: ModifiedSkill[];
  upstreamUpdates: UpstreamUpdate[];
  baselineEstablished?: boolean;
  stats: { total: number; scannedMs: number };
}

// ─── 文件读写 ───

function loadBaseline(): BaselineFile {
  try {
    if (!fs.existsSync(BASELINE_PATH)) return { version: 1, createdAt: new Date().toISOString(), skills: {} };
    return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8")) as BaselineFile;
  } catch {
    return { version: 1, createdAt: new Date().toISOString(), skills: {} };
  }
}

function saveBaseline(baseline: BaselineFile): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${BASELINE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(baseline, null, 2), "utf-8");
  fs.renameSync(tmp, BASELINE_PATH);
}

function loadState(): UpdateState {
  try {
    if (!fs.existsSync(STATE_PATH)) return { lastVersion: 0 };
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as UpdateState;
  } catch {
    return { lastVersion: 0 };
  }
}

function saveState(state: UpdateState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, STATE_PATH);
}

// ─── 指纹与归类 ───

function hashOf(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** 只读 SKILL.md + stat 目录（不递归） */
function readSkillFingerprint(skillDir: string): { hash: string; skillMdMtimeMs: number; dirMtimeMs: number } | null {
  try {
    const skillMdPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) return null;
    const raw = fs.readFileSync(skillMdPath, "utf-8");
    const skillStat = fs.statSync(skillMdPath);
    const dirStat = fs.statSync(skillDir);
    return { hash: hashOf(raw), skillMdMtimeMs: skillStat.mtimeMs, dirMtimeMs: dirStat.mtimeMs };
  } catch {
    return null;
  }
}

/** 读 .source 标记（两行：GitHub URL + 版本） */
function readSourceMarker(skillDir: string): { url: string; version?: string } | null {
  try {
    const p = path.join(skillDir, ".source");
    if (!fs.existsSync(p)) return null;
    const lines = fs.readFileSync(p, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const url = lines[0].startsWith("#") ? lines[1] ?? "" : lines[0];
    if (!url.includes("github.com")) return null;
    const version = lines.find((l) => /^v?\d+\.\d+/.test(l));
    return { url, version };
  } catch {
    return null;
  }
}

/** 从 frontmatter 提取 category_zh / title_zh */
function readFrontmatter(skillMdPath: string): { categoryZh?: string; version?: string } {
  try {
    const raw = fs.readFileSync(skillMdPath, "utf-8");
    const start = raw.indexOf("---");
    if (start !== 0) return {};
    const end = raw.indexOf("---", start + 3);
    if (end === -1) return {};
    const block = raw.slice(start + 3, end);
    const cat = block.match(/^category_zh:\s*(.+)$/m);
    const ver = block.match(/^version:\s*(.+)$/m);
    // description 内嵌版本模式：V\d+ — YYYY-MM-DD
    const descLine = block.match(/^description:\s*(.+)$/m);
    let descVersion: string | undefined;
    if (descLine) {
      const m = descLine[1].match(/V(\d+)[\s—–-]+\d{4}-\d{2}-\d{2}/);
      if (m) descVersion = `V${m[1]}`;
    }
    return {
      categoryZh: cat ? cat[1].trim().replace(/^["']|["']$/g, "") : undefined,
      version: ver?.[1]?.trim() ?? descVersion
    };
  } catch {
    return {};
  }
}

/** 归类：SKILL.md category_zh → 中文说明 → 名称前缀映射 → 未分类 */
const PREFIX_CATEGORIES: Array<[RegExp, string]> = [
  [/^marx-/, "总入口"],
  [/^nature-/, "论文写作"],
  [/^(academic-|paper-|lit-|section-writing-|ml-paper-|tech-paper-|benchmark-paper-)/, "论文写作"],
  [/^(research-|idea-|experimental-design|scientific-critical|scientific-brainstorm)/, "研究方法"],
  [/^(citation-|ref-|bib-|nature-citation|nature-ref)/, "文献引用"],
  [/^(sciverse|cnki|ncpssd|database-lookup|bgpt-|exa-|lit-search|literature-review|deep-research)/, "文献检索"],
  [/^(obsidian-|pyzotero|pdf2obsidian|md-clean)/, "知识管理"],
  [/^(figure-|drawio-|scientific-visualization|plotting-|scientific-schematics|dataviz)/, "绘图"],
  [/^(web-access|pdf-web-download|ui-ux-pro-max)/, "工具"],
  [/^(\d{2}\.|0\d-)/, "实证分析"]
];

function inferCategory(skillDir: string, skillName: string): string {
  // 1. SKILL.md frontmatter category_zh
  const fm = readFrontmatter(path.join(skillDir, "SKILL.md"));
  if (fm.categoryZh && fm.categoryZh !== "未分类") return fm.categoryZh;
  // 2. 中文说明文件分类行
  try {
    const zhDocPath = path.join(os.homedir(), ".claude", "skills", "_中文说明", `${skillName}.zh-CN.md`);
    if (fs.existsSync(zhDocPath)) {
      const zhDoc = fs.readFileSync(zhDocPath, "utf-8");
      const catLine = zhDoc.split("\n").find((l) => l.includes("分类"));
      const m = catLine?.match(/[:：]\s*(.+)/);
      if (m && m[1].trim()) return m[1].trim().slice(0, 20);
    }
  } catch { /* 忽略 */ }
  // 3. 名称前缀映射
  for (const [re, cat] of PREFIX_CATEGORIES) {
    if (re.test(skillName)) return cat;
  }
  return "未分类";
}

// ─── 扫描 ───

/** 递归收集目录下的嵌套 SKILL.md 技能目录（合集包内 research 子目录中的 SKILL.md 等） */
function collectNestedSkillDirs(root: string): Array<{ name: string; dir: string }> {
  const out: Array<{ name: string; dir: string }> = [];
  const stack: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: "", depth: 0 }];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try { entries = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "_中文说明" || entry.name === "__pycache__" || entry.name === ".git" || entry.name === "node_modules") continue;
      const childDir = path.join(cur.dir, entry.name);
      const childRel = cur.rel ? `${cur.rel}/${entry.name}` : entry.name;
      if (fs.existsSync(path.join(childDir, "SKILL.md"))) {
        out.push({ name: childRel, dir: childDir });
      } else if (cur.depth < 2) {
        stack.push({ dir: childDir, rel: childRel, depth: cur.depth + 1 });
      }
    }
  }
  return out;
}

/** 单技能增量检查（顶层与嵌套共用）：新技能上报、变更检测、基线同步 */
function checkSkill(
  name: string,
  skillDir: string,
  fp: { hash: string; skillMdMtimeMs: number; dirMtimeMs: number },
  baseline: BaselineFile,
  result: SkillUpdateResult,
  firstScan: boolean
): void {
  const old = baseline.skills[name];
  if (!old) {
    if (firstScan) {
      baseline.skills[name] = {
        name,
        skillMdHash: fp.hash,
        skillMdMtimeMs: fp.skillMdMtimeMs,
        dirMtimeMs: fp.dirMtimeMs,
        category: inferCategory(skillDir, name),
        addedAt: new Date().toISOString()
      };
      return;
    }
    result.newSkills.push({
      name,
      category: inferCategory(skillDir, name),
      detectedAt: new Date().toISOString()
    });
    return;
  }
  if (fp.hash !== old.skillMdHash) {
    result.modifiedSkills.push({ name, kind: "content", since: new Date(old.skillMdMtimeMs).toISOString() });
    old.skillMdHash = fp.hash;
    old.skillMdMtimeMs = fp.skillMdMtimeMs;
  } else if (fp.dirMtimeMs !== old.dirMtimeMs) {
    result.modifiedSkills.push({ name, kind: "files", since: new Date(old.dirMtimeMs).toISOString() });
    old.dirMtimeMs = fp.dirMtimeMs;
  }
}

export function scanLocalChanges(): SkillUpdateResult {
  const startedAt = Date.now();
  const baseline = loadBaseline();
  const state = loadState();
  const skillsDir = path.join(os.homedir(), ".claude", "skills");
  const firstScan = Object.keys(baseline.skills).length === 0;

  const result: SkillUpdateResult = {
    baselineVersion: state.lastVersion,
    newSkills: [],
    modifiedSkills: [],
    upstreamUpdates: [],
    stats: { total: 0, scannedMs: 0 }
  };

  if (!fs.existsSync(skillsDir)) {
    result.stats.scannedMs = Date.now() - startedAt;
    return result;
  }

  const seen = new Set<string>();
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    // Windows junction 对 isDirectory() 返回 false，需用 isSymbolicLink() 兜底（嵌套技能链接到顶层）
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === "_中文说明" || entry.name === "__pycache__") continue;
    const skillDir = path.join(skillsDir, entry.name);
    const fp = readSkillFingerprint(skillDir);
    if (fp) {
      seen.add(entry.name);
      checkSkill(entry.name, skillDir, fp, baseline, result, firstScan);
      continue;
    }
    // 顶层无 SKILL.md：可能是合集包，扫描嵌套技能（name 用 "pkg/nested" 相对路径）
    for (const nested of collectNestedSkillDirs(skillDir)) {
      const nfp = readSkillFingerprint(nested.dir);
      if (!nfp) continue;
      const nName = `${entry.name}/${nested.name}`;
      // 嵌套技能仅供列表展示（第二遍 listSkills 注册），基线跟踪只认顶层运行时名：
      // junction 已把该技能链接到顶层（除非 research-ideation 冲突），顶层那份会进基线，
      // 嵌套路径名不上报（避免同一技能双份跟踪/双份"新技能"提示）
      if (nested.name !== "research-ideation") {
        seen.add(nName); // 仅标记 seen（防止误删基线），不 checkSkill
        continue;
      }
      seen.add(nName);
      checkSkill(nName, nested.dir, nfp, baseline, result, firstScan);
    }
  }

  // 删除的 skill：从基线移除（用户自己删的，不上报）
  for (const name of Object.keys(baseline.skills)) {
    if (!seen.has(name)) delete baseline.skills[name];
  }

  const newVersion = state.lastVersion + (result.newSkills.length + result.modifiedSkills.length > 0 ? 1 : 0);
  result.baselineVersion = newVersion;
  if (firstScan) {
    result.baselineEstablished = true;
    result.baselineVersion = 1; // 首次给 1（可被前端"知道了"记住），0 无法区分"未看过"
  }

  baseline.version = newVersion;
  saveBaseline(baseline);
  saveState({ lastVersion: result.baselineVersion });
  result.stats.total = seen.size;
  result.stats.scannedMs = Date.now() - startedAt;
  return result;
}

// ─── 上游检测 ───

/** 检查 GitHub 上游（有 .source 标记的技能，8h 节流） */
export async function checkUpstream(skillName?: string): Promise<SkillUpdateResult> {
  const result = scanLocalChanges();
  const baseline = loadBaseline();
  const skillsDir = path.join(os.homedir(), ".claude", "skills");

  const targets: Array<{ name: string; dir: string; marker: { url: string; version?: string } }> = [];
  const dirs = skillName
    ? [path.join(skillsDir, skillName)]
    : fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== "_中文说明" && d.name !== "__pycache__")
        .map((d) => path.join(skillsDir, d.name));

  for (const dir of dirs) {
    const name = path.basename(dir);
    const marker = readSourceMarker(dir);
    if (!marker) continue;
    const entry = baseline.skills[name];
    // 8h 节流
    if (entry?.checkedAt && Date.now() - new Date(entry.checkedAt).getTime() < 8 * 3600_000 && !skillName) continue;
    targets.push({ name, dir, marker });
  }

  for (const target of targets) {
    try {
      const m = target.marker.url.match(/github\.com\/([^/]+)\/([^/?#]+)/);
      if (!m) continue;
      const [, owner, repo] = m;
      const token = process.env.GITHUB_TOKEN?.trim() ?? "";
      const headers = {
        Accept: "application/vnd.github+json",
        "User-Agent": "MarxSphereResearch/1.0",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      };
      // releases/latest 优先，空则 tags
      let latest = "";
      let resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, { headers });
      if (resp.ok) {
        const data = await resp.json() as { tag_name?: string };
        latest = data.tag_name ?? "";
      }
      if (!latest) {
        resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/tags?per_page=1`, { headers });
        if (resp.ok) {
          const tags = await resp.json() as Array<{ name: string }>;
          latest = tags[0]?.name ?? "";
        }
      }
      if (!latest) continue;

      const fm = readFrontmatter(path.join(target.dir, "SKILL.md"));
      const localVersion = fm.version ?? target.marker.version ?? "";
      const entry = baseline.skills[target.name];
      if (entry) {
        entry.sourceUrl = target.marker.url;
        entry.upstreamVersion = latest;
        entry.checkedAt = new Date().toISOString();
      }
      // 版本不同才报更新
      if (!localVersion || !latest || localVersion !== latest) {
        result.upstreamUpdates.push({
          name: target.name,
          url: target.marker.url,
          localVersion: localVersion || "未知",
          latestVersion: latest
        });
      }
    } catch { /* 单技能失败不影响整体 */ }
  }

  saveBaseline(baseline);
  return result;
}

// ─── 确认 / 忽略 ───

/** 新技能确认添加：写基线 + 返回归类 */
export function confirmNewSkill(name: string): { ok: boolean; category: string; error?: string } {
  const skillsDir = path.join(os.homedir(), ".claude", "skills");
  const skillDir = path.join(skillsDir, name);
  const fp = readSkillFingerprint(skillDir);
  if (!fp) return { ok: false, category: "未分类", error: `技能不存在或无 SKILL.md: ${name}` };

  const baseline = loadBaseline();
  const category = inferCategory(skillDir, name);
  baseline.skills[name] = {
    name,
    skillMdHash: fp.hash,
    skillMdMtimeMs: fp.skillMdMtimeMs,
    dirMtimeMs: fp.dirMtimeMs,
    category,
    addedAt: new Date().toISOString()
  };
  saveBaseline(baseline);
  return { ok: true, category };
}

/** 本地改动"知道了"（前端行为，后端同步基线已就地更新，此接口保留语义占位） */
export function dismissModification(name: string): { ok: boolean } {
  return { ok: true };
}

export const skillsUpdateService = {
  scanLocalChanges,
  checkUpstream,
  confirmNewSkill,
  dismissModification,
  baselinePath: BASELINE_PATH
};
