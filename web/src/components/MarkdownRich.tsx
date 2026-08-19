// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
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

/** V399: 轻量图表渲染（```chart JSON → 纯 SVG 柱状图/折线图/饼图，无额外依赖） */
function ChartBlock({ content }: { content: string }) {
  const [error, setError] = useState<string | null>(null);
  const chart = useMemo(() => {
    try {
      return JSON.parse(content) as {
        type?: "bar" | "line" | "pie";
        title?: string;
        labels?: string[];
        data?: number[];
        datasets?: Array<{ label?: string; data?: number[] }>;
      };
    } catch {
      return null;
    }
  }, [content]);

  if (!chart || !Array.isArray(chart.data) || chart.data.length === 0) {
    return <pre className="overflow-auto rounded-md border border-border/60 bg-muted/50 p-3 text-xs text-muted-foreground"><code>{content}</code></pre>;
  }

  const W = 420;
  const H = 200;
  const PAD = 34;
  const labels = chart.labels ?? chart.data.map((_, i) => `#${i + 1}`);
  const max = Math.max(...chart.data, 1);
  const primary = "hsl(214 55% 48%)";
  const grid = "hsl(var(--border))";

  // 饼图
  if (chart.type === "pie") {
    const total = chart.data.reduce((s, v) => s + Math.max(v, 0), 0) || 1;
    let acc = 0;
    const colors = ["hsl(214 55% 55%)", "hsl(43 96% 60%)", "hsl(150 45% 50%)", "hsl(280 50% 60%)", "hsl(25 90% 55%)", "hsl(220 10% 55%)"];
    const arcs = chart.data.map((v, i) => {
      const start = (acc / total) * 360;
      acc += Math.max(v, 0);
      const end = (acc / total) * 360;
      const x1 = 100 + 80 * Math.cos((start - 90) * Math.PI / 180);
      const y1 = 100 + 80 * Math.sin((start - 90) * Math.PI / 180);
      const x2 = 100 + 80 * Math.cos((end - 90) * Math.PI / 180);
      const y2 = 100 + 80 * Math.sin((end - 90) * Math.PI / 180);
      const large = end - start > 180 ? 1 : 0;
      return (
        <path key={i} d={`M100 100 L${x1} ${y1} A80 80 0 ${large} 1 ${x2} ${y2} Z`} fill={colors[i % colors.length]} stroke="hsl(var(--card))" strokeWidth="1" />
      );
    });
    return (
      <div className="overflow-auto rounded-md border border-border/60 bg-card/60 p-3">
        {chart.title ? <div className="mb-2 text-center text-xs font-medium text-foreground">{chart.title}</div> : null}
        <svg viewBox="0 0 200 200" className="mx-auto h-44">
          {arcs}
        </svg>
        <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1">
          {labels.map((l, i) => (
            <span key={i} className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="h-2 w-2 rounded-sm" style={{ background: colors[i % colors.length] }} />
              {l}（{chart.data?.[i]}）
            </span>
          ))}
        </div>
      </div>
    );
  }

  // 柱状图 / 折线图
  const n = chart.data.length;
  const slot = (W - PAD * 2) / n;
  const bars = chart.type === "line" ? null : chart.data.map((v, i) => (
    <rect key={i} x={PAD + slot * i + slot * 0.2} y={H - PAD - (v / max) * (H - PAD * 2)} width={slot * 0.6} height={(v / max) * (H - PAD * 2)} fill={primary} rx="2" opacity="0.85">
      <title>{`${labels[i]}: ${v}`}</title>
    </rect>
  ));
  const linePoints = chart.data.map((v, i) => `${PAD + slot * i + slot / 2},${H - PAD - (v / max) * (H - PAD * 2)}`).join(" ");
  const line = chart.type === "line" ? (
    <>
      <polyline points={linePoints} fill="none" stroke={primary} strokeWidth="2" strokeLinejoin="round" />
      {chart.data.map((v, i) => (
        <circle key={i} cx={PAD + slot * i + slot / 2} cy={H - PAD - (v / max) * (H - PAD * 2)} r="3" fill={primary}>
          <title>{`${labels[i]}: ${v}`}</title>
        </circle>
      ))}
    </>
  ) : null;

  return (
    <div className="overflow-auto rounded-md border border-border/60 bg-card/60 p-3">
      {chart.title ? <div className="mb-2 text-center text-xs font-medium text-foreground">{chart.title}</div> : null}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-md">
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke={grid} />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke={grid} />
        {[0.25, 0.5, 0.75].map((t) => (
          <line key={t} x1={PAD} y1={PAD + (1 - t) * (H - PAD * 2)} x2={W - PAD} y2={PAD + (1 - t) * (H - PAD * 2)} stroke={grid} strokeDasharray="3 3" opacity="0.4" />
        ))}
        {bars}
        {line}
        {labels.map((l, i) => (
          <text key={i} x={PAD + slot * i + slot / 2} y={H - PAD + 14} textAnchor="middle" fontSize="8" fill="hsl(var(--muted-foreground))">
            {String(l).slice(0, 8)}
          </text>
        ))}
      </svg>
    </div>
  );
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
          ) : block.lang === "chart" ? (
            <ChartBlock key={index} content={block.content} />
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
  // V399: 流式分段 — 闭合的 mermaid 代码块即时渲染为图表，公式单独渲染，其余走轻量渲染
  const segments = content.split(/(```mermaid[\s\S]*?```|\$\$[\s\S]+?\$\$|\$[^$\n]+\$)/g);
  for (const part of segments) {
    if (/^```mermaid[\s\S]*```$/.test(part.trim())) {
      const code = part.replace(/^```mermaid\s*\n?/, "").replace(/\n?```$/, "");
      nodes.push(<MermaidBlock key={nodes.length} content={code} />);
    } else if (/^\$\$[\s\S]+\$\$$/.test(part) || /^\$[^$\n]+\$$/.test(part)) {
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
