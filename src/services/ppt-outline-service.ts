// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// ppt-outline-service.ts — PPT 生成工作台 ① 大纲阶段
//
// 由来: 旧项目 AItoolman 的 M9(全项目最大模块, 111 个函数)把大纲当成**可编辑的中转物** ——
//   生成一份骨架 → 用户在界面上增删页/改标题/调顺序/改页数 → 再进入脚本阶段。
//   本项目此前只有 `paper-outline-service.exportOutlinePptx`: 论文大纲一键导出,
//   没有"先出一份演示稿大纲、改完再往下走"这一步。
//
// 这个文件只做**大纲**: 出页、改页、估页数、裁要点。文案由 LLM 出, 页数/要点数的
//   硬约束由本文件兜(见 normalizeOutline) —— 演示稿的失败大多不是"文案不好",
//   而是"一页塞了 12 条要点", 那种稿子讲不了。
//
// ⚠ 与旧项目的差别: 旧项目的 page 对象里带了一堆渲染态字段(z_order/width/height/…),
//   因为它把 PPT 的绝对定位直接当成数据模型。这里**只存内容**(kind/title/bullets/notes),
//   版面交给 ppt_render.py 按主题算 —— 否则改一次版式就要迁移一次数据。
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";

/** 页型。cover/toc/section/content/end 与 ppt_pages.kind 的 check 约束一一对应 */
export type PptPageKind = "cover" | "toc" | "section" | "content" | "end";

export interface PptOutlinePage {
  seq: number;
  kind: PptPageKind;
  title: string;
  bullets: string[];
  notes: string;
}

export interface PptOutline {
  title: string;
  subtitle: string;
  pages: PptOutlinePage[];
  /** 页数是怎么来的(+ 是否被上/下限夹过), 让界面能解释"为什么不是我要的 15 页" */
  pageCountNote: string;
  /**
   * 大纲是不是**降级**来的(LLM 没出活, 用模板骨架兜的)。
   * 必须显式带出来 —— 与配图的 imageSource 同一个道理: 用户有权知道手上这份
   * 稿子是模型写的还是骨架拼的, 不然会按"AI 生成"的预期去用。
   */
  degraded: boolean;
  degradeReason: string;
}

export const PAGE_MIN = 3;
export const PAGE_MAX = 60;
export const BULLETS_MIN = 1;
export const BULLETS_MAX = 8;

/** 一页标题的长度上限(汉字按 1 计)。超了界面上就换行成两行, 目录页也会撑破 */
const TITLE_MAX = 28;
const SUBTITLE_MAX = 40;
const BULLET_MAX = 60;

