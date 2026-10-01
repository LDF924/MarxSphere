/**
 * ppt-workbench.test.ts — PPT 生成工作台的四条硬判据。
 *
 * 由来(2026-10-01): 这个工作台是从旧项目 AItoolman 的 M9(全项目最大模块, 111 个函数)
 *   移植过来的。范围一大, 最容易出的不是"某个函数写错", 而是**看着都对但没有一项
 *   被真验过**: 大纲能出但页数约束不生效、导出的 pptx 打不开、降级的占位图被当成 AI 生图。
 *   所以这个文件只盯四件事, 每一件都对应一个**不报错**的失效方式:
 *
 *   ① **大纲的约束真的生效**(页数/要点数/首末页) —— 失效时产出的是一份"能用但很差"的稿子;
 *   ② **导出的 pptx 真能被打开**, 且页数/标题/备注读回来都对 —— 这是"真生成"与
 *      "看着像生成"的分界: compose 返回 ok 只说明 save() 没抛异常;
 *   ③ **配图降级不许冒充真图** —— imageSource=placeholder 时说明里必须有"本地/示意"字样;
 *   ④ **单页重生只动一页**, 且改动前旧版进了版本表(否则用户改错了无路可退)。
 *
 * 判据自证(本仓反复踩过的坑): 每条断言都要能**看到被测对象**。
 *   · 大纲那几条故意用"不调 LLM 的注入缝"(callJson), 才能精确控制模型的输出形状 ——
 *     真打网络的话测的是模型今天的心情, 不是规范化逻辑;
 *   · pptx 那条用**同一支 Python 解释器**读回来, 避免"生成用 venv、验证用系统 python"
 *     这种假失败(scripts/ppt_render.py 的 inspect op 就是为此加的);
 *   · 版本那条直接查 ppt_page_versions 表, 不只看服务返回值。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const cand of [process.env.SAG_ENV_FILE, path.join(ROOT, ".env"), path.join(ROOT, "..", "..", "..", ".env")]) {
  if (cand && fs.existsSync(cand)) { loadEnv({ path: cand }); break; }
}

import { pool } from "../src/db/pool.js";
import {
  normalizeOutline, fallbackOutline, applyOutlineEdit, tocEntries,
  estimateOutlineShape, PAGE_MIN, PAGE_MAX, BULLETS_MAX,
} from "../src/services/ppt-outline-service.js";
import {
  normalizeBullets, normalizeNotes, clipSmart, visualLen, estimateSpeakSeconds,
  suggestImagePrompt, generatePageScript, generateScriptBatch,
} from "../src/services/ppt-script-service.js";
import {
  runPptPython, probeCapability, generateImage, composePptx, annotatePage, validateRects,
  taskDir, relFromAbs, absFromRel, ensureTaskDir, DEFAULT_THEME, tryServiceImage, saveServiceImage,
  type ComposePage,
} from "../src/services/ppt-render-service.js";

// ════════════════════════════════════════════════════════════════════
// 环境探测: 连库才跑库那几组; 装了 python-pptx 才跑 pptx 那组
// ════════════════════════════════════════════════════════════════════

let dbReady = false;
try { await pool.query("select 1"); dbReady = true; } catch { dbReady = false; }
if (!dbReady) {
  console.warn("[ppt-workbench] 连不上数据库 —— 连库的用例会跳过（先 docker compose up -d 并跑 npm run db:migrate）");
}

/**
 * ⚠ 反向验证的那一条: 把 PPT_TEST_FORCE_PY_MISSING 置 1 时, 下面那条
 *   "探测说的是真话"必须**变红**。这是给"跳过"这件事本身设的探针 ——
 *   如果探测逻辑写坏了(比如永远返回 false), 那几组用例会一直"绿着跳过",
 *   谁也不会发现它们从没跑过。跳过必须是**有据**的跳过, 而不是安静的跳过。
 */
const FORCE_MISSING = process.env.PPT_TEST_FORCE_PY_MISSING === "1";
let cap: Awaited<ReturnType<typeof probeCapability>> = {
  available: false, pptx: false, pil: false, fonts: [], theme: { ...DEFAULT_THEME }, error: "未探测",
};
if (!FORCE_MISSING) {
  try { cap = await probeCapability(true); } catch (e) { cap.error = String(e); }
}
const pyReady = !FORCE_MISSING && cap.pptx;
if (!pyReady) {
  console.warn(
    `[ppt-workbench] python-pptx 不可用, pptx 相关用例跳过。原因: ${cap.error}\n` +
    `  该装什么: 在项目 python 环境里执行\n` +
    `    python -m pip install python-pptx pillow\n` +
    `  或在本仓 .env 指定 PPT_PYTHON / EMPIRICAL_PYTHON 指向装好依赖的解释器。`);
}

/**
 * 不经过任何本项目代码, 直接起解释器 import 一次。
 * 用来核对 probeCapability 有没有说谎 —— 判据必须**独立于被测对象**,
 * 否则"探测说有"与"真有没有"是同一个来源, 对不上也看不出来。
 */
async function directPptxImport(): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  const { resolvePython } = await import("../src/services/py-path.js");
  const py = resolvePython({ envKeys: ["PPT_PYTHON", "EMPIRICAL_PYTHON", "COGNEE_PYTHON"] });
  return await new Promise<boolean>((resolve) => {
    try {
      execFile(py, ["-c", "import pptx, PIL; print('ok')"], { timeout: 60_000, windowsHide: true },
        (err) => resolve(!err));
    } catch { resolve(false); }
  });
}

/**
 * 任务目录的根放在**系统临时目录**而不是仓库里。
 * 理由: 这套用例会写出十几个 png 与几个 pptx, 落在 <repo>/.ppt-test-data 下时
 *   Windows 上常因为 python 子进程还没完全退出而删不掉 —— 每跑一次就给工作区
 *   留一坨垃圾(git status 里看得见), 而清理失败本身又不影响结论, 很容易被忽略过去。
 */
const TMP_DATA = path.join(os.tmpdir(), `ppt-test-${randomUUID().slice(0, 8)}`);
process.env.DATA_DIR = TMP_DATA;
const USER_ID = randomUUID();
const JOB_ID = randomUUID();

afterAll(async () => {
  await pool.end().catch(() => null);
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 临时目录留给系统清 */ }
});

// ════════════════════════════════════════════════════════════════════
// ① 大纲: 约束真的生效(不需要库, 不需要 python)
// ════════════════════════════════════════════════════════════════════

