// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// test/orchestrator-graph.test.ts — V415 画布图 → 执行步骤的转换(编排器的接线正确性)
//
// 为什么单独测这个: 这里出的两个 bug 都**不报错、不崩溃**, 只是"改了没反应":
//   ① 节点参数被合到 with 顶层, 而运行时只读 with.args / with.body → 模板里写好的提示词、
//      工作台字段全部静默丢弃。实测表现为"编辑器改写节点永远 400: mode 需为 …",
//      而画布上字段面板显示得好好的。
//   ② 端点型 body 里写了 {{mode}} 这类**自定义字段名**, 而 renderTemplate 只认
//      {{inputs}}/{{user.x}}/{{outputs.x}} → 渲染成 "[未渲染:…]" 传给端点。
// 两处都靠端到端实测才发现(单测当时全绿), 所以补成单测钉住。

import { describe, it, expect, beforeAll } from "vitest";
import { dagNodeToMetaStep, graphToMetaSkill, listCapabilities, type CapabilityDef } from "../src/services/capability-registry.js";
import { ORCHESTRATOR_TEMPLATES } from "../src/services/orchestrator-templates.js";
import { renderTemplate, type MetaRunContext } from "../src/services/meta-skill-runtime.js";

/** 造一个最小能力表: 一个工具型(读 with.args) + 一个端点型(读 with.body) + 一个 LLM 型(读 with 顶层) */
const CAPS = [
  {
    id: "tool:llm_write", label: "LLM 生成", category: "通用", kind: "agent_tool",
    description: "", inputs: ["topic"], outputs: ["text"], risk: "safe", cost: "heavy", tool: "llm_write",
    step: { id: "llm_write", kind: "tool_call", label: "LLM 生成", with: { tool: "llm_write", args: { topic: "{{inputs}}", length: "中" } } },
  },
  {
    id: "editor:rewrite", label: "编辑器·段落改写", category: "编辑", kind: "endpoint",
    description: "", inputs: ["text"], outputs: ["text"], risk: "safe", cost: "medium",
    endpoint: { path: "/api/editor/v1/rewrite", method: "POST", body: { mode: "polish", text: "{{inputs}}" } },
    step: { id: "editor_rewrite", kind: "tool_call", label: "编辑器·段落改写", with: { endpoint: "/api/editor/v1/rewrite", body: { mode: "polish", text: "{{inputs}}" } } },
  },
  {
    id: "io:llm-write", label: "LLM 生成(通用)", category: "通用", kind: "llm_chat",
    description: "", inputs: ["text"], outputs: ["text"], risk: "safe", cost: "heavy",
    step: { id: "llm", kind: "llm_chat", label: "LLM 生成", with: { system: "你是专家", task: "{{inputs}}", maxTokens: 3000 } },
  },
] as unknown as CapabilityDef[];

const ctx = (over: Partial<MetaRunContext> = {}): MetaRunContext =>
  ({ runId: "r", skillId: "s", input: "任务输入", outputs: {}, userValues: {}, status: "running", ...over }) as MetaRunContext;

describe("dagNodeToMetaStep: 节点参数要进对位置", () => {
  it("工具型: 参数进 args 而不是 with 顶层", () => {
    const s = dagNodeToMetaStep({ id: "a", capabilityId: "tool:llm_write", params: { topic: "写一章", length: "长" } }, CAPS, []);
    expect((s.with as any).args.topic).toBe("写一章");
    expect((s.with as any).args.length).toBe("长");
    // 顶层不该留死键 —— 运行时根本不读它们
    expect((s.with as any).topic).toBeUndefined();
    expect((s.with as any).tool).toBe("llm_write");
  });

  it("端点型: 参数进 body", () => {
    const s = dagNodeToMetaStep({ id: "b", capabilityId: "editor:rewrite", params: { mode: "humanize", text: "原句" } }, CAPS, []);
    expect((s.with as any).body.mode).toBe("humanize");
    expect((s.with as any).body.text).toBe("原句");
    expect((s.with as any).mode).toBeUndefined();
  });

  it("LLM 型: 参数进 with 顶层(运行时就是这么读的)", () => {
    const s = dagNodeToMetaStep({ id: "c", capabilityId: "io:llm-write", params: { task: "写点什么", system: "你是审稿人" } }, CAPS, []);
    expect((s.with as any).task).toBe("写点什么");
    expect((s.with as any).system).toBe("你是审稿人");
  });

  it("工具节点带依赖时补 input=上游产出, 但用户显式给的 input 优先", () => {
    const auto = dagNodeToMetaStep({ id: "a", capabilityId: "tool:llm_write", params: { length: "长" } }, CAPS, ["up"]);
    expect((auto.with as any).args.input).toBe("{{inputs}}");
    const explicit = dagNodeToMetaStep({ id: "a", capabilityId: "tool:llm_write", params: { input: "我自己的输入" } }, CAPS, ["up"]);
    expect((explicit.with as any).args.input).toBe("我自己的输入");
  });

  it("未登记的自定义节点退化为 LLM 生成(参数直接进 with)", () => {
    const s = dagNodeToMetaStep({ id: "x", title: "自定义", params: { task: "随便写" } }, CAPS, []);
    expect(s.kind).toBe("llm_chat");
    expect((s.with as any).task).toBe("随便写");
  });
});

