// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// ppt-script-service.ts — PPT 生成工作台 ② 脚本阶段(每页要点 + 讲稿备注)
//
// 由来: 旧项目 AItoolman M9 的脚本阶段把"页面上的字"与"嘴里说的话"分开产出 ——
//   同一页既有 bullets(打在屏幕上, 越短越好), 也有 notes(讲稿, 越长越自然)。
//   本项目此前**没有**任何地方产出讲稿: `paper-outline-service` 只把大纲正文按
//   句号切成要点塞进 pptx, 出来的稿子能看但不能讲。
//
// ⚠ 中文演示文稿的断行与缩略是这个文件的核心, 不是附属品:
//   · 屏幕上一条要点超过 ~30 个汉字, 18pt 下会折成三行, 一页超过 6 条就溢出;
//   · 中文没有词间空格, 按"字数"截断会把"资本下乡"截成"资本下" + "乡…";
//   · 标题里的书名号/引号/冒号在目录页会撑得很难看。
//   所以这里有一整套**按标点边界**的缩略(clipSmart)与要点规范化(normalizeBullets),
//   而不是简单的 slice。
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";
import type { PptOutlinePage, PptPageKind } from "./ppt-outline-service.js";
import { BULLETS_MAX } from "./ppt-outline-service.js";

export interface PptPageScript {
  seq: number;
  kind: PptPageKind;
  title: string;
  bullets: string[];
  notes: string;
  /** 这一页的建议配图描述(给配图阶段当 prompt)。空 = 建议不配图 */
  imagePrompt: string;
  /** 这页是不是降级出来的(模型没出活) —— 与大纲阶段的 degraded 同一个口径 */
  degraded: boolean;
}

/** 屏幕上一条要点的长度上限(汉字计)。超过就该拆页或缩短 */
export const BULLET_SOFT_MAX = 30;
/** 中文演示的语速: 每分钟多少字(讲稿时长估算用), 学术报告偏慢 */
const CJK_PER_MINUTE = 200;

const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/;

/** 按码点数长度(代理对算一个) */
function len(s: string): number {
  return [...s].length;
}

function isCjk(ch: string): boolean {
  return CJK.test(ch);
}

/**
 * 中英混排的"视觉长度": 汉字算 1, 其它算 0.5。
 * 屏幕上"20 个汉字"与"40 个字母"占的宽度差不多 —— 按码点数一刀切会两头都不对。
 */
export function visualLen(s: string): number {
  let n = 0;
  for (const ch of String(s ?? "")) n += isCjk(ch) ? 1 : 0.5;
  return n;
}

/**
 * 按**标点边界**缩略中文句子。
 *
 * 为什么不能用 slice: "资本下乡对村集体收入的影响机制研究" 截到 14 字是
 *   "资本下乡对村集体收入的影响机" —— 读起来是断的。这里优先在最近的分句标点
 *   (、，；。：) 处断, 断不了才硬切并加省略号。
 */
export function clipSmart(s: unknown, max: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (visualLen(t) <= max) return t;
  const chars = [...t];
  // 先找标点: 从 max 处往前找最近的一个分句符(位置不早于 60% 处, 否则切得太短)
  const floor = Math.floor(max * 0.6);
  for (let i = Math.min(chars.length - 1, Math.floor(max)); i >= floor; i--) {
    if ("、，；。：,;.".includes(chars[i])) {
      const head = chars.slice(0, i).join("").replace(/[、，；。：,;.\s]+$/, "");
      if (visualLen(head) >= floor) return head;
    }
  }
  // 退而求其次: 硬切 + 省略号。省略号本身也占位, 所以留 1 个字的余量
  let acc = 0;
  const out: string[] = [];
  for (const ch of chars) {
    const w = isCjk(ch) ? 1 : 0.5;
    if (acc + w > max - 1) break;
    out.push(ch);
    acc += w;
  }
  return out.join("") + "…";
}

/** 去掉只在讲稿里有意义、打在屏幕上纯占地方的开头 */
const CONNECTIVE_HEAD = /^(首先|其次|再次|然后|接着|最后|总之|综上(所述)?|第一|第二|第三|第四|第五|其一|其二|其三|另外|此外|而且|因此|所以|由此|即|就是说)[,，、:：\s]*/;

/**
 * 要点规范化 —— 屏幕上的字。
 *
 * 三件事: 去掉"首先/其次"这类连接词(它们属于讲稿)、去掉句末句号(要点不是句子)、
 * 超长按标点缩略。**不做**的是"把两条合成一条" —— 那属于内容决策, 该由模型或用户做。
 */
