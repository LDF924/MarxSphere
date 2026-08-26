import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  aggregateContentHashFingerprint,
  artifactHashOf,
  isStaleFingerprint,
  type EvalFingerprint,
} from "../src/services/eval-fingerprint.js";

// V399-2 文献入库哈希版本化 P1/P2 — 评测数据指纹纯函数测试（不依赖 DB/API）
// 共享模块 src/services/eval-fingerprint.ts（server 侧 stale 判定 + 评测脚本同源）:
//   aggregateContentHashFingerprint: 排序+去重后 join('\n') 再 sha256
//   artifactHashOf: 内容 sha256（产物哈希登记 3.6）
//   isStaleFingerprint: 历史指纹 ≠ 当前指纹 → stale（3.3 改动点E）

describe("eval data fingerprint (V399-2 P1)", () => {
  it("fingerprint is 64 hex chars (sha256)", () => {
    const fp = aggregateContentHashFingerprint(["a", "b", "c"]);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same content_hash set produces identical fingerprint", () => {
    const set1 = ["hash1", "hash2", "hash3"];
    const set2 = ["hash3", "hash2", "hash1"]; // 顺序颠倒
    expect(aggregateContentHashFingerprint(set1)).toBe(aggregateContentHashFingerprint(set2));
  });

  it("duplicate hashes do not change fingerprint (dedup)", () => {
    const withDup = ["hash1", "hash2", "hash2", "hash1"];
    const noDup = ["hash1", "hash2"];
    expect(aggregateContentHashFingerprint(withDup)).toBe(aggregateContentHashFingerprint(noDup));
  });

  it("different content_hash set produces different fingerprint", () => {
    const a = ["hash1", "hash2", "hash3"];
    const b = ["hash1", "hash2", "hash4"]; // 一篇文档内容变了 → 指纹变
    expect(aggregateContentHashFingerprint(a)).not.toBe(aggregateContentHashFingerprint(b));
  });

  it("empty set has deterministic fingerprint (empty repo)", () => {
    expect(aggregateContentHashFingerprint([])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("artifactHashOf matches direct sha256 (artifact hash registration)", () => {
    const content = '{"foo":"bar"}';
    expect(artifactHashOf(content)).toBe(createHash("sha256").update(content).digest("hex"));
  });
});

describe("stale detection (V399-2 P2)", () => {
  const fp = (value: string | null): EvalFingerprint => ({
    algorithm: "sha256-of-doc-content-hashes",
    value,
    sampledAt: new Date().toISOString(),
  });

  it("different fingerprints → stale (data changed)", () => {
    expect(isStaleFingerprint(fp("aaa"), fp("bbb"))).toBe(true);
  });

  it("same fingerprint → not stale", () => {
    expect(isStaleFingerprint(fp("aaa"), fp("aaa"))).toBe(false);
  });

  it("missing fingerprint (old artifact / degraded) → not stale", () => {
    expect(isStaleFingerprint(null, fp("aaa"))).toBe(false);
    expect(isStaleFingerprint(undefined, fp("aaa"))).toBe(false);
    expect(isStaleFingerprint(fp(null), fp("aaa"))).toBe(false);
    expect(isStaleFingerprint(fp("aaa"), null)).toBe(false);
  });
});
