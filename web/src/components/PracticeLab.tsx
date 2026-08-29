// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// PracticeLab.tsx — 练习实验室(2026-08-29, Inno Agent Practice Lab 对照)
// 工作区级 Python 执行终端(持久运行时, 变量跨调用保持):
//   - 代码输入 + 执行输出(monospace 终端样式)
//   - 变量状态提示(同一运行时跨调用保持)
//   - 常用示例一键填充 + 重置运行时
import { useRef, useState } from "react";
import { Terminal, Play, RotateCcw, Loader2, Trash2 } from "lucide-react";

const EXAMPLES = [
  { label: "变量保持", code: "x = 42\nprint(f'x={x}, x*2={x*2}')" },
  { label: "数据分析", code: "import statistics\ndata = [3, 5, 7, 9, 11]\nprint('均值:', statistics.mean(data))\nprint('中位数:', statistics.median(data))" },
  { label: "matplotlib", code: "import matplotlib.pyplot as plt\nimport numpy as np\nx = np.linspace(0, 10, 100)\nplt.plot(x, np.sin(x))\nplt.title('sin(x)')\nplt.show()" },
];

interface HistoryEntry { code: string; output: string; ok: boolean }

export function PracticeLab() {
  const [code, setCode] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);

  const run = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/agent/persistent-runtime/exec", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      }).then((x) => x.json());
      const out = [r?.stdout, r?.stderr, r?.error ? `❌ ${r.error}` : ""].filter(Boolean).join("\n");
      setHistory((prev) => [...prev, { code, output: out || "（无输出）", ok: r?.ok !== false }]);
      setSessionId(r?.sessionId || null);
    } catch (e: any) {
      setHistory((prev) => [...prev, { code, output: `❌ ${String(e?.message || e).slice(0, 100)}`, ok: false }]);
    }
    setBusy(false);
    setTimeout(() => outputRef.current?.scrollTo({ top: 99999, behavior: "smooth" }), 50);
  };

  const reset = async () => {
    await fetch("/api/agent/persistent-runtime/reset", { method: "POST" }).catch(() => {});
    setSessionId(null);
    setNotice("运行时已重置(变量清空)");
    setTimeout(() => setNotice(null), 2000);
  };

  const clear = () => { setHistory([]); };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Terminal className="h-5 w-5 text-emerald-500" />
        <h2 className="text-lg font-semibold">练习实验室</h2>
        <span className="text-xs text-muted-foreground">Python 执行 · 变量跨调用保持(Inno Agent Practice Lab 对照)</span>
        {sessionId && <span className="ml-auto rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[9px] text-emerald-600">会话 {sessionId.slice(0, 8)}</span>}
      </div>

      {/* 示例快捷 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">示例:</span>
        {EXAMPLES.map((e) => (
          <button key={e.label} type="button" onClick={() => setCode(e.code)}
            className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] text-emerald-700 hover:bg-emerald-500/20">
            {e.label}
          </button>
        ))}
        <div className="ml-auto flex gap-1.5">
          <button type="button" onClick={() => void reset()} className="flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[10px] text-muted-foreground hover:bg-accent" title="重置运行时(清空变量)">
            <RotateCcw className="h-3 w-3" /> 重置
          </button>
          <button type="button" onClick={clear} className="flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[10px] text-muted-foreground hover:bg-accent" title="清空输出">
            <Trash2 className="h-3 w-3" /> 清空
          </button>
        </div>
      </div>
      {notice && <div className="rounded-lg bg-emerald-500/10 px-3 py-1.5 text-[10px] text-emerald-700">{notice}</div>}

      {/* 代码输入 */}
      <div className="rounded-xl border bg-slate-950/90 p-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-slate-400">
          <Terminal className="h-3 w-3" /> python — 持久运行时(变量保持)
        </div>
        <textarea value={code} onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void run(); }}
          placeholder="输入 Python 代码… (Ctrl+Enter 运行)"
          className="h-32 w-full resize-y rounded-lg bg-slate-900/60 p-3 font-mono text-[11px] leading-relaxed text-slate-200 outline-none focus:border-emerald-500/50" />
        <div className="mt-2 flex items-center gap-2">
          <button type="button" onClick={() => void run()} disabled={busy || !code.trim()}
            className="flex items-center gap-1 rounded-lg bg-emerald-600 px-4 py-2 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {busy ? "执行中…" : "运行 (Ctrl+Enter)"}
          </button>
          <span className="text-[9px] text-muted-foreground">变量跨调用保持 — 第二次运行可引用第一次的变量</span>
        </div>
      </div>

      {/* 输出终端 */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-slate-950/90">
        <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5 text-[10px] text-slate-400">
          <span>输出</span>
          <span>{history.length} 次执行</span>
        </div>
        <div ref={outputRef} className="h-full max-h-[400px] overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
          {history.length === 0 && <div className="text-slate-500">// 运行代码后此处显示输出</div>}
          {history.map((h, i) => (
            <div key={i} className="mb-2">
              <div className="text-emerald-400">&gt;&gt;&gt; {h.code.split("\n")[0]}{h.code.split("\n").length > 1 ? " …" : ""}</div>
              <pre className={`whitespace-pre-wrap ${h.ok ? "text-slate-300" : "text-red-400"}`}>{h.output}</pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