export function normalizeBullets(raw: unknown, maxBullets: number, maxLen = BULLET_SOFT_MAX): string[] {
  const arr = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    let t = typeof v === "object" && v ? String((v as Record<string, unknown>).text ?? "") : String(v ?? "");
    t = t.replace(/\s+/g, " ").trim();
    if (!t) continue;
    const stripped = t.replace(CONNECTIVE_HEAD, "");
    t = stripped || t;
    t = t.replace(/[。.]+$/, "");
    t = clipSmart(t, maxLen);
    // 去重: 模型很爱把同一句话换个说法写两遍(实测), 屏幕上看着就是复读
    const key = t.replace(/[、，；。：,;.\s]/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= Math.min(BULLETS_MAX, Math.max(1, maxBullets))) break;
  }
  return out;
}

/**
 * 讲稿备注的规范化。
 *
 * 讲稿**不做**缩略 —— 那是给人念的, 越自然越好。只做: 去掉 markdown 记号
 * (它是幻灯片备注, 不是文档)、去掉"以下是讲稿"这类元话语、超长才截。
 */
export function normalizeNotes(raw: unknown, maxLen = 400): string {
  let t = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!t) return "";
  t = t.replace(/^```[\s\S]*?\n/, "").replace(/\n```\s*$/, "");
  t = t.replace(/^#+\s*/gm, "");              // markdown 标题记号
  t = t.replace(/\*\*(.+?)\*\*/g, "$1");      // 加粗
  t = t.replace(/^(以下是|这是)?(本页)?(讲稿|备注|演讲词)[:：]?\s*/m, "");
  if (len(t) > maxLen) t = [...t].slice(0, maxLen).join("") + "…";
  return t.trim();
}

/** 讲稿读一遍要多久(秒)。界面上的"这段讲多久"用它 */
export function estimateSpeakSeconds(text: string): number {
  return Math.round((visualLen(String(text ?? "").replace(/\s/g, "")) / CJK_PER_MINUTE) * 60);
}

/** 降级: 没模型时从大纲直接造出一页的脚本(要点原样, 讲稿由要点拼) */
export function fallbackPageScript(page: PptOutlinePage, maxBullets: number): PptPageScript {
  const bullets = normalizeBullets(page.bullets, maxBullets);
  const notes = normalizeNotes(
    bullets.length
      ? `这一页讲「${page.title}」。依次说清: ${bullets.join("；")}。`
      : `这一页是「${page.title}」, 口头过渡到下一节。`);
  return {
    seq: page.seq, kind: page.kind, title: page.title,
    bullets, notes,
    imagePrompt: suggestImagePrompt(page.title, bullets),
    degraded: true,
  };
}

/**
 * 从页面内容**推导**一个配图描述。
 *
 * 为什么要有它: 配图阶段的主路径是让模型给出 imagePrompt(见 generatePageScript),
 *   但模型失败/降级时若 imagePrompt 为空, 配图阶段就完全无图可配 —— 而"推导一个"
 *   与"没有"的差别很大(哪怕只是背景图)。推导规则刻意保守: 只输出**能画出来**的
 *   版式类描述(示意图/时间线/对比), 不写"一张展现乡村振兴的宏大照片"这类空话。
 */
export function suggestImagePrompt(title: string, bullets: string[]): string {
  const t = String(title ?? "");
  const n = bullets.length;
  if (/对比|比较|异同|差别/.test(t)) return `${t}: 左右对比示意图, 两组要素并列`;
  if (/流程|步骤|路径|机制|过程/.test(t)) return `${t}: 横向流程示意图, ${Math.max(2, Math.min(5, n))} 个环节`;
  if (/时间|阶段|演进|历史|脉络/.test(t)) return `${t}: 时间轴示意图`;
  if (/数据|统计|趋势|增长|比例/.test(t)) return `${t}: 数据示意图(柱形/折线)`;
  if (/结构|框架|体系|层次/.test(t)) return `${t}: 层级结构示意图`;
  return `${t}: 条块示意版式, ${Math.max(2, Math.min(5, n))} 个要点分块`;
}

function buildPagePrompt(page: PptOutlinePage, topic: string, maxBullets: number, neighbors: string[]): string {
  return `你在为一份中文演示文稿写**单页脚本**。整份演示的主题是「${topic}」。

这一页:
  页型: ${page.kind}
  标题: ${page.title}
  现有要点(可能为空): ${JSON.stringify(page.bullets)}
  ${neighbors.length ? `上下文的其他页标题: ${neighbors.join(" / ")}` : ""}

请产出这一页的:
1. bullets —— **打在屏幕上的**要点, 最多 ${maxBullets} 条。每条 **${BULLET_SOFT_MAX} 个汉字以内**,
   是短句不是段落; 不要"首先/其次/最后"这类连接词(它们属于讲稿);
   不要句末句号。**中文演示文稿的写法**: 名词短语优先, 能用 8 个字说清就不用 10 个。
2. notes —— **讲稿**(讲给人听的), 60-150 字, 口语化, 说明这一页你要强调什么、怎么过渡到下一页。
   它不会出现在屏幕上, 所以可以展开, 可以有"这里我想强调的是…"。
3. imagePrompt —— 这一页配图的**可画描述**(30 字内), 例如"横向流程示意图, 4 个环节"。
   若这一页不适合配图(如封面/纯过渡), 给空字符串。
${page.kind === "cover" || page.kind === "end" || page.kind === "toc" ? "注意: 封面/目录/结束页 bullets 给空数组, 只写 notes。" : ""}

只输出 JSON: {"bullets":["…"],"notes":"…","imagePrompt":"…"}`;
}

