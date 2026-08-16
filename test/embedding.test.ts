import { describe, expect, it } from "vitest";
import { deterministicEmbedding } from "../src/ai/embedding-client.js";
import { cosineSimilarity } from "../src/db/vector.js";

describe("deterministicEmbedding", () => {
  it("is stable and normalized", () => {
    const a = deterministicEmbedding("SAG", 32);
    const b = deterministicEmbedding("SAG", 32);

    expect(a).toEqual(b);
    expect(a).toHaveLength(32);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });
});
