// ReasonPanel.tsx — 推理面板: 输入问题 → 查看推理链
import { useState, useEffect, useRef, type FC } from "react";
import { Loader2, Brain, ChevronRight, ChevronDown, CheckCircle2, XCircle, Clock, Copy, Info, Database, RefreshCw, Users, Wrench, ThumbsUp, ThumbsDown } from "lucide-react";
import { api } from "../lib/api";
import { LlmModelSelector } from "./LlmModelSelector";
import { reasonDemo } from "../lib/reason-demo";
import { reasonStepDocs } from "../lib/reason-step-docs";
import { cn, formatDuration } from "../lib/utils";
import { RetrievalSourceSwitches } from "./RetrievalSourceSwitches";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";

/** 推理 52 步完整链路（对齐 HomePanel REASON_STEPS）+ 触发条件标注 */
const REASON_52_STEPS: Array<{ name: string; trigger?: string; tokens?: { in: number; out: number } }> = [
  // Stage 0-1: 分类 + 大纲 (4步)
  { name: "问题分类" }, { name: "意图识别" }, { name: "术语变体" }, { name: "拆分子问题" },
  // Stage 2: Cognee 17路粗检索 (14步)
  { name: "实体抽取" }, { name: "Cognee HYBRID" }, { name: "RAG补全" }, { name: "图遍历" },
  { name: "关系三元组" }, { name: "摘要检索" }, { name: "子问题推理" }, { name: "上下文扩展" },
  { name: "时序分析", trigger: "时序类问题（何时/最近）" }, { name: "PG实体补漏" }, { name: "PG向量" }, { name: "CHUNKS词法" },
  { name: "语义检索" }, { name: "实体直查" },
  // Stage 3: Graphiti 精炼 (9步)
  { name: "实体精炼" }, { name: "概念搜索" }, { name: "文献蒸馏" }, { name: "领域知识" }, { name: "实体邻居" },
  { name: "段落回溯" }, { name: "论文溯源", trigger: "带 paperId 或论文定位命中" }, { name: "DeepWalk扩展", trigger: "图遍历结果稀疏时" }, { name: "关系查询", trigger: "关系型问题（谁投资/谁创办）" },
  // Stage 3.5: HyperEdge 超边知识层 (5步 — V166+ 新增)
  { name: "超边向量检索", trigger: "前端开启超边层" }, { name: "超边实体导向", trigger: "前端开启超边层" },
  { name: "超边BM25", trigger: "前端开启超边层" }, { name: "三路RRF融合", trigger: "前端开启超边层" }, { name: "时间衰减", trigger: "时序类问题" },
  // Stage 4: 融合生成 (20步)
  { name: "Compiled Truth" }, { name: "多查询变体" }, { name: "HyDE扩展", trigger: "查询词过短/语义模糊" }, { name: "意图调配额" }, { name: "三臂RRF" }, { name: "Cosine重打分" },
  { name: "Boost链" }, { name: "超边配额", trigger: "超边层有命中" }, { name: "LLM重排" }, { name: "压缩段落" }, { name: "COT推理", trigger: "多跳推理类问题" },
  { name: "Agentic搜索", trigger: "首次检索不足时" }, { name: "生成假设" }, { name: "自评校验" }, { name: "置信评估" },
  { name: "溯源标注" }, { name: "回写知识页", trigger: "结论通过评估" }, { name: "失败降级", trigger: "推理失败/置信度过低" },
  { name: "快速回退", trigger: "全栈超时（180s）" }, { name: "响应返回" }
];

/** 可消融算子清单（两组：检索栈 12 个 + 推理链路 9 个） */
const ABLATION_GROUPS: Array<{ key: string; label: string; ops: Array<{ key: string; label: string; desc: string }> }> = [
  {
    key: "search",
    label: "检索栈（12）",
    ops: [
      { key: "compiled_truth", label: "权威版本 ×2.0", desc: "关掉知识页命中加权" },
      { key: "title", label: "标题命中", desc: "关掉查询词命中标题 boost" },
      { key: "chronicle_type", label: "类型加权", desc: "关掉学术/政策事件加权" },
      { key: "backlink", label: "反向链接", desc: "关掉实体关联数加权" },
      { key: "cosine", label: "Cosine 重打分", desc: "关掉 RRF 后余弦混合重排" },
      { key: "dedup", label: "去重", desc: "关掉 4 路去重" },
      { key: "alias", label: "别名消解", desc: "关掉查询词别名归一" },
      { key: "relational", label: "关系臂", desc: "关掉关系型查询召回" },
      { key: "expansion", label: "事件扩展", desc: "关掉种子事件扩展" },
      { key: "graph_traversal", label: "图遍历", desc: "关掉 SQL 递归 2 跳" },
      { key: "multi_query", label: "多查询改写", desc: "关掉 LLM 查询变体" },
      { key: "rerank", label: "LLM 重排", desc: "关掉 reranker 打分" },
    ],
  },
  {
    key: "reason",
    label: "推理链路（9）",
    ops: [
      { key: "outline", label: "大纲生成", desc: "关掉问题拆解" },
      { key: "expand", label: "查询扩展", desc: "关掉 LLM 查询改写" },
      { key: "candidate_papers", label: "候选论文", desc: "关掉候选论文定位" },
      { key: "cognee_arm", label: "Cognee 臂", desc: "关掉 Cognee 粗检索（17 路）" },
      { key: "graphiti_arm", label: "Graphiti 臂", desc: "关掉 Graphiti 精检" },
      { key: "pg_arm", label: "PG 臂", desc: "关掉 PG 全文检索" },
      { key: "entity_extract", label: "实体抽取", desc: "关掉实体抽取" },
      { key: "hypothesis", label: "假设合成", desc: "关掉假设生成" },
      { key: "evaluate", label: "评估", desc: "关掉打分/通过判定" },
    ],
  },
];
import { Textarea } from "../components/ui/textarea";

