// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// HomePanel.tsx — MarxSphere 品牌首页（Landing）
// 深空宇宙背景 + 马克思理论叙事 + 功能入口 + 研究数据 + 检索栈 scrollytelling 动画
import { useEffect, useState, type FC } from "react";
import { Library, Sparkles, ExternalLink, BookOpenCheck, Boxes, FolderOpen, ChevronRight, Search, MessageSquareText, Network, Scale, Database, FileUp, LayoutGrid } from "lucide-react";
import { SymbolLogo } from "./SymbolLogo";
import { SCENARIOS, GROUPS } from "./ScenariosPanel";

// 检索栈动画步骤（按真实 Ask 18 步）
const RETRIEVAL_STEPS = [
  "向量化", "别名消解", "实体抽取", "实体召回", "关系召回", "事件关联",
  "标题向量", "多查询变体", "图遍历", "事件详情", "事件扩展",
  "意图分类", "加权 RRF", "Cosine 重打分", "Boost 链", "去重", "LLM 重排", "回取切片"
];

// 检索栈 LLM 步骤 token（对齐 ask-demo 演示值：仅 LLM 调用步骤有消耗，其余为 0）
const ASK_STEP_TOKENS: Record<string, { in: number; out: number }> = {
  "实体抽取": { in: 850, out: 260 },
  "多查询变体": { in: 520, out: 180 },
  "LLM 重排": { in: 3200, out: 140 },
};

// 推理链路动画步骤（按真实 SAG 推理 52 步流水线 — 含超边层 Stage 3.5）
const REASON_STEPS = [
  // Stage 0-1: 分类 + 大纲 (4步)
  "问题分类", "意图识别", "术语变体", "拆分子问题",
  // Stage 2: Cognee 17路粗检索 (14步)
  "实体抽取", "Cognee HYBRID", "RAG补全", "图遍历", "关系三元组", "摘要检索",
  "子问题推理", "上下文扩展", "时序分析", "PG实体补漏", "PG向量", "CHUNKS词法",
  "语义检索", "实体直查",
  // Stage 3: Graphiti 精炼 (9步)
  "实体精炼", "概念搜索", "文献蒸馏", "领域知识", "实体邻居",
  "段落回溯", "论文溯源", "DeepWalk扩展", "关系查询",
  // Stage 3.5: HyperEdge 超边知识层 (5步 — V166+ 新增)
  "超边向量检索", "超边实体导向", "超边BM25", "三路RRF融合", "时间衰减",
  // Stage 4: 融合生成 (20步)
  "Compiled Truth", "多查询变体", "HyDE扩展", "意图调配额", "三臂RRF", "Cosine重打分",
  "Boost链", "超边配额", "LLM重排", "压缩段落", "COT推理", "Agentic搜索",
  "生成假设", "自评校验", "置信评估", "溯源标注", "回写知识页", "失败降级", "快速回退", "响应返回"
];

// 推理链路 LLM 步骤 token（对齐 reason-demo 演示值：仅 LLM 调用步骤有消耗，其余为 0）
const REASON_STEP_TOKENS: Record<string, { in: number; out: number }> = {
  "多查询变体": { in: 820, out: 180 },
  "HyDE扩展": { in: 480, out: 160 },
  "LLM重排": { in: 4200, out: 150 },
  "COT推理": { in: 3500, out: 900 },
  "Agentic搜索": { in: 4200, out: 1100 },
  "生成假设": { in: 8500, out: 2100 },
  "自评校验": { in: 2400, out: 450 },
  "置信评估": { in: 900, out: 120 },
};

interface HomePanelProps {
  onChangeView: (view: "assistant" | "literature" | "reason" | "ask" | "truth" | "sciverse" | "skills" | "vault" | "graph" | "policy" | "scenarios" | "jobs" | "documents", params?: { demo?: string }) => void;
}

