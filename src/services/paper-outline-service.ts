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
}): Promise<ChapterResult> {
  const isRoot = input.level === 0;
  const prompt = `你是人文社科学术写作专家。请撰写论文章节正文(非标题)。

【论文主题】${input.topic}
${input.thesis ? `【核心论点】${input.thesis}` : ""}
【本章标题】${input.title}
【本章层级】${isRoot ? "章(如 一、/二、 或 第X章)" : "节/小节"}
${input.outlineTree ? `【全文大纲】\n${input.outlineTree}` : ""}
${input.prevContext ? `【前文已写内容(摘要)】\n${input.prevContext}\n请延续前文的术语、论点与证据风格, 保持前后文连贯, 不重复已述内容。` : ""}
【语体要求】${input.style ?? "严谨的哲社科学术语体(客观/规范, 禁用口语化、绝对化)"}

要求:
1. 围绕本章标题展开论证: 提出观点 → 理论依据 → 证据/例证 → 小结
2. 学术引文用 [1] 式占位(勿编造具体文献, 标注"待补引文"处)
3. 输出 JSON: {"content":"本章正文(中文, 自然分段, 800-1500字; 若有小节用 Markdown 二级/三级标题)"}`;

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
}): Promise<ChapterResult> {
  const kindCn = { abstract: "摘要", keywords: "关键词", conclusion: "结论" }[input.kind];
  const chapters = input.sections.map((s, i) => `第${i + 1}章 ${s}`).join("；");
  const bodies = (input.chapterContents ?? []).map((c) => c.slice(0, 500)).join("\n");
  const prompt = `你是人文社科学术写作专家。请为论文生成「${kindCn}」。

【论文主题】${input.topic}
${input.thesis ? `【核心论点】${input.thesis}` : ""}
【章节结构】${chapters}
${bodies ? `【各章要点(摘要用)】\n${bodies}` : ""}

要求:
1. ${input.kind === "abstract" ? "摘要 200-400 字, 涵盖目的/方法/结果/结论四要素" : input.kind === "keywords" ? "3-5 个关键词, 用「；」分隔" : "结论 300-600 字, 总结全文论点+研究贡献+展望"}
2. 输出 JSON: {"content":"${input.kind === "keywords" ? "关键词:…" : "内容"}"}`;

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

const execFileAsync = promisify(execFile);

function pythonBin(): string {
  const venvPy = path.resolve(process.cwd(), ".venv-fmtcheck", "Scripts", "python.exe");
  if (existsSync(venvPy)) return venvPy;
  return process.platform === "win32" ? "python" : "python3";
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
}): Promise<{ ok: boolean; base64?: string; error?: string }> {
  const items = flattenForDocx(input.nodes);
  const script = `
import sys, json, base64, io
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH

items = ${JSON.stringify(items)}
paper_title = ${JSON.stringify(input.paperTitle)}

doc = Document()
# 页边距(默认模板)
for section in doc.sections:
    section.top_margin = Cm(2.54)
    section.bottom_margin = Cm(2.54)
    section.left_margin = Cm(3.17)
    section.right_margin = Cm(2.54)

# 论文标题
h = doc.add_paragraph()
h.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = h.add_run(paper_title)
r.bold = True
r.font.size = Pt(16)

for it in items:
    # 标题
    level = it["level"]
    if level == 0:
        ph = doc.add_heading(it["title"], level=1)
    elif level == 1:
        ph = doc.add_heading(it["title"], level=2)
    else:
        ph = doc.add_heading(it["title"], level=3)
    # 正文
    content = it["content"] or ""
    for para in content.split("\\n"):
        p = para.strip()
        if not p:
            continue
        if p.startswith("# "):
            doc.add_heading(p[2:], level=2)
        elif p.startswith("## "):
            doc.add_heading(p[3:], level=3)
        elif p.startswith("### "):
            doc.add_heading(p[4:], level=4)
        else:
            doc.add_paragraph(p)

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
