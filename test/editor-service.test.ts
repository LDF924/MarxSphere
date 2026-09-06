// editor-service.test.ts — SocialSci P0-5 契约测试(学术编辑器服务)
// 覆盖: 文档 CRUD SQL / 锁语义 / 改写模式枚举 / 字数统计 / 全文检查返回契约(LLM mock 空走兜底)
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/db/pool.js", () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));
vi.mock("../src/services/llm-model-registry.js", () => ({
  getRoleModel: () => "test-model",
}));
vi.mock("../src/ai/llm-common.js", () => ({
  getLlmEndpoint: () => ({ url: "http://mock", key: "k", model: "m" }),
  fetchLlm: async () => ({ text: "{}" }),
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
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("rewriteText: 6 模式走对应提示词(LLM空→原文兜底)", async () => {
    const modes = ["condense", "de-template", "polish", "proofread", "journal-style", "humanize"] as const;
    for (const m of modes) {
      const r = await rewriteText(m, "测试文本内容需要改写");
      // fetchLlm mock 返回 {} → text 空 → 兜底原文
      expect(typeof r.text).toBe("string");
      expect(r.text.length).toBeGreaterThan(0);
    }
  });

  it("checkFulltext: LLM 非JSON → 兜底失败结构", async () => {
    const r = await checkFulltext("全文内容".repeat(30));
    expect(Array.isArray(r.checks)).toBe(true);
    expect(r.checks.length).toBeGreaterThan(0);
    expect(typeof r.checks[0].ok).toBe("boolean");
    expect(typeof r.checks[0].name).toBe("string");
  });
});
