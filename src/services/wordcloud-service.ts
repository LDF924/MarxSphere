// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// wordcloud-service.ts — 词云(文本/词频表 → PNG base64 + 词频数据)
//
// 由来: 旧平台有 save_wordcloud 这条能力, 本仓没有(grep 词云/wordcloud = 0)。这里补上,
//   并刻意把"词频从哪来"接到 keyword-network-service 的同一个入口 —— 词云里最大的词
//   必须能在共现图谱里找到, 否则用户会当 bug 报(两处各写一套分词, 一定会漂移)。
//
// 三条设计上的取舍:
//   ① **中文字体**: 词云库不给 font_path 时用默认英文字体, 中文全画成豆腐块 ——
//      图能出来、不报错、看着还挺像回事, 是典型的"假成功"。所以 python 侧找不到中文字体
//      时**直接失败**, 而不是出一张方块图(scripts/wordcloud_render.py 的 MISSING_CJK_FONT)。
//   ② **词位回传**: 只给一张 PNG, 图上的词就是死的(点不了、悬停不了)。python 侧回传
//      layout_(每个词的字号/坐标/旋转角), 这里原样透出给前端。
//   ③ **产物落盘走 blob-store**: 与 viz/empirical 同一套(viz-exec-service.ts 的持久化范式),
//      本地盘/共享卷/对象存储三种部署形态同一套代码。
import "dotenv/config";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { putObject, getObject } from "./blob-store.js";
import { resolvePython } from "./py-path.js";
import { extractCorpusKeywords, detectCorpusLang, type KeywordHit, type Lang } from "./keyword-network-service.js";

const RUNNER = path.join(process.env.SAG_ROOT || process.cwd(), "scripts", "wordcloud_render.py");
const TASKS_DIR = path.join(os.tmpdir(), "wordcloud-tasks");
const TIMEOUT_MS = 120_000;

function pythonBin(): string {
  return resolvePython({ envKeys: ["EMPIRICAL_PYTHON", "COGNEE_PYTHON"] });
}

export interface WordCloudOptions {
  width?: number;
  height?: number;
  maxWords?: number;
  background?: string;
  colormap?: string;
  colors?: string[];
  fontPath?: string;
  randomState?: number;
  preferHorizontal?: number;
  minFontSize?: number;
  maxFontSize?: number;
}

export interface WordCloudWord {
  word: string;
  count: number;
  size?: number;
  x?: number;
  y?: number;
  rotation?: number;
}

export interface WordCloudResult {
  ok: boolean;
  error?: string;
  /** `png:` 前缀 + base64 —— 前端可直接塞 <img src>。同时给了 imageRel, 大图优先用它 */
  imageBase64?: string;
  /** blob-store 里的相对路径(与 viz 产物同一套), 大图走它省传输 */
  imageRel?: string;
  width?: number;
  height?: number;
  fontUsed?: string;
  lang?: Lang;
  /** 走过后备路径时的说明(如"文本较短, 词频门槛已降档") —— 让降档不是隐形的 */
  note?: string;
  words?: WordCloudWord[];
}

/** 兼容两种入参形态: 直接给词频表, 或给文本(这里抽词) */
export interface WordCloudInput extends WordCloudOptions {
  text?: string;
  /** 多篇文本 —— 词频按**整批一份**统计(见 extractCorpusKeywords) */
  texts?: string[];
  frequencies?: KeywordHit[];
  lang?: Lang;
  topK?: number;
  /** 词频低于此不进词云。默认 2(与图谱一致) —— 它会同时决定词表, 见 extractCorpusKeywords */
  minCount?: number;
  stopwords?: string[];
}

