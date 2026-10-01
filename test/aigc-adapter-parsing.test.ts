/**
 * aigc-adapter-parsing.test.ts — 六个外接适配器的**响应解析**(2026-10-01)。
 *
 * ═══ 为什么必须单独验解析 ═══
 *
 * 我手里没有这六家的密钥, 所以"真调用一次"验不了。但**适配器最容易错的地方
 * 恰恰不是网络, 是解析** —— 而且错了不会报错:
 *
 *   · **分数方向翻转**。GPTZero 的 `completely_generated_prob` 高 = 像 AI;
 *     而 Winston 的 `score` 高 = 像**人**; Pangram 给的是 `fraction_human`
 *     —— 高 = 像**人**。写反了, 界面上会理直气壮地显示一个**含义相反**的分数:
 *     用户看到"12 分"以为很安全, 实际是 AI 特征 88。没有任何异常、没有日志。
 *   · **字段改名/缺失**。各家 API 的字段名会变, 读不到时若不抛错就会拿 undefined
 *     去算, 得到 NaN 或 0 —— 0 分看起来像"完全人类写的", 是最危险的假象。
 *
 * 所以这里用**真实形态的样例响应**(照各家文档的字段结构写)去打桩 `globalThis.fetch`,
 * 走完整的 `scanText` 路径 —— URL、鉴权头、解析、归一化、入库全部经过一遍。
 * 库里那步用 mock 替掉(它只负责存, 不是本文件的被测对象)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── 打桩: DB(只记录调用, 不真连) ──
const queryMock = vi.fn();
vi.mock("../src/db/pool.js", () => ({
  pool: { query: (...a: unknown[]) => queryMock(...a), connect: vi.fn() },
}));

// ── 打桩: 凭据解析(直接给一把假 key, 绕过解密) ──
vi.mock("../src/services/auth-service.js", () => ({
  encryptByokKey: (s: string) => `enc:${s}`,
  decryptByokKey: (s: string) => (s.startsWith("enc:") ? s.slice(4) : null),
}));

const { scanText } = await import("../src/services/aigc-external-service.js");

type FetchCall = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** 装一个假的 fetch: 按 URL 片段匹配返回样例响应, 并记录收到的请求 */
function stubFetch(routes: Array<{ match: string; status?: number; json: unknown }>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body ?? "{}")) });
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) throw new Error(`未打桩的 URL: ${url}`);
    const text = JSON.stringify(hit.json);
    return {
      status: hit.status ?? 200,
      text: async () => text,
      json: async () => hit.json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => {
  queryMock.mockReset();
  // 前两条是 scanText 的 insert / update
  queryMock.mockResolvedValue({ rows: [{ id: "scan-1" }], rowCount: 1 });
  // 凭据查询: 返回一条能解开的记录
  queryMock.mockImplementation((sql: string) => {
    if (String(sql).includes("from aigc_provider_credentials")) {
      return Promise.resolve({ rows: [{ id: "c1", user_id: "u1", provider: "x", key_encrypted: "enc:FAKEKEY", account_email: "me@example.com", enabled: true, note: "" }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [{ id: "scan-1" }], rowCount: 1 });
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("适配器解析 — 分数方向的铁律(越高越像 AI)", () => {
  it("GPTZero: completely_generated_prob 高 → 高分(同向, 不翻转)", async () => {
    const calls = stubFetch([{ match: "gptzero", json: { documents: [{ completely_generated_prob: 0.9, average_generated_prob: 0.88 }] } }]);
    const r = await scanText("u1", "gptzero", "some text for gptzero detection analysis", "en");
    expect(r.ok).toBe(true);
    expect(r.score).toBe(90);                       // 0.9 → 90, 方向正确
    expect(r.verdict).toBe("likely_ai");
    // 顺带验鉴权头与 URL —— 这两处抄错同样不报错, 只会 401
    expect(calls[0].url).toBe("https://api.gptzero.me/v2/predict/text");
    expect(calls[0].headers["x-api-key"]).toBe("FAKEKEY");
    expect(calls[0].body.version).toBe("2023-06-30");
  });

  it("⚠ Winston: score 是**人类概率** → 必须翻转(最容易写反的一家)", async () => {
    const stub = stubFetch([{ match: "gowinston", json: { score: 90, sentences: [] } }]);
    const r = await scanText("u1", "winston", "some english text for winston detection", "en");
    expect(stub[0].url).toBe("https://api.gowinston.ai/v2/ai-content-detection");
    expect(stub[0].headers.Authorization).toBe("Bearer FAKEKEY");
    /**
     * 平台说"90% 像人" ⇒ **AI 特征只有 10**。
     * 若这里返回 90, 就是本文件开头说的那个"含义相反的分数"。
     */
    expect(r.score).toBe(10);
    expect(r.verdict).toBe("likely_human");
  });

  it("⚠ Pangram: fraction_human 高 → 低分(翻转), 且 AI 辅助计入 AI 特征", async () => {
    const stub = stubFetch([{ match: "pangram", json: { fraction_ai: 0.1, fraction_ai_assisted: 0.3, fraction_human: 0.6, headline: "AI Assisted" } }]);
    const r = await scanText("u1", "pangram", "some english text for pangram detection", "en");
    expect(stub[0].url).toBe("https://text.api.pangram.com/v3");
    expect(stub[0].headers["x-api-key"]).toBe("FAKEKEY");
    // "AI 生成 0.1 + AI 辅助 0.3" 都算 AI 特征 → 40。学术场景里"AI 辅助"同样要计。
    expect(r.score).toBe(40);
    expect(r.verdict).toBe("mixed");
  });

  it("Sapling: score 高 → 高分(同向)", async () => {
    const stub = stubFetch([{ match: "sapling", json: { score: 0.8, sentence_scores: [] } }]);
    const r = await scanText("u1", "sapling", "some english text for sapling detection", "en");
    expect(stub[0].url).toBe("https://api.sapling.ai/api/v1/aidetect");
    expect(stub[0].body.key).toBe("FAKEKEY");     // Sapling 用 body 传 key, 不是 header
    expect(r.score).toBe(80);
    expect(r.verdict).toBe("likely_ai");
  });

  it("Originality: score.ai 高 → 高分(同向)", async () => {
    const stub = stubFetch([{ match: "originality", json: { score: { ai: 0.75, original: 0.25 } } }]);
    const r = await scanText("u1", "originality", "some text for originality detection", "en");
    expect(stub[0].url).toBe("https://api.originality.ai/api/v1/scan/ai");
    expect(stub[0].headers["X-OAI-API-KEY"]).toBe("FAKEKEY");
    expect(r.score).toBe(75);
    expect(r.verdict).toBe("likely_ai");
  });
});

describe("适配器解析 — Copyleaks 两段式鉴权", () => {
  it("先用 email+key 换 token, 再带 token 提交与轮询(共 3 次请求)", async () => {
    const calls = stubFetch([
      { match: "id.copyleaks.com", json: { access_token: "TOKEN123" } },
      { match: "/submit", json: { ok: true } },
      { match: "/check", json: { summary: { ai: 0.85, human: 0.15 } } },
    ]);
    const r = await scanText("u1", "copyleaks", "some text for copyleaks detection", "en");
    expect(r.ok).toBe(true);
    expect(calls[0].url).toContain("/v3/account/login/api");
    expect(calls[0].body.email).toBe("me@example.com");
    expect(calls[0].body.key).toBe("FAKEKEY");
    // 后续两次必须带 Bearer token(换来的那个), 不是原始 key
    expect(calls[1].headers.Authorization).toBe("Bearer TOKEN123");
    expect(calls[2].headers.Authorization).toBe("Bearer TOKEN123");
    expect(r.score).toBe(85);
  }, 20_000);
});

describe("适配器解析 — 读不到字段时必须失败, 不能悄悄给 0", () => {
  it("GPTZero 响应缺 documents → 报错(而不是当作 0 分人类写作)", async () => {
    stubFetch([{ match: "gptzero", json: { unexpected: [] } }]);
    const r = await scanText("u1", "gptzero", "some text here for detection", "en");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/documents/);
  });

  it("Winston 响应缺 score → 报错", async () => {
    stubFetch([{ match: "gowinston", json: { hello: 1 } }]);
    const r = await scanText("u1", "winston", "some english text for detection", "en");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/score/);
  });

  it("Pangram 响应缺 fraction_* → 报错", async () => {
    stubFetch([{ match: "pangram", json: { headline: "?" } }]);
    const r = await scanText("u1", "pangram", "some english text for detection", "en");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/fraction/);
  });
});

describe("适配器解析 — 平台错误要翻成人话", () => {
  it("Originality 的 422 企业版限制 → 明确告知, 不暴露英文错误码完事", async () => {
    stubFetch([{ match: "originality", status: 422, json: { error: "Enterprise Subscription Required to use the Originality.ai API" } }]);
    const r = await scanText("u1", "originality", "some text for detection here", "en");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/企业版|Enterprise/);
  });

  it("非 200 一律带出状态码与响应片段, 便于排查", async () => {
    stubFetch([{ match: "sapling", status: 500, json: { msg: "boom" } }]);
    const r = await scanText("u1", "sapling", "some english text for detection", "en");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/500/);
  });
});

describe("适配器解析 — 送检前的本地拦截", () => {
  it("Sapling + 中文 → 拒绝, 不给一个没意义的分数", async () => {
    // 不装 fetch: 若代码走到了网络这步, 会因未打桩而抛错 —— 判据因此能证明"确实拦在前面"
    globalThis.fetch = (() => { throw new Error("不该发起网络请求"); }) as unknown as typeof fetch;
    const r = await scanText("u1", "sapling", "这是一段中文文本，用于测试检测接口。", "zh");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/英文/);
  });

  it("manual 类平台不走 API → 明确指路", async () => {
    const r = await scanText("u1", "cnki", "任何文本", "zh");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/导出送检包|人工送检/);
  });
});
