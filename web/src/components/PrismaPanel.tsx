// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// PrismaPanel.tsx — PRISMA 系统综述工作台(参考 Elicit sysreview 机制)
// 阶段流: ①输入主题→检索文献库 ②LLM 筛选(可人工改判定+理由) ③PRISMA 流程摘要+纳入集
import { useState } from "react";
import { Filter, Loader2, ListChecks, Search, Workflow } from "lucide-react";

interface Paper { id: string; title: string; year?: string }
interface Decision { verdict: "included" | "excluded"; reason?: string }
interface Summary { identified: number; screened: number; excluded: number; included: number; flowText: string }

export function PrismaPanel() {
  const [topic, setTopic] = useState("");
  const [stage, setStage] = useState<"input" | "search" | "screen" | "done">("input");
  const [papers, setPapers] = useState<Paper[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [summary, setSummary] = useState<Summary | null>(null);
  const [searchTotal, setSearchTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [showExcluded, setShowExcluded] = useState(true);

  const doSearch = async () => {
    if (topic.trim().length < 2) { setMsg("主题至少 2 字"); return; }
    setLoading(true); setMsg(""); setDecisions({}); setSummary(null);
    try {
      const res = await fetch("/api/prisma/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, limit: 30 }),
      });
      const d = await res.json();
      if (!res.ok) { setMsg(d?.error?.message ?? "检索失败"); return; }
      setPapers(d.papers ?? []); setSearchTotal(d.total ?? 0);
      setStage("screen");
      setMsg(`✅ 检索识别 ${d.total ?? 0} 篇, 开始筛选(点「AI 筛选」或人工逐条判定)`);
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  const doScreen = async () => {
    setLoading(true); setMsg("");
    try {
      const res = await fetch("/api/prisma/screen", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, papers }),
      });
      const d = await res.json();
      if (!res.ok) { setMsg(d?.error?.message ?? "筛选失败"); return; }
      setDecisions(d.decisions ?? {});
      setSummary(d.summary ?? null);
      setStage("done");
      setMsg(`✅ 筛选完成: 纳入 ${d.summary?.included ?? 0} / 排除 ${d.summary?.excluded ?? 0}`);
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  const setVerdict = (paperId: string, verdict: "included" | "excluded") => {
    setDecisions((prev) => ({ ...prev, [paperId]: { ...(prev[paperId] ?? {}), verdict } }));
  };
  const setReason = (paperId: string, reason: string) => {
    setDecisions((prev) => ({ ...prev, [paperId]: { ...(prev[paperId] ?? {}), reason } }));
  };
  // 人工改后重算摘要
  const recalcSummary = () => {
    const ids = papers.filter((p) => decisions[p.id]).map((p) => p.id);
    const included = ids.filter((id) => decisions[id]?.verdict === "included").length;
    const excluded = ids.length - included;
    setSummary({
      identified: searchTotal, screened: ids.length, excluded, included,
      flowText: [
        `检索识别: ${searchTotal} 篇(文献库, ${new Date().toLocaleDateString("zh-CN")})`,
        `标题筛选: ${ids.length} 篇`,
        `排除: ${excluded} 篇(理由见判定表)`,
        `纳入综述: ${included} 篇`,
      ].join("\n"),
    });
    setMsg("已按人工判定重算 PRISMA 摘要");
  };

  const includedIds = new Set(papers.filter((p) => decisions[p.id]?.verdict === "included").map((p) => p.id));

  return (
    <section className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1300px] space-y-4 p-4">
      {/* 标题行 */}
      <div className="flex flex-wrap items-center gap-2">
        <Workflow className="h-5 w-5 text-emerald-300" />
        <h2 className="text-lg font-semibold">PRISMA 系统综述工作台</h2>
        <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-300">
          检索 → 标题筛选 → 纳入集
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground/50">参考 Elicit 系统综述机制 · 每步判定可审计</span>
      </div>

      {/* 引导卡片(点击跳阶段) */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        {[
          { s: "input", icon: "①", title: "输入综述主题", desc: "填主题(如资本下乡的治理效应), 从文献库检索" },
          { s: "search", icon: "②", title: "检索文献", desc: "关键词匹配文献库, 记录检索命中数" },
          { s: "screen", icon: "③", title: "标题筛选", desc: "AI 逐篇判 纳入/排除+理由, 可人工改" },
          { s: "done", icon: "④", title: "纳入集 + PRISMA 摘要", desc: "统计 识别/筛选/排除/纳入, 得纳入综述集" },
        ].map((g) => {
          const active = g.s === stage;
          const reachable = ["input", "search", "screen", "done"].indexOf(g.s) <= ["input", "search", "screen", "done"].indexOf(stage === "done" ? "done" : stage);
          return (
            <button key={g.s} type="button"
              onClick={() => { if (g.s === "search" && !loading) setStage("input"); else if (g.s !== "input" && papers.length > 0) { /* 已到过前阶段才可跳 */ setStage(g.s as never); } }}
              className={`rounded-lg border p-2.5 text-left transition-colors ${active ? "border-emerald-400/60 bg-emerald-400/10" : "border-border/60 bg-card/40 hover:bg-accent/30"}`}>
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <span className="text-sm">{g.icon}</span> {g.title}
                {active && <span className="ml-auto rounded bg-emerald-400/20 px-1 py-0.5 text-[9px] text-emerald-300">当前</span>}
              </div>
              <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground/70">{g.desc}</p>
            </button>
          );
        })}
      </div>

      <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/[0.03] p-3">
      {/* 阶段指示 */}
      <div className="mt-2 flex items-center gap-1 text-[10px]">
        {(["input", "search", "screen", "done"] as const).map((s, i) => (
          <div key={s} className="flex items-center gap-1">
            <span className={`flex h-5 w-5 items-center justify-center rounded-full ${stage === s || (i < (["input", "search", "screen", "done"] as const).indexOf(stage)) ? "bg-emerald-400/20 text-emerald-300" : "bg-background/40 text-muted-foreground/50"}`}>{i + 1}</span>
            <span className={stage === s ? "text-emerald-300" : "text-muted-foreground/60"}>
              {s === "input" ? "输入主题" : s === "search" ? "检索中" : s === "screen" ? "筛选" : "纳入集"}
            </span>
            {i < 3 && <span className="mx-0.5 text-muted-foreground/30">→</span>}
          </div>
        ))}
      </div>

      {/* ① 主题输入 */}
      {stage === "input" && (
        <div className="mt-3 flex gap-2">
          <input value={topic} onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSearch()}
            placeholder="综述主题, 如: 资本下乡的乡村治理效应(将从文献库检索)"
            className="h-8 min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 text-xs outline-none focus:border-emerald-400/50" />
          <button type="button" onClick={doSearch} disabled={loading}
            className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-3 text-xs font-medium text-white hover:bg-emerald-400 disabled:opacity-40">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />} 检索文献库
          </button>
        </div>
      )}

      {/* ② 筛选 */}
      {stage === "screen" && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <ListChecks className="h-3.5 w-3.5" /> 检索到 {searchTotal} 篇 — 点「AI 标题筛选」或人工点选判定
            <button type="button" onClick={doScreen} disabled={loading}
              className="ml-auto inline-flex items-center gap-1 rounded-md bg-emerald-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-400 disabled:opacity-40">
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Filter className="h-3 w-3" />} AI 标题筛选
            </button>
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto rounded border border-border/40 bg-background/20 p-1.5">
            {papers.map((p) => {
              const d = decisions[p.id];
              return (
                <div key={p.id} className="flex flex-wrap items-center gap-1.5 rounded px-1.5 py-1 text-[11px] hover:bg-accent/20">
                  <button type="button" onClick={() => setVerdict(p.id, d?.verdict === "included" ? "excluded" : "included")}
                    className={`min-w-0 max-w-[45%] flex-1 truncate text-left ${d?.verdict === "excluded" ? "text-muted-foreground/60 line-through" : ""}`}>
                    {p.title}{p.year ? `(${p.year})` : ""}
                  </button>
                  <span className="flex gap-1">
                    <button type="button" onClick={() => setVerdict(p.id, "included")}
                      className={`rounded px-1.5 py-0.5 text-[9px] ${d?.verdict === "included" ? "bg-emerald-400/20 text-emerald-300" : "text-muted-foreground/50 hover:text-emerald-300"}`}>纳入</button>
                    <button type="button" onClick={() => setVerdict(p.id, "excluded")}
                      className={`rounded px-1.5 py-0.5 text-[9px] ${d?.verdict === "excluded" ? "bg-red-400/20 text-red-300" : "text-muted-foreground/50 hover:text-red-300"}`}>排除</button>
                  </span>
                  {d?.verdict === "excluded" && (
                    <input value={d.reason ?? ""} onChange={(e) => setReason(p.id, e.target.value)}
                      placeholder="排除理由…" className="h-5 w-32 rounded border border-border/50 bg-background px-1 text-[9px] outline-none" />
                  )}
                </div>
              );
            })}
          </div>
          {Object.keys(decisions).length > 0 && (
            <button type="button" onClick={recalcSummary}
              className="rounded-md border border-emerald-400/30 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-400/10">生成 PRISMA 摘要</button>
          )}
        </div>
      )}

      {/* ③ 结果 */}
      {stage === "done" && summary && (
        <div className="mt-3 space-y-2">
          <div className="grid grid-cols-4 gap-2 text-center">
            <div className="rounded border border-border/40 bg-background/30 py-1.5">
              <div className="text-lg font-bold text-sky-300">{summary.identified}</div>
              <div className="text-[9px] text-muted-foreground">检索识别</div>
            </div>
            <div className="rounded border border-border/40 bg-background/30 py-1.5">
              <div className="text-lg font-bold text-amber-300">{summary.screened}</div>
              <div className="text-[9px] text-muted-foreground">标题筛选</div>
            </div>
            <div className="rounded border border-border/40 bg-background/30 py-1.5">
              <div className="text-lg font-bold text-red-300">{summary.excluded}</div>
              <div className="text-[9px] text-muted-foreground">排除</div>
            </div>
            <div className="rounded border border-border/40 bg-background/30 py-1.5">
              <div className="text-lg font-bold text-emerald-300">{summary.included}</div>
              <div className="text-[9px] text-muted-foreground">纳入综述</div>
            </div>
          </div>
          <pre className="rounded border border-border/40 bg-black/15 p-2 font-mono text-[10px] leading-4 text-muted-foreground">{summary.flowText}</pre>

          {/* 纳入集 */}
          <div className="text-[11px] font-medium text-emerald-300">纳入综述集({summary.included} 篇)</div>
          <div className="max-h-40 space-y-0.5 overflow-y-auto">
            {papers.filter((p) => includedIds.has(p.id)).map((p) => (
              <div key={p.id} className="rounded bg-emerald-400/5 px-2 py-1 text-[11px]">✓ {p.title}</div>
            ))}
          </div>
          {!showExcluded && (
            <div className="max-h-32 space-y-0.5 overflow-y-auto">
              {papers.filter((p) => !includedIds.has(p.id)).map((p) => (
                <div key={p.id} className="rounded bg-red-400/5 px-2 py-1 text-[10px] text-muted-foreground">
                  ✗ {p.title} <span className="text-red-300/60">[{decisions[p.id]?.reason ?? ""}]</span>
                </div>
              ))}
            </div>
          )}
          <button type="button" onClick={() => setShowExcluded((v) => !v)}
            className="text-[10px] text-muted-foreground/60 hover:text-foreground">切换显示排除列表</button>
        </div>
      )}

      {msg && <div className="mt-2 text-[11px] text-muted-foreground">{msg}</div>}
      </div>
      </div>
    </section>
  );
}
