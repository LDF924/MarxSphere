// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// StructurePanel.tsx — 论文结构解析面板（2026-08-29, Agentero 对照: 解析论文中的图/表/公式/算法并结合上下文理解）
// 可视化: 输入论文文本 → 自动定位图/表/公式/算法 → 四类 tab 分览 + 每块一键 AI 理解
import { useState } from "react";
import { Image, Table2, Sigma, Workflow, Loader2, Sparkles, FileText } from "lucide-react";

interface PaperBlock {
  kind: "figure" | "table" | "formula" | "algorithm";
  label: string;
  content: string;
  contextBefore: string;
  contextAfter: string;
}

const KIND_META: Record<PaperBlock["kind"], { label: string; icon: any; color: string }> = {
  figure: { label: "图", icon: Image, color: "text-sky-600 bg-sky-500/10 border-sky-500/30" },
  table: { label: "表", icon: Table2, color: "text-emerald-600 bg-emerald-500/10 border-emerald-500/30" },
  formula: { label: "公式", icon: Sigma, color: "text-violet-600 bg-violet-500/10 border-violet-500/30" },
  algorithm: { label: "算法", icon: Workflow, color: "text-amber-600 bg-amber-500/10 border-amber-500/30" },
};

export function StructurePanel() {
  const [input, setInput] = useState("");
  const [blocks, setBlocks] = useState<PaperBlock[]>([]);
  const [tab, setTab] = useState<PaperBlock["kind"] | "all">("all");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [explaining, setExplaining] = useState<string | null>(null);
  const [explanations, setExplanations] = useState<Record<string, string>>({});

  const parse = async () => {
    if (input.trim().length < 10) { setNotice({ type: "err", text: "请输入至少 10 字论文文本" }); return; }
    setBusy(true);
    setNotice(null);
    setExplanations({});
    try {
      const r = await fetch("/api/papers/structure", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: input }),
      }).then((x) => x.json());
      const ov = r?.overview;
      if (!ov) { setNotice({ type: "err", text: r?.error?.message || "解析失败" }); return; }
      const all: PaperBlock[] = [
        ...(ov.figures || []), ...(ov.tables || []), ...(ov.formulas || []), ...(ov.algorithms || []),
      ];
      setBlocks(all);
      setTab("all");
      setNotice({ type: "ok", text: `定位到 ${all.length} 个结构化块（图 ${(ov.figures || []).length} · 表 ${(ov.tables || []).length} · 公式 ${(ov.formulas || []).length} · 算法 ${(ov.algorithms || []).length}）` });
    } catch (e: any) { setNotice({ type: "err", text: e?.message || "解析失败" }); }
    setBusy(false);
  };

  const explain = async (b: PaperBlock) => {
    if (explanations[b.label]) return;
    setExplaining(b.label);
    try {
      const r = await fetch("/api/papers/structure/explain", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ block: b }),
      }).then((x) => x.json());
      if (r?.ok) setExplanations((p) => ({ ...p, [b.label]: r.result }));
      else setExplanations((p) => ({ ...p, [b.label]: `❌ ${r?.error || "理解失败"}` }));
    } catch (e: any) { setExplanations((p) => ({ ...p, [b.label]: `❌ ${e?.message || "理解失败"}` })); }
    setExplaining(null);
  };

  const counts = (kind: PaperBlock["kind"]) => blocks.filter((b) => b.kind === kind).length;
  const shown = blocks.filter((b) => tab === "all" || b.kind === tab);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 头部 */}
      <div className="flex items-center gap-2">
        <Workflow className="h-5 w-5 text-violet-500" />
        <h2 className="text-lg font-semibold">论文结构解析</h2>
        <span className="text-xs text-muted-foreground">图 / 表 / 公式 / 算法定位 + AI 上下文理解</span>
      </div>

      {/* 输入区 */}
      <div className="flex flex-col rounded-xl border bg-card/60 p-4">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium">
          <FileText className="h-3.5 w-3.5 text-violet-500" /> 论文文本（可粘贴 OCR 结果 / Markdown / 纯文本）
        </div>
        <textarea value={input} onChange={(e) => setInput(e.target.value)}
          placeholder={"粘贴论文全文文本…\n\n例如：\nFigure 1: 实验流程图…\nTable 2: 各模型性能对比…\n如公式 (3) 所示…\nAlgorithm 1: 训练流程…"}
          className="h-36 w-full resize-y rounded-lg border bg-background/60 p-3 font-mono text-[11px] leading-relaxed outline-none focus:border-violet-500/50" />
        <div className="mt-2 flex items-center gap-2">
          <button type="button" onClick={() => void parse()} disabled={busy}
            className="flex items-center gap-1 rounded-lg bg-violet-600 px-4 py-2 text-[11px] font-medium text-white transition-all hover:bg-violet-700 disabled:opacity-40">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {busy ? "解析中…" : "解析结构"}
          </button>
          <button type="button" onClick={() => { setInput(""); setBlocks([]); setExplanations({}); setNotice(null); }}
            className="rounded-lg border px-3 py-2 text-[11px] text-muted-foreground hover:bg-accent">清空</button>
          {notice && (
            <span className={`ml-auto rounded px-2 py-1 text-[10px] ${notice.type === "ok" ? "bg-green-500/10 text-green-700" : "bg-red-500/10 text-red-600"}`}>
              {notice.text}
            </span>
          )}
        </div>
      </div>

      {/* 统计卡 */}
      {blocks.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {(Object.keys(KIND_META) as PaperBlock["kind"][]).map((kind) => {
            const meta = KIND_META[kind];
            const Icon = meta.icon;
            const active = tab === kind;
            return (
              <button key={kind} type="button" onClick={() => setTab(active ? "all" : kind)}
                className={`flex items-center gap-2 rounded-xl border p-3 text-left transition-all ${meta.color} ${active ? "ring-2 ring-current" : "opacity-80 hover:opacity-100"}`}>
                <Icon className="h-5 w-5" />
                <div>
                  <div className="text-lg font-bold leading-none">{counts(kind)}</div>
                  <div className="text-[10px] opacity-80">{meta.label} · 点击{active ? "取消" : "筛选"}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* 块列表 */}
      {shown.length > 0 && (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {shown.map((b, i) => {
            const meta = KIND_META[b.kind];
            const Icon = meta.icon;
            const expl = explanations[b.label];
            return (
              <div key={`${b.label}-${i}`} className="rounded-xl border bg-card/60 p-3">
                <div className="flex items-start gap-2">
                  <span className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium ${meta.color}`}>
                    <Icon className="h-3 w-3" /> {b.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-muted-foreground">{b.content}</pre>
                    {b.contextBefore && (
                      <div className="mt-1.5 border-l-2 border-border/40 pl-2 text-[9px] text-muted-foreground/70">
                        <span className="font-medium">前文：</span>{b.contextBefore}
                        {b.contextAfter ? <><br /><span className="font-medium">后文：</span>{b.contextAfter}</> : null}
                      </div>
                    )}
                  </div>
                  <button type="button" onClick={() => void explain(b)} disabled={!!explaining}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-1.5 text-[10px] font-medium text-violet-700 hover:bg-violet-500/20 disabled:opacity-40">
                    {explaining === b.label ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                    {expl ? "已理解" : "AI 理解"}
                  </button>
                </div>
                {expl && (
                  <div className="mt-2 rounded-lg border border-violet-500/20 bg-violet-500/5 p-2.5 text-[11px] leading-relaxed text-violet-900">
                    <div className="mb-1 text-[9px] font-semibold text-violet-600">AI 理解 · {b.label}</div>
                    <div className="whitespace-pre-wrap">{expl}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {blocks.length === 0 && !busy && (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed bg-card/30">
          <div className="text-center text-[11px] text-muted-foreground">
            <Workflow className="mx-auto mb-2 h-8 w-8 opacity-40" />
            粘贴论文文本后点「解析结构」<br />
            自动定位 Figure / Table / 公式编号 / Algorithm
          </div>
        </div>
      )}
    </div>
  );
}
