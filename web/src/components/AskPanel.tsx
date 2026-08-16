// AskPanel.tsx — Ask 检索实时面板（18 步检索流水线：多臂召回 → 加权 RRF → boost 链 → 重排）
// 复用 MarxSphere SSE /api/search/stream 的 search_progress 步骤事件，
// 重组为左侧持久化步骤栈 + 右侧答案 + 引用条
import { useState, useRef, useEffect, type FC } from "react";
import { Loader2, Search, Sparkles, CheckCircle2, XCircle, Clock, FileText, ListOrdered, ChevronDown } from "lucide-react";
import { api } from "../lib/api";
import { askDemo } from "../lib/ask-demo";
import { cn, formatDuration } from "../lib/utils";
import { Card } from "../components/ui/card";
import { Textarea } from "../components/ui/textarea";
import { Button } from "../components/ui/button";
import type { SearchProgressEvent, SearchResult } from "../types";
import { RetrievalSourceSwitches } from "./RetrievalSourceSwitches";
import { LlmModelSelector } from "./LlmModelSelector";
import { FeedbackButtons } from "./FeedbackButtons";

interface StepEntry {
  key: string;
  title: string;
  detail: string;
  status: "running" | "done" | "failed";
  durationMs?: number;
  /** 每步的 input/output/参数/结果（GBrain 可视化：可展开查看） */
  payload?: unknown;
  /** 该步消耗的 token（OTEL span tokens） */
  tokens?: { input: number; output: number; cacheRead: number };
  /** 步骤序号（真实步数，非 1-12） */
  stepNumber: number;
  /** 条件触发标注（演示全景：该步骤在特定条件下才执行） */
  trigger?: string;
}

interface Citation {
  chunkId: string;
  sourceId: string;
  heading?: string;
  content: string;
  rank: number;
  score: number;
  /** 来源溯源：被哪个检索算子捞到 */
  sourceStep?: string;
}

/** 来源步骤中文标签（GBrain 溯源呈现） */
const STEP_LABELS: Record<string, string> = {
  "event-arm": "事件臂",
  vector: "向量召回",
  "graphiti-entity": "Graphiti 实体",
  "cognee-chunk": "Cognee 切片",
  "compiled-truth": "权威版本",
  keyword: "关键词"
};

/** 消融算子中文标签 */
const OP_LABELS: Record<string, string> = {
  compiled_truth: "Compiled Truth ×2.0",
  title: "标题命中 boost",
  chronicle_type: "事件类型加权"
};

/** 可消融算子清单（交互式开关） */
const ABLATION_OPERATORS: Array<{ key: string; label: string; desc: string }> = [
  { key: "compiled_truth", label: "权威版本 ×2.0", desc: "关掉知识页命中加权" },
  { key: "title", label: "标题命中", desc: "关掉查询词命中标题的 boost" },
  { key: "chronicle_type", label: "类型加权", desc: "关掉学术/政策事件加权" },
  { key: "backlink", label: "反向链接", desc: "关掉实体关联数加权" },
  { key: "cosine", label: "Cosine 重打分", desc: "关掉 RRF 后余弦混合重排" },
  { key: "dedup", label: "去重", desc: "关掉 4 路去重" },
  { key: "alias", label: "别名消解", desc: "关掉查询词别名归一" },
  { key: "relational", label: "关系臂", desc: "关掉关系型查询召回" },
  { key: "expansion", label: "事件扩展", desc: "关掉种子事件扩展" },
  { key: "graph_traversal", label: "图遍历", desc: "关掉 SQL 递归 2 跳" },
  { key: "multi_query", label: "多查询改写", desc: "关掉 LLM 查询变体" },
  { key: "rerank", label: "LLM 重排", desc: "关掉 reranker 打分" }
];

