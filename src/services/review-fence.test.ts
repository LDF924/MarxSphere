// review-fence.test.ts — fenced-JSON 审查协议解析单测
import { describe, expect, it } from "vitest";
import { buildReviewFence, splitReviewFence } from "./review-fence.js";

describe("splitReviewFence", () => {
  it("提取 ```review 块并剥除 fence", () => {
    const md = "正文内容\n```review\n{\"findings\":[{\"level\":\"error\",\"title\":\"引用不存在\",\"evidence\":\"[1] 无法解析\",\"check\":\"citation\"}],\"note\":\"人工复核\"}\n```\n";
    const { clean, review } = splitReviewFence(md);
    expect(review).not.toBeNull();
    expect(review?.findings).toHaveLength(1);
    expect(review?.findings[0].level).toBe("error");
    expect(review?.findings[0].title).toBe("引用不存在");
    expect(review?.findings[0].check).toBe("citation");
    expect(review?.note).toBe("人工复核");
    expect(clean).not.toContain("```review");
    expect(clean).toContain("正文内容");
  });

  it("畸形 JSON → review=null 且原文保留", () => {
    const md = "正文\n```review\n{invalid json}\n```\n";
    const { clean, review } = splitReviewFence(md);
    expect(review).toBeNull();
    expect(clean).toBe(md);
  });

  it("无 fence → review=null", () => {
    const { clean, review } = splitReviewFence("普通消息");
    expect(review).toBeNull();
    expect(clean).toBe("普通消息");
  });

  it("非法 level 回退 warn, 无 title 的 findings 被过滤", () => {
    const md = "```review\n{\"findings\":[{\"level\":\"bad\",\"title\":\"x\"},{\"title\":\"\"},{\"title\":\"y\",\"level\":\"ok\"}]}\n```\n";
    const { review } = splitReviewFence(md);
    expect(review?.findings).toHaveLength(2);
    expect(review?.findings[0].level).toBe("warn");
    expect(review?.findings[1].level).toBe("ok");
  });

  it("buildReviewFence 可往返", () => {
    const block = { kind: "reviewer" as const, findings: [{ level: "warn" as const, title: "t", evidence: "e" }], note: "n" };
    const fence = buildReviewFence(block);
    const { review } = splitReviewFence(fence);
    expect(review?.findings[0].title).toBe("t");
    expect(review?.note).toBe("n");
  });
});
