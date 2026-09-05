// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// DreamPanel.tsx — V404-7: 记忆 Dream 巩固审计面板(借鉴 OpenSquilla memory/dream)
// 人工可审提升流: 扫描候选(证据门控) → 评分列表 → accept 写战略记忆(回执) / reject 进隔离区 / rollback 回滚
import { useCallback, useEffect, useState } from "react";
import { Brain, CheckCircle2, ChevronDown, ChevronRight, Loader2, RefreshCw, RotateCcw, ShieldAlert, Sparkles, XCircle } from "lucide-react";

interface ProposalEvidence {
  id: string;
  query: string;
  qualityScore?: number | null;
  success?: boolean;
  strategySummary?: string;
}

interface Proposal {
  id: string;
  key: string;
  goal: string;
  seenCount: number;
  positiveSignals: number;
  negativeSignals: number;
  spanDays: number;
  score: number;
  polished: string;
  kind: string;
  status: "proposed" | "accepted" | "rejected";
  createdAt: string;
  receipt?: string;
  /** V405-ML(P2-Dream evidence): 支撑记录明细(可审计 — 该记忆由哪几次任务/质量/策略支撑) */
  evidence?: ProposalEvidence[];
}

const KIND_COLOR: Record<string, string> = {
  goal: "text-blue-300 bg-blue-400/10",
  decision: "text-purple-300 bg-purple-400/10",
  constraint: "text-amber-300 bg-amber-400/10",
  milestone: "text-emerald-300 bg-emerald-400/10",
  preference: "text-pink-300 bg-pink-400/10",
};

// V404-32: 演示数据
function demoProposal(over: Partial<Proposal> & { id: string }): Proposal {
  return {
    key: "x", goal: "示例目标", seenCount: 5, positiveSignals: 1, negativeSignals: 0,
    spanDays: 4, score: 0.72, polished: "示例打磨条目", kind: "goal", status: "proposed",
    createdAt: new Date().toISOString(), ...over,
  };
}
const DEMO_PROPOSALS: Proposal[] = [
  demoProposal({ id: "dp-demo-1", key: "综述", goal: "根据论文生成文献综述", seenCount: 22, spanDays: 21, positiveSignals: 2, score: 0.82, polished: "反复成功完成「论文文献综述生成」22 次/跨 21 天(用户正评 2 次); 建议沉淀为可复用综述流程模板。" }),
  demoProposal({ id: "dp-demo-2", key: "选题", goal: "理论接口选题法", seenCount: 14, spanDays: 12, positiveSignals: 1, score: 0.71, polished: "「理论接口选题」高频任务(14 次/跨 12 天) — 建议沉淀为选题方法模板。" }),
  demoProposal({ id: "dp-demo-3", key: "问答", goal: "论文深度问答", seenCount: 9, spanDays: 6, score: 0.58, polished: "「论文深度问答」重复任务(9 次/6 天) — 考虑固化为带引用验证的问答流程。" }),
];
const DEMO_QUARANTINE: Proposal[] = [demoProposal({ id: "dp-demo-q", key: "低分", goal: "单次成功未重复任务", seenCount: 1, spanDays: 1, score: 0.31, status: "rejected", createdAt: new Date(Date.now() - 86400000 * 2).toISOString() })];
const DEMO_RECEIPTS = [
  { event: "accept", proposalId: "dp-demo-old1", ts: new Date(Date.now() - 86400000).toISOString() },
  { event: "rollback", proposalId: "dp-demo-old2", ts: new Date(Date.now() - 86400000 * 3).toISOString() },
];

