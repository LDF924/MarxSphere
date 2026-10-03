// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// ScenariosPanel.tsx — 科研场景全景（研究全生命周期，V255 重构）
// 按研究阶段分组：选题构思 → 文献调研 → 证据检索 → 数据分析 → 论文写作 → 图表制作 → 评审发表 → 系统自动化
// 每个场景 = 业务描述 + 独有能力徽章（真实实现提取）+ 动作（view=跳转Tab / skill=跳转技能面板）
import type { FC } from "react";
import { useState } from "react";
import {
  BookOpen, Sparkles, Search, Library, ExternalLink, BookOpenCheck, FileText, Scale, Database,
  FolderOpen, ArrowRight, Lightbulb, PenLine, BarChart3, GraduationCap, Users, FlaskConical, ShieldCheck, Play, GitBranch, Target
} from "lucide-react";
import { cn } from "../lib/utils";
import { ScenariosWorkbench, type ScenarioStep } from "./ScenariosWorkbench";
import { SCENARIO_GUIDES } from "../lib/scenario-guides";

/**
 * 场景可以跳去哪个工作台。
 *
 * ⚠ 2026-09-29 从 12 个扩到 21 个: 此前只有 12 个视图, 于是 9 月新增的五个工作台
 *   **没法被任何场景指向** —— 场景里根本写不出"去写作舱做这件事"。
 *   每加一个新 tab 就该同步这里(以及 `App.tsx` 的 validViews 与 ScenariosWorkbench 的 TOOL_NAMES)。
 */
export type ScenarioView =
  | "reason" | "literature" | "ask" | "truth" | "sciverse" | "skills" | "graph"
  | "policy" | "vault" | "jobs" | "documents" | "cjournal"
  | "paper-outline" | "dag-workbench" | "review-lab" | "plot-agent" | "editor"
  | "education" | "corpus" | "statistics" | "imports"
  | "format-eval" | "citation-verify"
  // 2026-10-03 补: 10-02 落地的六个视图此前**写不进来**, 于是新能力在场景页集体缺席 ——
  //   研究速递(订阅推送) / 舆情检索 / Skill 广场 / PPT 工作台 / AIGC 检测 / 文献导入。
  //   与 2026-09-29 那次是同一个病: tab 进了导航, 但进到它的入口没同步。
  //   ⚠ 本段注释**不能出现成对的英文双引号** —— test/scenarios.test.ts 用正则从这个联合类型里
  //     抓所有引号内的字符串当视图名, 注释里的引号会被当成一个不存在的视图而报死链。
  | "digest" | "opinion" | "ppt-workbench" | "aigc-detect" | "lit-import";

interface Scenario {
  id: string;
  group: string;
  key: ScenarioView;
  title: string;
  desc: string;
  hint: string;
  icon: React.ReactNode;
  tag: string;
  /** 该场景独有的能力流程（真实实现提取） */
  capabilities: string[];
}

interface ScenariosPanelProps {
  onChangeView: (view: ScenarioView) => void;
}

