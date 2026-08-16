// RetrievalSourceSwitches.tsx — 检索源开关（三库任意组合：PG / Graphiti / Cognee）
// localStorage 持久化，Ask 与推理各自独立配置
import { useEffect, useState } from "react";
import { Database, Share2, Network } from "lucide-react";
import { cn } from "../lib/utils";
import { Card } from "./ui/card";

export type RetrievalSource = "pg" | "graphiti" | "cognee";

const SOURCE_META: Array<{ key: RetrievalSource; label: string; desc: string; icon: React.ReactNode }> = [
  { key: "pg", label: "PostgreSQL", desc: "实体/事件/切片", icon: <Database className="h-3.5 w-3.5" /> },
  { key: "graphiti", label: "Graphiti", desc: "Neo4j 实体/超边", icon: <Share2 className="h-3.5 w-3.5" /> },
  { key: "cognee", label: "Cognee", desc: "Neo4j 论文图谱", icon: <Network className="h-3.5 w-3.5" /> }
];

const STORAGE_KEY = (chain: string) => `sag:retrieval-sources:${chain}`;

export function RetrievalSourceSwitches({ chain, onChange }: { chain: "ask" | "reason"; onChange?: (sources: RetrievalSource[]) => void }) {
  const [sources, setSources] = useState<RetrievalSource[]>(["pg"]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY(chain));
      const parsed = raw ? (JSON.parse(raw) as { sources?: RetrievalSource[] }) : null;
      const list = (parsed?.sources ?? []).filter((s) => SOURCE_META.some((m) => m.key === s));
      const init: RetrievalSource[] = list.length > 0 ? list : ["pg"];
      setSources(init);
      onChange?.(init);
    } catch {
      setSources(["pg"]);
      onChange?.(["pg"]);
    }
  }, [chain]);

  const toggle = (key: RetrievalSource) => {
    setSources((prev) => {
      const next = prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key];
      if (next.length === 0) next.push("pg"); // 至少保留一个
      try {
        localStorage.setItem(STORAGE_KEY(chain), JSON.stringify({ sources: next }));
      } catch { /* 忽略 */ }
      onChange?.(next);
      return next;
    });
  };

  return (
    <Card className="p-2">
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">检索源</span>
        <span>三库任意组合</span>
        <span className="ml-auto">{sources.length} 个启用</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {SOURCE_META.map((meta) => {
          const on = sources.includes(meta.key);
          return (
            <button
              key={meta.key}
              type="button"
              onClick={() => toggle(meta.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
                on
                  ? "border-primary/50 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent"
              )}
              title={`${meta.label}（${meta.desc}）`}
            >
              {meta.icon}
              {meta.label}
              {on && <span className="text-[10px] text-primary">✓</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 text-[10px] text-muted-foreground">
        Graphiti/Cognee 需要完整模式（MCP 池）；预览模式仅 PostgreSQL 可用
      </div>
    </Card>
  );
}
