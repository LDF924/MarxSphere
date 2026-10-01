// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// docx-build-service.ts — Word 成品构建(2026-10-01)
//
// 从旧项目 AItoolman 移植的两项能力(其明文源码随包分发, 是本仓库唯一可直搬的部分):
//   ① LaTeX → Word 公式: 调 scripts/latex_to_docx.py, 生成的是**真 OMML**(<m:oMath>),
//      不是图片也不是纯文本 —— 可编辑、可重排、期刊排版系统能识别。
//   ② Word 封面页 + 目录(TOC): 调 scripts/add_cover_and_toc.py。
//
// 移植前的空白: 本仓库 `grep OMML/latex2mathml` = 0, 导出的 docx 里公式是纯文本;
//   封面与目录**完全没有**(paper-outline-service 的导出只有标题 + 正文 + 参考文献)。
//
// 依赖: python 侧需要 python-docx / latex2mathml / lxml。缺依赖时这里给**明确的**报错,
//   而不是让 python 抛 ModuleNotFoundError 让上层看到一堆栈(见 ensurePythonDeps)。
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { resolvePython } from "./py-path.js";

const execFileAsync = promisify(execFile);

const SCRIPT_LATEX = path.resolve(process.cwd(), "scripts", "latex_to_docx.py");
const SCRIPT_COVER = path.resolve(process.cwd(), "scripts", "add_cover_and_toc.py");

export interface DocxBuildResult {
  ok: boolean;
  error?: string;
  /** 生成文件的 base64(ok=true 时有) */
  base64?: string;
  /** 侧信道信息: 公式条数 / 用的哪个引擎 / 删了几个原标题 */
  meta?: Record<string, unknown>;
}

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `docx-${tag}-`));
}

/**
 * 跑一个 python 脚本, 入参走 **stdin 的 JSON**(不是命令行参数)。
 *
 * 为什么不走 argv: LaTeX 正文里有 `\`、引号、中文, 拼进命令行会在 Windows 上被
 *   cmd 的转义规则吃掉(本项目已有 [cmd-script-traps] 的前车之鉴), 走 stdin 免掉整类问题。
 *
 * ⚠ 必须用 spawn 而非 execFile: `execFile` 的**异步版没有 `input` 选项**
 *   (那是 `execFileSync`/`spawnSync` 才有的), 传了会被静默忽略 —— 脚本读到空 stdin,
 *   表现成"参数为空"的假失败, 而调用方看不出是传参方式错了。
 */
function runPy(script: string, payload: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(script)) {
      reject(new Error(`脚本不存在: ${script}`));
      return;
    }
    const child = spawn(resolvePython(), [script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 忽略 */ }
      reject(new Error(`python 脚本超时(${Math.round(timeoutMs / 1000)}s): ${path.basename(script)}`));
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 python: ${e.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const text = Buffer.concat(out).toString("utf8").trim();
      const errText = Buffer.concat(err).toString("utf8").trim();

      if (!text) {
        reject(new Error(
          `python 脚本没有输出(rc=${code}${errText ? `): ${errText.slice(-400)}` : ")"}`));
        return;
      }
      // 脚本只往 stdout 写一行 JSON; 若有多行, 取最后一行(容忍第三方库的杂音)
      const line = text.split(/\r?\n/).filter(Boolean).pop() as string;
      try {
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch {
        reject(new Error(`python 输出不是 JSON: ${line.slice(0, 200)}`));
      }
    });

    child.stdin.on("error", () => { /* 子进程提前退出时会 EPIPE, 由 close 统一处理 */ });
    child.stdin.end(JSON.stringify(payload), "utf8");
  });
}

/**
 * LaTeX 文本 → Word(.docx, 公式为 OMML)。
 *
 * 支持的定界符: 行间 `$$...$$` / 行内 `\(...\)`。
 */
export async function latexToDocx(input: {
  content: string;
  title?: string;
  fontName?: string;
  fontSize?: number;
}): Promise<DocxBuildResult> {
  if (!input.content?.trim()) return { ok: false, error: "content 为空" };

  const dir = tmpDir("latex");
  const out = path.join(dir, "out.docx");
  try {
    const res = await runPy(SCRIPT_LATEX, {
      content: input.content,
      output: out,
      title: input.title ?? "",
      fontName: input.fontName ?? "宋体",
      fontSize: input.fontSize ?? 12,
    }, 180_000);

    if (!res.ok) return { ok: false, error: String(res.error ?? "转换失败") };
    if (!fs.existsSync(out)) return { ok: false, error: "脚本报成功但产物不存在" };

    return {
      ok: true,
      base64: fs.readFileSync(out).toString("base64"),
      meta: { formulas: res.formulas, bytes: res.bytes },
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/**
 * 给已有 docx 加封面页 + 目录(TOC)。
 *
 * engine:
 *   · `python` —— 纯 python-docx, 跨平台, **不依赖 Office**; 目录是 TOC 域,
 *      已写入 `w:updateFields`, Word/WPS 打开时自动更新出页码。
 *   · `com`    —— 走 Word/WPS 的 COM, 拿到的就是**带页码的实体目录**; 仅 Windows 且装了 Office。
 *   · `auto`   —— 有 Office 用 com, 否则 python。
 */
export async function addCoverAndToc(input: {
  docxBase64: string;
  title?: string;
  position?: "high" | "center" | "low";
  engine?: "auto" | "python" | "com";
}): Promise<DocxBuildResult> {
  if (!input.docxBase64?.trim()) return { ok: false, error: "docxBase64 为空" };

  const dir = tmpDir("cover");
  const src = path.join(dir, "in.docx");
  const out = path.join(dir, "out.docx");
  try {
    fs.writeFileSync(src, Buffer.from(input.docxBase64, "base64"));

    const res = await runPy(SCRIPT_COVER, {
      docx: src,
      output: out,
      title: input.title ?? "",
      position: input.position ?? "center",
      engine: input.engine ?? "auto",
    }, 300_000);

    if (!res.ok) return { ok: false, error: String(res.error ?? "生成失败") };
    if (!fs.existsSync(out)) return { ok: false, error: "脚本报成功但产物不存在" };

    return {
      ok: true,
      base64: fs.readFileSync(out).toString("base64"),
      meta: { engine: res.engine, deletedParagraphs: res.deletedParagraphs, note: res.note },
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/**
 * 依赖自检 —— 让"缺 latex2mathml"这件事在**启动时**就暴露, 而不是用户点了导出才看到栈。
 *
 * 由来(2026-09-28 service-token 那次教训): MinerU token 过期 11 天没有任何地方记录,
 *   因为**过期这件事没有任何地方在检查**。同一个道理: 新增了一个 python 依赖,
 *   就得有地方能回答"它到底装没装"。
 */
export async function checkDocxBuildDeps(): Promise<{
  ok: boolean;
  python: string;
  missing: string[];
  error?: string;
}> {
  const py = resolvePython();
  const probe = "import importlib.util as u,json,sys;" +
    "mods=['docx','latex2mathml','lxml'];" +
    "print(json.dumps({'missing':[m for m in mods if u.find_spec(m) is None]}))";
  try {
    const { stdout } = await execFileAsync(py, ["-c", probe], {
      timeout: 30_000, windowsHide: true, encoding: "utf8",
    });
    const parsed = JSON.parse(String(stdout).trim()) as { missing?: string[] };
    const missing = parsed.missing ?? [];
    return { ok: missing.length === 0, python: py, missing };
  } catch (e: unknown) {
    return { ok: false, python: py, missing: ["docx", "latex2mathml", "lxml"],
      error: e instanceof Error ? e.message : String(e) };
  }
}
