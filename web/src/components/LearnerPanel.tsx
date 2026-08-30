// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// LearnerPanel.tsx — 学习者画像面板（2026-08-29, Inno Agent 学习引擎前端）
// 覆盖: 学习目标管理 / 掌握度状态机可视化(六态+遗忘曲线) / 误解诊断 /
//       前置知识诊断(教学入口门+回复协议) / 到期复习 / wiki 巡检 / 上下文包预览
import { useEffect, useState } from "react";
import { Target, Brain, AlertTriangle, GitBranch, RefreshCw, Loader2, Plus, CheckCircle2, X, Search, NotebookPen, Sparkles, CalendarClock } from "lucide-react";

interface Goal { id: string; title: string; type: string; priority: number; status: string; success_criteria: string[] }
interface Misconception { id: string; topic: string; description: string; evidence: string[]; status: string }

const STATE_COLORS: Record<string, string> = {
  stable: "bg-green-500/15 text-green-700 border-green-500/30",
  fragile: "bg-blue-500/15 text-blue-700 border-blue-500/30",
  learning: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  review_due: "bg-orange-500/15 text-orange-700 border-orange-500/30",
  misconception: "bg-red-500/15 text-red-700 border-red-500/30",
  unknown: "bg-muted/40 text-muted-foreground border-border/40",
};

