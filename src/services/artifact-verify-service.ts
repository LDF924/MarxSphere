// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// artifact-verify-service.ts — 产出物的**确定性**质检闭环(2026-10-01)
//
// ═══ 为什么要有这个服务 ═══
//
// 在此之前, 平台对技能的使用只到"把 SKILL.md 读成文本", 技能自带的脚本一个都没跑过。
// 而 `nature-paper2ppt/scripts/audit_pptx_quality.py` 查的恰恰是技能自己在
// `output-and-quality.md` 里定的交付标准(文字是否溢出画布、元素是否差几 pt 没对齐)。
//
// 2026-10-01 实测把这个代价量化了: 把平台生成的 pptx 丢给那个脚本一跑 ——
//   `Findings: high=20` —— **几乎每一页都有文字溢出画布**。
// 标准写在文档里、产物没人验, 于是"符合技能标准"这件事**从未被真正检验过**。
//
// 把约束写进生成提示能显著改善(实测 high 20→0、low 32→7), 但那靠的是**模型自觉**:
// 它可能这次照做、下次忘掉, 而且没有任何东西在交付前把关。
// 这个服务补的就是那一环 —— **在 execute 步骤完成后, 自动跑技能自带的质检脚本**,
// 把结果变成 reflect 能看到的失败项。
//
// ═══ 边界(三条刻意的选择) ═══
//
// ① **只当信号, 不改产物**。质检发现缺陷时这里**不会**去"自动修一遍" ——
//    修需要重新生成, 那是 agent 的活; 本服务只负责给出**可信的判据**,
//    由 reflect 决定要不要再来一轮。自动修补会引入第二套生成逻辑, 与本仓
//    在 p2o 领域引擎上踩过的"代码替模型做判断"是同一个坑。
//
// ② **脚本不可用时如实说"没验", 不假装通过**。技能没装、没有质检脚本、
//    扩展名对不上、python 没装 —— 这些情况一律返回 `ran:false` 并说明原因。
//    返回一个假的 `ok:true` 比不验更糟: 它让"已验证"这四个字贬值。
//
// ③ **不跑技能里"构建类"的脚本**。只跑 `verifier` 名单(见 skills-service 的
//    skillVerifierScripts); 构建脚本(`build_deck.mjs` 之类)会重新生成产物,
//    那是 execute 步骤的职责, 在这里跑等于绕过一次人工审批。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./storage-paths.js";
import { skillVerifierScripts } from "./skills-service.js";

export interface VerifyFinding {
  severity: string;
  slide?: number;
  code: string;
  message: string;
}

export interface ArtifactVerifyResult {
  /** 质检**真的跑了吗**。false 时 ok 无意义, 看 note 说明原因 */
  ran: boolean;
  ok: boolean;
  script?: string;
  artifact?: string;
  high: number;
  medium: number;
  low: number;
  /** 截断后的缺陷清单(reflect 只需要知道"哪里不行") */
  findings: VerifyFinding[];
  /** 一句话结论, 直接进步骤的 detail */
  summary: string;
  /** 没跑成时的原因 */
  note?: string;
}

/** agent 的产出目录（与沙箱 workspace-write 的 cwd 是同一处, 见 code-sandbox-service） */
export function artifactWorkspaceDir(): string {
  return dataPath("agent_workspace");
}

/** 认识的产物类型 → 用来匹配质检脚本 */
const KNOWN_EXT = ["pptx", "docx", "xlsx", "pdf", "csv", "json", "html", "md"];

/**
 * 从执行输出里解析出**产物文件名**。
 *
 * 生成提示要求模型"打印其路径", 实测各次措辞不一:
 *   "saved nature_paper2ppt.pptx" / "演示文稿已保存至: x.pptx" / "保存: x.pptx"
 * 所以按**扩展名**扫, 不依赖动词。
 */
export function parseArtifactName(output: string): string | null {
  const m = output.match(new RegExp(`([\\w\\u4e00-\\u9fa5.\\-（）()]+)\\.(${KNOWN_EXT.join("|")})\\b`, "i"));
  if (!m) return null;
  // 只取文件名部分 —— 模型可能写出带目录的路径, 而工作目录就是产物目录
  return path.basename(String(m[0]).trim());
}

/** 在产出目录里找 `since` 之后新增/修改、且扩展名匹配的产物(按修改时间倒序) */
export function findRecentArtifacts(since: number, exts: string[] = KNOWN_EXT): string[] {
  const dir = artifactWorkspaceDir();
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ p: string; m: number }> = [];
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(".")) continue;
    const ext = path.extname(f).slice(1).toLowerCase();
    if (!exts.includes(ext)) continue;
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.mtimeMs >= since) out.push({ p, m: st.mtimeMs });
    } catch { /* 单个文件读不到不影响整体 */ }
  }
  return out.sort((a, b) => b.m - a.m).map((x) => x.p);
}

/**
 * 这个质检脚本认不认这种产物。
 *
 * ⚠ 2026-10-01 踩到: 第一版只读脚本正文前 4000 字找 `.pptx` 字样 —— 大小写敏感,
 *   而 `audit_pptx_quality.py` 正文里写的是大写 `PPTX`(文件名里才是小写),
 *   于是**最该认的那种产物被判成"不认"**, 整条质检链直接短路。
 *   这就是本仓反复记的"判据看不到被测对象"。
 *
 * 现在三个来源都看, 任一命中即可 —— 顺序是按可靠度排的:
 *   ① **文件名**里带扩展名(最直接: `audit_pptx_quality` → pptx);
 *   ② 正文里出现该后缀(两种大小写都试);
 *   ③ 该技能名或脚本名里带产物类型词。
 */
