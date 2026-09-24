// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// paper-outline-service.ts — 论文写作工作台(大纲编辑器+分章生成+docx 导出)
// 参考 Respal「大纲编辑器/人机双写」体验(闭源, 仅借鉴交互思路, 不涉源码)
// 架构: 大纲 JSON 前端持有(localStorage 持久化) + 分章生成走 LLM + docx 导出走 python-docx
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";

export interface OutlineNode {
  id: string;
  title: string;        // 节标题
  level: number;        // 0=章 1=节 2=小节
  content?: string;     // 已生成内容(草稿)
  generated?: boolean;  // 是否已 LLM 生成
  children?: OutlineNode[];
}

export interface ChapterResult {
  id: string;
  title: string;
  content: string;      // 生成的章节正文(markdown)
  wordCount: number;
}

/**
 * 降 AIGC 强度档 —— 2026-09-15。
 * 此前只有布尔开关(enableDeAIFyMerge), 且**只作用于摘要/关键词**, 正文一字未动:
 * 用户勾"降AIGC合稿", 拿到的是同样的章节原文, 开关接近摆设。
 * 现在分三档, 且作用于**正文**, 每档都有硬约束(改写幅度上限 + 事实冻结),
 * 免得"降 AI 痕迹"变成"重写一篇"(学术稿改内容比留 AI 味更严重)。
 */
export type DeAITier = "light" | "medium" | "heavy";

const DEAI_TIER_PROMPT: Record<DeAITier, { label: string; spec: string; temp: number; maxTokens: number }> = {
  light: {
    label: "轻度降重",
    spec: `只做**表层替换**, 不动句子结构: 替换模板化连接词("首先/其次/最后/综上所述/随着…的发展"等)、
合并显而易见的空泛修饰、把重复出现的同义表达换掉。段落划分与句序保持不变。`,
    temp: 0.35,
    maxTokens: 8192,
  },
  medium: {
    label: "中度降重",
    spec: `在轻度基础上**调整句式节奏**: 长短句交替, 拆开过于整齐的并列排比, 把被动堆砌改为主动表述,
删掉无信息量的过渡句。段落主旨与论点顺序不变, 句子可以重排或合并。`,
    temp: 0.5,
    maxTokens: 12288,
  },
  heavy: {
    label: "重度降重",
    spec: `在轻度、中度基础上**重组表达路径**: 按论证需要重新安排句序与段落切分, 用具体信息替代概括性表述,
把"总-分"套路改成更自然的学术叙述。允许大幅改写语言, **但每一个事实、数据、引文、术语、结论都必须原样保留**。`,
    temp: 0.7,
    maxTokens: 16384,
  },
};

const DEAI_FROZEN = `【冻结项 — 三档都不得改动】
· 数据与数字: 所有数值、年份、比例、单位、表格内容
· 引文与出处: 直接引语、人名、文献、机构名、专有名词、术语
· 论证内容: 每一个论点、结论、因果关系的方向
· 标记: markdown 标题层级、表格、公式、[N] 引用标记一律原样保留`;

/** 单次降重的输入上限(按档位不同): 超长正文分块处理, 否则模型会截断导致丢正文 */
const DEAI_CHUNK_CHARS: Record<DeAITier, number> = { light: 6000, medium: 4000, heavy: 2600 };
/** 每档允许的最大字数增幅(保险丝: 模型跑偏成"扩写"时截回) */
const DEAI_MAX_GROWTH = 1.6;

/**
 * 正文降 AIGC。按空行切块 → 逐块改写 → 拼回。
 * 分块是必须的: 一次丢 8000 字进去, 模型只回 4000 字就是静默丢正文(实测同类任务的常见失败)。
 * 单块失败回退原文 —— 降重失败不该毁掉用户已有的稿子。
 */
export async function applyDeAITier(text: string, tier: DeAITier, opts: { model?: string; onProgress?: (done: number, total: number) => void } = {}): Promise<string> {
  const src = String(text ?? "");
  if (!src.trim()) return src;
  const spec = DEAI_TIER_PROMPT[tier] ?? DEAI_TIER_PROMPT.medium;
  const limit = DEAI_CHUNK_CHARS[tier] ?? 4000;
  // 按空行切段后装箱, 不硬切句子
  const paras = src.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf: string[] = [];
  let size = 0;
  for (const p of paras) {
    if (size + p.length > limit && buf.length) { chunks.push(buf.join("\n\n")); buf = []; size = 0; }
    buf.push(p); size += p.length + 2;
  }
  if (buf.length) chunks.push(buf.join("\n\n"));
  if (chunks.length <= 1) {
    const one = await deAIChunk(chunks[0] ?? src, spec, tier, opts.model);
    opts.onProgress?.(1, 1);
    return one;
  }
  const out: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    out.push(await deAIChunk(chunks[i], spec, tier, opts.model));
    opts.onProgress?.(i + 1, chunks.length);
  }
  return out.join("\n\n");
}

