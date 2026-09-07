// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// RecognizePage.tsx — 问卷上传识别（V380+）: 文本 → 主体/指标/变量结构
import { useState } from "react";
import { ScanSearch, FileUp, Loader2, FileText, Wand2 } from "lucide-react";
import { apiEmpiricalWorkshop, apiEmpiricalDemo, type Question } from "../../lib/api";
import { QuestionForm } from "./QuestionForm";
import { Button } from "../ui/button";
import { bufferToBase64 } from "../../lib/utils";

export function RecognizePage({ projectId, onSimLoaded }: {
  projectId?: string;
  /** V413: 仿真数据生成后回调(把数据载入下游工作台页面) */
  onSimLoaded?: (data: { columnOrder: string[]; rows: (string | number | null)[][] }) => void;
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // V413: 仿真状态
  const [qidSaved, setQidSaved] = useState<string | null>(null);
  const [simN, setSimN] = useState(200);
  const [simMissing, setSimMissing] = useState(true);
  const [simBusy, setSimBusy] = useState(false);
  const [simResult, setSimResult] = useState<{ n: number; cols: number } | null>(null);
  const [simError, setSimError] = useState("");
  const [simData, setSimData] = useState<{ columnOrder: string[]; rows: (string | number | null)[][] } | null>(null);
  // 轮询任务结果
  const pollResult = async (taskId: string, onDone: (r: any) => void): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      const r = await apiEmpiricalWorkshop.taskResult(taskId);
      if (r.status === "done") { onDone(r.result); return; }
      if (r.status === "error") throw new Error(r.error ?? "任务失败");
    }
    throw new Error("任务超时(90s)");
  };
  const runSimulate = async () => {
    if (!questions?.length) return;
    setSimBusy(true); setSimError(""); setSimResult(null); setSimData(null);
    try {
      // 优先用已落库问卷 ID(保留识别后跳转/结构), 否则直接传当前结构
      const body = qidSaved
        ? { projectId, questionnaireId: qidSaved, params: { n: simN, seed: 42, missing: simMissing ? { cols: ["moral_behavior_4"], rate: 0.1 } : undefined } }
        : { projectId, questionnaire: questions, params: { n: simN, seed: 42 } };
      const r = await apiEmpiricalWorkshop.simulateData(body as any);
      if (!r.ok) throw new Error(r.error ?? "生成失败");
      await pollResult(r.taskId!, (res) => {
        const data = res?.data;
        if (!data) throw new Error("结果无数据");
        setSimResult({ n: (res.meta?.n ?? 0) as number, cols: data.columnOrder.length });
        setSimData(data);
      });
    } catch (e: any) {
      setSimError(e?.message ?? "仿真生成失败");
    } finally { setSimBusy(false); }
  };

  const recognize = async () => {
    if (!text.trim()) { setError("请粘贴问卷文本"); return; }
    setBusy(true); setError(""); setQuestions(null);
    try {
      const r = await apiEmpiricalWorkshop.recognizeQuestionnaire({
        projectId, title: title || "上传问卷", rawText: text,
      });
      if (r.ok) {
        setQuestions(r.questionnaire.questions);
        setMeta(r.questionnaire.meta);
        setQidSaved(r.questionnaire.id);
        setSimResult(null);
      }
    } catch (e: any) {
      setError(e?.message ?? "识别失败");
    } finally { setBusy(false); }
  };

  const handleFile = async (f: File) => {
    // V412: 支持 PDF/Word/Excel/PPT 上传 — 服务端 Python 解析转文本
    const ext = f.name.toLowerCase().split(".").pop() || "";
    const binaryTypes = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"];
    if (binaryTypes.includes(ext)) {
      setBusy(true); setError("");
      try {
        const buf = await f.arrayBuffer();
        const base64 = await bufferToBase64(buf);
        const r = await apiEmpiricalWorkshop.parseQuestionnaireFile({ fileName: f.name, base64 });
        if (r.ok) { setText(r.text); setTitle(f.name.replace(/\.[^.]+$/, "")); }
        else setError(r.error ?? "解析失败");
      } catch (e: any) {
        setError(e?.message ?? "文件解析失败（文件过大？）");
      } finally { setBusy(false); }
      return;
    }
    // 文本类 → 前端直接读
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.readAsText(f, "utf-8");
  };

  const typeCount = (t: string) => (questions ?? []).filter((q) => q.type === t).length;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-2 flex items-center gap-2">
          <ScanSearch className="h-4 w-4 text-emerald-600" />
          <span className="text-xs font-semibold">问卷上传识别</span>
          <span className="text-[10px] text-muted-foreground">粘贴/上传问卷文本 → 自动识别主体、指标、变量结构(题号/题干/选项/类型/跳转)</span>
          <button
            onClick={async () => {
              setBusy(true); setError("");
              try {
                const r = await apiEmpiricalDemo.questionnaireText();
                if (r.ok && r.text) { setTitle("农村经营形态调查问卷(演示)"); setText(r.text); }
                else setError(r.error ?? "载入失败");
              } catch (e: any) { setError(e?.message ?? "载入失败"); }
              finally { setBusy(false); }
            }}
            disabled={busy}
            title="载入《农村经营形态调查问卷(最终打印版).pdf》提取的文本(16页 167题), 再点「开始识别」"
            className="ml-auto flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] hover:bg-accent disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3 text-emerald-600" />}
            {busy ? "载入中…" : "载入真实问卷文本"}
          </button>
        </div>
        <div className="mb-2 flex gap-2">
          <input className="flex-1 rounded-md border bg-background px-2 py-1.5 text-[11px]" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="问卷标题(可选)" />
          <label className="flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] hover:bg-accent">
            <FileUp className="h-3 w-3" /> 上传问卷文件
            <input type="file" accept=".txt,.md,.csv,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
          </label>
        </div>
        <textarea
          className="h-48 w-full rounded-md border bg-background p-2 font-mono text-[11px]"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="粘贴问卷文本(题号/题干/选项, 可直接粘贴 PDF 提取的文本)…"
        />
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" onClick={() => void recognize()} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <ScanSearch className="mr-1 h-3 w-3" />}
            {busy ? "识别中…(长问卷约60-120s)" : "开始识别"}
          </Button>
          <span className="text-[10px] text-muted-foreground">{text.length.toLocaleString()} 字符</span>
        </div>
        {error && <div className="mt-2 text-[11px] text-red-600">❌ {error}</div>}
      </div>

      {meta && (
        <div className="rounded-lg border bg-card p-2">
          <div className="text-[10px]"><span className="font-semibold text-muted-foreground">主体: </span>{String(meta.subject ?? "")}</div>
          <div className="mt-0.5 text-[10px]"><span className="font-semibold text-muted-foreground">指标: </span>{(meta.indicators ?? []).join(" / ")}</div>
        </div>
      )}

      {questions && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-[11px] font-semibold">
            识别结果 ({questions.length} 题)
            <span className="rounded bg-blue-100 px-1 text-[9px] text-blue-700">分类 {typeCount("cat")}</span>
            <span className="rounded bg-violet-100 px-1 text-[9px] text-violet-700">有序 {typeCount("ordinal")}</span>
            <span className="rounded bg-emerald-100 px-1 text-[9px] text-emerald-700">连续 {typeCount("cont")}</span>
            <span className="rounded bg-amber-100 px-1 text-[9px] text-amber-700">多选 {typeCount("multi")}</span>
            <span className="rounded bg-gray-100 px-1 text-[9px] text-gray-700">文本 {typeCount("text")}</span>
          </div>

          {/* V413: 仿真数据生成(按当前识别结构) */}
          {qidSaved && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50/50 p-2 dark:border-emerald-800 dark:bg-emerald-950/20">
              <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">🧪 仿真数据</span>
              <span className="text-[10px] text-muted-foreground">按 {questions.length} 题结构生成模拟作答(可勾选挖缺, 自动处理跳答 -99):</span>
              <input type="number" min={10} max={5000} value={simN}
                onChange={(e) => setSimN(Math.min(5000, Math.max(10, Number(e.target.value) || 100)))}
                className="w-20 rounded-md border bg-background px-1.5 py-0.5 text-[11px]" title="样本量" />
              <span className="text-[10px] text-muted-foreground">份</span>
              <label className="flex items-center gap-1 text-[10px]">
                <input type="checkbox" checked={simMissing} onChange={(e) => setSimMissing(e.target.checked)} />
                挖缺10% <span className="text-muted-foreground">(行为维度末题, 供插补演示)</span>
              </label>
              <Button size="sm" variant="outline" onClick={() => void runSimulate()} disabled={simBusy} className="h-6 text-[10px]">
                {simBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Wand2 className="mr-1 h-3 w-3 text-emerald-600" />}
                {simBusy ? "生成中…" : "生成仿真数据"}
              </Button>
              {simResult && (
                <span className="text-[10px] text-emerald-700 dark:text-emerald-400">
                  ✓ 已生成 {simResult.n} 份 × {simResult.cols} 列
                  <button className="ml-2 underline" onClick={() => onSimLoaded?.(simData!)}>载入工作台分析</button>
                </span>
              )}
              {simError && <span className="text-[10px] text-red-600">❌ {simError}</span>}
            </div>
          )}
          <div className="max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
            {questions.slice(0, 150).map((q, i) => (
              <QuestionForm key={i} q={q} />
            ))}
            {questions.length > 150 && <div className="text-center text-[10px] text-muted-foreground">…共 {questions.length} 题, 仅展示前 150</div>}
          </div>
        </div>
      )}
    </div>
  );
}
