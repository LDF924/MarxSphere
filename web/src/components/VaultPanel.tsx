// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// VaultPanel.tsx — 资料库面板：左树右文浏览 Obsidian 课题库（md/PDF/图片/表格/Office）
import { useState, useEffect, type FC, type ReactNode } from "react";
import { FolderOpen, FileText, FileImage, File, Download, Loader2, ChevronRight, ChevronDown, BookMarked, RefreshCw, X, BookOpenCheck } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { Card } from "../components/ui/card";
import { DragHandle } from "../components/ui/DragHandle";
import { VaultFilePreview } from "./VaultFilePreview";
import { fileKind, VIEWABLE_HINT } from "../lib/file-kind";
import type { VaultTreeNode } from "../types";

function fileIcon(name: string) {
  const kind = fileKind(name);
  if (kind === "image") return <FileImage className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  if (kind === "pdf") return <FileText className="h-3.5 w-3.5 shrink-0 text-red-400" />;
  return <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
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

export function VaultPanel() {
  const [tree, setTree] = useState<VaultTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string>("");

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

  // 2026-10-02: 预览分派收敛到 VaultFilePreview —— 本面板不再自己维护 PREVIEWABLE_EXT
  // 与五个预览 state(此前那份对 csv/geojson/shp/kml/drawio 一律报"Office 文档", 是错的)
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
          <BookMarked className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">资料库</h2>
          <span className="text-xs text-muted-foreground">Obsidian 资料库（课题研究 / 课题文献库 / AI科研指令包）</span>
          <ButtonSmall control="vault:refresh" onClick={() => void loadTree()}><RefreshCw className="h-3.5 w-3.5" /> 刷新</ButtonSmall>
        </div>

        {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}

        <div className="relative flex min-h-0 flex-1 flex-col">
          <DragHandle leftVar="--vault-w" defaultWidth={280} storageKey="vault-width" />
        <div className="relative grid h-[135vh] w-full grid-cols-1 grid-rows-[minmax(0,1fr)] gap-0 lg:grid-cols-[var(--vault-w,280px)_minmax(0,1fr)]" style={{"--vault-w": "280px"} as React.CSSProperties}>
          <Card className="flex min-h-0 flex-col overflow-y-auto p-2">
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
            {selectedPath ? (
              <VaultFilePreview
                path={selectedPath}
                name={selectedName}
                onClose={closePreview}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <div>选择左侧文件查看内容（目录仅展开，不预览）</div>
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
    <button
      type="button"
      data-control={props.control}
      onClick={props.onClick}
      className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
    >
      {props.children}
    </button>
  );
}
