// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// LiteraturePreviewPanel.tsx — 研究场景文献预览（V358）
// 从研究结果提取文献（title/chunkCount）→ 点击拉 /api/documents/:id/chunks 拼接全文 → AnnotationWorkspace 标注
// 集成到 6 个研究面板：分析完成后，"本次用到的文献"列表可逐篇预览原文并框选标注
import { useState, type FC } from "react";
import { BookOpen, FileText, ChevronDown, ChevronRight, Loader2, Search } from "lucide-react";
import { cn } from "../lib/utils";
import { AnnotationWorkspace } from "./AnnotationWorkspace";

export interface LiteratureRef {
  /** 文档 UUID（用于拉 chunks） */
  id?: string;
  documentId?: string;
  title: string;
  chunkCount?: number;
}

interface LiteraturePreviewPanelProps {
  /** 本次分析用到的文献（从研究结果提取） */
  references: LiteratureRef[];
  /** 面板标题（如 "本次用到的文献"） */
  title?: string;
  /** 标注 storageKey 前缀（按场景区分） */
  storageKeyPrefix?: string;
}

/** 从研究 API 结果中提取文献列表（兼容各 API 不同字段） */
export function extractLiteratureRefs(result: any): LiteratureRef[] {
  const refs: LiteratureRef[] = [];
  if (!result) return refs;
  const seen = new Set<string>();
  const add = (r: LiteratureRef) => {
    const key = r.id ?? r.documentId ?? r.title;
    if (key && !seen.has(key)) { seen.add(key); refs.push(r); }
  };
  // 兼容: documents / versions / citations / chunks 数组 / 直接 title 列表
  if (Array.isArray(result.documents)) {
    for (const d of result.documents) {
      if (typeof d === "string") add({ title: d });
      else add({ id: d.id ?? d.documentId, title: d.title ?? d.name ?? String(d), chunkCount: d.chunkCount ?? d.chunks });
    }
  }
  if (Array.isArray(result.versions)) {
    for (const v of result.versions) {
      if (typeof v === "string") add({ title: v });
      else add({ id: v.id, title: v.title ?? String(v), chunkCount: v.chunks?.length });
    }
  }
  if (Array.isArray(result.citations)) {
    for (const c of result.citations) {
      if (typeof c === "string") add({ title: c });
      else add({ title: c.title ?? String(c) });
    }
  }
  if (Array.isArray(result.chunks) || Array.isArray(result.sections)) {
    const arr = result.chunks ?? result.sections ?? [];
    for (const c of arr) {
      if (c?.documentId) add({ id: c.documentId, title: c.title ?? c.paperTitle ?? c.documentTitle ?? c.heading ?? "文献", chunkCount: 1 });
    }
  }
  return refs.slice(0, 8);
}

export const LiteraturePreviewPanel: FC<LiteraturePreviewPanelProps> = ({
  references,
  title = "本次用到的文献",
  storageKeyPrefix = "lit",
}) => {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [docText, setDocText] = useState<Record<string, string>>({});
  // 主动检索状态
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchedRefs, setSearchedRefs] = useState<LiteratureRef[]>([]);
  // 显示: 检索结果优先（主动检索），否则被动 references
  const activeRefs = searchedRefs.length > 0 ? searchedRefs : references;

  // 主动检索: /api/search → 按 documentId 去重 → 拉文档标题
  const doSearch = async () => {
    const q = searchQuery.trim();
    if (!q || searching) return;
    setSearching(true);
    setSearchError("");
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, sourceIds: ["c609acbf-1d6e-4bd5-9ae1-92fa6c64021a"], topK: 15 }),
      });
      const j = await res.json();
      const sections = j.sections ?? [];
      // 按 documentId 去重，取第一个 heading 作为临时标题
      const byDoc = new Map<string, LiteratureRef>();
      for (const s of sections) {
        if (!s?.documentId) continue;
        if (!byDoc.has(s.documentId)) {
          byDoc.set(s.documentId, { id: s.documentId, title: (s.paperTitle ?? s.documentTitle ?? s.heading ?? "文献").substring(0, 60) });
        }
      }
      const refs = [...byDoc.values()];
      // 异步拉每个文档的标题（并行，失败用临时标题）
      await Promise.all(refs.map(async (r) => {
        try {
          const dr = await fetch(`/api/documents/${r.id}`);
          const dj = await dr.json();
          if (dj.document?.title) r.title = dj.document.title;
        } catch { /* 用临时标题 */ }
      }));
      setSearchedRefs(refs);
      if (refs.length === 0) setSearchError("未检索到相关文献（知识库中可能没有该主题的论文）");
    } catch {
      setSearchError("检索失败，请重试");
    }
    setSearching(false);
  };

  if (references.length === 0) return null;

  const openDoc = async (ref: LiteratureRef) => {
    const id = ref.id ?? ref.documentId;
    if (!id) return;
    if (docText[id]) { setExpanded(expanded === id ? null : id); return; }
    setLoading(id);
    try {
      const res = await fetch(`/api/documents/${id}/chunks`);
      const j = await res.json();
      const chunks = Array.isArray(j) ? j : (j.chunks ?? []);
      const full = chunks.map((c: any) => (c.heading ? `## ${c.heading}\n` : "") + (c.content ?? "")).join("\n\n");
      setDocText((prev) => ({ ...prev, [id]: full }));
      setExpanded(id);
    } catch {
      // 拉取失败降级：显示标题
      setDocText((prev) => ({ ...prev, [id]: ref.title }));
      setExpanded(id);
    }
    setLoading(null);
  };

  return (
    <div className="rounded-lg border bg-background/40">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <BookOpen className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-semibold">{title}</span>
        <span className="text-[10px] text-muted-foreground">
          {activeRefs.length > 0 ? `(${activeRefs.length} 篇 · 点击预览全文可标注)` : "输入主题检索相关文献，点击预览原文可标注"}
        </span>
      </div>
      <div className="border-b p-2">
        <div className="flex gap-2">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void doSearch(); }}
            placeholder="输入主题检索当前研究用到的文献著作…（如：资本下乡 治理）"
            className="min-w-0 flex-1 rounded border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/50"
          />
          <button
            onClick={() => void doSearch()}
            disabled={searching}
            className="flex shrink-0 items-center gap-1 rounded bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
          >
            {searching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
            检索文献
          </button>
        </div>
        {searchError && <p className="mt-1 text-[10px] text-red-600">{searchError}</p>}
      </div>
      <div className="max-h-72 overflow-y-auto p-2">
        {activeRefs.map((ref, i) => {
          const id = ref.id ?? ref.documentId ?? ref.title;
          const isOpen = expanded === id;
          return (
            <div key={i} className="mb-1">
              <button
                onClick={() => (ref.id ?? ref.documentId) ? void openDoc(ref) : undefined}
                disabled={!ref.id && !ref.documentId}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] transition-colors",
                  (ref.id ?? ref.documentId) ? "hover:bg-muted" : "cursor-default"
                )}
              >
                {loading === id ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                ) : isOpen ? (
                  <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                )}
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{ref.title}</span>
                {ref.chunkCount ? <span className="shrink-0 text-[9px] text-muted-foreground">{ref.chunkCount} 切片</span> : null}
              </button>
              {isOpen && (
                <div className="mt-1 pl-6">
                  <AnnotationWorkspace
                    storageKey={`${storageKeyPrefix}-${id?.slice(0, 8)}`}
                    initialText={docText[id] ?? ""}
                    editable={false}
                    title={`${ref.title.slice(0, 20)}…（文献预览）`}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
