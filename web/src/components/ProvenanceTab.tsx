// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ProvenanceTab.tsx — 文件级溯源 tab(移植 open-science provenance 的前端展示)
// 展示 agent 写文件留痕: 最近写入列表 + 点开看版本历史/哈希
import { useEffect, useState } from "react";
import { History, Loader2 } from "lucide-react";

interface ProvenanceRecord {
  path: string;
  version: number;
  ts: string;
  tool: string;
  sessionId?: string;
  model?: string;
  contentHash: string;
  size: number;
  op: "write" | "delete" | "patch";
  runId?: string;
}

const TOOL_LABEL: Record<string, string> = {
  file_write: "文件写入", apply_patch: "精确补丁", todo_update: "待办管理", run_code: "运行代码",
};

function fmtTime(ts: string): string {
  try { return new Date(ts).toLocaleString("zh-CN", { hour12: false }); } catch { return ts; }
}

function FileHistory({ filePath, onBack }: { filePath: string; onBack: () => void }) {
  const [rows, setRows] = useState<ProvenanceRecord[] | null>(null);
  useEffect(() => {
    setRows(null);
    void (async () => {
      try {
        const res = await fetch(`/api/provenance/file?path=${encodeURIComponent(filePath)}`);
        const d = await res.json();
        setRows(Array.isArray(d.records) ? d.records : []);
      } catch { setRows([]); }
    })();
  }, [filePath]);
  return (
    <div className="space-y-2">
      <button type="button" onClick={onBack} className="text-[11px] text-muted-foreground hover:text-foreground">← 返回列表</button>
      <div className="rounded-md border border-border/60 bg-background/40 p-2 text-[11px] font-medium">{filePath} · 版本历史</div>
      {!rows ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中…</div>
      ) : rows.length === 0 ? (
        <div className="py-4 text-center text-xs text-muted-foreground/60">无留痕记录</div>
      ) : (
        rows.map((r) => (
          <div key={`${r.version}-${r.ts}`} className="rounded-md border border-border/50 bg-background/30 px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">v{r.version}</span>
              <span className="text-muted-foreground">{TOOL_LABEL[r.tool] ?? r.tool}</span>
              <span className={`rounded px-1.5 py-0.5 text-[9px] ${r.op === "delete" ? "bg-red-500/10 text-red-300" : r.op === "patch" ? "bg-amber-400/10 text-amber-300" : "bg-emerald-400/10 text-emerald-300"}`}>{r.op}</span>
              <span className="ml-auto text-[10px] text-muted-foreground">{fmtTime(r.ts)}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-muted-foreground/70">
              <span>sha256: <code className="font-mono">{r.contentHash}</code></span>
              <span>{r.size} B</span>
              {r.sessionId && <span>会话: {r.sessionId.slice(0, 12)}</span>}
              {r.model && <span>模型: {r.model}</span>}
              {r.runId && <span>任务: {r.runId.slice(0, 12)}</span>}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export function ProvenanceTab() {
  const [records, setRecords] = useState<ProvenanceRecord[] | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/provenance?limit=50");
        const d = await res.json();
        setRecords(Array.isArray(d.records) ? d.records : []);
      } catch { setRecords([]); }
    })();
  }, []);

  if (openFile) return <FileHistory filePath={openFile} onBack={() => setOpenFile(null)} />;

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <History className="h-3.5 w-3.5" /> 文件级溯源 · agent 写文件留痕(版本/哈希/工具)
        <span className="ml-auto text-[10px] text-muted-foreground/60">provenance.jsonl · 只增不改</span>
      </div>
      {!records ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中…</div>
      ) : records.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 bg-background/20 p-6 text-center text-xs text-muted-foreground/70">
          暂无留痕 — agent 每次写入 data/agent_workspace 的文件(file_write/apply_patch/todo_update)都会在此留痕
        </div>
      ) : (
        <div className="space-y-1.5">
          {records.map((r, i) => (
            <button key={`${r.path}-${r.version}-${i}`} type="button" onClick={() => setOpenFile(r.path)}
              className="flex w-full flex-wrap items-center gap-2 rounded-md border border-border/50 bg-background/30 px-3 py-2 text-left text-xs transition-colors hover:bg-accent/30">
              <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">v{r.version}</span>
              <span className="min-w-0 max-w-[45%] flex-1 truncate font-medium">{r.path}</span>
              <span className="text-[10px] text-muted-foreground">{TOOL_LABEL[r.tool] ?? r.tool}</span>
              <span className={`rounded px-1.5 py-0.5 text-[9px] ${r.op === "delete" ? "bg-red-500/10 text-red-300" : r.op === "patch" ? "bg-amber-400/10 text-amber-300" : "bg-emerald-400/10 text-emerald-300"}`}>{r.op}</span>
              <span className="ml-auto font-mono text-[9px] text-muted-foreground/50">{r.contentHash}</span>
              <span className="text-[10px] text-muted-foreground/60">{fmtTime(r.ts)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