export function AskPanel({ pendingDemo }: { pendingDemo?: string | null }) {
  const [query, setQuery] = useState("");
  // demo 只播一次 + runAsk 引用（避免闭包旧值）
  const pendingDemoRef = useRef(false);
  const runAskRef = useRef<() => Promise<void>>(async () => {});
  const playDemoRef = useRef<() => void>(() => {});
  // demo 播放中（显示"我自己输入"退出条）
  const [demoPlaying, setDemoPlaying] = useState(false);

  // 沙箱 demo 回放（GBrain 模式：静态数据逐步点亮，不真打 API）
  playDemoRef.current = () => {
    const demo = askDemo.get();
    setQuery(demo.query);
    setDemoPlaying(true);
    setSummary(null);
    setAnswer("");
    setCitations([]);
    setSteps([]);
    stepMapRef.current.clear();
    // 逐步骤点亮（320ms 一格，对齐 GBrain）
    demo.steps.forEach((step, index) => {
      setTimeout(() => {
        const entry: StepEntry = {
          key: step.key,
          title: step.title,
          detail: step.detail,
          status: "done",
          durationMs: step.durationMs,
          payload: (step as { payload?: unknown }).payload,
          tokens: (step as { tokens?: StepEntry["tokens"] }).tokens,
          stepNumber: index + 1,
          trigger: step.trigger
        };
        stepMapRef.current.set(step.key, entry);
        setSteps(Array.from(stepMapRef.current.values()));
        setLastLitKey(step.key);
        setTimeout(() => setLastLitKey(null), 600);
        // 最后一步完成后显示答案/引用/消融
        if (index === demo.steps.length - 1) {
          setTimeout(() => {
            setAnswer(demo.answer);
            setCitations(demo.citations.map((c) => ({ ...c, sourceId: c.sourceId, rank: c.rank, score: c.score, sourceStep: c.sourceStep })));
            setSummary(demo.summary);
            setAblation(demo.ablation);
            // demo 消融数据 → 交互式格式（映射前 6 个算子为"关闭后对比"）
            setCustomAblationResult({
              baselineCount: demo.ablation.baselineCount,
              ablatedCount: demo.ablation.baselineCount,
              overlapWithBaseline: demo.ablation.baselineCount,
              hitChangePct: 0,
              closedOperators: demo.ablation.operators.slice(0, 3).map((op) => op.operator)
            });
          }, 300);
        }
      }, index * 320);
    });
  };

  // 退出 demo：清空演示数据，用户自己输入
  const exitDemo = () => {
    setDemoPlaying(false);
    setQuery("");
    setSteps([]);
    setAnswer("");
    setCitations([]);
    setSummary(null);
    // 消融面板保留（固定框架，用户可直接操作）
    stepMapRef.current.clear();
  };
  const [steps, setSteps] = useState<StepEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState<string>("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ totalMs: number; steps: number; passed: number } | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // 最近点亮的步骤（完成时绿色脉冲动画）
  const [lastLitKey, setLastLitKey] = useState<string | null>(null);
  // 步骤详情文档（SQL/公式/代码，GBrain 教学台）
  const [stepDocsMap, setStepDocsMap] = useState<Record<string, { title: string; what: string; sql?: string; formula?: string; code?: string }>>({});
  // 消融实验（交互式：勾选算子关闭，对比基线）
  const [ablation, setAblation] = useState<{ baselineCount: number; operators: Array<{ operator: string; ablatedCount: number; overlapWithBaseline: number; hitChangePct: number }> } | null>(null);
  const [ablationLoading, setAblationLoading] = useState(false);
  // 交互式消融：勾选的算子（= 关闭）
  const [closedOps, setClosedOps] = useState<Set<string>>(new Set());
  const [customAblationResult, setCustomAblationResult] = useState<{ baselineCount: number; ablatedCount: number; overlapWithBaseline: number; hitChangePct: number; closedOperators: string[] } | null>(null);

  const toggleOp = (key: string) => {
    setClosedOps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const runCustomAblation = async () => {
    if (!query.trim() || !selectedProjectId) return;
    setAblationLoading(true);
    setCustomAblationResult(null);
    try {
      const data = await api.runCustomAblation({ query: query.trim(), sourceIds: [selectedProjectId], ablation: Array.from(closedOps) });
      setCustomAblationResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAblationLoading(false);
    }
  };

  useEffect(() => {
    api.getSearchStepDocs()
      .then((data) => {
        const map: Record<string, { title: string; what: string; sql?: string; formula?: string; code?: string }> = {};
        for (const d of data.steps) map[d.key] = d;
        setStepDocsMap(map);
      })
      .catch(() => {});
    // Hero「立即体验」：自动填入 demo 查询并自动检索（GBrain 自动播放 demo）
    if (pendingDemo && !pendingDemoRef.current) {
      pendingDemoRef.current = true;
      setQuery(pendingDemo);
      // 等 state 更新后自动检索
      setTimeout(() => {
        const projectId = selectedProjectId;
        if (projectId) {
          void runAskRef.current();
        }
      }, 300);
      return;
    }
    // 沙箱 demo：无 pendingDemo 时自动播放预设演示（GBrain 模式：静态回放，不真打 API）
    if (!pendingDemoRef.current) {
      pendingDemoRef.current = true;
      playDemoRef.current();
    }
  }, []);
  const [sources, setSources] = useState<Array<"pg" | "graphiti" | "cognee">>(["pg"]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const stepMapRef = useRef<Map<string, StepEntry>>(new Map());
  const startedAtRef = useRef<number>(0);

  useEffect(() => {
    api.listProjects().then((data) => {
      const list = data.projects.map((project) => ({ id: project.id, name: project.name }));
      setProjects(list);
      if (list.length > 0) setSelectedProjectId(list[0].id);
    }).catch(() => { /* 无项目时忽略 */ });
  }, []);

  const runAsk = async () => {
    if (!query.trim() || !selectedProjectId) return;
    runAskRef.current = runAsk;
    setRunning(true);
    setError(null);
    setAnswer("");
    setCitations([]);
    setSteps([]);
    setSummary(null);
    stepMapRef.current.clear();
    startedAtRef.current = Date.now();

    try {
      await api.streamSearch(
        {
          query: query.trim(),
          sourceIds: [selectedProjectId],
          searchMode: "standard",
          topK: 10,
          sources
        },
        (event) => {
          if (event.type === "step") {
            const stepEvent = event as SearchProgressEvent;
            const entry: StepEntry = {
              key: stepEvent.key,
              title: stepEvent.title,
              detail: stepEvent.detail,
              status: stepEvent.status,
              durationMs: stepEvent.durationMs,
              payload: stepEvent.payload,
              tokens: (stepEvent as { tokens?: StepEntry["tokens"] }).tokens,
              stepNumber: stepMapRef.current.size + 1
            };
            stepMapRef.current.set(stepEvent.key, entry);
            setSteps(Array.from(stepMapRef.current.values()));
            // 逐步点亮：步骤完成时记录为最近点亮（触发绿色脉冲动画）
            if (stepEvent.status === "done") {
              setLastLitKey(stepEvent.key);
              setTimeout(() => setLastLitKey(null), 600);
            }
          } else if (event.type === "done") {
            const result = (event as { type: "done"; result: SearchResult }).result;
            if (result && result.sections && result.sections.length > 0) {
              const newCitations = result.sections.map((section) => ({
                chunkId: section.chunkId,
                sourceId: section.sourceId,
                heading: section.heading,
                content: section.content,
                rank: section.rank,
                score: section.score,
                sourceStep: section.sourceStep
              }));
              setCitations(newCitations);
              setAnswer("检索完成，正在生成综合回答…");
              // 调用 LLM 综合回答（Ask 面板闭环）
              void composeAnswer(query.trim(), newCitations.map((c) => ({
                title: c.heading || c.sourceId.slice(0, 12),
                content: c.content,
                heading: c.heading
              })));
              // 检索即记忆：检索证据关联知识页（GBrain 机制5）
              void api.associateSearch(query.trim(), newCitations.map((c) => ({
                title: c.heading || c.sourceId.slice(0, 12),
                content: c.content.slice(0, 300)
              }))).catch(() => {});
              // Skillify 模式记录（GBrain 机制6）
              void api.recordSkillifyPattern(query.trim(), true, newCitations.map((c) => c.heading || "").filter(Boolean)).catch(() => {});
            }
          } else if (event.type === "error") {
            setError((event as { type: "error"; message: string }).message);
          }
        }
      );
      setSummary({
        totalMs: Date.now() - startedAtRef.current,
        steps: stepMapRef.current.size,
        passed: Array.from(stepMapRef.current.values()).filter((step) => step.status === "done").length
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const stepLabels = ["问题分类", "查询扩展", "粗检索", "双路融合", "精炼", "评分", "引用组装"];

  const composeAnswer = async (q: string, evidence: Array<{ title: string; content: string; heading?: string }>) => {
    try {
      const result = await api.composeAnswer(q, evidence);
      if (result.answer) setAnswer(result.answer);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAnswer("综合回答生成失败，请查看错误信息。");
    }
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Ask 检索</h2>
          <span className="text-xs text-muted-foreground">18 步检索流水线实时可视化（多臂召回 → 加权 RRF → boost 链 → 重排）</span>
        </div>
        <RetrievalSourceSwitches chain="ask" onChange={(s) => setSources(s)} />

        <Card className="p-4">
          <Textarea
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="输入研究问题，如：资本下乡对农村集体经济的双重效应"
            rows={2}
            className="mb-2"
          />
          <div className="mb-2 flex items-center gap-2">
            <label className="shrink-0 text-xs text-muted-foreground">检索范围：</label>
            <select
              value={selectedProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            >
              {projects.length === 0 && <option value="">（无项目，请先在「文档」页创建）</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => void runAsk()} disabled={running || !query.trim() || !selectedProjectId}>
              {running ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Search className="mr-1 h-4 w-4" />}
              {running ? "检索中…" : "开始检索"}
            </Button>
            {/* 2026-08-07 LLM 模型选择：在开始检索右边（按钮在左，模型在右） */}
            <LlmModelSelector />
          </div>
        </Card>

        {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        {/* demo 播放提示条（GBrain：沙箱回放，点"我自己输入"退出） */}
        {demoPlaying && (
          <div className="flex items-center gap-2 rounded-md border border-primary/25 bg-primary/5 px-4 py-2 text-xs">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <span className="text-muted-foreground">正在播放预设演示（沙箱回放 · 不消耗 API）</span>
            <button
              type="button"
              onClick={exitDemo}
              className="ml-auto rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              我自己输入
            </button>
          </div>
        )}

        {summary && (
          <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            <CheckCircle2 className="mr-1 inline h-4 w-4" />
            检索完成：{summary.steps} 步 / 通过 {summary.passed} 步 / 耗时 {(summary.totalMs / 1000).toFixed(1)}s
          </div>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          {/* 左：步骤栈（固定高度 = 20 步完全展开后的高度，一开始就那么高，逐一点亮时框不动） */}
          <Card className="flex flex-col p-3" style={{ height: 1467 }}>
            <div className="mb-2 flex shrink-0 items-center gap-1.5 text-sm font-medium">
              <ListOrdered className="h-4 w-4" /> 检索步骤栈
            </div>
            <div className="space-y-1.5">
              {steps.length === 0 && !running && (
                <div className="flex flex-col items-center justify-center gap-2 rounded border border-dashed border-border px-3 py-6 text-center">
                  <Search className="h-5 w-5 text-muted-foreground/60" />
                  <div className="text-xs text-muted-foreground">输入问题并开始检索，执行链路将在这里逐步点亮</div>
                </div>
              )}
              {steps.length === 0 && running && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> 初始化步骤…
                </div>
              )}
              {steps.map((step, index) => (
                <div key={step.key || index} className={cn(
                  "rounded border p-2 transition-colors",
                  step.status === "running" && "border-primary/40 bg-primary/5",
                  step.status === "failed" && "border-red-200 bg-red-50/60",
                  step.status === "done" && "border-border hover:border-primary/25",
                  expandedKey === step.key && "border-primary/50",
                  // 逐步点亮动画：步骤完成时绿色脉冲闪烁一次
                  step.status === "done" && step.key === lastLitKey && "step-light-up"
                )}>
                  <button
                    type="button"
                    onClick={() => setExpandedKey(expandedKey === step.key ? null : step.key)}
                    className="w-full text-left"
                  >
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="w-6 shrink-0 rounded bg-muted px-1 text-center text-[10px] text-muted-foreground">{step.stepNumber}</span>
                      {step.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
                      {step.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />}
                      {step.status === "failed" && <XCircle className="h-3.5 w-3.5 text-red-600" />}
                      <span className="font-medium">{step.title}</span>
                      {/* 条件触发标注（演示全景：该步骤在特定条件下才执行） */}
                      {step.trigger && (
                        <span
                          className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[9px] text-amber-700"
                          title={step.trigger}
                        >
                          条件触发
                        </span>
                      )}
                      {step.payload !== undefined && (
                        <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform", expandedKey === step.key && "rotate-180")} />
                      )}
                      {step.durationMs !== undefined && (
                        <span className="ml-auto flex items-center gap-0.5 text-muted-foreground">
                          <Clock className="h-3 w-3" />{formatDuration(step.durationMs)}
                        </span>
                      )}
                      {step.tokens && (
                        <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
                          tok {step.tokens.input + step.tokens.output}
                        </span>
                      )}
                    </div>
                    {step.detail && <div className="mt-1 truncate text-[11px] text-muted-foreground">{step.detail}</div>}
                  </button>
                  {/* 可展开：input/output/参数/结果（GBrain 可视化）+ SQL/公式/代码文档 */}
                  {expandedKey === step.key && (
                    <>
                      {step.payload !== undefined && (
                        <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted/40 p-2 text-[10px] leading-4 text-muted-foreground">
                          {typeof step.payload === "string" ? step.payload : JSON.stringify(step.payload, null, 2)}
                        </pre>
                      )}
                      {(() => {
                        const doc = stepDocsMap[step.key];
                        if (!doc) return null;
                        return (
                          <div className="mt-2 space-y-1.5 rounded bg-muted/30 p-2">
                            <div className="text-[10px] font-medium text-primary">{doc.title} · 真实实现</div>
                            {doc.formula && (
                              <div className="rounded bg-background/80 p-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
                                <span className="text-primary">公式 </span>{doc.formula}
                              </div>
                            )}
                            {doc.sql && (
                              <pre className="overflow-auto rounded bg-background/80 p-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
                                <span className="text-primary">SQL </span>{doc.sql}
                              </pre>
                            )}
                            {doc.code && (
                              <pre className="overflow-auto rounded bg-background/80 p-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
                                <span className="text-primary">代码 </span>{doc.code}
                              </pre>
                            )}
                          </div>
                        );
                      })()}
                    </>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {/* 右栏：答案+引用平分剩余空间，消融在底部与左栏步骤栈底部对齐 */}
          <div className="flex h-full min-h-0 flex-col gap-3">
            {/* 答案与证据（与引用平分剩余空间） */}
            <Card className="flex min-h-[120px] flex-1 flex-col p-4">
              <div className="mb-2 text-sm font-medium">答案与证据</div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {answer ? (
                  <div className="whitespace-pre-wrap text-sm">{answer}</div>
                ) : (
                  <div className="flex h-full min-h-[80px] items-center justify-center text-xs text-muted-foreground">
                    检索完成后，这里展示答案
                  </div>
                )}
              </div>
              {/* V375: 用户反馈闭环（点赞/踩 → OpenViking 长期记忆） */}
              {answer && <FeedbackButtons query={query} answer={answer} />}
            </Card>

            {/* 引用证据（与答案平分剩余空间） */}
            <Card className="flex min-h-[120px] flex-1 flex-col p-4">
              <div className="mb-2 shrink-0 text-sm font-medium">引用证据（{citations.length}）</div>
              {citations.length > 0 ? (
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
                  {citations.map((citation) => (
                    <div key={citation.chunkId} className="rounded border border-border p-2 text-xs">
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <FileText className="h-3 w-3" />
                        <span className="truncate font-mono text-[10px]">{citation.heading || citation.sourceId.slice(0, 12)}</span>
                        <span className="ml-auto flex shrink-0 items-center gap-1">
                          {/* 来源溯源：该证据被哪个检索算子捞到 */}
                          {citation.sourceStep && (
                            <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700" title="来源检索步骤">
                              ↑ {STEP_LABELS[citation.sourceStep] ?? citation.sourceStep}
                            </span>
                          )}
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            step{String(citation.rank ?? "").slice(0, 2) || "?"} · {Math.round((citation.score ?? 0) * 100)}%
                          </span>
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2">{citation.content}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">暂无引用证据</div>
              )}
            </Card>

            {/* 消融实验（自适应内容，不撑满——让引用证据框更大） */}
            <Card className="min-h-[120px] p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                消融实验
                <button
                  type="button"
                  onClick={() => void runCustomAblation()}
                  disabled={ablationLoading}
                  className="rounded bg-accent px-2 py-0.5 text-[11px] font-normal text-muted-foreground hover:bg-accent/70"
                >
                  {ablationLoading ? "跑消融中…" : customAblationResult ? "重跑" : "运行消融"}
                </button>
              </div>
              {/* 交互式算子开关：勾选 = 关掉该算子，对比基线 */}
              <div className="mb-2 grid grid-cols-2 gap-1.5">
                {ABLATION_OPERATORS.map((op) => {
                  const off = closedOps.has(op.key);
                  return (
                    <button
                      key={op.key}
                      type="button"
                      onClick={() => toggleOp(op.key)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[11px] transition-colors",
                        off
                          ? "border-red-300 bg-red-50 text-red-700"
                          : "border-border text-muted-foreground hover:border-primary/40"
                      )}
                        title={`${op.label}：${op.desc}`}
                      >
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", off ? "bg-red-500" : "bg-green-500")} />
                        <span className="truncate">{op.label}</span>
                        {off && <span className="ml-auto shrink-0 text-[9px]">已关</span>}
                      </button>
                    );
                  })}
                </div>
                {customAblationResult && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] text-muted-foreground">
                      基线（全算子）：命中 {customAblationResult.baselineCount} 条。
                      {customAblationResult.closedOperators.length > 0 ? (
                        <> 关掉「{customAblationResult.closedOperators.map((o) => OP_LABELS[o] ?? o).join("、")}」后：命中 {customAblationResult.ablatedCount} 条</>
                      ) : (
                        <> 未关任何算子（等价基线）</>
                      )}
                    </div>
                    <div className="flex items-center gap-2 rounded border border-border/60 px-2 py-1.5 text-[11px]">
                      <span className="w-28 shrink-0 font-medium">组合命中变化</span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                        <div
                          className={cn("h-full rounded", customAblationResult.hitChangePct > 20 ? "bg-red-400" : customAblationResult.hitChangePct > 0 ? "bg-amber-400" : "bg-green-400")}
                          style={{ width: `${Math.min(100, customAblationResult.hitChangePct)}%` }}
                        />
                      </div>
                      <span className={cn("w-16 shrink-0 text-right font-mono", customAblationResult.hitChangePct > 20 ? "text-red-600" : customAblationResult.hitChangePct > 0 ? "text-amber-600" : "text-green-700")}>
                        -{customAblationResult.hitChangePct}%
                      </span>
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      勾选算子 = 关闭它，点「运行消融」对比基线。变化越大说明被关的算子贡献越大。
                    </div>
                  </div>
                )}
            </Card>
          </div>
        </div>
      </div>
    </section>
  );
}
