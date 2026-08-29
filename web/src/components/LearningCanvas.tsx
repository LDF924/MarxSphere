// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// LearningCanvas.tsx — 全屏学习画布(V392, 源码移植 TraitTutor LearningCanvas)
// 三栏布局: 路径侧栏(状态点/Lock/Check) | 组件内容("为何此步"证据同屏) | 助手面板
// 侧边栏折叠: 挂载时无条件折叠(专注), 卸载时用户手动展开的偏好胜出
// 状态推进: 逐题提交(末题 complete), 409 自愈, 依赖锁定
import { useEffect, useState, useCallback } from "react";
import { Check, ChevronRight, Circle, Lock, Loader2, X, Route } from "lucide-react";

interface CanvasComponent {
  id: string;
  title: string;
  type: string;
  concept_refs?: string[];
  evidence_refs?: string[];
  status: "pending" | "started" | "completed" | "skipped";
  reason?: string;
  modality?: "text" | "interactive" | "visual" | "video" | "audio";
  required?: boolean;
  dependencies?: string[];
}

interface PlanData {
  id: string;
  goal: string;
  subject: string;
  version: number;
  components: CanvasComponent[];
}

/** 中文"为何此步"(源码 canvas-labels.ts 照抄) */
const REASON_ZH: Record<string, string> = {
  goal_map: "先明确目标、阶段与完成标准，让后续学习有清晰方向。",
  diagnostic_check: "可选的一次性起点判断；结果不写入 BKT，也不会触发新计划。",
  concept_explanation: "结合当前知识状态补足核心概念，再进入练习。",
  worked_example: "通过分步例题把概念连接到可执行的方法。",
  visual_map: "用关系图呈现重点概念和它们之间的联系。",
  video_explanation: "用短视频动态呈现课件中的核心概念。",
  audio_explanation: "把当前课件转成来源受限的播客脚本，并由导师语音讲解。",
  guided_practice: "在提示和即时反馈下完成练习，形成可判分证据。",
  calibration_checkpoint: "将作答前的把握度与核验结果对照，选定下一次更有效的学习策略。",
  retrieval_card: "用主动回忆检验保持程度，并安排后续复习。",
  progress_checkpoint: "回看当前证据，确认下一阶段最值得投入的内容。",
  reflection_prompt: "用简短反思整理本轮学习策略，不把自评当作掌握证据。",
  transfer_challenge: "把已学知识迁移到新情境，检验能否灵活运用。",
  review_queue: "优先复习已到期或仍需支持的概念。",
};

/** 阶段标签(源码 canvas-labels.ts actionLabel) */
const STAGE_LABEL: Record<string, string> = {
  mission: "本轮任务", learn: "理解", try: "尝试", decide: "校准与下一步", remember: "今日复习",
};

