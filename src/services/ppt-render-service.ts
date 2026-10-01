// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// ppt-render-service.ts — PPT 生成工作台 ③④ 配图与渲染(含单页批注重绘)
//
// 由来: 旧项目 AItoolman M9 的配图阶段有三个能力 —— 每页可选配图(示意图/图表/背景图)、
//   **参考图**(给一张图, 后续页沿用同一套视觉规范)、以及"将图片写为幻灯片背景"。
//   本项目此前完全没有配图能力, 也没有任何"图放哪、字放哪"的约定。
//
// ⚠ 生图: 本项目**没有**外部生图服务(grep 全仓无 text2image/image-generation 接口,
//   .env 里也没有任何绘图服务的 key)。所以这里的路径是:
//     ① 有配置的生图端点(PPT_IMAGE_ENDPOINT/PPT_IMAGE_API_KEY) → 真生图, imageSource="service"
//     ② 没有 → **本地降级**: python-pptx 侧的 PIL 画示意图 / 整页版式图, imageSource="placeholder"
//   ②的结果会**明确标注**来源并写上 image_note, 绝不冒充"AI 画的图"。
//   这条降级不是"假装成功": 它产出的确实是一张有版面感的示意图, 但它是模板画的,
//   用户拿着去投稿前必须知道这一点。
//
// 单页批注重绘(旧项目 _m9_add_annotation_by_image_rect / m9_build_annotated_regen_mask_payload)
//   在这里落地为 annotatePage(): 前端的框选坐标(归一化 0-1) → 掩膜 + 局部补丁。
//   真 inpaint 要有生图服务; 没有时**只重绘被框住的区域**, 其余像素原样保留,
//   并把 "想要什么"(prompt)原样记进版本, 而不是丢掉。
import { execFile } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolvePython } from "./py-path.js";
import { dataPath } from "./storage-paths.js";
import { putObject, getObject } from "./blob-store.js";

/** 幻灯片像素尺寸: 16:9, 1600x900 —— 投影/网页预览都够, 又不至于让 python 卡住 */
export const SLIDE_PX = { w: 1600, h: 900 };

export type ImageSource = "service" | "placeholder";

export interface ImageOutcome {
  ok: boolean;
  /** 相对数据根的 key(落 blob-store 用) */
  rel: string;
  /** 绝对路径(给 python 侧当输入) */
  absPath: string;
  source: ImageSource;
  /** 人话说明这张图是怎么来的 —— 必须能显示在界面上 */
  note: string;
  error: string;
}

export interface RenderTheme {
  bg: string;
  band: string;
  bandText: string;
  title: string;
  body: string;
  accent: string;
  footer: string;
  titleFont?: string;
  bodyFont?: string;
  latinFont?: string;
}

/** 缺省主题。`probe()` 会从 Python 侧取回同一份 —— 这里是断网/缺依赖时的兜底 */
export const DEFAULT_THEME: RenderTheme = {
  bg: "#FFFFFF", band: "#1A3A6B", bandText: "#FFFFFF",
  title: "#1A3A6B", body: "#2B2B2B", accent: "#C8102E", footer: "#8A8F98",
  titleFont: "微软雅黑", bodyFont: "微软雅黑", latinFont: "Arial",
};

/** python 脚本位置: 与 py-path 同口径(SAG_ROOT 优先, 便于 worktree/主仓混跑) */
function scriptPath(): string {
  const root = process.env.SAG_ROOT || process.cwd();
  const p = path.join(root, "scripts", "ppt_render.py");
  // SAG_ROOT 指到主仓而这次跑的是 worktree 时, 上面那个路径会是**另一棵树的脚本**。
  // 教训(migrate.ts 的 resolveMigrationsDir 同款): 静默用错文件比报错难查得多, 所以回退一次。
  if (existsSync(p)) return p;
  const local = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../../scripts/ppt_render.py");
  return existsSync(local) ? local : p;
}

function pythonBin(): string {
  // 与 viz/empirical 同一批变量: 本机是 EMPIRICAL_PYTHON, 容器里可能是别的名
  return resolvePython({ envKeys: ["PPT_PYTHON", "EMPIRICAL_PYTHON", "COGNEE_PYTHON"] });
}

