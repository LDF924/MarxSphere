// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// MarkdownReader.tsx — MD/纯文本预览 + 划词 AI 卡片(共享组件)
// 替代各面板手写 MarkdownPreview: 渲染逻辑保持一致, 新增原生 Selection API 划词监听
// 选中文本 → 弹 ReaderAiCard(解释/总结/翻译/追问, 复用 /api/reader/ai)
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { ReaderAiCard } from "./ReaderAiCard";

interface MarkdownReaderProps {
  content: string;
}

/** 轻量 Markdown 渲染(与原 MarkdownPreview 一致): 标题/粗体/列表/代码块/围栏 */
export function MarkdownReader({ content }: MarkdownReaderProps) {
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

  // ── 划词监听: 原生 Selection API ──
  // ⚠ 卡片常驻策略(用户明确要求): 划选后卡片一直存在, 直到:
  //   1. 用户点卡片 X 或「关闭」按钮
  //   2. 切换文件(组件卸载)
  //   3. 再次划选 → 新内容替换卡片
  //   ❌ 不做任何自动关闭(selectionchange/mousedown 误判曾导致卡片莫名消失)
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<{ snippet: string; anchor: { x: number; y: number } } | null>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onMouseUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      // 只在当前预览容器内的选择才弹卡
      if (!el.contains(range.commonAncestorContainer)) return;
      const text = sel.toString().replace(/\s+/g, " ").trim();
      if (text.length < 2 || text.length > 3000) return;
      const rect = range.getBoundingClientRect();
      setSelection({ snippet: text, anchor: { x: rect.left + rect.width / 2, y: rect.top } });
    };
    el.addEventListener("mouseup", onMouseUp);
    return () => el.removeEventListener("mouseup", onMouseUp);
  }, []);

  // A4 纸阅读版式: 行宽限制 + 舒适行高(与原 MarkdownPreview 一致)
  return (
    <>
      <div ref={bodyRef} className="mx-auto max-w-3xl space-y-1.5 px-4 py-2 text-sm leading-7">
        {blocks}
      </div>
      {selection && (
        <ReaderAiCard
          key={`${selection.snippet.slice(0, 40)}`}
          snippet={selection.snippet}
          anchor={selection.anchor}
          onClose={() => setSelection(null)}
        />
      )}
    </>
  );
}
