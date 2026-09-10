// editor-service.test.ts — SocialSci P0-5 契约测试(学术编辑器服务)
// 覆盖: 文档 CRUD SQL / 锁语义 / 改写模式枚举 / 字数统计 / 全文检查返回契约(LLM mock 空走兜底)
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/db/pool.js", () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));
vi.mock("../src/services/llm-model-registry.js", () => ({
  getRoleModel: () => "test-model",
  getLlmEndpoint: () => ({ url: "http://mock/chat/completions", key: "k", model: "m" }),
}));
// llmReply: null=模拟调用失败(抛错); 字符串=模拟成功返回该文本
let llmReply: string | null = "{}";
const MOCK_REWRITE = "改写后的学术文本";
vi.mock("../src/ai/llm-common.js", () => ({
  getLlmEndpoint: () => ({ url: "http://mock/chat/completions", key: "k", model: "m" }),
  fetchLlm: async () => (llmReply === null ? null : { text: llmReply }),
  fetchLlmDetailed: async () =>
    llmReply === null
      ? { ok: false, status: 401, message: "密钥无效或未授权", detail: "mock" }
      : { ok: true, text: llmReply, tokens: null, cacheHit: null, finishReason: "stop" },
}));

import { pool } from "../src/db/pool.js";
import {
  createDoc, saveDoc, deleteDoc, lockDoc, unlockDoc,
  rewriteText, checkFulltext,
} from "../src/services/editor-service.js";

describe("editor-service 文档 CRUD", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("createDoc: 标题+字数落库", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    const { id } = await createDoc("u1", "测试论文", "正文内容".repeat(20));
    expect(id).toBeTruthy();
    const [sql, vals] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("insert into documents_v2");
    expect(vals[1]).toBe("u1");
    expect(vals[4]).toBe(80); // "正文内容"=4字 ×20
  });

  it("saveDoc: content 同时更新 word_count", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ id: "d1", word_count: 30 }] } as any);
    const r = await saveDoc("u1", "d1", { content: "一二三四五".repeat(6) });
    expect(r?.word_count).toBe(30);
    const [sql, vals] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("word_count=$4"); // content=$3, word_count=$4
    expect(vals[3]).toBe(30);
  });

  it("deleteDoc 按归属删除", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ id: "d1" }] } as any);
    const r = await deleteDoc("u1", "d1");
    expect(r?.id).toBe("d1");
  });
});

describe("editor-service 锁语义", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("lockDoc: 空锁/自己持锁/超5分钟 可拿锁", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ locked_by: "user:u1" }] } as any);
    const r = await lockDoc("u1", "d1");
    expect(r.ok).toBe(true);
    const [sql] = vi.mocked(pool.query).mock.calls[0] as unknown as [string];
    expect(sql).toContain("now() - interval '5 minutes'"); // 超时自动释放
  });

  it("unlockDoc 只释放自己的锁", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    await unlockDoc("u1", "d1");
    const [sql, vals] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("locked_by=$2");
    expect(vals[1]).toBe("user:u1");
  });
});

describe("editor-service 改写与全文检查", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); llmReply = MOCK_REWRITE; });

  it("rewriteText: 6 模式走对应提示词, 返回模型改写结果", async () => {
    const modes = ["condense", "de-template", "polish", "proofread", "journal-style", "humanize"] as const;
    for (const m of modes) {
      const r = await rewriteText(m, "测试文本内容需要改写");
      expect(r.text).toBe(MOCK_REWRITE);
    }
  });

  it("rewriteText: 失败如实抛出, 不静默回原文(否则按钮徒有其表)", async () => {
    llmReply = null;  // 模拟调用失败
    // 抛出且带真实病因(密钥无效/模型不存在...), 而不是把用户原文当成改写结果返回
    await expect(rewriteText("polish", "测试文本内容需要改写")).rejects.toThrow(/密钥无效|未授权/);
  });

  it("checkFulltext: 模型返回非 JSON → 诚实兜底结构(带解析失败说明)", async () => {
    llmReply = "这不是 JSON";
    const r = await checkFulltext("全文内容".repeat(30));
    expect(Array.isArray(r.checks)).toBe(true);
    expect(r.checks.length).toBeGreaterThan(0);
    expect(r.checks[0].ok).toBe(false);
    expect(r.checks[0].findings.join("")).toMatch(/解析失败/);
  });

  it("checkFulltext: 调用失败 → 指出真实原因, 不谎称解析失败", async () => {
    llmReply = null;
    const r = await checkFulltext("全文内容".repeat(30));
    expect(r.checks[0].ok).toBe(false);
    expect(r.checks[0].findings.join("")).toMatch(/质检调用失败/);
  });

  it("checkFulltext: 正常 JSON → 原样透传 checks", async () => {
    llmReply = JSON.stringify({ checks: [{ name: "全文逻辑检查", ok: true, findings: [] }] });
    const r = await checkFulltext("全文内容".repeat(30), "logic");
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0].ok).toBe(true);
  });
});