function clip(s: unknown, n: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  // 按**码点**裁: [...t] 才能正确切开代理对, t.slice 会把 emoji 劈成半个
  const arr = [...t];
  return arr.length <= n ? t : arr.slice(0, n).join("");
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * 把 LLM 产出的大纲收进**可用的形状**。
 *
 * 为什么必须有这一步(而不是信模型): 演示稿的三个硬约束都不是"风格问题" ——
 *   · 页数: 3 页以下不成演示, 60 页以上没人讲;
 *   · 每页要点: 超过 8 条时 13.33 英寸宽的版面一定溢出(实测 18pt 下装 6-7 条);
 *   · 首末页: 没有封面/结束页的稿子看着像半成品。
 * 模型偶尔会漏掉其中一条, 而漏掉的表现是"能用但很差", 不会报错。
 */
export function normalizeOutline(
  raw: unknown,
  opts: { topic: string; wantPages?: number; maxBullets: number },
): PptOutline {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const maxBullets = Math.min(BULLETS_MAX, Math.max(BULLETS_MIN, Math.round(opts.maxBullets) || 5));
  // ⚠ 只有**明确给了**页数才夹到 [PAGE_MIN, PAGE_MAX]。
  //   先写成无条件 `Math.max(PAGE_MIN, want)` 时, "没指定页数"(0) 会被夹成 3,
  //   于是下面裁页的分支把一份 6 页的大纲砍到 3 页 —— 而调用方根本没要求页数。
  //   实测症状: 大纲只剩封面/目录/结束页, 所有正文页消失。
  const rawWant = Math.round(opts.wantPages ?? 0) || 0;
  const want = rawWant > 0 ? Math.min(PAGE_MAX, Math.max(PAGE_MIN, rawWant)) : 0;

  const rawPages = asArray(obj.pages).filter((p) => p && typeof p === "object") as Array<Record<string, unknown>>;
  const pages: PptOutlinePage[] = [];
  let seq = 10;

  for (const p of rawPages) {
    const kindRaw = String(p.kind ?? "").toLowerCase();
    const kind: PptPageKind =
      kindRaw === "cover" || kindRaw === "toc" || kindRaw === "section" || kindRaw === "end"
        ? (kindRaw as PptPageKind)
        : "content";
    const title = clip(p.title ?? p.name, TITLE_MAX);
    if (!title) continue; // 无标题的页一律丢弃: 它在界面上没法选、也没法改
    const bullets = asArray(p.bullets ?? p.points ?? p.items)
      .map((b) => clip(typeof b === "object" && b ? (b as Record<string, unknown>).text ?? "" : b, BULLET_MAX))
      .filter((b) => b.length > 0)
      // 目录/封面/结束页不需要要点(目录由 render 从正文页标题现算)
      .slice(0, kind === "content" || kind === "section" ? maxBullets : 2);
    pages.push({ seq: (seq += 10), kind, title, bullets, notes: clip(p.notes ?? p.speakerNotes ?? "", 400) });
  }

  // 首末页补齐(只在真缺的时候)
  if (!pages.length || pages[0].kind !== "cover") {
    pages.unshift({ seq: 0, kind: "cover", title: clip(obj.title ?? opts.topic, TITLE_MAX), bullets: [], notes: "" });
  }
  if (pages[pages.length - 1].kind !== "end") {
    pages.push({ seq: 0, kind: "end", title: "谢谢", bullets: [], notes: "" });
  }

  // 目录页: 有正文页就得有目录, 否则"目录页"这条能力形同不存在
  const hasToc = pages.some((p) => p.kind === "toc");
  const contentCount = pages.filter((p) => p.kind === "content" || p.kind === "section").length;
  if (!hasToc && contentCount >= 3) {
    const at = Math.min(1, pages.length - 1);
    pages.splice(at, 0, { seq: 0, kind: "toc", title: "目录", bullets: [], notes: "" });
  }

  // 页数: want 指"总页数"。只在**有正文页**的前提下裁或提示 —— 裁掉封面/结束页
  //   会让稿子直接不成样子, 所以裁的是中间那些 kind=content 的页。
  //
  // ⚠ 硬上限**先执行**: 模型有时会吐回 200 页(实测), 而用户要的是"一份讲得完的稿子"。
  //   夹不夹 want 都得上限 —— 上限是**安全阀**(PAGE_MAX), 下限 (PAGE_MIN) 只是建议,
  //   把"没指定页数"也按下限处理会反过来把一份 6 页的大纲砍成 3 页。
  if (pages.length > PAGE_MAX) {
    // 裁的优先级: 正文页 → 章节页 → 目录页; 封面与结束页不裁(裁了稿子没有头或没有尾)
    const rank = (k: PptPageKind) => (k === "content" ? 0 : k === "section" ? 1 : k === "toc" ? 2 : 3);
    const byRank = pages
      .map((p, i) => ({ i, k: p.kind }))
      .filter((x) => x.k !== "cover" && x.k !== "end")
      .sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i);
    const drop = new Set(byRank.slice(0, pages.length - PAGE_MAX).map((x) => x.i));
    const kept = pages.filter((_, i) => !drop.has(i));
    if (kept.length < pages.length) {
      pages.length = 0;
      pages.push(...kept);
    }
  }

  let note = `共 ${pages.length} 页`;
  if (want > 0 && pages.length !== want) {
    if (pages.length > want) {
      let over = pages.length - want;
      const keep: PptOutlinePage[] = [];
      for (const p of pages) {
        if (over > 0 && p.kind === "content") { over--; continue; }
        keep.push(p);
      }
      if (over === 0) {
        pages.length = 0;
        pages.push(...keep);
        note = `共 ${pages.length} 页(目标 ${want} 页, 已裁)`;
      } else {
        note = `共 ${pages.length} 页(目标 ${want} 页, 但封面/目录/结束页不可裁)`;
      }
    } else {
      note = `共 ${pages.length} 页(目标 ${want} 页, 内容不足未凑页)`;
    }
  }
  if (pages.length < PAGE_MIN) note += `; 少于 ${PAGE_MIN} 页, 建议补内容`;

  // seq 重排成 10/20/30... —— 留空档, 插入一页不必重排全表
  pages.forEach((p, i) => { p.seq = (i + 1) * 10; });

  return {
    title: clip(obj.title ?? opts.topic, TITLE_MAX),
    subtitle: clip(obj.subtitle ?? obj.subTitle ?? "", SUBTITLE_MAX),
    pages,
    pageCountNote: note,
    degraded: false,
    degradeReason: "",
  };
}