async function deAIChunk(text: string, spec: { label: string; spec: string; temp: number }, tier: DeAITier, model?: string): Promise<string> {
  if (!text.trim()) return text;
  const prompt = `你是中文学术写作编辑。请对下面这段论文正文执行「${spec.label}」, 目标是降低 AI 生成痕迹。

【${spec.label}的处理方式】
${spec.spec}

${DEAI_FROZEN}

【输出要求】
· 直接输出改写后的正文, 不要任何解释、前后缀或代码围栏
· 字数控制在原文的 0.9~1.3 倍之间
· 保持 markdown 格式

【原文】
${text}`;
  const ep = getLlmEndpoint({ model: model || getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: prompt }],
    temperature: spec.temp,
    maxTokens: DEAI_TIER_PROMPT[tier]?.maxTokens ?? 8192,
    timeoutMs: 300_000,
  });
  const got = String(res?.text ?? "").trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "");
  // 失败 / 空 / 膨胀失控 → 回退原文(宁可留着 AI 味, 不能丢正文)
  if (!got || got.length < text.length * 0.5 || got.length > text.length * DEAI_MAX_GROWTH) return text;
  return got;
}

async function llmJson(prompt: string, modelOverride?: string, maxTokens = 4000): Promise<any | null> {
  const ep = getLlmEndpoint({ model: modelOverride || getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url,
    key: ep.key,
    model: ep.model,
    messages: [{ role: "user", content: prompt + "\n\n只输出 JSON，不要其他文字。" }],
    temperature: 0.3,
    maxTokens,
    timeoutMs: 240_000,
  });
  if (!res?.text) return null;
  return parseLlmJson(res.text);
}