export interface GeneratePageScriptInput {
  page: PptOutlinePage;
  topic: string;
  maxBullets: number;
  /** 同一份稿子里其它页的标题(给模型上下文, 免得每页都从"背景"讲起) */
  neighborTitles?: string[];
  /** 注入缝: 测试用 */
  callJson?: (prompt: string, maxTokens: number) => Promise<unknown>;
}

/** 生成**单页**脚本 —— 单页重生就是再调一次它(见 ppt-workbench-service.regenPage) */
export async function generatePageScript(input: GeneratePageScriptInput): Promise<PptPageScript> {
  const { page } = input;
  const maxBullets = Math.min(BULLETS_MAX, Math.max(1, Math.round(input.maxBullets) || 5));
  const call = input.callJson ?? defaultCallJson;
  let raw: unknown = null;
  try {
    raw = await call(buildPagePrompt(page, input.topic, maxBullets, input.neighborTitles ?? []), 1600);
  } catch {
    return fallbackPageScript(page, maxBullets);   // 失败即降级, 不抛: 一页失败不该让整份稿子停住
  }
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bulletsRaw = obj.bullets ?? obj.points;
  const bullets = normalizeBullets(bulletsRaw, maxBullets);
  const notes = normalizeNotes(obj.notes ?? obj.speakerNotes);
  if (!bullets.length && !notes) return fallbackPageScript(page, maxBullets);
  // 封面/目录/结束页强制无要点 —— 模型偶尔会给它们编要点(实测),
  //   而"目录页上列 3 条要点"在版面上会和目录条目打架
  const isSpecial = page.kind === "cover" || page.kind === "toc" || page.kind === "end";
  return {
    seq: page.seq,
    kind: page.kind,
    title: page.title,
    bullets: isSpecial ? [] : bullets,
    notes: notes || fallbackPageScript(page, maxBullets).notes,
    imagePrompt: isSpecial ? "" : String(obj.imagePrompt ?? "").replace(/\s+/g, " ").trim().slice(0, 60)
      || (page.kind === "content" ? suggestImagePrompt(page.title, bullets) : ""),
    degraded: false,
  };
}

async function defaultCallJson(prompt: string, maxTokens: number): Promise<unknown> {
  const ep = getLlmEndpoint({ model: getRoleModel("editor") });
  if (!ep.key) throw new Error("未配置 LLM API Key");
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: prompt + "\n\n只输出 JSON，不要其他文字。" }],
    temperature: 0.5,
    maxTokens,
    timeoutMs: 180_000,
  });
  if (!res?.text) return null;
  return parseLlmJson(res.text);
}

/**
 * 批量生成脚本(整个任务一次跑完)。
 *
 * `onPage` 每完成一页回调一次 —— 工作台据此**边跑边落库**: 长任务中途死掉时,
 *   已经写完的页留在库里, 恢复时不必从第一页重来(旧项目的
 *   m9_save_job_state / m9_recover_m9_page_result 要解决的正是这件事)。
 * `shouldStop` 让调用方能在任务被取消/服务要关时体面停下, 而不是等 40 页跑完。
 */
export async function generateScriptBatch(input: {
  pages: PptOutlinePage[];
  topic: string;
  maxBullets: number;
  concurrency?: number;
  onPage?: (script: PptPageScript, index: number) => Promise<void> | void;
  shouldStop?: () => boolean | Promise<boolean>;
  callJson?: GeneratePageScriptInput["callJson"];
}): Promise<{ scripts: PptPageScript[]; stopped: boolean }> {
  const pages = input.pages;
  const titles = pages.map((p) => p.title);
  const concurrency = Math.min(4, Math.max(1, Math.round(input.concurrency ?? 3)));
  const results: Array<PptPageScript | null> = new Array(pages.length).fill(null);
  let cursor = 0;
  let stopped = false;

  const worker = async () => {
    for (;;) {
      if (stopped) return;
      if (input.shouldStop && await input.shouldStop()) { stopped = true; return; }
      const i = cursor++;
      if (i >= pages.length) return;
      const s = await generatePageScript({
        page: pages[i], topic: input.topic, maxBullets: input.maxBullets,
        // 邻居标题给 3 条: 太多会把 prompt 撑大, 太少(1 条)模型容易与上一页重复
        neighborTitles: titles.slice(Math.max(0, i - 2), i + 2),
        callJson: input.callJson,
      });
      results[i] = s;
      if (input.onPage) await input.onPage(s, i);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { scripts: results.filter((s): s is PptPageScript => s !== null), stopped };
}
