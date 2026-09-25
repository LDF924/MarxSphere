// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
/**
 * authed-image 契约测试。
 *
 * 为什么值得测: 这套重试规格(哪些码重试、哪些立刻放弃、退避多久)是**照抄参考产品**的,
 * 而它的失效方式很安静 —— 比如把"不可恢复的码立即放弃"写掉, 表现只是"用户多等 900ms",
 * 没人会报障; 又比如漏掉 Authorization, 本机有鉴权豁免、**只有上云才 401**。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchImageObjectUrl, RETRYABLE_STATUS } from "./authed-image";

const mkRes = (status: number, ok = status >= 200 && status < 300) =>
  ({ ok, status, blob: async () => new Blob(["x"]) }) as unknown as Response;

describe("fetchImageObjectUrl", () => {
  // 这个仓的单测跑在 node 环境(没有 jsdom), 所以 localStorage 与 URL.createObjectURL
  //   都得自己搭 —— 顺带把"token 从哪来"这件事固定在测试里。
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    store.set("sag_token", "tok-123");
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("成功时返回 object URL, 且带 Authorization 与 no-store", async () => {
    const fetchMock = vi.fn(async () => mkRes(200));
    vi.stubGlobal("fetch", fetchMock);
    const url = await fetchImageObjectUrl("/api/viz/files/a.png");
    expect(url).toBe("blob:fake");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
    // 产物图会被同名覆盖, 吃缓存就会显示旧图 —— 这条必须钉住
    expect(init.cache).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("可恢复的状态码重试到上限(4 次), 退避 150/300/450", async () => {
    // 断言的是**传给 setTimeout 的延迟**(那才是契约), 不是实测耗时 ——
    //   mock 成同步执行时 Date.now() 根本不走, 量出来永远是 1ms(第一版就这么写的)。
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
      delays.push(Number(ms));
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const fetchMock = vi.fn(async () => mkRes(500));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(fetchImageObjectUrl("/api/viz/files/a.png")).rejects.toThrow(/500/);
    } finally {
      vi.stubGlobal("setTimeout", realSetTimeout);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([150, 300, 450]);
  });

  it("不可恢复的状态码立即放弃, 只请求 1 次", async () => {
    const fetchMock = vi.fn(async () => mkRes(403));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchImageObjectUrl("/api/viz/files/a.png")).rejects.toThrow(/403/);
    // 403 重试不会变好 —— 白等 900ms 还多打三次服务端
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("网络异常也重试(参考产品 catch 到就继续下一轮)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchImageObjectUrl("/api/viz/files/a.png")).rejects.toThrow(/Failed to fetch/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("中止(AbortError)不重试 —— 用户已经切走了", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchMock = vi.fn(async () => {
      throw abort;
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchImageObjectUrl("/api/viz/files/a.png")).rejects.toThrow(/aborted/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("401 在重试表内(鉴权可能刚换 token)", () => {
    expect(RETRYABLE_STATUS as readonly number[]).toContain(401);
    expect(RETRYABLE_STATUS as readonly number[]).toEqual([401, 404, 408, 425, 429, 500, 502, 503, 504]);
  });
});