export function DreamPanel() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [quarantine, setQuarantine] = useState<Proposal[]>([]);
  const [receipts, setReceipts] = useState<Array<{ event: string; proposalId: string; ts?: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [useLlm, setUseLlm] = useState(false);
  const [msg, setMsg] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showQ, setShowQ] = useState(false);
  const [demoOn, setDemoOn] = useState(false);

  const load = useCallback(async () => {
    if (demoOn) {
      setProposals(DEMO_PROPOSALS);
      setQuarantine(DEMO_QUARANTINE);
      setReceipts(DEMO_RECEIPTS);
      setMsg("🎬 演示模式: 显示示例候选(真实模式: 点「扫描并生成候选」从 30 天任务挖掘)");
      return;
    }
    const j = await fetch("/api/memory/dream/state").then((r) => r.json());
    setProposals(j.proposals || []);
    setQuarantine(j.quarantine || []);
    setReceipts(j.receipts || []);
  }, [demoOn]);

  useEffect(() => { void load(); }, [load]);

  const run = async () => {
    setBusy(true); setMsg("扫描 task_experience(30 天)…");
    try {
      const j = await fetch("/api/memory/dream/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useLlm, days: 30 }),
      }).then((r) => r.json());
      setMsg(j.ok ? `✅ 巩固完成: 新增 ${j.count} 条候选(证据门控: ≥2次+跨天, 负评自动拦)` : `⚠️ ${j?.error?.message || "失败"}`);
      await load();
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  const act = async (path: string, id: string, extra = {}) => {
    setBusy(true);
    try {
      const j = await fetch(path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...extra }),
      }).then((r) => r.json());
      setMsg(j.ok ? (j.receipt ? `✅ ${j.receipt}` : "✅ 已处理") : `⚠️ ${j?.error || "失败"}`);
      await load();
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  const active = proposals.filter((p) => p.status === "proposed");
  const doneList = proposals.filter((p) => p.status !== "proposed");

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border border-purple-400/20 bg-purple-400/[0.04] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Brain className="h-4 w-4 text-purple-300" />
          <span className="text-[13px] font-semibold text-foreground">记忆 Dream 巩固</span>
          <span className="rounded bg-purple-400/10 px-1.5 py-0.5 text-[9px] text-purple-300">证据门控 · 人工可审 · 回滚可审计</span>
          <span className="ml-auto flex gap-1 text-[10px] text-muted-foreground/70">
            <span className="rounded bg-amber-400/10 px-1 py-0.5 text-amber-300">待审 {active.length}</span>
            <span className="rounded bg-emerald-400/10 px-1 py-0.5 text-emerald-300">已提升 {doneList.filter((p) => p.status === "accepted").length}</span>
          </span>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          回合捕获: 反复成功完成的任务(≥2 次/跨天)自动成候选 — 频率+信号+跨天加权评分。
          人工审阅后提升为战略记忆(注入未来会话); 错误可回滚。与纯向量灌入不同: 每条可审计、可纠正。
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={run} disabled={busy}
            className="inline-flex items-center gap-1 rounded-md bg-purple-500 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-purple-400 disabled:opacity-40">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            扫描并生成候选
          </button>
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} className="h-3 w-3" />
            LLM 打磨(否则确定性摘要)
          </label>
          <button type="button" onClick={() => { setDemoOn((v) => !v); }} className="rounded-md border border-amber-400/40 px-2 py-1 text-[10px] text-amber-300 hover:bg-amber-400/10">
            {demoOn ? "退出演示" : "🎬 演示数据"}
          </button>
          <button type="button" onClick={() => void load()} className="rounded-md px-2 py-1 text-[10px] text-muted-foreground/60 hover:text-foreground">
            <RefreshCw className="h-3 w-3" />
          </button>
          <button type="button" onClick={() => setShowQ((v) => !v)} className="text-[10px] text-muted-foreground/60 hover:text-foreground">
            隔离区 {quarantine.length}
          </button>
          {msg && <span className="text-[10px] text-muted-foreground">{msg}</span>}
        </div>
      </div>

      {/* 隔离区 */}
      {showQ && (
        <div className="rounded-lg border border-border/60 bg-card p-3">
          <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-amber-300">
            <ShieldAlert className="h-3 w-3" /> 隔离区(被驳回/疑似噪音 — 可审计不删除)
          </div>
          {quarantine.length === 0
            ? <p className="text-[11px] text-muted-foreground">暂无隔离记录</p>
            : <div className="space-y-1">{quarantine.map((q) => (
              <div key={q.id} className="rounded border border-border/40 px-2 py-1 text-[10px] text-muted-foreground">
                {q.polished || q.goal} <span className="opacity-60">({q.createdAt?.slice(0, 10)})</span>
              </div>
            ))}</div>}
        </div>
      )}

      {/* 待审候选 */}
      <div className="rounded-lg border border-border/60 bg-card p-3">
        <div className="mb-2 text-[11px] font-semibold text-muted-foreground">待审候选(证据: 出现次数/跨天/信号 → 评分)</div>
        {active.length === 0 && <p className="text-[11px] text-muted-foreground">暂无候选 — 点「扫描并生成候选」从最近 30 天成功任务中挖掘</p>}
        <div className="space-y-1.5">
          {active.map((p) => (
            <div key={p.id} className="rounded-md border border-border/40 bg-background/30 px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[9px] ${KIND_COLOR[p.kind] || "text-muted-foreground bg-muted"}`}>{p.kind}</span>
                <span className="min-w-0 flex-1 text-[11px] text-foreground">{p.polished}</span>
                <span className="rounded bg-purple-400/10 px-1.5 py-0.5 text-[10px] text-purple-300">{(p.score * 100).toFixed(0)}分</span>
                <span className="text-[9px] text-muted-foreground/60">{p.seenCount}次/跨{p.spanDays}天{p.positiveSignals > 0 ? `/👍${p.positiveSignals}` : ""}</span>
                <button type="button" onClick={() => act("/api/memory/dream/accept", p.id)}
                  className="inline-flex items-center gap-0.5 rounded bg-emerald-500 px-2 py-0.5 text-[10px] text-white hover:bg-emerald-400 disabled:opacity-40" disabled={busy}>
                  <CheckCircle2 className="h-3 w-3" /> 提升为战略记忆
                </button>
                <button type="button" onClick={() => act("/api/memory/dream/reject", p.id)}
                  className="inline-flex items-center gap-0.5 rounded border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-red-300 disabled:opacity-40" disabled={busy}>
                  <XCircle className="h-3 w-3" /> 驳回
                </button>
                <button type="button" onClick={() => setExpanded(expanded === p.id ? null : p.id)} className="text-muted-foreground/50">
                  {expanded === p.id ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </button>
              </div>
              {expanded === p.id && (
                <div className="mt-1.5 space-y-0.5 border-t border-border/30 pt-1.5 text-[10px] text-muted-foreground">
                  <div>目标: {p.goal}</div>
                  <div>归一键: {p.key} · 评分构成: 频率(×0.35)+跨天(×0.35)+正评信号(×0.3, 负评=0)</div>
                  {/* V405-ML(P2-Dream evidence): 支撑记录明细 — 审计可追溯 */}
                  {p.evidence && p.evidence.length > 0 && (
                    <div className="mt-1">
                      <div className="text-[9px] uppercase tracking-wide text-muted-foreground/50">支撑证据({p.evidence.length})</div>
                      <div className="mt-0.5 max-h-32 space-y-0.5 overflow-y-auto">
                        {p.evidence.map((e) => (
                          <div key={e.id} className="rounded bg-muted/30 px-1.5 py-0.5 font-mono text-[9px]">
                            #{e.id.slice(-6)} 「{e.query}」 q={e.qualityScore ?? "-"} {e.success === false ? "失败" : "成功"}{e.strategySummary ? ` [${e.strategySummary}]` : ""}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 已提升(可回滚) + 回执 */}
      {doneList.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-card p-3">
          <div className="mb-2 text-[11px] font-semibold text-muted-foreground">已处理(回执可审计, 提升可回滚)</div>
          <div className="space-y-1">
            {doneList.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-2 rounded border border-border/40 px-2 py-1.5 text-[10px]">
                <span className={`rounded px-1 py-0.5 ${p.status === "accepted" ? "bg-emerald-400/10 text-emerald-300" : "bg-red-400/10 text-red-300"}`}>
                  {p.status === "accepted" ? "已提升" : "已驳回"}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{p.polished}</span>
                {p.receipt && <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">{p.receipt}</span>}
                {p.status === "accepted" && (
                  <button type="button" onClick={() => act("/api/memory/dream/rollback", p.id)}
                    className="inline-flex items-center gap-0.5 rounded border border-border/60 px-1.5 py-0.5 text-muted-foreground hover:text-amber-300 disabled:opacity-40" disabled={busy}>
                    <RotateCcw className="h-2.5 w-2.5" /> 回滚
                  </button>
                )}
              </div>
            ))}
          </div>
          {receipts.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[10px] text-muted-foreground/60">回执流水({receipts.length})</summary>
              <div className="mt-1 max-h-28 space-y-0.5 overflow-y-auto font-mono text-[9px] text-muted-foreground/50">
                {receipts.map((r, i) => <div key={i}>{r.event} · {r.proposalId} · {r.ts?.slice(0, 19)}</div>)}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