/** V394: 组件内容执行器 — 按组件类型拉取真实内容(lesson/assessment/retrieval) */
function ComponentContent({ selected, onDone }: { selected: CanvasComponent; onDone: () => void }) {
  const [content, setContent] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [results, setResults] = useState<Record<number, boolean>>({});
  const [assessmentId, setAssessmentId] = useState<string>("");
  const [cardIdx, setCardIdx] = useState(0);
  const [cardRevealed, setCardRevealed] = useState(false);
  const kp = selected.concept_refs?.[0] || selected.title;

  const load = async () => {
    setLoading(true); setError(null); setAnswers({}); setResults({}); setAssessmentId("");
    try {
      const kind = selected.type;
      let path = "";
      const body: Record<string, unknown> = { subject: "通用", knowledgePoint: kp };
      if (["concept_explanation", "worked_example", "goal_map", "visual_map"].includes(kind)) {
        path = "/api/education/components/lesson"; body.kind = kind;
      } else if (["guided_practice", "transfer_challenge", "diagnostic_check"].includes(kind)) {
        path = "/api/education/components/assessment"; body.kind = kind;
      } else if (["retrieval_card", "review_queue"].includes(kind)) {
        path = "/api/education/components/retrieval";
      } else {
        setLoading(false); return;
      }
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.ok) { setError(j.error?.message || "生成失败"); setLoading(false); return; }
      if (j.assessmentId) setAssessmentId(j.assessmentId);
      setContent(j.component);
      setLoading(false);
    } catch (e: any) { setError(String(e?.message || e)); setLoading(false); }
  };
  useEffect(() => { void load(); }, [selected.id]);

  const grade = async (item: any, idx: number) => {
    try {
      // 判分走服务端(答案服务端持有, 前端无 correct_answer)
      const r = await fetch("/api/education/components/assessment/grade", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assessmentId, questionId: item.question_id, userAnswer: answers[idx] || "" }),
      });
      const j = await r.json();
      setResults((prev) => ({ ...prev, [idx]: j.correct }));
    } catch { /* 忽略 */ }
  };

  if (loading) return <div className="learning-card flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />生成学习内容…</div>;
  if (error) return <div className="learning-notice learning-notice--error">{error}</div>;
  if (!content) return null;

  // ── Lesson: 概念讲解/例题/目标地图 ──
  if (content.kind !== "assessment" && content.kind !== "retrieval_card" && !content.items) {
    return (
      <div className="learning-card text-sm leading-6">
        <h3 className="mb-2 text-base font-semibold">{content.title}</h3>
        <div className="whitespace-pre-wrap text-foreground/90">{content.content}</div>
        {(content.key_points || []).length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-xs font-semibold text-muted-foreground">要点</div>
            <ul className="space-y-1">{content.key_points.map((k: string, i: number) => <li key={i} className="text-xs text-muted-foreground">• {k}</li>)}</ul>
          </div>
        )}
        {(content.references || []).length > 0 && (
          <div className="mt-3 border-t pt-2 text-[10px] text-muted-foreground">
            <span className="font-semibold">来源:</span> {content.references.map((r: any) => r.source).join(" · ")}
          </div>
        )}
        <div className="mt-3 flex justify-end">
          <button type="button" onClick={onDone} className="learning-button learning-button--primary">完成此步骤</button>
        </div>
      </div>
    );
  }

  // ── Assessment: 题目作答(服务端判分) ──
  if (content.items) {
    return (
      <div className="learning-card space-y-4 text-sm">
        <h3 className="text-base font-semibold">{content.title}</h3>
        <div className="text-[11px] text-muted-foreground">作答后服务端判分 → 形成可审计学习证据(BKT)</div>
        {content.items.map((item: any, idx: number) => (
          <div key={idx} className="rounded-lg border border-border p-3">
            <div className="mb-2 font-medium">{idx + 1}. {item.question}</div>
            {item.question_type === "choice" ? (
              <div className="space-y-1">
                {(item.options || []).map((o: any, oi: number) => (
                  <label key={oi} className="flex items-center gap-2 rounded border border-border/60 px-2 py-1.5 text-xs hover:bg-accent/40 cursor-pointer">
                    <input type="radio" name={`q${idx}`} checked={answers[idx] === o.text} onChange={() => setAnswers((p) => ({ ...p, [idx]: o.text }))} />
                    {o.text}
                  </label>
                ))}
              </div>
            ) : (
              <textarea value={answers[idx] || ""} onChange={(e) => setAnswers((p) => ({ ...p, [idx]: e.target.value }))}
                placeholder="输入你的答案…" className="learning-textarea h-16" />
            )}
            <div className="mt-2 flex items-center gap-2">
              <button type="button" onClick={() => void grade(item, idx)} disabled={!answers[idx]?.trim()}
                className="learning-button learning-button--secondary">提交</button>
              {results[idx] !== undefined && (
                <span className={`learning-chip ${results[idx] ? "learning-chip--success" : "learning-chip--danger"}`}>
                  {results[idx] ? "✓ 回答正确" : "✗ 回答错误"}
                </span>
              )}
            </div>
          </div>
        ))}
        <div className="flex justify-end">
          <button type="button" onClick={onDone} className="learning-button learning-button--primary">完成练习</button>
        </div>
      </div>
    );
  }

  // ── Retrieval: 回忆卡(front/back 分离) ──
  if (content.cards) {
    const card = content.cards[cardIdx];
    return (
      <div className="learning-card text-sm">
        <h3 className="mb-3 text-base font-semibold">{content.title}</h3>
        {card ? (
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-center">
            {!cardRevealed ? (
              <>
                <div className="text-xs text-muted-foreground">回忆卡 {cardIdx + 1}/{content.cards.length}</div>
                <div className="mt-2 font-medium">{card.front}</div>
                <button type="button" onClick={() => setCardRevealed(true)} className="learning-button learning-button--secondary mt-4">显示答案</button>
              </>
            ) : (
              <>
                <div className="text-xs text-muted-foreground">答案</div>
                <div className="mt-2">{card.back}</div>
                <div className="mt-4 flex gap-2">
                  <button type="button" onClick={() => { setCardRevealed(false); setCardIdx((i) => i + 1); }}
                    className="learning-button learning-button--primary">✓ 记住了</button>
                  <button type="button" onClick={() => { setCardRevealed(false); setCardIdx((i) => i + 1); }}
                    className="learning-button learning-button--danger">✗ 忘了</button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="text-center text-muted-foreground">全部回忆卡完成</div>
        )}
        {(cardIdx >= content.cards.length || !card) && (
          <div className="mt-3 flex justify-end">
            <button type="button" onClick={onDone} className="learning-button learning-button--primary">完成复习</button>
          </div>
        )}
      </div>
    );
  }

  return null;
}

function componentStage(type: string): string {
  if (type === "goal_map") return "mission";
  if (["concept_explanation", "worked_example", "visual_map", "video_explanation", "audio_explanation"].includes(type)) return "learn";
  if (["diagnostic_check", "guided_practice", "transfer_challenge"].includes(type)) return "try";
  if (["calibration_checkpoint", "progress_checkpoint", "reflection_prompt"].includes(type)) return "decide";
  return "remember";
}

/** 状态标签(源码 statusLabel) */
const STATUS_LABEL: Record<string, string> = { pending: "待开始", started: "进行中", completed: "已完成", skipped: "已跳过" };
/** 模态标签(源码 modalityLabel) */
const MODALITY_LABEL: Record<string, string> = { interactive: "互动", visual: "图解", video: "视频", audio: "语音", text: "阅读" };

export function LearningCanvas({ planId, onExit }: { planId: string; onExit: () => void }) {
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 侧边栏折叠(源码 L138-146: 挂载时无条件折叠, 卸载时用户手动偏好胜出)
  const [pathCollapsed, setPathCollapsed] = useState(false);
  useEffect(() => {
    setPathCollapsed(true);
    return () => { /* 卸载: 恢复由外层控制, 此处不覆盖用户偏好 */ };
  }, []);

  const loadPlan = useCallback(async () => {
    try {
      const r = await fetch(`/api/learning-plans?studentId=default&subject=${encodeURIComponent("")}`);
      const j = await r.json();
      const p = (j.plans || []).find((x: any) => x.id === planId);
      if (!p) { setError("计划不存在"); setLoading(false); return; }
      // 补全组件详情(列表接口只有计数, 需 GET 详情)
      const detail = await fetch(`/api/learning-plans?studentId=default`).then((x) => x.json());
      const full = (detail.plans || []).find((x: any) => x.id === planId);
      if (full?.components) {
        setPlan({ id: full.id, goal: full.goal, subject: full.subject, version: full.version, components: full.components });
      } else {
        setPlan({ id: p.id, goal: p.goal, subject: p.subject, version: p.version, components: [] });
      }
      setLoading(false);
    } catch (e: any) { setError(String(e?.message || e)); setLoading(false); }
  }, [planId]);

  useEffect(() => { void loadPlan(); }, [loadPlan]);

  // 依赖锁定(源码 groupVisibleActions)
  const completedIds = new Set((plan?.components || []).filter((c) => ["completed", "skipped"].includes(c.status)).map((c) => c.id));
  const visibleActions = (plan?.components || []).map((c) => {
    const locked = !["completed", "skipped"].includes(c.status) && !(c.dependencies || []).every((d) => completedIds.has(d));
    return { ...c, locked };
  });

  // 状态推进(源码 applyComponentEvent: 幂等 + 409 自愈 + 自动前进)
  const applyEvent = async (componentId: string, action: "start" | "complete" | "skip") => {
    if (!plan) return;
    const comp = plan.components.find((c) => c.id === componentId);
    if (!comp || ["completed", "skipped"].includes(comp.status)) return;  // 幂等 no-op
    setBusy(true);
    try {
      const r = await fetch(`/api/learning-plans/${plan.id}/components/${componentId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: action === "complete" ? "completed" : action === "skip" ? "skipped" : "started" }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        // 409 自愈: 服务端已推进 → 重新拉取
        if (j?.error?.message?.includes("前置") || r.status === 409) { await loadPlan(); }
        else setError(j?.error?.message || "操作失败");
      } else {
        // 本地乐观更新
        setPlan((prev) => prev ? { ...prev, components: prev.components.map((c) => c.id === componentId ? { ...c, status: action === "complete" ? "completed" : action === "skip" ? "skipped" : "started" } : c) } : prev);
        // 自动前进到下一个未完成组件(源码: 环形扫描)
        if (action !== "start") {
          const idx = plan.components.findIndex((c) => c.id === componentId);
          const rest = [...plan.components.slice(idx + 1), ...plan.components.slice(0, idx)];
          const next = rest.find((c) => c.status === "pending" && (c.dependencies || []).every((d) => completedIds.has(d) || d === componentId));
          if (next) setSelectedId(next.id);
        }
      }
    } catch (e: any) { setError(String(e?.message || e)); }
    setBusy(false);
  };

  const selected = visibleActions.find((c) => c.id === selectedId) || visibleActions[0];
  const completedCount = visibleActions.filter((c) => c.status === "completed").length;
  const stage = selected ? componentStage(selected.type) : "mission";

  if (loading) return <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />加载学习画布…</div>;
  if (error) return <div className="flex h-full flex-col items-center justify-center gap-3 p-8"><div className="rounded bg-red-50 p-3 text-sm text-red-600">{error}</div><button onClick={onExit} className="rounded border px-3 py-1.5 text-sm">返回</button></div>;
  if (!plan) return null;

  return (
    <div className="learning-canvas">
      {/* 顶栏(源码 learning-canvas__header) */}
      <header className="learning-canvas__header flex shrink-0 items-center justify-between gap-3">
        <button type="button" onClick={onExit} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent" title="退出画布">
          <X className="h-3.5 w-3.5" /> 退出
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-sm font-semibold">{plan.goal}</div>
          <div className="text-[10px] text-muted-foreground">{plan.subject} · v{plan.version} · {completedCount}/{visibleActions.length} 个组件已完成</div>
        </div>
        <button type="button" onClick={() => setPathCollapsed((v) => !v)} className="rounded-md border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent" title="切换路径侧栏">
          {pathCollapsed ? "展开路径" : "收起路径"}
        </button>
      </header>

      <div className="learning-canvas__layout">
        {/* 路径侧栏(源码 learning-canvas__path-panel) */}
        {!pathCollapsed && (
          <aside className="learning-canvas__path-panel">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
              <Route className="h-3 w-3" /> 学习路径
            </div>
            <ol className="space-y-1">
              {visibleActions.map((c, i) => (
                <li key={c.id}>
                  <button
                    type="button"
                    disabled={c.locked}
                    onClick={() => setSelectedId(c.id)}
                    className={`learning-step ${selected?.id === c.id ? "learning-step--active" : ""} ${c.locked ? "learning-step--locked" : ""}`}
                    title={c.locked ? "此组件需要先完成相关练习" : c.reason}
                  >
                    {c.locked
                      ? <Lock size={13} className="shrink-0 text-muted-foreground" aria-hidden />
                      : c.status === "completed" ? <Check size={13} className="shrink-0 text-emerald-600" />
                      : selected?.id === c.id || c.status === "started" ? <span className="h-3 w-3 shrink-0 rounded-full border-2 border-primary" />
                      : <Circle size={13} className="shrink-0 text-muted-foreground/40" />}
                    <span className="min-w-0 flex-1">
                      <span className="block text-[8px] text-muted-foreground">{String(i + 1).padStart(2, "0")} · {STAGE_LABEL[componentStage(c.type)] || c.type}</span>
                      <span className="block truncate font-medium">{c.title}</span>
                    </span>
                    <ChevronRight size={12} className="shrink-0 opacity-40" />
                  </button>
                </li>
              ))}
            </ol>
            {/* 待复习区(源码: 路径侧栏底部) */}
            {visibleActions.some((c) => c.type === "review_queue") && (
              <div className="mt-3 rounded border border-border/60 bg-muted/30 p-2 text-[9px] text-muted-foreground">
                今日复习: 已到期知识点优先
              </div>
            )}
          </aside>
        )}

        {/* 内容区(源码 learning-canvas__content) */}
        <section className="learning-canvas__content">
          {selected && (
            <div className="mx-auto max-w-3xl">
              {/* 标题 + "为何此步"证据(源码 L1131-1149) */}
              <div className="mb-4 flex items-start justify-between gap-3 border-b pb-4">
                <div className="min-w-0">
                  <div className="text-[10px] text-muted-foreground">{STAGE_LABEL[stage]} · {MODALITY_LABEL[selected.modality || "text"]}</div>
                  <h2 className="mt-1 text-xl font-semibold">{selected.title}</h2>
                  <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
                    {REASON_ZH[selected.type] || selected.reason || "完成此步骤以推进学习。"}
                  </p>
                </div>
                <span className="learning-status-pill">
                  {STATUS_LABEL[selected.status] || selected.status}
                </span>
              </div>

              {/* V394: 组件内容 — 执行器生成真实内容(lesson/assessment/retrieval) */}
              <ComponentContent selected={selected} onDone={() => void applyEvent(selected.id, "complete")} />

              {/* 操作按钮(源码 ActionBar: complete/skip, completed 不渲染) */}
              {!["completed", "skipped"].includes(selected.status) && (
                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy || selected.locked}
                    onClick={() => void applyEvent(selected.id, selected.status === "pending" ? "start" : "complete")}
                    className="learning-button learning-button--primary"
                  >
                    {busy ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : null}
                    {selected.status === "pending" ? "开始此步骤" : "标记完成"}
                  </button>
                  {selected.required === false && selected.status === "pending" && (
                    <button type="button" disabled={busy} onClick={() => void applyEvent(selected.id, "skip")}
                      className="learning-button learning-button--secondary">
                      跳过(可选)
                    </button>
                  )}
                </div>
              )}
              {["completed", "skipped"].includes(selected.status) && (
                <div className="learning-notice learning-notice--success">
                  {selected.status === "completed" ? "✓ 已完成此步骤" : "已跳过"}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
