// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// AgentConsole.tsx — Agent 控制台（V392）
// 3 tab: 防错规则(预防规则管理) / 战略记忆(项目目标约束) / 执行日志(日志+成本+消息流)
// V392增强: 播放演示(demo逐步填充三tab) + 顶部统计概览 + 演示数据标注
import { useEffect, useRef, useState, type FC } from "react";
import { ShieldAlert, Brain, ScrollText, Plus, Trash2, Power, RefreshCw, Sparkles, FileSearch, BarChart3, Wrench, ShieldCheck } from "lucide-react";
import { cn } from "../lib/utils";

// ─── 防错规则 ───
interface Rule { id: number; category: string; pattern: string; rule: string; source: string; hitCount: number; enabled: boolean; createdAt: string; }
// ─── 战略记忆 ───
interface StrategicMem { id: number; kind: string; content: string; source: string; createdAt: string; }
// ─── 执行日志 ───
interface ExecLog { id: number; taskId?: string; stepId?: string; action: string; tool?: string; inputSummary?: string; outputSummary?: string; costCents: number; tokensIn: number; tokensOut: number; status: string; durationMs: number; createdAt: string; }
interface CostSummary { totalCostCents: number; totalTokens: number; execCount: number; byTool: Array<{ tool: string; costCents: number; count: number }>; }
interface AgentMsg { id: number; fromAgent: string; toAgent: string; msgType: string; payload: Record<string, unknown>; }

const KIND_LABELS: Record<string, string> = { goal: "目标", decision: "决策", constraint: "约束", milestone: "里程碑" };
const SOURCE_LABELS: Record<string, string> = { user: "用户", agent: "Agent", system: "系统", user_down: "踩反馈", eval_failure: "评测失败", manual: "手动" };
const CATEGORY_COLORS: Record<string, string> = {
  relevance: "bg-amber-100 text-amber-700", accuracy: "bg-red-100 text-red-700", completeness: "bg-blue-100 text-blue-700",
  citation: "bg-purple-100 text-purple-700", format: "bg-emerald-100 text-emerald-700", unknown: "bg-muted text-muted-foreground",
};

// ─── 演示数据（沙箱, 不调 API） ───
const DEMO_RULES: Rule[] = [
  { id: 101, category: "completeness", pattern: "影响类问题", rule: "回答影响类问题必须覆盖正面效应与风险两面，并引用具体年份数据，避免单边论述。", source: "user_down", hitCount: 3, enabled: true, createdAt: new Date().toISOString() },
  { id: 102, category: "accuracy", pattern: "概念定义", rule: "定义术语时必须标注出处文献或检索来源，不能只给自创表述。", source: "eval_failure", hitCount: 2, enabled: true, createdAt: new Date().toISOString() },
  { id: 103, category: "citation", pattern: "政策引用", rule: "引用政策条款必须标注法规名称与发布年份，无法追溯的来源不得引用。", source: "user_down", hitCount: 1, enabled: true, createdAt: new Date().toISOString() },
];
const DEMO_MEMORIES: StrategicMem[] = [
  { id: 201, kind: "goal", content: "本研究聚焦资本下乡对农村集体经济的双重效应，回答须紧扣该主题。", source: "user", createdAt: new Date().toISOString() },
  { id: 202, kind: "constraint", content: "文献引用必须来自三库检索结果，不得编造来源。", source: "user", createdAt: new Date().toISOString() },
  { id: 203, kind: "decision", content: "实证部分采用双重差分法(DID)并报告稳健性检验。", source: "agent", createdAt: new Date().toISOString() },
  { id: 204, kind: "milestone", content: "7月底完成文献综述初稿，8月中完成实证分析。", source: "user", createdAt: new Date().toISOString() },
];
const DEMO_LOGS: ExecLog[] = [
  { id: 301, taskId: "demo", stepId: "s1", action: "tool_call", tool: "retrieve", inputSummary: "资本下乡的政策背景与主要模式", outputSummary: "检索到 12 篇相关文献（2018-2025）", costCents: 2, tokensIn: 850, tokensOut: 260, status: "ok", durationMs: 1834, createdAt: new Date().toISOString() },
  { id: 302, taskId: "demo", stepId: "s2", action: "tool_call", tool: "reason", inputSummary: "资本下乡对农村集体经济的影响机制", outputSummary: "推理结论: 存在资源激活与利益挤占双重效应", costCents: 15, tokensIn: 3200, tokensOut: 1400, status: "ok", durationMs: 12400, createdAt: new Date().toISOString() },
  { id: 303, taskId: "demo", stepId: "s3", action: "tool_call", tool: "write", inputSummary: "撰写综述初稿（正面效应与风险）", outputSummary: "综述初稿完成（约3000字）", costCents: 8, tokensIn: 1500, tokensOut: 2100, status: "ok", durationMs: 8600, createdAt: new Date().toISOString() },
  { id: 304, taskId: "demo", stepId: "s4", action: "reflect", tool: "llm-reflect", inputSummary: "第 1 轮产出评估", outputSummary: "verdict=pass score=0.72", costCents: 3, tokensIn: 400, tokensOut: 120, status: "ok", durationMs: 2100, createdAt: new Date().toISOString() },
  { id: 305, taskId: "demo", stepId: "s5", action: "tool_call", tool: "review", inputSummary: "评审综述并修正", outputSummary: "评审通过，修正 2 处表述（土地流转→经营权流转）", costCents: 3, tokensIn: 600, tokensOut: 200, status: "ok", durationMs: 3400, createdAt: new Date().toISOString() },
];
const DEMO_MSGS: AgentMsg[] = [
  { id: 401, fromAgent: "orchestrator", toAgent: "worker-1", msgType: "task", payload: { goal: "梳理资本下乡的学术定义与政策背景", assignee: "retriever" } },
  { id: 402, fromAgent: "orchestrator", toAgent: "worker-2", msgType: "task", payload: { goal: "归纳对农村集体经济的多维影响", assignee: "retriever" } },
  { id: 403, fromAgent: "orchestrator", toAgent: "worker-3", msgType: "task", payload: { goal: "分析影响机制与典型案例", assignee: "writer" } },
  { id: 404, fromAgent: "worker-1", toAgent: "orchestrator", msgType: "result", payload: { result: "张良(2016)等定义演进…" } },
  { id: 405, fromAgent: "worker-2", toAgent: "orchestrator", msgType: "result", payload: { result: "塘约村案例: 集体收入增长3.2倍…" } },
  { id: 406, fromAgent: "worker-3", toAgent: "orchestrator", msgType: "result", payload: { result: "机制: 要素重组+利益挤占双轨…" } },
  { id: 407, fromAgent: "orchestrator", toAgent: "user", msgType: "result", payload: { summary: "研究报告: 概念/影响/机制/制度回应" } },
  // G14: 评审报告 demo — 模拟 orchestrate 完成后 reviewer 质量门消息（前端渲染评审卡）
  { id: 408, fromAgent: "reviewer", toAgent: "user", msgType: "status", payload: { status: "reviewed", reviewVerdict: "needs_revision", reviewScore: 0.74, reviewReport: "## 评审报告（资本下乡对农村集体经济的影响）\n**综合评分**: 0.74/1.0 · **结论**: ⚠️ 需修改\n- **C刊审稿人**: needs_revision (0.72) — 优点: 案例数据详实; 不足: 正反效应论证篇幅失衡\n- **方法论专家**: needs_revision (0.76) — 优点: 机制链条完整; 不足: 结论对政策回应不足\n\n**对抗质疑**:\n1. 塘约村个案能否代表中西部普遍情况？\n2. 「双轨并进」与现行土地政策是否有冲突？\n3. 利益挤占的量化证据是否充分？" } },
];
const DEMO_COST: CostSummary = { totalCostCents: 31, totalTokens: 12860, execCount: 5, byTool: [{ tool: "reason", costCents: 15, count: 1 }, { tool: "write", costCents: 8, count: 1 }, { tool: "reflect", costCents: 3, count: 1 }, { tool: "review", costCents: 3, count: 1 }, { tool: "retrieve", costCents: 2, count: 1 }] };
// G-demo: 情景记忆演示（研究轨迹沉淀 → 检索复用）
const DEMO_EPISODIC: any[] = [
  { id: 501, goal: "资本下乡对农村集体经济的双重效应", summary: "塘约村案例: 集体收入增长 3.2 倍; 代村案例: 农户分红占比仅 21%, 存在利益挤占风险; 结论需「激活+规制」双轨并进", toolsUsed: ["sag_retrieve", "sag_reason", "llm_write"], outcome: "success", importance: 0.85, accessCount: 12, createdAt: new Date().toISOString() },
  { id: 502, goal: "土地流转与经营权流转的术语辨析", summary: "「土地流转」表述不规范, 应统一为「农村土地经营权流转」(与集体经济组织法第45条一致)", toolsUsed: ["concept_trace"], outcome: "success", importance: 0.72, accessCount: 7, createdAt: new Date().toISOString() },
  { id: 503, goal: "农村集体经济组织法对资本入股的限制", summary: "法律限制资本控股集体资产, 仅允许入股; 评审修正「资本控股」→「资本入股」表述", toolsUsed: ["policy_search", "review_output"], outcome: "partial", importance: 0.6, accessCount: 3, createdAt: new Date().toISOString() },
];
// G-demo: 技能蒸馏演示（任务轨迹 → EDV 评审 → approved）
const DEMO_SKILLS: any[] = [
  { id: 601, name: "影响类问题双面论证", whenToApply: "回答影响类/效应类研究问题", skillMd: "1) 检索正反两面证据 2) 先正面效应后风险审视 3) 用具体年份数据支撑 4) 结尾给出双轨结论", status: "approved", consensus: 0.88, votes: [{ validator: "C刊审稿人", verdict: "approve", reason: "结构清晰, 覆盖完整" }, { validator: "方法论专家", verdict: "approve", reason: "论证链条可验证" }], sourceTasks: ["demo"], createdAt: new Date().toISOString() },
  { id: 602, name: "术语标准化检查", whenToApply: "写作/评审涉及法律术语或政策表述", skillMd: "1) 识别易混术语(控股/入股, 流转/转让) 2) 检索法规原文确认 3) 统一替换并标注依据", status: "pending", consensus: 0.6, votes: [{ validator: "C刊审稿人", verdict: "needs_revision", reason: "术语库需扩充" }], sourceTasks: ["demo"], createdAt: new Date().toISOString() },
];
// G-demo: 回归评测集演示（gold 任务 + 门禁历史）
const DEMO_EVAL_SUITE: any[] = [
  { id: 701, category: "gold", name: "剩余价值率推理", goal: "基于资本论推导剩余价值率的决定因素", expected_tools: ["sag_reason"], min_score: 0.7, enabled: true },
  { id: 702, category: "gold", name: "资本下乡综述", goal: "综述资本下乡对农村集体经济的影响", expected_tools: ["sag_retrieve", "llm_write"], min_score: 0.65, enabled: true },
  { id: 703, category: "gold", name: "政策条文核查", goal: "核查集体经济组织法对资本入股的限制条款", expected_tools: ["policy_search"], min_score: 0.7, enabled: true },
];
const DEMO_EVAL_HISTORY: any[] = [
  { id: 801, name: "剩余价值率推理", passed: true, score: 0.86, created_at: new Date().toISOString() },
  { id: 802, name: "资本下乡综述", passed: true, score: 0.74, created_at: new Date().toISOString() },
  { id: 803, name: "政策条文核查", passed: false, score: 0.42, created_at: new Date().toISOString() },
  { id: 804, name: "剩余价值率推理", passed: true, score: 0.9, created_at: new Date().toISOString() },
];