/** LLM 挂了/超时/返回不成形状时的骨架大纲 —— 让工作台能继续往下走, 且**明说是降级** */
export function fallbackOutline(topic: string, wantPages: number, maxBullets: number): PptOutline {
  const t = clip(topic || "演示文稿", TITLE_MAX);
  const total = Math.min(PAGE_MAX, Math.max(PAGE_MIN, wantPages || 8));
  const body = Math.max(2, total - 3); // 去掉封面/目录/结束
  const skeleton = ["研究背景与问题", "现状与文献", "核心概念界定", "分析框架", "材料与方法", "主要发现", "讨论与启示", "结论与展望"];
  const pages: PptOutlinePage[] = [
    { seq: 0, kind: "cover", title: t, bullets: [], notes: "" },
    { seq: 0, kind: "toc", title: "目录", bullets: [], notes: "" },
  ];
  for (let i = 0; i < body; i++) {
    pages.push({
      seq: 0, kind: "content",
      title: skeleton[i % skeleton.length],
      bullets: Array.from({ length: Math.min(maxBullets, 3) }, (_, k) => `待补充要点 ${k + 1}`),
      notes: "",
    });
  }
  pages.push({ seq: 0, kind: "end", title: "谢谢", bullets: [], notes: "" });
  pages.forEach((p, i) => { p.seq = (i + 1) * 10; });
  return {
    title: t, subtitle: "", pages,
    pageCountNote: `共 ${pages.length} 页(骨架)`,
    degraded: true,
    degradeReason: "文案模型不可用, 已用通用骨架兜底 —— 标题与要点都需要人工改写",
  };
}

function buildPrompt(topic: string, wantPages: number, maxBullets: number, sourceText: string): string {
  const pageHint = wantPages > 0
    ? `总页数约 ${wantPages} 页(含封面、目录、结束页)。`
    : "总页数按内容自然展开, 8-16 页之间。";
  return `你是中文演示文稿(PPT)的结构设计者。请为主题「${topic}」设计一份可直接上台讲的大纲。

要求:
1. ${pageHint}
2. 页型只用这五种: cover(封面) / toc(目录) / section(章节过渡) / content(正文) / end(结束)。
   第一页必须是 cover, 最后一页必须是 end, 中间至少一页 toc。
3. **每页要点最多 ${maxBullets} 条**。正文页每条要点是**一句能打在屏幕上的短句**,
   不是段落 —— 超过 30 个字就该拆到下一页。
4. 标题要"适合中文演示文稿": 14 字以内, 用最常见的词, 不要副标题、不要标点堆叠、不要英文缩写(除非学界通用)。
5. 正文页的 bullets 用中文, 避免"首先/其次/最后"这类只在讲稿里有意义的连接词 ——
   它们放讲稿(notes), 不放屏幕。
6. notes 是**讲稿**: 这一页你会怎么讲(60-150 字), 可以口语化, 可以有"这一页想强调的是…"。
${sourceText ? `\n可参考以下材料(不要照抄句子, 只取结构):\n${sourceText.slice(0, 6000)}` : ""}

只输出 JSON, 不要任何解释文字, 结构:
{"title":"演示标题","subtitle":"副标题(可空)","pages":[{"kind":"cover","title":"…","bullets":[],"notes":"…"}]}`;
}

export interface GenerateOutlineInput {
  topic: string;
  /** 期望总页数, 0/缺省 = 让模型自己定 */
  wantPages?: number;
  maxBullets?: number;
  /** 素材正文(论文摘要/正文节选)。为空则纯主题创作 */
  sourceText?: string;
  /** 注入缝: 测试与离线场景可换掉 LLM 调用, 不必打真网络 */
  callJson?: (prompt: string, maxTokens: number) => Promise<unknown>;
}

/**
 * 生成大纲。**永远返回一份可用的大纲** —— LLM 失败时给降级骨架并置 degraded。
 *
 * 为什么不是"失败就抛": 大纲是整个工作台的第一步, 抛出去意味着用户在界面上
 *   连"改一改再用"的机会都没有。降级骨架 + 显式 degraded 让用户能立刻开始编辑,
 *   而且知道这不是模型写的(而不是以为模型就这水平)。
 */
