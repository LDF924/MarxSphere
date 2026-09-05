// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// MetaSkillPanel.tsx — V404-4: MetaSkill 声明式 DAG 试点(最小 UI)
// 借鉴 OpenSquilla meta-skills: 声明式步骤 DAG, 前端触发运行 + 逐步显示 + user_input 表单
// 步骤: 选技能 → 输入主题 → 运行(步骤徽章实时亮) → 澄清表单(waiting_input) → 结果
import { useCallback, useEffect, useRef, useState } from "react";

interface StepLite { id: string; kind: string; label?: string }
interface SkillLite { id: string; name: string; description: string; steps: StepLite[] }
interface StepRunLite {
  stepId: string; kind: string; label?: string;
  status: "pending" | "running" | "done" | "failed" | "waiting_input";
  output?: string; error?: string;
  waitingFields?: Array<{ name: string; prompt: string; required: boolean }>;
}
interface Snapshot { status: string; stepLog: StepRunLite[] }

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-500/20 text-blue-300 border border-blue-500/40",
  done: "bg-green-500/15 text-green-300",
  failed: "bg-red-500/20 text-red-300",
  waiting_input: "bg-amber-400/20 text-amber-200 border border-amber-400/50 animate-pulse",
};
const KIND_LABEL: Record<string, string> = {
  user_input: "收集输入", agent: "检索/Agent", llm_chat: "LLM 生成", llm_classify: "分类",
  llm_gate: "质量门", tool_call: "工具调用",
};

