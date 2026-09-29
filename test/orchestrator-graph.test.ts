// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dagNodeToMetaStep, graphToMetaSkill, listCapabilities, type CapabilityDef } from "../src/services/capability-registry.js";
import { ORCHESTRATOR_TEMPLATES } from "../src/services/orchestrator-templates.js";
import { renderTemplate, type MetaRunContext } from "../src/services/meta-skill-runtime.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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
 * 占位符合法性: 运行时认 {{inputs}}/{{user.x}}/{{outputs.x}}, 以及**裸字段名**。
 *
 * 裸名 {{X}} 的合法条件是 X 是**该能力自己声明的字段名** —— 语义是"值来自字段面板"。
 * (2026-09-29 修: 它原来只是"被允许写", 实际渲染成 [未渲染:{{X}}] 发给端点, 见
 *  meta-skill-runtime.renderTemplate 里裸名那一段与 test/orchestrator-params.test.ts。)
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

  it("**模板节点的参数键必须是该能力声明过的字段**(死键在这一条被拦)", () => {
    // 由来(2026-09-29): tpl_empirical 给 stat:run 传 `method`, 而它读的是 `tool`;
    //   给 viz:render 传 `prompt`, 而它读的是 `message`。
    //   两个都是**死键**: 合并进 body 后端点不认(或忽略), 而画布上相关参数行照常显示、
    //   用户填了也不生效 —— 表现是"这个模板一跑就缺参数/画不出图", 查不出原因。
    const capById = new Map(realCaps.map((c) => [c.id, c]));
    const dead: string[] = [];
    for (const t of templates) {
      for (const n of t.graph.nodes) {
        if (!n.params || !n.capabilityId) continue;
        const cap = capById.get(n.capabilityId);
        if (!cap) continue;
        const fields = new Set((cap.fields ?? []).map((f) => f.name));
        const declared = new Set([...fields, ...(cap.inputs ?? []), ...(cap.outputs ?? [])]);
        // 少数几处是通用数据字段(不登记为 fields, 但运行时确实读)
        const universal = new Set(["input", "text", "csv", "params", "system", "task", "criteria"]);
        for (const k of Object.keys(n.params)) {
          if (!declared.has(k) && !universal.has(k)) {
            dead.push(`${t.id}:${n.id}(${n.capabilityId}) 传了 ${k} —— 该能力认: ${[...fields].join(", ") || "(无 fields)"}`);
          }
        }
      }
    }
    expect(
      dead,
      "这些参数名该能力不认识。写错名字不会报错: 参数被合进 body 后端点忽略,\n" +
        "而画布上参数行照常显示, 用户填了也不生效 —— 只能靠人肉比对能力注册表才发现。",
    ).toEqual([]);
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

  it("字段名为空(userValues 里没有)时仍然显式标记, 不静默留空", () => {
    // ⚠ 这条**不是**在说 {{mode}} 不该出现在模板里 —— 2026-09-29 起它是合法的:
    //   只要 mode 是该能力声明的字段, 运行时就会去 userValues 取(见 orchestrator-params.test.ts)。
    //   这里验的是**取不到**的情形(字段没值/名字拼错): 那时必须留痕, 否则"模板写错"
    //   看起来就像"上游没产出"。
    expect(renderTemplate("{{mode}}", ctx())).toContain("未渲染");
    expect(renderTemplate("{{拼错的名字}}", ctx())).toContain("未渲染");
  });
});

/**
 * 前端侧的同一条契约: **模板载入画布时, 字段默认值必须补上**。
 *
 * 由来(2026-09-29): `loadGraphInto` 原来写的是
 *   `params: n.params ? { ...n.params } : defaultParams(cap)`
 * —— 二选一。于是**模板节点永远拿不到字段默认值**: 模板没给的字段是 undefined,
 * 面板上连那一行都不出现(参数行按 params 的键渲染), 用户想填也没地方填;
 * 端点拿到空串只能报"参数不合法"。而 `fields[].default` 正是为"没人填时也别做空"准备的。
 *
 * ⚠ 这个文件在 Vue SFC 的 `<script setup>` 里, 单测 import 不了 —— 与
 *   `test/stage-steps.test.ts` 同一手法: 文本解析。写法一变它会红, 那是**要的**
 *   (契约就是"合并而不是二选一", 换写法时应该有人确认一遍)。
 */
