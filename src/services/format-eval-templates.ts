// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// format-eval-templates.ts — 论文格式智能评测: 结构化模板体系(2026-09-03)
// 取代 paper-quality FORMAT_RULES 的字符串数组: 每条规则可程序化取值,
// 支持检测/评分/自定义模板(前端内联 JSON)。规则引擎按模板参数化运行。
// 场景: 本科/硕士/博士毕业论文、职称论文、期刊论文(GB/T 7714)、技术报告。

export type HeadingPattern = "chapter-x.x" | "cn-seq";

export interface FormatTemplate {
  id: string;
  name: string;
  scope: string; // 本科/硕士/博士/职称/期刊/报告
  builtin: boolean;
  headingPattern: HeadingPattern;
  abstract: { required: boolean; min: number; max: number }; // 字数(中文计数)
  keywords: { required: boolean; min: number; max: number; separator: "；" | "," | ";" };
  requiredSections: string[]; // 模板要求的章节(缺失检测)
  citationStyle: "numeric" | "author-year"; // 正文标注风格
  referencesRequired: boolean;
  figureCaptionBelow: boolean; // 图题在下方、表题在上方
  sectionAliases?: Record<string, string[]>; // 对章节名的宽容变体(如 绪论/引言)
  humanCheckNotes: string[]; // 字体/行距等文本不可见项 → 报告提示人工核对
}

function tpl(partial: Omit<FormatTemplate, "builtin">): FormatTemplate {
  return { ...partial, builtin: true };
}

export const BUILTIN_TEMPLATES: FormatTemplate[] = [
  tpl({
    id: "undergrad-thesis",
    name: "本科毕业论文",
    scope: "本科",
    headingPattern: "chapter-x.x",
    abstract: { required: true, min: 200, max: 400 },
    keywords: { required: true, min: 3, max: 5, separator: "；" },
    requiredSections: ["摘要", "Abstract", "目录", "引言", "结论", "参考文献"],
    citationStyle: "numeric",
    referencesRequired: true,
    figureCaptionBelow: true,
    sectionAliases: {
      "引言": ["绪论", "导言", "前言", "1 引言"],
      "结论": ["结语", "结束语", "总结", "结束语"],
    },
    humanCheckNotes: [
      "正文建议宋体小四、行距 1.5 倍, 需在 Word 中人工核对(纯文本不可见)",
      "页边距与页码格式建议参照学校模板, 无法从文本检测",
    ],
  }),
  tpl({
    id: "master-thesis",
    name: "硕士学位论文",
    scope: "硕士",
    headingPattern: "chapter-x.x",
    abstract: { required: true, min: 300, max: 500 },
    keywords: { required: true, min: 3, max: 5, separator: "；" },
    requiredSections: ["摘要", "Abstract", "目录", "引言", "结论", "参考文献", "致谢"],
    citationStyle: "numeric",
    referencesRequired: true,
    figureCaptionBelow: true,
    sectionAliases: {
      "引言": ["绪论", "导言", "前言", "1 绪论"],
      "结论": ["结语", "总结"],
    },
    humanCheckNotes: [
      "正文建议宋体小四、行距 1.5 倍或固定值 20 磅, 需在 Word 中人工核对",
      "学位论文建议用页下注(脚注), 请核对脚注设置",
    ],
  }),
  tpl({
    id: "phd-thesis",
    name: "博士学位论文",
    scope: "博士",
    headingPattern: "chapter-x.x",
    abstract: { required: true, min: 500, max: 800 },
    keywords: { required: true, min: 3, max: 5, separator: "；" },
    requiredSections: ["摘要", "Abstract", "目录", "引言", "结论", "参考文献", "致谢", "攻读学位期间的研究成果"],
    citationStyle: "numeric",
    referencesRequired: true,
    figureCaptionBelow: true,
    sectionAliases: {
      "引言": ["绪论", "导言", "前言"],
      "结论": ["结语", "总结"],
    },
    humanCheckNotes: [
      "博士论文摘要 500-800 字, 需 Word 中核对字体(宋体小四/黑体标题)",
      "独创性声明与授权使用声明为学校固定页, 请在 Word 版核对",
    ],
  }),
  tpl({
    id: "title-paper",
    name: "职称论文",
    scope: "职称",
    headingPattern: "cn-seq",
    abstract: { required: true, min: 150, max: 300 },
    keywords: { required: true, min: 3, max: 5, separator: "；" },
    requiredSections: ["摘要", "关键词", "引言", "参考文献"],
    citationStyle: "author-year",
    referencesRequired: true,
    figureCaptionBelow: true,
    sectionAliases: {
      "引言": ["绪论", "导言", "前言", "一、引言"],
    },
    humanCheckNotes: [
      "职称论文通常要求正文字数 5000-10000, 请在 Word 统计后人工核对",
      "作者单位/职称信息占位符请按期刊要求填写",
    ],
  }),
  tpl({
    id: "journal-gb7714",
    name: "期刊论文(GB/T 7714)",
    scope: "期刊",
    headingPattern: "cn-seq",
    abstract: { required: true, min: 150, max: 300 },
    keywords: { required: true, min: 3, max: 5, separator: "；" },
    requiredSections: ["摘要", "关键词", "引言", "参考文献"],
    citationStyle: "numeric",
    referencesRequired: true,
    figureCaptionBelow: true,
    sectionAliases: {
      "引言": ["绪论", "导言", "前言"],
    },
    humanCheckNotes: [
      "期刊投稿通常要求宋体五号/固定行距, 请在排版软件中按编辑部要求核对",
      "参考文献著录格式需严格 GB/T 7714-2015, 建议用文献管理软件生成",
    ],
  }),
  tpl({
    id: "tech-report",
    name: "技术报告",
    scope: "报告",
    headingPattern: "chapter-x.x",
    abstract: { required: false, min: 0, max: 0 },
    keywords: { required: false, min: 0, max: 0, separator: "；" },
    requiredSections: ["目录", "引言", "结论", "参考文献"],
    citationStyle: "numeric",
    referencesRequired: false,
    figureCaptionBelow: true,
    sectionAliases: {
      "引言": ["概述", "背景", "前言"],
      "结论": ["总结", "展望"],
    },
    humanCheckNotes: [
      "技术报告无强制字体要求, 请按企业模板核对页眉/密级/编号",
    ],
  }),
];

export function resolveTemplate(
  templateId?: string,
  inline?: Partial<FormatTemplate>,
): FormatTemplate {
  // 自定义内联模板: 以指定内置模板为底稿, 覆盖传入字段
  const base = inline?.id
    ? BUILTIN_TEMPLATES.find((t) => t.id === inline.id)
    : undefined;
  const builtin = base ?? BUILTIN_TEMPLATES.find((t) => t.id === templateId)
    ?? BUILTIN_TEMPLATES.find((t) => t.id === "undergrad-thesis")!;
  if (!inline) return builtin;
  return {
    ...builtin,
    ...inline,
    builtin: false,
    abstract: { ...builtin.abstract, ...(inline.abstract ?? {}) },
    keywords: { ...builtin.keywords, ...(inline.keywords ?? {}) },
    sectionAliases: inline.sectionAliases ?? builtin.sectionAliases,
    humanCheckNotes: inline.humanCheckNotes ?? builtin.humanCheckNotes,
  };
}
