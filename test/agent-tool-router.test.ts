// agent-tool-router.test.ts — G16: Agent 纯函数单测
// 覆盖: planBudget / trimStepsByBudget / routeToolChain / isRetryableError / retryBackoffMs
//        checkNetworkAccess / checkPathAccess / maskCredentials / checkToolPolicy
import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  planBudget, trimStepsByBudget, routeToolChain, isRetryableError, retryBackoffMs,
} from "../src/services/agent-task-service.js";
import {
  checkNetworkAccess, checkPathAccess, maskCredentials, checkToolPolicy,
} from "../src/services/agent-tool-router.js";

// ═══ planBudget / trimStepsByBudget ═══
describe("planBudget", () => {
  const steps = [
    { id: "s1", title: "检索", type: "retrieve" as const, query: "x", status: "pending" as const },
    { id: "s2", title: "推理", type: "reason" as const, query: "x", status: "pending" as const },
    { id: "s3", title: "写作", type: "write" as const, query: "x", status: "pending" as const },
    { id: "s4", title: "评审", type: "review" as const, query: "x", status: "pending" as const },
  ];

  it("预算充足 → 不降级", () => {
    const b = planBudget(steps, 500);
    expect(b.degraded).toBe("none");
    expect(b.estimatedCents).toBe(2 + 15 + 8 + 3);
  });

  it("超预算但 60% 可覆盖 → reduce_steps", () => {
    const b = planBudget(steps, 20);  // 28 > 20, 28*0.6=16.8 ≤ 20
    expect(b.degraded).toBe("reduce_steps");
    expect(b.reason).toContain("削减");
  });

  it("远超预算 → cheap_model", () => {
    const b = planBudget(steps, 5);
    expect(b.degraded).toBe("cheap_model");
  });
});

describe("trimStepsByBudget", () => {
  it("不降级 → 原样返回", () => {
    const steps: any[] = [{ id: "s1", type: "write" }];
    const out = trimStepsByBudget(steps, { limitCents: 100, estimatedCents: 1, degraded: "none" });
    expect(out).toHaveLength(1);
  });

  it("reduce_steps → 砍掉部分 write/review", () => {
    const steps: any[] = Array.from({ length: 5 }, (_, i) => ({ id: `w${i}`, type: "write" }));
    const out = trimStepsByBudget(steps, { limitCents: 1, estimatedCents: 100, degraded: "reduce_steps" });
    expect(out.length).toBeLessThan(5);
    // 保留前 40%
    expect(out.length).toBe(2);
  });
});

// ═══ routeToolChain ═══
describe("routeToolChain", () => {
  it("概念溯源关键词 → classical 链", () => {
    expect(routeToolChain("分析剩余价值概念溯源").id).toBe("classical");
  });

  it("回归分析 → empirical 链", () => {
    expect(routeToolChain("研究农村收入回归分析").id).toBe("empirical");
  });

  it("无推理信号纯检索 → retrieval 链", () => {
    expect(routeToolChain("某县人口数据").id).toBe("retrieval");
  });

  it("含推理词 → reason 链", () => {
    expect(routeToolChain("为什么经济增长放缓").id).toBe("reason");
  });
});

// ═══ isRetryableError / retryBackoffMs ═══
describe("isRetryableError", () => {
  it("网络错误 → 可重试", () => {
    expect(isRetryableError("ECONNREFUSED connecting")).toBe(true);
    expect(isRetryableError("fetch failed: socket")).toBe(true);
  });
  it("429 限流 → 可重试", () => {
    expect(isRetryableError("HTTP 429 Too Many Requests")).toBe(true);
  });
  it("5xx → 可重试", () => {
    expect(isRetryableError("HTTP 502 Bad Gateway")).toBe(true);
  });
  it("超时 → 可重试", () => {
    expect(isRetryableError("request timeout")).toBe(true);
  });
  it("业务错误 → 不可重试", () => {
    expect(isRetryableError("参数错误: 无结果")).toBe(false);
    expect(isRetryableError("not found")).toBe(false);
  });
});

