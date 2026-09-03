// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// search-profiles.ts — 检索策略 profile 化(G6, 对齐 Zleap SearchProfile)
// 参照: zleap/sag/modules/search/profiles.py
// 设计对齐(不简化):
//   - SearchProfile = 不可变配置对象(recall/expansion/ranking 三段), 一次定义, 消融零成本
//   - 与本地现有 searchMode/subStrategy 对应: fast→fast, standard+multi→standard,
//     standard+hopllm→hopllm, 全部档位默认值=现状(行为不变)
export type ProfileName = "fast" | "standard" | "hopllm";

export interface ProfileRecall {
  entityTopK: number;
  multiTopK: number;
  keySimilarityThreshold: number;
  similarityThreshold: number;
  /** G1: 边相似度剪枝阈值(默认 0.35, 对齐 RELATIONAL_EDGE_THRESHOLD) */
  edgeThreshold: number;
}

export interface ProfileExpansion {
  subStrategy: "multi" | "multi1" | "hopllm";
  maxHops: number;
  maxEvents: number;
  maxEventsA: number;
  maxEventsB: number;
  maxHopRetries: number;
  /** G1: 逐跳实体配额(默认 15) */
  entitiesPerHop: number;
  /** G1: 逐跳事件配额(默认 50) */
  eventsPerHop: number;
  /** G1: 新事件向量阈值(默认 0.4) */
  eventThreshold: number;
}

export interface ProfileRanking {
  rerankTopK: number;
  maxSections: number;
}

export interface SearchProfile {
  name: ProfileName;
  recall: ProfileRecall;
  expansion: ProfileExpansion;
  ranking: ProfileRanking;
  /** 约束(对齐 SearchProfilePolicy): 允许的检索模式 */
  allowSearchModes: Array<"standard" | "fast">;
}

export const BUILTIN_SEARCH_PROFILES: Record<ProfileName, SearchProfile> = {
  fast: {
    name: "fast",
    recall: {
      entityTopK: 20,
      multiTopK: 20,
      keySimilarityThreshold: 0.9,
      similarityThreshold: 0.4,
      edgeThreshold: 0.35,
    },
    expansion: {
      subStrategy: "multi",
      maxHops: 1,
      maxEvents: 100,
      maxEventsA: 100,
      maxEventsB: 0,
      maxHopRetries: 3,
      entitiesPerHop: 15,
      eventsPerHop: 50,
      eventThreshold: 0.4,
    },
    ranking: {
      rerankTopK: 20,
      maxSections: 20,
    },
    allowSearchModes: ["fast"],
  },
  standard: {
    name: "standard",
    recall: {
      entityTopK: 20,
      multiTopK: 20,
      keySimilarityThreshold: 0.9,
      similarityThreshold: 0.4,
      edgeThreshold: 0.35,
    },
    expansion: {
      subStrategy: "multi",
      maxHops: 1,
      maxEvents: 100,
      maxEventsA: 100,
      maxEventsB: 0,
      maxHopRetries: 3,
      entitiesPerHop: 15,
      eventsPerHop: 50,
      eventThreshold: 0.4,
    },
    ranking: {
      rerankTopK: 20,
      maxSections: 20,
    },
    allowSearchModes: ["standard", "fast"],
  },
  hopllm: {
    name: "hopllm",
    recall: {
      entityTopK: 20,
      multiTopK: 20,
      keySimilarityThreshold: 0.9,
      similarityThreshold: 0.4,
      edgeThreshold: 0.35,
    },
    expansion: {
      subStrategy: "hopllm",
      maxHops: 1,
      maxEvents: 100,
      maxEventsA: 100,
      maxEventsB: 0,
      maxHopRetries: 3,
      entitiesPerHop: 15,
      eventsPerHop: 50,
      eventThreshold: 0.4,
    },
    ranking: {
      rerankTopK: 20,
      maxSections: 20,
    },
    allowSearchModes: ["standard", "fast"],
  },
};

/** 按 searchMode + subStrategy 解析生效 profile(默认 standard, 对齐现状) */
export function resolveSearchProfile(searchMode?: string, subStrategy?: string): SearchProfile {
  if (searchMode === "fast") return BUILTIN_SEARCH_PROFILES.fast;
  if (subStrategy === "hopllm") return BUILTIN_SEARCH_PROFILES.hopllm;
  return BUILTIN_SEARCH_PROFILES.standard;
}
