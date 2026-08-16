// markdown.tsx — 轻量 Markdown 渲染（App 对话与知识页 Claude 结论共用）
// 支持：标题 / 加粗 / 行内代码 / 代码块 / 无序有序列表 / 表格 / 引用 [n]
import type { ReactNode } from "react";
import { cn } from "./utils";

export interface MarkdownCitation {
  index: number;
  chunkId: string;
  sourceId: string;
  documentId?: string;
  heading?: string;
  content: string;
  rank?: number;
  score?: number;
  query?: string;
}

/** 完整 Markdown 消息（代码块分段 + 行渲染） */
export function MarkdownMessage({
  content,
  citations = [],
  onOpenCitation
}: {
  content: string;
  citations?: MarkdownCitation[];
  onOpenCitation?: (citation: MarkdownCitation) => void;
}) {
  const blocks = splitMarkdownCodeBlocks(content);
  return (
    <div className="space-y-2 break-words">
      {blocks.map((block, index) =>
        block.type === "code" ? (
          <pre key={index} className="overflow-auto rounded-md bg-muted p-3 text-xs leading-5 text-foreground">
            <code>{block.content}</code>
          </pre>
        ) : (
          <div key={index} className="space-y-1">
            {renderMarkdownLines(block.content, citations, onOpenCitation)}
          </div>
        )
      )}
    </div>
  );
}

function splitMarkdownCodeBlocks(content: string): Array<{ type: "text" | "code"; content: string }> {
  const blocks: Array<{ type: "text" | "code"; content: string }> = [];
  const regex = /```[^\n]*\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: "text", content: content.slice(lastIndex, match.index) });
    }
    blocks.push({ type: "code", content: match[1].trimEnd() });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < content.length) {
    blocks.push({ type: "text", content: content.slice(lastIndex) });
  }
  return blocks.length > 0 ? blocks : [{ type: "text", content }];
}

export function renderMarkdownLines(
  content: string,
  citations: MarkdownCitation[] = [],
  onOpenCitation?: (citation: MarkdownCitation) => void
) {
  const lines = content.split("\n");
  const nodes: ReactNode[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      nodes.push(<div key={index} className="h-2" />);
      continue;
    }
    if (isMarkdownTableStart(lines, index)) {
      const header = splitMarkdownTableCells(lines[index]);
      const alignments = parseMarkdownTableAlignments(lines[index + 1]);
      const rows: string[][] = [];
      let rowIndex = index + 2;
      while (rowIndex < lines.length && isMarkdownTableRow(lines[rowIndex])) {
        rows.push(splitMarkdownTableCells(lines[rowIndex]));
        rowIndex += 1;
      }
      nodes.push(
        <MarkdownTable
          key={index}
          header={header}
          rows={rows}
          alignments={alignments}
          citations={citations}
          onOpenCitation={onOpenCitation}
        />
      );
      index = rowIndex - 1;
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const className = heading[1].length === 1 ? "text-base font-semibold" : "text-sm font-semibold";
      nodes.push(<div key={index} className={className}>{renderInlineMarkdown(heading[2], citations, onOpenCitation)}</div>);
      continue;
    }
    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      nodes.push(
        <div key={index} className="flex gap-2">
          <span className="text-muted-foreground">•</span>
          <span>{renderInlineMarkdown(unordered[1], citations, onOpenCitation)}</span>
        </div>
      );
      continue;
    }
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      nodes.push(
        <div key={index} className="flex gap-2">
          <span className="text-muted-foreground">{trimmed.split(".")[0]}.</span>
          <span>{renderInlineMarkdown(ordered[1], citations, onOpenCitation)}</span>
        </div>
      );
      continue;
    }
    nodes.push(<p key={index} className="whitespace-pre-wrap leading-6">{renderInlineMarkdown(line, citations, onOpenCitation)}</p>);
  }
  return nodes;
}

function MarkdownTable(props: {
  header: string[];
  rows: string[][];
  alignments: Array<"left" | "center" | "right">;
  citations?: MarkdownCitation[];
  onOpenCitation?: (citation: MarkdownCitation) => void;
}) {
  return (
    <div className="my-2 max-w-full overflow-x-auto rounded-md border border-border bg-background/50">
      <table className="w-full table-auto border-collapse text-left text-xs leading-5">
        <thead className="bg-muted/60">
          <tr>
            {props.header.map((cell, index) => (
              <th
                key={`${index}-${cell}`}
                className={cn("border-b border-border px-2 py-1.5 font-semibold", tableAlignClass(props.alignments[index]))}
              >
                {renderInlineMarkdown(cell, props.citations, props.onOpenCitation)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t border-border/70">
              {props.header.map((_, cellIndex) => (
                <td
                  key={cellIndex}
                  className={cn("break-words px-2 py-1.5 align-top", tableAlignClass(props.alignments[cellIndex]))}
                >
                  {renderInlineMarkdown(row[cellIndex] ?? "", props.citations, props.onOpenCitation)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isMarkdownTableStart(lines: string[], index: number) {
  return isMarkdownTableRow(lines[index]) && isMarkdownTableDivider(lines[index + 1] ?? "");
}

function isMarkdownTableRow(line: string) {
  return splitMarkdownTableCells(line).length >= 2;
}

function isMarkdownTableDivider(line: string) {
  const cells = splitMarkdownTableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function splitMarkdownTableCells(line: string) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseMarkdownTableAlignments(line: string): Array<"left" | "center" | "right"> {
  return splitMarkdownTableCells(line).map((cell) => {
    const normalized = cell.replace(/\s+/g, "");
    if (normalized.startsWith(":") && normalized.endsWith(":")) return "center";
    if (normalized.endsWith(":")) return "right";
    return "left";
  });
}

function tableAlignClass(alignment?: "left" | "center" | "right") {
  if (alignment === "center") return "text-center";
  if (alignment === "right") return "text-right";
  return "text-left";
}

function renderInlineMarkdown(
  text: string,
  citations: MarkdownCitation[] = [],
  onOpenCitation?: (citation: MarkdownCitation) => void
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const citationByIndex = new Map(citations.map((citation) => [citation.index, citation]));
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\[(\d{1,2})\])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(
        <code key={`${match.index}-code`} className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>);
    } else {
      const citationIndex = Number(match[2]);
      const citation = citationByIndex.get(citationIndex);
      if (citation && onOpenCitation) {
        nodes.push(
          <button
            key={`${match.index}-citation`}
            type="button"
            className="mx-0.5 inline-flex h-5 min-w-5 translate-y-[-1px] items-center justify-center rounded border border-border bg-background px-1 text-[11px] font-semibold text-muted-foreground hover:bg-accent hover:text-foreground"
            title={citation.heading || citation.chunkId}
            onClick={() => onOpenCitation(citation)}
          >
            {citation.index}
          </button>
        );
      } else {
        nodes.push(token);
      }
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}
