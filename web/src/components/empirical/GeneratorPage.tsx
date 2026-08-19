// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// GeneratorPage.tsx — 问卷生成器（V380+）: 课题 → 结构化问卷
import { useState } from "react";
import { Wand2, Loader2, Sparkles } from "lucide-react";
import { apiEmpiricalWorkshop, type Question } from "../../lib/api";
import { QuestionForm } from "./QuestionForm";
import { Button } from "../ui/button";

// 演示: 农村经营形态课题(与真实问卷 PDF 同主题)
const DEMO_TOPIC = "二轮承包到期后农户调地意愿的影响因素研究(农村土地流转与经营形态)";
const DEMO_EXTRA = "需要包含: 身份特征(种植小户/家庭农场主/合作社负责人)、土地流转(转出/转入面积与租金)、种地意愿(1-5有序)、政策感知(补贴/保险/电商)维度";

export function GeneratorPage({ projectId }: { projectId?: string }) {
  const [topic, setTopic] = useState("");
  const [extra, setExtra] = useState("");
  const [nQuestions, setNQuestions] = useState(20);
  const [title, setTitle] = useState("");
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const generate = async () => {
    if (!topic.trim()) { setError("请输入课题"); return; }
    setBusy(true); setError(""); setQuestions(null);
    try {
      const r = await apiEmpiricalWorkshop.generateQuestionnaire({
        projectId, title: title || "未命名问卷", topic, extra: extra || undefined, nQuestions,
      });
      if (r.ok) {
        setQuestions(r.questionnaire.questions);
        setMeta(r.questionnaire.meta);
        setSavedId(r.questionnaire.id);
      }
    } catch (e: any) {
      setError(e?.message ?? "生成失败");
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-2 flex items-center gap-2">
          <Wand2 className="h-4 w-4 text-emerald-600" />
          <span className="text-xs font-semibold">问卷生成器</span>
          <span className="text-[10px] text-muted-foreground">输入课题 → LLM 生成结构化问卷(题号/变量名/题干/选项/类型/跳转)</span>
          <button
            onClick={() => { setTitle("农户调地意愿问卷(演示)"); setTopic(DEMO_TOPIC); setExtra(DEMO_EXTRA); setNQuestions(20); }}
            title="填入农村经营形态课题示例(与真实问卷 PDF 同主题), 点「生成问卷」即可"
            className="ml-auto flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] hover:bg-accent"
          >
            <Sparkles className="h-3 w-3 text-emerald-600" /> 填入示例课题
          </button>
        </div>
        <label className="mb-2 block">
          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">课题标题</span>
          <input className="w-full rounded-md border bg-background px-2 py-1.5 text-[11px]" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如: 农户调地意愿问卷" />
        </label>
        <label className="mb-2 block">
          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">研究课题 *</span>
          <textarea className="h-20 w-full rounded-md border bg-background p-2 text-[11px]" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="如: 二轮承包到期后农户调地意愿的影响因素研究" />
        </label>
        <div className="mb-2 flex gap-2">
          <label className="block flex-1">
            <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">补充要求(可选)</span>
            <input className="w-full rounded-md border bg-background px-2 py-1.5 text-[11px]" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="如: 需要包含土地流转、农资购买维度" />
          </label>
          <label className="block w-32">
            <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">题数</span>
            <select className="w-full rounded-md border bg-background px-2 py-1.5 text-[11px]" value={nQuestions} onChange={(e) => setNQuestions(Number(e.target.value))}>
              {[10, 15, 20, 30, 40, 50].map((n) => <option key={n} value={n}>{n} 题</option>)}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void generate()} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Wand2 className="mr-1 h-3 w-3" />}
            {busy ? "生成中…(约30-60s)" : "生成问卷"}
          </Button>
          {savedId && <span className="text-[10px] text-emerald-600">已保存 (id: {savedId.slice(0, 8)})</span>}
        </div>
        {error && <div className="mt-2 text-[11px] text-red-600">❌ {error}</div>}
      </div>

      {meta && (
        <div className="rounded-lg border bg-card p-2">
          <span className="text-[10px] font-semibold text-muted-foreground">变量维度: </span>
          <span className="text-[10px]">{(meta.dimensions ?? []).join(" / ")}</span>
        </div>
      )}

      {questions && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold">生成结果 ({questions.length} 题, 点击题目可编辑)</div>
          <div className="max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
            {questions.map((q, i) => (
              <QuestionForm key={i} q={q} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
