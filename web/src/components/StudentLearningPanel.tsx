// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// StudentLearningPanel.tsx — 学生端「我的学习」（复赛冲刺期）
// 新增能力散布：苏格拉底辅导 / 阶梯启发 / 错题-知识点联动 / 学习进度追踪 / 自动闭环周报 / 多模态作业拍照
// 全部走 /api/education/* 新路由（agent / loop / cognitive / kg / multimodal）
import { useState, useEffect, type ReactNode } from "react";
import { Send, Loader2, Sparkles, ClipboardList, BarChart3, Camera, ArrowRight, BookOpen, Play } from "lucide-react";
import { EduResultCard } from "./EduResultView";
import { EduFeedbackFAB } from "./EduFeedbackFAB";
import { DonutChart, MasteryBars, SimpleBars, StatCards, Timeline } from "./EduCharts";

const API = "/api/education";

/** 五步打磨流程（Hazel 式） */
const POLISH_STEPS = ["记录想法", "发散拓展", "初步验证", "聚焦收敛", "压力测试"] as const;

/** 示例想法模板（点击即填） */
const EXAMPLE_IDEAS = [
  "为什么说价值规律是商品经济的基本规律？",
  "剩余价值率与利润率的关系辨析",
  "资本主义基本矛盾在当代的表现形式",
  "《资本论》第一卷的核心范畴及其逻辑链条",
];

/** 与 EducationPanel 一致的调用方式（fetch 相对路径；path 为完整路径含 /api/education） */
async function post<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

interface ResultBox {
  title: string;
  data?: unknown;
  error?: string;
}