describe("frontend: 模板载入画布时的参数合并", () => {
  it("defaultParams 与模板参数是**合并**, 不是二选一", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "web", "socialsci-vue", "src", "views", "quick", "QuickModeView.vue"),
      "utf8",
    );
    // 二选一的写法(旧)
    const eitherOr = /n\.params\s*\?\s*\{\s*\.\.\.n\.params\s*\}\s*:\s*\(?\s*cap\s*\?/;
    expect(
      eitherOr.test(src),
      "loadGraphInto 又变回二选一了: 模板节点会丢掉字段默认值 —— 面板上没有可填行, 端点收到空参数。",
    ).toBe(false);
    // 合并的写法(新): defaultParams(cap) 打底, 模板参数覆盖
    expect(
      /\.\.\.defaultParams\(cap\)[\s\S]{0,80}\.\.\.\(?\s*n\.params/ .test(src),
      "没找到「默认值打底 + 模板参数覆盖」的写法 —— 契约变了请同步本测试",
    ).toBe(true);
  });
});

/**
 * 端到端: **照真实链路**走一遍 —— 能力的默认字段值被塞进节点参数, 再经 dagNodeToMetaStep
 * 合并、renderTemplate 渲染, 结果里不该有未渲染标记。
 *
 * 由来(2026-09-29): 我第一版写成了"直接渲染能力注册表的 step.with", 结果 18 个能力全红 ——
 *   而那 18 处**全部在 `step.with.body` 里、且名字都是该能力声明的字段**。body 正是
 *   `params[nested]` 会**整体替换**的那个槽(见 dagNodeToMetaStep), 所以那些裸占位符
 *   是"给字段留的种子", 运行时被参数值盖掉, 根本不参与渲染。
 *   照真实链路走就对了: 种子进 params → 合并 → 渲染。
 *
 * 判据用"渲染结果里没有未渲染标记", 不是"模板里没有裸占位符" —— 后者会把上面那 18 处
 * 误报成 bug, 逼着人把标记改掉(而那些标记是有用的: 它们告诉字段面板"这里该填什么")。
 */
describe("端到端: 按真实链路合并 + 渲染后不该有未渲染标记", () => {
  it("每个能力: 用默认字段值起一张单节点图 → 渲染后的 with 无未渲染标记", async () => {
    const caps = await listCapabilities();
    const bad: string[] = [];
    for (const c of caps) {
      if (!c.step?.with) continue;
      const w = c.step.with as Record<string, any>;
      if (!w.endpoint) continue; // 端点型才有"请求体必须合法"的硬约束
      // 模拟画布: 字段默认值进 params(模板没给的字段也补上, 这正是 loadGraphInto 修的那点)
      const params: Record<string, unknown> = {};
      for (const f of c.fields ?? []) if (f.default !== undefined) params[f.name] = f.default;
      const step = dagNodeToMetaStep({ id: "n", capabilityId: c.id, params }, caps, []);
      const rendered = JSON.stringify(step.with);
      const leaked = [...rendered.matchAll(/未渲染:\{\{([\w.| -]+)\}\}/g)].map((m) => m[1]);
      if (leaked.length) bad.push(`${c.id}: ${[...new Set(leaked)].join(", ")}`);
    }
    expect(
      bad,
      "这些能力的请求体里还留着未渲染的占位符 —— 会被原样发给端点。\n" +
        "两种成因: ① 字段没登记/名字对不上(面板填不了); ② 有 default 却没被塞进 params。",
    ).toEqual([]);
  });
});