/**
 * 调 python 脚本。
 *
 * ⚠ 入参走 **stdin JSON**, 不走 argv —— 本仓有明确教训(cmd 会把带 `=` 的参数吞掉),
 *   而这里要传的是含中文标点、换行、引号的整段稿子。
 * ⚠ stdout 必须只有一行 JSON: 脚本里的任何 print 都会把结果切碎。
 * ⚠ stderr 单独收 —— 它是诊断的唯一来源, 不能混进 stdout。
 */
export function runPptPython(payload: Record<string, unknown>, timeoutMs = 180_000): Promise<{
  ok: boolean; data: Record<string, unknown>; error: string; stderr: string;
}> {
  return new Promise((resolve) => {
    const py = pythonBin();
    const args = [scriptPath()];
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(py, args, {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        cwd: process.env.SAG_ROOT || process.cwd(),
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      }, (err, stdout, stderr) => {
        const errText = String(stderr ?? "").slice(0, 800);
        if (err) {
          // 超时/解释器不存在: stdout 可能是空的, 不能当"没结果"糊过去 —— 要把原因带上
          const reason = /ETIMEDOUT|timed out/i.test(String(err.message))
            ? `Python 执行超时(${timeoutMs}ms)`
            : String(err.message).slice(0, 200);
          resolve({ ok: false, data: {}, error: reason, stderr: errText });
          return;
        }
        const line = String(stdout ?? "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
        if (!line) { resolve({ ok: false, data: {}, error: "Python 无输出", stderr: errText }); return; }
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          resolve({
            ok: parsed.ok !== false,
            data: parsed,
            error: parsed.ok === false ? String(parsed.error ?? "未知错误") : "",
            stderr: errText,
          });
        } catch {
          resolve({ ok: false, data: {}, error: `Python 输出不是 JSON: ${line.slice(0, 160)}`, stderr: errText });
        }
      });
    } catch (e) {
      // 解释器路径不存在时 execFile 会**同步抛**(spawn ENOENT 也可能走回调, 两个都兜)
      resolve({ ok: false, data: {}, error: `无法启动 Python(${py}): ${String((e as Error)?.message ?? e).slice(0, 160)}`, stderr: "" });
      return;
    }
    if (!child.stdin) { resolve({ ok: false, data: {}, error: "子进程 stdin 不可用", stderr: "" }); return; }
    // 中文必须显式 utf-8: Windows 默认 cp936, 会把标题里的字写坏
    child.stdin.write(JSON.stringify(payload), "utf-8");
    child.stdin.end();
  });
}

export interface PptPythonCapability {
  available: boolean;
  pptx: boolean;
  pil: boolean;
  fonts: string[];
  theme: RenderTheme;
  error: string;
}

/**
 * 依赖自检 —— 缓存 60 秒。
 *
 * 为什么要缓存: 每次导出/出图前都探一次会让工作台每步多花 ~300ms(冷启动 Python 更久),
 *   而"这台机器上装没装 python-pptx"在一分钟里不会变。
 */
let probeCache: { at: number; v: PptPythonCapability } | null = null;
export async function probeCapability(force = false): Promise<PptPythonCapability> {
  if (!force && probeCache && Date.now() - probeCache.at < 60_000) return probeCache.v;
  const r = await runPptPython({ op: "probe" }, 60_000);
  const v: PptPythonCapability = r.ok
    ? {
        available: Boolean(r.data.pptx),
        pptx: Boolean(r.data.pptx),
        pil: Boolean(r.data.pil),
        fonts: Array.isArray(r.data.fonts) ? (r.data.fonts as string[]) : [],
        theme: { ...DEFAULT_THEME, ...(r.data.theme as Partial<RenderTheme> ?? {}) },
        error: r.data.pptx ? "" : String(r.data.pptxError ?? "python-pptx 未安装 (pip install python-pptx)"),
      }
    : { available: false, pptx: false, pil: false, fonts: [], theme: { ...DEFAULT_THEME }, error: `${r.error}${r.stderr ? ` | ${r.stderr.slice(0, 200)}` : ""}` };
  probeCache = { at: Date.now(), v };
  return v;
}