export function StudentLearningPanel() {
  const [busy, setBusy] = useState<string | null>(null);
  const [subject, setSubject] = useState("政治经济学");
  // 各功能区独立输入（互不干扰）
  const [socraticQ, setSocraticQ] = useState("");
  const [socraticA, setSocraticA] = useState("");
  // 苏格拉底对话流（socratic/socratic-continue 直接入口）
  const [socraticMsgs, setSocraticMsgs] = useState<Array<{ role: "user" | "ai"; text: string }>>([]);
  const [socraticRound, setSocraticRound] = useState(0);
  const [socraticState, setSocraticState] = useState<Record<string, unknown> | null>(null);
  const [scaffoldQ, setScaffoldQ] = useState("");
  const [wrongQ, setWrongQ] = useState("");
  const [langQ, setLangQ] = useState("");
  const [codingQ, setCodingQ] = useState("");
  const [cognitiveQ, setCognitiveQ] = useState("");
  const [collectQ, setCollectQ] = useState("");
  // 五步追问打磨 state
  const [polishSteps, setPolishSteps] = useState<Record<string, { done: boolean; result?: unknown }>>({});
  const [polishResult, setPolishResult] = useState<{ step: string; label: string; data: unknown } | null>(null);
  const [subQuestions, setSubQuestions] = useState<unknown[] | null>(null);
  // 打磨交互状态：空值警告 / 跳步警告 / 完成度
  const [polishWarnEmpty, setPolishWarnEmpty] = useState(false);
  const [polishSkipped, setPolishSkipped] = useState<string | null>(null);
  const polishDoneCount = (polishSteps.diverge?.done ? 1 : 0) + (polishSteps.verify?.done ? 1 : 0) + (polishSteps.focus?.done ? 1 : 0) + (polishSteps.stress?.done ? 1 : 0);
  const [result, setResult] = useState<ResultBox | null>(null);
  // Hazel 式追问区 + 手动子问题
  const [followUpMsgs, setFollowUpMsgs] = useState<Array<{ role: "user" | "ai"; text: string }>>([]);
  const [followUpInput, setFollowUpInput] = useState("");
  const [manualSubQ, setManualSubQ] = useState("");
  const [manualSubQs, setManualSubQs] = useState<string[]>([]);
  // 想法卡管理（Hazel 式多想法并行）
  const [ideaCards, setIdeaCards] = useState<Array<{ id: number; title: string; raw_idea: string; subject: string; progress: number }>>([]);
  const [activeCardId, setActiveCardId] = useState<number | null>(null);
  const [newIdeaTitle, setNewIdeaTitle] = useState("");

  const call = async (key: string, url: string, body: Record<string, unknown>, title: string) => {
    setBusy(key);
    setResult({ title, data: null });
    try {
      const r = await post(url, body);
      setResult({ title, data: r });
    } catch (e: any) {
      setResult({ title, error: String(e?.message || e).slice(0, 200) });
    } finally {
      setBusy(null);
    }
  };

  /** Demo 演示：填充输入框并触发对应调用 */
  const demoRun = (key: string, url: string, body: Record<string, unknown>, title: string, fills?: Record<string, string>) => {
    // 先填示例值
    Object.entries(fills || {}).forEach(([k, v]) => {
      const setters: Record<string, (v: string) => void> = {
        socraticQ: setSocraticQ, scaffoldQ: setScaffoldQ, wrongQ: setWrongQ,
        langQ: setLangQ, codingQ: setCodingQ, cognitiveQ: setCognitiveQ, collectQ: setCollectQ,
      };
      setters[k]?.(v);
    });
    // 触发调用
    void call(key, url, body, `${title}（Demo）`);
  };

  /** 打磨步骤执行 */
  const runPolish = async (step: "diverge" | "verify" | "focus" | "stress", label: string) => {
    // ① 原始想法为空 → 高亮输入框 + 醒目警告（不执行）
    if (!socraticQ.trim()) {
      setPolishWarnEmpty(true);
      setPolishSkipped(null);
      return;
    }
    setBusy(`polish-${step}`);
    // ② 前置上下文 = 前一步输出；跳步检测（前置未完成）
    const prev = step === "verify" ? polishSteps.diverge : step === "focus" ? polishSteps.verify : step === "stress" ? polishSteps.focus : null;
    if (!prev?.done) {
      const skippedLabel = step === "verify" ? "发散拓展" : step === "focus" ? "初步验证" : "聚焦收敛";
      setPolishSkipped(skippedLabel);   // 醒目降级警告
    } else {
      setPolishSkipped(null);
    }
    const body: Record<string, unknown> = {
      subject, question: socraticQ,
      step,
      ...(prev?.result ? { context: JSON.stringify(prev.result).slice(0, 1200) } : {}),
    };
    try {
      const r = await post(`${API}/agent/polish`, body);
      setPolishSteps((prev2) => ({ ...prev2, [step]: { done: true, result: r } }));
      setPolishResult({ step, label, data: r });
    } catch (e: any) {
      setPolishResult({ step, label, data: null });
      setResult({ title: `${label}`, error: String(e?.message || e).slice(0, 200) });
    } finally {
      setBusy(null);
    }
  };

  /** 子问题拆解 */
  const runDecompose = async () => {
    setBusy("decompose");
    try {
      const r = await post(`${API}/agent/decompose`, { subject, problemStatement: socraticQ || "价值规律在商品经济中的作用" });
      setSubQuestions((r as any).subQuestions || []);
    } catch (e: any) {
      setSubQuestions([]);
    } finally {
      setBusy(null);
    }
  };

  /** 苏格拉底会话：开始对话（socratic 直接入口） */
  const startSocraticChat = async () => {
    if (!socraticQ.trim()) { setPolishWarnEmpty(true); return; }
    setBusy("socratic-chat");
    try {
      const r = await post(`${API}/agent/socratic`, { subject, question: socraticQ });
      const sc = (r as any).socratic;
      const reply = [
        sc?.acknowledge,
        ...(sc?.questions || []).map((q: any) => `❓ ${q.q}`),
      ].filter(Boolean).join("\n");
      setSocraticMsgs([{ role: "ai", text: reply || "（无回复）" }]);
      setSocraticRound(1);
      setSocraticState((r as any).state || { round: 1, maxRounds: 3, question: socraticQ, subject });
    } catch (e: any) {
      setSocraticMsgs([{ role: "ai", text: `（调用失败：${String(e?.message || e).slice(0, 80)}）` }]);
    } finally {
      setBusy(null);
    }
  };

  /** 苏格拉底会话：回答（socratic-continue） */
  const continueSocraticChat = async () => {
    if (!socraticA.trim() || !socraticState) return;
    const answer = socraticA.trim();
    setSocraticMsgs((prev) => [...prev, { role: "user", text: answer }]);
    setSocraticA("");
    setBusy("socratic-chat");
    try {
      const r = await post(`${API}/agent/socratic-continue`, {
        subject, question: String(socraticState.question || ""), state: socraticState, studentAnswer: answer,
      });
      const sc = (r as any).socratic;
      const reply = [
        sc?.feedback,
        ...(sc?.questions || []).map((q: any) => `❓ ${q.q}`),
        ...(sc?.stepHints || []).map((h: string) => `💡 ${h}`),
        sc?.conclusionCheck ? `✅ ${sc.conclusionCheck}` : "",
      ].filter(Boolean).join("\n");
      setSocraticMsgs((prev) => [...prev, { role: "ai", text: reply || "（无回复）" }]);
      setSocraticRound((r as any).round || socraticRound + 1);
      setSocraticState((r as any).state || socraticState);
    } catch (e: any) {
      setSocraticMsgs((prev) => [...prev, { role: "ai", text: `（调用失败：${String(e?.message || e).slice(0, 80)}）` }]);
    } finally {
      setBusy(null);
    }
  };

  /** 步骤结果追问（Hazel「结果与追问」区） */
  const runFollowUp = async () => {
    if (!followUpInput.trim() || !polishResult?.data) return;
    const q = followUpInput.trim();
    setFollowUpMsgs((prev) => [...prev, { role: "user", text: q }]);
    setFollowUpInput("");
    setBusy("follow-up");
    try {
      const r = await post(`${API}/agent/follow-up`, {
        subject,
        stepLabel: polishResult.label,
        stepOutput: JSON.stringify(polishResult.data).slice(0, 1500),
        question: q,
      });
      const f = (r as any).followUp;
      const reply = [
        f?.acknowledge,
        ...(f?.followUps || []).map((fu: any) => `❓ ${fu.q}`),
        f?.insight ? `💡 ${f.insight}` : "",
      ].filter(Boolean).join("\n");
      setFollowUpMsgs((prev) => [...prev, { role: "ai", text: reply }]);
    } catch (e: any) {
      setFollowUpMsgs((prev) => [...prev, { role: "ai", text: `（追问失败：${String(e?.message || e).slice(0, 80)}）` }]);
    } finally {
      setBusy(null);
    }
  };

  /** 导出对话（五步打磨全过程） */
  const exportPolish = () => {
    const lines: string[] = [
      `# 想法打磨导出（${new Date().toLocaleString("zh-CN")}）`,
      "",
      `## 原始想法`,
      socraticQ || "（空）",
      "",
      "## 五步打磨过程",
    ];
    POLISH_STEPS.forEach((label, i) => {
      const stepKey = (i === 1 ? "diverge" : i === 2 ? "verify" : i === 3 ? "focus" : "stress") as string;
      lines.push(`### 第${i + 1}步 · ${label}${polishSteps[stepKey]?.done ? "（已完成）" : "（未执行）"}`);
      if (polishSteps[stepKey]?.result) {
        lines.push("```json");
        lines.push(JSON.stringify(polishSteps[stepKey].result, null, 2).slice(0, 2000));
        lines.push("```");
      }
      lines.push("");
    });
    if (followUpMsgs.length > 0) {
      lines.push("## 追问记录");
      followUpMsgs.forEach((m) => lines.push(`**${m.role === "user" ? "我" : "AI"}**：${m.text}`));
    }
    if ((subQuestions?.length || 0) + manualSubQs.length > 0) {
      lines.push("## 子问题");
      (subQuestions || []).forEach((q: any) => lines.push(`- ${q.question}`));
      manualSubQs.forEach((q) => lines.push(`- ${q}`));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `想法打磨-${socraticQ.slice(0, 10) || "未命名"}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /** 想法卡：加载列表 */
  const loadIdeaCards = async () => {
    try {
      const r = await post(`${API}/agent/idea-cards/list`, { studentId: "default" });
      setIdeaCards((r as any).cards || []);
    } catch { /* 忽略 */ }
  };
  /** 想法卡：新建（保存当前输入） */
  const createIdeaCard = async () => {
    if (!socraticQ.trim()) { setPolishWarnEmpty(true); return; }
    try {
      const r = await post(`${API}/agent/idea-cards/create`, {
        studentId: "default", title: newIdeaTitle || socraticQ.slice(0, 20), rawIdea: socraticQ, subject,
      });
      const card = (r as any).card;
      setActiveCardId(card.id);
      setNewIdeaTitle("");
      await loadIdeaCards();
    } catch { /* 忽略 */ }
  };
  /** 想法卡：切换（载入卡内容） */
  const selectIdeaCard = (card: { id: number; title: string; raw_idea: string; subject: string }) => {
    setActiveCardId(card.id);
    setSocraticQ(card.raw_idea);
    setSubject(card.subject);
    setPolishWarnEmpty(false);
  };
  /** 想法卡：删除 */
  const deleteIdeaCard = async (id: number) => {
    try {
      await post(`${API}/agent/idea-cards/delete`, { studentId: "default", id });
      setIdeaCards((prev) => prev.filter((c) => c.id !== id));
      if (activeCardId === id) setActiveCardId(null);
    } catch { /* 忽略 */ }
  };
  /** 想法卡：更新进度（打磨完成后） */
  const saveProgress = async (progress: number) => {
    if (!activeCardId) return;
    try {
      await post(`${API}/agent/idea-cards/update`, { studentId: "default", id: activeCardId, progress });
      await loadIdeaCards();
    } catch { /* 忽略 */ }
  };

  /** Demo 按钮（通用样式） */
  const DemoBtn = ({ onClick, label = "Demo 演示" }: { onClick: () => void; label?: string }) => (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded-lg border border-dashed border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 transition-colors"
      title="一键填入示例并运行"
    >
      <Play className="h-3 w-3" /> {label}
    </button>
  );

  // 首次加载想法卡列表
  useEffect(() => { void loadIdeaCards(); }, []);

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <EduFeedbackFAB role="student" scene="general" source="学生端工作台" />
      {/* 苏格拉底追问 · 五步打磨（Hazel 式） */}
      <div className="rounded-xl border bg-card p-3 lg:col-span-2">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <Sparkles className="h-3.5 w-3.5 text-emerald-600" /> 苏格拉底追问 · 五步打磨
          <span className="ml-auto">
            <span className={`mr-2 rounded-full px-2 py-0.5 text-[10px] font-semibold ${polishDoneCount > 0 ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}>
              完成度 {polishDoneCount}/5
            </span>
            <DemoBtn label="示例想法" onClick={() => setSocraticQ("为什么说价值规律是商品经济的基本规律？")} />
          </span>
        </div>

        {/* 想法卡（多想法并行管理） */}
        <div className="mb-2 flex items-center gap-1.5">
          <span className="text-[10px] font-medium text-muted-foreground">想法卡：</span>
          <div className="flex flex-1 flex-wrap items-center gap-1">
            {ideaCards.length === 0 && <span className="text-[10px] text-muted-foreground/60">（暂无，保存当前想法后出现）</span>}
            {ideaCards.map((card) => (
              <span key={card.id} className={`group inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                activeCardId === card.id ? "border-emerald-400 bg-emerald-50 text-emerald-700" : "border-border bg-muted/40 text-foreground/70 hover:bg-muted"
              }`}>
                <button onClick={() => selectIdeaCard(card)} className="max-w-[120px] truncate" title={card.raw_idea}>
                  {card.title}
                  {card.progress > 0 && <span className="ml-0.5 text-[9px] text-emerald-600">{card.progress}/5</span>}
                </button>
                <button onClick={() => deleteIdeaCard(card.id)} className="text-[9px] text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-red-500" title="删除">
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <input
              value={newIdeaTitle}
              onChange={(e) => setNewIdeaTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void createIdeaCard(); }}
              className="w-24 rounded-lg border bg-background px-2 py-1 text-[11px]"
              placeholder="标题（可选）"
            />
            <button
              onClick={() => void createIdeaCard()}
              disabled={!socraticQ.trim()}
              className="rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] text-white disabled:opacity-50"
              title="保存当前想法为新卡片"
            >
              + 新建
            </button>
          </div>
        </div>

        {/* 原始想法输入（空值时高亮提示） */}
        <div className={`mb-1 rounded-lg border-2 p-2 transition-colors ${polishWarnEmpty ? "border-red-400 bg-red-50" : "border-transparent bg-muted/30"}`}>
          <div className="mb-1 flex items-center gap-1.5">
            <label className="text-[11px] font-semibold text-foreground/80">① 记录想法（原始研究问题）</label>
            {polishWarnEmpty && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-medium text-white animate-pulse">⚠ 请先填写研究问题</span>}
          </div>
          <div className="flex gap-1">
            <input value={subject} onChange={(e) => setSubject(e.target.value)} className="min-w-0 w-28 rounded-lg border bg-background px-3 py-2 text-[13px]" placeholder="科目" />
            <input
              value={socraticQ}
              onChange={(e) => { setSocraticQ(e.target.value); if (polishWarnEmpty) setPolishWarnEmpty(false); }}
              className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-[13px] ${polishWarnEmpty ? "border-red-400 bg-white ring-2 ring-red-200" : "border-border bg-background"}`}
              placeholder="在此输入你的原始想法/研究问题，如：为什么价值规律是商品经济的基本规律？"
            />
          </div>
          {/* 示例想法模板（点击即填） */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-muted-foreground">不知道怎么写？试试示例想法：</span>
            {EXAMPLE_IDEAS.map((ex, i) => (
              <button
                key={i}
                onClick={() => { setSocraticQ(ex); setPolishWarnEmpty(false); }}
                className="rounded-full border border-dashed border-emerald-300 bg-emerald-50/60 px-2 py-0.5 text-[10px] text-emerald-700 hover:bg-emerald-100 transition-colors"
              >
                {ex.slice(0, 18)}…
              </button>
            ))}
          </div>
        </div>

        {/* 五步流程条（进度锁 + 完成度） */}
        <div className="mb-1 flex items-center gap-1">
          {POLISH_STEPS.map((label, i) => {
            const stepKey = (i === 1 ? "diverge" : i === 2 ? "verify" : i === 3 ? "focus" : "stress") as "diverge" | "verify" | "focus" | "stress";
            const done = i === 0 || Boolean(polishSteps[stepKey]?.done);
            const locked = i >= 2 && !done; // 聚焦/压力测试默认锁（前置未完成）
            return (
              <div key={i} className={`flex flex-1 items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] ${
                done ? "border-emerald-300 bg-emerald-50 text-emerald-700" : locked ? "border-amber-200 bg-amber-50/60 text-amber-700" : "border-border bg-muted/40 text-muted-foreground"
              }`}>
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] ${done ? "bg-emerald-600 text-white" : locked ? "bg-amber-400 text-white" : "bg-muted text-muted-foreground"}`}>
                  {done ? "✓" : locked ? "🔒" : i + 1}
                </span>
                <span className="truncate">{label}</span>
              </div>
            );
          })}
        </div>
        {/* 跳步降级警告（醒目） */}
        {polishSkipped && (
          <div className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
            ⚠ 已跳步执行：未完成「{polishSkipped}」直接执行后续步骤，输出将<strong>丢失前置上下文、质量降级</strong>。建议按顺序完成。
          </div>
        )}

        {/* 步骤执行按钮 */}
        <div className="flex flex-wrap items-center gap-1">
          <button disabled={busy !== null} onClick={() => runPolish("diverge", "发散拓展")}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[13px] text-white disabled:opacity-50">
            {busy === "polish-diverge" ? <Loader2 className="inline h-3 w-3 animate-spin" /> : "🌱"} 发散拓展
          </button>
          <button disabled={busy !== null} onClick={() => runPolish("focus", "聚焦收敛")}
            className={`rounded-lg px-3 py-1.5 text-[13px] text-white disabled:opacity-50 ${polishSteps.diverge?.done ? "bg-emerald-600" : "bg-amber-500"}`}>
            {busy === "polish-focus" ? <Loader2 className="inline h-3 w-3 animate-spin" /> : polishSteps.diverge?.done ? "🎯" : "🔓"} 聚焦收敛
          </button>
          <button disabled={busy !== null} onClick={() => runPolish("stress", "压力测试")}
            className={`rounded-lg px-3 py-1.5 text-[13px] text-white disabled:opacity-50 ${polishSteps.focus?.done ? "bg-red-600" : "bg-amber-500"}`}>
            {busy === "polish-stress" ? <Loader2 className="inline h-3 w-3 animate-spin" /> : polishSteps.focus?.done ? "⚡" : "🔓"} 压力测试
          </button>
          <button disabled={busy !== null} onClick={runDecompose}
            className="rounded-lg bg-sky-600 px-3 py-1.5 text-[13px] text-white disabled:opacity-50">
            {busy === "decompose" ? <Loader2 className="inline h-3 w-3 animate-spin" /> : "🔍"} 子问题拆解
          </button>
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          {polishSteps.diverge?.done && polishSteps.focus?.done && polishSteps.stress?.done
            ? "✅ 四步全部完成，问题已充分打磨"
            : "步骤可跳步执行（🔓 未锁），但跳步会丢失前置上下文、降低输出质量"}
        </div>

        {/* 步骤输出 */}
        {polishResult?.data ? (
          <div className="mt-2">
            <EduResultCard title={`${polishResult.label} 输出`} data={polishResult.data} />
          </div>
        ) : null}

        {/* 子问题结果 */}
        {subQuestions && subQuestions.length > 0 ? (
          <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50/50 p-2">
            <div className="mb-1.5 text-[11px] font-semibold text-sky-700">🔍 子问题拆解（{(subQuestions?.length || 0) + manualSubQs.length} 个）</div>
            <div className="space-y-1">
              {(subQuestions || []).map((q: any, i: number) => (
                <div key={i} className="rounded-md bg-card px-2 py-1.5 text-[12px]">
                  <span className="font-medium">{q.question}</span>
                  <span className="ml-2 text-[10px] text-muted-foreground">{q.rationale}</span>
                </div>
              ))}
              {manualSubQs.map((q, i) => (
                <div key={`m${i}`} className="rounded-md bg-card px-2 py-1.5 text-[12px]">
                  <span className="font-medium">{q}</span>
                  <span className="ml-2 text-[10px] text-muted-foreground">（手动添加）</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Hazel 式底部面板：追问区 + 子问题 */}
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {/* 结果与追问 */}
          <div className="rounded-lg border border-border/70 bg-card p-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-foreground/80">结果与追问（{followUpMsgs.length} 条）</span>
              <button onClick={exportPolish} className="rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted transition-colors">
                ⬇ 导出对话
              </button>
            </div>
            {followUpMsgs.length === 0 ? (
              <div className="rounded-md bg-muted/40 px-2.5 py-3 text-center text-[11px] text-muted-foreground">
                还没有追问。生成结果后，在这里针对这一步继续追问。<br />
                <span className="text-[10px] opacity-70">针对这一步的结果追问，AI 会苏格拉底式回应</span>
              </div>
            ) : (
              <div className="mb-1.5 max-h-40 space-y-1.5 overflow-y-auto">
                {followUpMsgs.map((m, i) => (
                  <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
                      m.role === "user" ? "rounded-br-sm bg-emerald-600 text-white" : "rounded-bl-sm border border-border/60 bg-background"
                    }`}>{m.text}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-1">
              <input
                value={followUpInput}
                onChange={(e) => setFollowUpInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void runFollowUp(); }}
                disabled={!polishResult?.data}
                className="min-w-0 flex-1 rounded-lg border bg-background px-2.5 py-1.5 text-[12px] disabled:opacity-50"
                placeholder={polishResult?.data ? "针对这一步的结果追问…" : "先执行本步，再追问"}
              />
              <button
                disabled={busy !== null || !followUpInput || !polishResult?.data}
                onClick={() => void runFollowUp()}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] text-white disabled:opacity-50"
              >
                发送
              </button>
            </div>
          </div>

          {/* 子问题面板 */}
          <div className="rounded-lg border border-border/70 bg-card p-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-foreground/80">子问题</span>
              <button
                onClick={runDecompose}
                disabled={busy !== null}
                className="rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] text-sky-700 hover:bg-sky-100 transition-colors disabled:opacity-50"
              >
                {busy === "decompose" ? <Loader2 className="inline h-2.5 w-2.5 animate-spin" /> : "✨"} AI 拆解
              </button>
            </div>
            <div className="mb-1.5 space-y-1">
              {(subQuestions || []).map((q: any, i: number) => (
                <div key={i} className="rounded-md bg-muted/40 px-2 py-1 text-[11px]">
                  <span className="font-medium">{q.question}</span>
                </div>
              ))}
              {manualSubQs.map((q, i) => (
                <div key={`m${i}`} className="rounded-md bg-muted/40 px-2 py-1 text-[11px]">
                  <span className="font-medium">{q}</span>
                  <span className="ml-1 text-[9px] text-muted-foreground">（手动）</span>
                </div>
              ))}
              {(subQuestions || []).length === 0 && manualSubQs.length === 0 && (
                <div className="rounded-md bg-muted/30 px-2 py-2 text-center text-[10px] text-muted-foreground">
                  从 Problem Statement 拆出 2-4 个子问题，或手动添加
                </div>
              )}
            </div>
            <div className="flex gap-1">
              <input
                value={manualSubQ}
                onChange={(e) => setManualSubQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && manualSubQ.trim()) { setManualSubQs((p) => [...p, manualSubQ.trim()]); setManualSubQ(""); } }}
                className="min-w-0 flex-1 rounded-lg border bg-background px-2.5 py-1.5 text-[12px]"
                placeholder="手动添加子问题…"
              />
              <button
                disabled={!manualSubQ.trim()}
                onClick={() => { setManualSubQs((p) => [...p, manualSubQ.trim()]); setManualSubQ(""); }}
                className="rounded-lg bg-muted px-3 py-1.5 text-[12px] hover:bg-muted/70 disabled:opacity-50"
              >
                添加
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 苏格拉底对话（socratic/socratic-continue 直接入口） */}
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <Sparkles className="h-3.5 w-3.5 text-emerald-600" /> 苏格拉底对话
          {socraticRound > 0 && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">第 {socraticRound}/3 轮</span>}
          <span className="ml-auto"><DemoBtn label="示例" onClick={() => { setSocraticQ("为什么说价值规律是商品经济的基本规律？"); }} /></span>
        </div>
        {socraticMsgs.length > 0 && (
          <div className="mb-2 max-h-52 space-y-1.5 overflow-y-auto rounded-lg bg-muted/30 p-2">
            {socraticMsgs.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-2.5 py-1.5 text-[11px] leading-relaxed ${
                  m.role === "user" ? "rounded-br-sm bg-emerald-600 text-white" : "rounded-bl-sm border border-border/60 bg-card"
                }`}>{m.text}</div>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-1">
          <input value={socraticQ} onChange={(e) => setSocraticQ(e.target.value)} className="min-w-0 flex-[2] rounded-lg border bg-background px-2.5 py-1.5 text-[12px]" placeholder="你的问题…" />
          <button disabled={busy !== null || !socraticQ.trim()} onClick={() => void startSocraticChat()}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] text-white disabled:opacity-50">
            {busy === "socratic-chat" && socraticRound === 0 ? <Loader2 className="inline h-3 w-3 animate-spin" /> : "💬"} 开始对话
          </button>
          <input value={socraticA} onChange={(e) => setSocraticA(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void continueSocraticChat(); }}
            disabled={!socraticState} className="min-w-0 flex-1 rounded-lg border bg-background px-2.5 py-1.5 text-[12px] disabled:opacity-50" placeholder="你的回答…" />
          <button disabled={busy !== null || !socraticA || !socraticState} onClick={() => void continueSocraticChat()}
            className="rounded-lg bg-emerald-100 px-3 py-1.5 text-[12px] text-emerald-700 disabled:opacity-50">回答</button>
        </div>
      </div>

      {/* 阶梯启发 + 拍照作业 */}
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <ClipboardList className="h-3.5 w-3.5 text-emerald-600" /> 阶梯式启发 · 作业拍照
          <span className="ml-auto"><DemoBtn onClick={() => demoRun("scaffold", `${API}/agent/scaffold`, { subject, question: "简述价值规律的基本内容及其表现形式", stuckLevel: 0 }, "阶梯式启发 · 方向提示", { scaffoldQ: "简述价值规律的基本内容及其表现形式" })} /></span>
        </div>
        <div className="mb-2 flex gap-1">
          <input value={scaffoldQ} onChange={(e) => setScaffoldQ(e.target.value)} className="min-w-0 flex-1 rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="题目文本（或拍照后自动 OCR）" />
        </div>
        <div className="flex gap-1">
          {["方向提示", "分步引导", "完整解析"].map((lbl, idx) => (
            <button
              key={idx}
              disabled={busy !== null}
              onClick={() => call(`scaffold${idx}`, `${API}/agent/scaffold`, { subject, question: scaffoldQ, stuckLevel: idx }, `阶梯式启发 · ${lbl}（第 ${idx + 1} 级）`)}
              className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors"
            >
              {lbl}
            </button>
          ))}
          <button
            disabled={busy !== null}
            onClick={() => call("photo", `${API}/multimodal/photo-solve`, { subject, imagePath: scaffoldQ }, "作业拍照识别（拍照→OCR→辅导）")}
            className="flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
          >
            <Camera className="h-3 w-3" /> 拍照题
          </button>
        </div>
      </div>

      {/* 错题-知识点联动 */}
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <ArrowRight className="h-3.5 w-3.5 text-emerald-600" /> 错题-知识点联动
          <span className="ml-auto"><DemoBtn onClick={() => demoRun("wrong", `${API}/agent/wrong-to-mastery`, { subject, knowledgePoint: "剩余价值", question: "剩余价值率与利润率总是混淆", mistakeType: "方法不熟" }, "错题归集 → 掌握度联动 → 变式题", { wrongQ: "剩余价值率与利润率总是混淆" })} /></span>
        </div>
        <div className="flex gap-1">
          <input
            onChange={(e) => setWrongQ(e.target.value)}
            value={wrongQ}
            placeholder="错题内容"
            className="min-w-0 flex-1 rounded border bg-background px-3 py-1.5 text-[13px]"
          />
          <button
            disabled={busy !== null}
            onClick={() => call("wrong", `${API}/agent/wrong-to-mastery`, { subject, knowledgePoint: wrongQ.slice(0, 20), question: wrongQ, mistakeType: "方法不熟" }, "错题归集 → 掌握度联动 → 变式题")}
            className="rounded-lg bg-orange-600 px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
          >
            记错题 + 变式
          </button>
          <button
            disabled={busy !== null}
            onClick={() => call("wrong-record", `${API}/homework/wrong`, { subject, knowledgePoint: wrongQ.slice(0, 20), question: wrongQ, mistakeType: "方法不熟" }, "错题归集（写入错题本）")}
            className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors"
          >
            记错题
          </button>
          <button
            disabled={busy !== null}
            onClick={() => call("wrong-list", `${API}/homework/wrong-list`, { subject }, "错题本列表（未掌握）")}
            className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors"
          >
            错题本
          </button>
        </div>
      </div>

      {/* 学习进度 + 自动闭环周报 */}
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <BarChart3 className="h-3.5 w-3.5 text-emerald-600" /> 学习进度 · 自动闭环周报
          <span className="ml-auto"><DemoBtn label="周报 Demo" onClick={() => demoRun("report", `${API}/loop/report`, { subject, days: 7 }, "自动闭环周报（7 天）")} /></span>
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            disabled={busy !== null}
            onClick={() => call("progress", `${API}/agent/progress`, { subject }, "学习进度追踪")}
            className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors"
          >
            进度报告
          </button>
          <button
            disabled={busy !== null}
            onClick={() => call("diagnose", `${API}/loop/diagnose`, { subject }, "自动诊断（薄弱点/行为/风险）")}
            className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors"
          >
            自动诊断
          </button>
          <button
            disabled={busy !== null}
            onClick={() => call("iterate", `${API}/loop/iterate`, { subject, goal: `巩固 ${subject} 薄弱知识点` }, "自动迭代（诊断→重排计划→重推内容）")}
            className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors"
          >
            自动迭代方案
          </button>
          <button
            disabled={busy !== null}
            onClick={() => call("report", `${API}/loop/report`, { subject, days: 7 }, "自动闭环周报（7 天）")}
            className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors"
          >
            闭环周报
          </button>
        </div>
      </div>

      {/* 阅读与语言学习（手册方向） */}
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <BookOpen className="h-3.5 w-3.5 text-emerald-600" /> 阅读与语言学习
          <span className="ml-auto"><DemoBtn onClick={() => demoRun("reading", `${API}/lang/reading`, { text: "价值规律是商品经济的基本规律，商品交换以价值量为基础实行等价交换。", language: "zh", focus: "精读" }, "阅读理解（主旨/结构/术语/难点）", { langQ: "价值规律是商品经济的基本规律，商品交换以价值量为基础实行等价交换。" })} /></span>
        </div>
        <div className="mb-2 flex gap-1">
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className="min-w-0 flex-1 rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="科目/语言" />
          <input value={langQ} onChange={(e) => setLangQ(e.target.value)} className="min-w-0 flex-[2] rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="待精读文本 / 待修改作文" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button disabled={busy !== null} onClick={() => call("reading", `${API}/lang/reading`, { text: langQ, language: "zh", focus: "精读" }, "阅读理解（主旨/结构/术语/难点）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            阅读理解
          </button>
          <button disabled={busy !== null} onClick={() => call("vocab", `${API}/lang/vocab-grammar`, { text: langQ, language: "zh" }, "词汇语法反馈")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            词汇语法
          </button>
          <button disabled={busy !== null} onClick={() => call("writing", `${API}/lang/writing`, { text: langQ, style: "学术", keepMeaning: true }, "写作修改（润色）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            写作修改
          </button>
        </div>
      </div>

      {/* 职业教育 / 编程教育（手册方向） */}
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <ClipboardList className="h-3.5 w-3.5 text-emerald-600" /> 职业教育 / 编程教育
          <span className="ml-auto"><DemoBtn onClick={() => demoRun("decompose", `${API}/coding/decompose`, { task: "用 Python 统计《资本论》第一卷高频概念词频", role: "马理论研究员", skillLevel: "基础" }, "任务拆解（步骤/依赖/验收）", { codingQ: "用 Python 统计《资本论》第一卷高频概念词频" })} /></span>
        </div>
        <div className="mb-2 flex gap-1">
          <input value={codingQ} onChange={(e) => setCodingQ(e.target.value)} className="min-w-0 flex-1 rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="任务 / 代码题 / 岗位（如：马理论研究员）" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button disabled={busy !== null} onClick={() => call("decompose", `${API}/coding/decompose`, { task: codingQ, role: "马理论研究员", skillLevel: "基础" }, "任务拆解（步骤/依赖/验收）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            任务拆解
          </button>
          <button disabled={busy !== null} onClick={() => call("code-tutor", `${API}/coding/tutor`, { subject: "编程", question: codingQ, hintLevel: "hint" }, "代码辅导（引导式+报错解读）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            代码辅导
          </button>
          <button disabled={busy !== null} onClick={() => call("interview", `${API}/coding/interview`, { role: codingQ, count: 5 }, "面试准备（答题框架+模拟追问）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            面试准备
          </button>
          <button disabled={busy !== null} onClick={() => call("career", `${API}/coding/path`, { role: codingQ, weeks: 12 }, "学习路线（技能/阶段/项目/里程碑）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            学习路线
          </button>
        </div>
      </div>
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <Sparkles className="h-3.5 w-3.5 text-emerald-600" /> 认知维度 · 千人千策 · 复习提醒
          <span className="ml-auto"><DemoBtn label="认知 Demo" onClick={() => demoRun("cognitive", `${API}/student/cognitive-dims`, { subject, knowledgePoint: "价值规律" }, "认知维度标签（布鲁姆六维）", { cognitiveQ: "价值规律" })} /></span>
        </div>
        <div className="mb-2 flex gap-1">
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className="min-w-0 flex-1 rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="科目" />
          <input value={cognitiveQ} onChange={(e) => setCognitiveQ(e.target.value)} className="min-w-0 flex-[2] rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="知识点（认知维度用）" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button disabled={busy !== null} onClick={() => call("cognitive", `${API}/student/cognitive-dims`, { subject, knowledgePoint: cognitiveQ }, "认知维度标签（布鲁姆六维）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            认知维度
          </button>
          <button disabled={busy !== null} onClick={() => call("recommend", `${API}/student/recommend`, { subject, professionalBackground: "经济学", goal: "系统学习" }, "千人千策（专业背景+进度推荐）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            千人千策
          </button>
          <button disabled={busy !== null} onClick={() => call("reminder", `${API}/student/review-reminder`, { subject }, "复习提醒（艾宾浩斯遗忘曲线）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            复习提醒
          </button>
        </div>
      </div>

      {/* 自动采集钩子 + BKT 追踪 + 策略校验（补齐缺前端入口的路由） */}
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <BarChart3 className="h-3.5 w-3.5 text-emerald-600" /> 自动采集 · BKT 追踪 · 策略
          <span className="ml-auto"><DemoBtn label="BKT Demo" onClick={() => demoRun("bkt-track", `${API}/cognitive/bkt-track`, { subject, knowledgePoint: "价值规律" }, "BKT 单点追踪（p(掌握)序列+预测答对概率）", { collectQ: "价值规律" })} /></span>
        </div>
        <div className="mb-2 flex gap-1">
          <input value={collectQ} onChange={(e) => setCollectQ(e.target.value)} className="min-w-0 flex-1 rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="知识点（如：价值规律）" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button disabled={busy !== null} onClick={() => call("record-answer", `${API}/adaptive/record-answer`, { subject, knowledgePoint: collectQ.slice(0, 20), question: collectQ, isCorrect: true }, "作答记录（写 answer_history + 掌握度更新）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            作答记录
          </button>
          <button disabled={busy !== null} onClick={() => call("hook-answer", `${API}/loop/hook-answer`, { subject, knowledgePoint: collectQ.slice(0, 20), question: collectQ, isCorrect: true }, "作答自动采集钩子（写 answer_history + 掌握度）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            作答采集钩子
          </button>
          <button disabled={busy !== null} onClick={() => call("hook-plan", `${API}/loop/hook-plan-progress`, { planId: 1, itemIndex: 0, done: true }, "计划进度钩子（任务完成→progress 更新）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            计划进度钩子
          </button>
          <button disabled={busy !== null} onClick={() => call("bkt-track", `${API}/cognitive/bkt-track`, { subject, knowledgePoint: collectQ.slice(0, 20) }, "BKT 单点追踪（p(掌握)序列+预测答对概率）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            BKT 追踪
          </button>
          <button disabled={busy !== null} onClick={() => call("policy", `${API}/agent/policy-check`, { content: collectQ }, "教育策略校验（不直接给答案等边界）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            策略校验
          </button>
          <button disabled={busy !== null} onClick={() => call("record", `${API}/lang/record`, { studentId: "default", activity: "reading", subject, topic: collectQ || "阅读" }, "学习记录落库（reading/writing/vocab）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            学习记录
          </button>
        </div>
      </div>

      {/* 结果区（结构化渲染 + 图表） */}
      <div className="lg:col-span-2">
        {result ? (
          <EduResultCard title={result.title} data={result.data} error={result.error} chart={buildChart(result)} />
        ) : (
          <div className="rounded-xl border border-dashed border-border/60 py-8 text-center text-xs text-muted-foreground">
            在上方选择能力并填入内容，结果将以结构化卡片 + 图表展示
          </div>
        )}
      </div>
    </div>
  );
}

/** 从不同结果类型提取图表数据 */
function buildChart(result: { title: string; data?: unknown }): ReactNode | null {
  const d = result.data as any;
  if (!d || typeof d !== "object") return null;

  // ① BKT 追踪：p(掌握) 序列 → 折线趋势（用 SimpleBars 展示各轮 p 值）
  if (d.trace && Array.isArray(d.trace)) {
    const steps = d.trace.slice(0, 10);
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-4">
          <StatCards stats={[
            { label: "最终 p(掌握)", value: (d.finalMastery ?? 0).toFixed(2), color: "#188038" },
            { label: "预测答对", value: (d.predictNextCorrect ?? 0).toFixed(2), color: "#1a73e8" },
            { label: "掌握等级", value: d.level === "mastered" ? "已掌握" : d.level === "fuzzy" ? "模糊" : "未掌握", color: d.level === "mastered" ? "#188038" : "#c5221f" },
          ]} />
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium text-foreground/80">p(掌握) 随作答迭代</div>
          <SimpleBars data={steps.map((s: any) => ({ label: `#${s.step}`, value: Math.round((s.pMastery ?? 0) * 100) }))} color="#1a73e8" />
        </div>
      </div>
    );
  }

  // ② 闭环周报：掌握度分布 + 统计卡
  if (d.report && typeof d.report === "object") {
    const r = d.report;
    const mastery = r.mastery || [];
    const mastered = mastery.filter((m: any) => m.mastery_level === "mastered").length;
    const fuzzy = mastery.filter((m: any) => m.mastery_level === "fuzzy").length;
    const unlearned = mastery.filter((m: any) => m.mastery_level === "unlearned").length;
    return (
      <div className="space-y-3">
        <StatCards stats={[
          { label: "作答数", value: r.answers ?? 0 },
          { label: "正确率", value: `${r.accuracy ?? 0}%`, color: "#188038" },
          { label: "错题清零率", value: `${r.wrongClearedRate ?? 0}%`, color: "#1a73e8" },
          { label: "计划完成率", value: `${r.planCompletion ?? 0}%`, color: "#e8710a" },
        ]} />
        {mastery.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-medium text-foreground/80">掌握度分布</div>
            <DonutChart data={[
              { label: "已掌握", value: mastered, color: "#188038" },
              { label: "模糊", value: fuzzy, color: "#e8710a" },
              { label: "未掌握", value: unlearned, color: "#c5221f" },
            ]} centerLabel="知识点" />
          </div>
        )}
        {mastery.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-medium text-foreground/80">各知识点掌握度</div>
            <MasteryBars points={mastery.slice(0, 8)} />
          </div>
        )}
      </div>
    );
  }

  // ③ 学习进度：掌握度进度条
  if (d.mastery && Array.isArray(d.mastery)) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-4">
          <StatCards stats={[
            { label: "变式正确率", value: `${d.variantAccuracy ?? 0}%`, color: "#188038" },
            { label: "错题清零率", value: `${d.wrongCleared ?? 0}%`, color: "#1a73e8" },
          ]} />
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium text-foreground/80">掌握度</div>
          <MasteryBars points={d.mastery.slice(0, 8)} />
        </div>
      </div>
    );
  }

  return null;
}
