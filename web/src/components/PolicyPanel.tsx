// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// PolicyPanel.tsx — 政策资料库面板（马克思政策库）
// 左=本地政策目录浏览+预览 · 右=gov.cn 政策检索 + 一键存入政策库
import { useState, useEffect, type FC, type ReactNode } from "react";
import { Landmark, Loader2, Search, FileText, FolderOpen, ChevronRight, ChevronDown, Save, RefreshCw, CheckCircle2, ExternalLink, Download, X } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { Card } from "../components/ui/card";
import { DragHandle } from "../components/ui/DragHandle";
import { Button } from "../components/ui/button";
import { VaultFilePreview } from "./VaultFilePreview";
import { fileKind, VIEWABLE_HINT } from "../lib/file-kind";
import type { PolicyTreeNode } from "../types";

interface PolicyHit {
  title: string;
  url: string;
  date: string;
  level: string;
  summary?: string;
}

// 2026-10-02: 类型判断收敛到 lib/file-kind.ts —— 本文件此前自己维护一份 PREVIEWABLE,
// 与 VaultPanel/EducationPanel 各一份, 三份都把非 md/pdf/图片的文件报成"Office 文档"(错的)
function fileIcon(name: string) {
  return fileKind(name) === "pdf"
    ? <FileText className="h-3.5 w-3.5 shrink-0 text-red-400" />
    : <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

function TreeItem({ node, depth, onSelect }: { node: PolicyTreeNode; depth: number; onSelect: (path: string, name: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const isDir = node.type === "dir";
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm hover:bg-accent"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => {
          if (isDir) setExpanded((c) => !c);
          else onSelect(node.path, node.name);
        }}
      >
        {isDir
          ? expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          : fileIcon(node.name)}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir && expanded && node.children?.map((child) => (
        <TreeItem key={child.path} node={child} depth={depth + 1} onSelect={onSelect} />
      ))}
    </div>
  );
}

export function PolicyPanel() {
  const [tree, setTree] = useState<PolicyTreeNode[]>([]);
  const [treeRoot, setTreeRoot] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 检索
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PolicyHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [savedMap, setSavedMap] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  // 本地文件预览
  const [selectedName, setSelectedName] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const loadTree = async () => {
    setLoading(true);
    try {
      const data = await api.getPolicyLibraryTree();
      setTree(data.nodes);
      setTreeRoot(data.root);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTree();
  }, []);

  const runSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    setSavedMap({});
    try {
      const data = await api.searchPolicy({ keyword: query.trim(), pageSize: 8 });
      if (data.error) setError(data.error);
      else setResults(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const savePolicy = async (hit: PolicyHit) => {
    setSaving(hit.url);
    try {
      const r = await api.savePolicyToLibrary({
        title: hit.title,
        url: hit.url,
        date: hit.date,
        summary: hit.summary,
        category: "abeedata-资本相关政策"
      });
      if (r.ok) setSavedMap((prev) => ({ ...prev, [hit.url]: true }));
      else setError(r.error ?? "保存失败");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  // 预览分派交给 VaultFilePreview(与资料库面板同一个组件)
  const selectFile = (filePath: string, fileName: string) => {
    setSelectedPath(filePath);
    setSelectedName(fileName);
  };

  const closePreview = () => {
    setSelectedPath(null);
    setSelectedName("");
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="flex w-full flex-col space-y-3">
        <div className="flex items-center gap-2">
          <Landmark className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">政策资料库</h2>
          <span className="text-xs text-muted-foreground">课题研究·著作政策会议</span>
          <ButtonSmall control="policy:refresh" onClick={() => void loadTree()}><RefreshCw className="h-3.5 w-3.5" /></ButtonSmall>
        </div>

        {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}

        {/* gov.cn 检索区 */}
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Search className="h-4 w-4 text-primary" /> gov.cn 政策检索（可存入政策库）
          </div>
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
              placeholder="如：土地流转 / 社会资本投资农业农村 / 农村集体经济"
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <Button data-control="policy:search" onClick={() => void runSearch()} disabled={searching || !query.trim()}>
              {searching ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Search className="mr-1 h-4 w-4" />} 检索
            </Button>
          </div>
          {results.length > 0 && (
            <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
              {results.map((hit) => (
                <div key={hit.url} className="rounded border border-border p-2">
                  <div className="text-sm font-medium">{hit.title}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {hit.date} · {hit.level === "state_council" ? "国务院" : hit.level || "政策"}
                  </div>
                  {hit.summary && <p className="mt-1 text-xs text-muted-foreground">{hit.summary.slice(0, 120)}</p>}
                  <div className="mt-1 flex items-center gap-3">
                    {hit.url && <a href={hit.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline"><ExternalLink className="h-3 w-3" />原文</a>}
                    <Button size="sm" variant="outline" data-control="policy:save" disabled={saving === hit.url || savedMap[hit.url]} onClick={() => void savePolicy(hit)}>
                      {saving === hit.url ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : savedMap[hit.url] ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <Save className="mr-1 h-3 w-3" />}
                      {savedMap[hit.url] ? "已存入" : "存入政策库"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* 本地政策目录浏览 + 预览 */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <DragHandle leftVar="--policy-w" defaultWidth={280} storageKey="policy-width" />
        {/* 双栏加高：135vh（比视口高 35%），外部滚动查看完整 */}
        <div className="relative grid h-[135vh] w-full grid-cols-1 grid-rows-[minmax(0,1fr)] gap-0 lg:grid-cols-[var(--policy-w,280px)_minmax(0,1fr)]" style={{"--policy-w": "280px"} as React.CSSProperties}>
          <Card className="flex min-h-0 flex-col overflow-y-auto p-2">
            <div className="mb-1 flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
              <FolderOpen className="h-3.5 w-3.5" /> 本地政策库
              {selectedPath && <span className="truncate text-primary">· {selectedName.slice(0, 40)}</span>}
            </div>
            {loading ? (
              <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载…</div>
            ) : tree.length === 0 ? (
              <div className="p-2 text-sm text-muted-foreground">政策库目录为空或不存在</div>
            ) : (
              tree.map((node) => (
                <TreeItem key={node.path} node={node} depth={0} onSelect={(path, name) => void selectFile(path, name)} />
              ))
            )}
          </Card>

          <Card className="flex min-h-0 flex-col overflow-hidden p-4">
            {selectedPath ? (
              <VaultFilePreview path={selectedPath} name={selectedName} onClose={closePreview} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <div>选择左侧政策文件查看内容</div>
                <div className="max-w-md text-center text-xs">{VIEWABLE_HINT}</div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
    </section>
  );
}

function ButtonSmall(props: { children: ReactNode; onClick: () => void; control?: string }) {
  return (
    <button type="button" data-control={props.control} onClick={props.onClick} className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
      {props.children}
    </button>
  );
}
