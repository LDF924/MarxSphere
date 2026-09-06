// viz-exec-service.test.ts — SocialSci P0-4 契约测试(科研绘图执行引擎)
// 覆盖: 代码危险拦截 / CSV 转义 / 列名白名单 / Agent 会话数据流(不触发真 LLM/Python)
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
  parseLlmJson: (t: string) => { try { return JSON.parse(t); } catch { return null; } },
}));

import { pool } from "../src/db/pool.js";
import { validateChartCode, rowsToCsv, validateColumns } from "../src/services/viz-exec-service.js";
import { createSession, listSessions, listMessages, listArtifacts } from "../src/services/viz-agent-service.js";

describe("validateChartCode 危险代码拦截(RCE 防线)", () => {
  it("正常 matplotlib 代码通过", () => {
    expect(validateChartCode("import matplotlib.pyplot as plt\nplt.plot([1,2,3])\nax.set_title('测试')")).toBeNull();
  });

  it("subprocess/系统调用被拦截", () => {
    expect(validateChartCode("import subprocess\nsubprocess.run(['cmd'])" )).not.toBeNull();
  });

  it("eval/exec/文件写被拦截", () => {
    expect(validateChartCode("eval('__import__(\"os\")')")).not.toBeNull();
    expect(validateChartCode("open('c:/windows/x','w')")).not.toBeNull();
  });

  it("超长代码被拦截", () => {
    expect(validateChartCode("x".repeat(31_000))).not.toBeNull();
  });
});

describe("rowsToCsv 转义", () => {
  it("含逗号/引号/换行字段被正确转义", () => {
    const csv = rowsToCsv(["a", "b"], [["含,逗号", "含\"引号\""], ["多\n行", 42]]);
    expect(csv).toContain('"含,逗号"');
    expect(csv).toContain('"含""引号"""');
    // 物理行 = 表头 + 2数据行 + 多行字段内部的换行符
    expect(csv.split("\n")[0]).toBe("a,b");
  });
});

describe("validateColumns 列名白名单", () => {
  it("合法列名通过", () => {
    expect(validateColumns(["year", "gdp_2", "Region"])).toBeNull();
  });
  it("危险/非法列名拦截", () => {
    expect(validateColumns(["__import__"])).not.toBeNull();
    expect(validateColumns(["os"])).not.toBeNull();
    expect(validateColumns(["col name"])).not.toBeNull();
  });
});

describe("viz-agent-service 会话数据流", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("createSession: 落库返回 id", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    const { id } = await createSession("u1", "画个柱状图");
    expect(id).toBeTruthy();
    const [sql, vals] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("insert into viz_sessions");
    expect(vals[2]).toBe("画个柱状图");
  });

  it("listSessions: 联表数产物计数", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ id: "s1", artifact_count: "3" }] } as any);
    const r = await listSessions("u1");
    expect(r).toHaveLength(1);
    const [sql] = vi.mocked(pool.query).mock.calls[0] as unknown as [string];
    expect(sql).toContain("viz_artifacts a where a.session_id=s.id");
    expect(sql).toContain("user_id=$1");
  });

  it("listMessages: 会话归属校验(user_id join)", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    await listMessages("u1", "s1");
    const [sql] = vi.mocked(pool.query).mock.calls[0] as unknown as [string];
    expect(sql).toContain("s.user_id=$2");
  });

  it("listArtifacts: 按版本倒序", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    await listArtifacts("u1", "s1");
    const [sql] = vi.mocked(pool.query).mock.calls[0] as unknown as [string];
    expect(sql).toContain("order by a.version desc");
  });
});