export function HomePanel({ onChangeView }: HomePanelProps) {
  // 技能总数（实时取自注册表 /api/skills，替代硬编码 103）
  const [skillCount, setSkillCount] = useState(192);
  useEffect(() => {
    fetch("/api/skills")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data?.skills) && data.skills.length > 0) setSkillCount(data.skills.length);
      })
      .catch(() => {});
  }, []);
  // 功能入口（业务语言，技术名词移入详情）
  const features = [
    {
      key: "reason" as const,
      icon: <Sparkles className="h-4.5 w-4.5" />,
      title: "推理 · 52 步链路",
      stage: "证据检索",
      desc: "多路混合检索 · 多链路事实溯源 · 52 步可展开推理链",
      hint: "输入研究问题，AI 多源检索后综合论证，每步可展开查看"
    },
    {
      key: "literature" as const,
      icon: <Library className="h-4.5 w-4.5" />,
      title: "文献库",
      stage: "文献调研",
      desc: "现入库 500 篇研究文献 · 每篇产出 original.md + 摘要.md + 术语表.md + 问答.md + index.md + 信息.md",
      hint: "浏览资本下乡与资本治理核心文献"
    },
    {
      key: "ask" as const,
      icon: <Search className="h-4.5 w-4.5" />,
      title: "检索问答",
      stage: "证据检索",
      desc: "可视化检索链路 · 透明展示知识调取过程",
      hint: "逐步展示 AI 如何找到证据并作答"
    },
    {
      key: "truth" as const,
      icon: <BookOpenCheck className="h-4.5 w-4.5" />,
      title: "研究记忆",
      stage: "文献调研",
      desc: "知识累积 + 证据时间线 · 让研究沉淀而非遗忘",
      hint: "整理主题研究脉络，形成长期记忆"
    },
    {
      key: "sciverse" as const,
      icon: <ExternalLink className="h-4.5 w-4.5" />,
      title: "外部检索",
      stage: "文献调研",
      desc: "权威文献证据补充 · 政策文件一手来源",
      hint: "查证外部文献与政策原文"
    },
    {
      key: "skills" as const,
      icon: <FolderOpen className="h-4.5 w-4.5" />,
      title: "技能库",
      stage: "全阶段",
      desc: `${skillCount} 个科研技能 · 覆盖选题/分析/写作/评审全流程`,
      hint: "一键调用标准化研究流程"
    },
    {
      key: "graph" as const,
      icon: <Network className="h-4.5 w-4.5" />,
      title: "知识图谱",
      stage: "文献调研",
      desc: "径向展开 · d3 力导向 · 逐层下钻 · 关系查询",
      hint: "探索实体-事件关系网络"
    },
    {
      key: "policy" as const,
      icon: <Scale className="h-4.5 w-4.5" />,
      title: "政策库",
      stage: "文献调研",
      desc: "gov.cn 政策检索 · 政策树浏览 · 法规原文定位",
      hint: "查证政策文件与法规条文"
    },
    {
      key: "vault" as const,
      icon: <Database className="h-4.5 w-4.5" />,
      title: "资料库",
      stage: "系统自动化",
      desc: "Obsidian 课题库 · 左树右文 · md/PDF/Office 预览",
      hint: "浏览课题研究资料体系"
    },
    {
      key: "scenarios" as const,
      icon: <LayoutGrid className="h-4.5 w-4.5" />,
      title: "科研场景",
      stage: "全阶段",
      desc: `${SCENARIOS.length} 个研究场景 · ${GROUPS.length} 大阶段 · 步骤向导引导完成研究`,
      hint: "选题/文献/分析/写作/评审/自动化全生命周期"
    },
    {
      key: "jobs" as const,
      icon: <FileUp className="h-4.5 w-4.5" />,
      title: "Jobs 自动化",
      stage: "系统自动化",
      desc: "多类任务 · Dream Cycle 自整理 · 队列可视化",
      hint: "入库/向量化/清洗/自整理后台执行"
    },
    {
      key: "documents" as const,
      icon: <Boxes className="h-4.5 w-4.5" />,
      title: "文档管理",
      stage: "系统自动化",
      desc: "批量上传入库 · 重命名/归档/级联删除",
      hint: "管理论文与原始资料文档"
    }
  ];

  /** 研究全景统计（与场景页 SCENARIOS/GROUPS 实时同步） */
  const capabilityStats = [
    { num: String(GROUPS.length), label: "大研究阶段" },
    { num: String(SCENARIOS.length), label: "科研场景" },
    { num: String(skillCount), label: "科研技能" },
    { num: "52", label: "推理步骤" },
    { num: "17", label: "自动化任务" },
    { num: "10,237", label: "篇文献" }
  ];

  const stats = [
    { num: "10,237", label: "篇 PDF 文献" },
    { num: "501", label: "篇已入库文献" },
    { num: "188,259", label: "图谱实体 (Graphiti+Cognee+PG)" },
    { num: "516,309", label: "图谱关系 (Graphiti+Cognee+PG)" },
    { num: "47,049", label: "文献切片 (Graphiti+PG)" },
    { num: "1,085", label: "知识社区" },
    { num: "11,702", label: "超边关系" }
  ];

  return (
    <section className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-screen-2xl px-6 py-16 md:px-10 md:py-24">
        {/* Hero：品牌叙事 */}
        <div className="text-center">
          <div className="mx-auto mb-8 flex items-center justify-center">
            <div className="scale-[1.8]">
              <SymbolLogo size={48} />
            </div>
          </div>
          <h1 className="font-display text-4xl font-semibold tracking-tight text-foreground md:text-6xl">
            MarxSphere
            {/* 马克思名言：每字金色光晕，单行拉直 + 双引号 */}
            <span className="block whitespace-nowrap text-xs font-normal tracking-wide text-accent-foreground/90 md:text-sm" style={{ marginTop: "1.2rem", lineHeight: 2 }}>
              <span className="golden-char">「</span>
              {Array.from("在科学上没有平坦的大道，只有不畏劳苦沿着陡峭山路攀登的人，才有希望达到光辉的顶点").map((ch, i) => (
                <span
                  key={i}
                  className="golden-char"
                  style={{ transitionDelay: `${(i % 8) * 30}ms` }}
                >
                  {ch}
                </span>
              ))}
              <span className="golden-char">」</span>
              <span className="golden-char-dash">——</span>
              <span className="golden-char">马克思《资本论》第一卷</span>
            </span>
          </h1>
          <p className="mx-auto mt-8 max-w-2xl text-xl leading-snug tracking-wide text-accent-foreground md:text-2xl">
            让 Agent 帮你真正读懂 <span className="font-bold text-foreground">马克思主义理论</span>
          </p>
          <p className="mx-auto mt-4 text-base text-muted-foreground/80 md:text-lg">
            农业农村现代化 · 资本下乡 · 工商资本 · 资本治理
          </p>
          <p className="mx-auto mt-3 text-sm text-muted-foreground/70">
            面向哲学社会科学全域科研赋能
          </p>

          {/* 按钮：开始研究提问 = 主按钮（跳 AI 对话页），进入文献库 = 次级 */}
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <button
              type="button"
              onClick={() => onChangeView("assistant")}
              className="rounded-full bg-primary px-8 py-3.5 text-sm font-semibold text-primary-foreground shadow-[0_0_28px_hsl(214_55%_48%/0.35)] transition-all hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-[0_0_40px_hsl(214_55%_48%/0.5)]"
            >
              开始研究提问
            </button>
            <button
              type="button"
              onClick={() => onChangeView("literature")}
              className="rounded-full border border-border bg-background/50 px-7 py-3 text-sm font-medium text-muted-foreground transition-all hover:border-primary/40 hover:bg-accent/40 hover:text-foreground"
            >
              进入文献库
            </button>
          </div>

          {/* 当前课题：立项项目横幅（紧跟开始研究提问） */}
          <div className="mt-6 w-full rounded-lg border border-primary/25 bg-gradient-to-r from-primary/10 via-background/40 to-primary/10 p-5 text-center transition-colors hover:border-primary/50">
            <div className="flex items-center justify-center gap-2 text-xs font-medium uppercase tracking-widest text-primary/70">
              <Sparkles className="h-3.5 w-3.5" />
              当前课题
              <Sparkles className="h-3.5 w-3.5" />
            </div>
            <button
              type="button"
              onClick={() => onChangeView("reason")}
              className="mt-2 flex w-full items-center justify-center gap-2 text-base font-semibold text-accent-foreground transition-colors hover:text-primary md:text-lg"
              title="点击进入推理，围绕本课题提问"
            >
              <BookOpenCheck className="h-4 w-4 shrink-0 text-primary" />
              <span className="whitespace-nowrap text-left leading-snug">
                2026年广西研究生教育创新计划项目——<span className="text-primary">《农业农村现代化进程中工商资本规范与引导路径研究》</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
            <p className="mt-1.5 text-xs text-muted-foreground/80">点击进入推理，围绕本课题开展研究</p>
          </div>
        </div>

        {/* 数据带：研究规模（三库图谱真实数据） */}
        <div className="rise-stagger mt-20 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7">
          {stats.map((stat) => (
            <div key={stat.label} className="glass rounded-lg p-4 text-center transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-lg">
              <div className="text-2xl font-semibold text-accent-foreground lg:text-xl">{stat.num}</div>
              <div className="mt-1.5 text-xs leading-tight text-muted-foreground">{stat.label}</div>
            </div>
          ))}
        </div>

        {/* 检索栈 scrollytelling 动画（18 步逐步点亮） */}
        <RetrievalStackAnimation />

        {/* 推理栈 scrollytelling 动画（52 步逐步点亮） */}
        <ReasonStackAnimation />

        {/* 功能入口 */}
        <div className="mt-20">
          <div className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
            <span>研究能力</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </div>

          {/* 研究全景统计条（对齐场景页 8 大阶段；数字滚升动画 finesse 2026-08-07） */}
          <div className="mb-6 grid grid-cols-3 gap-3 sm:grid-cols-6">
            {capabilityStats.map((stat) => (
              <RollUpNumber key={stat.label} target={stat.num} label={stat.label} />
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {features.map((feature) => (
              <button
                key={feature.key}
                type="button"
                onClick={() => onChangeView(feature.key)}
                className="group glass rounded-lg p-5 text-left transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-lg"
              >
                <div className="flex items-center gap-3">
                  <span className="rounded-lg bg-primary/10 p-2.5 text-primary transition-colors group-hover:bg-primary/20">
                    {feature.icon}
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-base font-medium text-foreground">{feature.title}</div>
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">{feature.stage}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground/80">{feature.hint}</div>
                  </div>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{feature.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* 示例研究命题（点击载入） */}
        <div className="mt-16 rounded-lg border border-dashed border-primary/25 bg-background/40 p-6 text-center transition-colors hover:border-primary/50">
          <p className="text-sm text-muted-foreground">💡 点击载入示例研究命题，快速启动推理</p>
          <button
            type="button"
            onClick={() => onChangeView("reason")}
            className="mt-3 inline-flex items-center gap-2 text-sm text-accent-foreground hover:text-primary"
          >
            <MessageSquareText className="h-4 w-4" />
            「资本下乡对农村集体经济的双重效应及其制度约束」
          </button>
        </div>

      </div>
    </section>
  );
}

/** 检索栈动画：18 步逐步点亮（scrollytelling 简化版 — 自动播放循环） */
/** KPI 数字滚升（finesse 2026-08-07：0 → target，1.2s 缓出；reduced-motion 直接终值） */
function RollUpNumber({ target, label }: { target: string; label: string }) {
  const [display, setDisplay] = useState(target);
  useEffect(() => {
    const numeric = Number(target.replace(/,/g, ""));
    if (!Number.isFinite(numeric)) { setDisplay(target); return; }
    const rm = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (rm) { setDisplay(target); return; }
    const duration = 1200;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const formatted = target.includes(",")
        ? Math.round(numeric * eased).toLocaleString("en-US")
        : String(Math.round(numeric * eased));
      setDisplay(formatted);
      if (p < 1) raf = requestAnimationFrame(tick);
      else setDisplay(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return (
    <div className="glass rounded-lg px-3 py-3 text-center">
      <div className="font-display text-2xl font-semibold text-primary tabular-nums">{display}</div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

function RetrievalStackAnimation() {
  const [litCount, setLitCount] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setLitCount((current) => (current >= RETRIEVAL_STEPS.length ? 0 : current + 1));
    }, 400);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="glass mt-16 rounded-2xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-sm font-medium text-foreground">Ask 检索栈 · 18 步流水线</div>
        <div className="text-xs text-muted-foreground">
          {litCount > 0 && litCount < RETRIEVAL_STEPS.length
            ? `第 ${litCount}/${RETRIEVAL_STEPS.length} 步 · ${RETRIEVAL_STEPS[litCount - 1]}`
            : litCount >= RETRIEVAL_STEPS.length ? "完成" : "待启动"}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {RETRIEVAL_STEPS.map((step, index) => {
          const tokens = ASK_STEP_TOKENS[step];
          return (
            <span
              key={step}
              className={
                index < litCount
                  ? "rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground shadow-[0_0_12px_hsl(214_55%_48%/0.4)] transition-all duration-300"
                  : "rounded-md bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground transition-all duration-300"
              }
            >
              <span className="mr-1 opacity-60">{index + 1}</span>
              {step}
              {tokens && index < litCount && (
                <span className="ml-1.5 rounded bg-white/15 px-1 py-0.5 font-mono text-[9px]">
                  tok {tokens.in + tokens.out}
                </span>
              )}
            </span>
          );
        })}
      </div>
      <div className="mt-3 text-[10px] text-muted-foreground">
        推理链路 52 步：分类 → 大纲 → Cognee 17 路粗检索 → Graphiti 精炼 → 超边三路检索 → 融合生成 → 自评自愈
      </div>
    </div>
  );
}

/** 推理栈动画：52 步逐步点亮（与 Ask 18 步同款 scrollytelling — 自动播放循环） */
function ReasonStackAnimation() {
  const [litCount, setLitCount] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setLitCount((current) => (current >= REASON_STEPS.length ? 0 : current + 1));
    }, 700);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="glass mt-6 rounded-2xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-sm font-medium text-foreground">推理链路 · 52 步流水线</div>
        <div className="text-xs text-muted-foreground">
          {litCount > 0 && litCount < REASON_STEPS.length
            ? `第 ${litCount}/${REASON_STEPS.length} 步 · ${REASON_STEPS[litCount - 1]}`
            : litCount >= REASON_STEPS.length ? "完成" : "待启动"}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {REASON_STEPS.map((step, index) => {
          const tokens = REASON_STEP_TOKENS[step];
          return (
            <span
              key={step}
              className={
                index < litCount
                  ? "rounded-md bg-gradient-to-r from-violet-500 to-fuchsia-500 px-2.5 py-1.5 text-xs font-medium text-white shadow-[0_0_12px_hsl(270_70%_55%/0.45)] transition-all duration-300"
                  : "rounded-md bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground transition-all duration-300"
              }
            >
              <span className="mr-1 opacity-60">{index + 1}</span>
              {step}
              {tokens && index < litCount && (
                <span className="ml-1.5 rounded bg-white/15 px-1 py-0.5 font-mono text-[9px]">
                  tok {tokens.in + tokens.out}
                </span>
              )}
            </span>
          );
        })}
      </div>
      <div className="mt-3 text-[10px] text-muted-foreground">
        推理链路：分类 → 大纲 → Cognee 17 路粗检索 → Graphiti 精炼+超边 → 融合生成 → 自评自愈
      </div>
    </div>
  );
}
