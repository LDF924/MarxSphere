// search-profiles.test.ts — 检索策略 profile 单测(G6, 对齐 Zleap SearchProfile 语义)
import { describe, expect, it } from "vitest";

import { BUILTIN_SEARCH_PROFILES, resolveSearchProfile } from "../src/services/search-profiles.js";

describe("BUILTIN_SEARCH_PROFILES", () => {
  it("三档齐全且字段完整", () => {
    expect(Object.keys(BUILTIN_SEARCH_PROFILES)).toEqual(["fast", "standard", "hopllm"]);
    for (const profile of Object.values(BUILTIN_SEARCH_PROFILES)) {
      expect(profile.recall.entityTopK).toBeGreaterThan(0);
      expect(profile.recall.multiTopK).toBeGreaterThan(0);
      expect(profile.recall.keySimilarityThreshold).toBeGreaterThan(0);
      expect(profile.recall.similarityThreshold).toBeGreaterThan(0);
      expect(profile.expansion.maxHops).toBeGreaterThan(0);
      expect(profile.expansion.entitiesPerHop).toBeGreaterThan(0);
      expect(profile.expansion.eventsPerHop).toBeGreaterThan(0);
      expect(profile.ranking.maxSections).toBeGreaterThan(0);
    }
  });

  it("默认值 = 现状(行为不变)", () => {
    const standard = BUILTIN_SEARCH_PROFILES.standard;
    expect(standard.recall.entityTopK).toBe(20);
    expect(standard.recall.multiTopK).toBe(20);
    expect(standard.recall.keySimilarityThreshold).toBe(0.9);
    expect(standard.recall.similarityThreshold).toBe(0.4);
    expect(standard.expansion.maxHops).toBe(1);
    expect(standard.expansion.maxEventsA).toBe(100);
    expect(standard.expansion.maxHopRetries).toBe(3);
  });
});

describe("resolveSearchProfile", () => {
  it("fast 模式 → fast profile", () => {
    expect(resolveSearchProfile("fast", "multi").name).toBe("fast");
  });
  it("hopllm 子策略 → hopllm profile", () => {
    expect(resolveSearchProfile("standard", "hopllm").name).toBe("hopllm");
  });
  it("默认 → standard profile", () => {
    expect(resolveSearchProfile().name).toBe("standard");
    expect(resolveSearchProfile("standard", "multi").name).toBe("standard");
  });
});