function scriptSupportsExt(scriptPath: string, ext: string): boolean {
  try {
    const base = path.basename(scriptPath).toLowerCase();
    if (base.includes(ext)) return true;                       // ① 文件名
    const head = fs.readFileSync(scriptPath, "utf8").slice(0, 8000);
    const low = head.toLowerCase();
    if (low.includes(`.${ext}`) || new RegExp(`\\b${ext}\\b`).test(low)) return true;  // ② 正文(小写化后)
    return false;
  } catch { return false; }
}

function runProcess(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: `无法启动 ${cmd}: ${String((e as Error).message)}` });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const done = (code: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") + extra });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } done(null, `\n（质检超时 ${Math.round(timeoutMs / 1000)}s）`); }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => done(null, `\n${String(e.message)}`));
    child.on("close", (code) => done(code));
  });
}

/** python 解释器 —— 与 docx-build-service 同一套探测 */
async function resolvePython(): Promise<string> {
  if (process.env.SAG_SANDBOX_PYTHON) return process.env.SAG_SANDBOX_PYTHON;
  return process.platform === "win32" ? "python" : "python3";
}

/** 从质检脚本的输出里解析计数行与缺陷表 */
function parseReport(stdout: string): { high: number; medium: number; low: number; findings: VerifyFinding[] } {
  const counts = { high: 0, medium: 0, low: 0 };
  const cm = stdout.match(/high=(\d+),\s*medium=(\d+),\s*low=(\d+)/i);
  if (cm) {
    counts.high = Number(cm[1]); counts.medium = Number(cm[2]); counts.low = Number(cm[3]);
  }
  const findings: VerifyFinding[] = [];
  // markdown 表格行: | high | 2 | `shape_out_of_bounds` | text shape extends ... |
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(high|medium|low)\s*\|\s*(\d+)?\s*\|\s*`?([a-z_]+)`?\s*\|\s*(.+?)\s*\|?\s*$/i);
    if (m) {
      findings.push({
        severity: m[1].toLowerCase(),
        slide: m[2] ? Number(m[2]) : undefined,
        code: m[3],
        message: m[4].replace(/\|$/, "").trim().slice(0, 160),
      });
    }
  }
  // 没解析到计数行但解析到了明细 → 用明细反推(脚本格式变了也不至于瞎报 0)
  if (!cm && findings.length) {
    for (const f of findings) {
      if (f.severity === "high") counts.high++;
      else if (f.severity === "medium") counts.medium++;
      else counts.low++;
    }
  }
  return { ...counts, findings };
}

/**
 * 对刚产出的文件跑一次技能自带的质检。
 *
 * @param skillName 技能 id(可选)。没有它就没有质检脚本可用。
 * @param output    execute 步骤的工具输出 —— 用来解析产物文件名
 * @param since     执行开始的时间戳, 用于只认**这次**新产生的文件
 */
export async function verifyProducedArtifact(input: {
  skillName?: string;
  output: string;
  since: number;
}): Promise<ArtifactVerifyResult> {
  const empty = (note: string): ArtifactVerifyResult => ({
    ran: false, ok: true, high: 0, medium: 0, low: 0, findings: [], summary: "", note,
  });

  if (!input.skillName) return empty("未识别到技能, 跳过质检");
  const verifiers = skillVerifierScripts(input.skillName);
  if (!verifiers.length) return empty(`技能「${input.skillName}」没有自带的质检脚本`);

  // 定位产物: 先信输出里报的名字, 找不到再扫目录
  const named = parseArtifactName(input.output);
  const dir = artifactWorkspaceDir();
  let artifact = named ? path.join(dir, named) : "";
  if (!artifact || !fs.existsSync(artifact)) {
    const recent = findRecentArtifacts(input.since);
    artifact = recent[0] ?? "";
  }
  if (!artifact || !fs.existsSync(artifact)) return empty("本次执行没有在产出目录里找到新文件");

  const ext = path.extname(artifact).slice(1).toLowerCase();
  const script = verifiers.find((v) => scriptSupportsExt(v, ext));
  if (!script) return empty(`技能的质检脚本都不认 .${ext} 产物(${verifiers.map((v) => path.basename(v)).join(", ")})`);

  const isJs = /\.(mjs|js|cjs|ts)$/.test(script);
  const cmd = isJs ? (process.env.SAG_NODE_BIN || process.execPath) : await resolvePython();
  const args = isJs ? [script, artifact] : [script, artifact];
  const r = await runProcess(cmd, args, 60_000);

  const text = `${r.stdout}\n${r.stderr}`;
  // 脚本起不来(python 缺失/依赖缺失)与"跑起来但报了缺陷"必须分开 ——
  //   前者是**没验**, 后者才是**验出问题**。
  if (!/Findings:|findings|high=/i.test(text) && r.code !== 0 && r.code !== 1) {
    return empty(`质检脚本没能正常运行(${path.basename(script)}): ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  }

  const parsed = parseReport(text);
  const ok = parsed.high === 0;
  const parts = [`high=${parsed.high}`, `medium=${parsed.medium}`, `low=${parsed.low}`];
  const summary = ok
    ? `质检通过（${parts.join(" / ")}）`
    : `质检发现 ${parsed.high} 项高级缺陷（${parts.join(" / ")}）`;

  return {
    ran: true,
    ok,
    script: path.basename(script),
    artifact: path.basename(artifact),
    ...parsed,
    // 只带 high/medium 进上下文 —— low 动辄几十条, 会淹没真正要改的东西
    findings: parsed.findings.filter((f) => f.severity !== "low").slice(0, 10),
    summary,
  };
}