export const SCENARIOS: Scenario[] = [
  // ═══ 一、选题构思 ═══
  {
    id: "S01",
    group: "选题构思",
    key: "skills",
    title: "研究方向生成",
    desc: "从兴趣/趋势出发，生成并评估候选研究方向",
    hint: "research-ideation · idea-evaluator 五维评估",
    icon: <Lightbulb className="h-4.5 w-4.5" />,
    tag: "选题",
    capabilities: ["研究创意生成", "五维评估(新颖/可行/重要)", "范式匹配", "致命缺陷审计"]
  },
  {
    id: "S02",
    group: "选题构思",
    key: "skills",
    title: "科学头脑风暴",
    desc: "多角度发散讨论研究问题，挑战假设",
    hint: "scientific-brainstorming · scientific-critical-thinking",
    icon: <Sparkles className="h-4.5 w-4.5" />,
    tag: "发散",
    capabilities: ["多视角发散", "假设挑战", "逻辑漏洞检测", "科学思维训练"]
  },
  {
    id: "S03",
    group: "选题构思",
    key: "skills",
    title: "研究设计规划",
    desc: "实验设计、样本量计算、方法选择",
    hint: "experimental-design · statistical-power",
    icon: <FlaskConical className="h-4.5 w-4.5" />,
    tag: "设计",
    capabilities: ["随机化/分组设计", "功效分析", "混杂控制", "因果识别策略"]
  },
  {
    id: "S04",
    group: "选题构思",
    key: "skills",
    title: "开题报告规划",
    desc: "结构化开题：研究问题/文献基础/方法/进度",
    hint: "lit-search 查全 → 综述 → 开题框架",
    icon: <GraduationCap className="h-4.5 w-4.5" />,
    tag: "开题",
    capabilities: ["近 N 年文献查全", "PRISMA 计量", "研究缺口定位", "开题框架生成"]
  },

  // ═══ 二、文献调研 ═══
  {
    id: "S05",
    group: "文献调研",
    key: "literature",
    title: "文献综述",
    desc: "从研究问题出发，自动检索、综合、生成带引用的文献综述",
    hint: "输入研究问题，AI 多源检索后生成带引用的综述",
    icon: <BookOpen className="h-4.5 w-4.5" />,
    tag: "综述",
    capabilities: ["问题拆解大纲", "Cognee 17 路粗检", "Graphiti 精炼", "超边知识层", "三臂 RRF 融合", "LLM 重排"]
  },
  {
    id: "S06",
    group: "文献调研",
    key: "literature",
    title: "系统性文献检索",
    desc: "时间窗全量检索+金标召回率评测（SLR 级）",
    hint: "lit-search · nature-academic-search · exa-search",
    icon: <Search className="h-4.5 w-4.5" />,
    tag: "检索",
    capabilities: ["时间窗全量覆盖", "金标召回评测", "多源交叉验证", "引文饱和检测"]
  },
  {
    id: "S07",
    group: "文献调研",
    key: "sciverse",
    title: "外部学术检索",
    desc: "语义/结构化/引文关系/读全文四工具",
    hint: "Sciverse 4 工具 · 知网引文网络",
    icon: <ExternalLink className="h-4.5 w-4.5" />,
    tag: "外检",
    capabilities: ["语义检索 RAG", "结构化过滤", "引文滚雪球", "OA 读全文"]
  },
  {
    id: "S08",
    group: "文献调研",
    key: "truth",
    title: "研究证据包",
    desc: "把关键命题、证据、出处沉淀为知识页",
    hint: "Compiled Truth + 证据时间线",
    icon: <BookOpenCheck className="h-4.5 w-4.5" />,
    tag: "沉淀",
    capabilities: ["Compiled Truth 管理", "证据时间线", "TruthDiff 差异预览", "Claude Code 归纳桥"]
  },
  {
    id: "S09",
    group: "文献调研",
    key: "literature",
    title: "论文对比矩阵",
    desc: "多篇论文的研究范式、数据来源、核心结论对比",
    hint: "文献库多篇对比摘要/问答/术语表",
    icon: <Scale className="h-4.5 w-4.5" />,
    tag: "对比",
    capabilities: ["摘要对比", "研究范式对照", "结论差异定位", "术语表对比"]
  },
  {
    id: "S10",
    group: "文献调研",
    key: "ask",
    title: "引文溯源（Citation）",
    desc: "每个论断绑定真实出处，防幻觉、可核验",
    hint: "检索结果回链到本地图谱与原文",
    icon: <ShieldCheck className="h-4.5 w-4.5" />,
    tag: "溯源",
    capabilities: ["来源步骤标注", "原文分块回链", "超边来源溯源", "置信度标注"]
  },
  {
    id: "S11",
    group: "文献调研",
    key: "graph",
    title: "文献关系图谱",
    desc: "径向/力导向双视图探索实体-事件网络",
    hint: "知识图谱 · 关系查询 · 快速建联",
    icon: <Database className="h-4.5 w-4.5" />,
    tag: "图谱",
    capabilities: ["径向逐层展开", "d3 力导向", "关系查询", "三元组快速建联"]
  },
  {
    id: "S12",
    group: "文献调研",
    key: "policy",
    title: "政策文本检索",
    desc: "gov.cn 政策检索 + 课题政策库五维分类",
    hint: "政策资料库 · 法规定位",
    icon: <FileText className="h-4.5 w-4.5" />,
    tag: "政策",
    capabilities: ["gov.cn 检索", "五维分类", "法规原文定位", "政策→研究关联"]
  },

  // ═══ 三、证据检索 ═══
  {
    id: "S13",
    group: "证据检索",
    key: "ask",
    title: "科学问答（RAG）",
    desc: "基于文献证据回答问题，每个论断都有出处可回链",
    hint: "可视化检索链路，透明展示 AI 如何调取证据",
    icon: <Search className="h-4.5 w-4.5" />,
    tag: "问答",
    capabilities: ["多臂召回", "加权 RRF", "Boost 链", "Cosine 重打分", "Compiled Truth ×2.0", "引用溯源"]
  },
  {
    id: "S14",
    group: "证据检索",
    key: "reason",
    title: "多跳推理链",
    desc: "52 步推理链路：拆解→检索→推理→自评",
    hint: "推理工作台 · 多跳因果链",
    icon: <Sparkles className="h-4.5 w-4.5" />,
    tag: "推理",
    capabilities: ["问题分类", "大纲拆解", "四路分调", "COT 多跳推理", "假设自评", "失败自愈"]
  },
  {
    id: "S15",
    group: "证据检索",
    key: "ask",
    title: "教学与科研答疑",
    desc: "基于文献证据通俗讲解，适合教学与学习",
    hint: "提问后 AI 检索证据并给出带引用的解释",
    icon: <GraduationCap className="h-4.5 w-4.5" />,
    tag: "答疑",
    capabilities: ["意图识别", "术语变体扩展", "别名消解", "多查询改写", "证据化回答"]
  },
  {
    id: "S16",
    group: "证据检索",
    key: "literature",
    title: "全文证据查找",
    desc: "从检索片段定位到原文完整段落",
    hint: "切片→原文定位 · 摘要/问答/术语表",
    icon: <FileText className="h-4.5 w-4.5" />,
    tag: "证据",
    capabilities: ["切片→原文定位", "摘要/问答/术语表", "原文索引元数据", "PDF 原文对照"]
  },
  {
    id: "S17",
    group: "证据检索",
    key: "ask",
    title: "研究方向趋势扫描",
    desc: "按年份分布看主题演进，追踪研究前沿",
    hint: "文献库按年份筛选看主题演变",
    icon: <BarChart3 className="h-4.5 w-4.5" />,
    tag: "趋势",
    capabilities: ["年份分布视图", "主题演进追踪", "学者产出统计", "论文发表趋势"]
  },

  // ═══ 四、数据分析 ═══
  {
    id: "S18",
    group: "数据分析",
    key: "skills",
    title: "计量实证分析",
    desc: "回归/面板/DID/RDD/合成控制全流程",
    hint: "00.1-Python · 00.2-Stata · 00.3-R 三栈",
    icon: <BarChart3 className="h-4.5 w-4.5" />,
    tag: "计量",
    capabilities: ["M1-M6 渐进模型", "事件研究", "DID 双重差分", "安慰剂/稳健性检验", "出版级表格"]
  },
  {
    id: "S19",
    group: "数据分析",
    key: "skills",
    title: "因果推断",
    desc: "潜在结果框架 · 工具变量 · 断点回归",
    hint: "Mixtape 因果推断 · 10-Jill0099",
    icon: <FlaskConical className="h-4.5 w-4.5" />,
    tag: "因果",
    capabilities: ["潜在结果框架", "工具变量 IV", "RDD 断点", "合成控制", "敏感性分析"]
  },
  {
    id: "S20",
    group: "数据分析",
    key: "skills",
    title: "宏观经济建模",
    desc: "DSGE/HANK 数值计算 · 均衡求解",
    hint: "20-wenddymacro-python-econ-skill",
    icon: <Database className="h-4.5 w-4.5" />,
    tag: "建模",
    capabilities: ["DSGE 求解", "HANK 异质主体", "数值模拟", "脉冲响应"]
  },
  {
    id: "S21",
    group: "数据分析",
    key: "skills",
    title: "统计推断与检验",
    desc: "描述统计/诊断检验/生存分析",
    hint: "nature-statistics · 假设检验全家桶",
    icon: <BarChart3 className="h-4.5 w-4.5" />,
    tag: "统计",
    capabilities: ["描述统计", "正态/异方差诊断", "KM/Cox 生存", "Meta 分析"]
  },

  // ═══ 五、论文写作 ═══
  {
    id: "S22",
    group: "论文写作",
    key: "skills",
    title: "学术论文写作",
    desc: "12 智能体流水线：研究→写作→评审→修订",
    hint: "academic-paper · academic-pipeline",
    icon: <PenLine className="h-4.5 w-4.5" />,
    tag: "写作",
    capabilities: ["大纲/摘要/引言", "LaTeX/DOCX/PDF", "引用核验", "双重同行评审", "反驳信"]
  },
  {
    id: "S23",
    group: "论文写作",
    key: "skills",
    title: "文献综述写作",
    desc: "系统性综述 + 结构化学术写作",
    hint: "literature-review · section-writing-agent",
    icon: <BookOpen className="h-4.5 w-4.5" />,
    tag: "综述",
    capabilities: ["多库综合检索", "PRISMA 流程", "结构化写作", "引文格式"]
  },
  {
    id: "S24",
    group: "论文写作",
    key: "skills",
    title: "论文润色与改写",
    desc: "中英文学术润色 · 仿写风格校准",
    hint: "paper-polish · nature-polishing",
    icon: <PenLine className="h-4.5 w-4.5" />,
    tag: "润色",
    capabilities: ["学术语体校准", "中英互译润色", "查重规避", "逻辑连贯性"]
  },
  {
    id: "S25",
    group: "论文写作",
    key: "skills",
    title: "引用管理",
    desc: "BibTeX 生成 · 引用核验 · 防幻觉引用",
    hint: "citation-management · citation-verification",
    icon: <Scale className="h-4.5 w-4.5" />,
    tag: "引文",
    capabilities: ["BibTeX 生成", "DOI 元数据校验", "假引用检测", "全库引用核对"]
  },

  // ═══ 六、图表制作 ═══
  {
    id: "S26",
    group: "图表制作",
    key: "skills",
    title: "科研图表设计",
    desc: "三图范式（动机图/方法图/结果图）",
    hint: "figure-designer · scientific-figure",
    icon: <BarChart3 className="h-4.5 w-4.5" />,
    tag: "图表",
    capabilities: ["Figure1 动机图", "方法流程图", "结果对比图", "QC 审计"]
  },
  {
    id: "S27",
    group: "图表制作",
    key: "skills",
    title: "可视化与幻灯片",
    desc: "数据可视化 + 学术汇报 PPT",
    hint: "scientific-visualization · scholar-slides",
    icon: <BarChart3 className="h-4.5 w-4.5" />,
    tag: "演示",
    capabilities: ["数据可视化", "学术幻灯片", "海报设计", "汇报脚本"]
  },

  // ═══ 七、评审发表 ═══
  {
    id: "S28",
    group: "评审发表",
    key: "skills",
    title: "同行评审模拟",
    desc: "5 视角评审（期刊适配+3 同行+魔鬼代言人）",
    hint: "academic-paper-reviewer · peer-review",
    icon: <Users className="h-4.5 w-4.5" />,
    tag: "评审",
    capabilities: ["5 视角模拟", "期刊适配评估", "方法论审查", "复评验证"]
  },
  {
    id: "S29",
    group: "评审发表",
    key: "skills",
    title: "投稿前检查",
    desc: "预提交清单 · 完整性审计 · 免责审查",
    hint: "pre-submission-reviewer · paper-self-review",
    icon: <ShieldCheck className="h-4.5 w-4.5" />,
    tag: "检查",
    capabilities: ["预提交清单", "完整性审计", "伦理披露", "作者贡献声明"]
  },
  {
    id: "S30",
    group: "评审发表",
    key: "skills",
    title: "审稿意见回应",
    desc: "审稿回复信 · 逐条回应 · 修订稿",
    hint: "review-response · nature-response",
    icon: <PenLine className="h-4.5 w-4.5" />,
    tag: "回应",
    capabilities: ["逐条回应", "反驳论证", "修订说明", "重投策略"]
  },
  {
    id: "S31",
    group: "评审发表",
    key: "skills",
    title: "基金申报",
    desc: "研究计划书 · 立项依据 · 预算",
    hint: "research-proposal · research-grants",
    icon: <Sparkles className="h-4.5 w-4.5" />,
    tag: "基金",
    capabilities: ["计划书框架", "立项依据论证", "预算编制", "评审要点覆盖"]
  },

  // ═══ 八、系统自动化 ═══
  {
    id: "S32",
    group: "系统自动化",
    key: "documents",
    title: "外部文献入库衔接",
    desc: "网页/文献转 PDF，清洗后入库本地图谱",
    hint: "网页转 PDF → 解析 → 三库入库",
    icon: <ExternalLink className="h-4.5 w-4.5" />,
    tag: "入库",
    capabilities: ["网页/EPUB 转 PDF", "pdf2obsidian 解析", "三库联动入库", "幂等去重", "断点续传"]
  },
  {
    id: "S33",
    group: "系统自动化",
    key: "jobs",
    title: "知识库自动化",
    desc: "多类后台任务 · Dream Cycle 自整理",
    hint: "Jobs 队列 · 入库/向量化/清洗/自整理",
    icon: <Database className="h-4.5 w-4.5" />,
    tag: "自动化",
    capabilities: ["批量入库", "向量化/索引", "孤儿清理", "Dream Cycle 自整理", "任务队列可视化"]
  },
  {
    id: "S34",
    group: "系统自动化",
    key: "vault",
    title: "Obsidian 资料管理",
    desc: "课题资料树浏览 · md/PDF/Office 预览",
    hint: "资料库 · 左树右文",
    icon: <FolderOpen className="h-4.5 w-4.5" />,
    tag: "资料",
    capabilities: ["目录树浏览", "Markdown 渲染", "PDF/图片预览", "Office 下载"]
  },
  {
    id: "S35",
    group: "系统自动化",
    key: "documents",
    title: "文档管理",
    desc: "批量上传入库 · 重命名/归档/级联删除",
    hint: "文档管理 · 数据治理",
    icon: <FileText className="h-4.5 w-4.5" />,
    tag: "治理",
    capabilities: ["批量上传", "重命名/归档", "级联删除", "去重"]
  },

  // ═══ 九、经典文本研究（马理论专用）═══
  {
    id: "S36",
    group: "经典文本研究",
    key: "reason",
    title: "核心概念溯源与语义演变",
    desc: "追踪概念（资本/意识形态/市民社会）从起源到不同历史阶段的语义变化，定位原始出处",
    hint: "概念溯源 · 跨文本语义演变 · 语境差异区分",
    icon: <BookOpenCheck className="h-4.5 w-4.5" />,
    tag: "溯源",
    capabilities: ["语义演变阶段归纳", "原始出处定位", "语境内涵差异区分", "原文引用标注"]
  },
  {
    id: "S37",
    group: "经典文本研究",
    key: "reason",
    title: "文本论证结构拆解",
    desc: "对经典著作自动划分逻辑层次，梳理从前提到结论的完整论证链条",
    hint: "论证拆解 · 逻辑层次 · 前提-结论链",
    icon: <Scale className="h-4.5 w-4.5" />,
    tag: "拆解",
    capabilities: ["逻辑层次划分", "论证链条梳理", "论证类型标注", "原文段落对应"]
  },
  {
    id: "S38",
    group: "经典文本研究",
    key: "reason",
    title: "多文本互文对照",
    desc: "同一主题下不同经典作家文本对比，或不同译本译法分歧标注",
    hint: "互文对照 · 版本对比 · 译法分歧",
    icon: <Library className="h-4.5 w-4.5" />,
    tag: "对照",
    capabilities: ["多文本同题对比", "表述差异分析", "译法分歧标注", "观点侧重识别"]
  },
  {
    id: "S39",
    group: "经典文本研究",
    key: "reason",
    title: "晦涩文本阐释辅助",
    desc: "哲学/理论晦涩段落的逻辑拆解与通俗化重述，标注学界主流解读与争议点",
    hint: "文本阐释 · 通俗重述 · 学界解读",
    icon: <Lightbulb className="h-4.5 w-4.5" />,
    tag: "阐释",
    capabilities: ["命题逻辑拆解", "通俗化重述", "学界解读标注", "原文出处绑定"]
  },
  {
    id: "S40",
    group: "经典文本研究",
    key: "documents",
    title: "版本校勘与文本差异",
    desc: "识别手稿版/全集版/单行本/不同译本的文字差异，标注删改与增补",
    hint: "版本校勘 · 差异识别 · 删改标注",
    icon: <ShieldCheck className="h-4.5 w-4.5" />,
    tag: "校勘",
    capabilities: ["多版本比对", "删改/增补标注", "差异类型识别", "文字考证辅助"]
  },

  // ═══ 十、学术研究（学派/观点/争鸣/谱系/前沿）═══
  {
    id: "S41",
    group: "学术研究",
    key: "reason",
    title: "学派脉络全景梳理",
    desc: "梳理理论流派起源、代表人物、核心命题、发展阶段、内部分歧与后世影响",
    hint: "学派脉络 · 思想演进 · 师承关系",
    icon: <GitBranch className="h-4.5 w-4.5" />,
    tag: "学派",
    capabilities: ["起源与背景", "代表人物梳理", "发展阶段归纳", "师承关系图"]
  },
  {
    id: "S42",
    group: "学术研究",
    key: "reason",
    title: "核心观点对比分析",
    desc: "同一问题横向对比不同学者/学派的观点、论证逻辑与立场，输出结构化对照表",
    hint: "观点对比 · 共识与争议 · 论据支撑",
    icon: <Scale className="h-4.5 w-4.5" />,
    tag: "对比",
    capabilities: ["观点对照表", "论证逻辑比较", "共识/争议识别", "观点聚类"]
  },
  {
    id: "S43",
    group: "学术研究",
    key: "reason",
    title: "学术争鸣脉络还原",
    desc: "识别核心学术论战，梳理正反双方代表人物、核心论据、回合交锋与后续影响",
    hint: "争鸣还原 · 回合交锋 · 论战时间线",
    icon: <Users className="h-4.5 w-4.5" />,
    tag: "争鸣",
    capabilities: ["问题缘起定位", "正反方梳理", "交锋回合还原", "时间线可视化"]
  },
  {
    id: "S44",
    group: "学术研究",
    key: "reason",
    title: "学者思想谱系构建",
    desc: "梳理学者思想发展历程、阶段代表作、观点演变，识别师承与理论来源",
    hint: "学者谱系 · 思想演变 · 师承网络",
    icon: <GraduationCap className="h-4.5 w-4.5" />,
    tag: "谱系",
    capabilities: ["思想阶段梳理", "代表作定位", "师承识别", "影响评估"]
  },
  {
    id: "S45",
    group: "学术研究",
    key: "reason",
    title: "学科前沿动态追踪",
    desc: "汇总 CSSCI/核心期刊研究热点、新兴议题、方法转向，识别高频关键词",
    hint: "前沿追踪 · 高频词 · 热点识别",
    icon: <BarChart3 className="h-4.5 w-4.5" />,
    tag: "前沿",
    capabilities: ["研究热点汇总", "高频关键词", "新兴议题识别", "前沿简报"]
  },

  // ═══ 十一、论文写作与研究设计（S46-S50）═══
  {
    id: "S46",
    group: "论文写作研究",
    key: "reason",
    title: "研究问题凝练与空白识别",
    desc: "基于文献库总结研究现状，明确已解决/争议/空白问题，提炼有价值的研究问题",
    hint: "问题凝练 · 空白识别 · 选题价值",
    icon: <Lightbulb className="h-4.5 w-4.5" />,
    tag: "凝练",
    capabilities: ["研究现状总结", "空白识别", "争议问题定位", "主题覆盖矩阵"]
  },
  {
    id: "S47",
    group: "论文写作研究",
    key: "reason",
    title: "研究框架与论证结构设计",
    desc: "按研究类型推荐论文结构（理论研究/实证/历史/比较/文本/政策），拆解章节论证任务",
    hint: "框架设计 · 结构模板 · 逻辑骨架",
    icon: <PenLine className="h-4.5 w-4.5" />,
    tag: "框架",
    capabilities: ["结构模板匹配", "章节任务拆解", "逻辑骨架搭建", "设计理由说明"]
  },
  {
    id: "S48",
    group: "论文写作研究",
    key: "reason",
    title: "论证链条补全与逻辑校验",
    desc: "梳理论点→结论的推理步骤，识别逻辑断层，提示补充理论依据或实证支撑",
    hint: "论证补全 · 断层检测 · 逻辑校验",
    icon: <Scale className="h-4.5 w-4.5" />,
    tag: "论证",
    capabilities: ["推理链条梳理", "逻辑断层识别", "微观机制提示", "断层度量化"]
  },
  {
    id: "S49",
    group: "论文写作研究",
    key: "reason",
    title: "研究方法适配建议",
    desc: "按主题推荐全人文社科研究方法（文本/比较/历史/质性/定量），说明边界与误区",
    hint: "方法适配 · 适用边界 · 操作要点",
    icon: <FlaskConical className="h-4.5 w-4.5" />,
    tag: "方法",
    capabilities: ["方法推荐", "适用边界说明", "操作要点", "常见误区警示"]
  },
  {
    id: "S50",
    group: "论文写作研究",
    key: "reason",
    title: "反方视角与反驳意见生成",
    desc: "主动提供对立学派批评、逻辑反例、前提质疑，预判反驳完善论证",
    hint: "反方视角 · 前提质疑 · 预判反驳",
    icon: <Users className="h-4.5 w-4.5" />,
    tag: "反方",
    capabilities: ["对立批评生成", "逻辑反例", "前提弱化检测", "回应建议"]
  },

  // ═══ 十二、论文写作输出（S51-S55）═══
  {
    id: "S51",
    group: "论文写作输出",
    key: "reason",
    title: "高质量文献综述生成",
    desc: "按研究缘起-发展脉络-学派分歧-共识-不足结构生成综述初稿，每观点标注来源",
    hint: "综述生成 · 学术脉络 · 来源标注",
    icon: <BookOpen className="h-4.5 w-4.5" />,
    tag: "综述",
    capabilities: ["五段结构模板", "学术脉络呈现", "观点来源标注", "拒绝观点堆砌"]
  },
  {
    id: "S52",
    group: "论文写作输出",
    key: "reason",
    title: "学术段落扩写与润色",
    desc: "基于核心观点扩写为严谨学术段落，补充理论依据，去除口语化表达",
    hint: "段落扩写 · 术语体适配 · 口语检测",
    icon: <PenLine className="h-4.5 w-4.5" />,
    tag: "扩写",
    capabilities: ["学术段落扩写", "理论依据补充", "口语化检测", "规范表达改写"]
  },
  {
    id: "S53",
    group: "论文写作输出",
    key: "reason",
    title: "规范化学术要件生成",
    desc: "按期刊/学位要求生成摘要、关键词、引言、结论、英文摘要等要件初稿",
    hint: "学术要件 · 摘要引言 · 英文摘要",
    icon: <FileText className="h-4.5 w-4.5" />,
    tag: "要件",
    capabilities: ["摘要生成", "关键词提炼", "引言结论", "英文摘要"]
  },
  {
    id: "S54",
    group: "论文写作输出",
    key: "reason",
    title: "引文与参考文献格式化",
    desc: "支持 GB/T 7714、APA、MLA 格式自动生成参考文献列表并核对对应",
    hint: "引文格式 · GB/T 7714 · APA · MLA",
    icon: <Library className="h-4.5 w-4.5" />,
    tag: "引文",
    capabilities: ["三格式生成", "自动转换", "引文核对", "格式修正"]
  },
  {
    id: "S55",
    group: "论文写作输出",
    key: "reason",
    title: "多场景语体适配",
    desc: "适配期刊/学位/会议/理论宣传/课程论文的语体差异，调整严谨度与通俗度",
    hint: "语体适配 · 五场景规则库 · 口语检测",
    icon: <GraduationCap className="h-4.5 w-4.5" />,
    tag: "语体",
    capabilities: ["五场景语体库", "严谨度调整", "通俗度平衡", "口语化检测"]
  },

  // ═══ 十三、论文质量检查（S56-S60）═══
  {
    id: "S56",
    group: "论文质量检查",
    key: "reason",
    title: "概念一致性校验",
    desc: "全文扫描核心概念使用，识别内涵不一致、偷换概念，提示易混淆概念差异",
    hint: "概念校验 · 偷换概念 · 易混淆对",
    icon: <Scale className="h-4.5 w-4.5" />,
    tag: "概念",
    capabilities: ["内涵一致性扫描", "偷换概念识别", "易混淆概念库", "差异提示"]
  },
  {
    id: "S57",
    group: "论文质量检查",
    key: "reason",
    title: "引文准确性核查",
    desc: "核对引文与标注文献一致性，识别断章取义/误引/错标，检查直接间接引用规范",
    hint: "引文核查 · 误引识别 · 引用规范",
    icon: <Library className="h-4.5 w-4.5" />,
    tag: "引文",
    capabilities: ["引文-文献核对", "断章取义识别", "直接/间接规范", "对应关系检查"]
  },
  {
    id: "S58",
    group: "论文质量检查",
    key: "reason",
    title: "逻辑自洽性检查",
    desc: "识别逻辑矛盾、循环论证、论据不支撑论点、推理跳跃，标记薄弱环节",
    hint: "逻辑检查 · 循环论证 · 推理跳跃",
    icon: <GitBranch className="h-4.5 w-4.5" />,
    tag: "逻辑",
    capabilities: ["矛盾识别", "循环论证检测", "论据支撑检查", "推理跳跃标记"]
  },
  {
    id: "S59",
    group: "论文质量检查",
    key: "reason",
    title: "学术不端风险提示",
    desc: "识别未标注转述、大段重合表述，计算重合度，提示补充引文位置",
    hint: "不端风险 · 重合度计算 · 引文提示",
    icon: <ShieldCheck className="h-4.5 w-4.5" />,
    tag: "诚信",
    capabilities: ["N-gram重合度", "长段重合定位", "未标注转述检测", "引文补充提示"]
  },
  {
    id: "S60",
    group: "论文质量检查",
    key: "reason",
    title: "格式规范适配",
    desc: "适配期刊/学位/党校/高校学报格式，统一标题层级、字体行距、脚注参考文献",
    hint: "格式适配 · 规则库 · 标题层级",
    icon: <FileText className="h-4.5 w-4.5" />,
    tag: "格式",
    capabilities: ["格式规则库", "标题层级适配", "字体行距统一", "参考文献格式"]
  },

  // ═══ 十四、理论思辨拓展（S61-S65）═══
  {
    id: "S61",
    group: "理论思辨拓展",
    key: "reason",
    title: "理论前提反思",
    desc: "揭示研究的默认理论预设、价值立场与认识论前提，分析合理性，提供替代视角",
    hint: "前提反思 · 认识论 · 替代范式",
    icon: <Scale className="h-4.5 w-4.5" />,
    tag: "前提",
    capabilities: ["理论预设揭示", "价值立场识别", "认识论前提分析", "替代范式提供"]
  },
  {
    id: "S62",
    group: "理论思辨拓展",
    key: "reason",
    title: "跨学科视角拓展",
    desc: "引入社会学/政治学/法学等相邻学科的理论资源与分析框架，丰富研究视角",
    hint: "跨学科 · 学科映射 · 交叉框架",
    icon: <GitBranch className="h-4.5 w-4.5" />,
    tag: "交叉",
    capabilities: ["学科映射库", "理论框架引入", "融合洞见", "适用边界"]
  },
  {
    id: "S63",
    group: "理论思辨拓展",
    key: "reason",
    title: "理论与现实联结",
    desc: "搭建理论命题-现实案例-机制分析的桥梁，用抽象理论分析现实问题",
    hint: "理论应用 · 案例匹配 · 机制分析",
    icon: <Lightbulb className="h-4.5 w-4.5" />,
    tag: "联结",
    capabilities: ["理论命题拆解", "案例相似匹配", "机制分析", "适用边界"]
  },
  {
    id: "S64",
    group: "理论思辨拓展",
    key: "reason",
    title: "理论创新点识别",
    desc: "识别现有研究的理论局限与可创新空间（概念/视角/方法/框架），评估学术价值",
    hint: "创新识别 · 研究空间 · 学术价值",
    icon: <Sparkles className="h-4.5 w-4.5" />,
    tag: "创新",
    capabilities: ["创新信号扫描", "理论局限识别", "四类创新点", "创新定位"]
  },
  {
    id: "S65",
    group: "理论思辨拓展",
    key: "reason",
    title: "理论体系建构",
    desc: "将分散命题整合为自洽理论框架，检测体系一致性，识别薄弱环节",
    hint: "体系建构 · 概念网络 · 自洽性",
    icon: <Database className="h-4.5 w-4.5" />,
    tag: "建构",
    capabilities: ["命题整合", "核心概念定义", "逻辑关系梳理", "一致性检测"]
  },
  {
    id: "S66",
    group: "政经C刊科研",
    key: "cjournal",
    title: "政经C刊选题",
    desc: "基于马理论C刊选题方法论（四步法/理论接口/选题矩阵/悖论/编辑校验）生成有发表潜力的选题",
    hint: "四步法 · 理论接口 · 选题矩阵 · 悖论 · 编辑校验",
    icon: <Target className="h-4.5 w-4.5" />,
    tag: "选题",
    capabilities: ["四步法选题", "理论接口映射", "选题矩阵", "悖论选题", "编辑三标准校验"]
  },

  // ═══ 十六、写作舱与工作台（2026-09-29 补）═══
  //
  // 由来(用户:「科研中心里的场景需要更新」): 上面 66 条最后实质改动是 2026-08-15,
  //   而**9 月之后新增的十二项能力一条都没进场景** —— 写作舱六个 tab、编排画布、
  //   评审台、可视化工坊、编辑器、教育、语料库、统计台、文献管理。
  //   用户在场景页找不到它们, 只能靠记得住导航路径。
  //
  // 每条都按"用户真会这么问"写, 并且**跳转是真的**(key 指向对应工作台视图)。
  {
    id: "S67",
    group: "写作舱与工作台",
    key: "paper-outline",
    title: "研途写作舱全流程",
    desc: "把一篇论文从选题界定做到统稿定稿：六步阶段 + 章节写作 + 素材/证据/假设台账",
    hint: "选题界定 → 框架设计 → 研究实施 → 文献与资料 → 章节写作 → 统稿定稿",
    icon: <PenLine className="h-4.5 w-4.5" />,
    tag: "写作舱",
    capabilities: ["六步阶段推进", "章节树与正文写作", "素材库/证据账本/假设台账", "版本历史与回档", "素材按章过滤"]
  },
  {
    id: "S68",
    group: "写作舱与工作台",
    key: "paper-outline",
    title: "投稿要件与数据可得性",
    desc: "生成摘要/结论/讨论等要件，补齐作者贡献、利益冲突、致谢、基金、数据可得性五项声明",
    hint: "要件生成 · 声明齐备性检查 · 导出时一并带上",
    icon: <FileText className="h-4.5 w-4.5" />,
    tag: "要件",
    capabilities: ["摘要/关键词/结论/讨论生成", "五项声明落库", "缺失项检查", "导出 Word 带声明"]
  },
  {
    id: "S69",
    group: "写作舱与工作台",
    key: "paper-outline",
    title: "开题 · 基金 · 伦理 · 预注册",
    desc: "开题报告、基金申报书、伦理审查、预注册四类申报稿，各按固定节次结构化产出",
    hint: "四类申报 × 七节结构 · 与写作舱同源",
    icon: <GraduationCap className="h-4.5 w-4.5" />,
    tag: "申报",
    capabilities: ["开题报告七节", "基金立项依据/方案/预算", "伦理声明", "预注册文稿"]
  },
  {
    id: "S70",
    group: "写作舱与工作台",
    key: "dag-workbench",
    title: "课题流程编排",
    desc: "用自然语言描述研究流程，生成可执行 DAG，节点可单步跑、整条跑、暂停续跑",
    hint: "对话式编排 · 能力表 191 项 · 事件流可回放",
    icon: <GitBranch className="h-4.5 w-4.5" />,
    tag: "编排",
    capabilities: ["nl-to-dag 生成", "单步/整条执行", "运行控制与恢复", "事件流与计划历史", "画布图存取"]
  },
  {
    id: "S71",
    group: "写作舱与工作台",
    key: "review-lab",
    title: "论文质量评审",
    desc: "按期刊标准分段审稿，逐维度评分卡 + 大修/小修问题清单 + 原文批注",
    hint: "分钟级后台跑 · 期刊库 80 本 · 审稿历史可重审",
    icon: <ShieldCheck className="h-4.5 w-4.5" />,
    tag: "评审",
    capabilities: ["分段审阅", "多维评分卡", "原文批注", "审稿历史与重审链", "报告导出"]
  },
  {
    id: "S72",
    group: "写作舱与工作台",
    key: "review-lab",
    title: "期刊投稿须知解析",
    desc: "抓取/粘贴目标期刊的投稿须知，解析成结构化规则集，直接用作审稿与格式检查依据",
    hint: "批量解析入库 · 按刊复审",
    icon: <Library className="h-4.5 w-4.5" />,
    tag: "投稿",
    capabilities: ["投稿须知解析", "规则集入期刊库", "按刊审稿", "格式要求提取"]
  },
  {
    id: "S73",
    group: "写作舱与工作台",
    key: "plot-agent",
    title: "成果可视化工坊",
    desc: "对话式出图：上传数据或直接描述需求，系统规划→出图→自审修订→落盘 PNG+SVG",
    hint: "期刊版式预设 · 矢量可编辑 · 产物可转素材",
    icon: <BarChart3 className="h-4.5 w-4.5" />,
    tag: "出图",
    capabilities: ["自然语言出图", "数据文件绑定", "期刊版式预设", "产物导出/转素材"]
  },
  {
    id: "S74",
    group: "写作舱与工作台",
    key: "editor",
    title: "学术文本工作台",
    desc: "在线学术编辑器：富文本写作 + 14 个 AI 动作（改写/检查/题名/引文）+ 图表 + 版本",
    hint: "选区改写 · 题名候选可点选 · 导入导出 Word",
    icon: <PenLine className="h-4.5 w-4.5" />,
    tag: "编辑",
    capabilities: ["文档读写与版本回档", "选区改写六模式", "题名/摘要/关键词生成", "引文一致性检查", "导入导出 Word"]
  },
  {
    id: "S75",
    group: "写作舱与工作台",
    key: "education",
    title: "教学与教育能力",
    desc: "面向教学的讲解、练习与批改：六类教育能力，把研究材料转成可直接上课的内容",
    hint: "文献证据讲解 · 教学场景",
    icon: <GraduationCap className="h-4.5 w-4.5" />,
    tag: "教学",
    capabilities: ["循证讲解", "教学材料生成", "练习与批改", "教育档案"]
  },
  {
    id: "S76",
    group: "写作舱与工作台",
    key: "corpus",
    title: "写作语料库",
    desc: "从已入库文献抽取文本/概念/逻辑/句式四类语料，写作时按需引用，形成自己的表达库",
    hint: "四子库 · LLM 提取 · 可被 Agent 引用",
    icon: <FolderOpen className="h-4.5 w-4.5" />,
    tag: "语料",
    capabilities: ["四类语料抽取", "按主题检索", "写作时注入", "产出沉淀回库"]
  },
  {
    id: "S77",
    group: "写作舱与工作台",
    key: "statistics",
    title: "数据分析台",
    desc: "上传 CSV/Excel 跑真正的统计：描述统计、回归、面板、逻辑回归，结果可回流到正文章节",
    hint: "17 类方法 · SSE 流式结果 · 结果可转素材",
    icon: <BarChart3 className="h-4.5 w-4.5" />,
    tag: "统计",
    capabilities: ["数据上传与变量识别", "描述统计/回归/面板", "流式结果", "结果回流章节"]
  },
  {
    id: "S78",
    group: "写作舱与工作台",
    key: "imports",
    title: "文献管理与入库",
    desc: "把 PDF 批量收进来、解析、去重、入库，并维护文献元数据与引用关系",
    hint: "批量上传 · 三库入库 · 去重与元数据",
    icon: <Database className="h-4.5 w-4.5" />,
    tag: "入库",
    capabilities: ["批量上传与去重", "PDF 解析", "三库入库", "元数据与引用维护"]
  },

  // ═══ 十七、学术情报与质检（2026-10-03 补）═══
  //
  // 由来(用户:「场景也应该更新新增的了」): 上一批 S67-S78 补到 2026-09-29 为止,
  //   而 10-02/10-03 落地的六项能力**一条都没进场景** —— 研究速递、舆情检索、
  //   Skill 广场、PPT 工作台、AIGC 检测、文献导入。它们在场景页里连**视图名都写不出来**
  //   (ScenarioView 闭集里没有), 所以不是"忘了写一条", 是整类能力在场景层不存在。
  //
  // 与 S67-S78 那批的区别: 那批是"把活儿做完"的工具, 这批是**做活儿之前先看世界**的
  //   工具 —— 订阅前沿、看舆情、找现成技能、检测自己写出的是不是像 AI 写的。
  //   所以单独成组, 不并进"写作舱与工作台"。
  {
    id: "S79",
    group: "学术情报与质检",
    key: "digest",
    title: "研究速递（订阅式前沿推送）",
    desc: "按你的主题与订阅期刊自动抓取最新成果与刊物动态，形成每天可刷的速递流",
    hint: "主题订阅 · 期刊目录/征稿 · 可接外部源(RSS/在线搜刊)",
    icon: <BookOpen className="h-4.5 w-4.5" />,
    tag: "速递",
    capabilities: ["主题与期刊订阅", "三年/任意日期区间筛选", "期刊在线搜索(OpenAlex+Crossref)", "自定义 RSS/网页源", "未读与已读标记"]
  },
  {
    id: "S80",
    group: "学术情报与质检",
    key: "opinion",
    title: "政策与舆情检索",
    desc: "把政策文件与舆情动态一起查：外部检索的「舆情检索」分区里，关键词检索 + 15 个平台热榜 + 网页归档三合一",
    hint: "多源舆情 · 政策原文 · 可转成推理素材",
    icon: <Scale className="h-4.5 w-4.5" />,
    tag: "舆情",
    capabilities: ["多源舆情检索", "政策文件定位", "结果转推理/写作素材"]
  },
  {
    id: "S81",
    group: "学术情报与质检",
    key: "skills",
    title: "Skill 广场（找现成流程）",
    desc: "两百多个技能摆成一个广场：按分类/标签/来源筛选，看版本与热度，看中了直接提交/安装",
    hint: "分类与标签统计 · 版本/作者/来源 · Agent 召回热度",
    icon: <FolderOpen className="h-4.5 w-4.5" />,
    tag: "技能",
    capabilities: ["按分类/标签/来源浏览", "版本与作者可见", "Agent 召回热度", "一键进详情"]
  },
  {
    id: "S82",
    group: "学术情报与质检",
    key: "ppt-workbench",
    title: "汇报 PPT 生成",
    desc: "把研究内容直接做成可讲的汇报稿：分页大纲→逐页内容→可编辑 pptx",
    hint: "一句话出稿 · 分页可改 · 导出 pptx",
    icon: <FileText className="h-4.5 w-4.5" />,
    tag: "汇报",
    capabilities: ["主题到大纲", "逐页内容生成", "在线编辑", "导出 pptx"]
  },
  {
    id: "S83",
    group: "学术情报与质检",
    key: "aigc-detect",
    title: "AIGC 检测与降 AI 味",
    desc: "投稿前先自检：统计指标给判定，并给出改哪几句、怎么改的具体清单",
    hint: "多维指标 · 判定分级 · 改写清单",
    icon: <ShieldCheck className="h-4.5 w-4.5" />,
    tag: "质检",
    capabilities: ["多维 AIGC 指标", "分级判定", "具体改写建议", "结果转投稿流程"]
  },
  {
    id: "S84",
    group: "学术情报与质检",
    key: "lit-import",
    title: "文献批量导入",
    desc: "从 Zotero / RIS / BibTeX / 文件夹一次性把文献搬进来，自动解析元数据",
    hint: "Zotero/RIS/BibTeX · 批量解析 · 去重",
    icon: <Database className="h-4.5 w-4.5" />,
    tag: "导入",
    capabilities: ["多格式导入", "元数据解析", "重复识别", "批量入库"]
  },
  {
    id: "S85",
    group: "学术情报与质检",
    key: "format-eval",
    title: "投稿前格式体检",
    desc: "按目标期刊/学校模板逐条比对格式：页边距、字号、行距、引用体例给到具体位置",
    hint: "规则引擎 + LLM · 定位到页 · 可自定义模板",
    icon: <Target className="h-4.5 w-4.5" />,
    tag: "格式",
    capabilities: ["模板比对", "问题定位", "自定义模板导入", "与评审台联动"]
  }
];