interface ReasonTask {
  id: string;
  query: string;
  status: string;
  created_at: string;
  completed_at?: string;
}

interface OutlineItem {
  id: string;
  title: string;
  description: string;
  status: string;
}

interface RetrieveStep {
  id: string;
  engine: string;
  search_type: string;
  query: string;
  duration_ms: number;
  status: string;
  error?: string;
  result_count?: number;
  /** V249: 该步真实 LLM token 消耗（后端从 usage 采集，存 parameters.tokens）
   * V381: cacheHit — KV Cache 命中 token（DeepSeek prompt_cache_hit_tokens） */
  tokens?: { in: number; out: number; cacheHit?: number };
}

interface Hypothesis {
  id: string;
  content: string;
  confidence: number;
  reasoning: string;
}

interface Evaluation {
  id: string;
  overall_score: number;
  passed: boolean;
  notes: string;
  /** 演示标记：demo 沙箱回放用预设值；真实推理时后端 LLM Judge 返回真实分（无此字段） */
  isDemo?: boolean;
}

export interface ReasonDetail {
  task: ReasonTask;
  outlines: OutlineItem[];
  retrieveSteps: RetrieveStep[];
  hyperEdges: HyperEdgeItem[];   // V211+: 超边知识层检索结果
  hypotheses: Hypothesis[];
  evaluations: Evaluation[];
}

interface HyperEdgeItem {
  id: string;
  text: string;
  type: string;
  summary: string;
  entities: string[];
  source_title: string;
  pub_year: number | null;
  confidence: number;
  score: number;
}

/** 记忆演示数据（2026-08-07）：沙箱展示记忆面板效果，不消耗 API */
const MEMORY_DEMO_CONTEXTS = [
  {
    query: "资本下乡对农村集体经济的影响及制度约束",
    answer_summary: "资本下乡具有双重效应：正面激活闲置资源、促进集体经济增收；负面存在挤占农户利益风险。制度约束包括土地流转规范与监管工具。",
    citations: ["来源:2019年中央一号文件", "来源:农业农村部土地流转管理办法"],
  },
  {
    query: "工商资本参与乡村振兴的路径有哪些",
    answer_summary: "主要路径包括：产业带动型（特色农业/乡村旅游）、村企合作型（股份合作/保底分红）、平台服务型（冷链物流/电商）三种模式，需防范资本逐利导致的资源错配。",
    citations: ["来源:资本下乡研究综述"],
  },
  {
    query: "农村集体经济组织法对资本入股的规制",
    answer_summary: "集体经济组织法明确集体资产股权量化规则，资本入股须经成员大会决议，收益分配按股分红并保留集体积累，防止资本控制集体资产。",
    citations: ["来源:农村集体经济组织法第45条"],
  },
];

const MEMORY_DEMO_EXPERIENCES = [
  { query: "资本下乡对农村集体经济的双重效应", qtype: "政策评估", quality_score: 0.87, duration_ms: 185000, success: true },
  { query: "土地流转中的产权问题分析", qtype: "多跳推理", quality_score: 0.72, duration_ms: 320000, success: true },
  { query: "乡村振兴战略的资本参与机制", qtype: "概念定义", quality_score: 0.64, duration_ms: 95000, success: false },
];

const reasonApi = {
  async query(sourceId: string, query: string, topK?: number, sources?: Array<"pg" | "graphiti" | "cognee">, mode?: "template" | "adaptive") {
    const res = await fetch("/api/reason/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 2026-08-07 记忆层：传 sessionId（当前用项目级固定 ID，后续可接真实会话）
      body: JSON.stringify({
        sourceId, query, topK,
        ...(sources ? { sources } : {}),
        ...(mode ? { mode } : {}),
        sessionId: "00000000-0000-0000-0000-000000000000",
      }),
    });
    return res.json();
  },
  // 2026-08-07 流式输出：答案分块 SSE 推送（打字机效果），onToken 逐步渲染
  async queryStream(
    sourceId: string, query: string,
    onToken: (text: string) => void,
    topK?: number, sources?: Array<"pg" | "graphiti" | "cognee">, mode?: "template" | "adaptive"
  ): Promise<any> {
    const res = await fetch("/api/reason/query/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId, query, topK,
        ...(sources ? { sources } : {}),
        ...(mode ? { mode } : {}),
        sessionId: "00000000-0000-0000-0000-000000000000",
      }),
    });
    if (!res.body) return res.json();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: any = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const evt = JSON.parse(dataLine.slice(6));
        if (evt.type === "token" && evt.text) onToken(evt.text);
        else if (evt.type === "done") result = evt.result;
        else if (evt.type === "error") throw new Error(evt.message);
      }
    }
    return result;
  },
  async getTask(taskId: string): Promise<ReasonDetail> {
    const res = await fetch(`/api/reason/tasks/${taskId}`);
    return res.json();
  },
  // 2026-08-07 记忆层前端：会话记忆 + 相似经验
  async getMemoryContext(sessionId = "00000000-0000-0000-0000-000000000000"): Promise<any[]> {
    const res = await fetch(`/api/memory/context?sessionId=${sessionId}`);
    const data = await res.json();
    return data.contexts || [];
  },
  async getExperience(query: string): Promise<any[]> {
    const res = await fetch(`/api/memory/experience?query=${encodeURIComponent(query)}`);
    const data = await res.json();
    return data.experiences || [];
  },
  async clearMemory(sessionId = "00000000-0000-0000-0000-000000000000"): Promise<void> {
    await fetch(`/api/memory/context?sessionId=${sessionId}`, { method: "DELETE" });
  },
};