describe("graphToMetaSkill: 边就是依赖", () => {
  it("target 的 depends_on 含 source", () => {
    const def = graphToMetaSkill({
      id: "g", name: "g",
      nodes: [{ id: "a", capabilityId: "io:llm-write" }, { id: "b", capabilityId: "io:llm-write" }],
      edges: [{ source: "a", target: "b" }],
    }, CAPS);
    expect(def.steps.find((s) => s.id === "b")!.depends_on).toEqual(["a"]);
  });

  it("并联分支各自成依赖, 汇合节点拿到全部上游", () => {
    const def = graphToMetaSkill({
      id: "g", name: "g",
      nodes: ["src", "x", "y", "merge"].map((id) => ({ id, capabilityId: "io:llm-write" })),
      edges: [
        { source: "src", target: "x" }, { source: "src", target: "y" },
        { source: "x", target: "merge" }, { source: "y", target: "merge" },
      ],
    }, CAPS);
    expect(def.steps.find((s) => s.id === "merge")!.depends_on?.sort()).toEqual(["x", "y"]);
  });

  it("脏边(指向不存在的节点)被跳过而不是抛错", () => {
    const def = graphToMetaSkill({
      id: "g", name: "g",
      nodes: [{ id: "a", capabilityId: "io:llm-write" }],
      edges: [{ source: "ghost", target: "a" }, { source: "a", target: "ghost" }],
    }, CAPS);
    expect(def.steps.find((s) => s.id === "a")!.depends_on).toEqual([]);
  });
});

/**
 * 占位符合法性: 运行时只替换 {{inputs}}/{{user.x}}/{{outputs.x}}。
 * 其它 {{X}} 只有一种合法情形 —— X 是**该能力自己的字段名**, 语义是"值由字段面板填"
 * (能力自带模板里有这种写法, 如 {{concept}}/{{claim}}/{{tool}})。
 * 既不是内置又不是自己字段的, 就是拼错的字段名, 运行时渲染成 [未渲染:…] 发给端点。
 */
const SYSTEM_PLACEHOLDER = /^(inputs?|user\.[\w-]+|outputs?\.[\w-]+)$/;
function badPlaceholders(v: unknown, fieldNames: Set<string>, where: string): string[] {
  const bad: string[] = [];
  const walk = (val: unknown, path: string) => {
    if (typeof val === "string") {
      for (const m of val.matchAll(/\{\{\s*([\w.$-]+)\s*\}\}/g)) {
        const key = m[1];
        if (!SYSTEM_PLACEHOLDER.test(key) && !fieldNames.has(key)) bad.push(`${path}: {{${key}}}`);
      }
    } else if (Array.isArray(val)) val.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (val && typeof val === "object") for (const [k, x] of Object.entries(val)) walk(x, `${path}.${k}`);
  };
  walk(v, where);
  return bad;
}

