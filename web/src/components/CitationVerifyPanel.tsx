// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// CitationVerifyPanel.tsx — V399: 引文三维核验面板 (citation-lab 方法论移植)
// 输入: 断言句 + 参考文献 (DOI/标题) + 引用上下文
// 输出: 三维核验结果卡 (元数据真伪/语境相关性/断言支持度) + 整体状态
import { useState, type FC } from "react";
import { Loader2, ShieldCheck, ShieldAlert, ShieldQuestion, SearchCheck, Link2, FileText, CheckCircle2 } from "lucide-react";
import { cn } from "../lib/utils";

interface DimensionResult {
  status: "green" | "yellow" | "white" | "red";
  label: string;
  score: number;
  reason: string;
}

interface VerifyResponse {
  ok: boolean;
  dimensions?: {
    metadata: DimensionResult;
    relevance: DimensionResult;
    support: DimensionResult;
  };
  overall?: { status: string; score: number };
  error?: string;
}

const STATUS_META: Record<string, { color: string; bg: string; label: string }> = {
  green: { color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/30", label: "通过" },
  yellow: { color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/30", label: "存疑" },
  white: { color: "text-slate-400", bg: "bg-slate-500/10 border-slate-500/30", label: "无法判定" },
  red: { color: "text-red-400", bg: "bg-red-500/10 border-red-500/30", label: "疑似问题" },
};

function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] || STATUS_META.white;
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", m.bg, m.color)}>
      {m.label}
    </span>
  );
}

function DimensionCard({ title, icon, dim }: { title: string; icon: React.ReactNode; dim?: DimensionResult }) {
  if (!dim) return null;
  const m = STATUS_META[dim.status] || STATUS_META.white;
  return (
    <div className={cn("rounded-lg border p-3", m.bg)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          {icon}
          {title}
        </div>
        <div className="flex items-center gap-2">
          <span className={cn("text-sm font-bold", m.color)}>{dim.score.toFixed(2)}</span>
          <StatusBadge status={dim.status} />
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{dim.reason}</p>
    </div>
  );
}

export const CitationVerifyPanel: FC = () => {
  const [claim, setClaim] = useState("");
  const [doi, setDoi] = useState("");
  const [title, setTitle] = useState("");
  const [context, setContext] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VerifyResponse | null>(null);

  const run = async () => {
    if (!claim.trim() || claim.trim().length < 5) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/citations/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claim: claim.trim(),
          referenceDoi: doi.trim() || undefined,
          referenceTitle: title.trim() || undefined,
          context: context.trim() || undefined,
        }),
      });
      const text = await res.text();
      setResult(JSON.parse(text));
    } catch (e: any) {
      setResult({ ok: false, error: String(e?.message || e).slice(0, 200) });
    } finally {
      setLoading(false);
    }
  };

  const overall = result?.overall;

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto w-full max-w-[1200px] space-y-4">
      <div className="flex items-center gap-2">
        <SearchCheck className="h-4 w-4 text-violet-400" />
        <h2 className="text-sm font-semibold">引文三维核验</h2>
        <span className="text-[10px] text-muted-foreground">元数据真伪 · 语境相关性 · 断言支持度</span>
      </div>

      {/* 输入区 */}
      <div className="rounded-lg border bg-card p-4">
        {/* 断言 */}
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-medium text-foreground/80">断言句（引用所在句, 必填）</span>
          <textarea
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
            placeholder="如：该研究利用野外监测数据揭示了全球飞行昆虫生物量在27年间下降超过75%"
            rows={2}
            className="w-full rounded-md border bg-background px-3 py-2 text-xs leading-5"
          />
        </label>

        {/* 参考文献 */}
        <div className="mt-4 border-t border-border/60 pt-4">
          <div className="mb-2 text-[11px] font-medium text-foreground/80">参考文献</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[10px] text-muted-foreground">DOI（可选, 优先）</span>
              <input
                value={doi}
                onChange={(e) => setDoi(e.target.value)}
                placeholder="10.1371/journal.pone.0185809"
                className="w-full rounded-md border bg-background px-3 py-2 text-xs"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] text-muted-foreground">标题（可选）</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="论文标题（无 DOI 时用于检索）"
                className="w-full rounded-md border bg-background px-3 py-2 text-xs"
              />
            </label>
          </div>
        </div>

        {/* 上下文 */}
        <div className="mt-4 border-t border-border/60 pt-4">
          <label className="block">
            <span className="mb-1 block text-[10px] text-muted-foreground">引用上下文段落（可选, 提升相关性判定）</span>
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="该引用所在段落的上下文…"
              rows={2}
              className="w-full rounded-md border bg-background px-3 py-2 text-xs leading-5"
            />
          </label>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            onClick={run}
            disabled={loading || claim.trim().length < 5}
            className="flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
            {loading ? "核验中…" : "开始核验"}
          </button>
        </div>
      </div>

      {/* 结果区 */}
      {result?.error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
          {result.error}
        </div>
      )}

      {overall && result?.dimensions && (
        <div className="space-y-3">
          {/* 整体状态 */}
          <div className="flex items-center justify-between rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2 text-xs font-semibold">
              {overall.status === "green" ? (
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
              ) : overall.status === "red" ? (
                <ShieldAlert className="h-4 w-4 text-red-400" />
              ) : (
                <ShieldQuestion className="h-4 w-4 text-amber-400" />
              )}
              整体判定
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold">{overall.score.toFixed(3)}</span>
              <StatusBadge status={overall.status} />
            </div>
          </div>

          {/* 三维结果 */}
          <DimensionCard title="① 元数据真伪" icon={<Link2 className="h-3.5 w-3.5" />} dim={result.dimensions.metadata} />
          <DimensionCard title="② 语境相关性" icon={<FileText className="h-3.5 w-3.5" />} dim={result.dimensions.relevance} />
          <DimensionCard title="③ 断言支持度" icon={<CheckCircle2 className="h-3.5 w-3.5" />} dim={result.dimensions.support} />
        </div>
      )}
      </div>
    </section>
  );
};