describe("retryBackoffMs", () => {
  it("指数退避", () => {
    expect(retryBackoffMs(1)).toBe(1000);
    expect(retryBackoffMs(2)).toBe(2000);
    expect(retryBackoffMs(3)).toBe(4000);
  });
  it("上限 30s", () => {
    expect(retryBackoffMs(10)).toBe(30_000);
  });
});

// ═══ checkNetworkAccess ═══
describe("checkNetworkAccess", () => {
  it("白名单 host 放行", () => {
    expect(checkNetworkAccess("https://api.deepseek.com/v1").allowed).toBe(true);
  });
  it("白名单条目的子域放行", () => {
    expect(checkNetworkAccess("https://sub.api.deepseek.com/x").allowed).toBe(true);
  });
  it("云元数据端点拦截(SSRF)", () => {
    const r = checkNetworkAccess("http://169.254.169.254/latest/meta-data");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("SSRF");
  });
  it("私有 IP 拦截", () => {
    expect(checkNetworkAccess("http://192.168.1.1/").allowed).toBe(false);
    expect(checkNetworkAccess("http://10.0.0.1/").allowed).toBe(false);
  });
  it("未知域名拦截", () => {
    expect(checkNetworkAccess("https://evil.example.com/").allowed).toBe(false);
  });
  it("非法 URL", () => {
    expect(checkNetworkAccess("not a url").allowed).toBe(false);
  });
});

// ═══ checkPathAccess ═══
describe("checkPathAccess", () => {
  // G26: 项目根 = 仓库根（fileURLToPath 推导, 与实现一致; 静态 import 兼容 ESM）
  // import.meta.url 是 test/agent-tool-router.test.ts → dirname = test/ → 上两级 = 仓库根
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  it("项目内路径放行", () => {
    expect(checkPathAccess(projectRoot + "/data/x.json").allowed).toBe(true);
  });
  it("目录穿越拦截", () => {
    const r = checkPathAccess(projectRoot + "/../../etc/passwd");
    expect(r.allowed).toBe(false);
  });
  it("系统路径拦截", () => {
    expect(checkPathAccess("/etc/passwd").allowed).toBe(false);
  });
});

// ═══ maskCredentials ═══
describe("maskCredentials", () => {
  it("sk- 密钥打码", () => {
    const out = maskCredentials("key=sk-abcdefgh12345678 rest");
    expect(out).toContain("sk-abcdefgh****");
    expect(out).not.toContain("12345678");
  });
  it("Bearer token 打码", () => {
    const out = maskCredentials("Authorization: Bearer abcdefghijklmnop123456");
    expect(out).toContain("Bearer ****");
  });
  it("api_key 打码", () => {
    const out = maskCredentials("api_key: secret1234567890");
    expect(out).not.toContain("secret1234567890");
  });
  it("普通文本不变", () => {
    expect(maskCredentials("正常文本")).toBe("正常文本");
  });
});

// ═══ checkToolPolicy ═══
describe("checkToolPolicy", () => {
  it("白名单外工具拦截", () => {
    const r = checkToolPolicy("pdf_parse", "manager", new Set(["search"]));
    expect(r.allowed).toBe(false);
  });
  it("白名单内工具放行", () => {
    expect(checkToolPolicy("search", "manager", new Set(["search"])).allowed).toBe(true);
  });
  it("危险工具默认禁止, 白名单开启需审批", () => {
    const denied = checkToolPolicy("file_delete", "manager", undefined);
    expect(denied.allowed).toBe(false);
    const approved = checkToolPolicy("file_delete", "manager", new Set(["file_delete"]));
    expect(approved.allowed).toBe(true);
    expect(approved.requiresApproval).toBe(true);
  });
  it("角色不足拦截(analyst 工具 + reader)", () => {
    const r = checkToolPolicy("llm_write", "reader", undefined);
    expect(r.allowed).toBe(false);
  });
});