export const ReasonPanel: FC<{ onReasonStart?: () => void }> = ({ onReasonStart }) => {
  const [sourceId, setSourceId] = useState("c609acbf-1d6e-4bd5-9ae1-92fa6c64021a");
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReasonDetail | null>(null);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [sources, setSources] = useState<Array<"pg" | "graphiti" | "cognee">>(["pg"]);
  // V267: 推理模式 — template(固定52步,默认) / adaptive(LLM动态选算子)
  const [mode, setMode] = useState<"template" | "adaptive">("template");
  // 2026-08-07 记忆层前端：会话记忆 + 相似经验 + 反思徽章（默认常驻展示）
  const [memoryContexts, setMemoryContexts] = useState<any[]>([]);
  const [experiences, setExperiences] = useState<any[]>([]);
  const [showMemory, setShowMemory] = useState(true);
  // 2026-08-07 用户画像 + 决策审计
  const [userProfile, setUserProfile] = useState<{ preferredSources: string[]; totalQueries: number; topTopics: string[] } | null>(null);
  const [planRationale, setPlanRationale] = useState<string | null>(null);
  const [reflection, setReflection] = useState<{ triggered: boolean; beforeScore?: number; afterScore?: number; reason?: string } | null>(null);
  // 2026-08-07 流式输出：打字机渲染中的答案
  const [streamingText, setStreamingText] = useState("");
  // 2026-08-07 模型审计：本次推理实际用到的模型
  const [usedModel, setUsedModel] = useState<{ role: string; model: string } | null>(null);
  // 2026-08-07 评审 Agent + 工具调用 + 反馈
  const [reviewInfo, setReviewInfo] = useState<{ score: number; issues: string[]; suggestion: string } | null>(null);
  const [toolCalls, setToolCalls] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<boolean | null>(null);

  const sendFeedback = async (positive: boolean) => {
    setFeedback(positive);
    // 反馈到最近一条经验（若经验列表有第一条）
    if (experiences.length > 0 && experiences[0].id) {
      try {
        await fetch(`/api/memory/experience/${experiences[0].id}/feedback`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positive }),
        });
      } catch { /* 反馈失败静默 */ }
    }
    // V375: 同步写入 OpenViking 长期记忆（用户偏好/约束）
    try {
      const answerText = experiences.length > 0 ? (experiences[0].answer_summary ?? "") : "";
      await fetch("/api/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: positive ? "up" : "down", query, answer: String(answerText).substring(0, 1000) }),
      });
    } catch { /* OpenViking 不可用静默 */ }
  };

  const loadMemory = async (q?: string) => {
    try {
      setMemoryContexts(await reasonApi.getMemoryContext());
      if (q) setExperiences(await reasonApi.getExperience(q));
      // 用户画像
      const res = await fetch("/api/memory/profile");
      const data = await res.json();
      setUserProfile(data.profile || null);
    } catch { /* 记忆加载失败静默 */ }
  };
  const clearMemory = async () => {
    await reasonApi.clearMemory();
    setMemoryContexts([]);
  };
  // 记忆演示：逐步填充演示数据（沙箱，不消耗 API）
  const [memoryDemoPlaying, setMemoryDemoPlaying] = useState(false);
  const memoryDemoTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const playMemoryDemo = () => {
    memoryDemoTimersRef.current.forEach(clearTimeout);
    memoryDemoTimersRef.current = [];
    setMemoryDemoPlaying(true);
    setExperiences([]);
    setMemoryContexts([]);
    MEMORY_DEMO_CONTEXTS.forEach((m, i) => {
      memoryDemoTimersRef.current.push(setTimeout(() => {
        setMemoryContexts((prev) => [...prev, m]);
      }, i * 600));
    });
    // 经验卡片最后填充
    memoryDemoTimersRef.current.push(setTimeout(() => {
      setExperiences(MEMORY_DEMO_EXPERIENCES);
      setMemoryDemoPlaying(false);
    }, MEMORY_DEMO_CONTEXTS.length * 600 + 400));
  };

  // 沙箱 demo：挂载时自动播放预设推理演示（GBrain 模式：静态回放，不真打 API）
  useEffect(() => {
    // 2026-08-07 记忆层：挂载时加载会话记忆
    void loadMemory();
    // 加载项目列表，选中第一个（消融/推理用）
    api.listProjects().then((data) => {
      if (data.projects.length > 0) setSourceId(data.projects[0].id);
    }).catch(() => {});
    if (!demoRef.current) {
      demoRef.current = true;
      const demo = reasonDemo.get();
      setQuery(demo.task.query);
      setDetail(demo);
      setTaskId("demo-reason-task");
      setDemoPlaying(true);
    }
  }, []);

  // 沙箱 demo 播放（GBrain 模式：静态数据展示四个区域，不真打 API）
  const [demoPlaying, setDemoPlaying] = useState(false);
  const demoRef = useRef(false);
  // 交互式消融（推理页：12 算子开关）
  const [closedOps, setClosedOps] = useState<Set<string>>(new Set());
  const [ablationResult, setAblationResult] = useState<{ baselineCount: number; ablatedCount: number; overlapWithBaseline: number; hitChangePct: number; closedOperators: string[] } | null>(null);
  const [ablationLoading, setAblationLoading] = useState(false);

  const toggleOp = (key: string) => {
    setClosedOps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const runGroupAblation = async (groupKey: string) => {
    if (!query.trim() || !sourceId) return;
    setAblationLoading(true);
    setAblationResult(null);
    try {
      const group = ABLATION_GROUPS.find((g) => g.key === groupKey);
      if (!group) return;
      // 本组勾选的算子
      const ops = group.ops.filter((op) => closedOps.has(op.key)).map((op) => op.key);
      if (groupKey === "search") {
        // 检索栈组：走 search-service 消融接口
        const data = await api.runCustomAblation({ query: query.trim(), sourceIds: [sourceId], ablation: ops });
        setAblationResult(data);
      } else {
        // 推理链路组：走推理消融接口（需完整模式）
        const res = await fetch("/api/reason/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceId, query: query.trim(), ablation: ops }),
        });
        const data = await res.json();
        if (data.error) {
          setError(`${data.error.message || "推理消融失败"}（需完整模式）`);
          setAblationResult({ baselineCount: 0, ablatedCount: 0, overlapWithBaseline: 0, hitChangePct: 0, closedOperators: ops });
        } else {
          const hyp = data.trace?.hypothesis as { content?: string } | undefined;
          const eval2 = data.trace?.evaluation as { passed?: boolean } | undefined;
          const ok = Boolean(hyp?.content) && eval2?.passed !== false;
          setAblationResult({
            baselineCount: ok ? 1 : 0,
            ablatedCount: ok ? 1 : 0,
            overlapWithBaseline: ok ? 1 : 0,
            hitChangePct: ok ? 0 : 100,
            closedOperators: ops,
          });
        }
      }
    } catch { /* 失败不阻断 */ }
    finally { setAblationLoading(false); }
  };
  const [error, setError] = useState("");

  async function runReason() {
    if (!sourceId || !query) return;
    setRunning(true);
    setError("");
    setDetail(null);
    setStreamingText("");
    onReasonStart?.();  // V214: 通知 App 清空右侧面板(搜索过程+原始日志)，只展示本次推理
    try {
      // 2026-08-07 流式输出：答案打字机效果逐步渲染
      const result = await reasonApi.queryStream(
        sourceId, query,
        (text) => setStreamingText((prev) => prev + text),
        undefined, sources, mode
      );
      if (result.error) {
        setError(result.error.message || "推理失败");
      } else {
        // API 返回 { taskId, trace: { outline, retrieveResults, hypothesis, evaluation, timings } }
        // 包装成 ReasonDetail 结构给面板渲染
        const d: ReasonDetail = {
          task: { id: result.taskId, query: result.trace?.query || query, status: 'completed', created_at: new Date().toISOString() },
          outlines: (result.trace?.outline || []).map((o: any, i: number) => ({ id: o.id || String(i), title: o.title, description: o.description || '', status: 'completed' })),
          retrieveSteps: (result.trace?.retrieveResults || []).flatMap((rr: any) => (rr.results || []).map((r: any) => ({
            id: Math.random().toString(36).slice(2),
            engine: r.engine,
            search_type: r.toolName || '',
            query: '',
            duration_ms: r.durationMs || 0,
            status: r.error ? 'failed' : 'completed',
            error: r.error,
          }))),
          hyperEdges: (result.trace?.hyperEdges || []).map((h: any) => ({
            id: h.id || '',
            text: h.text || '',
            type: h.type || '其他',
            summary: h.summary || '',
            entities: h.entities || [],
            source_title: h.source_title || '',
            pub_year: h.pub_year || null,
            confidence: h.confidence || 0,
            score: h.score || 0,
          })),
          hypotheses: [{
            id: 'h1',
            content: result.trace?.hypothesis?.content || '',
            confidence: result.trace?.hypothesis?.confidence || 0.5,
            reasoning: result.trace?.hypothesis?.reasoning || '',
          }],
          evaluations: [{
            id: 'e1',
            overall_score: result.trace?.evaluation?.overallScore || 0,
            passed: result.trace?.evaluation?.passed || false,
            notes: result.trace?.evaluation?.notes || '',
          }],
        };
        setTaskId(result.taskId);
        setDetail(d);
        // 2026-08-07 记忆层：推理完成后刷新记忆 + 相似经验 + 反思徽章 + 评审 + 工具
        setReflection(result.trace?.reflection || null);
        setReviewInfo(result.trace?.review || null);
        setToolCalls(result.trace?.toolCalls || []);
        setPlanRationale(result.trace?.planRationale || null);
        setUsedModel(result.trace?.model || null);
        setFeedback(null);
        void loadMemory(query);
        // 重新拉取完整任务详情（getReasonTaskDetail 返回全部步骤——实时 trace 只含检索阶段）
        try {
          const full = await reasonApi.getTask(result.taskId);
          if (full && full.retrieveSteps && full.retrieveSteps.length > 0) {
            setDetail(full);
          }
        } catch { /* 详情拉取失败用实时 trace */ }
        // 联动知识页：推理结论沉淀为证据
        try {
          const evidence = [
            { title: "推理假设", content: result.trace?.hypothesis?.content || "" },
            { title: "推理评估", content: result.trace?.evaluation?.notes || "" }
          ].filter((e) => e.content);
          if (evidence.length > 0) {
            await api.associateSearch(query, evidence);
          }
        } catch { /* 联动失败不影响主流程 */ }
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div className="mb-1 flex items-center gap-2">
        <Brain className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">推理工作台</h2>
        <span className="text-xs text-muted-foreground">52 步推理链路 · 三库任意组合 · 事实溯源 · 超边知识</span>
      </div>

      {/* V267: 推理模式切换 — 模板(固定52步) / 自适应(LLM动态选算子) */}
      <div className="flex items-center gap-2">
        <div className="flex rounded-md border border-border p-0.5">
          <button
            type="button"
            onClick={() => setMode("template")}
            className={cn(
              "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
              mode === "template" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            title="固定 52 步流水线（评测基线 0.870）"
          >
            模板 52 步
          </button>
          <button
            type="button"
            onClick={() => setMode("adaptive")}
            className={cn(
              "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
              mode === "adaptive" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            title="LLM 动态选择算子（简单问题 5 步收敛，复杂问题自动加算子）"
          >
            自适应
          </button>
        </div>
        {mode === "adaptive" && (
          <span className="text-[10px] text-muted-foreground/70">LLM 规划算子 · 简单题收敛 / 难题加深</span>
        )}
        {/* 2026-08-07 记忆层：会话记忆开关（默认常驻展开，可收起） */}
        <button
          type="button"
          onClick={() => setShowMemory((v) => !v)}
          className={cn(
            "flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors",
            showMemory ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"
          )}
          title="会话记忆：历史问答上下文（推理时自动注入）"
        >
          <Database className="h-3 w-3" />
          {showMemory ? "收起记忆" : `记忆 ${memoryContexts.length > 0 ? `(${memoryContexts.length})` : ""}`}
        </button>
      </div>

      {/* 2026-08-07 记忆层：会话记忆面板 + 相似经验 */}
      {showMemory && (
        <div className="space-y-2 rounded-lg border border-border/70 bg-background/40 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Database className="h-3 w-3 text-primary" />
              <span className="text-xs font-medium text-primary">会话记忆 · 推理时注入上下文</span>
              {memoryContexts.length > 0 && (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary">{memoryContexts.length} 条</span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={playMemoryDemo}
                disabled={memoryDemoPlaying}
                className="rounded border border-dashed border-primary/40 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/5 disabled:opacity-50"
                title="播放记忆演示（沙箱 · 不消耗 API）"
              >
                {memoryDemoPlaying ? "播放中…" : "播放演示"}
              </button>
              <button
                type="button"
                onClick={() => void loadMemory()}
                className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                title="刷新记忆"
              >
                刷新
              </button>
              {memoryContexts.length > 0 && (
                <button
                  type="button"
                  onClick={() => void clearMemory()}
                  className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-red-500"
                >
                  清空
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowMemory(false)}
                className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              >
                收起
              </button>
            </div>
          </div>
          {memoryContexts.length === 0 && !memoryDemoPlaying ? (
            <div className="text-[11px] text-muted-foreground/60">
              暂无记忆 — 完成一次推理后自动沉淀（问题/答案摘要/引用）
              <button
                type="button"
                onClick={playMemoryDemo}
                className="ml-2 rounded border border-dashed border-primary/40 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/5"
              >
                播放演示看看效果
              </button>
            </div>
          ) : memoryContexts.length === 0 && memoryDemoPlaying ? (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> 正在填充演示记忆…
            </div>
          ) : (
            <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
              {memoryContexts.map((m, i) => (
                <div key={i} className="rounded bg-muted/30 p-2">
                  <div className="text-[11px] font-medium text-foreground">Q: {m.query}</div>
                  <div className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">
                    A: {m.answer_summary || m.answerSummary || "（无摘要）"}
                  </div>
                  {Array.isArray(m.citations) && m.citations.length > 0 && (
                    <div className="mt-1 text-[9px] text-muted-foreground/60">引用 {m.citations.length} 条</div>
                  )}
                </div>
              ))}
            </div>
          )}
          {userProfile && userProfile.totalQueries > 0 && (
            <div className="mt-1 rounded bg-primary/5 p-2">
              <div className="text-[11px] font-medium text-primary">用户画像 · 个性化路由</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
                <span className="text-muted-foreground">提问 {userProfile.totalQueries} 次</span>
                {userProfile.topTopics.length > 0 && (
                  <>
                    <span className="text-muted-foreground/60">高频主题:</span>
                    {userProfile.topTopics.slice(0, 4).map((t) => (
                      <span key={t} className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">{t}</span>
                    ))}
                  </>
                )}
                {userProfile.preferredSources.length > 0 && (
                  <span className="text-muted-foreground/60">偏好源: {userProfile.preferredSources.join("/")}</span>
                )}
              </div>
            </div>
          )}
          {/* 2026-08-07 决策审计：规划 rationale（adaptive 模式） */}
          {planRationale && (
            <div className="mt-1 rounded bg-amber-50/40 p-2">
              <div className="text-[11px] font-medium text-amber-800">规划决策 · LLM 依据</div>
              <div className="mt-0.5 text-[10px] text-amber-800/80">{planRationale}</div>
            </div>
          )}
          {experiences.length > 0 && (
            <>
              <div className="mt-1 border-t border-border/50 pt-2 text-xs font-medium text-primary">相似问题经验 · 规划参考</div>
              <div className="space-y-1.5">
                {experiences.map((e, i) => (
                  <div key={i} className="rounded bg-muted/20 p-2 text-[10px]">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-muted-foreground">{e.query}</span>
                      <span className={cn(
                        "ml-auto shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px]",
                        (e.quality_score ?? 0) >= 0.6 ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
                      )}>
                        {(e.quality_score ?? 0).toFixed(2)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-muted-foreground/70">
                      {e.qtype || ""} · {Math.round((e.duration_ms ?? 0) / 1000)}s · {e.success ? "成功" : "失败"}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* 2026-08-07 反思徽章：Judge 低分 → 反思修正 → 复评 */}
      {reflection?.triggered && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200/60 bg-amber-50/40 px-3 py-2 text-[11px] text-amber-800">
          <RefreshCw className="h-3.5 w-3.5" />
          <span className="font-medium">反思修正</span>
          <span className="text-muted-foreground">
            初评 {(reflection.beforeScore ?? 0).toFixed(2)} → 复评 {(reflection.afterScore ?? 0).toFixed(2)}
          </span>
        </div>
      )}

      {/* 2026-08-07 评审 Agent 徽章：独立角色审核结果 */}
      {reviewInfo && (
        <div className="flex items-start gap-2 rounded-md border border-blue-200/60 bg-blue-50/30 px-3 py-2 text-[11px] text-blue-900">
          <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium">评审 Agent</span>
              <span className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[9px]",
                (reviewInfo.score ?? 0) >= 0.6 ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
              )}>
                {(reviewInfo.score ?? 0).toFixed(2)}
              </span>
            </div>
            {reviewInfo.issues && reviewInfo.issues.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {reviewInfo.issues.slice(0, 3).map((issue, i) => (
                  <div key={i} className="truncate text-[10px] text-blue-800/80">• {issue}</div>
                ))}
              </div>
            )}
            {reviewInfo.suggestion && (
              <div className="mt-1 text-[10px] text-blue-800/70">建议: {reviewInfo.suggestion}</div>
            )}
          </div>
        </div>
      )}

      {/* 2026-08-07 工具调用徽章：代码执行/网页抓取 */}
      {toolCalls && toolCalls.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-cyan-200/60 bg-cyan-50/30 px-3 py-2 text-[11px] text-cyan-900">
          <Wrench className="h-3.5 w-3.5" />
          <span className="font-medium">工具调用</span>
          {toolCalls.map((t, i) => (
            <span key={i} className="rounded bg-cyan-100/70 px-1.5 py-0.5 font-mono text-[9px] text-cyan-800">{t}</span>
          ))}
          <span className="text-cyan-800/60">已增强推理上下文</span>
        </div>
      )}

      {/* 2026-08-07 用户反馈：点赞/点踩 → 影响经验排序 */}
      {detail && (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void sendFeedback(true)}
            className={cn(
              "flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors",
              feedback === true ? "border-green-400/50 bg-green-50 text-green-700" : "border-border text-muted-foreground hover:bg-accent"
            )}
            title="这个回答有帮助"
          >
            <ThumbsUp className="h-3 w-3" /> 有帮助
          </button>
          <button
            type="button"
            onClick={() => void sendFeedback(false)}
            className={cn(
              "flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors",
              feedback === false ? "border-red-400/50 bg-red-50 text-red-700" : "border-border text-muted-foreground hover:bg-accent"
            )}
            title="这个回答有问题"
          >
            <ThumbsDown className="h-3 w-3" /> 不准确
          </button>
        </div>
      )}

      <RetrievalSourceSwitches chain="reason" onChange={(s) => setSources(s)} />

      {/* demo 播放提示条（GBrain：沙箱回放，点"我自己输入"退出） */}
      {demoPlaying && (
        <div className="flex items-center gap-2 rounded-md border border-primary/25 bg-primary/5 px-4 py-2 text-xs">
          <Info className="h-3.5 w-3.5 text-primary" />
          <span className="text-muted-foreground">正在播放预设推理演示（沙箱回放 · 不消耗 API）</span>
          <button
            type="button"
            onClick={() => { setDemoPlaying(false); setDetail(null); setQuery(""); setTaskId(null); }}
            className="ml-auto rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            我自己输入
          </button>
        </div>
      )}

      {/* 输入区 */}
      <Card className="p-4">
        <div className="flex flex-col gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">项目 ID</label>
            <div className="flex items-center gap-2">
              <Input
                spellCheck={false}
                autoComplete="off"
                placeholder="8ecb4299-... 或填写你自己的项目ID"
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                title="复制项目 ID"
                onClick={() => {
                  if (sourceId) {
                    void navigator.clipboard.writeText(sourceId);
                  }
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Info className="h-3 w-3" />
              默认使用当前项目 ID；填写你项目对应的 UUID 可切换检索范围
            </p>
          </div>
          <Textarea
            className="min-h-[80px]"
            placeholder="输入研究问题..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={running}
          />
          <div className="flex items-center gap-2 self-end">
            {/* 2026-08-07 LLM 模型选择：推理页在左，提交推理在右 */}
            <LlmModelSelector />
            <Button
              onClick={runReason}
              disabled={running || !sourceId || !query}
            >
              {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              提交推理
            </Button>
          </div>
        </div>
      </Card>

      {error ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : null}

      {/* 推理链可视化 */}
      {detail ? (
        <div className="flex flex-col gap-4">
          {/* 答案与证据（推理假设结论）— 2026-08-07 流式：打字机逐步渲染 */}
          {streamingText ? (
            <Card className="p-4">
              <h3 className="mb-2 flex items-center gap-2 font-medium text-sm text-muted-foreground">
                答案与证据
                {running && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
              </h3>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{streamingText}</p>
              {running && <div className="mt-1 text-[10px] text-muted-foreground/60">推理完成，正在输出答案…</div>}
            </Card>
          ) : detail.hypotheses?.length > 0 ? (
            <Card className="p-4">
              <h3 className="mb-2 flex items-center gap-2 font-medium text-sm text-muted-foreground">
                答案与证据
                {/* 2026-08-07 模型名展示：本次推理实际用到的模型 */}
                {usedModel && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary" title="本次推理实际使用模型">
                    {usedModel.model}
                  </span>
                )}
              </h3>
              <p className="text-sm leading-relaxed">{detail.hypotheses[0].content}</p>
              {detail.hypotheses[0].reasoning ? (
                <div className="mt-2 rounded bg-accent/50 p-2 text-xs text-muted-foreground">
                  <span className="font-medium text-muted-foreground">推理依据：</span>
                  {detail.hypotheses[0].reasoning}
                </div>
              ) : null}
              {detail.evaluations?.[0] ? (
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <span className={cn("rounded px-2 py-0.5 font-medium", detail.evaluations[0].passed ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700")}>
                    {detail.evaluations[0].passed ? "✓ 通过" : "✗ 未通过"}
                  </span>
                  {detail.evaluations[0].isDemo ? (
                    // 沙箱演示：预设值，非真实评测（真实推理时由后端 LLM Judge 返回）
                    <span className="text-muted-foreground">
                      演示评分 <span className="font-mono font-medium text-foreground">{detail.evaluations[0].overall_score.toFixed(2)}</span>/1
                      <span className="ml-1 rounded bg-amber-50 px-1 py-0.5 text-[9px] text-amber-700">演示值</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">综合评分 {((detail.evaluations[0].overall_score ?? 0)).toFixed(3)}</span>
                  )}
                </div>
              ) : null}
            </Card>
          ) : null}

          {/* 任务状态 */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" />
            任务 {taskId?.slice(0, 8)}...
            {detail.task?.status === "completed" ? (
              <span className="flex items-center gap-1 text-green-600">
                <CheckCircle2 className="h-4 w-4" /> 完成
              </span>
            ) : detail.task?.status === "failed" ? (
              <span className="flex items-center gap-1 text-red-600">
                <XCircle className="h-4 w-4" /> 失败
              </span>
            ) : (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
          </div>

          {/* 大纲 */}
          {detail.outlines?.length > 0 ? (
            <Card className="p-4">
              <h3 className="mb-2 font-medium text-sm text-muted-foreground">问题拆解</h3>
              <div className="flex flex-col gap-2">
                {detail.outlines.map((o, i) => (
                  <div key={o.id} className="flex items-start gap-2 rounded bg-accent/50 p-2 text-sm">
                    <span className="font-mono text-xs text-muted-foreground">{i + 1}.</span>
                    <div>
                      <div className="font-medium">{o.title}</div>
                      <div className="text-xs text-muted-foreground">{o.description?.substring(0, 120)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {/* 检索步骤（52 步完整推理链路：已执行显示真实数据，其余灰态） */}
          <Card className="p-4">
            <h3 className="mb-2 font-medium text-sm text-muted-foreground">
              检索步骤（{detail.retrieveSteps?.length ?? 0}/{REASON_52_STEPS.length} 步 · 52 步推理链路）
            </h3>
            <div className="flex flex-col gap-1">
              {REASON_52_STEPS.map((step, index) => {
                // 已执行的步骤：按顺序对齐（第 i 步 ↔ 第 i 条 retrieveSteps，比模糊匹配更准）
                const exec = detail.retrieveSteps?.[index];
                const isExecuted = Boolean(exec && exec.status === "completed");
                return (
                  <div
                    key={`${step.name}-${index}`}
                    className={cn(
                      "rounded border px-3 py-2 text-sm transition-colors",
                      isExecuted
                        ? exec?.status === "completed" ? "border-border hover:border-primary/25" : "border-red-200 bg-red-50/60"
                        : "border-dashed border-border/50 bg-muted/20"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => isExecuted && setExpandedStep(expandedStep === exec.id ? null : exec.id)}
                      className="flex w-full items-center justify-between text-left"
                      disabled={!isExecuted}
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-6 shrink-0 rounded bg-muted px-1 text-center text-[10px] text-muted-foreground">{index + 1}</span>
                        {isExecuted ? (
                          exec?.status === "completed"
                            ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                            : <XCircle className="h-3.5 w-3.5 text-red-600" />
                        ) : (
                          <span className="h-3.5 w-3.5 rounded-full border border-muted-foreground/30" />
                        )}
                        <span className={cn(isExecuted ? "font-medium" : "text-muted-foreground")}>{step.name}</span>
                        {isExecuted && exec?.engine && (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-mono text-primary">
                            {exec.engine}
                          </span>
                        )}
                        {isExecuted && exec?.query && (
                          <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform", expandedStep === exec.id && "rotate-180")} />
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {step.trigger && (
                          <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[9px] text-amber-700" title={step.trigger}>
                            条件触发
                          </span>
                        )}
                        {isExecuted && exec?.result_count != null && (
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                            入 {exec.result_count} → 出 {exec.result_count}
                          </span>
                        )}
                        {isExecuted && exec?.tokens && (
                          <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
                            tok {exec.tokens.in + exec.tokens.out}
                            {typeof exec.tokens.cacheHit === "number" && exec.tokens.cacheHit > 0 && (
                              <span className="ml-1 text-emerald-600" title="KV Cache 命中 token（前缀复用）">
                                ⚡{Math.round((exec.tokens.cacheHit / exec.tokens.in) * 100)}% 命中
                              </span>
                            )}
                          </span>
                        )}
                        {isExecuted ? (
                          <span className="font-mono">{formatDuration(exec.duration_ms)}</span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground/50">待执行</span>
                        )}
                      </div>
                    </button>
                    {/* 可展开：已执行步骤的 query/参数 + 公式/SQL/代码（Ask 同款） */}
                    {isExecuted && expandedStep === exec.id && (
                      <div className="mt-2 space-y-1 border-t border-border/50 pt-2">
                        {exec.query && (
                          <div className="text-xs">
                            <span className="text-muted-foreground">query: </span>
                            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{exec.query.slice(0, 200)}</code>
                          </div>
                        )}
                        {exec.error && <div className="text-xs text-red-600">error: {exec.error}</div>}
                        <div className="text-xs text-muted-foreground">
                          结果数: <span className="font-mono">{exec.result_count ?? "?"}</span> · 引擎: {exec.engine}
                        </div>
                        {/* 步骤文档：公式/SQL/代码（GBrain 教学台，与 Ask step-docs 同款） */}
                        {(() => {
                          const doc = reasonStepDocs.get(step.name);
                          if (!doc) return null;
                          return (
                            <div className="mt-2 space-y-1.5 rounded bg-muted/30 p-2">
                              <div className="text-[10px] font-medium text-primary">{step.name} · 真实实现</div>
                              <div className="text-[10px] text-muted-foreground">{doc.what}</div>
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
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          {/* 引用证据：超边知识层检索结果（N元结构化知识片段） */}
          {detail.hyperEdges?.length > 0 ? (
            <Card className="p-4">
              <h3 className="mb-2 font-medium text-sm text-muted-foreground">
                引用证据（{detail.hyperEdges.length} 条 · 超边知识 · Stage 3.5）
              </h3>
              <div className="flex flex-col gap-2">
                {detail.hyperEdges.map((h, index) => (
                  <div key={h.id || index} className="rounded bg-accent/50 px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{h.type}</span>
                      <span className="flex-1 text-xs leading-relaxed">{h.summary || h.text}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {h.source_title?.slice(0, 12)} {h.pub_year || ''} · 置信{h.confidence}
                      </span>
                    </div>
                    {h.entities?.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {h.entities.slice(0, 5).map((e) => (
                          <span key={e} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{e}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {/* 消融实验（交互式：两组算子——检索栈 12 + 推理链路 9，各自独立运行） */}
          <Card className="p-4">
            <div className="mb-2 text-sm font-medium">消融实验</div>
            {/* 两组算子：检索栈（12）+ 推理链路（9），各自独立运行 */}
            {ABLATION_GROUPS.map((group) => (
              <div key={group.key} className="mb-3">
                <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
                  {group.label}
                  <span className="text-[10px] font-normal">{group.key === "search" ? "检索层组件（与 Ask 共用）" : "推理层组件（四路分调/假设/评估）"}</span>
                  <button
                    type="button"
                    onClick={() => void runGroupAblation(group.key)}
                    disabled={ablationLoading}
                    className="ml-auto rounded bg-accent px-2 py-0.5 text-[10px] font-normal text-muted-foreground hover:bg-accent/70"
                  >
                    {ablationLoading ? "跑消融中…" : "运行本组消融"}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4">
                  {group.ops.map((op) => {
                    const off = closedOps.has(op.key);
                    return (
                      <button
                        key={op.key}
                        type="button"
                        onClick={() => toggleOp(op.key)}
                        className={cn(
                          "flex items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[11px] transition-colors",
                      off ? "border-red-300 bg-red-50 text-red-700" : "border-border text-muted-foreground hover:border-primary/40"
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
              </div>
            ))}
            {ablationResult && (
              <>
                <div className="mb-1.5 text-[11px] text-muted-foreground">
                  基线（全算子）：命中 {ablationResult.baselineCount} 条。
                  {ablationResult.closedOperators.length > 0 ? (
                    <> 关掉「{ablationResult.closedOperators.join("、")}」后：命中 {ablationResult.ablatedCount} 条</>
                  ) : (
                    <> 未关任何算子（等价基线）</>
                  )}
                </div>
                <div className="flex items-center gap-2 rounded border border-border/60 px-2 py-1.5 text-[11px]">
                  <span className="w-28 shrink-0 font-medium">组合命中变化</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                    <div
                      className={cn("h-full rounded", ablationResult.hitChangePct > 20 ? "bg-red-400" : ablationResult.hitChangePct > 0 ? "bg-amber-400" : "bg-green-400")}
                      style={{ width: `${Math.min(100, ablationResult.hitChangePct)}%` }}
                    />
                  </div>
                  <span className={cn("w-16 shrink-0 text-right font-mono", ablationResult.hitChangePct > 20 ? "text-red-600" : ablationResult.hitChangePct > 0 ? "text-amber-600" : "text-green-700")}>
                    -{ablationResult.hitChangePct}%
                  </span>
                </div>
              </>
            )}
            <div className="mt-2 text-[10px] text-muted-foreground">
              勾选算子 = 关闭它，点「运行消融」对比基线（命中变化 %）。评测基线 50 题 0.870。
            </div>
          </Card>

          {/* 评测详情（保留，答案框已含摘要） */}
          {detail.evaluations?.length > 0 ? (
            <Card className="p-4">
              <h3 className="mb-2 font-medium text-sm text-muted-foreground">评测</h3>
              <div className="flex items-center gap-3 text-sm">
                {detail.evaluations[0].isDemo ? (
                  // 沙箱演示：预设值 0.9/1（真实推理时由后端 LLM Judge 返回真实分）
                  <span className="text-lg font-semibold">{detail.evaluations[0].overall_score.toFixed(2)}/1</span>
                ) : (
                  <span className="text-lg font-semibold">
                    {(detail.evaluations[0].overall_score).toFixed(3)}
                  </span>
                )}
                {detail.evaluations[0].passed ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-500" />
                )}
                {detail.evaluations[0].isDemo && (
                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">演示值 · 非真实评测</span>
                )}
                <span className="text-xs text-muted-foreground">{detail.evaluations[0].notes}</span>
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* 空状态 */}
      {!detail && !error ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          输入项目 ID 和研究问题，点击「提交推理」开始
        </div>
      ) : null}
    </div>
  );
};