export const AgentConsole: FC = () => {
  const [tab, setTab] = useState<"rules" | "memory" | "logs" | "eval" | "audit" | "tools" | "episodic" | "skills" | "agent">("rules");
  // V392: 演示模式 — demo 数据填充三 tab（沙箱不调 API）
  const [demoOn, setDemoOn] = useState(false);
  const [demoPlaying, setDemoPlaying] = useState(false);
  const demoStage = useRef(0);
  const demoTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // 主动研究: 手动触发 + 结果提示
  const [proactiveMsg, setProactiveMsg] = useState("");
  const runProactive = async () => {
    if (proactiveMsg) return;
    setProactiveMsg("巡检中…");
    try {
      const r = await fetch("/api/agent/proactive-research", { method: "POST" });
      const d = await r.json();
      const res = d.result || {};
      setProactiveMsg(`✅ 发起 ${res.created?.length || 0} 个研究任务（信号 ${res.signals || 0} 个）`);
      setTimeout(() => setProactiveMsg(""), 5000);
    } catch {
      setProactiveMsg("❌ 巡检失败");
      setTimeout(() => setProactiveMsg(""), 3000);
    }
  };

  const playDemo = () => {
    demoTimers.current.forEach(clearTimeout);
    demoTimers.current = [];
    demoStage.current = 0;
    setDemoPlaying(true);
    setDemoOn(true);
    setTab("rules");
    const stage = () => {
      demoStage.current++;
      // G-demo: 巡览全部 8 tab — 规则→记忆→日志→评测→审计→工具→情景→技能→完成
      if (demoStage.current === 1) { setTab("rules"); }
      else if (demoStage.current === 2) { setTab("memory"); }
      else if (demoStage.current === 3) { setTab("logs"); }
      else if (demoStage.current === 4) { setTab("eval"); }
      else if (demoStage.current === 5) { setTab("audit"); }
      else if (demoStage.current === 6) { setTab("tools"); }
      else if (demoStage.current === 7) { setTab("episodic"); }
      else if (demoStage.current === 8) { setTab("skills"); }
      else { setDemoPlaying(false); }
    };
    stage();
    demoTimers.current.push(setTimeout(() => stage(), 1200));
    demoTimers.current.push(setTimeout(() => stage(), 2400));
    demoTimers.current.push(setTimeout(() => stage(), 3600));
    demoTimers.current.push(setTimeout(() => stage(), 4800));
    demoTimers.current.push(setTimeout(() => stage(), 6000));
    demoTimers.current.push(setTimeout(() => stage(), 7200));
    demoTimers.current.push(setTimeout(() => stage(), 8400));
    demoTimers.current.push(setTimeout(() => stage(), 9600));
  };
  useEffect(() => () => demoTimers.current.forEach(clearTimeout), []);

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {/* tab 头 */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-4 py-2">
        {([["rules", "防错规则"], ["memory", "战略记忆"], ["logs", "执行日志"], ["eval", "评测报告"], ["audit", "审计报表"], ["tools", "工具策略"], ["episodic", "情景记忆"], ["skills", "技能库"], ["agent", "Agent 管理"]] as const).map(([id, label]) => (
          <button key={id} type="button" aria-label={`切换到${label}标签页`} aria-selected={tab === id} onClick={() => setTab(id)}
            className={cn("shrink-0 rounded-md px-3 py-1.5 text-xs transition-colors", tab === id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground")}>
            {label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1.5">
          {demoOn && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] text-amber-700">演示数据</span>}
          {/* 主动研究: 手动触发一次自主巡检（每日自动由后端调度） */}
          <button type="button" aria-label="主动研究" onClick={() => void runProactive()}
            className="flex items-center gap-1 rounded-md border border-dashed border-cyan-400/40 px-2.5 py-1 text-[11px] text-cyan-400 hover:bg-cyan-500/5 disabled:opacity-50"
            title="自主巡检: 失败任务/评测回退/热点 → 生成研究假设 → 发起任务">
            <Sparkles className="h-3 w-3" />
            {proactiveMsg || "主动研究"}
          </button>
          <button type="button" aria-label={demoPlaying ? "停止演示" : "播放演示"} onClick={playDemo} disabled={demoPlaying}
            className="flex items-center gap-1 rounded-md border border-dashed border-primary/40 px-2.5 py-1 text-[11px] text-primary hover:bg-primary/5 disabled:opacity-50"
            title="播放演示：规则→记忆→日志 自动巡览（沙箱 · 不消耗 API）">
            <Sparkles className="h-3 w-3" />
            {demoPlaying ? "演示中…" : "播放演示"}
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div className="w-full space-y-4">
          {tab === "rules" && <RulesTab demoOn={demoOn} />}
          {tab === "memory" && <MemoryTab demoOn={demoOn} />}
          {tab === "logs" && <LogsTab demoOn={demoOn} />}
          {tab === "eval" && <EvalTab demoOn={demoOn} />}
          {tab === "audit" && <AuditTab demoOn={demoOn} />}
          {tab === "tools" && <ToolsTab demoOn={demoOn} />}
          {tab === "episodic" && <EpisodicTab demoOn={demoOn} />}
          {tab === "skills" && <SkillsTab demoOn={demoOn} />}
          {tab === "agent" && <AgentManageTab />}
        </div>
      </div>
    </section>
  );
};

// ═══ 防错规则 tab ═══
function RulesTab({ demoOn }: { demoOn: boolean }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [msg, setMsg] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newRule, setNewRule] = useState({ query: "", note: "" });
  const load = async () => {
    try {
      const r = await fetch("/api/prevention-rules");
      const real = (await r.json()).rules || [];
      setRules(demoOn ? [...DEMO_RULES, ...real] : real);
    } catch {}
  };
  useEffect(() => { void load(); }, [demoOn]);

  const toggle = async (id: number, enabled: boolean) => {
    await fetch(`/api/prevention-rules/${id}/toggle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
    void load();
  };
  const create = async () => {
    if (!newRule.query.trim()) return;
    const r = await fetch("/api/prevention-rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: newRule.query, note: newRule.note }) });
    const d = await r.json();
    setMsg(d.rule ? `已生成规则: ${d.rule.category}` : d.error || "创建失败");
    setNewRule({ query: "", note: "" });
    setShowCreate(false);
    void load();
  };
  const del = async (id: number) => {
    if (!confirm("停用该规则？")) return;
    await fetch(`/api/prevention-rules/${id}/toggle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    void load();
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">防错规则</h2>
          <span className="text-xs text-muted-foreground">用户踩反馈/评测失败自动归因 · 推理时注入防复发</span>
        </div>
        <button type="button" onClick={() => setShowCreate((v) => !v)}
          className="flex items-center gap-1 rounded-md bg-primary/10 px-3 py-1.5 text-xs text-primary hover:bg-primary/20">
          <Plus className="h-3.5 w-3.5" /> 手动创建
        </button>
      </div>
      {/* 概览卡片 */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
          <div className="text-xs text-muted-foreground">规则总数</div>
          <div className="mt-1 text-2xl font-bold text-primary">{rules.length}</div>
        </div>
        <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
          <div className="text-xs text-muted-foreground">启用中</div>
          <div className="mt-1 text-2xl font-bold">{rules.filter((r) => r.enabled).length}</div>
        </div>
        <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
          <div className="text-xs text-muted-foreground">累计拦截/命中</div>
          <div className="mt-1 text-2xl font-bold">{rules.reduce((a, r) => a + r.hitCount, 0)}</div>
        </div>
      </div>
      {msg && <div className="rounded border border-primary/30 bg-primary/5 px-3 py-2 text-sm">{msg}</div>}
      {showCreate && (
        <div className="rounded-lg border p-4">
          <div className="mb-2 text-sm font-medium">模拟一次错误归因（输入不满意的问题）</div>
          <input value={newRule.query} onChange={(e) => setNewRule({ ...newRule, query: e.target.value })} placeholder="问题（如: 资本下乡的影响分析）"
            className="mb-2 w-full rounded-md border border-white/10 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500" />
          <input value={newRule.note} onChange={(e) => setNewRule({ ...newRule, note: e.target.value })} placeholder="失败/不满意的原因（如: 漏了政策背景）"
            className="mb-2 w-full rounded-md border border-white/10 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowCreate(false)} className="rounded-md bg-muted px-3 py-1.5 text-xs">取消</button>
            <button type="button" onClick={() => void create()} disabled={!newRule.query.trim()}
              className="rounded-md bg-primary px-3 py-1.5 text-xs text-white disabled:opacity-40">生成规则</button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {rules.length === 0 && <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">暂无防错规则 — 点击「播放演示」查看示例，或用户踩反馈后自动生成</div>}
        {rules.map((r) => (
          <div key={r.id} className={cn("rounded-lg border p-3", !r.enabled && "opacity-50")}>
            <div className="flex items-center gap-2">
              <span className={cn("rounded px-1.5 py-0.5 text-[10px]", CATEGORY_COLORS[r.category] || CATEGORY_COLORS.unknown)}>{r.category}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.pattern}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">命中 {r.hitCount} 次 · {SOURCE_LABELS[r.source] || r.source}</span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{r.rule}</div>
            <div className="mt-2 flex items-center gap-2">
              <button type="button" onClick={() => void toggle(r.id, !r.enabled)}
                className={cn("flex items-center gap-1 rounded px-2 py-0.5 text-[10px]", r.enabled ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground")}>
                <Power className="h-3 w-3" /> {r.enabled ? "启用中" : "已停用"}
              </button>
              <button type="button" onClick={() => void del(r.id)} className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-red-600 hover:bg-red-50">
                <Trash2 className="h-3 w-3" /> 停用
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ═══ 战略记忆 tab ═══
function MemoryTab({ demoOn }: { demoOn: boolean }) {
  const [memories, setMemories] = useState<StrategicMem[]>([]);
  const [context, setContext] = useState("");
  const [msg, setMsg] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newMem, setNewMem] = useState({ kind: "goal", content: "" });
  const load = async () => {
    try {
      const r = await fetch("/api/strategic-memory");
      const real = (await r.json()).memory || [];
      setMemories(demoOn ? [...DEMO_MEMORIES, ...real] : real);
      const c = await fetch("/api/strategic-memory/context");
      const realCtx = (await c.json()).context || "";
      if (demoOn) {
        setContext("【项目目标】\n- 本研究聚焦资本下乡对农村集体经济的双重效应，回答须紧扣该主题。\n- 实证部分采用双重差分法(DID)并报告稳健性检验。\n\n【项目约束】\n- 文献引用必须来自三库检索结果，不得编造来源。\n\n【近期决策】\n- (2026-08-10) 实证部分采用双重差分法(DID)并报告稳健性检验。");
      } else {
        setContext(realCtx);
      }
    } catch {}
  };
  useEffect(() => { void load(); }, [demoOn]);

  const add = async () => {
    if (!newMem.content.trim()) return;
    const r = await fetch("/api/strategic-memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: newMem.kind, content: newMem.content }) });
    const d = await r.json();
    setMsg(d.record ? "已记录" : d.error || "失败");
    setNewMem({ kind: "goal", content: "" });
    setShowAdd(false);
    void load();
  };
  const del = async (id: number) => {
    if (!confirm("删除该记忆？")) return;
    await fetch(`/api/strategic-memory/${id}`, { method: "DELETE" });
    void load();
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">战略记忆</h2>
          <span className="text-xs text-muted-foreground">项目级目标/约束/决策 · 每次推理注入</span>
        </div>
        <button type="button" onClick={() => setShowAdd((v) => !v)}
          className="flex items-center gap-1 rounded-md bg-primary/10 px-3 py-1.5 text-xs text-primary hover:bg-primary/20">
          <Plus className="h-3.5 w-3.5" /> 添加
        </button>
      </div>
      {/* 概览卡片 */}
      <div className="grid grid-cols-4 gap-3">
        {(["goal", "constraint", "decision", "milestone"] as const).map((k) => (
          <div key={k} className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
            <div className="text-xs text-muted-foreground">{KIND_LABELS[k]}</div>
            <div className="mt-1 text-2xl font-bold text-primary">{memories.filter((m) => m.kind === k).length}</div>
          </div>
        ))}
      </div>
      {msg && <div className="rounded border border-primary/30 bg-primary/5 px-3 py-2 text-sm">{msg}</div>}
      {showAdd && (
        <div className="rounded-lg border p-4">
          <div className="mb-2 flex gap-2">
            {(["goal", "constraint", "decision", "milestone"] as const).map((k) => (
              <button key={k} type="button" onClick={() => setNewMem({ ...newMem, kind: k })}
                className={cn("rounded px-2 py-1 text-[10px]", newMem.kind === k ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>
                {KIND_LABELS[k]}
              </button>
            ))}
          </div>
          <input value={newMem.content} onChange={(e) => setNewMem({ ...newMem, content: e.target.value })} placeholder="如: 本研究聚焦资本下乡的双重效应"
            className="mb-2 w-full rounded-md border border-white/10 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowAdd(false)} className="rounded-md bg-muted px-3 py-1.5 text-xs">取消</button>
            <button type="button" onClick={() => void add()} disabled={!newMem.content.trim()} className="rounded-md bg-primary px-3 py-1.5 text-xs text-white disabled:opacity-40">保存</button>
          </div>
        </div>
      )}
      {/* 注入内容预览 */}
      <div className="rounded-lg border border-dashed border-primary/30 bg-primary/5 p-3">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-primary">
          <FileSearch className="h-3.5 w-3.5" /> 当前会话注入内容（推理时追加到提示词）
        </div>
        <pre className="whitespace-pre-wrap font-sans text-[11px] leading-4 text-muted-foreground">{context || "（暂无注入内容 — 添加目标/约束后自动生效）"}</pre>
      </div>
      <div className="space-y-2">
        {memories.length === 0 && <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">暂无战略记忆 — 点击「播放演示」查看示例</div>}
        {memories.map((m) => (
          <div key={m.id} className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
            <div className="flex items-center gap-2">
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{KIND_LABELS[m.kind] || m.kind}</span>
              <span className="text-[10px] text-muted-foreground">{SOURCE_LABELS[m.source] || m.source} · {new Date(m.createdAt).toLocaleDateString("zh-CN")}</span>
              <button type="button" onClick={() => void del(m.id)} className="ml-auto text-muted-foreground hover:text-red-500">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-1 text-sm">{m.content}</div>
          </div>
        ))}
      </div>
    </>
  );
}

// ═══ 执行日志 tab ═══
function LogsTab({ demoOn }: { demoOn: boolean }) {
  const [logs, setLogs] = useState<ExecLog[]>([]);
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [messages, setMessages] = useState<AgentMsg[]>([]);
  const [taskFilter, setTaskFilter] = useState("");
  const [showMsgs, setShowMsgs] = useState(false);
  const [msg, setMsg] = useState("");
  // V396-3: 执行 DAG 视图（span 树）
  const [showDag, setShowDag] = useState(false);
  const [spans, setSpans] = useState<any[]>([]);
  const load = async (taskId = "") => {
    try {
      const q = taskId ? `?taskId=${taskId}` : "";
      const r = await fetch(`/api/agent/logs${q}`);
      const real = (await r.json()).logs || [];
      const s = await fetch(`/api/agent/logs/cost-summary${q}`);
      const realSummary = (await s.json()).summary || null;
      const m = await fetch(`/api/agent/messages${q}`);
      const realMsgs = (await m.json()).messages || [];
      setLogs(demoOn ? [...DEMO_LOGS, ...real] : real);
      setSummary(demoOn && !realSummary ? DEMO_COST : realSummary);
      setMessages(demoOn ? [...DEMO_MSGS, ...realMsgs] : realMsgs);
      // V396-3: 加载 span 树（需 taskId）
      if (taskId) {
        const st = await fetch(`/api/agent/logs/span-tree?taskId=${taskId}`);
        setSpans((await st.json()).spans || []);
      }
    } catch {}
  };
  useEffect(() => { void load(); }, [demoOn]);

  const runMaintenance = async () => {
    setMsg("记忆整理中…");
    try {
      const r = await fetch("/api/memory-maintenance/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const d = await r.json();
      setMsg(`整理完成: 合并 ${d.result?.merged || 0} 条, 遗忘 ${d.result?.forgotten || 0} 条`);
    } catch { setMsg("整理失败"); }
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">执行日志</h2>
          <span className="text-xs text-muted-foreground">工具调用/决策/成本全链路</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setShowMsgs((v) => !v)}
            className="rounded-md bg-primary/10 px-3 py-1.5 text-xs text-primary hover:bg-primary/20">
            {showMsgs ? "隐藏消息流" : "消息流"}
          </button>
          <button type="button" onClick={() => void runMaintenance()}
            className="flex items-center gap-1 rounded-md bg-muted px-3 py-1.5 text-xs hover:opacity-80">
            <RefreshCw className="h-3 w-3" /> 记忆整理
          </button>
        </div>
      </div>
      {msg && <div className="rounded border border-primary/30 bg-primary/5 px-3 py-2 text-sm">{msg}</div>}

      {/* 成本看板 */}
      {summary && summary.execCount > 0 && (
        <div className="rise-stagger grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
            <div className="text-xs text-muted-foreground">累计成本</div>
            <div className="mt-1 text-xl font-bold text-emerald-600">¥{(summary.totalCostCents / 100).toFixed(3)}</div>
          </div>
          <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
            <div className="text-xs text-muted-foreground">总 token</div>
            <div className="mt-1 text-xl font-bold">{summary.totalTokens.toLocaleString()}</div>
          </div>
          <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
            <div className="text-xs text-muted-foreground">执行次数</div>
            <div className="mt-1 text-xl font-bold">{summary.execCount}</div>
          </div>
          <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
            <div className="text-xs text-muted-foreground">按工具</div>
            <div className="mt-1 text-xs">{summary.byTool.slice(0, 3).map((t) => `${t.tool} ¥${(t.costCents / 100).toFixed(3)}`).join(" · ") || "—"}</div>
          </div>
        </div>
      )}

      {/* 消息流 */}
      {showMsgs && (
        <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Agent 消息协议流（{messages.length} 条）· V394-6: 工人产出实时共享，后续工人自动复用</div>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {messages.map((m) => (
              <div key={m.id} className="flex items-center gap-2 rounded px-2 py-1 text-[11px] odd:bg-muted/30">
                <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">{m.fromAgent}</span>
                <span className="text-muted-foreground">→</span>
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{m.toAgent}</span>
                <span className="text-muted-foreground">[{m.msgType}]</span>
                <span className="min-w-0 flex-1 truncate">{JSON.stringify(m.payload).slice(0, 60)}</span>
              </div>
            ))}
            {messages.length === 0 && <div className="text-[11px] text-muted-foreground">暂无消息</div>}
            {/* G14: 评审报告卡 — reviewer 质量门产出（多 Agent 编排后自动评审） */}
            {messages.some((m) => m.fromAgent === "reviewer" && m.payload?.reviewVerdict) && (
              <div className="mt-2 rounded-lg border border-amber-300/30 bg-amber-50/10 p-2.5">
                <div className="mb-1 flex items-center gap-2 text-[10px] font-medium text-amber-300">
                  <ShieldCheck className="h-3.5 w-3.5" /> 多 Agent 评审报告（V396-10 质量门）
                </div>
                {messages.filter((m) => m.fromAgent === "reviewer" && m.payload?.reviewVerdict).map((m) => {
                  const v = m.payload;
                  const verdict = String(v.reviewVerdict || "");
                  const score = Number(v.reviewScore ?? 0);
                  const report = String(v.reviewReport || "");
                  return (
                    <div key={"r" + m.id} className="mb-1.5 rounded border border-border/40 bg-background/40 p-2">
                      <div className="flex items-center gap-2 text-[10px]">
                        <span className={"rounded px-1.5 py-0.5 font-medium " + (verdict === "approved" ? "bg-emerald-100 text-emerald-700" : verdict === "needs_revision" ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700")}>
                          {verdict === "approved" ? "✅ 通过" : verdict === "needs_revision" ? "⚠️ 需修改" : "❌ 否决"}
                        </span>
                        <span className="text-muted-foreground">综合评分 <b className="text-amber-400">{score.toFixed(2)}</b>/1.0</span>
                      </div>
                      {report && (
                        <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap font-sans text-[10px] leading-4 text-muted-foreground">{report}</pre>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 日志列表 */}
      <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
        <div className="mb-2 flex items-center gap-2">
          <input value={taskFilter} onChange={(e) => { setTaskFilter(e.target.value); void load(e.target.value); }}
            placeholder="按任务ID筛选（可留空=全部）" className="min-w-0 flex-1 rounded-md border border-white/10 bg-slate-800 px-3 py-1.5 text-xs text-white placeholder:text-slate-500" />
          <span className="shrink-0 text-[10px] text-muted-foreground">{logs.length} 条</span>
        </div>
        <div className="max-h-96 space-y-1 overflow-y-auto">
          {logs.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-2 rounded px-2 py-1 text-[11px] odd:bg-muted/30">
              <span className={cn("rounded px-1.5 py-0.5 text-[9px]", l.status === "ok" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700")}>{l.status}</span>
              <span className="font-mono text-[10px] text-primary">{l.action}</span>
              <span className="rounded bg-muted px-1 font-mono text-[10px]">{l.tool || "-"}</span>
              <span className="min-w-0 flex-1 truncate">{l.inputSummary || ""}</span>
              <span className="shrink-0 text-muted-foreground">{l.durationMs}ms</span>
              <span className="shrink-0 font-mono text-[10px] text-emerald-600">¥{(l.costCents / 100).toFixed(3)}</span>
            </div>
          ))}
          {logs.length === 0 && <div className="text-[11px] text-muted-foreground">暂无执行日志 — 点击「播放演示」查看示例，或运行 Agent 任务后出现</div>}
        </div>
      </div>
      {/* V396-3: 执行 DAG 视图（span 树可视化） */}
      {spans.length > 0 && (
        <div className="rounded-lg border border-indigo-500/20 p-3">
          <div className="mb-2 flex items-center gap-2">
            <button type="button" onClick={() => setShowDag((v) => !v)}
              className="rounded-md bg-indigo-500/10 px-3 py-1.5 text-xs text-indigo-400 hover:bg-indigo-500/20">
              {showDag ? "隐藏执行 DAG" : "执行 DAG 视图"}（{spans.length} spans）
            </button>
            <span className="text-[10px] text-muted-foreground">span 树: CHAIN/LLM/TOOL/AGENT 执行轨迹</span>
          </div>
          {showDag && (
            <div className="space-y-0.5 font-mono text-[10px]">
              {spans.map((s: any) => (
                <div key={s.id} className="flex items-start gap-1.5 rounded px-1.5 py-0.5 hover:bg-slate-800/50" style={{ paddingLeft: 12 + (s.parentId ? 20 : 0) + "px" }}>
                  <span className={"shrink-0 rounded px-1 text-[8px] font-bold " + (s.spanType === "LLM" ? "bg-purple-500/15 text-purple-300" : s.spanType === "AGENT" ? "bg-cyan-500/15 text-cyan-300" : s.status === "failed" ? "bg-red-500/15 text-red-300" : "bg-indigo-500/15 text-indigo-300")}>
                    {s.spanType}
                  </span>
                  <span className="shrink-0 text-slate-400">#{s.id}</span>
                  <span className="min-w-0 flex-1 truncate">{s.action}{s.tool ? ` · ${s.tool}` : ""}</span>
                  <span className={"shrink-0 " + (s.status === "failed" ? "text-red-400" : s.status === "ok" ? "text-emerald-400" : "text-slate-400")}>{s.status}</span>
                  <span className="shrink-0 text-slate-500">{s.durationMs}ms · ¥{(s.costCents / 100).toFixed(3)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}


// V393-7: 评测报告 tab
interface EvalReport {
  days: number; totalTasks: number; completedTasks: number; failedTasks: number; cancelledTasks: number;
  completionRate: number; totalSteps: number; succeededSteps: number; failedSteps: number; stepSuccessRate: number;
  multiLoopTasks: number; multiLoopRate: number; reflectCount: number; approvalCount: number;
  avgCostCents: number; totalCostCents: number;
  // V396-1: 轨迹级指标
  planAdherence: number; toolAccuracy: number; toolRetryRate: number; reasoningQuality: number; judgedTasks: number;
  regression?: { metric: string; delta: number; threshold: number; alarm: boolean };
}
function EvalTab({ demoOn }: { demoOn: boolean }) {
  const [report, setReport] = useState<EvalReport | null>(null);
  const [curve, setCurve] = useState<Array<{ day: string; completionRate: number; stepSuccessRate: number; taskCount: number }>>([]);
  const [days, setDays] = useState(7);
  const load = async (d = days) => {
    try {
      const r = await fetch("/api/agent/eval-report?days=" + d);
      setReport((await r.json()).report);
      const c = await fetch("/api/agent/learning-curve?days=14");
      setCurve((await c.json()).curve || []);
    } catch {}
  };
  useEffect(() => { if (!demoOn) void load(); }, [demoOn]);
  const pct = (v: number) => Math.round(v * 100) + "%";
  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Agent 评测报告</h2>
          <span className="text-xs text-muted-foreground">任务完成率 / 步骤成功率 / 多轮收敛率</span>
        </div>
        <select value={days} onChange={(e) => { setDays(Number(e.target.value)); void load(Number(e.target.value)); }}
          className="rounded border border-white/10 bg-slate-800 px-2 py-1 text-xs text-white">
          <option value={7}>近7天</option><option value={30}>近30天</option><option value={90}>近90天</option>
        </select>
      </div>
      {!report ? (
        demoOn ? (
          <EvalDemo />
        ) : (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">暂无评测数据 — 运行 Agent 任务后自动生成</div>
        )
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
              <div className="text-xs text-muted-foreground">任务完成率</div>
              <div className="mt-1 text-2xl font-bold text-primary">{pct(report.completionRate)}</div>
              <div className="text-[10px] text-muted-foreground">{report.completedTasks}/{report.totalTasks} 完成</div>
            </div>
            <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
              <div className="text-xs text-muted-foreground">步骤成功率</div>
              <div className="mt-1 text-2xl font-bold text-emerald-600">{pct(report.stepSuccessRate)}</div>
              <div className="text-[10px] text-muted-foreground">{report.succeededSteps}/{report.totalSteps} 步</div>
            </div>
            <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
              <div className="text-xs text-muted-foreground">平均步骤成本</div>
              <div className="mt-1 text-2xl font-bold text-emerald-600">¥{(report.avgCostCents / 100).toFixed(3)}</div>
              <div className="text-[10px] text-muted-foreground">总成本 ¥{(report.totalCostCents / 100).toFixed(3)}</div>
            </div>
          </div>
          {/* V396-1: 轨迹级指标（工具准确率/计划遵循/推理质量/回归告警） */}
          <div className="rounded-lg border border-indigo-500/20 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs font-medium text-indigo-400">轨迹级评测（工具调用准确率 / 计划遵循 / 推理质量）</span>
              {report.regression?.alarm && (
                <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[9px] font-medium text-red-400">⚠ 回归告警：{report.regression.metric} 回退 {Math.round(Math.abs(report.regression.delta) * 100)}%</span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-lg border border-indigo-500/20 p-3">
                <div className="text-xs text-muted-foreground">工具调用准确率</div>
                <div className="mt-1 text-2xl font-bold text-indigo-600">{pct(report.toolAccuracy)}</div>
                <div className="text-[10px] text-muted-foreground">重试率 {pct(report.toolRetryRate)}</div>
              </div>
              <div className="rounded-lg border border-indigo-500/20 p-3">
                <div className="text-xs text-muted-foreground">计划遵循度</div>
                <div className="mt-1 text-2xl font-bold text-indigo-600">{report.planAdherence.toFixed(2)}</div>
                <div className="text-[10px] text-muted-foreground">实际步骤/计划步骤</div>
              </div>
              <div className="rounded-lg border border-indigo-500/20 p-3">
                <div className="text-xs text-muted-foreground">推理质量 (LLM judge)</div>
                <div className="mt-1 text-2xl font-bold text-purple-600">{pct(report.reasoningQuality)}</div>
                <div className="text-[10px] text-muted-foreground">抽样 {report.judgedTasks} 任务 rubric 评分</div>
              </div>
              <div className="rounded-lg border border-indigo-500/20 p-3">
                <div className="text-xs text-muted-foreground">多轮收敛率</div>
                <div className="mt-1 text-2xl font-bold text-purple-600">{pct(report.multiLoopRate)}</div>
                <div className="text-[10px] text-muted-foreground">{report.multiLoopTasks} 个任务 ≥2轮</div>
              </div>
            </div>
          </div>
          {/* V394-9: 学习曲线（近14天完成率趋势） */}
          {curve.length > 0 && (
            <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
              <div className="mb-2 text-xs font-medium text-muted-foreground">学习曲线（近14天 · 任务完成率趋势）</div>
              <div className="flex h-24 items-end gap-1">
                {curve.map((pt, i) => (
                  <div key={i} className="flex flex-1 flex-col items-center gap-0.5" title={pt.day + " 完成率 " + Math.round(pt.completionRate * 100) + "% · " + pt.taskCount + " 任务"}>
                    <div className="w-full rounded-t bg-primary/60" style={{ height: Math.max(3, pt.completionRate * 80) + "px" }} />
                    <span className="text-[9px] text-muted-foreground">{pt.day.slice(3)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                完成率均值 {Math.round(curve.reduce((a, p) => a + p.completionRate, 0) / Math.max(curve.length, 1) * 100)}% · 共 {curve.reduce((a, p) => a + p.taskCount, 0)} 任务
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
              <div className="text-xs text-muted-foreground">失败任务</div>
              <div className="mt-1 text-xl font-bold text-red-600">{report.failedTasks}</div>
            </div>
            <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
              <div className="text-xs text-muted-foreground">失败步骤</div>
              <div className="mt-1 text-xl font-bold text-red-600">{report.failedSteps}</div>
            </div>
            <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
              <div className="text-xs text-muted-foreground">reflect 评估</div>
              <div className="mt-1 text-xl font-bold">{report.reflectCount}</div>
            </div>
            <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
              <div className="text-xs text-muted-foreground">审批次数</div>
              <div className="mt-1 text-xl font-bold">{report.approvalCount}</div>
            </div>
          </div>
          {/* V396-2: 回归评测集（gold 任务 + 故障注入 + 门禁历史）— G-demo: demoOn 透传 */}
          <EvalSuitePanel demoOn={demoOn} />
        </>
      )}
    </>
  );
}

// V396-2: 回归评测集面板（gold 任务列表 + 运行 + 历史门禁）— G-demo: 支持演示模式
function EvalSuitePanel({ demoOn = false }: { demoOn?: boolean }) {
  const [suite, setSuite] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [running, setRunning] = useState(false);
  const [fault, setFault] = useState("none");
  const [runResult, setRunResult] = useState<any>(null);
  const load = async () => {
    try {
      // G-demo: 演示模式用 DEMO_EVAL_SUITE 填充（沙箱不调 API）
      if (demoOn) { setSuite(DEMO_EVAL_SUITE); setHistory(DEMO_EVAL_HISTORY); return; }
      const [s, h] = await Promise.all([
        fetch("/api/agent/eval-suite").then((r) => r.json()),
        fetch("/api/agent/eval-suite/history?limit=10").then((r) => r.json()),
      ]);
      setSuite(s.suite || []);
      setHistory(h.history || []);
    } catch {}
  };
  useEffect(() => { void load(); }, [demoOn]);
  // 审计修复: 评测集创建/删除
  const [showEvalForm, setShowEvalForm] = useState(false);
  const [evalForm, setEvalForm] = useState({ name: "", goal: "", expectedTools: "", minScore: "0.7" });
  const addEvalItem = async () => {
    setShowEvalForm((v) => !v);
  };
  const saveEvalItem = async () => {
    try {
      await fetch("/api/agent/eval-suite", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: evalForm.name, category: "gold", goal: evalForm.goal,
          expectedTools: evalForm.expectedTools.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          minScore: Number(evalForm.minScore) || 0.7,
        }),
      });
      setEvalForm({ name: "", goal: "", expectedTools: "", minScore: "0.7" });
      setShowEvalForm(false);
      void load();
    } catch { /* 创建失败忽略 */ }
  };
  const deleteEvalItem = async (id: number) => {
    if (!confirm("删除该评测条目？")) return;
    try { await fetch(`/api/agent/eval-suite/${id}`, { method: "DELETE" }); void load(); } catch { /* ignore */ }
  };
  const run = async () => {
    setRunning(true); setRunResult(null);
    // G-demo: 演示模式模拟运行结果（不调后端）
    if (demoOn) {
      await new Promise((r) => setTimeout(r, 800));
      setRunResult({ total: 3, passed: 2, failed: 1, results: [
        { name: "剩余价值率推理", passed: true, score: 0.86, fault: fault !== "none" ? fault : "none" },
        { name: "资本下乡综述", passed: true, score: 0.74, fault: "none" },
        { name: "政策条文核查", passed: false, score: 0.42, error: "期望工具 policy_search 未命中（检索超时）", fault: fault === "timeout" ? "timeout" : "none" },
      ] });
      return;
    }
    try {
      const r = await fetch("/api/agent/eval-suite/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fault, limit: 4 }),
      });
      const d = await r.json();
      setRunResult(d.result);
      await load();
    } catch {}
    finally { setRunning(false); }
  };
  return (
    <div className="rounded-lg border border-cyan-500/20 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium text-cyan-400">回归评测集（gold 任务 · CI 门禁）</span>
        <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[9px] text-cyan-300/80" title="V6: 每24小时自动运行, 通过率<50%触发告警">🔄 自动回归 24h</span>
        <select value={fault} onChange={(e) => setFault(e.target.value)}
          className="rounded border border-white/10 bg-slate-800 px-1.5 py-0.5 text-[10px] text-white">
          <option value="none">无故障</option>
          <option value="rate_limit">429 风暴</option>
          <option value="timeout">超时</option>
        </select>
        <button type="button" aria-label="运行评测集" onClick={() => void run()} disabled={running}
          className="ml-auto rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 px-3 py-1 text-[10px] font-medium text-white hover:brightness-110 disabled:opacity-40">
          {running ? "运行中…" : "运行评测集"}
        </button>
        {/* 审计修复: 评测集创建 */}
        <button type="button" aria-label="新增评测条目" onClick={() => void addEvalItem()}
          className="shrink-0 rounded-lg bg-cyan-500/10 px-3 py-1 text-[10px] text-cyan-300 hover:bg-cyan-500/20">+ 新增</button>
      </div>
      {/* 新增评测条目表单 */}
      {showEvalForm && (
        <div className="mb-2 grid grid-cols-2 gap-2 rounded border border-cyan-500/20 p-2">
          <input value={evalForm.name} onChange={(e) => setEvalForm({ ...evalForm, name: e.target.value })} placeholder="名称（如: 剩余价值率推理）"
            className="rounded border border-white/10 bg-slate-800 px-2 py-1 text-[10px] text-white" />
          <input value={evalForm.goal} onChange={(e) => setEvalForm({ ...evalForm, goal: e.target.value })} placeholder="目标（Agent 将执行）"
            className="rounded border border-white/10 bg-slate-800 px-2 py-1 text-[10px] text-white" />
          <input value={evalForm.expectedTools} onChange={(e) => setEvalForm({ ...evalForm, expectedTools: e.target.value })} placeholder="期望工具（逗号分隔, 如 sag_reason）"
            className="rounded border border-white/10 bg-slate-800 px-2 py-1 text-[10px] text-white" />
          <div className="flex gap-2">
            <input type="number" value={evalForm.minScore} onChange={(e) => setEvalForm({ ...evalForm, minScore: e.target.value })} placeholder="阈值(0-1, 默认0.7)"
              className="w-24 rounded border border-white/10 bg-slate-800 px-2 py-1 text-[10px] text-white" />
            <button type="button" onClick={() => void saveEvalItem()}
              className="rounded bg-cyan-500/15 px-3 py-1 text-[10px] text-cyan-300 hover:bg-cyan-500/25">保存</button>
            <button type="button" onClick={() => setShowEvalForm(false)} className="rounded bg-muted px-2 py-1 text-[10px]">取消</button>
          </div>
        </div>
      )}
      {/* 评测集条目 */}
      <div className="space-y-1">
        {suite.map((s: any) => (
          <div key={s.id} className="flex items-center gap-2 rounded border border-white/5 bg-slate-900/50 px-2 py-1 text-[10px]">
            <span className="rounded bg-cyan-500/15 px-1 py-0.5 text-cyan-300">{s.category}</span>
            <span className="font-medium">{s.name}</span>
            <span className="truncate text-slate-400">{s.goal}</span>
            <span className="ml-auto shrink-0 text-slate-500">期望工具 {s.expected_tools?.join("/")} · 阈值 {s.min_score}</span>
            <button type="button" aria-label={`删除评测${s.name}`} onClick={() => void deleteEvalItem(s.id)}
              className="shrink-0 rounded px-1 text-red-400 hover:bg-red-500/10">✕</button>
          </div>
        ))}
      </div>
      {/* 运行结果 */}
      {runResult && (
        <div className="mt-2 rounded border border-cyan-500/20 bg-cyan-500/5 p-2">
          <div className="text-[10px] font-medium text-cyan-300">
            评测 {runResult.total} 条 · 通过 {runResult.passed} · 失败 {runResult.failed}
          </div>
          <div className="mt-1 space-y-0.5">
            {runResult.results?.map((r: any, i: number) => (
              <div key={i} className="flex items-center gap-2 text-[9px]">
                <span className={r.passed ? "text-emerald-400" : "text-red-400"}>{r.passed ? "✓" : "✗"}</span>
                <span>{r.name}</span>
                <span className="text-slate-400">score {r.score}</span>
                {r.fault !== "none" && <span className="rounded bg-amber-500/15 px-1 text-amber-300">注入:{r.fault}</span>}
                {r.error && <span className="truncate text-red-400/70">{r.error.slice(0, 50)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {/* 门禁历史 */}
      {history.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[9px] text-slate-500">最近评测历史（门禁趋势）</div>
          <div className="flex flex-wrap gap-1">
            {history.slice(0, 10).map((h: any, i: number) => {
              // V399-2 P2 补齐: 参数/环境快照溯源提示（fault 注入方式 + 记录时间 + node 版本）
              const params = h.parameters_json || null;
              const env = h.environment_json || null;
              const detail = [
                h.name + " · " + h.created_at,
                params?.fault ? "fault=" + params.fault : "",
                params?.suite ? "suite=" + params.suite : "",
                env?.node ? "node=" + env.node : "",
                env?.recordedAt ? "记录于 " + env.recordedAt : "",
              ].filter(Boolean).join(" | ");
              return (
                <span key={i} title={detail}
                  className={"rounded px-1.5 py-0.5 text-[9px] " + (h.passed ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300")}>
                  {h.name.split("-")[0]} {h.passed ? "✓" : "✗"} {h.score}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// V393-6: 审计报表 tab
interface AuditReport {
  totalTasks: number; totalCostCents: number; totalTokens: number;
  byTool: Array<{ tool: string; costCents: number; count: number }>;
  recentTasks: Array<{ taskId: string; stepId: string; action: string; tool: string; costCents: number; createdAt: string }>;
}
function AuditTab({ demoOn }: { demoOn: boolean }) {
  const [report, setReport] = useState<AuditReport | null>(null);
  const [days, setDays] = useState(7);
  const load = async (d = days) => {
    try {
      const r = await fetch("/api/agent/logs/audit-report?days=" + d);
      setReport((await r.json()).report);
    } catch {}
  };
  useEffect(() => { if (!demoOn) void load(); }, [demoOn]);
  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">审计报表</h2>
          <span className="text-xs text-muted-foreground">用户×任务×成本×工具溯源</span>
        </div>
        <select value={days} onChange={(e) => { setDays(Number(e.target.value)); void load(Number(e.target.value)); }}
          className="rounded border border-white/10 bg-slate-800 px-2 py-1 text-xs text-white">
          <option value={7}>近7天</option><option value={30}>近30天</option>
        </select>
      </div>
      {!report ? (
        demoOn ? (
          <AuditDemo />
        ) : (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">暂无审计数据 — 运行 Agent 任务后自动生成</div>
        )
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
              <div className="text-xs text-muted-foreground">执行次数</div>
              <div className="mt-1 text-2xl font-bold text-primary">{report.totalTasks}</div>
            </div>
            <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
              <div className="text-xs text-muted-foreground">累计成本</div>
              <div className="mt-1 text-2xl font-bold text-emerald-600">¥{(report.totalCostCents / 100).toFixed(3)}</div>
            </div>
            <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
              <div className="text-xs text-muted-foreground">总 token</div>
              <div className="mt-1 text-2xl font-bold">{report.totalTokens.toLocaleString()}</div>
            </div>
          </div>
          <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
            <div className="mb-2 text-xs font-medium text-muted-foreground">按工具成本分布</div>
            {report.byTool.length === 0 ? <div className="text-xs text-muted-foreground">暂无工具记录</div> : (
              <div className="space-y-1.5">
                {report.byTool.map((t) => {
                  const max = Math.max(...report.byTool.map((x) => x.costCents), 1);
                  return (
                    <div key={t.tool} className="flex items-center gap-2">
                      <span className="w-24 shrink-0 truncate font-mono text-[10px]">{t.tool}</span>
                      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded bg-muted">
                        <div className="h-full rounded bg-primary" style={{ width: ((t.costCents / max) * 100) + "%" }} />
                      </div>
                      <span className="shrink-0 text-[10px] text-muted-foreground">¥{(t.costCents / 100).toFixed(3)} · {t.count}次</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
            <div className="mb-2 text-xs font-medium text-muted-foreground">最近执行（{report.recentTasks.length} 条）</div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {report.recentTasks.map((t, i) => (
                <div key={i} className="flex items-center gap-2 rounded px-2 py-1 text-[11px] odd:bg-muted/30">
                  <span className="rounded bg-muted px-1 font-mono text-[10px]">{t.tool || "-"}</span>
                  <span className="font-mono text-[10px] text-primary">{t.action}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-muted-foreground">{String(t.taskId || "").slice(0, 8)}</span>
                  <span className="shrink-0 font-mono text-[10px] text-emerald-600">¥{(t.costCents / 100).toFixed(3)}</span>
                  <span className="shrink-0 text-[9px] text-muted-foreground">{new Date(t.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

// V393-4/5: 工具策略 tab
const TOOL_INFO: Array<{ name: string; label: string; desc: string; minRole: string; risk: string }> = [
  { name: "sag_reason", label: "SAG推理", desc: "多路混合检索+52步推理链", minRole: "reader", risk: "safe" },
  { name: "sag_retrieve", label: "文献检索", desc: "知识库检索返回片段", minRole: "reader", risk: "safe" },
  { name: "llm_write", label: "LLM写作", desc: "撰写研究段落/综述", minRole: "analyst", risk: "safe" },
  { name: "concept_trace", label: "概念溯源", desc: "经典文本概念演变", minRole: "reader", risk: "safe" },
  { name: "policy_search", label: "政策检索", desc: "政策法规原文检索", minRole: "reader", risk: "safe" },
  { name: "empirical_analysis", label: "实证分析", desc: "回归/问卷/统计分析", minRole: "analyst", risk: "safe" },
  { name: "review_output", label: "质量评审", desc: "产出质量评审打分", minRole: "analyst", risk: "safe" },
  { name: "summarize", label: "内容摘要", desc: "长文本压缩摘要", minRole: "reader", risk: "safe" },
  { name: "file_delete", label: "文件删除", desc: "删除文件（默认禁止）", minRole: "manager", risk: "deny" },
  { name: "data_purge", label: "数据清理", desc: "批量清理数据（默认禁止）", minRole: "manager", risk: "deny" },
  { name: "external_publish", label: "外部发布", desc: "发布到外部（默认禁止）", minRole: "manager", risk: "deny" },
  { name: "payment", label: "支付操作", desc: "扣款/转账（默认禁止）", minRole: "manager", risk: "deny" },
  // 补齐: 行动/协作/多模态工具（26 个全量）
  { name: "sag_search", label: "知识库检索", desc: "混合检索(BM25+向量+图谱)", minRole: "reader", risk: "safe" },
  { name: "sag_get_event", label: "事件详情", desc: "知识库事件详情", minRole: "reader", risk: "safe" },
  { name: "sag_ingest", label: "文档入库", desc: "文档入库知识库(需审批)", minRole: "manager", risk: "review" },
  { name: "run_code", label: "代码执行", desc: "沙箱执行Python/JS(3级+远程WSL/SSH/GPU)", minRole: "manager", risk: "safe" },
  { name: "runtime_exec", label: "持久Python", desc: "常驻会话, 变量跨调用保持", minRole: "manager", risk: "safe" },
  { name: "run_command", label: "终端命令", desc: "沙箱shell执行(需审批)", minRole: "manager", risk: "review" },
  { name: "web_fetch", label: "网页抓取", desc: "白名单网页抓取", minRole: "reader", risk: "safe" },
  { name: "web_search", label: "网页搜索", desc: "学术/政策源搜索", minRole: "reader", risk: "safe" },
  { name: "file_read", label: "文件读取", desc: "agent_workspace只读", minRole: "reader", risk: "safe" },
  { name: "file_write", label: "文件写入", desc: "agent_workspace写(需审批)", minRole: "manager", risk: "review" },
  { name: "apply_patch", label: "精确补丁", desc: "Codex格式补丁修改(需审批)", minRole: "manager", risk: "review" },
  { name: "agent_subagent", label: "外部Agent", desc: "委托Claude Code(需审批)", minRole: "manager", risk: "review" },
  { name: "attachment_read", label: "附件读取", desc: "图片视觉/文本读取", minRole: "reader", risk: "safe" },
  { name: "image_analyze", label: "图片理解", desc: "OCR/图表JSON/描述", minRole: "reader", risk: "safe" },
  { name: "audio_transcribe", label: "音频转写", desc: "whisper转写/降级", minRole: "reader", risk: "safe" },
  { name: "code_search", label: "代码搜索", desc: "项目源码搜索", minRole: "reader", risk: "safe" },
  { name: "todo_update", label: "待办管理", desc: "任务待办清单维护", minRole: "analyst", risk: "safe" },
  { name: "github_repo", label: "GitHub仓库", desc: "仓库信息/README/issue", minRole: "reader", risk: "safe" },
];
function ToolsTab({ demoOn }: { demoOn: boolean }) {
  const [msg] = useState("工具策略由后端环境变量控制: AGENT_TOOL_WHITELIST 逗号分隔; 未配置=全部按角色放行");
  const roleLabels: Record<string, string> = { reader: "只读", analyst: "分析", manager: "管理" };
  // Guardian 安全策略: 策略查看 + 判定预览
  const [guardianPolicy, setGuardianPolicy] = useState("");
  const [guardianTool, setGuardianTool] = useState("sag_retrieve");
  const [guardianAuth, setGuardianAuth] = useState("high");
  const [guardianVerdict, setGuardianVerdict] = useState("");
  const [guardianReason, setGuardianReason] = useState("");
  const loadPolicy = async () => {
    try {
      const r = await fetch("/api/agent/guardian/policy");
      const d = await r.json();
      setGuardianPolicy(d.policy || "（策略不可用）");
    } catch { setGuardianPolicy("（策略加载失败）"); }
  };
  // 审计修复: 策略热重载（编辑 guardian-policy.md 后生效）
  const reloadPolicy = async () => {
    try {
      const r = await fetch("/api/agent/guardian/reload", { method: "POST" });
      const d = await r.json();
      setPluginMsg(d.result?.ok ? "✅ 策略已重载" : "❌ 重载失败");
      void loadPolicy();
    } catch { setPluginMsg("❌ 重载失败"); }
  };
  const previewGuardian = async () => {
    try {
      const r = await fetch("/api/agent/guardian/review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: guardianTool, authorization: guardianAuth }),
      });
      const d = await r.json();
      setGuardianVerdict(d.decision?.verdict || "");
      setGuardianReason(d.decision?.reason || "");
    } catch { setGuardianVerdict(""); setGuardianReason("（判定失败）"); }
  };
  // 收尾①: Hooks 管理 + 运行时设置
  const [hooksList, setHooksList] = useState<Array<{ id: string; event: string; name: string; enabled: boolean }>>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const loadHooks = async () => {
    try {
      const r = await fetch("/api/agent/hooks");
      setHooksList((await r.json()).hooks || []);
    } catch { setHooksList([]); }
  };
  const deleteHook = async (id: string) => {
    try { await fetch(`/api/agent/hooks/${id}`, { method: "DELETE" }); } catch { /* ignore */ }
    void loadHooks();
  };
  // 审计修复: hooks 创建
  const [hookEvent, setHookEvent] = useState("task_end");
  const [hookName, setHookName] = useState("");
  const addHook = async () => {
    try {
      const r = await fetch("/api/agent/hooks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: hookEvent, name: hookName || "自定义钩子" }),
      });
      const d = await r.json();
      setPluginMsg(d.ok ? "✅ 钩子已注册" : `❌ ${d.error || "注册失败"}`);
      setHookName("");
      void loadHooks();
    } catch { setPluginMsg("❌ 注册失败"); }
  };
  const loadSettings = async () => {
    try {
      const r = await fetch("/api/agent/settings");
      const d = await r.json();
      const s = d.settings || {};
      setSettings({ preset: s.preset || "academic", autonomy: s.autonomy || "auto-edit", sandbox_profile: s.sandbox_profile || "read-only" });
    } catch { setSettings({}); }
  };
  // 批次4: OAuth 账号管理 + 插件模板
  const [oauthAccounts, setOauthAccounts] = useState<Array<{ provider: string; account: string; scope?: string }>>([]);
  const [pluginTemplates, setPluginTemplates] = useState<Array<{ id: string; name: string; desc: string }>>([]);
  const [pluginMsg, setPluginMsg] = useState("");
  // 前端缺口④: 已安装插件文件列表
  const [pluginFiles, setPluginFiles] = useState<string[]>([]);
  const loadPluginFiles = async () => {
    try {
      const r = await fetch("/api/agent/plugins/files");
      const d = await r.json();
      setPluginFiles((d.files || []).map((f: any) => typeof f === "string" ? f : f.name));
    } catch { setPluginFiles([]); }
  };
  const oauthProviders = ["github", "feishu", "notion"];
  const loadOAuthAccounts = async () => {
    try {
      const r = await fetch("/api/agent/oauth/accounts");
      setOauthAccounts((await r.json()).accounts || []);
    } catch { setOauthAccounts([]); }
  };
  const startOAuth = async (provider: string) => {
    try {
      const r = await fetch(`/api/agent/oauth/${provider}/start`);
      const d = await r.json();
      if (d.url) { window.open(d.url, "_blank", "noopener"); return; }
      setPluginMsg(`❌ ${d.error || "授权发起失败"}`);
      setTimeout(() => setPluginMsg(""), 4000);
    } catch { setPluginMsg("❌ 授权发起失败"); setTimeout(() => setPluginMsg(""), 4000); }
  };
  const revokeOAuth = async (provider: string, account: string) => {
    try { await fetch(`/api/agent/oauth/${provider}/${encodeURIComponent(account)}`, { method: "DELETE" }); } catch { /* ignore */ }
    void loadOAuthAccounts();
  };
  const loadPluginTemplates = async () => {
    try {
      const r = await fetch("/api/agent/plugins/templates");
      setPluginTemplates((await r.json()).templates || []);
    } catch { setPluginTemplates([]); }
  };
  const installPlugin = async (id: string) => {
    try {
      const r = await fetch(`/api/agent/plugins/templates/${id}/install`, { method: "POST" });
      const d = await r.json();
      setPluginMsg(d.ok ? `✅ 已安装 ${d.tools} 个工具（热加载生效）` : `❌ ${d.error || "安装失败"}`);
      setTimeout(() => setPluginMsg(""), 4000);
    } catch { setPluginMsg("❌ 安装失败"); }
  };
  // 前端缺口⑥⑦: 运行时诊断（Provider/并发/队列/内存/子进程）
  const [diag, setDiag] = useState<Record<string, any>>({});
  const loadDiagnostics = async () => {
    // 审计修复: 各接口独立容错（任一失败不影响其他, 不再一败全零）
    const [d, p, m, s, c] = await Promise.all([
      fetch("/api/agent/diagnostics").then((r) => r.json()).catch(() => ({})),
      fetch("/api/agent/providers").then((r) => r.json()).catch(() => ({})),
      fetch("/api/agent/memory-usage").then((r) => r.json()).catch(() => ({})),
      fetch("/api/agent/subprocesses").then((r) => r.json()).catch(() => ({})),
      fetch("/api/agent/compute-status").then((r) => r.json()).catch(() => ({})),
    ]);
    // 审计修复: 消费诊断全部字段（sse/chatSessions/toolRegistry/db）
    setDiag({
      llm: d.llm, queue: d.queue, providers: p.providers, memory: m, procs: s.processes, compute: c,
      sse: d.sseSubscribers, chatSessions: d.chatSessions, toolRegistry: d.toolRegistry, db: d.db,
    });
  };
  // wisp借鉴: 重置持久运行时（关闭全部会话）
  const resetRuntimes = async () => {
    try {
      const r = await fetch("/api/agent/compute-status");
      const d = await r.json();
      for (const s of d.runtimes || []) {
        await fetch("/api/agent/persistent-runtime/" + s.sessionId + "/close", { method: "POST" }).catch(() => {});
      }
      await loadDiagnostics();
    } catch { /* 重置失败忽略 */ }
  };
  // 批次4: 挂载时加载 OAuth/插件模板/插件文件（ToolsTab 内, 与函数同作用域）
  useEffect(() => { void loadOAuthAccounts(); void loadPluginTemplates(); void loadPluginFiles(); void loadDiagnostics(); void loadWorkflows(); void loadCreds(); void loadLiveTools(); }, []);
  // 审计修复: 实时工具清单（含 pdf_parse/插件工具, 与后端实际工具集对齐）
  const [liveTools, setLiveTools] = useState<Array<{ name: string; label: string; risk: string; description: string }>>([]);
  const loadLiveTools = async () => {
    try {
      const r = await fetch("/api/agent/tools");
      setLiveTools((await r.json()).tools || []);
    } catch { setLiveTools([]); }
  };
  // 审计修复: 工作流 / 会话检索 / 凭据 / 自主级别
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string; desc: string }>>([]);
  const [workflowMsg, setWorkflowMsg] = useState("");
  const [sessionSearchQ, setSessionSearchQ] = useState("");
  const [sessionResults, setSessionResults] = useState<Array<{ snippet: string }>>([]);
  const [credNames, setCredNames] = useState<string[]>([]);
  const [autonomyLevel, setAutonomyLevel] = useState("auto-edit");
  const loadWorkflows = async () => {
    try {
      const r = await fetch("/api/agent/workflows");
      setWorkflows((await r.json()).workflows || []);
    } catch { setWorkflows([]); }
  };
  const runWorkflow = async (id: string) => {
    const goal = prompt("工作流目标（将按流水线执行）:", "");
    if (goal === null) return;
    try {
      const r = await fetch(`/api/agent/workflows/${id}/run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: goal || "" }),
      });
      const d = await r.json();
      setWorkflowMsg(d.ok ? `✅ 已启动（任务 ${d.result?.taskId?.slice(0, 8)}）` : `❌ ${d.error || "启动失败"}`);
      setTimeout(() => setWorkflowMsg(""), 4000);
    } catch { setWorkflowMsg("❌ 启动失败"); }
  };
  const searchSessions = async () => {
    try {
      const r = await fetch("/api/agent/sessions/search?q=" + encodeURIComponent(sessionSearchQ));
      setSessionResults((await r.json()).sessions || []);
    } catch { setSessionResults([]); }
  };
  const loadCreds = async () => {
    try {
      const r = await fetch("/api/agent/credentials");
      setCredNames(((await r.json()).credentials || []).map((c: any) => c.name));
    } catch { setCredNames([]); }
  };
  const deleteCred = async (name: string) => {
    try { await fetch(`/api/agent/credentials/${encodeURIComponent(name)}`, { method: "DELETE" }); } catch { /* ignore */ }
    void loadCreds();
  };
  const setAutonomy = async (level: string) => {
    setAutonomyLevel(level);
    try {
      await fetch("/api/agent/autonomy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level }),
      });
    } catch { /* 切换失败忽略 */ }
  };
  // 审计修复: 运维操作 — 反馈统计/审批超时/工人列表
  const [feedbackStats, setFeedbackStats] = useState<{ positive?: number; negative?: number }>({});
  const [workers, setWorkers] = useState<any[]>([]);
  const loadFeedbackStats = async () => {
    try {
      const r = await fetch("/api/agent/feedback/stats");
      setFeedbackStats((await r.json()).stats || {});
    } catch { setFeedbackStats({}); }
  };
  const runApprovalTimeout = async () => {
    try {
      const r = await fetch("/api/agent/tasks/timeout-approvals", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxWaitMinutes: 60 }),
      });
      const d = await r.json();
      setPluginMsg(d.result ? `✅ 处理 ${d.result.timedOut} 个超时审批` : "❌ 处理失败");
      setTimeout(() => setPluginMsg(""), 4000);
    } catch { setPluginMsg("❌ 处理失败"); }
  };
  const loadWorkers = async () => {
    try {
      const r = await fetch("/api/agent/workers");
      setWorkers((await r.json()).workers || []);
    } catch { setWorkers([]); }
  };
  // 审计修复: 质量评审（手动评审文本）
  const [reviewText, setReviewText] = useState("");
  const [reviewResult, setReviewResult] = useState("");
  const runReview = async () => {
    try {
      const r = await fetch("/api/agent/review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: reviewText.slice(0, 40), workers: [{ workerName: "manual", goal: "待评审产出", result: reviewText.slice(0, 1500) }], summary: reviewText.slice(0, 800) }),
      });
      const d = await r.json();
      const res = d.result || {};
      setReviewResult(`评审分 ${(res.finalScore ?? 0).toFixed(2)} · ${res.verdict || "?"}\n${(res.report || "").slice(0, 600)}`);
    } catch { setReviewResult("评审失败"); }
  };
  // 审计修复: 图片预处理检查
  const [imageCheckPath, setImageCheckPath] = useState("");
  const [imageCheckMsg, setImageCheckMsg] = useState("");
  const checkImage = async () => {
    if (!imageCheckPath.trim()) return;
    try {
      const r = await fetch("/api/agent/image/prepare", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: imageCheckPath.trim() }),
      });
      const d = await r.json();
      setImageCheckMsg(d.suggestion || d.error || "OK");
    } catch { setImageCheckMsg("检查失败"); }
  };
  return (
    <>
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">工具策略</h2>
        <span className="text-xs text-muted-foreground">权限分级 + 白名单 + 风险控制</span>
        {demoOn && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] text-amber-700">演示数据</span>}
      </div>
      {msg && <div className="rounded border border-primary/30 bg-primary/5 px-3 py-2 text-xs">{msg}</div>}
      <div className="grid grid-cols-3 gap-3">
        {([["reader", "只读", "可调检索/推理/政策工具"], ["analyst", "分析", "可调写作/实证/评审工具"], ["manager", "管理", "可调全部工具（含危险需审批）"]] as const).map(([id, label, desc]) => (
          <div key={id} className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
            <div className="text-xs font-medium">{label} <span className="font-mono text-[9px] text-muted-foreground">({id})</span></div>
            <div className="mt-1 text-[10px] text-muted-foreground">{desc}</div>
          </div>
        ))}
      </div>
      <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
        <div className="mb-2 text-xs font-medium text-muted-foreground">工具清单与权限（{liveTools.length || TOOL_INFO.length} 个{liveTools.length > 0 ? " · 实时" : ""}）</div>
        <div className="space-y-1">
          {(liveTools.length > 0 ? liveTools.map((t) => ({ name: t.name, label: t.label, desc: t.description, minRole: "?", risk: t.risk })) : TOOL_INFO).map((t: any) => (
            <div key={t.name} className="flex items-center gap-2 rounded px-2 py-1.5 text-[11px] odd:bg-muted/30">
              <span className="w-28 shrink-0 font-mono text-[10px] text-primary">{t.name}</span>
              <span className="w-16 shrink-0 text-muted-foreground">{t.label}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground/80">{t.desc}</span>
              <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[9px]",
                t.risk === "deny" ? "bg-red-100 text-red-700"
                  : t.minRole === "manager" ? "bg-amber-100 text-amber-700"
                  : t.minRole === "analyst" ? "bg-blue-100 text-blue-700"
                  : "bg-emerald-100 text-emerald-700")}>
                {t.risk === "deny" ? "默认禁止" : "最低: " + roleLabels[t.minRole]}
              </span>
            </div>
          ))}
        </div>
      </div>
      {/* Guardian 安全策略（借鉴 Codex guardian）: 策略查看 + 判定预览 */}
      <div className="rounded-lg border border-amber-500/20 p-3">
        <div className="mb-2 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-amber-400" />
          <span className="text-xs font-medium text-amber-400">Guardian 安全策略</span>
          <span className="text-[10px] text-muted-foreground">风险等级 × 用户授权度 → allow/deny/review</span>
          <button type="button" aria-label="重载Guardian策略" onClick={() => void loadPolicy()}
            className="ml-auto rounded bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400 hover:bg-amber-500/20">查看策略</button>
            {/* 审计修复: 策略热重载 */}
            <button type="button" aria-label="重载Guardian策略" onClick={() => void reloadPolicy()}
              className="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400 hover:bg-amber-500/20">重载策略</button>
        </div>
        {guardianPolicy && (
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-slate-900/60 p-2 font-mono text-[9px] leading-3.5 text-amber-100/70">{guardianPolicy}</pre>
        )}
        {/* 判定预览: 选工具+授权度 → 看判定 */}
        <div className="mt-2 flex items-center gap-2">
          <select value={guardianTool} onChange={(e) => setGuardianTool(e.target.value)} aria-label="Guardian判定工具"
            className="rounded border border-white/10 bg-slate-800 px-2 py-1 text-[10px] text-white">
            {["sag_retrieve", "file_write", "file_read", "run_code", "web_fetch", "sag_ingest", "agent_subagent", "llm_write"].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={guardianAuth} onChange={(e) => setGuardianAuth(e.target.value)} aria-label="Guardian授权度"
            className="rounded border border-white/10 bg-slate-800 px-2 py-1 text-[10px] text-white">
            {[["high", "授权: high"], ["medium", "授权: medium"], ["low", "授权: low"], ["unknown", "授权: unknown"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button type="button" aria-label="Guardian判定" onClick={() => void previewGuardian()}
            className="rounded bg-amber-500/10 px-2 py-1 text-[10px] text-amber-400 hover:bg-amber-500/20">判定</button>
          {guardianVerdict && (
            <span className={cn("rounded px-2 py-0.5 text-[10px] font-medium",
              guardianVerdict === "allow" ? "bg-emerald-100 text-emerald-700"
                : guardianVerdict === "deny" ? "bg-red-100 text-red-700"
                : "bg-amber-100 text-amber-700")}>
              {guardianVerdict === "allow" ? "✅ allow" : guardianVerdict === "deny" ? "⛔ deny" : "⚠️ review"}
            </span>
          )}
          {guardianReason && <span className="truncate text-[9px] text-muted-foreground">{guardianReason}</span>}
        </div>
      </div>
      {/* 收尾①: Hooks 管理（生命周期钩子注册/列表/删除） */}
      <div className="rounded-lg border border-indigo-500/20 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-medium text-indigo-400">生命周期 Hooks</span>
          <span className="text-[10px] text-muted-foreground">任务/工具事件钩子（task_start/tool_after…）</span>
          <button type="button" aria-label="刷新hooks" onClick={() => void loadHooks()}
            className="ml-auto rounded bg-indigo-500/10 px-2 py-0.5 text-[10px] text-indigo-400 hover:bg-indigo-500/20">刷新</button>
        </div>
        {hooksList.length > 0 && (
          <div className="space-y-0.5">
            {hooksList.map((h) => (
              <div key={h.id} className="flex items-center gap-2 rounded px-2 py-1 text-[10px] odd:bg-muted/30">
                <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 font-mono text-indigo-300">{h.event}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{h.name}</span>
                <span className="text-[9px] text-muted-foreground/60">{h.enabled ? "启用" : "停用"}</span>
                <button type="button" aria-label="删除钩子" onClick={() => void deleteHook(h.id)}
                  className="rounded px-1 text-red-400 hover:bg-red-500/10">✕</button>
              </div>
            ))}
          </div>
        )}
        {hooksList.length === 0 && <div className="text-[10px] text-muted-foreground">暂无钩子（注册: 下方表单选择事件）</div>}
        {/* 审计修复: hooks 创建（前端此前只能读删不能建） */}
        <div className="mt-2 flex items-center gap-2">
          <select value={hookEvent} onChange={(e) => setHookEvent(e.target.value)} aria-label="钩子事件"
            className="rounded border border-white/10 bg-slate-800 px-2 py-1 text-[10px] text-white">
            {["task_start", "task_end", "tool_before", "tool_after", "step_fail", "reflect", "approval"].map((ev) => <option key={ev} value={ev}>{ev}</option>)}
          </select>
          <input value={hookName} onChange={(e) => setHookName(e.target.value)} placeholder="钩子名（如: 失败通知）"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-slate-800 px-2 py-1 text-[10px] text-white" />
          <button type="button" aria-label="注册钩子" onClick={() => void addHook()}
            className="shrink-0 rounded bg-indigo-500/10 px-2.5 py-1 text-[10px] text-indigo-300 hover:bg-indigo-500/20">注册</button>
        </div>
      </div>
      {/* 收尾①: 运行时设置（预设/自主级别/沙箱持久化状态） */}
      <div className="rounded-lg border border-cyan-500/20 p-3">
        <div className="mb-2 text-xs font-medium text-cyan-400">运行时设置（持久化到 DB）</div>
        <div className="grid grid-cols-3 gap-2 text-[10px]">
          <div className="rounded bg-slate-900/50 p-2">
            <div className="text-muted-foreground">预设模式</div>
            <div className="mt-0.5 font-medium text-cyan-300">{settings.preset || "academic"}</div>
          </div>
          <div className="rounded bg-slate-900/50 p-2">
            <div className="text-muted-foreground">自主级别</div>
            <div className="mt-0.5 font-medium text-cyan-300">{settings.autonomy || "auto-edit"}</div>
          </div>
          <div className="rounded bg-slate-900/50 p-2">
            <div className="text-muted-foreground">沙箱级别</div>
            <div className="mt-0.5 font-medium text-cyan-300">{settings.sandbox_profile || "read-only"}</div>
          </div>
        </div>
        <button type="button" aria-label="刷新设置" onClick={() => void loadSettings()}
          className="mt-2 rounded bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-400 hover:bg-cyan-500/20">刷新设置</button>
      </div>
      {/* 批次4: OAuth 授权管理（GitHub/飞书/Notion 账号） */}
      <div className="rounded-lg border border-emerald-500/20 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-medium text-emerald-400">外部服务授权（OAuth）</span>
          <span className="text-[10px] text-muted-foreground">Agent 可代表你访问 GitHub/飞书/Notion</span>
          <button type="button" aria-label="刷新OAuth" onClick={() => void loadOAuthAccounts()}
            className="ml-auto rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400 hover:bg-emerald-500/20">刷新</button>
        </div>
        {oauthAccounts.length > 0 && (
          <div className="space-y-0.5">
            {oauthAccounts.map((a) => (
              <div key={a.provider + a.account} className="flex items-center gap-2 rounded px-2 py-1 text-[10px] odd:bg-muted/30">
                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-emerald-300">{a.provider}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{a.account}</span>
                {a.scope && <span className="text-[9px] text-muted-foreground/60">{a.scope.slice(0, 20)}</span>}
                <button type="button" aria-label="撤销授权" onClick={() => void revokeOAuth(a.provider, a.account)}
                  className="rounded px-1 text-red-400 hover:bg-red-500/10">✕</button>
              </div>
            ))}
          </div>
        )}
        {oauthAccounts.length === 0 && <div className="text-[10px] text-muted-foreground">未授权任何服务 — 配置 AGENT_*_CLIENT_ID 后点下方按钮授权</div>}
        {/* 前端缺口①: OAuth 授权发起（跳转 provider 授权页） */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {oauthProviders.map((p) => (
            <button key={p} type="button" aria-label={`授权${p}`} onClick={() => void startOAuth(p)}
              className="rounded bg-emerald-500/10 px-2.5 py-1 text-[10px] text-emerald-400 hover:bg-emerald-500/20">
              授权 {p}
            </button>
          ))}
          {oauthProviders.length === 0 && <span className="text-[9px] text-muted-foreground/60">未配置任何 OAuth 应用（AGENT_GITHUB_CLIENT_ID 等）</span>}
        </div>
      </div>
      {/* 批次4: 插件模板库（一键安装预置插件） */}
      <div className="rounded-lg border border-purple-500/20 p-3">
        <div className="mb-2 text-xs font-medium text-purple-400">插件模板库（一键安装, 热加载生效）</div>
        <div className="space-y-1">
          {pluginTemplates.map((t) => (
            <div key={t.id} className="flex items-center gap-2 rounded px-2 py-1 text-[10px] odd:bg-muted/30">
              <span className="font-medium text-purple-300">{t.name}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{t.desc}</span>
              <button type="button" aria-label={`安装${t.name}插件`} onClick={() => void installPlugin(t.id)}
                className="shrink-0 rounded bg-purple-500/10 px-2 py-0.5 text-purple-300 hover:bg-purple-500/20">安装</button>
            </div>
          ))}
        </div>
        {pluginMsg && <div className="mt-1 text-[10px] text-emerald-400">{pluginMsg}</div>}
        {/* 前端缺口④: 已安装插件文件（plugins/ 目录） */}
        {pluginFiles.length > 0 && (
          <div className="mt-2 border-t border-purple-500/10 pt-2">
            <div className="mb-1 text-[9px] text-muted-foreground">已安装插件（plugins/ 目录, 热加载生效）:</div>
            <div className="flex flex-wrap gap-1">
              {pluginFiles.map((f) => (
                <span key={f} className="rounded bg-purple-500/10 px-1.5 py-0.5 font-mono text-[9px] text-purple-300">{f}</span>
              ))}
            </div>
          </div>
        )}
      </div>
      {/* 前端缺口⑥⑦: Provider 状态 + 运行时诊断 */}
      <div className="rounded-lg border border-slate-500/20 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-medium text-slate-400">运行时诊断</span>
          <span className="text-[10px] text-muted-foreground">Provider/并发/队列/内存/子进程</span>
          <button type="button" aria-label="刷新诊断" onClick={() => void loadDiagnostics()}
            className="ml-auto rounded bg-slate-500/10 px-2 py-0.5 text-[10px] text-slate-400 hover:bg-slate-500/20">刷新</button>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <div className="rounded bg-slate-900/50 p-2">
            <div className="text-muted-foreground">LLM Provider</div>
            <div className="mt-0.5 font-medium text-slate-300">{diag.providers?.llm?.filter((p: any) => p.active)[0]?.label || "default"}</div>
          </div>
          <div className="rounded bg-slate-900/50 p-2">
            <div className="text-muted-foreground">Sandbox Provider</div>
            <div className="mt-0.5 font-medium text-slate-300">{diag.providers?.sandbox?.filter((p: any) => p.active)[0]?.label || "default"}</div>
          </div>
          <div className="rounded bg-slate-900/50 p-2">
            <div className="text-muted-foreground">LLM 并发</div>
            <div className="mt-0.5 font-medium text-slate-300">{diag.llm ? `${diag.llm.active}/${diag.llm.adaptiveCap}` : "-"}</div>
          </div>
          <div className="rounded bg-slate-900/50 p-2">
            <div className="text-muted-foreground">队列</div>
            <div className="mt-0.5 font-medium text-slate-300">{diag.queue ? `${diag.queue.queued} 等 / ${diag.queue.running} 跑` : "-"}</div>
          </div>
          <div className="rounded bg-slate-900/50 p-2">
            <div className="text-muted-foreground">内存 RSS</div>
            <div className="mt-0.5 font-medium text-slate-300">{diag.memory ? `${diag.memory.rssMB} MB` : "-"}</div>
          </div>
          <div className="rounded bg-slate-900/50 p-2">
            <div className="text-muted-foreground">子进程</div>
            <div className="mt-0.5 font-medium text-slate-300">{diag.procs ? `${diag.procs.length} 个` : "-"}</div>
          </div>
          {/* wisp借鉴: 持久运行时会话 + 远程上下文状态 */}
          <div className="rounded bg-slate-900/50 p-2">
            <div className="text-muted-foreground">持久Python会话</div>
            <div className="mt-0.5 font-medium text-slate-300">{diag.compute ? `${diag.compute.runtimes?.length ?? 0} 个活跃` : "-"}</div>
          </div>
          <div className="rounded bg-slate-900/50 p-2">
            <div className="text-muted-foreground">远程计算</div>
            <div className="mt-0.5 font-medium text-slate-300">
              {diag.compute ? [
                diag.compute.remote?.wsl ? "WSL" : "",
                diag.compute.remote?.sshConfigured ? "SSH" : "",
                diag.compute.remote?.gpuConfigured ? "GPU" : "",
              ].filter(Boolean).join("/") || "仅本机" : "-"}
            </div>
          </div>
          {/* 审计修复: 诊断补全 — SSE订阅/会话/工具注册/DB */}
          <div className="rounded bg-slate-900/50 p-2">
            <div className="text-muted-foreground">SSE订阅</div>
            <div className="mt-0.5 font-medium text-slate-300">{diag.sse ?? "-"}</div>
          </div>
          <div className="rounded bg-slate-900/50 p-2">
            <div className="text-muted-foreground">聊天会话</div>
            <div className="mt-0.5 font-medium text-slate-300">{diag.chatSessions ?? "-"}</div>
          </div>
          <div className="rounded bg-slate-900/50 p-2">
            <div className="text-muted-foreground">工具注册</div>
            <div className="mt-0.5 font-medium text-slate-300">{diag.toolRegistry?.size ?? "-"}</div>
          </div>
          <div className="rounded bg-slate-900/50 p-2">
            <div className="text-muted-foreground">DB任务</div>
            <div className="mt-0.5 font-medium text-slate-300">
              {diag.db ? `${diag.db.running ?? 0}跑/${diag.db.awaiting ?? 0}待/${diag.db.failed24h ?? 0}败24h` : "-"}
            </div>
          </div>
        </div>
        {/* wisp借鉴: 持久运行时重置按钮 */}
        <button type="button" aria-label="重置持久运行时" onClick={() => void resetRuntimes()}
          className="mt-2 rounded bg-slate-500/10 px-2 py-0.5 text-[10px] text-slate-400 hover:bg-slate-500/20"
          title="关闭全部持久 Python 会话（下次调用重新创建）">
          重置持久运行时
        </button>
      </div>
      {/* 审计修复: 工作流模板执行（复用 TaskPanel 的编排能力） */}
      <div className="rounded-lg border border-teal-500/20 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-medium text-teal-400">工作流</span>
          <span className="text-[10px] text-muted-foreground">一键运行预置流水线（文献综述/概念溯源/实证分析）</span>
        </div>
        <div className="space-y-1">
          {workflows.map((w) => (
            <div key={w.id} className="flex items-center gap-2 rounded px-2 py-1 text-[10px] odd:bg-muted/30">
              <span className="font-medium text-teal-300">{w.name}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{w.desc}</span>
              <button type="button" aria-label={`运行${w.name}`} onClick={() => void runWorkflow(w.id)}
                className="shrink-0 rounded bg-teal-500/10 px-2 py-0.5 text-teal-300 hover:bg-teal-500/20">运行</button>
            </div>
          ))}
          {workflowMsg && <div className="text-[10px] text-emerald-400">{workflowMsg}</div>}
        </div>
      </div>
      {/* 审计修复: 会话检索 + 凭据管理 + 自主级别读写 */}
      <div className="rounded-lg border border-rose-500/20 p-3">
        <div className="mb-2 text-xs font-medium text-rose-400">会话检索 / 凭据 / 自主级别</div>
        <div className="mb-2 flex gap-2">
          <input value={sessionSearchQ} onChange={(e) => setSessionSearchQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void searchSessions(); }}
            placeholder="跨会话检索（找回历史研究）…" className="min-w-0 flex-1 rounded-md border border-white/10 bg-slate-800 px-2 py-1 text-[10px] text-white" />
          <button type="button" aria-label="会话检索" onClick={() => void searchSessions()}
            className="shrink-0 rounded bg-rose-500/10 px-2 py-1 text-[10px] text-rose-300 hover:bg-rose-500/20">检索</button>
        </div>
        {sessionResults.length > 0 && (
          <div className="mb-2 max-h-24 space-y-0.5 overflow-y-auto">
            {sessionResults.map((s, i) => (
              <div key={i} className="rounded bg-slate-900/50 px-2 py-1 text-[9px] text-muted-foreground">{s.snippet}</div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {/* 自主级别读写 */}
          <select value={autonomyLevel} onChange={(e) => void setAutonomy(e.target.value)} aria-label="自主级别"
            className="rounded border border-white/10 bg-slate-800 px-2 py-1 text-[10px] text-white">
            <option value="suggest">自主: 建议(逐步审批)</option>
            <option value="auto-edit">自主: 自动编辑(高危审批)</option>
            <option value="full-auto">自主: 全自动</option>
          </select>
          {/* 凭据管理 */}
          {credNames.map((c) => (
            <span key={c} className="flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300">
              {c}
              <button type="button" aria-label={`删除凭据${c}`} onClick={() => void deleteCred(c)}
                className="text-red-400 hover:text-red-300">✕</button>
            </span>
          ))}
          {credNames.length === 0 && <span className="text-[9px] text-muted-foreground/60">无凭据（OAuth 授权后自动存储）</span>}
        </div>
      </div>
      {/* 审计修复: 运维操作 — 反馈统计/审批超时/工人列表 */}
      <div className="rounded-lg border border-slate-500/20 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-medium text-slate-400">运维操作</span>
          <span className="text-[10px] text-muted-foreground">反馈统计 / 审批超时 / 工人任务</span>
        </div>
        <div className="space-y-1.5 text-[10px]">
          {/* 反馈统计 */}
          <div className="flex items-center gap-2 rounded bg-slate-900/50 px-2 py-1">
            <span className="text-muted-foreground">用户反馈:</span>
            <span className="text-emerald-300">👍 {feedbackStats.positive ?? 0}</span>
            <span className="text-red-300">👎 {feedbackStats.negative ?? 0}</span>
            <button type="button" aria-label="刷新反馈统计" onClick={() => void loadFeedbackStats()}
              className="ml-auto rounded bg-slate-500/10 px-2 py-0.5 text-slate-400 hover:bg-slate-500/20">刷新</button>
          </div>
          {/* 审批超时处理 */}
          <div className="flex items-center gap-2 rounded bg-slate-900/50 px-2 py-1">
            <span className="text-muted-foreground">审批超时: 未响应任务自动按拒绝处理</span>
            <button type="button" aria-label="处理审批超时" onClick={() => void runApprovalTimeout()}
              className="ml-auto rounded bg-amber-500/10 px-2 py-0.5 text-amber-300 hover:bg-amber-500/20">立即处理</button>
          </div>
          {/* 工人任务列表 */}
          <div className="rounded bg-slate-900/50 px-2 py-1">
            <div className="flex items-center">
              <span className="text-muted-foreground">工人任务: {workers.length} 个</span>
              <button type="button" aria-label="加载工人" onClick={() => void loadWorkers()}
                className="ml-auto rounded bg-slate-500/10 px-2 py-0.5 text-slate-400 hover:bg-slate-500/20">加载</button>
            </div>
            {workers.length > 0 && (
              <div className="mt-1 max-h-24 space-y-0.5 overflow-y-auto">
                {workers.slice(0, 8).map((w: any) => (
                  <div key={w.id} className="flex items-center gap-2 text-[9px] text-muted-foreground">
                    <span className="font-mono text-slate-400">{w.workerName}</span>
                    <span className={"rounded px-1 " + (w.status === "done" ? "bg-emerald-500/15 text-emerald-300" : w.status === "failed" ? "bg-red-500/15 text-red-300" : "bg-slate-500/15 text-slate-300")}>{w.status}</span>
                    <span className="min-w-0 flex-1 truncate">{w.goal}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* 审计修复: 图片预处理检查（>1MB 提示压缩, 减少多模态 token） */}
          <div className="flex items-center gap-2 rounded bg-slate-900/50 px-2 py-1">
            <input value={imageCheckPath} onChange={(e) => setImageCheckPath(e.target.value)}
              placeholder="检查图片: agent_workspace/xxx.png" className="min-w-0 flex-1 rounded border border-white/10 bg-slate-800 px-2 py-0.5 text-[10px] text-white" />
            <button type="button" aria-label="检查图片" onClick={() => void checkImage()}
              className="shrink-0 rounded bg-slate-500/10 px-2 py-0.5 text-slate-400 hover:bg-slate-500/20">检查</button>
            {imageCheckMsg && <span className="shrink-0 text-[9px] text-amber-300/80">{imageCheckMsg}</span>}
          </div>
        </div>
      </div>
      {/* 审计修复: 质量评审（手动评审文本 — 复用多Agent评审质量门） */}
      <div className="rounded-lg border border-orange-500/20 p-3">
        <div className="mb-2 text-xs font-medium text-orange-400">质量评审（多 Agent 视角）</div>
        <textarea value={reviewText} onChange={(e) => setReviewText(e.target.value)} rows={3}
          placeholder="粘贴要评审的研究产出/段落…" className="w-full rounded-md border border-white/10 bg-slate-800 px-2 py-1 text-[10px] text-white" />
        <div className="mt-1 flex items-center gap-2">
          <button type="button" aria-label="评审文本" onClick={() => void runReview()} disabled={!reviewText.trim()}
            className="rounded bg-orange-500/10 px-3 py-1 text-[10px] text-orange-300 hover:bg-orange-500/20 disabled:opacity-40">
            评审
          </button>
          {reviewResult && (
            <pre className="min-w-0 flex-1 truncate whitespace-pre-wrap font-mono text-[9px] leading-3.5 text-orange-100/70">{reviewResult}</pre>
          )}
        </div>
      </div>
      {/* V394-2: 模型路由展示 */}
      <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
        <div className="mb-2 text-xs font-medium text-muted-foreground">模型路由策略（按步骤类型+复杂度选档）</div>
        <div className="space-y-1">
          {[
            ["检索/摘要", "cheap", "便宜档 · 简单任务用"],
            ["写作/评审/规划/评估", "standard", "标准档 · 常规任务"],
            ["推理（含机制/因果/比较等复杂信号）", "strong", "强档 · 复杂任务升档"],
          ].map(([t, tier, desc]) => (
            <div key={tier} className="flex items-center gap-2 rounded px-2 py-1.5 text-[11px] odd:bg-muted/30">
              <span className="w-32 shrink-0 truncate text-muted-foreground">{t}</span>
              <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[9px]",
                tier === "cheap" ? "bg-emerald-100 text-emerald-700"
                  : tier === "strong" ? "bg-purple-100 text-purple-700"
                  : "bg-blue-100 text-blue-700")}>
                {tier}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground/70">{desc}</span>
            </div>
          ))}
        </div>
      </div>
      {/* V394-3: 知识回流展示 */}
      <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
        <div className="mb-2 text-xs font-medium text-muted-foreground">知识回流（任务产出 → 知识页草稿）</div>
        <div className="text-[11px] leading-4 text-muted-foreground">
          Agent 任务完成且产出 ≥100 字时，自动提交为知识页草稿（<span className="text-primary">pending_review</span>），在「知识页」审核通过后正式入库。
          同主题草稿自动去重。你的研究成果会逐步沉淀为可复用的知识库。
        </div>
      </div>
      {/* V394-1: 规划记忆注入展示 */}
      <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
        <div className="mb-2 text-xs font-medium text-muted-foreground">规划记忆注入（规划时自动加载）</div>
        <div className="space-y-1 text-[11px]">
          <div className="flex items-center gap-2 rounded px-2 py-1 odd:bg-muted/30">
            <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[9px] text-red-700">防错规则</span>
            <span className="text-muted-foreground">历史踩坑自动防复发（「防错规则」tab 管理）</span>
          </div>
          <div className="flex items-center gap-2 rounded px-2 py-1 odd:bg-muted/30">
            <span className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[9px] text-blue-700">战略记忆</span>
            <span className="text-muted-foreground">项目目标/约束对齐（「战略记忆」tab 管理）</span>
          </div>
        </div>
      </div>
      <div className="rounded-lg border border-dashed border-primary/30 bg-primary/5 p-3">
        <div className="mb-1 text-xs font-medium text-primary">白名单配置</div>
        <div className="text-[11px] leading-4 text-muted-foreground">
          后端环境变量 AGENT_TOOL_WHITELIST 可限制 Agent 可用工具（逗号分隔）。
          危险工具（file_delete 等）默认禁止，白名单开启后仍需人工审批。
        </div>
      </div>
    </>
  );
}


// V393: 评测报告 demo（沙箱）
function EvalDemo() {
  const demo: EvalReport = {
    days: 7, totalTasks: 12, completedTasks: 9, failedTasks: 2, cancelledTasks: 1,
    completionRate: 0.75, totalSteps: 38, succeededSteps: 34, failedSteps: 4, stepSuccessRate: 0.895,
    multiLoopTasks: 3, multiLoopRate: 0.33, reflectCount: 6, approvalCount: 2,
    avgCostCents: 9, totalCostCents: 342,
    // V396-1: 轨迹级 demo
    planAdherence: 0.92, toolAccuracy: 0.895, toolRetryRate: 0.08, reasoningQuality: 0.78, judgedTasks: 5,
  };
  const pct = (v: number) => Math.round(v * 100) + "%";
  return (
    <div className="space-y-4">
      <div className="rounded border border-amber-300/40 bg-amber-50/10 px-3 py-2 text-xs text-amber-600">演示数据（沙箱 · 不消耗 API）</div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
          <div className="text-xs text-muted-foreground">任务完成率</div>
          <div className="mt-1 text-2xl font-bold text-primary">{pct(demo.completionRate)}</div>
          <div className="text-[10px] text-muted-foreground">{demo.completedTasks}/{demo.totalTasks} 完成</div>
        </div>
        <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
          <div className="text-xs text-muted-foreground">步骤成功率</div>
          <div className="mt-1 text-2xl font-bold text-emerald-600">{pct(demo.stepSuccessRate)}</div>
          <div className="text-[10px] text-muted-foreground">{demo.succeededSteps}/{demo.totalSteps} 步</div>
        </div>
        <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
          <div className="text-xs text-muted-foreground">多轮收敛率</div>
          <div className="mt-1 text-2xl font-bold text-purple-600">{pct(demo.multiLoopRate)}</div>
          <div className="text-[10px] text-muted-foreground">{demo.multiLoopTasks} 个任务 ≥2轮</div>
        </div>
        <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
          <div className="text-xs text-muted-foreground">平均步骤成本</div>
          <div className="mt-1 text-2xl font-bold text-emerald-600">¥{(demo.avgCostCents / 100).toFixed(3)}</div>
          <div className="text-[10px] text-muted-foreground">总成本 ¥{(demo.totalCostCents / 100).toFixed(3)}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
          <div className="text-xs text-muted-foreground">失败任务</div>
          <div className="mt-1 text-xl font-bold text-red-600">{demo.failedTasks}</div>
        </div>
        <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
          <div className="text-xs text-muted-foreground">失败步骤</div>
          <div className="mt-1 text-xl font-bold text-red-600">{demo.failedSteps}</div>
        </div>
        <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
          <div className="text-xs text-muted-foreground">reflect 评估</div>
          <div className="mt-1 text-xl font-bold">{demo.reflectCount}</div>
        </div>
        <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
          <div className="text-xs text-muted-foreground">审批次数</div>
          <div className="mt-1 text-xl font-bold">{demo.approvalCount}</div>
        </div>
      </div>
    </div>
  );
}

// V393: 审计报表 demo（沙箱）
function AuditDemo() {
  const demo = {
    totalTasks: 38, totalCostCents: 342, totalTokens: 125600,
    byTool: [
      { tool: "reason", costCents: 150, count: 12 },
      { tool: "write", costCents: 80, count: 8 },
      { tool: "reflect", costCents: 30, count: 6 },
      { tool: "review", costCents: 27, count: 6 },
      { tool: "retrieve", costCents: 20, count: 6 },
    ],
    recentTasks: [
      { taskId: "3f2a...91", stepId: "s2", action: "tool_call", tool: "reason", costCents: 15, createdAt: new Date().toISOString() },
      { taskId: "3f2a...91", stepId: "s3", action: "tool_call", tool: "write", costCents: 8, createdAt: new Date().toISOString() },
      { taskId: "3f2a...91", stepId: "s4", action: "reflect", tool: "llm-reflect", costCents: 3, createdAt: new Date().toISOString() },
      { taskId: "7b1c...44", stepId: "s1", action: "tool_call", tool: "retrieve", costCents: 2, createdAt: new Date().toISOString() },
      { taskId: "7b1c...44", stepId: "s5", action: "approval", tool: "human-gate", costCents: 0, createdAt: new Date().toISOString() },
    ],
  };
  const max = Math.max(...demo.byTool.map((x) => x.costCents), 1);
  return (
    <div className="space-y-4">
      <div className="rounded border border-amber-300/40 bg-amber-50/10 px-3 py-2 text-xs text-amber-600">演示数据（沙箱 · 不消耗 API）</div>
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
          <div className="text-xs text-muted-foreground">执行次数</div>
          <div className="mt-1 text-2xl font-bold text-primary">{demo.totalTasks}</div>
        </div>
        <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
          <div className="text-xs text-muted-foreground">累计成本</div>
          <div className="mt-1 text-2xl font-bold text-emerald-600">¥{(demo.totalCostCents / 100).toFixed(3)}</div>
        </div>
        <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
          <div className="text-xs text-muted-foreground">总 token</div>
          <div className="mt-1 text-2xl font-bold">{demo.totalTokens.toLocaleString()}</div>
        </div>
      </div>
      <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
        <div className="mb-2 text-xs font-medium text-muted-foreground">按工具成本分布</div>
        <div className="space-y-1.5">
          {demo.byTool.map((t) => (
            <div key={t.tool} className="flex items-center gap-2">
              <span className="w-24 shrink-0 truncate font-mono text-[10px]">{t.tool}</span>
              <div className="h-2 min-w-0 flex-1 overflow-hidden rounded bg-muted">
                <div className="h-full rounded bg-primary" style={{ width: ((t.costCents / max) * 100) + "%" }} />
              </div>
              <span className="shrink-0 text-[10px] text-muted-foreground">¥{(t.costCents / 100).toFixed(3)} · {t.count}次</span>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-lg border p-3 transition-all duration-200 hover:border-primary/30 hover:shadow-md">
        <div className="mb-2 text-xs font-medium text-muted-foreground">最近执行（{demo.recentTasks.length} 条）</div>
        <div className="space-y-1">
          {demo.recentTasks.map((t, i) => (
            <div key={i} className="flex items-center gap-2 rounded px-2 py-1 text-[11px] odd:bg-muted/30">
              <span className="rounded bg-muted px-1 font-mono text-[10px]">{t.tool || "-"}</span>
              <span className="font-mono text-[10px] text-primary">{t.action}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-muted-foreground">{t.taskId}</span>
              <span className="shrink-0 font-mono text-[10px] text-emerald-600">¥{(t.costCents / 100).toFixed(3)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// V396-8: 情景记忆 tab（研究轨迹 + 遗忘机制）
function EpisodicTab({ demoOn }: { demoOn: boolean }) {
  const [memories, setMemories] = useState<any[]>([]);
  const [query, setQuery] = useState("");
  const [forgetResult, setForgetResult] = useState("");
  const load = async (q = "") => {
    try {
      // G-demo: 演示模式用 DEMO_EPISODIC 填充（沙箱不调 API）
      if (demoOn) { setMemories(DEMO_EPISODIC); return; }
      const r = await fetch(`/api/agent/episodic-memory${q ? "?q=" + encodeURIComponent(q) : ""}`);
      setMemories((await r.json()).memories || []);
    } catch {}
  };
  useEffect(() => { void load(); }, [demoOn]);
  const runForget = async () => {
    try {
      const r = await fetch("/api/agent/episodic-memory/forget", { method: "POST" });
      const d = await r.json();
      setForgetResult(`遗忘 ${d.result?.forgotten || 0} 条（${(d.result?.reasons || []).join("; ")}）`);
      await load();
    } catch {}
  };
  // 审计修复: 记忆整理(consolidate)
  const runConsolidate = async () => {
    try {
      const r = await fetch("/api/agent/episodic-memory/consolidate", { method: "POST" });
      const d = await r.json();
      setForgetResult(`整理完成: ${d.result?.consolidated || d.result?.merged || "OK"}`);
      await load();
    } catch { setForgetResult("整理失败"); }
  };
  // W4: 消息表 TTL 清理（agent_messages/worker_tasks）
  const runCleanup = async () => {
    try {
      const r = await fetch("/api/agent/cleanup-tables", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 30 }),
      });
      const d = await r.json();
      const res = d.result || {};
      setForgetResult(`清理: 消息 ${res.messagesDeleted ?? 0} 条 · 工人任务 ${res.workersDeleted ?? 0} 条（>30天）`);
    } catch {}
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="h-5 w-5 text-cyan-500" />
          <h2 className="text-lg font-semibold">情景记忆</h2>
          <span className="text-xs text-muted-foreground">研究轨迹沉淀 · 检索复用 · 三类遗忘机制</span>
        </div>
        <div className="flex items-center gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="检索历史研究轨迹…"
            className="rounded border border-white/10 bg-slate-800 px-2 py-1 text-xs text-white" />
          <button type="button" onClick={() => void load(query)}
            className="rounded-md bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-400 hover:bg-cyan-500/20">检索</button>
          <button type="button" onClick={() => void runForget()}
            className="rounded-md bg-amber-500/10 px-3 py-1.5 text-xs text-amber-400 hover:bg-amber-500/20">执行遗忘</button>
          {/* 审计修复: 记忆整理(consolidate) */}
          <button type="button" onClick={() => void runConsolidate()}
            className="rounded-md bg-purple-500/10 px-3 py-1.5 text-xs text-purple-400 hover:bg-purple-500/20">整理记忆</button>
          <button type="button" onClick={() => void runCleanup()} title="删除30天前的消息/工人任务"
            className="rounded-md bg-slate-500/10 px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-500/20">清理消息表</button>
        </div>
      </div>
      {forgetResult && <div className="rounded bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300">{forgetResult}</div>}
      <div className="space-y-2">
        {memories.length === 0 && <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">暂无情景记忆 — 运行 Agent 任务后自动沉淀</div>}
        {memories.map((m: any) => (
          <div key={m.id} className="rounded-lg border border-cyan-500/20 p-3">
            <div className="flex items-center gap-2">
              <span className={"rounded px-1.5 py-0.5 text-[9px] font-bold " + (m.outcome === "success" ? "bg-emerald-500/15 text-emerald-300" : m.outcome === "partial" ? "bg-amber-500/15 text-amber-300" : "bg-red-500/15 text-red-300")}>{m.outcome}</span>
              <span className="text-xs font-medium">{m.goal}</span>
              <span className="ml-auto text-[9px] text-muted-foreground">重要 {m.importance} · 访问 {m.accessCount} 次</span>
            </div>
            <div className="mt-1 text-[10px] leading-4 text-muted-foreground">{m.summary}</div>
            {m.toolsUsed?.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {m.toolsUsed.map((t: string, i: number) => (
                  <span key={i} className="rounded bg-slate-700/60 px-1 py-0.5 text-[8px] text-slate-300">{t}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// V396-9: 技能库 tab（蒸馏技能 + EDV 验证）
function SkillsTab({ demoOn }: { demoOn: boolean }) {
  const [skills, setSkills] = useState<any[]>([]);
  const [skillifyMsg, setSkillifyMsg] = useState("");
  // 审计修复: 技能召回检索（跨任务复用蒸馏技能）
  const [recallQ, setRecallQ] = useState("");
  const [recallResults, setRecallResults] = useState<any[]>([]);
  // 2026-08-29 Agentero 对照: Skill 导入/卸载
  const [importPath, setImportPath] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const [installed, setInstalled] = useState<Array<{ name: string; hasHealthcheck: boolean }>>([]);

  const loadInstalled = async () => {
    try {
      const r = await fetch("/api/agent/skills/installed");
      const d = await r.json();
      setInstalled(d.skills || []);
    } catch { setInstalled([]); }
  };
  useEffect(() => { void loadInstalled(); }, []);

  const doImportSkill = async () => {
    if (!importPath.trim()) return;
    setImportMsg("导入中…");
    try {
      const r = await fetch("/api/agent/skills/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourcePath: importPath.trim() }),
      });
      const d = await r.json();
      if (d.ok) { setImportMsg(`✅ 已导入技能「${d.name}」（~/.claude/skills/${d.name}）`); setImportPath(""); await loadInstalled(); }
      else setImportMsg(`❌ ${d.error?.message || "导入失败"}`);
    } catch (e: any) { setImportMsg(`❌ ${e.message || "导入失败"}`); }
  };

  const doRemoveSkill = async (name: string) => {
    if (!confirm(`卸载技能「${name}」？`)) return;
    try {
      const r = await fetch(`/api/agent/skills/${encodeURIComponent(name)}/remove`, { method: "POST" });
      const d = await r.json();
      if (d.ok) { setImportMsg(`✅ 已卸载「${name}」`); await loadInstalled(); }
      else setImportMsg(`❌ ${d.error?.message || "卸载失败"}`);
    } catch (e: any) { setImportMsg(`❌ ${e.message || "卸载失败"}`); }
  };
  const load = async () => {
    try {
      // G-demo: 演示模式用 DEMO_SKILLS 填充（沙箱不调 API）
      if (demoOn) { setSkills(DEMO_SKILLS); return; }
      const r = await fetch("/api/agent/skills");
      setSkills((await r.json()).skills || []);
    } catch {}
  };
  const recallSkills = async () => {
    try {
      const r = await fetch("/api/agent/skills/recall?query=" + encodeURIComponent(recallQ));
      setRecallResults((await r.json()).skills || []);
    } catch { setRecallResults([]); }
  };
  useEffect(() => { void load(); }, [demoOn]);
  // V396-15: 固化为正式 Skill — approved 技能一键调 Skillify 生成 ~/.claude/skills/ SKILL.md
  const solidifySkill = async (s: any) => {
    setSkillifyMsg("");
    try {
      // name: 技能名转 kebab-case（中文名用 agent-skill-N）
      const name = /^[a-z0-9-]+$/.test(s.name) ? s.name : `agent-skill-${s.id}`;
      const r = await fetch("/api/skills/skillify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          title: s.name,
          description: `${s.whenToApply}（AI 蒸馏技能, EDV 共识 ${s.consensus}/${s.votes?.length || 0} 票）`,
          triggers: [s.whenToApply],
          steps: s.skillMd?.split(/[。\n]/).map((x: string) => x.trim()).filter((x: string) => x.length > 3).slice(0, 8) || [s.skillMd],
        }),
      });
      const d = await r.json();
      setSkillifyMsg(d.ok ? `✅ 已固化: ${d.path}` : `❌ ${d.error || "固化失败"}`);
    } catch (e: any) {
      setSkillifyMsg(`❌ ${e.message || "固化失败"}`);
    }
  };
  // V396-16: 删除技能（可选连带删已固化的 SKILL.md）
  const removeSkill = async (s: any) => {
    if (!confirm(`删除技能「${s.name}」？${s.status === "approved" ? "\n（已固化为 SKILL.md 的话会一并删除）" : ""}`)) return;
    setSkillifyMsg("");
    try {
      const r = await fetch(`/api/agent/skills/${s.id}?removeSkillify=true`, { method: "DELETE" });
      const d = await r.json();
      if (d.error) { setSkillifyMsg(`❌ ${d.error}`); return; }
      setSkillifyMsg(d.removedSkillify ? `✅ 已删除技能 + SKILL.md（${d.removedSkillify}）` : "✅ 已删除技能");
      await load();
    } catch (e: any) { setSkillifyMsg(`❌ ${e.message || "删除失败"}`); }
  };
  return (
    <div className="space-y-3">
      {/* 2026-08-29 Agentero 对照: Skill 导入（本地路径 → ~/.claude/skills/） */}
      <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-indigo-300">
          <Wrench className="h-3.5 w-3.5" /> Skill 导入 / 卸载
          <span className="text-[9px] font-normal text-muted-foreground">从本地目录导入 SKILL.md 技能包 → ~/.claude/skills/</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input value={importPath} onChange={(e) => setImportPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void doImportSkill(); }}
            placeholder="技能包路径，如 D:/skills/my-skill 或 …/SKILL.md"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-slate-800 px-3 py-1.5 text-xs text-white outline-none" />
          <button type="button" onClick={() => void doImportSkill()} disabled={!importPath.trim()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
            导入
          </button>
          <button type="button" onClick={() => void loadInstalled()}
            className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent">
            查看已安装
          </button>
        </div>
        {importMsg && <div className="mt-1.5 text-[10px] text-indigo-300">{importMsg}</div>}
        {installed.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[9px] text-muted-foreground">已安装：</span>
            {installed.map((s) => (
              <span key={s.name} className="flex items-center gap-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-[10px] text-indigo-300">
                {s.name}
                {s.hasHealthcheck && <span title="含健康检查">✓</span>}
                <button type="button" onClick={() => void doRemoveSkill(s.name)}
                  className="text-indigo-400 hover:text-red-400" title="卸载">✕</button>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Wrench className="h-5 w-5 text-indigo-500" />
        <h2 className="text-lg font-semibold">技能库</h2>
        <span className="text-xs text-muted-foreground">从任务轨迹蒸馏的可复用技能 · EDV 防自我确认 · approved 可固化为正式 Skill</span>
        <button type="button" onClick={() => void load()} className="ml-auto rounded-md bg-indigo-500/10 px-3 py-1.5 text-xs text-indigo-400 hover:bg-indigo-500/20">刷新</button>
      </div>
      {/* 审计修复: 技能召回检索（跨任务复用蒸馏技能） */}
      <div className="flex items-center gap-2">
        <input value={recallQ} onChange={(e) => setRecallQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void recallSkills(); }}
          placeholder="技能召回检索（按适用场景找可复用技能）…" className="min-w-0 flex-1 rounded-md border border-white/10 bg-slate-800 px-3 py-1.5 text-xs text-white" />
        <button type="button" onClick={() => void recallSkills()}
          className="shrink-0 rounded-md bg-indigo-500/10 px-3 py-1.5 text-xs text-indigo-400 hover:bg-indigo-500/20">召回</button>
      </div>
      {recallResults.length > 0 && (
        <div className="space-y-1">
          {recallResults.map((s: any) => (
            <div key={s.id} className="rounded border border-indigo-500/20 bg-indigo-500/5 px-2 py-1.5 text-[10px]">
              <span className="font-medium text-indigo-300">{s.name}</span>
              <span className="ml-2 text-muted-foreground">适用: {s.whenToApply}</span>
              <div className="mt-0.5 text-muted-foreground/80">{s.skillMd}</div>
            </div>
          ))}
        </div>
      )}
      {skillifyMsg && <div className="rounded bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300">{skillifyMsg}</div>}
      <div className="space-y-2">
        {skills.length === 0 && <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">暂无蒸馏技能 — 任务完成后自动提炼</div>}
        {skills.map((s: any) => (
          <div key={s.id} className="rounded-lg border border-indigo-500/20 p-3">
            <div className="flex items-center gap-2">
              <span className={"rounded px-1.5 py-0.5 text-[9px] font-bold " + (s.status === "approved" ? "bg-emerald-500/15 text-emerald-300" : s.status === "rejected" ? "bg-red-500/15 text-red-300" : "bg-amber-500/15 text-amber-300")}>{s.status}</span>
              <span className="text-xs font-medium">{s.name}</span>
              <span className="ml-auto text-[9px] text-muted-foreground">共识 {s.consensus}/{s.votes?.length || 0} 票</span>
              {s.status === "approved" && (
                <button type="button" onClick={() => void solidifySkill(s)} title="固化为正式 SKILL.md（进入技能页）"
                  className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[8px] font-medium text-emerald-300 hover:bg-emerald-500/25">
                  固化为 Skill
                </button>
              )}
              <button type="button" onClick={() => void removeSkill(s)} title="删除技能（已固化的 SKILL.md 一并删除）"
                className="shrink-0 rounded bg-red-500/15 px-1.5 py-0.5 text-[8px] font-medium text-red-300 hover:bg-red-500/25">
                ✕ 删除
              </button>
            </div>
            <div className="mt-1 text-[10px] text-indigo-300">适用: {s.whenToApply}</div>
            <div className="mt-1 text-[10px] leading-4 text-muted-foreground">{s.skillMd}</div>
            {s.votes?.length > 0 && (
              <div className="mt-1.5 space-y-0.5">
                {s.votes.map((v: any, i: number) => (
                  <div key={i} className="text-[9px] text-slate-400">{v.validator}: {v.verdict} — {v.reason}</div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══ Agent 管理 tab（2026-08-29, Agentero 对照: 支持快速安装、配置、卸载 Agent）═══
function AgentManageTab() {
  const [status, setStatus] = useState<{ running: boolean; configured: boolean; name: string; command: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [taskInput, setTaskInput] = useState("");
  const [taskResult, setTaskResult] = useState("");

  const refresh = async () => {
    const r = await fetch("/api/byoa/agent-status").then((x) => x.json()).catch(() => null);
    setStatus(r || { running: false, configured: false, name: "", command: "" });
  };
  useEffect(() => { void refresh(); }, []);

  const act = async (action: "start" | "stop" | "test", label: string) => {
    setBusy(action);
    const r = await fetch(`/api/byoa/agent/${action}`, { method: "POST" }).then((x) => x.json()).catch(() => null);
    setBusy(null);
    if (r?.ok) setNotice({ type: "ok", text: `${label}成功` });
    else setNotice({ type: "err", text: r?.error || `${label}失败` });
    void refresh();
  };

  const runTask = async () => {
    if (!taskInput.trim()) return;
    setBusy("run");
    const r = await fetch("/api/byoa/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: taskInput }) }).then((x) => x.json()).catch(() => null);
    setBusy(null);
    r?.ok ? setTaskResult(String(r.result || "（无返回）").slice(0, 3000)) : setNotice({ type: "err", text: r?.error || "任务失败" });
  };

  return (
    <div className="rounded-xl border bg-card/60 p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="text-xs font-semibold">外部 Agent 管理（ACP）</div>
        <span className={`ml-auto rounded px-1.5 py-0.5 text-[9px] ${status?.running ? "bg-green-100 text-green-700" : "bg-muted/40 text-muted-foreground"}`}>
          {status?.running ? "运行中" : "未运行"}
        </span>
        <span className={`rounded px-1.5 py-0.5 text-[9px] ${status?.configured ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"}`}>
          {status?.configured ? "已配置" : "未配置"}
        </span>
      </div>
      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-3">
        <div className="rounded-lg bg-muted/20 p-2">
          <div className="text-[9px] text-muted-foreground">Agent 名称</div>
          <div className="truncate text-[12px] font-medium">{status?.name || "—"}</div>
        </div>
        <div className="rounded-lg bg-muted/20 p-2 md:col-span-2">
          <div className="text-[9px] text-muted-foreground">启动命令（.env 配置 BYOA_AGENT_COMMAND / BYOA_AGENT_ARGS）</div>
          <div className="truncate font-mono text-[11px]">{status?.command || "—"}</div>
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void act("start", "启动")} disabled={!!busy || status?.running}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
          {busy === "start" ? "启动中…" : "启动 Agent"}
        </button>
        <button type="button" onClick={() => void act("stop", "停止")} disabled={!!busy || !status?.running}
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-[11px] font-medium text-red-700 hover:bg-red-100 disabled:opacity-40">
          {busy === "stop" ? "停止中…" : "停止 Agent"}
        </button>
        <button type="button" onClick={() => void act("test", "连接测试")} disabled={!!busy}
          className="rounded-lg border px-3 py-1.5 text-[11px] hover:bg-accent disabled:opacity-40">
          {busy === "test" ? "测试中…" : "测试连接"}
        </button>
        <span className="text-[9px] text-muted-foreground">配置/卸载：编辑 .env 的 BYOA_* 变量后重启服务</span>
      </div>
      {notice && (
        <div className={`mb-3 rounded border px-2 py-1 text-[10px] ${notice.type === "ok" ? "border-green-200 bg-green-50 text-green-700" : "border-red-200 bg-red-50 text-red-700"}`}>
          {notice.text}
        </div>
      )}
      <div className="rounded-lg border bg-muted/10 p-3">
        <div className="mb-1.5 text-[10px] font-medium text-muted-foreground">委派任务（写入/检索/整理工作流）</div>
        <div className="flex gap-2">
          <input value={taskInput} onChange={(e) => setTaskInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void runTask()}
            placeholder="如：把这篇论文的要点整理成双链笔记"
            className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-[11px] outline-none" />
          <button type="button" onClick={() => void runTask()} disabled={!!busy || !taskInput.trim() || !status?.running}
            className="rounded-lg bg-blue-600 px-3 py-2 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-40">
            {busy === "run" ? "执行中…" : "执行"}
          </button>
        </div>
        {taskResult && (
          <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-background/60 p-2 text-[10px] leading-relaxed">{taskResult}</pre>
        )}
      </div>
    </div>
  );
}