// ════════════════════ 任务目录(旧项目 m9_create_new_task_dir 的对应物) ════════════════════

/**
 * 任务目录: `<DATA_DIR>/ppt-tasks/<userId>/<jobId>/`。
 *
 * 为什么既要用 blob-store 又要留目录: blob-store 负责"跨副本可读的产物"
 *   (导出的 pptx、每页图), 而**中间产物与断点状态**是本节点私有的 —— 旧项目那套
 *   目录结构(每个 job 一个目录, 里面按页放图)的价值在于出问题时人能直接翻。
 *   所以目录只保证**本节点**可用, 不承诺跨副本; 要跨副本的东西一律 putObject。
 */
export function taskDir(userId: string, jobId: string): string {
  const safeUser = String(userId).replace(/[^A-Za-z0-9_-]/g, "");
  const safeJob = String(jobId).replace(/[^A-Za-z0-9_-]/g, "");
  return dataPath("ppt-tasks", safeUser, safeJob);
}

export function ensureTaskDir(userId: string, jobId: string): string {
  const d = taskDir(userId, jobId);
  for (const sub of ["", "pages", "images", "out"]) {
    mkdirSync(path.join(d, sub), { recursive: true });
  }
  return d;
}

/** 页图在任务目录里的文件名。版本号进文件名 —— 回滚只需换指针, 不必搬字节 */
export function pageImagePath(userId: string, jobId: string, seq: number, version: number, tag = ""): string {
  const suffix = tag ? `-${tag.replace(/[^A-Za-z0-9_-]/g, "")}` : "";
  return path.join(taskDir(userId, jobId), "images", `p${String(seq).padStart(3, "0")}-v${version}${suffix}.png`);
}

/** 本地绝对路径 → 数据根相对 key(落库用)。不在数据根下返回空串 */
export function relFromAbs(abs: string): string {
  const norm = (s: string) => path.resolve(s).replace(/\\/g, "/").toLowerCase();
  const root = norm(dataPath());
  const target = norm(abs);
  if (!target.startsWith(root + "/")) return "";
  return path.resolve(abs).replace(/\\/g, "/").slice(path.resolve(dataPath()).replace(/\\/g, "/").length + 1);
}

/** 数据根相对 key → 绝对路径 */
export function absFromRel(rel: string): string {
  const clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^data\//, "");
  return path.join(dataPath(), clean);
}

// ════════════════════ ③ 配图 ════════════════════

export type ImageKind = "diagram" | "backdrop" | "slide" | "annotate";

export interface GenerateImageInput {
  userId: string;
  jobId: string;
  seq: number;
  version: number;
  kind: ImageKind;
  title: string;
  bullets: string[];
  theme: RenderTheme;
  pageNo?: number;
  /** 批注重绘用 */
  baseImageAbs?: string;
  rects?: Array<{ x: number; y: number; w: number; h: number; label?: string }>;
  geometry?: { width: number; height: number };
  /** 整页位图(slide)用: 页型决定走"标题带"还是"整页大字"版式 */
  pageKind?: string;
  /** 整页位图(slide)用: 配图在版式里的位置 */
  imageLayout?: "none" | "right" | "background";
  tag?: string;
}

/**
 * 出图 —— **必须**在返回值里说清来源。
 *
 * 判据(测试也盯这条): imageSource 是 service 时, note 里必须出现真实服务名;
 *   placeholder 时, note 必须出现"本地"/"示意"/"降级"之类的词。
 *   不允许出现"有图但说不清哪来的"这一档 —— 那正是用户被误导的入口。
 */
