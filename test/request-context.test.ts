// request-context.test.ts — 调用者身份上下文(账单归属的地基)
// 背景(2026-09-11): 服务层拿不到 request, 靠这个 ALS 才能按用户记账/计费。
// 已实测: Fastify 的 onRequest hook 里 als.run 不传播到 handler, 必须在路由处理器入口 run。
import { describe, expect, it } from "vitest";
import { runWithContext, getRequestContext, currentUserId } from "../src/services/request-context.js";

describe("request-context", () => {
  it("无上下文时返回 undefined(系统/后台调用)", () => {
    expect(getRequestContext()).toBeUndefined();
    expect(currentUserId()).toBeUndefined();
  });

  it("runWithContext 内可读到 userId/tenantId", () => {
    runWithContext({ userId: "u-1", tenantId: "t-1" }, () => {
      expect(currentUserId()).toBe("u-1");
      expect(getRequestContext()?.tenantId).toBe("t-1");
    });
  });

  it("上下文穿透 await 的深层异步调用", async () => {
    const deep = async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentUserId();
    };
    const got = await runWithContext({ userId: "u-2" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return deep();
    });
    expect(got).toBe("u-2");
  });

  it("退出后不残留(请求间不串号)", () => {
    runWithContext({ userId: "u-3" }, () => { /* 占用一次 */ });
    expect(currentUserId()).toBeUndefined();
  });

  it("空身份 = 不计费的系统调用, 不抛错", () => {
    runWithContext({}, () => {
      expect(currentUserId()).toBeUndefined();
    });
  });

  it("异常原样透传, 且不污染外层上下文", () => {
    expect(() => runWithContext({ userId: "u-4" }, () => { throw new Error("boom"); })).toThrow("boom");
    expect(currentUserId()).toBeUndefined();
  });
});
