import { randomUUID } from "node:crypto";
import { decode, encode } from "gpt-tokenizer/encoding/cl100k_base";
import type { ChunkingMode } from "../../types.js";

export interface SectionDraft {
  id: string;
  orderIndex: number;
  heading: string;
  content: string;
  rawContent: string;
  tokenCount: number;
}

export interface ChunkDraft {
  id: string;
  rank: number;
  heading: string;
  content: string;
  rawContent: string;
  sectionIds: string[];
}

export interface ChunkingResult {
  sections: SectionDraft[];
  chunks: ChunkDraft[];
}

export interface ChunkMarkdownOptions {
  mode?: ChunkingMode;
  maxTokens?: number;
  overlapTokens?: number;
}

export function chunkMarkdown(content: string, options: ChunkMarkdownOptions = {}): ChunkingResult {
  const mode = options.mode ?? (options.maxTokens == null && options.overlapTokens == null ? "heading_strict" : "token");
  if (mode === "heading_strict") {
    const sections = buildHeadingStrictSections(content);
    return {
      sections,
      chunks: sections.map((section, index) => buildChunk([section], index))
    };
  }
  const sections = buildTokenWindowSections(content, options);
  return {
    sections,
    chunks: sections.map((section, index) => buildChunk([section], index))
  };
}

function buildHeadingStrictSections(content: string): SectionDraft[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const sections: SectionDraft[] = [];
  let headings: Array<{ level: number; title: string; line: string }> = [];
  let contentLines: string[] = [];

  function flush(): void {
    if (headings.length === 0 && contentLines.every((line) => !line.trim())) {
      contentLines = [];
      return;
    }
    const headingContent = headings.map((heading) => heading.line).join("\n");
    const body = contentLines.join("\n").trim();
    const rawContent = [headingContent, body].filter(Boolean).join("\n").trim();
    if (!rawContent) {
      headings = [];
      contentLines = [];
      return;
    }
    const mainHeading = headings.length > 0
      ? headings.reduce((best, heading) => heading.level < best.level ? heading : best, headings[0]).title
      : "Introduction";
    sections.push({
      id: randomUUID(),
      orderIndex: sections.length,
      heading: mainHeading,
      content: stripMarkdown(rawContent),
      rawContent,
      tokenCount: estimateTokens(rawContent)
    });
    headings = [];
    contentLines = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flush();
      headings = [{
        level: headingMatch[1].length,
        title: headingMatch[2].trim(),
        line
      }];
      continue;
    }
    contentLines.push(line);
  }
  flush();

  if (sections.length === 0 && content.trim()) {
    const rawContent = content.trim();
    sections.push({
      id: randomUUID(),
      orderIndex: 0,
      heading: "Introduction",
      content: stripMarkdown(rawContent),
      rawContent,
      tokenCount: estimateTokens(rawContent)
    });
  }
  return sections;
}

function buildTokenWindowSections(content: string, options: ChunkMarkdownOptions): SectionDraft[] {
  const maxTokens = normalizeTokenCount(options.maxTokens ?? 512, 64, 8192);
  const overlapTokens = normalizeTokenCount(options.overlapTokens ?? 100, 0, maxTokens - 1);
  const tokenIds = encode(content);
  if (tokenIds.length === 0) {
    return [];
  }
  const stride = Math.max(1, maxTokens - overlapTokens);
  const sections: SectionDraft[] = [];
  for (let start = 0; start < tokenIds.length; start += stride) {
    let end = Math.min(start + maxTokens, tokenIds.length);
    let rawContent = decode(tokenIds.slice(start, end)).trim();
    while (estimateTokens(rawContent) > maxTokens && end > start + 1) {
      end -= 1;
      rawContent = decode(tokenIds.slice(start, end)).trim();
    }
    if (!rawContent) {
      if (end >= tokenIds.length) {
        break;
      }
      continue;
    }
    sections.push({
      id: randomUUID(),
      orderIndex: sections.length,
      heading: extractFirstHeading(rawContent) ?? "Introduction",
      content: stripMarkdown(rawContent),
      rawContent,
      tokenCount: estimateTokens(rawContent)
    });
    if (end >= tokenIds.length) {
      break;
    }
  }
  return sections;
}

function normalizeTokenCount(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(Math.trunc(value), max));
}

function extractFirstHeading(text: string): string | null {
  for (const line of text.split("\n")) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      return headingMatch[2].trim();
    }
  }
  return null;
}

