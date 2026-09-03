// universe-view-settings-drawer.test.ts — 设置契约单测(移植 Zleap,去掉双语文案断言)
import { describe, expect, it } from "vitest";

import {
  DEFAULT_UNIVERSE_VIEW_PREFERENCES,
  UNIVERSE_VIEW_LIMITS,
  minimumUniverseCacheCapacity,
  normalizeUniverseViewPreferences,
} from "./universe-view-preferences";

describe("knowledge universe settings contract", () => {
  it("exposes one configuration shared by exploration and accumulation", () => {
    expect(DEFAULT_UNIVERSE_VIEW_PREFERENCES).toEqual({
      version: 7,
      cacheCapacity: 1_000,
      eventWindowSize: 50,
      cardsEnabled: true,
      eventCardPreviewCount: 13,
      temporalPageSize: 20,
      temporalPrefetchPages: 3,
      entityTypes: null,
      documentIds: null,
    });
  });

  it("keeps cache, scene window and network page capacities distinct", () => {
    const normalized = normalizeUniverseViewPreferences({
      ...DEFAULT_UNIVERSE_VIEW_PREFERENCES,
      cacheCapacity: 1_000,
      eventWindowSize: 50,
      temporalPageSize: 20,
      temporalPrefetchPages: 3,
    });

    expect(normalized.cacheCapacity).toBe(1_000);
    expect(normalized.eventWindowSize).toBe(50);
    expect(normalized.temporalPageSize).toBe(20);
    expect(normalized.temporalPrefetchPages).toBe(3);
    expect(minimumUniverseCacheCapacity(50, 20, 3)).toBe(200);
  });

  it("supports production-sized ranges without device-specific silent caps", () => {
    expect(UNIVERSE_VIEW_LIMITS.cacheCapacity).toMatchObject({
      min: 200,
      max: 5_000,
      default: 1_000,
    });
    expect(UNIVERSE_VIEW_LIMITS.eventWindowSize).toMatchObject({
      min: 20,
      max: 100,
      default: 50,
    });
    expect(UNIVERSE_VIEW_LIMITS.eventCardPreviewCount).toMatchObject({
      min: 1,
      max: 20,
      default: 13,
    });
  });

  it("repairs filters while preserving all-documents and all-types semantics", () => {
    expect(normalizeUniverseViewPreferences({
      ...DEFAULT_UNIVERSE_VIEW_PREFERENCES,
      entityTypes: [" Person ", "Person", "", "Concept"],
      documentIds: ["doc-b", " doc-a ", "doc-a", ""],
    })).toMatchObject({
      entityTypes: ["Concept", "Person"],
      documentIds: ["doc-a", "doc-b"],
    });
    expect(normalizeUniverseViewPreferences({
      ...DEFAULT_UNIVERSE_VIEW_PREFERENCES,
      entityTypes: null,
      documentIds: null,
    })).toMatchObject({
      entityTypes: null,
      documentIds: null,
    });
  });
});
