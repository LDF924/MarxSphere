// PolicyPanel.tsx — 政策资料库面板（马克思政策库）
// 左=本地政策目录浏览+预览 · 右=gov.cn 政策检索 + 一键存入政策库
import { useState, useEffect, type FC, type ReactNode } from "react";
import { Landmark, Loader2, Search, FileText, FolderOpen, ChevronRight, ChevronDown, Save, RefreshCw, CheckCircle2, ExternalLink, Download, X } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { Card } from "../components/ui/card";
import { DragHandle } from "../components/ui/DragHandle";
import { Button } from "../components/ui/button";
import type { PolicyTreeNode, VaultFileRecord } from "../types";

interface PolicyHit {
  title: string;
  url: string;
  date: string;
  level: string;
  summary?: string;
}

// 可预览的扩展名
const PREVIEWABLE = [".md", ".markdown", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".txt"];

function isPreviewable(name: string) {
  const ext = "." + (name.toLowerCase().split(".").pop() || "");
  return PREVIEWABLE.includes(ext);
}

function fileIcon(name: string) {
  const ext = name.toLowerCase().split(".").pop() || "";
  if (["pdf"].includes(ext)) return <FileText className="h-3.5 w-3.5 shrink-0 text-red-400" />;
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  return <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
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

function MarkdownPreview({ content }: { content: string }) {
  const blocks: ReactNode[] = [];
  const lines = content.split("\n");
  let codeBlock: string[] | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (codeBlock) {
      if (line.trim().startsWith("```")) {
        blocks.push(<pre key={index} className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">{codeBlock.join("\n")}</pre>);
        codeBlock = null;
      } else {
        codeBlock.push(line);
      }
      continue;
    }
    if (line.trim().startsWith("```")) {
      codeBlock = [];
      continue;
    }
    const headingMatch = line.match(/^(#{1,4})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(
        <div key={index} className={cn("mt-2 font-semibold", level <= 2 ? "text-base" : "text-sm")}>
          {headingMatch[2].replace(/\*\*(.*?)\*\*/g, "$1")}
        </div>
      );
      continue;
    }
    if (line.trim().startsWith("- ") || line.trim().startsWith("* ")) {
      blocks.push(
        <div key={index} className="flex gap-1.5 text-sm">
          <span className="text-muted-foreground">•</span>
          <span>{line.trim().slice(2)}</span>
        </div>
      );
      continue;
    }
    if (!line.trim()) {
      blocks.push(<div key={index} className="h-1" />);
      continue;
    }
    blocks.push(<div key={index} className="text-sm">{line}</div>);
  }
  if (codeBlock) {
    blocks.push(<pre key="tail" className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">{codeBlock.join("\n")}</pre>);
  }
  // A4 纸阅读版式：行宽限制 + 舒适行高（长文档阅读体验）
  return <div className="mx-auto max-w-3xl space-y-1.5 px-4 py-2 text-sm leading-7">{blocks}</div>;
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
  const [file, setFile] = useState<VaultFileRecord | null>(null);
  const [binaryUrl, setBinaryUrl] = useState<string | null>(null);
  const [isOffice, setIsOffice] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);

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

  const selectFile = async (filePath: string, fileName: string) => {
    setSelectedPath(filePath);
    setSelectedName(fileName);
    setFile(null);
    setBinaryUrl(null);
    setIsOffice(false);
    setFileLoading(true);
    try {
      if (isPreviewable(fileName)) {
        if (fileName.toLowerCase().endsWith(".md") || fileName.toLowerCase().endsWith(".markdown") || fileName.toLowerCase().endsWith(".txt")) {
          const data = await api.getVaultFile(filePath);
          setFile(data.file);
        } else {
          setBinaryUrl(`/api/vault/binary?path=${encodeURIComponent(filePath)}`);
        }
      } else {
        setIsOffice(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFileLoading(false);
    }
  };

  const closePreview = () => {
    setSelectedPath(null);
    setSelectedName("");
    setFile(null);
    setBinaryUrl(null);
    setIsOffice(false);
  };

  return (
    <section className="min-h-0 flex-1 overflow-hidden px-4 py-4 md:px-6">
      <div className="mx-auto flex h-full w-full max-w-[1400px] flex-col space-y-3">
        <div className="flex items-center gap-2">
          <Landmark className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">政策资料库</h2>
          <span className="text-xs text-muted-foreground">课题研究·著作政策会议</span>
          <ButtonSmall onClick={() => void loadTree()}><RefreshCw className="h-3.5 w-3.5" /></ButtonSmall>
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
            <Button onClick={() => void runSearch()} disabled={searching || !query.trim()}>
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
                    <Button size="sm" variant="outline" disabled={saving === hit.url || savedMap[hit.url]} onClick={() => void savePolicy(hit)}>
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
        <div className="relative grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[var(--policy-w,280px)_minmax(0,1fr)]" style={{"--policy-w": "280px"} as React.CSSProperties}>
          <Card className="min-h-0 overflow-y-auto p-2">
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

          <Card className="min-h-0 overflow-y-auto p-4">
            {fileLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />读取文件…</div>
            ) : binaryUrl ? (
              <div className="flex h-full flex-col">
                <div className="mb-2 flex items-center justify-between gap-2 border-b border-border pb-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {fileIcon(selectedName)}
                    <span className="truncate font-medium">{selectedName}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <a
                      href={`/api/vault/binary?path=${encodeURIComponent(selectedPath ?? "")}&download=1`}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                    >
                      <Download className="h-3 w-3" /> 下载
                    </a>
                    <button
                      type="button"
                      onClick={closePreview}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                      title="关闭预览"
                    >
                      <X className="h-3 w-3" /> 关闭
                    </button>
                  </div>
                </div>
                {selectedName.toLowerCase().endsWith(".pdf") ? (
                  <div className="flex min-h-0 flex-1 items-start justify-center overflow-hidden">
                    <iframe src={binaryUrl} title={selectedName} className="aspect-[210/297] h-full max-w-full rounded border border-border bg-white" />
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 items-center justify-center p-4">
                    <img src={binaryUrl} alt={selectedName} className="max-h-full max-w-full rounded object-contain" />
                  </div>
                )}
              </div>
            ) : isOffice ? (
              <div className="relative flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                <button
                  type="button"
                  onClick={closePreview}
                  className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                  title="关闭预览"
                >
                  <X className="h-3 w-3" /> 关闭
                </button>
                <FileText className="h-10 w-10 text-muted-foreground/50" />
                <div className="text-sm font-medium">{selectedName}</div>
                <div className="max-w-sm text-xs text-muted-foreground">
                  Office 文档（Word/Excel/PPT）浏览器不支持内联预览，请下载后用本地 Office 打开。
                </div>
                <a
                  href={`/api/vault/binary?path=${encodeURIComponent(selectedPath ?? "")}&download=1`}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                >
                  <Download className="h-3.5 w-3.5" /> 下载并打开
                </a>
              </div>
            ) : file ? (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2 border-b border-border pb-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {fileIcon(file.name)}
                    <span className="truncate font-medium">{file.name}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted-foreground">{Math.round(file.size / 1024)} KB</span>
                    <button
                      type="button"
                      onClick={closePreview}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                      title="关闭预览"
                    >
                      <X className="h-3 w-3" /> 关闭
                    </button>
                  </div>
                </div>
                <MarkdownPreview content={file.content.slice(0, 20000)} />
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <div>选择左侧政策文件查看内容</div>
                <div className="max-w-sm text-center text-xs">支持 md / PDF / 图片内联预览，Office 文档可下载打开</div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
    </section>
  );
}

function ButtonSmall(props: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={props.onClick} className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
      {props.children}
    </button>
  );
}