export function toBase64(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString("base64")}`;
}

/** 产物 key: 与 viz 一样按用户分目录; 内容 hash 做文件名, 同参数重跑不会堆垃圾 */
export function wordcloudKey(userId: string, contentHash: string): string {
  return `wordcloud-files/${userId}/${contentHash}.png`;
}

function runPython(taskDir: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(pythonBin(), [RUNNER, taskDir], {
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      cwd: process.env.SAG_ROOT || process.cwd(),
    }, () => {
      // 不看退出码: python 侧任何异常都会写 result.json(见脚本兜底), 有结果文件就以它为准;
      // 没有才是真的崩了/超时了。
      const resultPath = path.join(taskDir, "result.json");
      if (existsSync(resultPath)) {
        try {
          const r = JSON.parse(readFileSync(resultPath, "utf-8")) as { ok?: boolean; error?: string };
          resolve(r.ok ? { ok: true } : { ok: false, error: r.error ?? "渲染失败" });
          return;
        } catch { /* 解析失败走下面 */ }
      }
      resolve({ ok: false, error: "Python 执行无结果(超时/崩溃/未安装 wordcloud)" });
    });
  });
}

/** 词云库装没装 + 有没有中文字体 —— 让调用方(与测试)能提前跳过, 而不是等渲染失败 */
export async function wordcloudAvailable(): Promise<{ ok: boolean; font?: string; version?: string; error?: string }> {
  if (!existsSync(RUNNER)) return { ok: false, error: "缺少 scripts/wordcloud_render.py" };
  return await new Promise((resolve) => {
    execFile(pythonBin(), [RUNNER, "--selfcheck"], {
      timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
    }, (err, stdout) => {
      if (err) { resolve({ ok: false, error: String(err.message).slice(0, 200) }); return; }
      try {
        const r = JSON.parse(String(stdout).trim().split(/\r?\n/).pop() ?? "{}");
        resolve({ ok: Boolean(r.ok), font: r.font, version: r.version, error: r.error });
      } catch {
        resolve({ ok: false, error: "自检输出无法解析" });
      }
    });
  });
}

/**
 * 一份词频表 → 词云 PNG(+ 每个词的位置)。
 * 这是**唯一**和 Python 说话的地方; 上层的 getWordCloud 负责把文本变成词频。
 */
export async function renderWordCloud(
  userId: string,
  frequencies: KeywordHit[],
  opts: WordCloudOptions = {},
): Promise<WordCloudResult> {
  if (!userId) return { ok: false, error: "缺少用户身份" };
  if (!frequencies.length) return { ok: false, error: "词频为空: 没有可画的词" };

  const taskId = randomUUID();
  const taskDir = path.join(TASKS_DIR, taskId);
  mkdirSync(taskDir, { recursive: true });
  try {
    writeFileSync(path.join(taskDir, "input.json"),
      JSON.stringify({ frequencies, ...opts }), "utf-8");
    const r = await runPython(taskDir);
    if (!r.ok) return { ok: false, error: r.error };

    const resultPath = path.join(taskDir, "result.json");
    const meta = JSON.parse(readFileSync(resultPath, "utf-8")) as {
      width: number; height: number; fontUsed: string; words: WordCloudWord[];
    };
    const pngPath = path.join(taskDir, "output.png");
    if (!existsSync(pngPath)) return { ok: false, error: "Python 未产出 output.png" };
    const png = readFileSync(pngPath);

    // 内容 hash 做 key: 同一批词频重跑落同一个对象, 不会每点一次就多一份图
    const hash = createHash("sha256").update(png).digest("hex").slice(0, 16);
    const key = wordcloudKey(userId, hash);
    await putObject(key, png);

    return {
      ok: true,
      imageBase64: toBase64(png),
      imageRel: key,
      width: meta.width, height: meta.height,
      fontUsed: meta.fontUsed, words: meta.words,
    };
  } catch (e) {
    return { ok: false, error: `词云任务失败: ${String(e).slice(0, 160)}` };
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
}

/** 文本/词频表 → 词云 的统合入口(路由与 Agent 直接用这个) */
export async function getWordCloud(userId: string, input: WordCloudInput): Promise<WordCloudResult> {
  let frequencies = input.frequencies ?? [];
  let lang = input.lang;
  /** 降档重试的说明, 随结果一起返回 —— 别让"用了更松的阈值"变成看不见的行为 */
  let note = "";
  if (frequencies.length === 0) {
    const texts = input.texts?.length ? input.texts : (input.text ? [input.text] : []);
    if (texts.length === 0) return { ok: false, error: "需要 text / texts / frequencies 之一" };
    // 未指定语言时按语料判: 中文语料用中文停用词与分词, 英文同理 —— 判错会让词云里全是噪声
    const picked: Lang = lang ?? detectCorpusLang(texts.join(""));
    lang = picked;
    const topK = input.topK ?? 120;
    const wantedMinCount = input.minCount ?? 2;
    frequencies = extractCorpusKeywords(texts, picked, {
      topK, stopwords: input.stopwords, minCount: wantedMinCount,
    });
    /**
     * 空结果时**降档重试一次**(minCount 2 → 1)。
     *
     * 由来(2026-10-01 真机冒烟): 用户粘一段 100 字的正常中文段落, 抽出来是空的,
     *   报"文本里没有提取到关键词(全是停用词?)" —— 而那段话里明明有
     *   「农村集体经济」「乡村振兴」这些词。实测同一段: minCount=2 → 2 个词,
     *   minCount=1 → 9 个词。默认 2 是为了压掉单次出现的碎片(见 extractCorpusKeywords 注释),
     *   但对**短文本是致命的** —— 短文本里每个词本来就只出现一两次。
     *
     * 降档只在"本来会失败"时发生, 且把发生过的降档写进 note:
     *   宁可给一张有噪声的图并说明, 也别给一句"没有关键词"让用户对着正常文本发呆。
     */
    if (frequencies.length === 0 && wantedMinCount > 1) {
      frequencies = extractCorpusKeywords(texts, picked, {
        topK, stopwords: input.stopwords, minCount: 1,
      });
      if (frequencies.length > 0) {
        note = `文本较短, 已把词频门槛从 ${wantedMinCount} 降到 1 才取到词（可能有少量只出现一次的词）`;
      }
    }
    if (frequencies.length === 0) {
      return { ok: false, error: "文本里没有提取到关键词（可能是纯符号/数字，或全被停用词过滤了）" };
    }
  }
  const r = await renderWordCloud(userId, frequencies, input);
  return { ...r, lang, ...(note ? { note } : {}) } as WordCloudResult;
}

/**
 * 读取词云产物(鉴权后由路由调用): 只允许读本用户 wordcloud-files/ 下的对象。
 *
 * ⚠ 别照抄 viz-exec-service.readVizFile 的 `marker = "/viz-files/<uid>/"`(带前导斜杠):
 *   那边能work是因为库里的历史行带了 `data/` 前缀, 斜杠是 data 与 viz-files 之间的那个。
 *   这里的 key 由 wordcloudKey() 现写(无前缀), 同一个写法会 indexOf 恒 -1 ——
 *   表现是"产物明明写进去了, 读却永远读不到"(实测踩过)。
 */
export async function readWordCloudFile(relPath: string, userId?: string): Promise<Buffer | null> {
  if (!userId) return null;
  const clean = relPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.\./g, "");
  const marker = `wordcloud-files/${userId}/`;
  const idx = clean.indexOf(marker);
  if (idx < 0) return null;
  const name = clean.slice(idx + marker.length);
  // 只接受单层文件名, 不允许再带路径分隔或盘符
  if (!name || name.includes("/") || name.includes(":")) return null;
  return getObject(`${marker}${name}`);
}
