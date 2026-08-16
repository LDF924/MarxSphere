import { describe, expect, it } from "vitest";
import { SearchService } from "../src/services/search-service.js";
import type { SearchInput } from "../src/types.js";

describe("SearchService", () => {
  it("rejects unsupported strategies instead of silently falling back", async () => {
    const service = new SearchService();
    const input = {
      query: "SAG 是什么？",
      sourceIds: ["00000000-0000-0000-0000-000000000000"],
      strategy: "atomic"
    } as unknown as SearchInput;

    await expect(service.search(input)).rejects.toThrow("Unsupported search strategy: atomic");
  });
});
