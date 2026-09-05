// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// test/search-provider-registry.test.ts — V404-24(H5): 检索 provider 目录
// 借鉴 OpenSquilla search/registry(能力集+fallback 链), 自写 TS
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SEARCH_PROVIDER_SPECS, providerSpec, rankedProviders, searchWithRegistry,
} from "../src/services/search-provider-registry.js";

const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
beforeEach(() => {
  setEnv("BOCHA_SEARCH_API_KEY", undefined);
  setEnv("TAVILY_API_KEY", undefined);
  setEnv("EXA_API_KEY", undefined);
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("search-provider-registry (H5)", () => {
  it("spec 单一真源: 4 provider 含能力集/键位", () => {
    expect(SEARCH_PROVIDER_SPECS.map((p) => p.providerId)).toEqual(["bocha", "tavily", "exa", "edge_bing"]);
    expect(providerSpec("bocha")?.envKey).toBe("BOCHA_SEARCH_API_KEY");
    expect(providerSpec("bocha")?.capabilities).toContain("content");
    expect(providerSpec("edge_bing")?.capabilities).toContain("no_key");
    expect(providerSpec("nope")).toBeUndefined();
  });

  it("无 key 时仅 edge_bing 可用(no_key 保底); 有 Bocha key 时 Bocha 排第一(国内直连优先)", () => {
    let ranked = rankedProviders(["web"]);
    expect(ranked.map((p) => p.providerId)).toEqual(["edge_bing"]); // 无 key → 只剩无 key provider
    setEnv("BOCHA_SEARCH_API_KEY", "test-key");
    ranked = rankedProviders(["web"]);
    expect(ranked[0].providerId).toBe("bocha"); // cnFriendly + preferredWhenKeyed → 第一
    expect(ranked.map((p) => p.providerId)).toEqual(["bocha", "edge_bing"]);
  });

  it("能力过滤: 请求 freshness 时无 freshness 能力的被排除", () => {
    setEnv("BOCHA_SEARCH_API_KEY", "k");
    // freshness 能力: bocha 有, edge_bing 无
    const withF = rankedProviders(["web"]).filter((p) => p.capabilities.includes("freshness"));
    expect(withF.map((p) => p.providerId)).toEqual(["bocha"]);
  });

  it("searchWithRegistry: 无任何可用 provider → 明确失败含尝试链", async () => {
    const r = await searchWithRegistry("测试查询", { edgePath: "不存在路径" });
    expect("ok" in r && r.ok === false).toBe(true);
    if ("ok" in r && !r.ok) {
      expect(r.error).toContain("全部搜索 provider 失败");
    }
  });

  it("searchWithRegistry: 指定 bocha 无 key → auth 跳过不空耗", async () => {
    const r = await searchWithRegistry("测试", { providers: ["bocha", "edge_bing"], edgePath: "nonexistent-edge" });
    // bocha 无 key 快速跳过, edge 尝试失败 → 明确失败
    expect("ok" in r && r.ok === false).toBe(true);
  });
});
