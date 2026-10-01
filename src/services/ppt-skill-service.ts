// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// ppt-skill-service.ts — PPT 的**第二条生成路径**: 走外部技能(2026-10-01)
//
// ═══════════════════════════════════════════════════════════════
// 为什么要有第二条路
// ═══════════════════════════════════════════════════════════════
//   本仓已有的 PPT 工作台(ppt-workbench-service)是**自建管线**:
//   大纲(LLM) → 脚本(LLM) → 配图 → python-pptx 渲染。
//   它的长处在**快、可控、可单页重生**: 每页一行落库, 改第 3 页不碰别的页。
//
//   但社区里已经有一批**把"好 PPT"这件事做透了**的技能 —— 例如
//   `nature-paper2ppt`(Nature 风格中文论文汇报, 带讲稿与配图裁剪, 还自带
//   `scripts/audit_pptx_quality.py` 做溢出/对齐/图注完整性自检)。
//   这些技能的内部约定(叙事弧、术语台账、自检项)是**几百次迭代攒出来的**,
//   我们重写一遍不如直接调用它。
//
// ═══════════════════════════════════════════════════════════════
// 关键事实: 技能不是"能被调用的函数", 是**交给 Agent 的指令**
// ═══════════════════════════════════════════════════════════════
//   `view_skill_run`(src/services/agent-view-tools.ts:321) 不执行任何东西 ——
//   它把 SKILL.md + references + scripts 清单读出来拼成一段文本返回。
//   skills-service 的 `getSkillDetail(name)` 同理(纯读文件)。
//   真正"跑"技能的是**拿到这段指令的 LLM/Agent**。
//
//   所以这条路径的诚实描述是:
//     **本服务负责"选技能 + 备料 + 建 Agent 任务 + 回收产物", 中间那段执行交给 Agent。**
//   这不是偷懒 —— 硬造一个"服务端直接跑 skill"的假接口, 只会得到一堆
//   "技能说要做 A, 我们的代码做了 B" 的静默偏差(本仓在 p2o 领域引擎上已经踩过)。
//
//   由此带来一个**必须向用户交代**的差别, 见 SKILL_NOTE:
//   第二条路径是分钟级、有额度成本、且产物质量取决于所用模型; 不是"点一下就好"的快路。
//
// ═══════════════════════════════════════════════════════════════
// 为什么把候选技能写死在服务里, 而不是让前端搜索"含 ppt 的技能"
// ═══════════════════════════════════════════════════════════════
//   本机 skills 目录下有 190+ 个技能, 其中名字含 slide/ppt 的有 5 个, 能力天差地别:
//     · nature-paper2ppt  → 真产出 .pptx(唯一一个这么声称并带 QA 脚本的)
//     · scientific-slides → 模板/时间分配指导
//     · scholar-slides    → 学术汇报
//     · paper-slide-deck  → **只出图片**(17 种 T2I 风格), 不是可编辑幻灯片
//     · beamer-presentation → LaTeX Beamer, 产物是 PDF 不是 pptx
//   让用户在一堆"看起来都能做 PPT"的技能里选, 而其中三个根本产不出 .pptx,
//   是把这个坑转嫁给用户。这里用**显式白名单 + 讲清产物形态**, 前端只渲染这个清单。
//
// 清单为空时不报错、不隐藏 —— 前端会显示"本机未装 PPT 技能, 请先安装"。
// (技能在 ~/.claude/skills, 是**本机资产**, 不随仓库分发; CI/新机器上没有是正常的。)
import { existsSync } from "node:fs";
import { getSkillDetail } from "./skills-service.js";

export interface PptSkillCandidate {
  /** 技能 id(= skills 目录名 = SKILL.md frontmatter 的 name) */
  id: string;
  /** 一句话说明它做什么 */
  label: string;
  /** **产物形态** —— 这是选技能时最先要知道的事 */
  output: "pptx" | "images" | "pdf" | "guide";
  outputLabel: string;
  /** 适合什么场景 */
  bestFor: string;
  /** 已知限制(有就写, 没有留空) */
  caveat?: string;
  /** 本机是否真的装了 */
  installed: boolean;
}

/**
 * 候选清单。
 *
 * ⚠ 这里的 `output` 是**实际产物形态**, 不是技能自称的 ——
 *   `paper-slide-deck` 的描述里写着 slide, 但它走 T2I 出图, 图片烘进版式后**不可编辑**;
 *   一个要改字的用户拿到它只会困惑。所以显式标成 images。
 *   同理 beamer 出的是 PDF。
 */