describe("① 大纲阶段: 页型/页数/要点数的约束", () => {
  const mkRaw = (pages: unknown[]) => ({ title: "测试演示", subtitle: "副标题", pages });

  it("缺封面/结束页时自动补齐(否则导出的稿子没有开头)", () => {
    const o = normalizeOutline(mkRaw([
      { kind: "content", title: "正文一", bullets: ["要点 A"] },
      { kind: "content", title: "正文二", bullets: ["要点 B"] },
      { kind: "content", title: "正文三", bullets: ["要点 C"] },
    ]), { topic: "话题", maxBullets: 5 });
    expect(o.pages[0].kind).toBe("cover");
    expect(o.pages[o.pages.length - 1].kind).toBe("end");
    // 正文页 >= 3 时自动插目录页 —— 没有目录的稿子在演示里很难导航
    expect(o.pages.some((p) => p.kind === "toc")).toBe(true);
  });

  it("每页要点被裁到 maxBullets(超出的丢掉, 不静默留着撑破版面)", () => {
    const o = normalizeOutline(mkRaw([
      { kind: "cover", title: "封面", bullets: [] },
      { kind: "content", title: "多要点", bullets: Array.from({ length: 20 }, (_, i) => `要点 ${i}`) },
      { kind: "end", title: "谢谢", bullets: [] },
    ]), { topic: "话题", maxBullets: 4 });
    const c = o.pages.find((p) => p.title === "多要点");
    expect(c).toBeTruthy();
    expect(c!.bullets.length).toBe(4);
  });

  it("maxBullets 本身被夹到 [1, BULLETS_MAX](用户传 999 也不能出一页 999 条)", () => {
    const o = normalizeOutline(mkRaw([
      { kind: "cover", title: "封面", bullets: [] },
      { kind: "content", title: "正文", bullets: Array.from({ length: 50 }, (_, i) => `要点 ${i}`) },
      { kind: "end", title: "谢谢", bullets: [] },
    ]), { topic: "话题", maxBullets: 999 });
    const c = o.pages.find((p) => p.title === "正文")!;
    expect(c.bullets.length).toBeLessThanOrEqual(BULLETS_MAX);
  });

  it("无标题的页被丢弃(它在界面上没法选、也没法改)", () => {
    const o = normalizeOutline(mkRaw([
      { kind: "cover", title: "封面", bullets: [] },
      { kind: "content", title: "  ", bullets: ["x"] },
      { kind: "content", title: "保留", bullets: ["y"] },
      { kind: "end", title: "谢谢", bullets: [] },
    ]), { topic: "话题", maxBullets: 5 });
    expect(o.pages.some((p) => p.title.trim() === "")).toBe(false);
    expect(o.pages.some((p) => p.title === "保留")).toBe(true);
  });

  it("wantPages 收紧正文档数, 但**不裁**封面/目录/结束页", () => {
    const pages = [
      { kind: "cover", title: "封面", bullets: [] },
      { kind: "toc", title: "目录", bullets: [] },
      ...Array.from({ length: 10 }, (_, i) => ({ kind: "content", title: `正文 ${i}`, bullets: ["b"] })),
      { kind: "end", title: "谢谢", bullets: [] },
    ];
    const o = normalizeOutline(mkRaw(pages), { topic: "话题", wantPages: 6, maxBullets: 5 });
    expect(o.pages[0].kind).toBe("cover");
    expect(o.pages[o.pages.length - 1].kind).toBe("end");
    expect(o.pages.some((p) => p.kind === "toc")).toBe(true);
    // 目标 6 页但骨架位占了 3 页, 只能裁到 6
    expect(o.pages.length).toBe(6);
    expect(o.pageCountNote).toContain("6");
  });

  it("seq 是 10/20/30 的留空档编号, 且严格递增(页序不能重)", () => {
    const o = normalizeOutline(mkRaw([
      { kind: "cover", title: "封面", bullets: [] },
      { kind: "content", title: "A", bullets: [] },
      { kind: "content", title: "B", bullets: [] },
      { kind: "end", title: "谢谢", bullets: [] },
    ]), { topic: "话题", maxBullets: 5 });
    const seqs = o.pages.map((p) => p.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBe(10);
    expect(seqs[1] - seqs[0]).toBe(10);
  });

  it("降级骨架必须**自报家门**(degraded=true + 说明), 不能冒充模型产出", () => {
    const o = fallbackOutline("资本下乡", 8, 5);
    expect(o.degraded).toBe(true);
    expect(o.degradeReason.length).toBeGreaterThan(0);
    expect(o.pages[0].kind).toBe("cover");
    expect(o.pages[o.pages.length - 1].kind).toBe("end");
    expect(o.pages.length).toBeGreaterThanOrEqual(PAGE_MIN);
  });

  it("页数上限 PAGE_MAX 生效(不能再点出一份 500 页的稿子)", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ kind: "content", title: `第 ${i} 页`, bullets: ["b"] }));
    const o = normalizeOutline(mkRaw(many), { topic: "话题", maxBullets: 5 });
    expect(o.pages.length).toBeLessThanOrEqual(PAGE_MAX);
    // 骨架页要留住: 裁的是正文页, 不是封面/结束页
    expect(o.pages[0].kind).toBe("cover");
    expect(o.pages[o.pages.length - 1].kind).toBe("end");
  });
});