export function MetaSkillPanel() {
  const [skills, setSkills] = useState<SkillLite[]>([]);
  const [skillId, setSkillId] = useState("");
  const [topic, setTopic] = useState("");
  const [runId, setRunId] = useState("");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [finalOutput, setFinalOutput] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // V404-10: DAG 提案(技能组 → LLM 编排 → 隔离区人工审 → 注册动态可跑)
  const [proposeTopic, setProposeTopic] = useState("");
  const [proposeMsg, setProposeMsg] = useState("");
  const [proposeBusy, setProposeBusy] = useState(false);
  const [proposals, setProposals] = useState<Array<{ id: string; dag: { id: string; name: string; description: string; steps: Array<{ kind: string; label?: string }> }; status: string; createdAt: string }>>([]);
  const [showProposals, setShowProposals] = useState(false);

  const loadProposals = useCallback(async () => {
    const j = await fetch("/api/meta-skill/proposals").then((r) => r.json()).catch(() => ({ proposals: [] }));
    setProposals(j.proposals || []);
  }, []);

  const doProposeDag = async () => {
    if (!proposeTopic.trim()) return;
    setProposeBusy(true); setProposeMsg("LLM 编排技能组为 DAG…");
    try {
      const r = await fetch("/api/meta-skill/propose-dag", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: proposeTopic, seenCount: 1 }),
      }).then((res) => res.json());
      if (!r.ok) { setProposeMsg(`❌ ${r?.error || "提案失败"}`); return; }
      setProposeMsg(`✅ 提案生成: ${r.proposal.dag.name}(${r.proposal.dag.steps.length} 步) — 在下方审阅区处理`);
      setProposeTopic("");
      await loadProposals();
    } catch (e: any) { setProposeMsg(`❌ ${e?.message || "提案失败"}`); }
    finally { setProposeBusy(false); }
  };

  const actProposal = async (id: string, path: string) => {
    setProposeBusy(true);
    try {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).then((res) => res.json());
      if (!r.ok) { setProposeMsg(`❌ ${r?.error || "操作失败"}`); return; }
      setProposeMsg(`✅ 已处理提案(注册为动态 DAG: ${r.dagId || "reject"})`);
      await loadProposals();
      // 刷新可用技能列表(accept 后新 DAG 立即可跑)
      const j = await fetch("/api/meta-skill/list").then((res) => res.json()).catch(() => ({ skills: [] }));
      setSkills(j.skills || []);
    } catch (e: any) { setProposeMsg(`❌ ${e?.message || "操作失败"}`); }
    finally { setProposeBusy(false); }
  };

  useEffect(() => {
    fetch("/api/meta-skill/list").then((r) => r.json()).then((j) => {
      setSkills(j.skills || []);
      if (j.skills?.length) setSkillId(j.skills[0].id);
    }).catch(() => {});
    void loadProposals();
  }, [loadProposals]);

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const poll = useCallback(async (id: string) => {
    const j = await fetch(`/api/meta-skill/progress?runId=${id}`).then((r) => r.json());
    if (!j.ok) { // 运行结束已清理 → 停轮询
      stopPoll();
      setBusy(false);
      return;
    }
    setSnap({ status: j.status, stepLog: j.stepLog || [] });
    if (j.status === "done" || j.status === "failed") {
      stopPoll();
      setBusy(false);
      // 终态时从最后 done 步骤拼结果(简单取最后有输出的)
      const last = [...(j.stepLog || [])].reverse().find((s: any) => s.output);
      setFinalOutput(last?.output || "（无输出）");
    }
  }, [stopPoll]);

  const run = async () => {
    if (!skillId) return;
    setBusy(true); setSnap(null); setFinalOutput("");
    const r = await fetch("/api/meta-skill/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId, input: topic }),
    }).then((res) => res.json());
    if (!r.runId) { setBusy(false); setFinalOutput(r.error || "启动失败"); return; }
    setRunId(r.runId);
    pollRef.current = setInterval(() => poll(r.runId), 1500);
  };

  const submitForm = async () => {
    await fetch("/api/meta-skill/input", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, values: form }),
    }).then((r) => r.json());
    setForm({});
  };

  const waiting = snap?.stepLog.find((s) => s.status === "waiting_input");
  const stepCount = skills.find((s) => s.id === skillId)?.steps.length || 0;
  const doneCount = snap ? snap.stepLog.filter((s) => s.status === "done").length : 0;

  // V404-32: 演示运行 — 假步骤逐段推进(展示进度徽章/澄清表单/产出 UI, 零 LLM 成本)
  const playDemo = () => {
    if (!skills.length) return;
    stopPoll();
    setBusy(true); setSnap(null); setFinalOutput("");
    setRunId("demo-run");
    const def = skills[0];
    const stepLog: StepRunLite[] = def.steps.map((st, i) => ({ stepId: st.id, kind: st.kind, label: st.label, status: "pending" }));
    const stepIdx = { i: 0 };
    setSnap({ status: "running", stepLog });
    const timers: ReturnType<typeof setTimeout>[] = [];
    const advance = () => {
      const idx = stepIdx.i;
      if (idx >= stepLog.length) {
        setBusy(false);
        setFinalOutput("【演示产出】这是一段示例文献综述。\n## 一、研究缘起\n关于该主题的学术讨论源于……(演示文本, 实际运行会生成真实综述)\n## 二、发展脉络\n……");
        setSnap((prev) => (prev ? { ...prev, status: "done" } : prev));
        return;
      }
      const step = stepLog[idx];
      const isUserInput = step.kind === "user_input";
      if (isUserInput) {
        step.status = "waiting_input";
        step.waitingFields = [{ name: "topic", prompt: "综述主题", required: true }];
      } else {
        step.status = "running";
      }
      setSnap({ status: "running", stepLog: [...stepLog] });
      timers.push(setTimeout(() => {
        if (step.kind === "user_input") {
          // 模拟用户填表后自动继续
          step.status = "done";
          step.output = "topic: 演示主题";
          step.waitingFields = undefined;
          stepIdx.i++;
          setSnap({ status: "running", stepLog: [...stepLog] });
          timers.push(setTimeout(advance, 900));
        } else {
          step.status = "done";
          step.output = `【${step.kind} 演示输出】示例内容 ${step.kind === "llm_gate" ? "{\"pass\":true,\"reason\":\"引用检查通过\"}" : step.kind === "llm_chat" ? "这是演示生成的综述草稿……(真实运行会调用 LLM)" : "检索到示例文献 8 篇……"}`;
          stepIdx.i++;
          timers.push(setTimeout(advance, 900));
        }
      }, isUserInput ? 400 : 700));
    };
    advance();
  };

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border border-border/60 bg-card p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[13px] font-semibold text-foreground">MetaSkill · 声明式步骤 DAG 工作流</div>
          <span className="flex items-center gap-1.5">
            <button type="button" onClick={() => playDemo()} disabled={busy || skills.length === 0}
              className="rounded border border-amber-400/40 px-2 py-0.5 text-[10px] text-amber-300 hover:bg-amber-400/10 disabled:opacity-40">
              🎬 演示运行(零成本)
            </button>
            <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-300">运行时强制编排</span>
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={skillId} onChange={(e) => setSkillId(e.target.value)}
            className="h-8 rounded-md border border-border/60 bg-background px-2 text-[12px] text-foreground"
          >
            {skills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input
            value={topic} onChange={(e) => setTopic(e.target.value)}
            placeholder="综述主题(研究问题, 如: 资本下乡对村级治理的影响)"
            className="h-8 min-w-[280px] flex-1 rounded-md border border-border/60 bg-background px-2 text-[12px]"
          />
          <button
            onClick={run} disabled={busy || !topic.trim()}
            className="rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground disabled:opacity-40"
          >{busy ? "运行中…" : "▶ 运行 DAG"}</button>
        </div>
        {skills.find((s) => s.id === skillId) && (
          <p className="mt-2 text-[11px] text-muted-foreground">{skills.find((s) => s.id === skillId)?.description}</p>
        )}
        {runId && <div className="mt-1 text-[10px] text-muted-foreground">runId: {runId} · {doneCount}/{stepCount} 步完成</div>}
      </div>

      {/* 步骤进度条(逐步显示) */}
      {snap && snap.stepLog.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-card p-3">
          <div className="mb-2 text-[11px] font-semibold text-muted-foreground">执行进度(拓扑序, 由运行时强制)</div>
          <div className="space-y-1.5">
            {snap.stepLog.map((s) => (
              <div key={s.stepId} className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${STATUS_STYLE[s.status]}`}>
                <span className="w-24 shrink-0 text-[11px] font-medium">{s.label || s.stepId}</span>
                <span className="w-16 shrink-0 text-[10px] opacity-80">{KIND_LABEL[s.kind] || s.kind}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] opacity-90">
                  {s.status === "done" ? `✓ ${(s.output || "").slice(0, 90)}` : ""}
                  {s.status === "failed" ? `✗ ${(s.error || "").slice(0, 150)}` : ""}
                  {s.status === "running" ? "执行中…" : ""}
                  {s.status === "pending" ? "等待" : ""}
                  {s.status === "waiting_input" ? "等待用户输入 ↓" : ""}
                </span>
                {s.kind === "llm_gate" && s.status === "done" && <span className="shrink-0 text-[10px] opacity-70">门✓</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* user_input 澄清表单 */}
      {waiting && (
        <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 p-3">
          <div className="mb-2 text-[12px] font-medium text-amber-200">📋 澄清步骤({waiting.label || waiting.stepId}): 提交后自动继续 DAG</div>
          <div className="space-y-2">
            {(waiting.waitingFields || []).map((f) => (
              <div key={f.name}>
                <label className="mb-0.5 block text-[11px] text-muted-foreground">{f.prompt}{f.required && <span className="text-red-400"> *</span>}</label>
                <input
                  value={form[f.name] || ""} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
                  className="h-8 w-full rounded-md border border-border/60 bg-background px-2 text-[12px]"
                />
              </div>
            ))}
          </div>
          <button
            onClick={submitForm} disabled={!waiting.waitingFields?.every((f) => !f.required || (form[f.name] || "").trim())}
            className="mt-2 rounded-md bg-amber-500/90 px-3 py-1 text-[12px] font-medium text-amber-950 disabled:opacity-40"
          >提交并继续</button>
        </div>
      )}

      {/* 最终结果 */}
      {finalOutput && (
        <div className="rounded-lg border border-border/60 bg-card p-3">
          <div className="mb-1 text-[11px] font-semibold text-muted-foreground">最终产出({finalOutput.length} 字)</div>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-foreground">{finalOutput}</pre>
        </div>
      )}

      {/* V404-10: DAG 提案区(技能组 → LLM 编排 → 人工审 → 注册可跑) */}
      <div className="rounded-lg border border-fuchsia-400/20 bg-fuchsia-400/[0.04] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-semibold text-fuchsia-300">MetaSkill 提案(auto_propose→DAG)</span>
          <span className="text-[9px] text-muted-foreground/60">approved 技能组 → LLM 编排声明式 DAG → 人工审 → 注册为动态工作流(可在上方运行)</span>
          <button type="button" onClick={() => { setShowProposals((v) => !v); if (!showProposals) void loadProposals(); }}
            className="ml-auto rounded border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/40">
            审阅区({proposals.filter((p) => p.status === "proposed").length})
          </button>
        </div>
        <div className="mt-2 flex gap-2">
          <input
            value={proposeTopic} onChange={(e) => setProposeTopic(e.target.value)}
            placeholder="高频任务主题(如: 马理论选题与接口分析)"
            className="h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 text-[11px]"
          />
          <button type="button" onClick={() => void doProposeDag()} disabled={proposeBusy || !proposeTopic.trim()}
            className="rounded-md bg-fuchsia-600 px-3 text-[11px] font-medium text-white hover:bg-fuchsia-500 disabled:opacity-40">
            {proposeBusy ? "编排中…" : "✦ 生成 DAG 提案"}
          </button>
        </div>
        {proposeMsg && <div className="mt-1 text-[10px] text-fuchsia-200/80">{proposeMsg}</div>}
        {showProposals && (
          <div className="mt-2 space-y-1.5">
            {proposals.length === 0 && <p className="text-[10px] text-muted-foreground">暂无提案 — 输入主题生成第一条</p>}
            {proposals.map((p) => (
              <div key={p.id} className={`rounded-md border px-2 py-1.5 text-[11px] ${p.status === "proposed" ? "border-amber-400/30 bg-amber-400/5" : "border-border/40 opacity-70"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[9px] ${p.status === "proposed" ? "bg-amber-400/15 text-amber-200" : p.status === "accepted" ? "bg-emerald-400/15 text-emerald-300" : "bg-red-400/15 text-red-300"}`}>
                    {p.status === "proposed" ? "待审" : p.status}
                  </span>
                  <span className="font-medium text-foreground">{p.dag.name}</span>
                  <span className="text-[9px] text-muted-foreground/60">{p.dag.description?.slice(0, 50)}</span>
                  <span className="text-[9px] text-muted-foreground/50">{p.dag.steps.length} 步 · {p.createdAt?.slice(0, 10)}</span>
                  {p.status === "proposed" && (
                    <span className="ml-auto flex gap-1">
                      <button type="button" onClick={() => void actProposal(p.id, "/api/meta-skill/proposals/accept")} disabled={proposeBusy}
                        className="rounded bg-emerald-600 px-2 py-0.5 text-[10px] text-white hover:bg-emerald-500 disabled:opacity-40">✓ 注册并启用</button>
                      <button type="button" onClick={() => void actProposal(p.id, "/api/meta-skill/proposals/reject")} disabled={proposeBusy}
                        className="rounded border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-red-300 disabled:opacity-40">✗ 驳回</button>
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[9px] text-muted-foreground/60">步骤: {p.dag.steps.map((s, i) => `${i + 1}.${s.kind}${s.label ? `(${s.label})` : ""}`).join(" → ")}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