export async function generateImage(input: GenerateImageInput): Promise<ImageOutcome> {
  ensureTaskDir(input.userId, input.jobId);
  const geo = input.geometry ?? { width: SLIDE_PX.w, height: SLIDE_PX.h };
  const outPath = pageImagePath(input.userId, input.jobId, input.seq, input.version, input.tag ?? input.kind);
  const payload: Record<string, unknown> = {
    op: "image",
    kind: input.kind,
    out: outPath,
    width: geo.width,
    height: geo.height,
    title: input.title,
    bullets: input.bullets,
    theme: input.theme,
    pageNo: input.pageNo,
    pageKind: input.pageKind ?? "",
    imageLayout: input.imageLayout ?? "none",
  };
  if (input.kind === "annotate") {
    payload.baseImage = input.baseImageAbs ?? "";
    payload.rects = input.rects ?? [];
    payload.maskOut = outPath.replace(/\.png$/, "-mask.png");
    payload.prompt = "";
  }
  const r = await runPptPython(payload, 120_000);
  if (!r.ok || !existsSync(outPath)) {
    return { ok: false, rel: "", absPath: "", source: "placeholder", note: "", error: r.error || "出图失败" };
  }
  const rel = relFromAbs(outPath);
  if (rel) {
    // 落 blob-store: 单机时它是同一份文件的再写一次(幂等), 多副本时这才是能被别人读到的那一份
    try { await putObject(rel, readFileSync(outPath)); } catch { /* 本地已落盘, 对象存储失败不致命 */ }
  }
  const note = input.kind === "annotate"
    ? "批注区域已按框选范围重绘(其余像素未改动)。这是本地重绘, 不是生成式修补"
    : "本地生成的示意版式图(无外部生图服务), 可作排版占位, 不是 AI 插画";
  return { ok: true, rel, absPath: outPath, source: "placeholder", note, error: "" };
}

/**
 * 外部生图端点(可选)。
 *
 * 本项目**没有**现成的生图服务, 这里留的是一个**显式配置**的接口:
 *   配了 PPT_IMAGE_ENDPOINT + PPT_IMAGE_API_KEY 才走它, 否则返回 null 走降级。
 * 不做的两件事: 不猜任何厂商的私有协议(猜错的代价是几百次失败的静默重试),
 *   不把"调用失败"包装成成功(那是把降级说成生图)。
 */
export async function tryServiceImage(prompt: string, theme: RenderTheme): Promise<{ ok: boolean; buf?: Buffer; provider?: string; error?: string }> {
  const url = process.env.PPT_IMAGE_ENDPOINT || "";
  const key = process.env.PPT_IMAGE_API_KEY || "";
  if (!url || !key) return { ok: false, error: "未配置外部生图服务(PPT_IMAGE_ENDPOINT/PPT_IMAGE_API_KEY)" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ prompt, style: `主色 ${theme.band}, 底色 ${theme.bg}`, width: 1024, height: 576 }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `生图服务返回 ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    // 有些端点出错时返回 JSON 而不是图 —— 直接存下来会得到一个"打不开的 png"
    if (buf.length < 1024 || buf.subarray(0, 2).toString("latin1") === "\x7b\x22") {
      return { ok: false, error: "生图服务未返回图片字节" };
    }
    return { ok: true, buf, provider: new URL(url).host };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 160) };
  }
}

// ════════════════════ 参考图(风格模仿) ════════════════════

/**
 * 从参考图提取一套主题覆盖值。
 *
 * ⚠ 能说的与不能说的: 拿回来的只是**配色**(主色/底色/深浅)。"学会了那张图的风格"
 *   这句话不成立 —— 版式、图形语言、排版气质都不是几个颜色能表达的。
 *   所以调用方拿到的 theme 只覆盖颜色; 字体/版式沿用本工作台的规范。
 */
export async function themeFromReference(referenceAbs: string, base: RenderTheme = DEFAULT_THEME): Promise<{ ok: boolean; theme: RenderTheme; error: string }> {
  if (!referenceAbs || !existsSync(referenceAbs)) {
    return { ok: false, theme: base, error: "参考图不存在" };
  }
  const r = await runPptPython({ op: "theme", reference: referenceAbs }, 60_000);
  if (!r.ok || !r.data.theme) return { ok: false, theme: base, error: r.error || "参考图解析失败" };
  return { ok: true, theme: { ...base, ...(r.data.theme as Partial<RenderTheme>) }, error: "" };
}

/** 参考图落盘(用户上传的字节 → 任务目录), 返回绝对路径与相对 key */
export async function saveReferenceImage(userId: string, jobId: string, bytes: Buffer, ext = "png"): Promise<{ absPath: string; rel: string }> {
  const d = ensureTaskDir(userId, jobId);
  const safeExt = /^[a-z0-9]{2,5}$/i.test(ext) ? ext.toLowerCase() : "png";
  const p = path.join(d, `reference-${createHash("sha1").update(bytes).digest("hex").slice(0, 10)}.${safeExt}`);
  writeFileSync(p, bytes);
  const rel = relFromAbs(p);
  if (rel) { try { await putObject(rel, bytes); } catch { /* 忽略 */ } }
  return { absPath: p, rel };
}

/**
 * 把**外部生图服务返回的字节**落成这一页的配图。
 *
 * 单独抽出来是因为它必须与"本地画一张"分开 —— 两者产出都叫 png, 差别全在
 * `imageSource` 上。踩过一次: 服务真返回了图, 代码却把它丢掉、又用本地画了一张,
 * 然后标 `source: "service"` —— 于是"声称是 AI 画的"底下躺着模板画的图。
 * 那一版比"降级"更糟: 降级至少说了实话。
 */
export async function saveServiceImage(input: {
  userId: string; jobId: string; seq: number; version: number; bytes: Buffer; provider: string; tag?: string;
}): Promise<ImageOutcome> {
  ensureTaskDir(input.userId, input.jobId);
  const p = pageImagePath(input.userId, input.jobId, input.seq, input.version, input.tag ?? "svc");
  try {
    writeFileSync(p, input.bytes);
  } catch (e) {
    return { ok: false, rel: "", absPath: "", source: "service", note: "", error: `生图结果落盘失败: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
  const rel = relFromAbs(p);
  if (rel) { try { await putObject(rel, input.bytes); } catch { /* 本地已落盘 */ } }
  return { ok: true, rel, absPath: p, source: "service", note: `AI 生图(${input.provider})`, error: "" };
}