describe("模板完整性: 每个内置模板都要真的能跑", () => {
  // 这一条是"模板加错了但没人发现"的兜底 —— 模板里写错能力 id 或把参数写到运行时读不到的位置,
  // 表现是"选了这个模板, 一跑就 400/空转", 而画布上看着完全正常。
  // 用**真实注册表**核对(而不是上面那份最小替身): 模板引用的 id 必须真的能查到。
  const templates = ORCHESTRATOR_TEMPLATES;
  let realCaps: CapabilityDef[] = [];
  beforeAll(async () => { realCaps = await listCapabilities(); });

  it("模板不少于 13 条且 id 唯一", () => {
    expect(templates.length).toBeGreaterThanOrEqual(13);
    const ids = templates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("新增的三条(润色/大纲/精读)都在", () => {
    for (const id of ["tpl_polish", "tpl_outline", "tpl_pdf_deepread"]) {
      expect(templates.some((t) => t.id === id), `缺模板 ${id}`).toBe(true);
    }
  });

  it("每个模板的每个节点都引用了真实能力(否则会静默退化成 LLM 生成)", () => {
    const known = new Set(realCaps.map((c) => c.id));
    expect(known.size).toBeGreaterThan(50); // 注册表真加载到了, 不是空表
    const missing: string[] = [];
    for (const t of templates) {
      for (const n of t.graph.nodes) {
        if (n.capabilityId && !known.has(n.capabilityId)) missing.push(`${t.id}:${n.id}→${n.capabilityId}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("模板节点的参数全部落在运行时真正读的位置", () => {
    const broken: string[] = [];
    for (const t of templates) {
      for (const step of graphToMetaSkill(t.graph, realCaps).steps) {
        const w = step.with as Record<string, any> | undefined;
        if (!w) continue;
        const nested = w.tool ? "args" : w.endpoint ? "body" : null;
        if (!nested) continue; // llm_* 直接读顶层, 不在此判据内
        const isKnown = (k: string) => k === "tool" || k === "endpoint" || k === nested || k === "maxTokens" || k === "temperature" || k === "system";
        for (const k of Object.keys(w)) {
          if (!isKnown(k)) broken.push(`${t.id}:${step.id} 顶层残留 ${k}(运行时读不到)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("能力自带模板里的 {{占位符}} 都必须有来源(拼错字段名会在这里被拦)", () => {
    const bad: string[] = [];
    for (const c of realCaps) {
      const w = c.step?.with as Record<string, any> | undefined;
      if (!w?.endpoint) continue;
      const fields = new Set((c.fields ?? []).map((f) => f.name));
      bad.push(...badPlaceholders(w.body, fields, c.id));
    }
    expect(bad).toEqual([]);
  });

  it("每个端点能力的模板占位符都能对上自己的字段(含「模板写了但字段漏登记」)", () => {
    // 这条抓的是反向缺口: 模板里引用了 {{code}}, 但 fields 里没有 code ——
    // 用户在画布上**没有任何地方能填它**(实测: emp:regression 的字段只有 projectId,
    // 而它的 body 要 {{code}})。这类缺口让能力"看着能加节点, 实际跑不起来"。
    const bad: string[] = [];
    for (const c of realCaps) {
      const w = c.step?.with as Record<string, any> | undefined;
      if (!w?.endpoint) continue;
      const fields = new Set((c.fields ?? []).map((f) => f.name));
      const missing = badPlaceholders(w.body, fields, c.id);
      if (missing.length) bad.push(`${c.id} 字段缺: ${missing.map((m) => m.split("{{")[1]?.replace("}}", "")).join(",")}`);
    }
    expect(bad).toEqual([]);
  });

  it("模板(graph)里的自定义占位符必须能由该能力的字段补上", () => {
    // 画布节点没有"字段面板自动补值"这一路 —— 值只来自节点参数。
    // 所以模板里出现 {{X}} 时, X 要么是系统内置, 要么必须是该能力的字段名(用户能在面板里填),
    // 否则就是个渲染不出来的死占位符。
    const capById = new Map(realCaps.map((c) => [c.id, c]));
    const bad: string[] = [];
    for (const t of templates) {
      for (const step of graphToMetaSkill(t.graph, realCaps).steps) {
        const w = step.with as Record<string, any> | undefined;
        if (!w) continue;
        const node = t.graph.nodes.find((n) => n.id === step.id);
        const fields = new Set((node?.capabilityId ? capById.get(node.capabilityId)?.fields ?? [] : []).map((f) => f.name));
        bad.push(...badPlaceholders(w, fields, `${t.id}:${step.id}`));
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("renderTemplate: 模板占位符的行为边界", () => {
  it("已知占位符各归各位: {{inputs}} 取上游产出, {{outputs.x}} 取步骤产物", () => {
    const out = renderTemplate("body={{inputs}} out={{outputs.a}}", ctx({ stepInput: "上游产出", outputs: { a: "A" } }));
    expect(out).toBe("body=上游产出 out=A");
  });

  it("自定义字段名不是模板 —— 渲染成标记而不是静默留空", () => {
    // 这就是端点型能力模板里**不该**出现的东西: {{mode}} 只能由节点参数换成字面值。
    // 静默留空会让"模板写错"看起来像"上游没产出", 所以显式标记出来。
    expect(renderTemplate("{{mode}}", ctx())).toContain("未渲染");
  });
});
