// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// structural-chunker.ts — 结构化分块（2026-08-29, 移植自 Inno Agent structural-chunker.ts, MIT License）
// Copyright (c) 2026 Inno Agent Contributors — 算法与结构保持一致
// 两级分块(不丢内容):
//   1. semanticBlocks: 按标题(#)分语义块, 每块带 headingPath(标题路径)
//   2. splitOversizedBlock: 超长块按句子(.!?。！？)切, 超长句硬切
//   3. 循环兜底: 极少情况仍超长时按 targetChars 切 + 只读重叠
export interface StructuralChunkOptions {
  targetChars?: number;
  overlapChars?: number;
}

export interface SemanticChunk {
  text: string;
  headingPath: string;
}

const DEFAULT_TARGET_CHARS = 24_000;
const DEFAULT_OVERLAP_CHARS = 400;

/** 边界优先分块(源码 lastBoundary: 标题>段落>句号) */
function lastBoundary(content: string, start: number, hardEnd: number): number {
  const minEnd = Math.min(hardEnd, start + Math.floor((hardEnd - start) * 0.6));
  const window = content.slice(minEnd, hardEnd);
  const candidates = [
    window.lastIndexOf("\n#"),
    window.lastIndexOf("\n\n"),
    Math.max(window.lastIndexOf("。"), window.lastIndexOf("！"), window.lastIndexOf("？"), window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? ")),
  ];
  const relative = Math.max(...candidates);
  if (relative < 0) return hardEnd;
  return minEnd + relative + (window.startsWith("\n#", relative) ? 1 : 2);
}

/** 超长块按句子切(源码 splitOversizedBlock) */
function splitOversizedBlock(block: string, targetChars: number): string[] {
  if (block.length <= targetChars * 1.25) return [block];
  const pieces = block.match(/[^.!?。！？\n]+[.!?。！？]?|\n+/g) ?? [block];
  const output: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length > targetChars) { output.push(current.trim()); current = ""; }
    if (piece.length > targetChars) {
      for (let index = 0; index < piece.length; index += targetChars) {
        const slice = piece.slice(index, index + targetChars).trim();
        if (slice) output.push(slice);
      }
    } else current += piece;
  }
  if (current.trim()) output.push(current.trim());
  return output;
}

/** 按标题分语义块(源码 semanticBlocks: 标题路径栈 + 段落累积) */
function semanticBlocks(content: string, targetChars: number): SemanticChunk[] {
  const blocks: SemanticChunk[] = [];
  const headingStack: string[] = [];
  let paragraph: string[] = [];
  let paragraphHeading = "";
  const headingPath = () => headingStack.filter(Boolean).join(" > ");
  const flush = () => {
    const text = paragraph.join("\n").trim();
    if (text) for (const piece of splitOversizedBlock(text, targetChars)) blocks.push({ text: piece, headingPath: paragraphHeading });
    paragraph = [];
  };
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const depth = heading[1].length;
      headingStack.length = depth - 1;
      headingStack[depth - 1] = heading[2].trim();
      paragraphHeading = headingPath();
    } else if (line.trim() === "---") {
      flush();
    } else if (line.trim()) {
      paragraph.push(line);
    } else if (paragraph.length > 0) {
      flush();
    }
  }
  flush();
  return blocks;
}

/** 结构化分块(与源码 splitStructuralChunks 一致): 语义块 + 循环兜底 */
export function splitStructuralChunks(content: string, options: StructuralChunkOptions = {}): string[] {
  if (!content) return [];
  const targetChars = Math.max(1_000, Math.trunc(options.targetChars ?? DEFAULT_TARGET_CHARS));
  const overlapChars = Math.max(0, Math.min(Math.trunc(options.overlapChars ?? DEFAULT_OVERLAP_CHARS), Math.floor(targetChars / 4)));
  const blocks = semanticBlocks(content, targetChars);
  if (blocks.length === 0) return [content];

  const chunks: string[] = [];
  let cursor = 0;
  for (const block of blocks) {
    // 语义块内部超长 → 按目标长度切(句号边界优先)
    const chunkStart = cursor;
    let blockCursor = 0;
    while (blockCursor < block.text.length) {
      const hardEnd = Math.min(block.text.length, blockCursor + targetChars);
      const end = hardEnd < block.text.length ? lastBoundary(block.text, blockCursor, hardEnd) : hardEnd;
      const safeEnd = end > blockCursor ? end : hardEnd;
      const start = blockCursor > 0 ? Math.max(0, blockCursor - overlapChars) : blockCursor;
      chunks.push(block.text.slice(start, safeEnd));
      blockCursor = safeEnd;
    }
    cursor = chunkStart + block.text.length;
  }
  // 兜底: 全部块超短且未覆盖全文 → 按目标切(与源码循环一致)
  const joined = chunks.join("");
  if (joined.length < content.length * 0.6 && content.length > targetChars) {
    const fallback: string[] = [];
    let c = 0;
    while (c < content.length) {
      const hardEnd = Math.min(content.length, c + targetChars);
      const end = hardEnd < content.length ? lastBoundary(content, c, hardEnd) : hardEnd;
      const safeEnd = end > c ? end : hardEnd;
      const start = fallback.length === 0 ? c : Math.max(0, c - overlapChars);
      fallback.push(content.slice(start, safeEnd));
      c = safeEnd;
    }
    return fallback;
  }
  return chunks;
}

/** 带标题路径的分块(供 RAG 引用来源) */
export function splitSemanticChunks(content: string, options: StructuralChunkOptions = {}): SemanticChunk[] {
  const targetChars = Math.max(1_000, Math.trunc(options.targetChars ?? DEFAULT_TARGET_CHARS));
  return semanticBlocks(content, targetChars);
}

export const structuralChunkerService = { splitStructuralChunks, splitSemanticChunks };
