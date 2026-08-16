// plugin-example-classical.ts — V395-4: 示例插件（经典文本研究工具包）
// 插件入口约定: export { tools } — AgentToolDef 数组（注册时自动采集声明）
// 注册: POST /api/agent/plugins {id:"classical-tools", name:"经典文本", entry:"./plugin-example-classical.js"}
// 启用后 buildAgentTools 自动合并这些工具（工具名带插件前缀, LLM 可选择调用）
import type { AgentToolDef } from "./agent-tool-router.js";

export const tools: AgentToolDef[] = [
  {
    name: "concept_trace", label: "概念溯源", risk: "safe",
    description: "经典文本概念溯源与语义演变（马理论经典研究专用）",
    params: { concept: { type: "string", required: true, desc: "概念名（如 剩余价值）" } },
    run: async (a) => {
      const res = await fetch("http://localhost:4173/api/classical/concept-trace", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: String(a.concept), sourceId: "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a" }),
      });
      const d: any = await res.json();
      return d?.stages?.map((s: any) => `${s.era}: ${s.meaning}`).join("\n") || d?.error || "（无结果）";
    },
  },
  {
    name: "argument_structure", label: "论证拆解", risk: "safe",
    description: "拆解经典文本中的论证结构（前提/推理/结论）",
    params: { text: { type: "string", required: true, desc: "待拆解的文本段落" } },
    run: async (a) => `论证拆解请求已登记: ${String(a.text).slice(0, 100)}…（请在经典文本研究场景查看完整拆解）`,
  },
];