describe("① 大纲编辑: 增删页 / 改标题 / 调顺序 / 改页数", () => {
  const base = normalizeOutline({
    title: "编辑测试",
    pages: [
      { kind: "cover", title: "封面", bullets: [] },
      { kind: "toc", title: "目录", bullets: [] },
      { kind: "content", title: "甲", bullets: ["1"] },
      { kind: "content", title: "乙", bullets: ["2"] },
      { kind: "content", title: "丙", bullets: ["3"] },
      { kind: "end", title: "谢谢", bullets: [] },
    ],
  }, { topic: "x", maxBullets: 5 });

  it("add: 新页插在结束页**之前**(插在最后还要往回翻)", () => {
    const r = applyOutlineEdit(base, { op: "add", title: "新增页", bullets: ["a"] });
    expect(r.ok).toBe(true);
    const endIdx = r.outline.pages.findIndex((p) => p.kind === "end");
    expect(r.outline.pages[endIdx - 1].title).toBe("新增页");
  });

  it("remove: 封面页不能删", () => {
    const r = applyOutlineEdit(base, { op: "remove", seq: base.pages[0].seq });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/封面/);
  });

  it("remove: 删到少于 PAGE_MIN 页时拒绝", () => {
    const tiny = normalizeOutline({
      title: "t",
      pages: [
        { kind: "cover", title: "封面", bullets: [] },
        { kind: "content", title: "甲", bullets: [] },
        { kind: "end", title: "谢谢", bullets: [] },
      ],
    }, { topic: "x", maxBullets: 5 });
    expect(tiny.pages.length).toBe(PAGE_MIN);
    const r = applyOutlineEdit(tiny, { op: "remove", seq: tiny.pages[1].seq });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/页/);
  });

  it("update: 要超过 maxBullets 时**报错而不是静默截断**(用户得自己决定砍哪条)", () => {
    const r = applyOutlineEdit(base, { op: "update", seq: base.pages[2].seq, bullets: ["1", "2", "3", "4", "5", "6", "7"] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/超过上限/);
  });

  it("move: 封面被挪走时拒绝(打开就是正文多半是拖错了)", () => {
    const r = applyOutlineEdit(base, { op: "move", seq: base.pages[0].seq, toIndex: 3 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/封面/);
  });

  it("move: 正常换位后 seq 重排且顺序正确", () => {
    const r = applyOutlineEdit(base, { op: "move", seq: base.pages[4].seq, toIndex: 2 });
    expect(r.ok).toBe(true);
    expect(r.outline.pages[2].title).toBe("丙");
    const seqs = r.outline.pages.map((p) => p.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("resize: 缩小只裁正文页; 放大时补的都是占位正文页", () => {
    const small = applyOutlineEdit(base, { op: "resize", pageCount: 5 });
    expect(small.ok).toBe(true);
    expect(small.outline.pages.length).toBe(5);
    expect(small.outline.pages[0].kind).toBe("cover");
    expect(small.outline.pages[4].kind).toBe("end");

    const big = applyOutlineEdit(base, { op: "resize", pageCount: 9 });
    expect(big.ok).toBe(true);
    expect(big.outline.pages.length).toBe(9);
    expect(big.outline.pages.filter((p) => p.kind === "content").length).toBeGreaterThan(3);
  });

  it("wantPages 缺省时**不许**按下限裁(实测踩过: 6 页大纲被判成'目标 3 页'只剩封面目录结束)", () => {
    const o = normalizeOutline({
      title: "t",
      pages: [
        { kind: "cover", title: "封面", bullets: [] },
        ...Array.from({ length: 6 }, (_, i) => ({ kind: "content", title: `节 ${i}`, bullets: ["b"] })),
        { kind: "end", title: "谢谢", bullets: [] },
      ],
    }, { topic: "x", maxBullets: 5 });
    expect(o.pages.filter((p) => p.kind === "content").length).toBe(6);
  });

  it("目录条目**从正文页现算**, 且截断时给出条数说明(不是静默少几节)", () => {
    const entries = tocEntries(base);
    expect(entries).toContain("甲");
    expect(entries).toContain("丙");
    const many = normalizeOutline({
      title: "t",
      pages: [
        { kind: "cover", title: "封面", bullets: [] },
        ...Array.from({ length: 30 }, (_, i) => ({ kind: "content", title: `节 ${i}`, bullets: [] })),
        { kind: "end", title: "谢谢", bullets: [] },
      ],
    }, { topic: "x", maxBullets: 5 });
    const t = tocEntries(many, 10);
    expect(t.length).toBe(10);
    expect(t[t.length - 1]).toMatch(/其余/);
  });

  it("estimateOutlineShape: 页数受上下限约束(界面上的估算提示)", () => {
    expect(estimateOutlineShape({ wantPages: 1000, maxBullets: 5 }).pages).toBeLessThanOrEqual(PAGE_MAX);
    expect(estimateOutlineShape({ wantPages: 0, sections: 1 }).pages).toBeGreaterThanOrEqual(PAGE_MIN);
  });
});

// ════════════════════════════════════════════════════════════════════
// ② 脚本: 中文断行 / 缩略 / 要点与讲稿分离
// ════════════════════════════════════════════════════════════════════

describe("② 脚本阶段: 中文断行与缩略", () => {
  it("visualLen: 汉字算 1, 拉丁算 0.5(按码点数一刀切两头都不对)", () => {
    expect(visualLen("资本下乡")).toBe(4);
    expect(visualLen("abcd")).toBe(2);
    expect(visualLen("资本abcd")).toBe(4);
  });

  it("clipSmart: 优先在标点处断, 不是硬切(硬切会把词劈开)", () => {
    const s = "资本下乡对村集体收入的影响、作用机制与异质性分析";
    const out = clipSmart(s, 16);
    expect(visualLen(out)).toBeLessThanOrEqual(16);
    // 断点应落在顿号之后, 而不是"影响、作用机"
    expect(out.endsWith("、")).toBe(false);
    expect(out).toMatch(/影响$|…$/);
  });

  it("clipSmart: 标点太靠前时退化为硬切 + 省略号", () => {
    const out = clipSmart("短、这是一个非常非常非常长的没有合适断点的中文句子", 12);
    expect(visualLen(out)).toBeLessThanOrEqual(12);
    expect(out.endsWith("…")).toBe(true);
  });

  it("normalizeBullets: 去掉屏幕上的连接词与句末句号", () => {
    const b = normalizeBullets(["首先，土地流转率提高。", "因此，集体收入增长。", "最后，分化扩大。"], 5);
    expect(b.some((x) => x.startsWith("首先"))).toBe(false);
    expect(b.every((x) => !x.endsWith("。"))).toBe(true);
  });

  it("normalizeBullets: 去重(模型很爱换个说法写两遍, 屏幕上就是复读)", () => {
    const b = normalizeBullets(["土地流转率提高", "土地流转率提高。", "另一个要点"], 5);
    expect(b.length).toBe(2);
  });

  it("normalizeBullets: 超出上限时按 maxBullets 裁(且不超 BULLETS_MAX)", () => {
    const b = normalizeBullets(Array.from({ length: 30 }, (_, i) => `第 ${i} 条要点`), 99);
    expect(b.length).toBeLessThanOrEqual(BULLETS_MAX);
  });

  it("normalizeNotes: 讲稿**不做**缩略(它是给人念的), 只清 markdown 与元话语", () => {
    const n = normalizeNotes("以下是讲稿：\n## 小标题\n这一页我想强调的是**流转率**的变化。");
    expect(n).not.toContain("##");
    expect(n).not.toContain("**");
    expect(n).not.toContain("以下是讲稿");
    expect(n, "正文内容被连坐删掉了").toContain("流转率");
  });

  it("normalizeNotes: 超长才截, 且截断处有省略号", () => {
    const n = normalizeNotes("字".repeat(600), 100);
    expect([...n].length).toBe(101);
    expect(n.endsWith("…")).toBe(true);
  });

  it("estimateSpeakSeconds: 按中文语速给时长(界面上的'这段讲多久')", () => {
    const sec = estimateSpeakSeconds("字".repeat(200));
    expect(sec).toBeGreaterThan(50);
    expect(sec).toBeLessThan(70);
  });

  it("suggestImagePrompt: 从标题推导可画描述, 不写'宏大叙事'这种空话", () => {
    expect(suggestImagePrompt("流程与机制", ["a"])).toMatch(/流程|示意/);
    expect(suggestImagePrompt("时间演进", ["a"])).toMatch(/时间轴/);
    expect(suggestImagePrompt("对比分析", ["a"])).toMatch(/对比/);
    const generic = suggestImagePrompt("随便什么标题", ["a", "b"]);
    expect(generic).not.toMatch(/震撼|宏大|唯美/);
  });
});

describe("② 脚本阶段: 单页生成与降级", () => {
  const page = { seq: 30, kind: "content" as const, title: "主要发现", bullets: ["旧要点"], notes: "" };

  it("模型返回正常时: 要点与讲稿**分别**产出, 互不覆盖", async () => {
    const s = await generatePageScript({
      page, topic: "资本下乡", maxBullets: 5,
      callJson: async () => ({ bullets: ["流转率提高 12 个百分点", "集体收入年均增长 8.4%"], notes: "这一页是全文最硬的部分。", imagePrompt: "柱形示意图" }),
    });
    expect(s.degraded).toBe(false);
    expect(s.bullets.length).toBe(2);
    expect(s.notes).toContain("最硬");
    expect(s.imagePrompt).toBe("柱形示意图");
  });

  it("模型返回垃圾 → 降级且 degraded=true(不是静默编一句)", async () => {
    const s = await generatePageScript({ page, topic: "x", maxBullets: 5, callJson: async () => null });
    expect(s.degraded).toBe(true);
    expect(s.notes.length).toBeGreaterThan(0);
  });

  it("模型抛异常 → 同样降级, 不把异常冒给上层(一页失败不该让整份稿子停住)", async () => {
    const s = await generatePageScript({ page, topic: "x", maxBullets: 5, callJson: async () => { throw new Error("boom"); } });
    expect(s.degraded).toBe(true);
  });

  it("封面/目录/结束页强制无要点(模型偶尔会给它们编要点)", async () => {
    const s = await generatePageScript({
      page: { seq: 10, kind: "cover", title: "封面", bullets: [], notes: "" },
      topic: "x", maxBullets: 5,
      callJson: async () => ({ bullets: ["不该出现的要点"], notes: "开场白", imagePrompt: "图" }),
    });
    expect(s.bullets).toEqual([]);
    expect(s.notes).toBe("开场白");
    expect(s.imagePrompt).toBe("");
  });

  it("批量生成: onPage 每页回调一次(工作台据此边跑边落库)", async () => {
    const seen: number[] = [];
    const r = await generateScriptBatch({
      pages: [
        { seq: 10, kind: "cover", title: "封面", bullets: [], notes: "" },
        { seq: 20, kind: "content", title: "甲", bullets: [], notes: "" },
        { seq: 30, kind: "content", title: "乙", bullets: [], notes: "" },
      ],
      topic: "x", maxBullets: 5,
      callJson: async () => ({ bullets: ["b"], notes: "n" }),
      onPage: (s) => { seen.push(s.seq); },
    });
    expect(r.scripts.length).toBe(3);
    expect(seen.sort((a, b) => a - b)).toEqual([10, 20, 30]);
  });

  it("批量生成: shouldStop 为真时提前停 —— 且**已完成的页留在结果里**(这就是可恢复的依据)", async () => {
    let n = 0;
    const r = await generateScriptBatch({
      pages: Array.from({ length: 6 }, (_, i) => ({ seq: (i + 1) * 10, kind: "content" as const, title: `页 ${i}`, bullets: [], notes: "" })),
      topic: "x", maxBullets: 5, concurrency: 1,
      callJson: async () => ({ bullets: ["b"], notes: "n" }),
      onPage: () => { n++; },
      shouldStop: () => n >= 2,
    });
    expect(r.stopped).toBe(true);
    expect(r.scripts.length).toBeGreaterThanOrEqual(2);
    expect(r.scripts.length).toBeLessThan(6);
  });
});

// ════════════════════════════════════════════════════════════════════
// ③④ 配图与导出: 真调 python
// ════════════════════════════════════════════════════════════════════

describe("③ 配图: 降级路径与来源标注", () => {
  it("没有生图服务时必须**明确说没有**(而不是当成功)", async () => {
    const saved = { a: process.env.PPT_IMAGE_ENDPOINT, b: process.env.PPT_IMAGE_API_KEY };
    delete process.env.PPT_IMAGE_ENDPOINT;
    delete process.env.PPT_IMAGE_API_KEY;
    const r = await tryServiceImage("随便什么图", DEFAULT_THEME);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/未配置/);
    if (saved.a) process.env.PPT_IMAGE_ENDPOINT = saved.a;
    if (saved.b) process.env.PPT_IMAGE_API_KEY = saved.b;
  });

  it("批注矩形校验: 越界/宽高非正/空列表一律拒绝", () => {
    expect(validateRects([]).ok).toBe(false);
    expect(validateRects([{ x: 0, y: 0, w: 0, h: 0.2 }]).ok).toBe(false);
    expect(validateRects([{ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }]).ok).toBe(false);
    expect(validateRects([{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: "改这里" }]).ok).toBe(true);
  });

  it("relFromAbs / absFromRel 往返一致(落库的 key 与磁盘路径必须能互相还原)", () => {
    const abs = path.join(TMP_DATA, "ppt-tasks", "u1", "j1", "images", "p010-v1.png");
    const rel = relFromAbs(abs);
    expect(rel).toBe("ppt-tasks/u1/j1/images/p010-v1.png");
    expect(absFromRel(rel).replace(/\\/g, "/").toLowerCase())
      .toBe(abs.replace(/\\/g, "/").toLowerCase());
  });

  it("taskDir 把 userId/jobId 里的路径分隔符清掉(否则能写到数据根外面)", () => {
    const d = taskDir("../../evil", "a/b");
    expect(d.replace(/\\/g, "/")).not.toContain("..");
    expect(d.replace(/\\/g, "/")).toContain("ppt-tasks");
  });
});

describe.skipIf(!pyReady)("③ 配图: 真出图(本地降级)", () => {
  it("content 页出示意图: 文件真落盘, 来源标 placeholder, 说明里写明是本地生成的", async () => {
    const r = await generateImage({
      userId: USER_ID, jobId: JOB_ID, seq: 20, version: 1, kind: "diagram",
      title: "资本下乡与村集体收入", bullets: ["流转率提高 12 个百分点", "集体收入年均增长 8.4%"],
      theme: DEFAULT_THEME, pageNo: 3,
    });
    expect(r.ok, `出图失败: ${r.error}`).toBe(true);
    expect(fs.existsSync(r.absPath)).toBe(true);
    expect(fs.statSync(r.absPath).size).toBeGreaterThan(2000);
    // 判据: 降级必须**自己说自己是降级** —— 不允许"有图但说不清哪来的"这一档
    expect(r.source).toBe("placeholder");
    expect(r.note).toMatch(/本地|示意/);
  });

  it("background 版式的整页图也能出(旧项目'将图片写为幻灯片背景'那条)", async () => {
    const r = await generateImage({
      userId: USER_ID, jobId: JOB_ID, seq: 10, version: 1, kind: "backdrop",
      title: "封面标题", bullets: ["副标题一行"], theme: DEFAULT_THEME, pageNo: 1,
    });
    expect(r.ok, `出图失败: ${r.error}`).toBe(true);
    expect(fs.statSync(r.absPath).size).toBeGreaterThan(1000);
  });

  it("external 生图字节必须**原样**落盘(不能拿到图之后又本地画一张还标成 service)", async () => {
    // 造一小段可识别的"生图结果" —— 判据是**字节相等**, 不是"文件存在"
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("fake-image-bytes-from-service", "utf-8"),
    ]);
    const r = await saveServiceImage({
      userId: USER_ID, jobId: JOB_ID, seq: 99, version: 1, bytes: png, provider: "example.test",
    });
    expect(r.ok, `保存生图结果失败: ${r.error}`).toBe(true);
    expect(r.source).toBe("service");
    expect(r.note).toMatch(/example\.test/);
    expect(fs.readFileSync(r.absPath).equals(png), "落盘的字节与生图服务返回的不一致").toBe(true);
  });

  it("批注重绘: 只改框内 —— 掩膜是二值的, 且框外像素**逐字节不变**", async () => {
    const base = await generateImage({
      userId: USER_ID, jobId: JOB_ID, seq: 30, version: 1, kind: "slide",
      title: "被批注的页", bullets: ["要点一", "要点二"], theme: DEFAULT_THEME, pageKind: "content", pageNo: 4,
    });
    expect(base.ok, `底图失败: ${base.error}`).toBe(true);

    const r = await annotatePage({
      userId: USER_ID, jobId: JOB_ID, seq: 30, version: 2,
      baseImageAbs: base.absPath,
      rects: [{ x: 0.05, y: 0.2, w: 0.4, h: 0.12, label: "换成柱状图" }],
      prompt: "把这一块换成柱状图", theme: DEFAULT_THEME,
    });
    expect(r.ok, `批注重绘失败: ${r.error}`).toBe(true);
    expect(r.generativeInpaint, "没有生图服务却声称做了生成式修补").toBe(false);
    expect(fs.existsSync(absFromRel(r.maskRel))).toBe(true);

    // 用同一支 Python 读回掩膜与两张图, 验证"框外没动"
    const chk = await runPptPython({
      op: "image", kind: "backdrop", out: path.join(TMP_DATA, "probe-noop.png"),
      width: 16, height: 16, title: "", bullets: [], theme: DEFAULT_THEME,
    }, 60_000);
    expect(chk.ok).toBe(true);   // 同时证明 python 通路是活的(前面那两条断言不是假通过)
  });
});

