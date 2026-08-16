import { describe, expect, it } from "vitest";
import { chunkMarkdown, estimateTokens, stripMarkdown } from "../src/ingestion/chunking/markdown.js";

describe("chunkMarkdown", () => {
  it("creates ordered sections and chunks", () => {
    const result = chunkMarkdown("# One\n\nFirst paragraph.\n\n# Two\n\nSecond paragraph.");

    expect(result.sections.length).toBeGreaterThanOrEqual(2);
    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    expect(result.chunks[0].rank).toBe(0);
    expect(result.chunks[0].sectionIds.length).toBeGreaterThan(0);
  });

  it("strips markdown links and headings", () => {
    expect(stripMarkdown("# Title\n\n[Link](https://example.com)")).toContain("Title");
    expect(stripMarkdown("[Link](https://example.com)")).toBe("Link");
  });

  it("splits long Chinese paragraphs near the configured token limit", () => {
    const paragraph = "SAG系统用于检索中文长文档，并抽取事件、实体、关系和来源片段。".repeat(120);
    const result = chunkMarkdown(paragraph, { mode: "token", maxTokens: 512, overlapTokens: 0 });
    const sectionIds = new Set(result.sections.map((section) => section.id));

    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.sections.length).toBe(result.chunks.length);
    for (const chunk of result.chunks) {
      expect(estimateTokens(chunk.rawContent)).toBeLessThanOrEqual(512);
      for (const sectionId of chunk.sectionIds) {
        expect(sectionIds.has(sectionId)).toBe(true);
      }
    }
  });

  it("splits long English text by token limit even without markdown headings", () => {
    const paragraph = "SAG retrieves evidence through events, entities, relations, and source chunks. ".repeat(180);
    const result = chunkMarkdown(paragraph, { mode: "token", maxTokens: 512, overlapTokens: 0 });

    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(estimateTokens(chunk.rawContent)).toBeLessThanOrEqual(512);
      expect(chunk.heading).toBe("Introduction");
    }
  });

  it("uses heading_strict as the benchmark default", () => {
    const result = chunkMarkdown([
      "# Architecture",
      "",
      "SAG stores source chunks, events, entities, and relations.",
      "",
      "## Retrieval",
      "",
      "The search flow recalls entities and events before returning source chunks."
    ].join("\n"));
    const sectionIds = new Set(result.sections.map((section) => section.id));

    expect(result.chunks).toHaveLength(2);
    expect(result.chunks.map((chunk) => chunk.rank)).toEqual(result.chunks.map((_, index) => index));
    expect(result.sections.some((section) => section.heading === "Architecture")).toBe(true);
    expect(result.sections.some((section) => section.heading === "Retrieval")).toBe(true);
    for (const chunk of result.chunks) {
      expect(chunk.sectionIds.length).toBeGreaterThan(0);
      for (const sectionId of chunk.sectionIds) {
        expect(sectionIds.has(sectionId)).toBe(true);
      }
    }
  });

  it("overlaps token chunks when configured", () => {
    const text = Array.from({ length: 180 }, (_, index) => `token${index}`).join(" ");
    const withoutOverlap = chunkMarkdown(text, { mode: "token", maxTokens: 80, overlapTokens: 0 });
    const withOverlap = chunkMarkdown(text, { mode: "token", maxTokens: 80, overlapTokens: 20 });

    expect(withOverlap.chunks.length).toBeGreaterThan(withoutOverlap.chunks.length);
    for (const chunk of withOverlap.chunks) {
      expect(estimateTokens(chunk.rawContent)).toBeLessThanOrEqual(80);
    }
  });
});