export async function generateOutline(input: GenerateOutlineInput): Promise<PptOutline> {
  const topic = clip(input.topic, TITLE_MAX) || "演示文稿";
  const maxBullets = Math.min(BULLETS_MAX, Math.max(BULLETS_MIN, Math.round(input.maxBullets ?? 5) || 5));
  const wantPages = Math.min(PAGE_MAX, Math.max(0, Math.round(input.wantPages ?? 0) || 0));
  const prompt = buildPrompt(topic, wantPages, maxBullets, input.sourceText ?? "");
  const call = input.callJson ?? defaultCallJson;
  let raw: unknown = null;
  let err = "";
  try {
    raw = await call(prompt, 4096);
  } catch (e) {
    err = String((e as Error)?.message ?? e).slice(0, 160);
  }
  const pages = raw && typeof raw === "object" ? asArray((raw as Record<string, unknown>).pages) : [];
  if (!pages.length) {
    const fb = fallbackOutline(topic, wantPages, maxBullets);
    fb.degradeReason = err ? `${fb.degradeReason}(模型调用失败: ${err})` : fb.degradeReason;
    return fb;
  }
  return normalizeOutline(raw, { topic, wantPages, maxBullets });
}

async function defaultCallJson(prompt: string, maxTokens: number): Promise<unknown> {
  const ep = getLlmEndpoint({ model: getRoleModel("editor") });
  if (!ep.key) throw new Error("未配置 LLM API Key");
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: prompt + "\n\n只输出 JSON，不要其他文字。" }],
    temperature: 0.4,
    maxTokens,
    timeoutMs: 240_000,
  });
  if (!res?.text) return null;
  return parseLlmJson(res.text);
}

// ════════════════════ 大纲编辑(增删页 / 改标题 / 调顺序 / 改页数) ════════════════════

export interface OutlineEdit {
  op: "add" | "remove" | "update" | "move" | "resize";
  seq?: number;
  kind?: PptPageKind;
  title?: string;
  bullets?: string[];
  notes?: string;
  toIndex?: number;
  pageCount?: number;
  maxBullets?: number;
}

/**
 * 纯函数式的大纲编辑 —— 服务层据此把改动落到 ppt_pages。
 *
 * 为什么不直接在 SQL 里改: 顺序调整、页数约束、目录页同步这几件事**互相牵制**
 *   (删了正文页要改目录; 页数不够要提示而不是硬凑)。放在一处纯函数里,
 *   就能单独测"删到只剩 2 页会怎样"而不必起库。
 */
