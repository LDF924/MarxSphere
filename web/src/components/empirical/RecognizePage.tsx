// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// RecognizePage.tsx — 问卷上传识别（V380+）: 文本 → 主体/指标/变量结构
import { useState } from "react";
import { ScanSearch, FileUp, Loader2, FileText } from "lucide-react";
import { apiEmpiricalWorkshop, apiEmpiricalDemo, type Question } from "../../lib/api";
import { QuestionForm } from "./QuestionForm";
import { Button } from "../ui/button";

export function RecognizePage({ projectId }: { projectId?: string }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
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
