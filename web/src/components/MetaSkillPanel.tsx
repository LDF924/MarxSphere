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

  useEffect(() => {
    fetch("/api/meta-skill/list").then((r) => r.json()).then((j) => {
      setSkills(j.skills || []);
      if (j.skills?.length) setSkillId(j.skills[0].id);
    }).catch(() => {});
  }, []);

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

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border border-border/60 bg-card p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[13px] font-semibold text-foreground">MetaSkill · 声明式步骤 DAG 试点(文献综述)</div>
          <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-300">OpenSquilla 借鉴 · 运行时强制编排</span>
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
    </div>
  );
}