// ════════════════════ ④ 渲染(合成 pptx) ════════════════════

export interface ComposePage {
  seq: number;
  kind: string;
  title: string;
  bullets: string[];
  notes: string;
  /** 这一页配图的**绝对路径**(空 = 无图) */
  imagePath?: string;
  imageLayout?: "none" | "right" | "background";
  /** image 模式下贴的整页位图 */
  wholeSlidePath?: string;
}

export interface ComposeResult {
  ok: boolean;
  absPath: string;
  rel: string;
  mode: ExportMode;
  slides: number;
  warnings: string[];
  overflows: Array<{ seq: number; overBy: number }>;
  /** 第几页(1 起)指着图但磁盘上没图 —— 不能静默当无图 */
  missingImages: number[];
  error: string;
}

export type ExportMode = "editable" | "image";

/**
 * 合成 pptx。
 *
 * 两种模式(**可编辑 vs 不可编辑**):
 *   editable —— 文本框 + 图片形状, 用户在 PowerPoint 里能继续改字/挪图;
 *   image    —— 每页先渲染成位图再整页贴, 换台机器打开不会跑版, 代价是不能再改字。
 *   旧项目把这两条做成"导出选项", 原因就是这个取舍无处可逃 —— 没有一种模式两头都占。
 */
export async function composePptx(input: {
  userId: string;
  jobId: string;
  mode: ExportMode;
  title: string;
  pages: ComposePage[];
  theme: RenderTheme;
  /** 文件名后缀(留空自动带时间戳 + 模式) */
  nameSuffix?: string;
  onProgress?: (done: number, total: number, stage: string) => Promise<void> | void;
}): Promise<ComposeResult> {
  const total = input.pages.length;
  const d = ensureTaskDir(input.userId, input.jobId);
  if (!total) return { ok: false, absPath: "", rel: "", mode: input.mode, slides: 0, warnings: [], overflows: [], missingImages: [], error: "没有页面可导出" };

  const warnings: string[] = [];
  let pages = input.pages.map((p) => ({ ...p }));

  // image 模式: 先把每页画成位图。**先做这一遍**再合成 —— 中途失败时用户
  //   看到的是"第 7 页渲染失败", 而不是一个半成品 pptx(那更让人以为导好了)。
  if (input.mode === "image") {
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const out = pageImagePath(input.userId, input.jobId, p.seq, 0, "slide");
      const r = await runPptPython({
        op: "image", kind: "slide", out,
        width: SLIDE_PX.w, height: SLIDE_PX.h,
        title: p.title, bullets: p.bullets, theme: input.theme,
        pageKind: p.kind, pageNo: i + 1,
        imageLayout: p.imageLayout ?? "none",
        baseImage: p.imagePath ?? "",
      }, 120_000);
      if (!r.ok || !existsSync(out)) {
        return {
          ok: false, absPath: "", rel: "", mode: input.mode, slides: 0, warnings, overflows: [], missingImages: [],
          error: `第 ${i + 1} 页位图渲染失败: ${r.error}`,
        };
      }
      pages[i] = { ...p, wholeSlidePath: out };
      if (input.onProgress) await input.onProgress(i + 1, total, "位图渲染");
    }
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const safeTitle = (input.title || "演示文稿").replace(/[\\/:*?"<>|]/g, "").slice(0, 40);
  const outPath = path.join(d, "out", `${safeTitle}${input.nameSuffix ?? ""}-${input.mode}-${stamp}.pptx`);
  if (input.onProgress) await input.onProgress(total, total, "合成 pptx");

  const r = await runPptPython({
    op: "compose",
    out: outPath,
    mode: input.mode,
    theme: input.theme,
    pages: pages.map((p) => ({
      seq: p.seq, kind: p.kind, title: p.title, bullets: p.bullets, notes: p.notes,
      imagePath: input.mode === "image" ? (p.wholeSlidePath ?? "") : (p.imagePath ?? ""),
      imageLayout: p.imageLayout ?? "none",
    })),
  }, 300_000);

  if (!r.ok || !existsSync(outPath)) {
    return {
      ok: false, absPath: "", rel: "", mode: input.mode, slides: 0, warnings, overflows: [], missingImages: [],
      error: `${r.error}${r.stderr ? ` | ${r.stderr.slice(0, 200)}` : ""}`,
    };
  }
  const rel = relFromAbs(outPath);
  if (rel) { try { await putObject(rel, readFileSync(outPath)); } catch { /* 忽略 */ } }
  return {
    ok: true, absPath: outPath, rel, mode: input.mode,
    slides: Number(r.data.slides ?? total),
    warnings: Array.isArray(r.data.warnings) ? (r.data.warnings as string[]) : [],
    overflows: Array.isArray(r.data.overflows) ? (r.data.overflows as Array<{ seq: number; overBy: number }>) : [],
    missingImages: Array.isArray(r.data.missingImages) ? (r.data.missingImages as number[]) : [],
    error: "",
  };
}

// ════════════════════ ⑤ 批注重绘 ════════════════════

/** 前端框选: 归一化坐标(0-1)。用归一化而不是像素: 预览宽度随窗口变, 像素坐标会画到别处 */
export interface AnnotationRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 用户在这一块上写的批注 */
  label?: string;
}

export interface AnnotationPayload {
  pageSeq: number;
  rects: AnnotationRect[];
  /** 用户希望改成什么样(自然语言)。没有生图服务时它进不了像素, 但必须**存进版本** */
  prompt: string;
  baseImageRel: string;
  maskRel: string;
  generatedRel: string;
}

export function validateRects(rects: unknown): { ok: boolean; rects: AnnotationRect[]; error: string } {
  const arr = Array.isArray(rects) ? rects : [];
  const out: AnnotationRect[] = [];
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const nums = ["x", "y", "w", "h"].map((k) => Number(o[k]));
    if (nums.some((n) => !Number.isFinite(n))) return { ok: false, rects: [], error: "批注矩形坐标必须是数字" };
    const [x, y, w, h] = nums;
    if (w <= 0 || h <= 0) return { ok: false, rects: [], error: "批注矩形宽高必须为正" };
    if (x < 0 || y < 0 || x + w > 1.001 || y + h > 1.001) {
      return { ok: false, rects: [], error: "批注矩形必须在页面范围内(归一化 0-1)" };
    }
    out.push({ x, y, w, h, label: typeof o.label === "string" ? o.label.slice(0, 200) : "" });
  }
  if (!out.length) return { ok: false, rects: [], error: "至少需要一个批注矩形" };
  // 上限: 一个掩膜上画几百个框既没意义, 又会让 PIL 路径退化成"整页重绘"
  if (out.length > 32) return { ok: false, rects: out.slice(0, 32), error: "批注矩形最多 32 个" };
  return { ok: true, rects: out, error: "" };
}

