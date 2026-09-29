// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// DocsPanel.tsx — 文档浏览（对标 Sciverse /docs：左侧章节导航 + 右侧 Markdown 渲染）
// 渲染 docs/ 目录的 md 文件：overview/quickstart/api-reference/cookbook/integrations
import { useState, useEffect } from "react";
import { BookOpen, ChevronRight, FileText, Loader2 } from "lucide-react";
import { apiDocs, type DocEntry } from "../lib/api";
import { MarkdownMessage } from "../lib/markdown";
import { cn } from "../lib/utils";

export function DocsPanel() {
  const [index, setIndex] = useState<DocEntry[]>([]);
  const [currentId, setCurrentId] = useState("overview");
  const [content, setContent] = useState("");
  const [currentTitle, setCurrentTitle] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void apiDocs.get(currentId).then((r) => {
      if (cancelled) return;
      setIndex(r.index);
      setContent(r.current.content);
      setCurrentTitle(r.current.title);
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, [currentId]);

  /**
   * 文档正文里的相对链接(`[项目概述](PROJECT-OVERVIEW.md)`)在静态托管下必然 404 ——
   * 那些 .md 不进 web/dist。这里把它解析成"切到该文档":
   * 后端索引里带 `path`, 所以按文件名(含 `integrations/` 这类子目录)反查 id。
   *
   * ⚠ 2026-09-29: 此前 markdown.tsx **完全没有链接分支**, 于是文档里到处是
   * `[标题](xxx.md)` 这种原始字面量, 且点不动 —— 文档中心最该能做的事(在文档间跳)反而是坏的。
   */
  const openDocLink = (href: string) => {
    const target = href.split("#")[0].replace(/^\.\//, "").toLowerCase();
    if (!target) return;
    const hit = index.find((d) => {
      const p = String((d as { path?: string }).path ?? "").toLowerCase();
      return p === target || p.endsWith("/" + target);
    });
    if (hit) setCurrentId(hit.id);
    // 反查不到就静默 —— 文档里写了个已删的链接不是致命错误, 而弹错更烦人
  };

  const groups = Array.from(new Set(index.map((d) => d.group)));

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧章节导航 */}
      <aside className="w-52 shrink-0 overflow-y-auto border-r border-border p-3">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <BookOpen className="h-4 w-4 text-violet-500" />
          文档
          {index.length > 0 && <span className="ml-auto text-[10px] font-normal text-muted-foreground">{index.length}</span>}
        </div>
        {groups.map((group) => (
          <div key={group} className="mb-3">
            <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</div>
            {index.filter((d) => d.group === group).map((d) => (
              <button
                key={d.id}
                data-control="docs:nav"
                onClick={() => setCurrentId(d.id)}
                className={cn(
                  "mb-0.5 flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs transition-colors",
                  currentId === d.id
                    ? "bg-violet-500/10 font-medium text-violet-700"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <FileText className="h-3 w-3 shrink-0" />
                <span className="truncate">{d.title}</span>
                {currentId === d.id && <ChevronRight className="ml-auto h-3 w-3 shrink-0" />}
              </button>
            ))}
          </div>
        ))}
      </aside>

      {/* 右侧文档内容 */}
      <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
        {loading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载文档...
          </div>
        ) : (
          <article className="mx-auto w-full max-w-[1100px]">
            <h1 className="mb-4 text-xl font-semibold">{currentTitle}</h1>
            <div className="markdown-body">
              <MarkdownMessage content={content} onOpenDocLink={openDocLink} />
            </div>
          </article>
        )}
      </main>
    </div>
  );
}