export function LearnerPanel() {
  const [tab, setTab] = useState<"overview" | "goals" | "misconceptions" | "gate" | "wiki">("overview");
  const [notice, setNotice] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 目标
  const [goals, setGoals] = useState<Goal[]>([]);
  const [newGoalTitle, setNewGoalTitle] = useState("");
  const [newGoalType, setNewGoalType] = useState("knowledge");
  const [newGoalPriority, setNewGoalPriority] = useState("0.8");

  // 误解
  const [misconceptions, setMisconceptions] = useState<Misconception[]>([]);
  const [newMisTopic, setNewMisTopic] = useState("");
  const [newMisDesc, setNewMisDesc] = useState("");

  // 前置诊断(默认值: 无需输入即可体验, 用户可改)
  const [gateTarget, setGateTarget] = useState("剩余价值");
  const [gatePre, setGatePre] = useState("商品二因素");
  const [gateResult, setGateResult] = useState("");

  // 画像快照(自动画像)
  const [profile, setProfile] = useState<any>(null);

  // wiki 巡检
  const [wikiIssues, setWikiIssues] = useState<any[]>([]);
  const [wikiStats, setWikiStats] = useState<any>(null);
  // 知识图谱统计(2026-08-29, Inno Agent L2 wiki-graph)
  const [graphStats, setGraphStats] = useState<any>(null);
  // 上下文包(2026-08-29, Inno Agent context-pack 服务)
  const [contextPack, setContextPack] = useState<string | null>(null);

  const loadGraphStats = async () => {
    const r = await fetch("/api/notes/wiki/graph").then((x) => x.json()).catch(() => null);
    if (r?.ok) setGraphStats(r.stats);
  };

  const loadContextPack = async () => {
    const r = await fetch("/api/education/learner/context-pack").then((x) => x.json()).catch(() => null);
    if (r?.ok) setContextPack(r.formatted);
  };

  const loadAll = async () => {
    const [g, m, snap] = await Promise.all([
      fetch("/api/education/learner/goals").then((r) => r.json()).catch(() => ({ goals: [] })),
      fetch("/api/education/learner/misconceptions").then((r) => r.json()).catch(() => ({ misconceptions: [] })),
      fetch("/api/education/learner/events").then((r) => r.json()).catch(() => ({ profile: null })),
    ]);
    setGoals(g.goals || []);
    setMisconceptions(m.misconceptions || []);
    setProfile(snap.profile);
  };
  useEffect(() => { void loadAll(); }, []);

  const rebuildProfile = async () => {
    setBusy(true);
    const r = await fetch("/api/education/learner/rebuild", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((x) => x.json()).catch(() => null);
    setBusy(false);
    r?.ok ? tell("ok", `已从 ${r.events} 个事件重建画像(${r.applied} 项变更)`) : tell("err", "重建失败");
    void loadAll();
  };

  const tell = (t: "ok" | "err", text: string) => setNotice({ type: t, text: text.slice(0, 150) });

  const addGoal = async () => {
    if (!newGoalTitle.trim()) return;
    setBusy(true);
    const r = await fetch("/api/education/learner/goals", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newGoalTitle.trim(), type: newGoalType, priority: Number(newGoalPriority) || 0.5 }) }).then((x) => x.json());
    setBusy(false);
    r?.ok ? (tell("ok", `目标「${newGoalTitle}」已创建`), setNewGoalTitle(""), void loadAll()) : tell("err", r?.error || "创建失败");
  };

  const archiveGoal = async (id: string) => {
    await fetch(`/api/education/learner/goals/${id}/archive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    void loadAll();
  };

  const addMisconception = async () => {
    if (!newMisTopic.trim() || !newMisDesc.trim()) return;
    setBusy(true);
    const r = await fetch("/api/education/learner/misconceptions", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: newMisTopic.trim(), description: newMisDesc.trim(), evidence: ["手动记录"] }) }).then((x) => x.json());
    setBusy(false);
    r?.ok ? (tell("ok", "误解已记录"), setNewMisTopic(""), setNewMisDesc(""), void loadAll()) : tell("err", r?.error || "记录失败");
  };

  const resolveMis = async (id: string) => {
    await fetch(`/api/education/learner/misconceptions/${id}/resolve`, { method: "POST" });
    void loadAll();
  };

  const runGate = async () => {
    if (!gateTarget.trim()) return;
    setBusy(true);
    try {
      // 前置解析: 用当前画像知识状态
      const knowledge = (profile?.knowledge || []).map((k: any) => ({ conceptId: k.conceptId, mastery: k.mastery, confidence: k.confidence ?? 0.1, stabilityDays: k.stabilityDays ?? 0.25, lastSuccessfulRetrievalAt: k.lastSuccessfulRetrievalAt, lastResult: k.lastResult, retrievalCount: (k.evidenceIds || []).length > 0 ? 1 : 0, lapseCount: k.lastResult === "incorrect" ? 1 : 0, successfulTransferCount: 0, evidenceIds: k.evidenceIds || [], stateLabel: k.stateLabel || "unknown", retrievability: 0.5, nextActions: k.nextActions || [] }));
      const r = await fetch("/api/education/learner/gate", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetConceptId: gateTarget, prerequisiteConceptId: gatePre, states: knowledge }) }).then((x) => x.json());
      if (r?.ok) setGateResult(r.protocol || r.reason || "");
      else tell("err", r?.error || "诊断失败");
    } catch (e: any) { tell("err", String(e?.message || e).slice(0, 100)); }
    setBusy(false);
  };

  const auditWiki = async () => {
    setBusy(true);
    const r = await fetch("/api/notes/audit").then((x) => x.json()).catch(() => null);
    setBusy(false);
    if (r?.ok) { setWikiIssues(r.issues || []); setWikiStats(r.stats); tell("ok", `巡检完成: 破损 ${r.stats?.broken_links || 0} · 孤立 ${r.stats?.orphans || 0} · 过期 ${r.stats?.stale || 0}`); }
    else tell("err", "巡检失败");
  };

  const fixWiki = async () => {
    setBusy(true);
    const r = await fetch("/api/notes/audit/fix", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ createAll: true }) }).then((x) => x.json());
    setBusy(false);
    r?.ok ? (tell("ok", `已创建 ${r.created?.length || 0} 个缺失笔记`), void auditWiki()) : tell("err", "修复失败");
  };

  const knowledge = profile?.knowledge || [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 头部 */}
      <div className="flex items-center gap-2">
        <Brain className="h-5 w-5 text-violet-500" />
        <h2 className="text-lg font-semibold">学习者画像</h2>
        <span className="text-xs text-muted-foreground">Inno Agent 学习引擎 · 掌握度状态机 / 前置诊断 / 自动画像</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={() => void rebuildProfile()} disabled={busy}
            className="flex items-center gap-1 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-1.5 text-[11px] text-violet-700 hover:bg-violet-500/20 disabled:opacity-40" title="从事件日志重放重建画像">
            <Sparkles className="h-3 w-3" /> 重建画像
          </button>
          <button type="button" onClick={() => void loadAll()} className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-[11px] hover:bg-accent">
            <RefreshCw className="h-3 w-3" /> 刷新
          </button>
        </div>
      </div>

      {/* Tab */}
      <div className="flex flex-wrap gap-1.5">
        {([["overview", "总览", Brain], ["goals", "学习目标", Target], ["misconceptions", "误解诊断", AlertTriangle], ["gate", "前置诊断", GitBranch], ["wiki", "Wiki 巡检", NotebookPen]] as const).map(([id, label, Icon]) => (
          <button key={id} type="button" onClick={() => setTab(id)}
            className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-[11px] font-medium transition-all ${tab === id ? "bg-violet-600 text-white" : "border hover:bg-accent"}`}>
            <Icon className="h-3 w-3" /> {label}
          </button>
        ))}
      </div>
      {notice && <div className={`rounded-lg px-3 py-1.5 text-[10px] ${notice.type === "ok" ? "bg-green-500/10 text-green-700" : "bg-red-500/10 text-red-600"}`}>{notice.text}</div>}

      {/* ── 总览: 掌握度状态机 + 遗忘曲线 + 到期复习 ── */}
      {tab === "overview" && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="rounded-xl border bg-card p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium"><Sparkles className="h-3.5 w-3.5 text-violet-500" /> 掌握度状态(状态机投影)</div>
            {knowledge.length === 0 && <div className="text-[10px] text-muted-foreground">暂无学习记录 — 在教育答题或调用 learner/events 后自动生成</div>}
            {knowledge.length > 0 && (
              <div className="space-y-1.5">
                {knowledge.map((k: any, i: number) => {
                  const label = k.stateLabel || "unknown";
                  return (
                    <div key={i} className="flex items-center gap-2 rounded-lg border bg-muted/10 px-3 py-2">
                      <span className={`rounded-full border px-2 py-0.5 text-[9px] font-medium ${STATE_COLORS[label] || STATE_COLORS.unknown}`}>{label}</span>
                      <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{k.conceptId}</span>
                      <span className="text-[9px] text-muted-foreground">掌握 {((k.mastery || 0) * 100).toFixed(0)}%</span>
                      {k.retrievability != null && (
                        <div className="w-24" title={`可提取性 ${(k.retrievability * 100).toFixed(0)}%`}>
                          <div className="h-1.5 rounded bg-muted/40"><div className="h-1.5 rounded bg-violet-500" style={{ width: `${k.retrievability * 100}%` }} /></div>
                        </div>
                      )}
                      {k.reviewDueAt && <span title={`复习到期 ${k.reviewDueAt}`}><CalendarClock className="h-3 w-3 text-orange-500" /></span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {profile?.misconceptions?.length > 0 && (
            <div className="rounded-xl border bg-red-500/5 p-4">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-red-700"><AlertTriangle className="h-3.5 w-3.5" /> 活跃误解(自动画像)</div>
              {profile.misconceptions.filter((m: any) => m.status !== "resolved").map((m: any, i: number) => (
                <div key={i} className="text-[11px] text-red-800">• {m.description}</div>
              ))}
            </div>
          )}
          <div className="rounded-xl border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-medium">学习者上下文包(注入系统提示词)</div>
              <button type="button" onClick={() => void loadContextPack()} className="text-[10px] text-violet-600 hover:underline">
                {contextPack ? "刷新" : "加载"}
              </button>
            </div>
            {contextPack ? (
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/20 p-2 text-[9px] leading-relaxed text-muted-foreground">{contextPack}</pre>
            ) : (
              <div className="text-[10px] text-muted-foreground">加载后显示 context-pack 服务生成的完整上下文(状态机投影+偏好映射+复习调度)</div>
            )}
          </div>
        </div>
      )}

      {/* ── 学习目标 ── */}
      {tab === "goals" && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="rounded-xl border bg-card p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium"><Target className="h-3.5 w-3.5 text-emerald-600" /> 新建学习目标</div>
            <div className="flex flex-wrap gap-2">
              <input value={newGoalTitle} onChange={(e) => setNewGoalTitle(e.target.value)} placeholder="目标标题，如：马克思主义政治经济学"
                className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-[11px] outline-none" />
              <select value={newGoalType} onChange={(e) => setNewGoalType(e.target.value)} className="rounded-lg border bg-background px-2 py-2 text-[11px]">
                <option value="knowledge">知识</option><option value="skill">技能</option><option value="project">项目</option>
              </select>
              <select value={newGoalPriority} onChange={(e) => setNewGoalPriority(e.target.value)} className="rounded-lg border bg-background px-2 py-2 text-[11px]">
                <option value="0.9">高优先</option><option value="0.5">中优先</option><option value="0.2">低优先</option>
              </select>
              <button type="button" onClick={() => void addGoal()} disabled={busy || !newGoalTitle.trim()}
                className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
                <Plus className="h-3 w-3" /> 创建
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            {goals.map((g) => (
              <div key={g.id} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
                <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${g.status === "active" ? "bg-emerald-500/15 text-emerald-700" : "bg-muted/40 text-muted-foreground"}`}>{g.status}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{g.title}</span>
                <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[9px] text-muted-foreground">{g.type}</span>
                <span className="text-[9px] text-muted-foreground">优先 {g.priority}</span>
                {g.success_criteria?.length > 0 && <span className="text-[9px] text-muted-foreground" title={g.success_criteria.join("; ")}>🎯 {g.success_criteria.length} 标准</span>}
                {g.status === "active" && (
                  <button type="button" onClick={() => void archiveGoal(g.id)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-red-600" title="归档">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
            {goals.length === 0 && <div className="text-center text-[10px] text-muted-foreground">暂无目标 — 创建第一个学习目标</div>}
          </div>
        </div>
      )}

      {/* ── 误解诊断 ── */}
      {tab === "misconceptions" && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="rounded-xl border bg-card p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium"><AlertTriangle className="h-3.5 w-3.5 text-red-500" /> 记录误解(带证据)</div>
            <div className="flex flex-wrap gap-2">
              <input value={newMisTopic} onChange={(e) => setNewMisTopic(e.target.value)} placeholder="主题，如：剩余价值"
                className="w-32 rounded-lg border bg-background px-3 py-2 text-[11px] outline-none" />
              <input value={newMisDesc} onChange={(e) => setNewMisDesc(e.target.value)} placeholder="误解描述，如：混淆剩余价值与利润"
                className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-[11px] outline-none" />
              <button type="button" onClick={() => void addMisconception()} disabled={busy}
                className="rounded-lg bg-red-600 px-3 py-2 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-40">记录</button>
            </div>
          </div>
          <div className="space-y-1.5">
            {misconceptions.map((m) => (
              <div key={m.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${m.status === "open" ? "bg-red-500/5 border-red-500/20" : "bg-muted/10"}`}>
                <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[9px] font-medium text-red-700">{m.topic}</span>
                <span className="min-w-0 flex-1 truncate text-[11px]">{m.description}</span>
                <span className="text-[9px] text-muted-foreground">{m.evidence?.length || 0} 证据</span>
                {m.status === "open" && (
                  <button type="button" onClick={() => void resolveMis(m.id)} className="flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[9px] text-emerald-700 hover:bg-emerald-500/20" title="标记已纠正">
                    <CheckCircle2 className="h-3 w-3" /> 已纠正
                  </button>
                )}
              </div>
            ))}
            {misconceptions.length === 0 && <div className="text-center text-[10px] text-muted-foreground">暂无误解记录</div>}
          </div>
        </div>
      )}

      {/* ── 前置诊断(教学入口门) ── */}
      {tab === "gate" && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="rounded-xl border bg-card p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium"><GitBranch className="h-3.5 w-3.5 text-violet-500" /> 教学入口判断(前置知识诊断)</div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-muted-foreground">学</span>
              <input value={gateTarget} onChange={(e) => setGateTarget(e.target.value)} className="w-36 rounded-lg border bg-background px-3 py-2 text-[11px] outline-none" placeholder="目标概念" />
              <span className="text-[10px] text-muted-foreground">需要前置</span>
              <input value={gatePre} onChange={(e) => setGatePre(e.target.value)} className="w-36 rounded-lg border bg-background px-3 py-2 text-[11px] outline-none" placeholder="前置概念" />
              <button type="button" onClick={() => void runGate()} disabled={busy}
                className="flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-2 text-[11px] font-medium text-white hover:bg-violet-700 disabled:opacity-40">
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />} 诊断
              </button>
            </div>
          </div>
          {gateResult && (
            <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-3">
              <div className="mb-1 text-[9px] font-semibold text-violet-600">下一条回复协议</div>
              <pre className="whitespace-pre-wrap text-[10px] leading-relaxed text-violet-900">{gateResult}</pre>
            </div>
          )}
          {!gateResult && (
            <div className="rounded-xl border border-dashed bg-card p-6 text-center text-[10px] text-muted-foreground">
              输入目标概念与前置概念 → 诊断前置是否满足 → 生成教学动作(direct/diagnose/teach/repair)与回复协议
            </div>
          )}
        </div>
      )}

      {/* ── Wiki 巡检 ── */}
      {tab === "wiki" && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="flex items-center gap-2 rounded-xl border bg-card p-4">
            <div className="flex-1">
              <div className="text-xs font-medium"><NotebookPen className="mr-1 inline h-3.5 w-3.5 text-sky-600" /> 知识库巡检(L2 wiki 维护器)</div>
              <div className="mt-0.5 text-[9px] text-muted-foreground">
                {wikiStats
                  ? `破损链接 ${wikiStats.broken_links} · 孤立页 ${wikiStats.orphans} · 过期 ${wikiStats.stale}`
                  : "检测破损双链 / 孤立页 / 过期笔记, 可一键修复"}
              </div>
            </div>
            <button type="button" onClick={() => void auditWiki()} disabled={busy} className="rounded-lg bg-sky-600 px-3 py-2 text-[11px] font-medium text-white hover:bg-sky-700 disabled:opacity-40">
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "巡检"}
            </button>
            <button type="button" onClick={() => void fixWiki()} disabled={busy} className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-[11px] text-sky-700 hover:bg-sky-500/20 disabled:opacity-40">
              一键修复
            </button>
          </div>
          {wikiIssues.length > 0 && (
            <div className="space-y-1">
              {wikiIssues.slice(0, 30).map((iss, i) => (
                <div key={i} className="flex items-start gap-2 rounded-lg border bg-muted/10 px-3 py-1.5 text-[10px]">
                  <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-medium ${iss.kind === "broken_link" ? "bg-red-500/10 text-red-600" : iss.kind === "orphan" ? "bg-amber-500/10 text-amber-700" : "bg-muted/40 text-muted-foreground"}`}>
                    {iss.kind === "broken_link" ? "破损链接" : iss.kind === "orphan" ? "孤立页" : "过期"}
                  </span>
                  <span className="min-w-0 flex-1 text-muted-foreground">{iss.detail}</span>
                  {iss.suggestion && <span className="shrink-0 text-sky-600">{iss.suggestion}</span>}
                </div>
              ))}
            </div>
          )}
          {/* 2026-08-29: 知识图谱统计(Inno Agent L2 wiki-graph) */}
          <div className="rounded-xl border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-medium">知识图谱统计(L2 wiki-graph)</div>
              <button type="button" onClick={() => void loadGraphStats()} className="text-[10px] text-sky-600 hover:underline">
                {graphStats ? "刷新" : "加载"}
              </button>
            </div>
            {graphStats ? (
              <div className="grid grid-cols-4 gap-2 text-center">
                {[["节点", graphStats.nodes], ["边", graphStats.edges], ["孤立页", graphStats.isolated], ["中心度TOP", graphStats.topCentral?.[0]?.title?.slice(0, 6)]].map(([label, v]) => (
                  <div key={String(label)} className="rounded-lg bg-muted/10 px-2 py-2">
                    <div className="text-lg font-bold text-sky-600">{v}</div>
                    <div className="text-[9px] text-muted-foreground">{label}</div>
                  </div>
                ))}
                {graphStats.topCentral && (
                  <div className="col-span-4 mt-1 flex flex-wrap gap-1">
                    <span className="text-[9px] text-muted-foreground">核心概念:</span>
                    {graphStats.topCentral.slice(0, 5).map((c: any) => (
                      <span key={c.title} className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[9px] text-sky-700" title={`度 ${c.degree}`}>
                        {c.title.slice(0, 12)}·{c.degree}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[10px] text-muted-foreground">点击加载知识图谱统计(节点/边/孤立/中心度)</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