const CANDIDATES: Omit<PptSkillCandidate, "installed">[] = [
  {
    id: "nature-paper2ppt",
    label: "Nature 论文转 PPT",
    output: "pptx",
    outputLabel: "可编辑 .pptx（含讲稿备注）",
    bestFor: "论文 / 预印本 / 组会汇报 —— 从原文做一整套带讲稿的汇报稿，自动裁剪原图",
    caveat: "耗时 5–10 分钟，按模型调用计费；中文汇报向，输出为中文",
  },
  {
    id: "scientific-slides",
    label: "学术幻灯片",
    output: "pptx",
    outputLabel: "按技能模板产出",
    bestFor: "需要按会议时长分配内容、控制叙事节奏的学术报告",
  },
  {
    id: "scholar-slides",
    label: "学者汇报幻灯片",
    output: "pptx",
    outputLabel: "按技能模板产出",
    bestFor: "学位答辩 / 学术交流，偏学术表达规范",
  },
  {
    id: "paper-slide-deck",
    label: "论文图解卡片（图片）",
    output: "images",
    outputLabel: "⚠ 只有图片，不可编辑文字",
    bestFor: "做视觉化图解 / 社交媒体长图，不需要在 PowerPoint 里改字",
    caveat: "走文生图路线，17 种视觉风格；产出是图片，不是可编辑幻灯片",
  },
  {
    id: "beamer-presentation",
    label: "Beamer 演示（LaTeX）",
    output: "pdf",
    outputLabel: "⚠ LaTeX 排版，产出 PDF 不是 pptx",
    bestFor: "用 LaTeX 写讲稿、要数学公式精排的学术报告",
    caveat: "产物是 PDF；要改内容得改 LaTeX 源",
  },
];

/** skills-service 扫的是用户目录 —— 直接用它的判断, 不自己拼路径 */
export function listPptSkills(): PptSkillCandidate[] {
  return CANDIDATES.map((c) => {
    let installed = false;
    try { installed = !!getSkillDetail(c.id); } catch { installed = false; }
    return { ...c, installed };
  });
}

/** 本机是否装了任何一条**能产出 pptx** 的技能 —— 决定"技能路径"这个 tab 要不要显示 */
export function hasAnyPptSkill(): boolean {
  return listPptSkills().some((c) => c.installed);
}

/**
 * 给用户的一句话交代 —— 第二条路径与快路的差别。
 *
 * 这段文案是**功能的一部分**, 不是装饰: 用户点"用技能生成"时,
 * 若不告诉他"这要 5-10 分钟且花钱", 他会以为界面卡死了。
 */
export const SKILL_PATH_NOTE =
  "技能路径会把这篇稿子的原文交给所选技能执行 —— 由 Agent 按技能的完整指令逐页构建，" +
  "通常数分钟（nature-paper2ppt 官方给的估算是 5–10 分钟）并按模型调用计费。" +
  "与上面的「大纲 → 脚本 → 配图」快路相比：快路几十秒出稿、每一页都能单独重生成；" +
  "技能路径更慢也更贵，但成品是技能作者迭代过很多轮的版式与叙事结构。";

export interface SkillPromptInput {
  skillId: string;
  title: string;
  topic?: string;
  /** 源文本(论文正文/大纲)。nature-paper2ppt 这类技能要靠它做叙事抽取 */
  sourceText?: string;
  /** 期望页数 */
  wishPages?: number;
  /** 额外要求(风格/受众/时长) */
  extra?: string;
}

/**
 * 组装交给 Agent 的**任务描述**。
 *
 * ⚠ 这里刻意**不复制 SKILL.md 的内容** —— 只写"去加载哪个技能 + 这次的具体要求"。
 *   理由: `view_skill_run` 会把 SKILL.md 全文(最多 16000 字)注入, 我们再抄一份,
 *   两边迟早不一致; 而且技能内容更新后我们的副本就是**旧指令**,
 *   Agent 会按旧版执行却不报错。指路, 不代抄。
 */
export function buildSkillPrompt(input: SkillPromptInput): { ok: boolean; error?: string; prompt?: string } {
  const c = listPptSkills().find((x) => x.id === input.skillId);
  if (!c) return { ok: false, error: `未知 PPT 技能: ${input.skillId}` };
  if (!c.installed) return { ok: false, error: `本机没有安装技能「${c.label}」(${c.id})，请先在技能库中安装` };
  if (!input.title.trim()) return { ok: false, error: "缺少演示稿标题" };

  const src = String(input.sourceText ?? "").trim();
  const asked = [
    input.topic?.trim() ? `主题/来源: ${input.topic.trim()}` : "",
    input.wishPages ? `期望页数: 约 ${input.wishPages} 页(技能有自己的叙事结构, 页数以它的判断为准, 这只是参考)` : "",
    input.extra?.trim() ? `额外要求: ${input.extra.trim()}` : "",
  ].filter(Boolean);

  const prompt = [
    `用技能 \`${input.skillId}\` 制作一份演示稿。`,
    "",
    `演示稿标题: ${input.title.trim()}`,
    ...asked,
    "",
    src
      ? `源文本如下(${src.replace(/\s/g, "").length} 字):\n\n---\n${src}\n---`
      : "没有提供源文本 —— 若该技能要求源材料(如论文原文), 请先说明缺什么, 不要自行编造内容。",
    "",
    `产物要求: ${c.outputLabel}。`,
    c.caveat ? `注意: ${c.caveat}` : "",
    "",
    "先把 SKILL.md 完整读一遍再动手 —— 不要凭记忆套用该技能的流程。",
    "完成后把产出的文件路径报出来。",
  ].filter((x) => x !== "").join("\n");

  return { ok: true, prompt };
}

/** 技能目录是否真的存在于本机(诊断用) */
export function skillPathExists(skillId: string): boolean {
  try {
    const d = getSkillDetail(skillId);
    return !!d && existsSync(d.skillMdPath);
  } catch { return false; }
}