function buildSections(content: string): SectionDraft[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const sections: SectionDraft[] = [];
  let heading = "Introduction";
  let buffer: string[] = [];

  function flush(): void {
    const raw = buffer.join("\n").trim();
    if (!raw) {
      return;
    }
    sections.push({
      id: randomUUID(),
      orderIndex: sections.length,
      heading,
      content: stripMarkdown(raw),
      rawContent: raw,
      tokenCount: estimateTokens(raw)
    });
    buffer = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flush();
      heading = headingMatch[2].trim();
      buffer.push(line);
      continue;
    }
    if (!line.trim() && buffer.length > 0) {
      buffer.push(line);
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();

  if (sections.length === 0 && content.trim()) {
    sections.push({
      id: randomUUID(),
      orderIndex: 0,
      heading,
      content: stripMarkdown(content),
      rawContent: content,
      tokenCount: estimateTokens(content)
    });
  }
  return sections;
}

function splitLargeSection(section: SectionDraft, maxTokens: number): SectionDraft[] {
  const paragraphs = section.rawContent.split(/\n{2,}/);
  const result: SectionDraft[] = [];
  let buffer: string[] = [];
  let tokens = 0;
  for (const paragraph of paragraphs) {
    const paragraphTokens = estimateTokens(paragraph);
    if (paragraphTokens > maxTokens) {
      if (buffer.length > 0) {
        result.push(cloneSection(section, buffer.join("\n\n"), result.length));
        buffer = [];
        tokens = 0;
      }
      for (const fragment of splitTextByTokenLimit(paragraph, maxTokens)) {
        result.push(cloneSection(section, fragment, result.length));
      }
      continue;
    }
    if (buffer.length > 0 && tokens + paragraphTokens > maxTokens) {
      result.push(cloneSection(section, buffer.join("\n\n"), result.length));
      buffer = [];
      tokens = 0;
    }
    buffer.push(paragraph);
    tokens += paragraphTokens;
  }
  if (buffer.length > 0) {
    result.push(cloneSection(section, buffer.join("\n\n"), result.length));
  }
  return result;
}

function splitTextByTokenLimit(text: string, maxTokens: number): string[] {
  const sentences = splitBySentenceBoundary(text);
  const chunks: string[] = [];
  let buffer = "";
  let bufferTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);
    if (sentenceTokens > maxTokens) {
      if (buffer.trim()) {
        chunks.push(buffer.trim());
        buffer = "";
        bufferTokens = 0;
      }
      chunks.push(...forceSplitByTokenLimit(sentence, maxTokens));
      continue;
    }
    if (!buffer || bufferTokens + sentenceTokens <= maxTokens) {
      buffer += sentence;
      bufferTokens += sentenceTokens;
      continue;
    }
    chunks.push(buffer.trim());
    buffer = sentence;
    bufferTokens = sentenceTokens;
  }

  if (buffer.trim()) {
    chunks.push(buffer.trim());
  }
  return chunks.filter(Boolean);
}

function splitBySentenceBoundary(text: string): string[] {
  const parts = text.match(/[^。！？!?；;\n]+[。！？!?；;\n]?|\n+/gu) ?? [text];
  return parts.filter((part) => part.length > 0);
}

function forceSplitByTokenLimit(text: string, maxTokens: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining) {
    if (estimateTokens(remaining) <= maxTokens) {
      chunks.push(remaining);
      break;
    }

    let cut = findPrefixLengthByTokenLimit(remaining, maxTokens);
    if (cut <= 0) {
      cut = 1;
    }

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }

  return chunks.filter(Boolean);
}

function findPrefixLengthByTokenLimit(text: string, maxTokens: number): number {
  let low = 0;
  let high = text.length;
  let best = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    const tokens = estimateTokens(candidate);
    if (tokens <= maxTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function cloneSection(section: SectionDraft, rawContent: string, offset: number): SectionDraft {
  return {
    id: randomUUID(),
    orderIndex: section.orderIndex + offset / 1000,
    heading: section.heading,
    content: stripMarkdown(rawContent),
    rawContent,
    tokenCount: estimateTokens(rawContent)
  };
}

function buildChunk(sections: SectionDraft[], rank: number): ChunkDraft {
  const heading = sections.find((section) => section.heading)?.heading ?? "Untitled";
  return {
    id: randomUUID(),
    rank,
    heading,
    content: sections.map((section) => section.content).join("\n").trim(),
    rawContent: sections.map((section) => section.rawContent).join("\n\n"),
    sectionIds: sections.map((section) => section.id)
  };
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function estimateTokens(text: string): number {
  return Math.max(1, encode(text).length);
}