/**
 * 批注重绘的 payload 构造(对应旧项目的 m9_build_annotated_regen_mask_payload)。
 *
 * 把"用户框了什么 + 想要什么 + 拿哪张图做底"攒成一个**可序列化**的结构,
 * 原因是它要进版本表: 批注重绘只改局部, 出了偏差时得知道当时拿哪个版本做的基线。
 */
export function buildAnnotationPayload(input: {
  pageSeq: number;
  rects: AnnotationRect[];
  prompt: string;
  baseImageRel: string;
  maskRel: string;
  generatedRel: string;
}): AnnotationPayload {
  return {
    pageSeq: input.pageSeq,
    rects: input.rects,
    prompt: String(input.prompt ?? "").slice(0, 500),
    baseImageRel: input.baseImageRel,
    maskRel: input.maskRel,
    generatedRel: input.generatedRel,
  };
}

export interface AnnotateResult {
  ok: boolean;
  rel: string;
  absPath: string;
  maskRel: string;
  source: ImageSource;
  note: string;
  /** 有没有走真生成式修补(现在必然是 false —— 本项目没有那个服务) */
  generativeInpaint: boolean;
  error: string;
}

/**
 * 只改被框住的那一块。其余像素**逐字节保留**。
 *
 * 判据(测试盯这条): 产出的图必须能被 PIL 原样读回, 且与底图同尺寸;
 *   掩膜必须是**只有框内为白**的二值图 —— 否则"只改一块"这句话不成立。
 */