export const GROUPS = ["选题构思", "文献调研", "证据检索", "数据分析", "论文写作", "图表制作", "评审发表", "系统自动化", "经典文本研究", "学术研究", "论文写作研究", "论文写作输出", "论文质量检查", "理论思辨拓展", "政经C刊科研", "写作舱与工作台", "学术情报与质检"];

const GROUP_ICONS: Record<string, React.ReactNode> = {
  "选题构思": <Lightbulb className="h-4 w-4" />,
  "文献调研": <BookOpen className="h-4 w-4" />,
  "证据检索": <Search className="h-4 w-4" />,
  "数据分析": <BarChart3 className="h-4 w-4" />,
  "论文写作": <PenLine className="h-4 w-4" />,
  "图表制作": <BarChart3 className="h-4 w-4" />,
  "评审发表": <Users className="h-4 w-4" />,
  "系统自动化": <Database className="h-4 w-4" />,
  "经典文本研究": <BookOpenCheck className="h-4 w-4" />,
  "学术研究": <GitBranch className="h-4 w-4" />,
  "论文写作研究": <PenLine className="h-4 w-4" />,
  "论文写作输出": <FileText className="h-4 w-4" />,
  "论文质量检查": <ShieldCheck className="h-4 w-4" />,
  "理论思辨拓展": <Scale className="h-4 w-4" />,
  "政经C刊科研": <Target className="h-4 w-4" />,
  "写作舱与工作台": <FlaskConical className="h-4 w-4" />,
  "学术情报与质检": <Sparkles className="h-4 w-4" />
};

