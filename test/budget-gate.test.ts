// budget-gate.test.ts — 额度闸门路径判定的回归测试
//
// 由来(2026-09-13): `/api/review/` 整段前缀被额度闸门罩住, 连纯读的期刊库列表也 402 ——
// 额度用尽的用户打开「论文质量评审」看到的是空白面板。这里锁住"哪些该放行、哪些仍要拦",
// 尤其是容易误放的几个: 解析投稿须知(烧 LLM)、导出(会用 LLM 补摘要)、job stream(评审正文)。
import { describe, expect, it } from "vitest";
import { requestNeedsBudgetCheck } from "../src/services/budget-gate.js";

const PREFIXES = ["/api/editor/v1/ai/", "/api/format-eval/", "/api/quality/", "/api/review/",
  "/api/paper-outline/", "/api/academic/", "/api/writing/", "/api/classical/", "/api/theory/"];

/** 走真实入口: 假 request 进 Fastify 适配层, 返回"是否要过额度检查" */
const gated = (method: string, url: string) =>
  requestNeedsBudgetCheck({ method, raw: { url } } as never, PREFIXES);

describe("budget-gate: 放行的不计费接口", () => {
  it("期刊库/评审标准/统计/任务列表的读放行", () => {
    for (const u of ["/api/review/journals", "/api/review/standards", "/api/review/stats", "/api/review/jobs"]) {
      expect(gated("GET", u), u).toBe(false);
    }
  });

  it("自建期刊与评审标准的增删改放行(不烧 token)", () => {
    // 主键都是 uuid(见 migrations/117_review_suite.sql: id uuid default gen_random_uuid())
    const jid = "3f2a91c4-8b7e-4d10-9a55-c1e0f7b2d834";
    const sid = "f79fbdb6-0d6f-435d-a4c1-40aa8c6af1b1";
    expect(gated("POST", "/api/review/journals")).toBe(false);
    expect(gated("PUT", `/api/review/journals/${jid}`)).toBe(false);
    expect(gated("DELETE", `/api/review/journals/${jid}`)).toBe(false);
    expect(gated("POST", "/api/review/standards")).toBe(false);
    expect(gated("PUT", `/api/review/standards/${sid}`)).toBe(false);
    expect(gated("POST", `/api/review/standards/${sid}/default`)).toBe(false);
    expect(gated("DELETE", `/api/review/standards/${sid}`)).toBe(false);
  });

  it("子路径是动作名而不是 id 时不能被当成 id 放行", () => {
    // 写测试时抓到的真 bug: 用 [^/]+ 会把 /journals/parse 当成 /journals/<id> 免费放行
    expect(gated("PUT", "/api/review/journals/parse")).toBe(true);
    expect(gated("DELETE", "/api/review/standards/parse")).toBe(true);
    // 放宽到"11 位以上任意串"也不行 —— batch-parse 正好 11 位
    expect(gated("POST", "/api/review/journals/batch-parse")).toBe(true);
  });

  it("格式检查的规则/模板常量放行(规则库是本地的, 不调 LLM)", () => {
    expect(gated("GET", "/api/format-eval/templates")).toBe(false);
    expect(gated("GET", "/api/format-eval/rules")).toBe(false);
  });

  it("已存论点树放行", () => {
    expect(gated("GET", "/api/classical/argument-tree")).toBe(false);
  });

  it("暂停/取消已有评审任务放行(不产生新花费)", () => {
    expect(gated("POST", "/api/review/jobs/job-1/control")).toBe(false);
  });

  it("带 query 的读仍然放行", () => {
    expect(gated("GET", "/api/review/journals?level=南核")).toBe(false);
  });
});

describe("budget-gate: 必须继续拦的烧 token 接口", () => {
  it("发起评审要拦(整条流水线都烧 token)", () => {
    expect(gated("POST", "/api/review/jobs")).toBe(true);
  });

  it("解析投稿须知要拦(README 说的就是 LLM 解析)", () => {
    expect(gated("POST", "/api/review/journals/parse")).toBe(true);
    expect(gated("POST", "/api/review/journals/batch-parse")).toBe(true);
    expect(gated("POST", "/api/review/journals/split-preview")).toBe(true);
    expect(gated("POST", "/api/review/standards/parse")).toBe(true);
  });

  it("导出要拦(导出时会用 LLM 补摘要, 且有额度记账)", () => {
    expect(gated("POST", "/api/review/jobs/job-1/export-word")).toBe(true);
    expect(gated("POST", "/api/review/jobs/job-1/export-html")).toBe(true);
  });

  it("评审正文的流式推送要拦(那是烧过 token 的产物)", () => {
    expect(gated("GET", "/api/review/jobs/job-1/stream")).toBe(true);
  });

  it("任务详情要拦(它返回评审正文; 任务列表才是看进度的口子)", () => {
    expect(gated("GET", "/api/review/jobs/job-1")).toBe(true);
  });

  it("场景 API(写作/学术/经典/理论/质量)照旧全拦", () => {
    expect(gated("POST", "/api/writing/framework")).toBe(true);
    expect(gated("POST", "/api/academic/school")).toBe(true);
    expect(gated("POST", "/api/classical/concept-trace")).toBe(true);
    expect(gated("POST", "/api/theory/premise")).toBe(true);
    expect(gated("POST", "/api/quality/logic")).toBe(true);
  });

  it("编辑器 AI 助手照旧拦(每个按钮都是一次 LLM 调用)", () => {
    expect(gated("POST", "/api/editor/v1/ai/jobs")).toBe(true);
    expect(gated("GET", "/api/editor/v1/ai/model")).toBe(false);   // 读模型名不烧 token
  });

  it("格式检查的执行接口照旧拦", () => {
    expect(gated("POST", "/api/format-eval/check")).toBe(true);
    expect(gated("POST", "/api/format-eval/check-docx")).toBe(true);
  });

  it("论文大纲: 生成正文/要件要拦(烧 LLM), 导出放行(只调 python 排版)", () => {
    expect(gated("POST", "/api/paper-outline/chapter")).toBe(true);
    expect(gated("POST", "/api/paper-outline/component")).toBe(true);
    expect(gated("POST", "/api/paper-outline/export")).toBe(false);
    expect(gated("POST", "/api/paper-outline/export-pptx")).toBe(false);
  });
});

describe("budget-gate: 前缀之外的路径不受影响", () => {
  it("不在这 8 个前缀下的接口一律不看额度", () => {
    expect(gated("POST", "/api/auth/login")).toBe(false);
    expect(gated("GET", "/api/documents")).toBe(false);
    expect(gated("POST", "/api/orchestrator/run")).toBe(false);
  });
});

describe("budget-gate: 判据是语义不是方法", () => {
  it("列表的读与自建记录都免费(两者都不烧 token)", () => {
    expect(gated("GET", "/api/review/journals")).toBe(false);
    expect(gated("POST", "/api/review/journals")).toBe(false);
  });

  it("同一路径下烧 token 的动作仍受管(方法不是判据, 动作才是)", () => {
    expect(gated("POST", "/api/review/journals/parse")).toBe(true);
    expect(gated("GET", "/api/review/jobs/job-1/stream")).toBe(true);
  });

  it("大小写不敏感", () => {
    expect(gated("get", "/api/review/stats")).toBe(false);
  });
});
