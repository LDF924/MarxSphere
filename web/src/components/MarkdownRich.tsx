// MarkdownRich.tsx — V398: AI 对话页富渲染（代码块语法高亮 + KaTeX 公式 + Mermaid 图表）
// 混合方案：代码块 → react-markdown（rehype-highlight + rehype-katex），正文段 → 现有轻量渲染（引用徽章 [n]）
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import { Check, Copy } from "lucide-react";
import { renderMarkdownLines, type MarkdownCitation } from "../lib/markdown";
import { cn } from "../lib/utils";

/** 代码块分段（增强版：识别 ```lang 语言标签） */
function splitRichBlocks(content: string): Array<{ type: "text" | "code"; content: string; lang?: string }> {
  const blocks: Array<{ type: "text" | "code"; content: string; lang?: string }> = [];
  const regex = /```([a-zA-Z0-9_+-]*)[^\n]*\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: "text", content: content.slice(lastIndex, match.index) });
    }
    blocks.push({ type: "code", content: match[2].trimEnd(), lang: match[1] || undefined });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < content.length) {
    blocks.push({ type: "text", content: content.slice(lastIndex) });
  }
  return blocks.length > 0 ? blocks : [{ type: "text", content }];
}

/** V399: Mermaid 图表渲染（flowchart/sequence/gantt 等）— 懒加载 mermaid，失败回退代码块 */
function MermaidBlock({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let mermaidModule: typeof import("mermaid") | null = null;
    void import("mermaid").then((m) => {
      mermaidModule = m;
      m.default.initialize({
        startOnLoad: false,
        theme: document.documentElement.classList.contains("light") ? "default" : "dark",
        securityLevel: "loose"
      });
      if (!cancelled && ref.current) {
        m.default.render(`mmd-${Date.now()}`, content).then(({ svg }) => {
          if (!cancelled && ref.current) {
            ref.current.innerHTML = svg;
          }
        }).catch((e: unknown) => {
          if (!cancelled) setError(String(e instanceof Error ? e.message : e));
        });
      }
    }).catch(() => {
      if (!cancelled) setError("mermaid 加载失败");
    });
    return () => {
      cancelled = true;
    };
  }, [content]);

  if (error) {
    return (
      <pre className="overflow-auto rounded-md border border-red-400/30 bg-muted/50 p-3 text-xs leading-5 text-muted-foreground">
        <code>{content}</code>
      </pre>
    );
  }
  return <div ref={ref} className="overflow-auto rounded-md border border-border/60 bg-card/60 p-3" />;
}

/** 单个代码块：语言标签 + 复制按钮 + 语法高亮 */
function RichCodeBlock({ content, lang }: { content: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const code = useMemo(() => `\`\`\`${lang ?? ""}\n${content}\n\`\`\``, [content, lang]);
  return (
    <div className="group relative overflow-hidden rounded-md border border-border bg-muted/60">
      <div className="flex items-center justify-between border-b border-border/60 bg-background/40 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {lang || "text"}
        </span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(content).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="flex h-6 items-center gap-1 rounded border border-border/60 px-1.5 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <div className="markdown-rich-code overflow-auto p-3 text-xs leading-5">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {code}
        </ReactMarkdown>
      </div>
    </div>
  );
}

/** 富 Markdown 消息：代码块高亮 + KaTeX 公式 + 引用徽章（正文段走现有轻量渲染） */
export function MarkdownRich({
  content,
  citations = [],
  onOpenCitation
}: {
  content: string;
  citations?: MarkdownCitation[];
  onOpenCitation?: (citation: MarkdownCitation) => void;
}) {
  const blocks = splitRichBlocks(content);
  return (
    <div className="space-y-2 break-words">
      {blocks.map((block, index) =>
        block.type === "code" ? (
          block.lang === "mermaid" ? (
            <MermaidBlock key={index} content={block.content} />
          ) : (
            <RichCodeBlock key={index} content={block.content} lang={block.lang} />
          )
        ) : (
          <div key={index} className="space-y-1">
            {renderMarkdownLines(block.content, citations, onOpenCitation)}
          </div>
        )
      )}
    </div>
  );
}

/** 流式增量渲染（轻量，快速）：仅 KaTeX 公式 + 行内样式，无代码块高亮（流式性能优先） */
export function MarkdownStreaming({ content }: { content: string }) {
  const nodes: ReactNode[] = [];
  const parts = content.split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+\$)/g);
  for (const part of parts) {
    if (/^\$\$[\s\S]+\$\$$/.test(part) || /^\$[^$\n]+\$$/.test(part)) {
      nodes.push(
        <span key={nodes.length} className="markdown-rich-inline">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeKatex]}>
            {part}
          </ReactMarkdown>
        </span>
      );
    } else {
      nodes.push(
        <span key={nodes.length} className="whitespace-pre-wrap">
          {renderMarkdownLines(part)}
        </span>
      );
    }
  }
  return <div className={cn("space-y-1 break-words")}>{nodes}</div>;
}
