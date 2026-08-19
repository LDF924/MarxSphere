// VaultPanel.tsx — 资料库面板：左树右文浏览 Obsidian 课题库（md/PDF/图片/Office）
import { useState, useEffect, type FC, type ReactNode } from "react";
import { FolderOpen, FileText, FileImage, File, Download, Loader2, ChevronRight, ChevronDown, BookMarked, RefreshCw, X } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { Card } from "../components/ui/card";
import { DragHandle } from "../components/ui/DragHandle";
import type { VaultTreeNode, VaultFileRecord } from "../types";

// 可内联预览的扩展名
const PREVIEWABLE_EXT = new Set([".md", ".markdown", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".txt"]);
// 可下载但不预览（Office 等）
const DOWNLOADABLE_EXT = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".epub"]);

function fileIcon(name: string) {
  const ext = name.toLowerCase().split(".").pop() || "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return <FileImage className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  if (["pdf"].includes(ext)) return <FileText className="h-3.5 w-3.5 shrink-0 text-red-400" />;
  return <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

function isPreviewable(name: string) {
  const ext = "." + (name.toLowerCase().split(".").pop() || "");
  return PREVIEWABLE_EXT.has(ext);
}

function TreeItem({ node, depth, selectedPath, onSelect }: {
  node: VaultTreeNode;
  depth: number;
  selectedPath: string;
  onSelect: (path: string, name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isDir = node.type === "dir";
  const isSelected = node.path === selectedPath;

  return (
    <div>
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm hover:bg-accent",
          isSelected && "bg-accent text-foreground"
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => {
          if (isDir) {
            setExpanded((current) => !current);
          } else {
            onSelect(node.path, node.name);
          }
        }}
      >
        {isDir ? (
          expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> :
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          fileIcon(node.name)
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir && expanded && node.children?.map((child) => (
        <TreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function MarkdownPreview({ content }: { content: string }) {
  // 轻量 Markdown 渲染：标题/粗体/列表/代码块/围栏
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

export function VaultPanel() {
  const [tree, setTree] = useState<VaultTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string>("");
  const [file, setFile] = useState<VaultFileRecord | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [binaryUrl, setBinaryUrl] = useState<string | null>(null);
  const [isOffice, setIsOffice] = useState(false);

  const loadTree = async () => {
    setLoading(true);
    try {
      const data = await api.getVaultTree();
      setTree(data.nodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTree();
  }, []);

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
          // PDF/图片 → iframe 内联预览
          const url = `/api/vault/binary?path=${encodeURIComponent(filePath)}`;
          setBinaryUrl(url);
        }
      } else {
        // Office 等 → 下载模式
        setIsOffice(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFileLoading(false);
    }
  };

  /** 关闭预览：清空全部预览状态 */
  const closePreview = () => {
    setSelectedPath(null);
    setSelectedName("");
    setFile(null);
    setBinaryUrl(null);
    setIsOffice(false);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 md:px-6">
      <div className="flex min-h-0 w-full flex-1 flex-col space-y-3">
        <div className="flex items-center gap-2">
          <BookMarked className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">资料库</h2>
          <span className="text-xs text-muted-foreground">Obsidian 资料库（课题研究 / 课题文献库 / AI科研指令包）</span>
          <ButtonSmall onClick={() => void loadTree()}><RefreshCw className="h-3.5 w-3.5" /> 刷新</ButtonSmall>
        </div>

        {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}

        <div className="relative flex min-h-0 flex-1 flex-col">
          <DragHandle leftVar="--vault-w" defaultWidth={280} storageKey="vault-width" />
        <div className="relative grid min-h-0 w-full flex-1 grid-cols-1 gap-0 lg:grid-cols-[var(--vault-w,280px)_minmax(0,1fr)]" style={{"--vault-w": "280px"} as React.CSSProperties}>
          <Card className="min-h-0 overflow-y-auto p-2">
            {loading ? (
              <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />加载目录…
              </div>
            ) : tree.length === 0 ? (
              <div className="p-2 text-sm text-muted-foreground">未发现资料库目录</div>
            ) : (
              tree.map((node) => (
                <TreeItem key={node.path} node={node} depth={0} selectedPath={selectedPath ?? ""} onSelect={(path, name) => void selectFile(path, name)} />
              ))
            )}
          </Card>

          <Card className="flex min-h-0 flex-col overflow-hidden p-4">
            {fileLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />读取文件…</div>
            ) : binaryUrl ? (
              <div className="flex min-h-full flex-col">
                <div className="mb-3 flex shrink-0 items-center justify-between gap-2 border-b border-border pb-2">
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
                {/* 预览撑满容器：宽高占满右栏，内容超高时内部滚动 */}
                {selectedName.toLowerCase().endsWith(".pdf") ? (
                  <div className="min-h-0 flex-1">
                    <iframe
                      src={binaryUrl}
                      title={selectedName}
                      className="h-full w-full rounded border border-border bg-white"
                    />
                  </div>
                ) : (
                  // 图片等 → 撑满容器内居中，可滚动
                  <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
                    <img src={binaryUrl} alt={selectedName} className="max-h-full max-w-full object-contain" />
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
                <FolderOpen className="h-10 w-10 text-muted-foreground/50" />
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
                <div>选择左侧文件查看内容（目录仅展开，不预览）</div>
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
    <button
      type="button"
      onClick={props.onClick}
      className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
    >
      {props.children}
    </button>
  );
}