export const ScenariosPanel: FC<ScenariosPanelProps> = ({ onChangeView }) => {
  const [activeGuide, setActiveGuide] = useState<string | null>(null);

  // 进入场景工作台（全屏向导：研究步骤 + 工具引导）
  const openWorkbench = (scenarioId: string) => setActiveGuide(scenarioId);

  // 当前场景指南
  const guide = activeGuide ? SCENARIO_GUIDES.find((g) => g.id === activeGuide) : null;

  // 工作台模式：全屏步骤向导
  if (guide) {
    return (
      <ScenariosWorkbench
        guide={guide}
        onBack={() => setActiveGuide(null)}
        onNavigate={(view) => onChangeView(view)}
      />
    );
  }

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto w-full max-w-[1400px] space-y-6">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">科研场景</h2>
          <span className="text-xs text-muted-foreground">{SCENARIOS.length} 个场景 · {GROUPS.length} 大研究阶段 · 全生命周期覆盖</span>
        </div>
        <p className="text-xs text-muted-foreground/70">
          从选题构思到评审发表，覆盖研究全生命周期。点击场景进入<b className="text-primary">研究步骤工作台</b>，按步骤引导完成研究（每步标注使用工具 + 操作指引）。
        </p>

        {GROUPS.map((group) => {
          const groupScenarios = SCENARIOS.filter((s) => s.group === group);
          if (groupScenarios.length === 0) return null;
          return (
            <div key={group}>
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground/80">
                <span className="text-primary">{GROUP_ICONS[group]}</span>
                {group}
                <span className="text-xs font-normal text-muted-foreground/60">{groupScenarios.length} 个场景</span>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {groupScenarios.map((scenario) => {
                  const hasGuide = SCENARIO_GUIDES.some((g) => g.id === scenario.id);
                  return (
                    <button
                      key={scenario.id}
                      type="button"
                      data-control="scenarios:open"
                      onClick={() => hasGuide ? openWorkbench(scenario.id) : onChangeView(scenario.key)}
                      className="group glass rounded-lg p-4 text-left transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-lg"
                    >
                      <div className="flex items-center gap-3">
                        <span className="rounded-lg bg-primary/10 p-2 text-primary transition-colors group-hover:bg-primary/20">
                          {scenario.icon}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">{scenario.id}</span>
                            <span className="truncate text-base font-medium text-foreground">{scenario.title}</span>
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground/80">{scenario.tag} · {hasGuide ? "进入工作台" : "点击进入"}</div>
                        </div>
                        {hasGuide ? (
                          <span className="flex shrink-0 items-center gap-1 rounded bg-primary/15 px-2 py-1 text-[10px] font-medium text-primary transition-colors group-hover:bg-primary/25">
                            <Play className="h-3 w-3" />
                            研究步骤
                          </span>
                        ) : (
                          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                        )}
                      </div>
                      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{scenario.desc}</p>
                      {/* 该场景独有的能力流程徽章（真实实现提取） */}
                      <div className="mt-3 grid grid-cols-2 gap-1">
                        {scenario.capabilities.map((cap) => (
                          <span
                            key={cap}
                            className="flex items-center gap-1.5 truncate rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors group-hover:bg-primary/5 group-hover:text-foreground/80"
                          >
                            <span className="h-1 w-1 shrink-0 rounded-full bg-primary/50" />
                            {cap}
                          </span>
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground/60">{scenario.hint}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
