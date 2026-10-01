/**
 * wordcloud.test.ts — 词云(文本/词频表 → PNG + 词频数据)。
 *
 * 这个文件分两层, 因为它的失效方式分两种:
 *
 *   **纯 TS 层**(不依赖 Python)测的是"什么会被静默吞掉":
 *     空词频不该画出一张空白图、归属不该串号、产物 key 不该带路径、产物读取不该越界。
 *     这些全是"不报错的错", 单测是唯一能拦住它们的地方。
 *
 *   **Python 层**测的是"图是不是真的画出来了":
 *     ① 词云库/中文字体没装 → `describe.skipIf`, 与 `test/file-text-service.test.ts`
 *        对真库、`test/v399-integration.test.ts` 对 pandas 的 `describe.skipIf` 同一套处理;
 *     ② **中文必须真的渲染成汉字** —— 词云库不给 font_path 时会把中文画成豆腐块(□),
 *        图能出来、不报错、看着还挺像回事。所以断言"选到了中文字体文件"+"PNG 尺寸对",
 *        而不是"命令返回 0"。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  toBase64, wordcloudKey, getWordCloud, renderWordCloud, wordcloudAvailable, readWordCloudFile,
} from "../src/services/wordcloud-service.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "wordcloud_render.py");

/** 与 v399-integration 同一套解析: .env 里的 EMPIRICAL_PYTHON 优先(venv 里的库才齐) */
function resolvePy(): string {
  const envPath = path.join(ROOT, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*EMPIRICAL_PYTHON\s*=\s*(.+)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return process.env.EMPIRICAL_PYTHON || process.env.COGNEE_PYTHON
    || (process.platform === "win32" ? "python" : "python3");
}
const PY = resolvePy();

/**
 * 依赖探测(一次, 30s 超时)。不这么做的话"没装 wordcloud"会表现成一组渲染用例失败,
 * 而真正的原因环境问题会被当成回归。
 */
let probe: { ok: boolean; font?: string; version?: string; error?: string } = { ok: false, error: "未探测" };
try {
  const stdout = execFileSync(PY, [SCRIPT, "--selfcheck"], { encoding: "utf-8", timeout: 30_000, stdio: "pipe" });
  probe = JSON.parse(String(stdout).trim().split(/\r?\n/).pop() ?? "{}");
} catch (e) {
  probe = { ok: false, error: String((e as Error).message).slice(0, 160) };
}
if (!probe.ok) {
  console.warn(`[wordcloud] Python 侧不可用, 渲染用例跳过(${probe.error}) — `
    + "装依赖: pip install wordcloud; 指定解释器: EMPIRICAL_PYTHON");
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 纯 TS: 那些"不报错的错"
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!probe.ok)("词云 · Python 侧可用性自检", () => {
  it("★ 自检报告里带着**中文字体路径**, 而不是只说 ok", () => {
    // 只看 ok 是不够的: 没有中文字体时词云库会静默把中文画成豆腐块
    expect(probe.ok).toBe(true);
    expect(probe.font).toBeTruthy();
    expect(existsSync(probe.font!)).toBe(true);
  });

  it("wordcloudAvailable() 与服务侧自检结论一致", async () => {
    const r = await wordcloudAvailable();
    expect(r.ok).toBe(true);
    expect(r.font).toBe(probe.font);
    expect(r.version).toBe(probe.version);
  });
});

describe("词云 · 数据URL与产物 key", () => {
  it("PNG → data URL(前端可直接塞 img src)", () => {
    const url = toBase64(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(Buffer.from(url.split(",")[1], "base64").equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
  });

  it("★ 产物 key 按用户分目录 + 内容 hash 命名(同参数重跑不堆垃圾)", () => {
    const a = wordcloudKey("u1", "abc123");
    expect(a).toBe("wordcloud-files/u1/abc123.png");
    expect(wordcloudKey("u2", "abc123")).not.toBe(a);   // 换用户就换目录
    expect(wordcloudKey("u1", "def456")).not.toBe(a);   // 换内容就换文件
  });
});

describe("词云 · 归属与越界", () => {
  it("★ 没有身份读不到产物", async () => {
    expect(await readWordCloudFile("wordcloud-files/u1/x.png")).toBeNull();
    expect(await readWordCloudFile("wordcloud-files/u1/x.png", "")).toBeNull();
  });

  it("★ 别人的目录读不到(字符串里出现 uid 不算数, 必须整段前缀匹配)", async () => {
    for (const p of [
      "wordcloud-files/other/x.png",
      "wordcloud-files/u1-other/x.png",     // 前缀相似但用户不同
      "wordcloud-files/x.png",
    ]) expect(await readWordCloudFile(p, "u1")).toBeNull();
  });

  it("★ 上跳与嵌套路径读不到(拼不出 `../../` 式的越界)", async () => {
    for (const p of [
      "wordcloud-files/u1/../../secret.png",
      "wordcloud-files/u1/a/b.png",
      "wordcloud-files/u1/C:/windows/x.png",
    ]) expect(await readWordCloudFile(p, "u1")).toBeNull();
  });
});

describe("词云 · 空输入", () => {
  it("★ 没有 text / texts / frequencies → 直接报错, 不画一张空白图", async () => {
    const r = await getWordCloud("u1", {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/text|texts|frequencies/);
  });

  it("★ 缺用户身份 → 报错", async () => {
    const r = await renderWordCloud("", [{ word: "资本下乡", count: 3 }]);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("★ 词频表为空 → 报错, 不落到 Python", async () => {
    const r = await renderWordCloud("u1", []);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("空");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② Python 侧: 直接打脚本, 断言产物本身(与生产同一条 execFileSync 路径)
// ═══════════════════════════════════════════════════════════════════════════
function runScript(input: unknown): { dir: string; result: Record<string, unknown> } {
  const dir = mkdtempSync(path.join(tmpdir(), "wordcloud-test-"));
  writeFileSync(path.join(dir, "input.json"), JSON.stringify(input), "utf-8");
  try {
    execFileSync(PY, [SCRIPT, dir], { encoding: "utf-8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: "pipe" });
  } catch { /* python 侧异常也会写 result.json, 以文件为准 */ }
  const resultPath = path.join(dir, "result.json");
  const result = existsSync(resultPath)
    ? JSON.parse(readFileSync(resultPath, "utf-8")) as Record<string, unknown>
    : { ok: false, error: "没有 result.json" };
  return { dir, result };
}

const FREQS = [
  { word: "乡村治理", count: 42 }, { word: "资本下乡", count: 30 },
  { word: "乡村振兴战略", count: 25 }, { word: "土地流转", count: 18 },
  { word: "数字经济", count: 12 }, { word: "data", count: 9 },
];

describe.skipIf(!probe.ok)("wordcloud_render.py · 真出图", () => {
  it("★ 中文词频 → PNG, 尺寸与请求一致, 用的是中文字体", { timeout: 120_000 }, () => {
    const { dir, result } = runScript({ frequencies: FREQS, width: 600, height: 400, maxWords: 20 });
    try {
      expect(result.ok, String(result.error ?? "")).toBe(true);
      expect(result.width).toBe(600);
      expect(result.height).toBe(400);
      // 字体这条才是"中文没被画成豆腐块"的判据 —— 不给 font_path 时词云库会用默认英文字体
      expect(String(result.fontUsed)).toBe(probe.font);
      const png = readFileSync(path.join(dir, "output.png"));
      expect(png.length).toBeGreaterThan(1000);
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");   // PNG 魔数
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("★ 回传每个词的位置与字号(前端拿它做点击/悬停)", { timeout: 120_000 }, () => {
    const { dir, result } = runScript({ frequencies: FREQS, width: 500, height: 350, maxWords: 10 });
    try {
      expect(result.ok, String(result.error ?? "")).toBe(true);
      const words = result.words as Array<{ word: string; count: number; size?: number; x?: number; y?: number }>;
      expect(Array.isArray(words)).toBe(true);
      expect(words.length).toBeGreaterThan(0);
      const top = words.find((w) => w.word === "乡村治理");
      expect(top, "最高频的词没进结果").toBeTruthy();
      expect(top!.count).toBe(42);
      expect(top!.size).toBeGreaterThan(0);
      expect(top!.x).toBeGreaterThanOrEqual(0);
      expect(top!.y).toBeGreaterThanOrEqual(0);
      // 字号与词频同序: 词频最高的词字号必须最大
      const maxSize = Math.max(...words.map((w) => w.size ?? 0));
      expect(top!.size).toBe(maxSize);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("★ maxWords 是硬上限", { timeout: 120_000 }, () => {
    const { dir, result } = runScript({ frequencies: FREQS, maxWords: 3 });
    try {
      expect(result.ok, String(result.error ?? "")).toBe(true);
      const words = result.words as unknown[];
      expect(words.length).toBeLessThanOrEqual(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("★ 空词频 → 明确错误码, 不是一张空白图", { timeout: 120_000 }, () => {
    const { dir, result } = runScript({ frequencies: [] });
    try {
      expect(result.ok).toBe(false);
      expect(result.code).toBe("EMPTY_FREQUENCIES");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("★ 词频里的垃圾(空词/0/负数/非对象)被丢掉, 剩下的照常出图", { timeout: 120_000 }, () => {
    const { dir, result } = runScript({
      frequencies: [{ word: "  ", count: 5 }, { word: "资本下乡", count: 0 },
        { word: "乡村治理", count: -3 }, "不是对象", { word: "土地流转", count: 7 }],
    });
    try {
      expect(result.ok, String(result.error ?? "")).toBe(true);
      const words = result.words as Array<{ word: string }>;
      expect(words.map((w) => w.word)).toEqual(["土地流转"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("★ 指定不存在的字体 → 明确失败(MISSING_CJK_FONT 那条路)", { timeout: 120_000 }, () => {
    const { dir, result } = runScript({ frequencies: FREQS, fontPath: "C:/definitely/not/a/font.ttf" });
    try {
      // 显式给了坏路径时应当报错; 若实现改成静默回退默认字体, 这条会挂
      expect(result.ok).toBe(false);
      expect(result.code).toBe("MISSING_CJK_FONT");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "win32")(
    "★ 显式指定**纯拉丁字体**画中文 → 拒绝(它不报错, 只出一张空白图)",
    { timeout: 120_000 }, () => {
      // arial 没有汉字字形。词云库照常出图、不抛异常 —— 图上每个汉字都是空的。
      // 判据是"渲染该字 vs 渲染一个必定不存在的字符"位图相同(见脚本 font_has_cjk)。
      const { dir, result } = runScript({ frequencies: FREQS, fontPath: "C:/Windows/Fonts/arial.ttf" });
      try {
        expect(result.ok).toBe(false);
        expect(result.code).toBe("MISSING_CJK_FONT");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

  it("★ 纯英文词云不强制要求中文字体(没装 CJK 字体的机器也要能用)", { timeout: 120_000 }, () => {
    const { dir, result } = runScript({
      frequencies: [{ word: "rural", count: 5 }, { word: "governance", count: 3 }],
    });
    try {
      expect(result.ok, String(result.error ?? "")).toBe(true);
      expect(readFileSync(path.join(dir, "output.png")).length).toBeGreaterThan(500);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("★ 超大画布被夹到上限(请求体直通, 不夹会申请巨量内存)", { timeout: 120_000 }, () => {
    const { dir, result } = runScript({ frequencies: FREQS, width: 99999, height: 99999 });
    try {
      expect(result.ok, String(result.error ?? "")).toBe(true);
      expect(result.width).toBe(2000);
      expect(result.height).toBe(2000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("★ 自定义配色与背景真的落到图上了(不是只接了参数)", { timeout: 120_000 }, () => {
    const { dir, result } = runScript({
      frequencies: FREQS, width: 400, height: 300,
      background: "#112233", colors: ["#ff0000", "#00ff00"],
    });
    try {
      expect(result.ok, String(result.error ?? "")).toBe(true);
      const png = readFileSync(path.join(dir, "output.png"));
      expect(png.length).toBeGreaterThan(500);
      // 背景色出现在 PNG 里(未压缩的 RGBA 左顶点)—— 图是空的/用的是默认白底时会不匹配
      const mm = execFileSync(PY, ["-c",
        "from PIL import Image;im=Image.open(r'" + path.join(dir, "output.png").replace(/\\/g, "/") + "');print(im.convert('RGB').getpixel((0,0)))"],
        { encoding: "utf-8", timeout: 60_000, windowsHide: true }).trim();
      expect(mm).toBe("(17, 34, 51)");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 端到端: 文本 → 词频 → 词云(走服务层, 与路由同一条路)
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!probe.ok)("getWordCloud · 文本进 图出", { timeout: 120_000 }, () => {
  const TEXT = [
    "乡村振兴战略以乡村治理为基础。资本下乡改变乡村治理格局。土地流转是乡村治理的关键环节。",
    "资本下乡与土地流转相互促进, 乡村治理因此转型。乡村振兴战略要求资本下乡规范有序。",
    "土地流转推动乡村振兴战略落地。乡村治理需要资本下乡与土地流转协同。",
  ];

  it("★ 中文文本 → 图 + 词频, 且词频来自与图谱同一套分词(词云最大的词能在图谱里找到)", async () => {
    const r = await getWordCloud("test-user", { texts: TEXT, width: 500, height: 350, maxWords: 10 });
    expect(r.ok, String(r.error ?? "")).toBe(true);
    expect(r.lang).toBe("zh");
    expect(r.imageBase64?.startsWith("data:image/png;base64,")).toBe(true);
    expect(r.fontUsed).toBe(probe.font);
    const words = r.words ?? [];
    expect(words.length).toBeGreaterThan(0);
    // 词云按"画布上的字号"排, **不是**按词频排(长词的字号自带一个长度因子) ——
    // 所以断言"词频最高的词是谁", 而不是"谁排在结果第 0 位"。
    const byCount = [...words].sort((a, b) => b.count - a.count);
    expect(byCount[0].word).toBe("乡村治理");
    // ★ 分词口径若漂移(比如退回 `[一-龥]{2,6}` 一刀切, 或让一次性长片段进词表),
    //   这几个真词会被长片段顶掉 —— 那才是这条用例真正在盯的东西
    const ws = words.map((w) => w.word);
    for (const w of ["乡村治理", "资本下乡", "土地流转", "乡村振兴战略"]) expect(ws).toContain(w);
    // 长片段(跨词/整句)不该出现
    for (const w of ws) expect(w.length).toBeLessThanOrEqual(6);
  });

  it("产物真的落了盘, 且能用返回的 key 读回来(与 viz 产物同一套 blob-store)", async () => {
    const r = await getWordCloud("test-user", { texts: TEXT, width: 400, height: 300, maxWords: 5 });
    expect(r.ok, String(r.error ?? "")).toBe(true);
    expect(r.imageRel).toBeTruthy();
    const back = await readWordCloudFile(r.imageRel!, "test-user");
    expect(back).not.toBeNull();
    expect(back!.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("★ 直接给词频表也能画(不强制走文本抽取)", async () => {
    const r = await getWordCloud("test-user", { frequencies: FREQS, width: 400, height: 300, maxWords: 6 });
    expect(r.ok, String(r.error ?? "")).toBe(true);
    expect(r.lang).toBeUndefined();          // 没给文本 → 没判过语言, 就不编一个出来
    expect((r.words ?? []).length).toBeGreaterThan(0);
  });

  it("★ 英文文本走英文管线(词形还原生效, 中文图那套不会串过来)", async () => {
    const r = await getWordCloud("test-user", {
      texts: ["Rural governance and rural institutions. Rural capital shapes rural governance."],
      width: 400, height: 300, maxWords: 10,
    });
    expect(r.ok, String(r.error ?? "")).toBe(true);
    expect(r.lang).toBe("en");
    // rural 出现 4 次、governance 2 次 —— 若走了中文管线会一个词都抽不出来
    const words = (r.words ?? []).map((w) => w.word);
    expect(words).toContain("rural");
    expect(words.some((w) => /[一-鿿]/.test(w))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 不可用时的行为(与上面 skipIf 相反的一面): 给出**可执行的**提示, 不是静默成功
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(probe.ok)("wordcloud_render.py · 依赖缺失时的报错", () => {
  it("★ 没装库/没字体 → 明确错误, 且提示怎么装(不是超时或空白结果)", () => {
    const { dir, result } = runScript({ frequencies: FREQS });
    try {
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/wordcloud|字体|font/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
