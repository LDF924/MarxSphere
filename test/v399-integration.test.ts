// v399-integration.test.ts — V399 新增组件测试
// 覆盖: empirical_metaanalysis.py (元分析) / verify_claim.py (引文三维核验)
//       / oa_fallback.py (OA回退) / md_clean_cli.py (markdown清洗)
// 方式: 直接 spawn python 子进程 (与生产 execFileSync 同路径), 断言 stdout JSON。
// 网络依赖用例标注 [network] — 离线时跳过 (vi.it.skipIf)。
import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.env.SAG_ROOT || process.cwd();
// 优先从 .env 读实证 venv (vitest 不自动加载 dotenv)
function resolvePy(): string {
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*EMPIRICAL_PYTHON\s*=\s*(.+)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  // CI(Linux/ubuntu)只有 python3 无 python; Windows 用 python
  return process.env.EMPIRICAL_PYTHON || process.env.COGNEE_PYTHON || (process.platform === "win32" ? "python" : "python3");
}
const PY = resolvePy();
const hasNet = process.env.SKIP_NETWORK_TESTS !== "1";

// V400 CI 修复: python 依赖检测 — 无 pandas/scipy 的裸环境(CI ubuntu)跳过 python 依赖用例, 不报错
let pyHasPandas = true;
try {
  execFileSync(PY, ["-c", "import pandas, scipy, requests"], { encoding: "utf-8", timeout: 15_000, stdio: "pipe" });
} catch {
  pyHasPandas = false;
}

function runPy(script: string, args: string[], timeoutMs = 90_000): string {
  return execFileSync(PY, [script, ...args], { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "v399-test-"));
}