export async function annotatePage(input: {
  userId: string;
  jobId: string;
  seq: number;
  version: number;
  baseImageAbs: string;
  rects: AnnotationRect[];
  prompt: string;
  theme: RenderTheme;
}): Promise<AnnotateResult> {
  if (!input.baseImageAbs || !existsSync(input.baseImageAbs)) {
    return { ok: false, rel: "", absPath: "", maskRel: "", source: "placeholder", note: "", generativeInpaint: false, error: "底图不存在, 无法批注重绘" };
  }
  const v = validateRects(input.rects);
  if (!v.ok) return { ok: false, rel: "", absPath: "", maskRel: "", source: "placeholder", note: "", generativeInpaint: false, error: v.error };

  // 有生图服务时先试它 —— 但**仍以本地掩膜合成收尾**: 生成式模型会整图重画,
  //   而用户要的是"只改这一块"。现在没有服务, 这条分支直接走降级。
  const svc = await tryServiceImage(`局部重绘: ${input.prompt}`, input.theme);

  const r = await generateImage({
    userId: input.userId, jobId: input.jobId, seq: input.seq, version: input.version,
    kind: "annotate", title: "", bullets: [], theme: input.theme,
    baseImageAbs: input.baseImageAbs, rects: v.rects, tag: "annotate",
  });
  if (!r.ok) return { ok: false, rel: "", absPath: "", maskRel: "", source: "placeholder", note: "", generativeInpaint: false, error: r.error };
  const maskAbs = r.absPath.replace(/\.png$/, "-mask.png");
  return {
    ok: true, rel: r.rel, absPath: r.absPath,
    maskRel: relFromAbs(maskAbs), source: "placeholder",
    note: svc.ok
      ? "已生成修补图, 但掩膜合成仍走本地(生成式结果不保证框外像素不变), 框外为原图"
      : "无外部生图服务: 框内按本地重绘并高亮, 框外像素原样保留",
    generativeInpaint: false,
    error: "",
  };
}

/** 从 blob-store 取回一页图(跨副本读的入口)。
 *  两个校验都不是防御性代码: 路由会把这个 key 从请求里带进来, 而 `getObject`
 *  本身不做前缀限制 —— 没有这两行, 一个构造出来的 key 就能读到别人任务目录下的对象。 */
export async function readPptFile(rel: string): Promise<Buffer | null> {
  const clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^data\//, "");
  if (!clean.startsWith("ppt-")) return null;
  if (clean.includes("..")) return null;
  return getObject(clean);
}