/** 已生成章节的正文(供后续章节上下文衔接) */
function chapterContext(nodes: OutlineNode[]): string {
  const parts: string[] = [];
  const walk = (list: OutlineNode[], depth: number) => {
    for (const n of list) {
      if (n.generated && n.content && n.content.trim().length > 50) {
        parts.push(`[${n.title}] ${n.content.slice(0, 400)}`);
      }
      if (n.children?.length) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return parts.slice(-5).join("\n\n"); // 最近 5 章, 防超长
}

/** 全文大纲树(标题路径), 供写作时看结构 */
function treePath(nodes: OutlineNode[]): string {
  const lines: string[] = [];
  const walk = (list: OutlineNode[], depth: number) => {
    for (const n of list) {
      lines.push(`${"  ".repeat(depth)}${n.title}`);
      if (n.children?.length) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return lines.join("\n");
}

/**
 * 分章生成: 给定章节标题 + 论文主题 + 前文上下文 → 该章正文
 * 前后文连贯: 注入已生成章节摘要, LLM 延续论点/术语/证据风格
 */
export async function generateChapter(input: {
  nodeId: string;
  title: string;
  level: number;
  topic: string;          // 论文主题
  thesis?: string;        // 核心论点
  prevContext?: string;   // 前文(前几章已生成内容摘要)
  outlineTree?: string;   // 全文大纲(标题树)
  style?: string;         // 语体(默认哲社科学术语体)
  model?: string;
  citationPool?: string;  // SocialSci R3: 真实引用池(素材引文编号清单, 供正文[ N ]引用)
  /**
   * V417: 本章的目标字数。来自用户填的「字数预估」按章分配的配额。
   * 此前这个参数不存在 —— 用户在「选题界定」填的 totalWordCount 一路到此断掉,
   * 而界面却写着"AI 智能体将按此字数进行科研分配"(InputView 的字数预估卡),
   * prompt 里还写死 800-1500 字。现在由 runChapterBatch 按章均分后传进来。
   */
  targetWordCount?: number;
  /**
   * 用户上传的参考样例(闭源 `buildSampleContent()`: 把每个文件拼成 `=== 文件名 ===\n内容`, 截 8000 字)。
   *
   * 2026-09-16: 此前这个参数**不存在**, 于是「选题界定」页上传的参考文件只喂给了澄清提问那一处,
   * **从不进入章节生成** —— 用户在界面上传了 3 个 PDF 当写作范式, 生成的正文跟它们毫无关系。
   */
  sampleContent?: string;
}): Promise<ChapterResult> {
  const isRoot = input.level === 0;
  // 目标字数 → 提示词里的区间(±20%); 没给就用原来的兜底区间
  const wcHint = input.targetWordCount && input.targetWordCount > 0
    ? `${Math.round(input.targetWordCount * 0.8)}-${Math.round(input.targetWordCount * 1.2)}字(本章配额约 ${input.targetWordCount} 字)`
    : "800-1500字";
  const prompt = `你是人文社科学术写作专家。请撰写论文章节正文(非标题)。

【论文主题】${input.topic}
${input.thesis ? `【核心论点】${input.thesis}` : ""}
【本章标题】${input.title}
【本章层级】${isRoot ? "章(如 一、/二、 或 第X章)" : "节/小节"}
${input.outlineTree ? `【全文大纲】\n${input.outlineTree}` : ""}
${input.prevContext ? `【前文已写内容(摘要)】\n${input.prevContext}\n请延续前文的术语、论点与证据风格, 保持前后文连贯, 不重复已述内容。` : ""}
【语体要求】${input.style ?? "严谨的哲社科学术语体(客观/规范, 禁用口语化、绝对化)"}
${input.citationPool ? `【可引文献池(须从下列真实条目中选择, 不得虚构)】
${input.citationPool}
引用写法: 每条条目前的序号形如 \`23\`(池位置_条内序号), **必须原样写成占位符** \`§REF_23_1§\`。
例: 若池里有 \`23. 李海波. 测度框架[J]. 2020.\`, 则行文写成 "李海波提出的测度框架§REF_23_1§"。
不要自己编编号, 不要写 \`[1]\` 这种数字——编号由后续环节按**正文首次出现顺序**统一重排,
你只管把引用的位置标出来。请自然引用 1-5 条。` : ""}
${input.sampleContent ? `【参考样例(用户上传的文献/范文, 用来判断其写作取向与规范)】\n${input.sampleContent.slice(0, 4000)}\n注意: 只借鉴其**语体、结构与论证密度**, 不要照抄其观点与结论。` : ""}

要求:
1. 围绕本章标题展开论证: 提出观点 → 理论依据 → 证据/例证 → 小结
2. 学术引文用 [1] 式占位(勿编造具体文献, 标注"待补引文"处)${input.citationPool ? " — 但已有引用池时必须用池内条目编号" : ""}
3. 输出 JSON: {"content":"本章正文(中文, 自然分段, ${wcHint}; 若有小节用 Markdown 二级/三级标题)"}`;

  const answer = await llmJson(prompt, input.model, 6000);
  const content = String(answer?.content ?? "").trim();
  return {
    id: input.nodeId,
    title: input.title,
    content,
    wordCount: content.replace(/\s/g, "").length,
  };
}

/**
 * 生成摘要/引言/结论等"论文要件"章节(特殊逻辑)
 */
export async function generateComponent(input: {
  kind: "abstract" | "keywords" | "conclusion";
  topic: string;
  thesis?: string;
  sections: string[];     // 正文各章标题
  chapterContents?: string[]; // 各章正文(摘要需要全貌)
  model?: string;
  /**
   * V417: 降 AI 痕迹。用户在「统稿定稿」勾了「降 AIGC」后, 这条开关此前一路写到
   * input_snapshot 就断了 —— runPhase5 从不读它, 用户选的档位对产出零影响。
   * 打开时在提示词里加反模板化要求。
   * 2026-09-15: 扩成三档(轻/中/重), 摘要/关键词按档位给不同强度的指令; 正文的降重
   * 由调用方用 applyDeAITier() 做(那条路要分块, 不适合塞在这个单次 JSON 调用里)。
   */
  deAITone?: boolean | DeAITier;
}): Promise<ChapterResult> {
  const kindCn = { abstract: "摘要", keywords: "关键词", conclusion: "结论" }[input.kind];
  const chapters = input.sections.map((s, i) => `第${i + 1}章 ${s}`).join("；");
  const bodies = (input.chapterContents ?? []).map((c) => c.slice(0, 500)).join("\n");
  const tier: DeAITier | null = !input.deAITone ? null : input.deAITone === true ? "medium" : input.deAITone;
  const tierSpec = tier ? DEAI_TIER_PROMPT[tier] : null;
  // 摘要/关键词本来就是新写的, 没有"原文"可冻结 —— 只传处理方式, 不传冻结清单(那是给改写正文用的)
  const deAI = tierSpec ? `\n3. **${tierSpec.label}(降 AI 痕迹)**: ${tierSpec.spec}` : "";
  const prompt = `你是人文社科学术写作专家。请为论文生成「${kindCn}」。

【论文主题】${input.topic}
${input.thesis ? `【核心论点】${input.thesis}` : ""}
【章节结构】${chapters}
${bodies ? `【各章要点(摘要用)】\n${bodies}` : ""}

要求:
1. ${input.kind === "abstract" ? "摘要 200-400 字, 涵盖目的/方法/结果/结论四要素" : input.kind === "keywords" ? "3-5 个关键词, 用「；」分隔" : "结论 300-600 字, 总结全文论点+研究贡献+展望"}
2. 输出 JSON: {"content":"${input.kind === "keywords" ? "关键词:…" : "内容"}"}${deAI}`;

  const answer = await llmJson(prompt, input.model, 3000);
  const content = String(answer?.content ?? "").trim();
  return { id: input.kind, title: kindCn, content, wordCount: content.replace(/\s/g, "").length };
}

// ═══ docx 导出(python-docx 子进程, 与 format-check 同通道) ═══
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePython } from "./py-path.js";

/** V417: 导出的参考文献块 —— text 为空即"没接出可引文献"，需在文档里显式提醒人工补录 */
export interface ReferenceListInfo {
  text: string;
  /** 有条目但著录不全(缺作者/年份) */
  needsManual: boolean;
  /** 条目实际来自哪些检索源 */
  sources?: string[];
}

const execFileAsync = promisify(execFile);

function pythonBin(): string {
  return resolvePython();
}

/** 大纲树 → 结构化内容(标题+正文顺序展开) */
function flattenForDocx(nodes: OutlineNode[]): Array<{ title: string; level: number; content: string }> {
  const out: Array<{ title: string; level: number; content: string }> = [];
  const walk = (list: OutlineNode[]) => {
    for (const n of list) {
      out.push({ title: n.title, level: Math.min(n.level, 3), content: n.content ?? "" });
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** 导出 docx: 大纲+已生成内容 → 结构化 Word(python-docx) */
export async function exportOutlineDocx(input: {
  paperTitle: string;
  nodes: OutlineNode[];
  fontName?: string; // R7(闭源 formatPresets.docxFont): 默认 SimSun, 编辑器按预览预设传
  fontSize?: number; // R7: 正文字号(pt), 同样来自预览预设; 缺省走 python 侧默认
  references?: ReferenceListInfo; // V417: 参考文献 + 著录完整性(补录提醒)
  /** V425: 目标体例 —— 决定行距与页边距(见下方 LAYOUT 表) */
  formatTarget?: "期刊论文" | "学位论文" | "党校期刊" | "高校学报";
}): Promise<{ ok: boolean; base64?: string; error?: string }> {
  const items = flattenForDocx(input.nodes);
  const fontName = input.fontName || "SimSun";
  /**
   * 体例 → 版式参数(V425 新增)。
   *
   * 由来(2026-09-24): 这段脚本原先**从不设置行距和页边距** —— python-docx 新建 Document
   *   拿到的是 Word 模板默认值(页边距 2.54/3.17cm, **单倍行距**), 导出的稿子与
   *   "按目标期刊体例"没有任何关系, 用户还得自己调。这里把 FORMAT_RULES
   *   (paper-quality-service) 里那几条**可机读**的规则真正落到文件上:
   *     期刊论文 行距 1.5 倍; 学位论文 1.5 倍; 党校期刊 1.5 倍; 高校学报 **固定值 20 磅**。
   *   ⚠ 字体/字号那两条**不在这里做**: 它们已经由 fontName/fontSize 从前端预设传进来了,
   *     再按体例覆盖一遍会把用户自己选的字号顶掉。此处只补原先**完全没人管**的两项。
   *   页边距四档暂无权威出处(paper-quality-service 只给了行距与字体), 故统一用学术论文
   *     通行的 2.54/3.17cm —— 即 Word 默认值, **显式写出来**是为了让它成为有意为之的取值,
   *     而不是"没人设所以恰好是默认"。
   */
  const LAYOUT: Record<string, { spacingMode: "multiple" | "exact"; spacingValue: number }> = {
    "期刊论文": { spacingMode: "multiple", spacingValue: 1.5 },
    "学位论文": { spacingMode: "multiple", spacingValue: 1.5 },
    "党校期刊": { spacingMode: "multiple", spacingValue: 1.5 },
    "高校学报": { spacingMode: "exact", spacingValue: 20 },
  };
  const layout = LAYOUT[input.formatTarget ?? ""] ?? { spacingMode: "multiple" as const, spacingValue: 1.5 };
  // 字号: 之前只传字体不传字号 —— 预设里 docxFontSize 4 档(10.5/10.5/12/11)在导出时被整个丢掉。
  //   0 / 未传 → python 侧保持原默认(不改既有行为)
  const bodyFontSize = Number(input.fontSize) > 0 ? Number(input.fontSize) : 0;
  const refs = input.references ?? { text: "", needsManual: false, sources: [] };
  const script = `
import sys, json, base64, io
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH

items = ${JSON.stringify(items)}
paper_title = ${JSON.stringify(input.paperTitle)}
font_name = ${JSON.stringify(fontName)}
body_size = ${bodyFontSize > 0 ? bodyFontSize : "None"}
references_text = ${JSON.stringify(refs.text ?? "")}
refs_needs_manual = ${refs.needsManual ? "True" : "False"}
refs_sources = ${JSON.stringify(refs.sources ?? [])}
# V425: 体例决定的行距(见服务端 LAYOUT 表的注释)
spacing_mode = ${JSON.stringify(layout.spacingMode)}
spacing_value = ${layout.spacingValue}

def set_run(r, size=None):
    r.font.name = font_name
    from docx.oxml.ns import qn
    r._element.rPr.rFonts.set(qn("w:eastAsia"), font_name)
    if size:
        r.font.size = Pt(size)

def set_spacing(par):
    """给段落套上体例行距。原先**整篇没有任何行距设置** —— python-docx 建的空文档是单倍行距,
    与 FORMAT_RULES 里写的 1.5 倍对不上, 导出结果就不是"按体例"的。"""
    pf = par.paragraph_format
    if spacing_mode == "exact":
        pf.line_spacing = Pt(spacing_value)
    else:
        pf.line_spacing = spacing_value

doc = Document()
# 页边距: 显式写出(值同 Word 默认, 但从此是**有意为之**而不是"没人设所以恰好如此")
for section in doc.sections:
    section.top_margin = Cm(2.54)
    section.bottom_margin = Cm(2.54)
    section.left_margin = Cm(3.17)
    section.right_margin = Cm(2.54)

# 论文标题
h = doc.add_paragraph()
h.alignment = WD_ALIGN_PARAGRAPH.CENTER
set_spacing(h)
r = h.add_run(paper_title)
r.bold = True
set_run(r, 16)

for it in items:
    # 标题
    level = it["level"]
    if level == 0:
        ph = doc.add_heading(it["title"], level=1)
    elif level == 1:
        ph = doc.add_heading(it["title"], level=2)
    else:
        ph = doc.add_heading(it["title"], level=3)
    set_spacing(ph)
    for run in ph.runs:
        set_run(run)
    # 正文
    content = it["content"] or ""
    for para in content.split("\\n"):
        p = para.strip()
        if not p:
            continue
        if p.startswith("# "):
            ph2 = doc.add_heading(p[2:], level=2)
            set_spacing(ph2)
            for run in ph2.runs:
                set_run(run)
        elif p.startswith("## "):
            ph3 = doc.add_heading(p[3:], level=3)
            set_spacing(ph3)
            for run in ph3.runs:
                set_run(run)
        elif p.startswith("### "):
            ph4 = doc.add_heading(p[4:], level=4)
            set_spacing(ph4)
            for run in ph4.runs:
                set_run(run)
        else:
            pp = doc.add_paragraph(p)
            set_spacing(pp)
            for run in pp.runs:
                set_run(run, body_size)

# ── 参考文献(V417): 有真实条目就落列表; 没有就显式标注"需人工补录", 不伪造 ──
refh = doc.add_heading("参考文献", level=1)
set_spacing(refh)
for run in refh.runs:
    set_run(run)
if references_text.strip():
    for line in references_text.split("\\n"):
        line = line.strip()
        if not line:
            continue
        p = doc.add_paragraph(line)
        set_spacing(p)
        for run in p.runs:
            set_run(run)
    if refs_needs_manual:
        note = doc.add_paragraph("（部分条目仅有标题、缺作者/年份等著录信息，请按投稿要求人工补全。）")
        set_spacing(note)
        for run in note.runs:
            set_run(run, 10)
else:
    empty = doc.add_paragraph("【本文未接出可引文献：正文中的引用编号为占位符，请人工补录参考文献后再投稿。】")
    for run in empty.runs:
        set_run(run, 10)
# V417: refs_sources 此前是**死变量**(赋值后全文再没引用) —— 条目到底来自哪些库,
#   应该让读者/审稿人看得到, 而不是只留在接口里。
if references_text.strip() and refs_sources:
    src_note = doc.add_paragraph("（内部检索来源：" + "、".join(str(x) for x in refs_sources) + "）")
    for run in src_note.runs:
        set_run(run, 10)

buf = io.BytesIO()
doc.save(buf)
print(json.dumps({"ok": True, "base64": base64.b64encode(buf.getvalue()).decode()}))
`;
  const tmpScript = path.join(os.tmpdir(), `outline-docx-${Date.now()}.py`);
  try {
    writeFileSync(tmpScript, script, "utf8");
    const { stdout } = await execFileAsync(pythonBin(), [tmpScript], { timeout: 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    const d = JSON.parse(stdout);
    if (d.ok && d.base64) return { ok: true, base64: d.base64 };
    return { ok: false, error: "导出失败: 无输出" };
  } catch (e: any) {
    return { ok: false, error: String(e?.stderr || e?.message || e).slice(0, 300) };
  } finally {
    try { rmSync(tmpScript, { force: true }); } catch { /* 忽略 */ }
  }
}

/** 导出 PPTX: 大纲+内容 → 学术演示稿(python-pptx): 封面+每章一页(标题+要点) */
export async function exportOutlinePptx(input: {
  paperTitle: string;
  nodes: OutlineNode[];
  author?: string;
}): Promise<{ ok: boolean; base64?: string; error?: string }> {
  const items = flattenForDocx(input.nodes);
  const script = `
import sys, json, base64, io
from pptx import Presentation
from pptx.util import Pt, Inches

items = ${JSON.stringify(items)}
paper_title = ${JSON.stringify(input.paperTitle)}
author = ${JSON.stringify(input.author ?? "")}

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)

def add_title_slide():
    slide = prs.slides.add_slide(prs.slide_layouts[0])
    slide.shapes.title.text = paper_title
    if author:
        slide.placeholders[1].text = author

def add_content_slide(title, content):
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = title
    body = slide.placeholders[1].text_frame
    body.clear()
    # 抽要点: 每自然段或句号断句为 bullet
    paras = [p.strip() for p in content.split("\\n") if p.strip()]
    bullets = []
    for p in paras:
        if p.startswith("#"):
            continue
        # 按句号拆长段, 保留前 3 句
        sentences = [s + "。" for s in p.split("。") if len(s.strip()) > 10][:3]
        bullets.extend(sentences)
        if len(bullets) >= 6:
            break
    first = True
    for b in bullets[:6]:
        para = body.paragraphs[0] if first else body.add_paragraph()
        first = False
        para.text = b.strip()
        para.level = 0
        para.font.size = Pt(18)

add_title_slide()
for it in items:
    content = it["content"] or ""
    if content.strip():
        add_content_slide(it["title"], content)

buf = io.BytesIO()
prs.save(buf)
print(json.dumps({"ok": True, "base64": base64.b64encode(buf.getvalue()).decode()}))
`;
  const tmpScript = path.join(os.tmpdir(), `outline-pptx-${Date.now()}.py`);
  try {
    writeFileSync(tmpScript, script, "utf8");
    const { stdout } = await execFileAsync(pythonBin(), [tmpScript], { timeout: 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    const d = JSON.parse(stdout);
    if (d.ok && d.base64) return { ok: true, base64: d.base64 };
    return { ok: false, error: "导出失败: 无输出" };
  } catch (e: any) {
    return { ok: false, error: String(e?.stderr || e?.message || e).slice(0, 300) };
  } finally {
    try { rmSync(tmpScript, { force: true }); } catch { /* 忽略 */ }
  }
}