// ═══ 1. 元分析 (empirical_metaanalysis.py) ═══
describe("empirical_metaanalysis", () => {
  const SCRIPT = join(ROOT, "scripts", "empirical_metaanalysis.py");
  it.skipIf(!existsSync(SCRIPT) || !pyHasPandas)("合成数据 → 随机效应+森林图+依赖审计", () => {
    const dir = tmpDir();
    try {
      const data = {
        columnOrder: ["study", "yi", "vi", "cluster"],
        rows: [
          ["a", 0.42, 0.05, "A"], ["b", 0.31, 0.04, "A"], ["c", 0.55, 0.09, "B"],
          ["d", 0.28, 0.03, "C"], ["e", 0.61, 0.12, "D"], ["f", 0.38, 0.06, "E"],
        ],
      };
      writeFileSync(join(dir, "input.json"), JSON.stringify({
        method: "meta_analysis", script: "metaanalysis",
        data, params: { model: "random", tauMethod: "REML", test: "knha", clusterCol: "cluster" },
      }), "utf-8");
      runPy(SCRIPT, [dir]);
      const r = JSON.parse(readFileSync(join(dir, "result.json"), "utf-8"));
      // 核心结果
      expect(r.meta.model).toBe("随机效应");
      expect(r.meta.k).toBe(6);
      expect(r.meta.clusters).toBe(5);
      // 表格/图
      expect(r.tables.map((t: any) => t.id)).toContain("meta_main");
      expect(r.figures.map((f: any) => f.id)).toEqual(["forest", "funnel"]);
      // 依赖审计 (6 研究 5 群 → 提示)
      expect(r.diagnostics.map((d: any) => d.id)).toContain("dependence");
      // 小样本警告 (k<10 → 禁 Egger)
      expect(r.warnings.some((w: string) => w.includes("Egger"))).toBe(true);
      // 合并效应量数值合理 (0.3-0.5 之间)
      const main = r.tables[0].rows as string[][];
      const estRow = main.find((row) => row[0] === "合并效应量");
      expect(estRow).toBeDefined();
      expect(Number(estRow![1])).toBeGreaterThan(0.3);
      expect(Number(estRow![1])).toBeLessThan(0.5);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(!existsSync(SCRIPT) || !pyHasPandas)("数据不足 (k<2) → 错误提示不崩溃", () => {
    const dir = tmpDir();
    try {
      const data = { columnOrder: ["yi", "vi"], rows: [[0.5, 0.1]] };
      writeFileSync(join(dir, "input.json"), JSON.stringify({ method: "meta_analysis", data, params: {} }), "utf-8");
      runPy(SCRIPT, [dir]);
      const r = JSON.parse(readFileSync(join(dir, "result.json"), "utf-8"));
      expect(r.tables[0].title).toBe("错误");
      expect(r.tables[0].rows[0][0]).toContain("无法合并");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ═══ 2. 引文三维核验 (verify_claim.py) ═══
describe("verify_claim", () => {
  const SCRIPT = join(ROOT, "vendor", "citation-lab", "verify_claim.py");
  it.skipIf(!existsSync(SCRIPT) || !hasNet || !pyHasPandas)("真实 DOI → 元数据 green + 支持度评估 [network]", { timeout: 120_000, retry: 2 }, () => {
    const out = runPy(SCRIPT, [
      "该研究利用野外监测数据揭示了全球飞行昆虫生物量在27年间下降超过75%",
      "--doi", "10.1371/journal.pone.0185809",
      "--context", "多项研究关注全球昆虫多样性下降趋势",
    ], 110_000);
    const r = JSON.parse(out);
    expect(r.ok).toBe(true);
    expect(r.overall.status).toBeDefined();
    // 真实论文 → 元数据维度应 green (多源命中)
    expect(r.dimensions.metadata.status).toBe("green");
    // 支持度维度应输出覆盖率
    expect(typeof r.dimensions.support.score).toBe("number");
  });

  it.skipIf(!existsSync(SCRIPT) || !hasNet || !pyHasPandas)("伪造 DOI → 元数据 red [network]", { timeout: 120_000, retry: 2 }, () => {
    const out = runPy(SCRIPT, ["测试断言", "--doi", "10.9999/definitely-fake-doi-xyz"], 110_000);
    const r = JSON.parse(out);
    expect(r.ok).toBe(true);
    expect(r.dimensions.metadata.status).toBe("red");
  });

  it.skipIf(!existsSync(SCRIPT) || !pyHasPandas)("无摘要无 DOI → white 不崩溃", () => {
    const out = runPy(SCRIPT, ["测试断言"]);
    const r = JSON.parse(out);
    expect(r.ok).toBe(true);
    expect(["red", "yellow", "white", "green"]).toContain(r.overall.status);
  });
});

// ═══ 3. OA 回退 (oa_fallback.py) ═══
describe("oa_fallback", () => {
  const SCRIPT = join(ROOT, "vendor", "instsci-oa", "oa_fallback.py");
  it.skipIf(!existsSync(SCRIPT) || !hasNet || !pyHasPandas)("OpenAlex 检索 → 返回结果 [network]", { timeout: 120_000, retry: 2 }, () => {
    const out = runPy(SCRIPT, ["openalex", "agrarian political economy", "2"], 110_000);
    const r = JSON.parse(out);
    expect(r.ok).toBe(true);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0].title).toBeTruthy();
    expect(r.items[0]).toHaveProperty("doi");
  });

  it.skipIf(!existsSync(SCRIPT) || !hasNet || !pyHasPandas)("Unpaywall 查真实 DOI → is_oa 布尔 [network]", { timeout: 120_000, retry: 2 }, () => {
    const out = runPy(SCRIPT, ["oa", "10.1371/journal.pone.0185809"], 110_000);
    const r = JSON.parse(out);
    expect(typeof r.is_oa).toBe("boolean");
  });

  it.skipIf(!existsSync(SCRIPT) || !pyHasPandas)("参数错误 → 非零退出不崩溃", () => {
    // oa_fallback CLI 对未知命令 exit 1 (设计如此), execFileSync 会抛 — 验证异常行为而非崩溃级错误
    expect(() => runPy(SCRIPT, ["bad-command"], 30_000)).toThrow();
  });
});

// ═══ 4. Markdown 清洗 (md_clean_cli.py) ═══
describe("md_clean", () => {
  const SCRIPT = join(ROOT, "vendor", "scansci-pdf", "md_clean_cli.py");
  it.skipIf(!existsSync(SCRIPT))("组合变音符号折叠 + NFC 归一化", () => {
    const dir = tmpDir();
    try {
      const inPath = join(dir, "in.md");
      writeFileSync(inPath, "Daniel S<sup>ˇ</sup>uta and M<sup>¨</sup>uller", "utf-8");
      const out = runPy(SCRIPT, [inPath]);
      const r = JSON.parse(out);
      expect(r.warnings).toBeInstanceOf(Array);
      const cleaned = readFileSync(join(dir, "out.md"), "utf-8");
      expect(cleaned).toContain("Šuta");
      // M<sup>¨</sup>uller → M + U+0308 (组合分音符) + uller; NFC 后是 M̈uller (combining 不并入 u)
      expect(cleaned).toContain("M̈uller");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(!existsSync(SCRIPT))("替换字符 → 质量警告", () => {
    const dir = tmpDir();
    try {
      const inPath = join(dir, "in.md");
      writeFileSync(inPath, "normal text with � bad char", "utf-8");
      const out = runPy(SCRIPT, [inPath]);
      const r = JSON.parse(out);
      expect(r.warnings.some((w: string) => w.includes("替换字符"))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ═══ 5. 引用网络图 (citation-graph-service, paper-atlas 算法提炼) ═══
import { bibliographicCoupling, coCitation, combineSimilarity, buildCitationGraph } from "../src/services/citation-graph-service.js";

describe("citation_graph", () => {
  it("文献耦合余弦重叠精确计算", () => {
    const a = new Set(["r1", "r2", "r3", "r4"]);
    const b = new Set(["r1", "r2", "r5", "r6"]);
    expect(bibliographicCoupling(a, b)).toBeCloseTo(0.5, 10);
  });

  it("共被引与组合相似度", () => {
    const ca = new Set(["c1", "c2"]);
    const cb = new Set(["c1"]);
    expect(coCitation(ca, cb)).toBeCloseTo(1 / Math.sqrt(2), 10);
    // 组合 = 0.5*耦合 + 0.5*共被引
    const refs = new Set<string>();
    expect(combineSimilarity(refs, refs, ca, cb)).toBeCloseTo(0.5 * (1 / Math.sqrt(2)), 10);
  });

  it("图构造: 共享引用多的论文边权重更高 + seed 标记", () => {
    const papers = {
      p1: { title: "论文一", year: 2020, references: ["r1", "r2", "r3"], citations: ["c1"] },
      p2: { title: "论文二", year: 2021, references: ["r1", "r2", "r4"], citations: ["c1", "c2"] },
      p3: { title: "论文三", year: 2022, references: ["r5", "r6"], citations: ["c3"] },
      p4: { title: "论文四", year: 2023, references: ["r1", "r2", "r5"], citations: ["c1"] },
    };
    const g = buildCitationGraph({ papers, seedPaperId: "p1", threshold: 0.2 });
    expect(g.nodes.find((n) => n.id === "p1")?.isSeed).toBe(true);
    // p1~p4 权重最高 (共享 r1,r2 + 共被引 c1)
    const top = g.edges[0];
    expect(top.source === "p1" || top.target === "p1").toBe(true);
    expect(top.weight).toBeGreaterThan(0.8);
    // 所有边权重有序
    for (let i = 1; i < g.edges.length; i++) {
      expect(g.edges[i - 1].weight).toBeGreaterThanOrEqual(g.edges[i].weight);
    }
  });

  it("节点裁剪: 超过上限时按加权度保留 + seed 必保", () => {
    const papers: Record<string, any> = {};
    for (let i = 1; i <= 10; i++) {
      papers[`p${i}`] = { title: `论文${i}`, year: 2020, references: [`r${i}`, "r0"], citations: [`c${i}`] };
    }
    // p5 与所有论文共享 r0 → 加权度高
    papers.p5.references = ["r0"];
    papers.p5.citations = [];
    const g = buildCitationGraph({ papers, seedPaperId: "p9", threshold: 0.05, nodeMax: 4, edgeMax: 10 });
    expect(g.nodes.length).toBeLessThanOrEqual(4);
    expect(g.nodes.some((n) => n.id === "p9")).toBe(true);  // seed 必保
    expect(g.edges.length).toBeLessThanOrEqual(10);
  });
});

// ═══ 6. 预算/时间提醒 (agent-reminder-service, codex 对齐) ═══
// 惰性 import: 模块顶层依赖 pool.js(需 DB), CI 无 DATABASE_URL 时顶层 import 会崩
describe("agent_reminder", () => {
  it("token 估算: 中文≈1字/token, 英文≈4字符/token", async () => {
    const { estimateTokens } = await import("../src/services/agent-reminder-service.js");
    expect(estimateTokens("资本下乡与农村集体经济")).toBe(11);  // 11 个汉字
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });

  it("时间提醒格式 (codex current_time_reminder 对齐)", async () => {
    const { currentTimeReminder } = await import("../src/services/agent-reminder-service.js");
    const r = currentTimeReminder();
    expect(r).toContain("<current_time_reminder>");
    expect(r).toContain("It is ");
    expect(r).toContain("本地时间");
  });
});

// ═══ 7. Guardian 拒绝熔断 (codex guardian/mod.rs 对齐) ═══
import { guardianReview, resetGuardianBreaker, guardianBreakerOpen } from "../src/services/agent-guardian-service.js";

describe("guardian_breaker", () => {
  it("连续拒绝 3 次触发熔断", () => {
    resetGuardianBreaker();
    // 低授权 + 高风险工具 → deny
    for (let i = 0; i < 3; i++) {
      const d = guardianReview("run_code", { profile: "full-access" }, "low");
      expect(d.verdict).toBe("deny");
    }
    expect(guardianBreakerOpen()).toBe(true);
  });

  it("allow/review 重置计数", () => {
    resetGuardianBreaker();
    guardianReview("run_code", { profile: "full-access" }, "low");  // deny
    guardianReview("sag_reason", {}, "high");                        // allow
    expect(guardianBreakerOpen()).toBe(false);
    expect(guardianReview("sag_reason", {}, "high").verdict).toBe("allow");
  });
});

// ═══ 8. Mailbox 双通道 + 审批缓存 (codex input_queue/approvals 对齐) ═══
// 惰性 import: 模块顶层依赖 pool.js(需 DB), CI 无 DATABASE_URL 时顶层 import 会崩
describe("agent_mailbox", () => {
  it("入队→取用→标记已投递", async () => {
    const { enqueueMailbox, drainMailbox, hasPendingMail, clearMailbox } = await import("../src/services/agent-mailbox-service.js");
    clearMailbox("t1");
    enqueueMailbox("t1", { fromAgent: "worker-1", toAgent: "orchestrator", kind: "result", payload: { result: "done" } });
    expect(hasPendingMail("t1")).toBe(true);
    const items = drainMailbox("t1");
    expect(items.length).toBe(1);
    expect(items[0].kind).toBe("result");
    expect(hasPendingMail("t1")).toBe(false);
  });

  it("deferToNextTurn 标记未投递为下一回合", async () => {
    const { enqueueMailbox, drainMailbox, deferToNextTurn, clearMailbox } = await import("../src/services/agent-mailbox-service.js");
    clearMailbox("t2");
    enqueueMailbox("t2", { fromAgent: "worker-1", toAgent: "orchestrator", kind: "note", payload: {} });
    deferToNextTurn("t2");
    expect(drainMailbox("t2")[0].phase).toBe("next");
  });
});

describe("approval_cache", () => {
  it("批准写入缓存, 同键命中", async () => {
    const { cacheApproval, getCachedApproval, clearApprovalCache } = await import("../src/services/approval-cache-service.js");
    clearApprovalCache("t3");
    cacheApproval("t3", "删除文件", "file_delete", true);
    expect(getCachedApproval("t3", "删除文件", "file_delete")).toBe("allow");
    // 不同任务不命中
    expect(getCachedApproval("t-other", "删除文件", "file_delete")).toBeUndefined();
  });

  it("拒绝写缓存", async () => {
    const { cacheApproval, getCachedApproval, clearApprovalCache } = await import("../src/services/approval-cache-service.js");
    clearApprovalCache("t4");
    cacheApproval("t4", "发布", "external_publish", false);
    expect(getCachedApproval("t4", "发布", "external_publish")).toBe("deny");
  });
});

// ═══ 9. 任务状态机回归 (V400: planning 拒绝回归修复 2dfd2770) ═══
// 纯函数测试: steer 状态校验不依赖 DB/LLM; 惰性 import(agent-task-service 依赖 pool.js)
describe("agent_task_state_machine", () => {
  it("planning 是首次执行前置状态(不可 steer, 但可被 run 接受)", async () => {
    const { isSteerableStatus } = await import("../src/services/agent-task-service.js");
    expect(isSteerableStatus("planning")).toBe(false);
    expect(isSteerableStatus("running")).toBe(true);
    expect(isSteerableStatus("awaiting_approval")).toBe(true);
    expect(isSteerableStatus("paused")).toBe(true);
    expect(isSteerableStatus("completed")).toBe(false);
    expect(isSteerableStatus("failed")).toBe(false);
    expect(isSteerableStatus("cancelled")).toBe(false);
  });
});