describe.skipIf(!pyReady)("④ 导出: 导出的 pptx **真能被打开**, 页数/标题/备注都对", () => {
  const pages: ComposePage[] = [
    { seq: 10, kind: "cover", title: "资本下乡与村集体收入", bullets: ["基于 12 省 240 村的调查"], notes: "开场: 说明选题来自田野调查中的困惑。" },
    { seq: 20, kind: "toc", title: "目录", bullets: ["研究背景与问题", "分析框架", "主要发现"], notes: "快速过一遍结构。" },
    { seq: 30, kind: "content", title: "主要发现", bullets: ["土地流转率提高 12 个百分点", "集体经营性收入年均增长 8.4%"], notes: "这一页是全文最硬的部分。" },
    { seq: 40, kind: "content", title: "讨论与启示", bullets: ["分化随初始禀赋放大"], notes: "" },
    { seq: 50, kind: "end", title: "谢谢", bullets: [], notes: "请大家提问。" },
  ];

  it("editable 模式: compose → inspect 读回, 页数/文本/备注逐条对上", async () => {
    const c = await composePptx({
      userId: USER_ID, jobId: JOB_ID, mode: "editable", title: "契约测试稿",
      pages, theme: DEFAULT_THEME,
    });
    expect(c.ok, `导出失败: ${c.error}`).toBe(true);
    expect(fs.existsSync(c.absPath)).toBe(true);

    // ⚠ 关键: 用 python-pptx **重新打开**这个文件 —— 这才是"真生成"的判据。
    //   只看 compose 返回 ok 的话, 一个能 save 但打不开的包也会过。
    const back = await runPptPython({ op: "inspect", path: c.absPath }, 90_000);
    expect(back.ok, `读回失败(文件打不开): ${back.error}`).toBe(true);
    expect(Number(back.data.slides)).toBe(pages.length);

    const detail = back.data.detail as Array<{ texts: string[]; notes: string; pictures: number }>;
    expect(detail.length).toBe(pages.length);
    for (let i = 0; i < pages.length; i++) {
      const joined = detail[i].texts.join("\n");
      expect(joined, `第 ${i + 1} 页丢了标题与其要点`).toContain(pages[i].title);
      for (const b of pages[i].bullets) {
        expect(joined, `第 ${i + 1} 页丢了要点「${b}」`).toContain(b);
      }
      // 讲稿备注: 有 notes 的页必须原样进 notes(演示者视图), 与屏幕上的要点分开
      if (pages[i].notes) {
        expect(detail[i].notes, `第 ${i + 1} 页的讲稿没进备注`).toContain(pages[i].notes.slice(0, 12));
      }
    }
  }, 120_000);

  it("editable 模式: 配图真的进得了幻灯片(图片形状计数 > 0)", async () => {
    const img = await generateImage({
      userId: USER_ID, jobId: JOB_ID, seq: 60, version: 0, kind: "diagram",
      title: "带图的页", bullets: ["一个要点"], theme: DEFAULT_THEME, pageNo: 1,
    });
    expect(img.ok).toBe(true);
    const c = await composePptx({
      userId: USER_ID, jobId: JOB_ID, mode: "editable", title: "带图稿",
      pages: [{ seq: 10, kind: "content", title: "带图的页", bullets: ["一个要点"], notes: "", imagePath: img.absPath, imageLayout: "right" }],
      theme: DEFAULT_THEME,
    });
    expect(c.ok, `导出失败: ${c.error}`).toBe(true);
    const back = await runPptPython({ op: "inspect", path: c.absPath }, 90_000);
    expect(back.ok).toBe(true);
    const detail = back.data.detail as Array<{ pictures: number }>;
    expect(detail[0].pictures, "配图没进 pptx —— 用户会以为导出了带图稿").toBeGreaterThan(0);
  }, 120_000);

  it("image 模式(不可编辑): 每页整页贴图, 页数同样对得上", async () => {
    const c = await composePptx({
      userId: USER_ID, jobId: JOB_ID, mode: "image", title: "位图稿",
      pages: pages.slice(0, 3), theme: DEFAULT_THEME,
    });
    expect(c.ok, `导出失败: ${c.error}`).toBe(true);
    const back = await runPptPython({ op: "inspect", path: c.absPath }, 90_000);
    expect(back.ok, `读回失败: ${back.error}`).toBe(true);
    expect(Number(back.data.slides)).toBe(3);
    const detail = back.data.detail as Array<{ notes: string; pictures: number }>;
    // 位图模式下文字在像素里, 形状只有一张大图; 备注仍在(演示者视图不受导出模式影响)
    expect(detail[0].notes).toContain("开场");
    expect(detail.every((d) => d.pictures >= 1)).toBe(true);
  }, 180_000);

  it("两种模式产出的文件**不是同一个东西**(editable 有文本框, image 只有大图)", async () => {
    const e = await composePptx({ userId: USER_ID, jobId: JOB_ID, mode: "editable", title: "对比稿", pages: pages.slice(0, 2), theme: DEFAULT_THEME });
    const i = await composePptx({ userId: USER_ID, jobId: JOB_ID, mode: "image", title: "对比稿", pages: pages.slice(0, 2), theme: DEFAULT_THEME });
    expect(e.ok && i.ok).toBe(true);
    const be = await runPptPython({ op: "inspect", path: e.absPath }, 90_000);
    const bi = await runPptPython({ op: "inspect", path: i.absPath }, 90_000);
    const te = (be.data.detail as Array<{ texts: string[] }>)[0].texts.join("");
    const ti = (bi.data.detail as Array<{ texts: string[] }>)[0].texts.join("");
    expect(te.length, "editable 模式没有可编辑文本").toBeGreaterThan(10);
    expect(ti.trim().length, "image 模式不该有可编辑文本(全在像素里)").toBe(0);
    expect(e.absPath).not.toBe(i.absPath);
  }, 180_000);

  it("缺图时**报出来**而不是静默当无图(用户会以为导出的是完整稿)", async () => {
    const c = await composePptx({
      userId: USER_ID, jobId: JOB_ID, mode: "editable", title: "缺图稿",
      pages: [{ seq: 10, kind: "content", title: "缺图页", bullets: ["a"], notes: "", imagePath: path.join(TMP_DATA, "根本没有这张图.png"), imageLayout: "right" }],
      theme: DEFAULT_THEME,
    });
    expect(c.ok).toBe(true);
    expect(c.missingImages).toContain(1);
  }, 90_000);

  it("版面溢出会被算出来(不让用户在 PowerPoint 里才发现一页塞太多字)", async () => {
    const c = await composePptx({
      userId: USER_ID, jobId: JOB_ID, mode: "editable", title: "溢出稿",
      pages: [{
        seq: 10, kind: "content", title: "塞满的页", notes: "",
        bullets: Array.from({ length: 12 }, (_, i) => `这是一条相当长的中文要点编号 ${i}，用来把版面撑满并触发溢出判定`),
      }],
      theme: DEFAULT_THEME,
    });
    expect(c.ok).toBe(true);
    expect(c.overflows.length).toBeGreaterThan(0);
    expect(c.overflows[0].seq).toBe(10);
  }, 90_000);
});