export function applyOutlineEdit(
  outline: PptOutline,
  edit: OutlineEdit,
): { ok: boolean; outline: PptOutline; error?: string } {
  const pages = outline.pages.map((p) => ({ ...p, bullets: [...p.bullets] }));
  const findIdx = (seq?: number) => pages.findIndex((p) => p.seq === seq);

  switch (edit.op) {
    case "add": {
      const kind: PptPageKind = edit.kind && ["cover", "toc", "section", "content", "end"].includes(edit.kind)
        ? edit.kind : "content";
      const title = clip(edit.title ?? "新页面", TITLE_MAX);
      // 插在 end 之前 —— 插在结束页之后的话, 讲到最后还要翻回来
      const endIdx = pages.findIndex((p) => p.kind === "end");
      const at = edit.toIndex != null ? Math.max(0, Math.min(pages.length, edit.toIndex))
        : (endIdx >= 0 ? endIdx : pages.length);
      pages.splice(at, 0, {
        seq: 0, kind, title,
        bullets: (edit.bullets ?? []).map((b) => clip(b, BULLET_MAX)).filter(Boolean).slice(0, BULLETS_MAX),
        notes: clip(edit.notes ?? "", 400),
      });
      break;
    }
    case "remove": {
      const i = findIdx(edit.seq);
      if (i < 0) return { ok: false, outline, error: `找不到 seq=${edit.seq} 的页` };
      if (pages[i].kind === "cover") return { ok: false, outline, error: "封面页不能删(删了演示稿没有开头)" };
      if (pages.length <= PAGE_MIN) return { ok: false, outline, error: `少于 ${PAGE_MIN} 页就不是演示稿了` };
      pages.splice(i, 1);
      break;
    }
    case "update": {
      const i = findIdx(edit.seq);
      if (i < 0) return { ok: false, outline, error: `找不到 seq=${edit.seq} 的页` };
      if (edit.title !== undefined) pages[i].title = clip(edit.title, TITLE_MAX);
      if (edit.kind !== undefined) pages[i].kind = edit.kind;
      if (edit.bullets !== undefined) {
        const maxB = Math.min(BULLETS_MAX, Math.max(BULLETS_MIN, Math.round(edit.maxBullets ?? 5) || 5));
        const bs = edit.bullets.map((b) => clip(b, BULLET_MAX)).filter(Boolean);
        // 超出的**不静默丢**: 明确报错让用户自己砍或改 maxBullets
        if (bs.length > maxB) return { ok: false, outline, error: `本页要点 ${bs.length} 条, 超过上限 ${maxB} 条` };
        pages[i].bullets = bs;
      }
      if (edit.notes !== undefined) pages[i].notes = clip(edit.notes, 400);
      break;
    }
    case "move": {
      const i = findIdx(edit.seq);
      if (i < 0) return { ok: false, outline, error: `找不到 seq=${edit.seq} 的页` };
      const to = Math.max(0, Math.min(pages.length - 1, edit.toIndex ?? i));
      const [p] = pages.splice(i, 1);
      pages.splice(to, 0, p);
      // 封面必须留在第一位 —— 允许把封面挪走会让"打开就是正文", 用户多半是拖错了
      if (pages[0].kind !== "cover") return { ok: false, outline, error: "封面页必须排在第一页" };
      break;
    }
    case "resize": {
      const want = Math.min(PAGE_MAX, Math.max(PAGE_MIN, Math.round(edit.pageCount ?? 0) || 0));
      if (!want) return { ok: false, outline, error: "页数不合法" };
      const over = pages.length - want;
      if (over > 0) {
        const keep: PptOutlinePage[] = [];
        let left = over;
        for (const p of pages) {
          if (left > 0 && p.kind === "content") { left--; continue; }
          keep.push(p);
        }
        if (left > 0) return { ok: false, outline, error: `只能裁到 ${pages.length - over + left} 页(封面/目录/结束页不可裁)` };
        pages.length = 0;
        pages.push(...keep);
      } else if (over < 0) {
        const endIdx = pages.findIndex((p) => p.kind === "end");
        const at = endIdx >= 0 ? endIdx : pages.length;
        for (let k = 0; k < -over; k++) {
          pages.splice(at, 0, { seq: 0, kind: "content", title: `待补充 ${k + 1}`, bullets: [], notes: "" });
        }
      }
      break;
    }
    default:
      return { ok: false, outline, error: `未知编辑操作: ${(edit as OutlineEdit).op}` };
  }

  pages.forEach((p, i) => { p.seq = (i + 1) * 10; });
  const maxB = Math.min(BULLETS_MAX, Math.max(BULLETS_MIN, Math.round(edit.maxBullets ?? 5) || 5));
  return {
    ok: true,
    outline: {
      ...outline,
      pages,
      // 手改过就不再是"模型出的那份"了 —— 降级标记留着会让界面在用户改完后还在警告
      degraded: false,
      degradeReason: "",
      pageCountNote: `共 ${pages.length} 页(每页最多 ${maxB} 条要点)`,
    },
  };
}

/**
 * 目录页的条目 —— 从**正文页现算**, 而不是让模型再写一遍。
 *
 * 为什么: 模型写的目录与正文页标题很容易对不上(实测常见), 而用户改了标题之后
 *   目录也不会跟着变。现算的目录永远和正文一致。
 */
export function tocEntries(outline: PptOutline, limit = 12): string[] {
  const titles = outline.pages
    .filter((p) => p.kind === "content" || p.kind === "section")
    .map((p) => p.title);
  if (titles.length <= limit) return titles;
  const head = titles.slice(0, limit - 1);
  head.push(`…(其余 ${titles.length - limit + 1} 节)`);
  return head;
}

/** 页数/要点的估算 —— 界面上"这时候是多少页"的提示用 */
export function estimateOutlineShape(input: { wantPages?: number; maxBullets?: number; sections?: number }): {
  pages: number;
  bulletsPerPage: number;
  words: number;
} {
  const sections = Math.max(1, Math.round(input.sections ?? 0) || 6);
  const maxBullets = Math.min(BULLETS_MAX, Math.max(BULLETS_MIN, Math.round(input.maxBullets ?? 5) || 5));
  const pages = Math.min(PAGE_MAX, Math.max(PAGE_MIN, Math.round(input.wantPages ?? 0) || sections + 3));
  // 每页要点按每条 25 个汉字估字数, 供"讲多久"参考(中文约 200 字/分钟)
  return { pages, bulletsPerPage: maxBullets, words: (pages - 3) * maxBullets * 25 };
}