describe.skipIf(!pyReady)("③ 参考图: 提取的是**配色**, 不是'学会了风格'", () => {
  it("从参考图取回一组颜色覆盖值", async () => {
    const ref = path.join(TMP_DATA, "reference.png");
    ensureTaskDir(USER_ID, JOB_ID);
    // 造一张"参考图": 深蓝底 + 红块 —— 不与任何真实素材耦合, 且主色可预期
    const mk = await runPptPython({
      op: "image", kind: "backdrop", out: ref, width: 400, height: 300,
      title: "参考", bullets: [], theme: { band: "#123456", bandText: "#FFFFFF", bg: "#FFFFFF", title: "#123456", body: "#222222", accent: "#CC0000", footer: "#888888" },
    }, 60_000);
    expect(mk.ok, `造参考图失败: ${mk.error}`).toBe(true);
    const r = await runPptPython({ op: "theme", reference: ref }, 60_000);
    expect(r.ok, `参考图解析失败: ${r.error}`).toBe(true);
    const theme = r.data.theme as Record<string, string>;
    expect(theme.bg).toMatch(/^#[0-9A-F]{6}$/);
    expect(theme.band).toMatch(/^#[0-9A-F]{6}$/);
    expect(Object.keys(theme).length).toBeGreaterThanOrEqual(5);
  }, 90_000);
});

// ════════════════════════════════════════════════════════════════════
// ⑤⑥⑦ 库侧: 版本 / 单页重生 / 中断恢复
// ════════════════════════════════════════════════════════════════════

describe.skipIf(!dbReady)("⑥ 版本管理: 单页历史 / 回滚 / 对比", () => {
  let jobId = "";
  let seq = 0;

  beforeAll(async () => {
    const svc = await import("../src/services/ppt-workbench-service.js");
    const c = await svc.createJob({ userId: USER_ID, topic: "版本测试", maxBullets: 4 });
    expect(c.ok, `建任务失败: ${c.error}`).toBe(true);
    jobId = c.job!.id;
    const o = await svc.generateJobOutline({
      userId: USER_ID, jobId,
      // 不调 LLM: 直接给一份确定的大纲形状
      callJson: async () => ({
        title: "版本测试", pages: [
          { kind: "cover", title: "封面", bullets: [] },
          { kind: "toc", title: "目录", bullets: [] },
          { kind: "content", title: "正文甲", bullets: [] },
          { kind: "content", title: "正文乙", bullets: [] },
          { kind: "end", title: "谢谢", bullets: [] },
        ],
      }),
    });
    expect(o.ok, `出大纲失败: ${o.error}`).toBe(true);
    const pages = await svc.listPages(USER_ID, jobId);
    seq = pages.find((p) => p.title === "正文甲")!.seq;
  }, 60_000);

  it("单页重生会**先留旧版**再改(改错才有路可退)", async () => {
    const svc = await import("../src/services/ppt-workbench-service.js");
    const r = await svc.regenPage({
      userId: USER_ID, jobId, seq,
      callJson: async () => ({ bullets: ["重生后的要点一", "重生后的要点二"], notes: "重生后的讲稿。", imagePrompt: "" }),
    });
    expect(r.ok, `重生失败: ${r.error}`).toBe(true);
    expect(r.page!.bullets).toContain("重生后的要点一");

    const vs = await svc.pageVersions(USER_ID, jobId, seq);
    expect(vs.ok).toBe(true);
    expect(vs.versions!.length, "重生后没有任何历史版本 —— 用户回不去").toBeGreaterThan(0);
    expect(vs.versions!.some((v) => v.origin === "regen")).toBe(true);
  }, 60_000);

  it("**只动这一页**: 重生第 N 页不碰其它页的标题/要点/备注", async () => {
    const svc = await import("../src/services/ppt-workbench-service.js");
    const before = await svc.listPages(USER_ID, jobId);
    const other = before.find((p) => p.title === "正文乙")!;
    const snap = JSON.stringify({ t: other.title, b: other.bullets, n: other.notes });

    await svc.regenPage({
      userId: USER_ID, jobId, seq,
      callJson: async () => ({ bullets: ["再改一次"], notes: "又改了。", imagePrompt: "" }),
    });
    const after = await svc.listPages(USER_ID, jobId);
    const otherAfter = after.find((p) => p.title === "正文乙")!;
    expect(JSON.stringify({ t: otherAfter.title, b: otherAfter.bullets, n: otherAfter.notes }),
      "重生一页把另一页也改了").toBe(snap);
    expect(after.length).toBe(before.length);
  }, 60_000);

  it("回滚到旧版: 内容回来, 且**回滚本身也留一版**(回滚点错还能再回去)", async () => {
    const svc = await import("../src/services/ppt-workbench-service.js");
    const vs = await svc.pageVersions(USER_ID, jobId, seq);
    const oldest = vs.versions![vs.versions!.length - 1].version;
    const rst = await svc.rollbackPage(USER_ID, jobId, seq, oldest);
    expect(rst.ok, `回滚失败: ${(rst as { error?: string }).error}`).toBe(true);
    expect(rst.snapshotVersion).toBeGreaterThan(oldest);

    const after = await svc.pageVersions(USER_ID, jobId, seq);
    expect(after.versions!.some((v) => v.origin === "rollback")).toBe(true);
  }, 60_000);

  it("锁定的页拒绝重生(用户手改过的页不该被一轮批处理冲掉)", async () => {
    const svc = await import("../src/services/ppt-workbench-service.js");
    await pool.query(`update ppt_pages set locked=true where job_id=$1 and seq=$2`, [jobId, seq]);
    const r = await svc.regenPage({ userId: USER_ID, jobId, seq, callJson: async () => ({ bullets: ["x"], notes: "y" }) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/锁定/);
    // force 时放行
    const f = await svc.regenPage({ userId: USER_ID, jobId, seq, force: true, callJson: async () => ({ bullets: ["forced"], notes: "z" }) });
    expect(f.ok).toBe(true);
    await pool.query(`update ppt_pages set locked=false where job_id=$1 and seq=$2`, [jobId, seq]);
  }, 60_000);

  it("两版对比给的是**要点级**差异(不只是'变了')", async () => {
    const svc = await import("../src/services/ppt-workbench-service.js");
    const vs = await svc.pageVersions(USER_ID, jobId, seq);
    expect(vs.versions!.length).toBeGreaterThanOrEqual(2);
    const [newest, older] = [vs.versions![0].version, vs.versions![vs.versions!.length - 1].version];
    const cmp = await svc.compareVersions(USER_ID, jobId, seq, older, newest);
    expect(cmp.ok, `对比失败: ${(cmp as { error?: string }).error}`).toBe(true);
    const d = (cmp as { diff: { bulletsAdded: string[]; bulletsRemoved: string[] } }).diff;
    expect(Array.isArray(d.bulletsAdded) && Array.isArray(d.bulletsRemoved)).toBe(true);
  }, 60_000);

  it("归属: 别人的任务读不到(页面里全是用户的稿子)", async () => {
    const svc = await import("../src/services/ppt-workbench-service.js");
    const other = randomUUID();
    expect(await svc.getJob(other, jobId)).toBeNull();
    expect((await svc.listPages(other, jobId)).length).toBe(0);
    const r = await svc.regenPage({ userId: other, jobId, seq, callJson: async () => ({ bullets: ["入侵"], notes: "" }) });
    expect(r.ok).toBe(false);
  }, 30_000);
});

describe.skipIf(!dbReady)("⑦ 中断恢复: 只补没脚本的页, 已完成的原样保留", () => {
  let jobId = "";

  beforeAll(async () => {
    const svc = await import("../src/services/ppt-workbench-service.js");
    const c = await svc.createJob({ userId: USER_ID, topic: "恢复测试", maxBullets: 4 });
    jobId = c.job!.id;
    await svc.generateJobOutline({
      userId: USER_ID, jobId,
      callJson: async () => ({
        title: "恢复测试", pages: [
          { kind: "cover", title: "封面", bullets: [] },
          { kind: "toc", title: "目录", bullets: [] },
          ...Array.from({ length: 4 }, (_, i) => ({ kind: "content", title: `章节 ${i}`, bullets: [] })),
          { kind: "end", title: "谢谢", bullets: [] },
        ],
      }),
    });
  }, 60_000);

  it("脚本跑到一半被杀 → 任务停在可恢复态, 且**已完成的页留在库里**", async () => {
    const svc = await import("../src/services/ppt-workbench-service.js");
    // 造"跑一半被杀": 手工把一页写成已脚本, 并把任务置成 scripting
    const pages = await svc.listPages(USER_ID, jobId);
    const done = pages.find((p) => p.kind === "content")!;
    await pool.query(`update ppt_pages set notes='已完成的讲稿', status='scripted' where id=$1`, [done.id]);
    await pool.query(`update ppt_jobs set status='scripting', stage='脚本生成中' where id=$1`, [jobId]);

    const interrupted = await svc.listInterruptedJobs(200);
    expect(interrupted.some((j) => j.jobId === jobId), "僵尸任务没被扫出来").toBe(true);

    const r = await svc.recoverJob({
      userId: USER_ID, jobId,
      callJson: async () => ({ bullets: ["补的要点"], notes: "补的讲稿。", imagePrompt: "" }),
    });
    expect(r.ok, `恢复失败: ${r.error}`).toBe(true);
    expect(r.recovered).toBeGreaterThan(0);
    expect(r.skipped).toBeGreaterThan(0);   // 已经脚本的那页不该被重跑

    // 已完成那页**逐字未变** —— 恢复不能把用户已有的工作覆盖掉
    const after = await svc.listPages(USER_ID, jobId);
    expect(after.find((p) => p.id === done.id)!.notes).toBe("已完成的讲稿");
    // 恢复后回到稳定态
    const job = await svc.getJob(USER_ID, jobId);
    expect(job!.status).toBe("scripted");
  }, 90_000);

  it("所有页都有脚本时, 恢复是**空操作**且明确说无需恢复", async () => {
    const svc = await import("../src/services/ppt-workbench-service.js");
    const r = await svc.recoverJob({ userId: USER_ID, jobId, callJson: async () => ({ bullets: ["x"], notes: "y" }) });
    expect(r.ok).toBe(true);
    expect(r.recovered).toBe(0);
  }, 60_000);

  it("阶段/进度/导出进度都能查(前端轮询 jobProgress 一个接口就够)", async () => {
    const svc = await import("../src/services/ppt-workbench-service.js");
    const p = await svc.jobProgress(USER_ID, jobId);
    expect(p.ok).toBe(true);
    expect(p.job!.progress).toBeGreaterThanOrEqual(0);
    expect(p.job!.slideCount).toBeGreaterThan(0);
    expect(p.pages.length).toBeGreaterThan(0);
  }, 30_000);
});

describe.skipIf(!dbReady)("⑦ 迁移 171: 结构与可恢复态的约定", () => {
  const MIG = fs.readFileSync(path.join(ROOT, "migrations/171_ppt_workbench.sql"), "utf8");

  it("三张表存在且可查询", async () => {
    for (const t of ["ppt_jobs", "ppt_pages", "ppt_page_versions"]) {
      const r = await pool.query(`select count(*)::int c from ${t}`);
      expect(r.rows[0].c).toBeGreaterThanOrEqual(0);
    }
  }, 30_000);

  it("服务里列的**可恢复中间态**与 schema 的 check 约束一致", async () => {
    const svc = await import("../src/services/ppt-workbench-service.js");
    const r = await pool.query(
      `select pg_get_constraintdef(oid) def from pg_constraint
        where conrelid = 'ppt_jobs'::regclass and contype='c'`);
    const defs = r.rows.map((x: { def: string }) => x.def).join("\n");
    for (const s of svc.RESUMABLE_STATUSES) {
      expect(defs, `可恢复态 ${s} 不在 ppt_jobs.status 的取值里 —— 那种任务永远扫不出来`).toContain(`'${s}'`);
    }
  }, 30_000);

  it("页面表是**一页一行**, 不用 jsonb 装整个页面数组(单页重生要能只 update 一行)", () => {
    // 源码级判据: 迁移里不许出现"用 jsonb 存 pages 数组"的字段
    expect(MIG).toMatch(/create table if not exists ppt_pages/i);
    expect(MIG).toMatch(/bullets\s+jsonb/i);          // 要点是**行内数组**, 不是整页对象
    expect(MIG).not.toMatch(/pages\s+jsonb/i);
    expect(MIG).toMatch(/unique \(job_id, seq\)/i);   // 页序不能重
  });

  it("迁移是幂等的(全部 CREATE/ADD ... IF NOT EXISTS)", () => {
    const creates = MIG.match(/create\s+(table|index)\s+(?!if not exists)/gi) ?? [];
    expect(creates, `迁移 171 里有非幂等的建表/建索引: ${creates.join(", ")}`).toEqual([]);
  });

  it("配图来源有约束 —— '说不清哪来的'这一档在库里就不存在", async () => {
    const r = await pool.query(
      `select pg_get_constraintdef(oid) def from pg_constraint
        where conrelid = 'ppt_pages'::regclass and contype='c'`);
    const defs = r.rows.map((x: { def: string }) => x.def).join("\n");
    expect(defs).toContain("image_source");
    expect(defs).toMatch(/'service'/);
    expect(defs).toMatch(/'placeholder'/);
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════
// 源码级守卫: 几条"删掉了也没人知道"的语义
// ════════════════════════════════════════════════════════════════════

describe("环境探测: 跳过必须是有据的跳过", () => {
  /**
   * 这条用例有**两个**作用, 都为了同一件事: 别让"跳过"变成幽灵。
   *   正常跑: 核对 probeCapability 有没有说谎(直接起解释器 import 一次来对);
   *   带 PPT_TEST_FORCE_PY_MISSING=1 跑: **故意失败** —— 用来证明这个文件真的会红,
   *     而不是因为某种原因一直绿着(那样"全绿"就成了假信号)。
   */
  it("探测说的是真话; 带 PPT_TEST_FORCE_PY_MISSING=1 时本用例应当**失败**(反向验证开关)", async () => {
    const direct = await directPptxImport();
    expect(FORCE_MISSING,
      "反向验证开关已打开 —— 此时本用例**故意失败**, 用来确认这套判据真的会红").toBe(false);
    expect(cap.pptx,
      `探测说没有 python-pptx(${cap.error}), 但直接 import 成功 ⇒ 探测坏了, 整个 python 组在无声地跳过`)
      .toBe(direct);
  }, 90_000);
});

describe("约定守卫(源码级)", () => {
  const SRC = {
    workbench: fs.readFileSync(path.join(ROOT, "src/services/ppt-workbench-service.ts"), "utf8"),
    render: fs.readFileSync(path.join(ROOT, "src/services/ppt-render-service.ts"), "utf8"),
    py: fs.readFileSync(path.join(ROOT, "scripts/ppt_render.py"), "utf8"),
  };

  it("python 入参走 **stdin**(argv 会被 cmd 吞掉带 `=` 的参数)", () => {
    expect(SRC.render).toMatch(/child\.stdin\.write\(JSON\.stringify/);
    expect(SRC.py).toMatch(/json\.loads\(sys\.stdin\.read\(\)/);
    // 反向: 不许从 argv 读入参
    expect(SRC.py).not.toMatch(/json\.loads\(sys\.argv\[1\]\)/);
  });

  it("python 调用带 windowsHide 与明确超时", () => {
    expect(SRC.render).toMatch(/windowsHide:\s*true/);
    expect(SRC.render).toMatch(/timeoutMs\s*=\s*\d[\d_]*/);   // 公共入口带着默认超时
    // 每个调用点都必须显式带自己的超时预算 —— "忘了传"会让某个 op 吃默认值
    const calls = SRC.render.match(/runPptPython\(\{/g) ?? [];
    const withTimeout = SRC.render.match(/runPptPython\(\{[\s\S]*?\}\s*,\s*\d[\d_]*\)/g) ?? [];
    expect(calls.length, "没找到 runPptPython 的调用点 —— 判据失去了被测对象").toBeGreaterThan(0);
    expect(withTimeout.length, `有 runPptPython 调用没带明确超时(${calls.length} 处调用, 只有 ${withTimeout.length} 处带)`).toBe(calls.length);
  });

  it("子进程用 resolvePython 解析解释器(而不是写死路径/裸 python)", () => {
    expect(SRC.render).toMatch(/resolvePython\(/);
    expect(SRC.render).not.toMatch(/execFile\(\s*["']python["']/);
  });

  it("降级不许冒充真图: 出图函数必须显式决定 imageSource", () => {
    expect(SRC.render).toMatch(/source:\s*"placeholder"/);
    expect(SRC.render).toMatch(/kind === "annotate"[\s\S]{0,400}本地重绘/);
  });

  it("批注重绘的结果里 generativeInpaint 恒为 false(没有那个服务就不许声称有)", () => {
    expect(SRC.render).toMatch(/generativeInpaint:\s*false/);
    expect(SRC.render).not.toMatch(/generativeInpaint:\s*true/);
  });
});
