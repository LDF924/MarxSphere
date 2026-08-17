// agent-view-tools.ts — V399: 33 视图能力工具化（对话页一句话调度全系统）
// 把各视图面板的核心后端能力封装为 Agent 工具，注册进 buildAgentTools。
// 原则：只读优先、结果截断、异常兜底为「（不可用: …）」不抛断工具循环。
import type { AgentToolDef } from "./agent-tool-router.js";

/** 安全地执行服务调用，异常兜底为可读文本（不抛断工具循环） */
async function safeCall(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e: any) {
    return `（视图能力不可用: ${String(e?.message || e).slice(0, 150)}）`;
  }
}

export const VIEW_TOOLS: AgentToolDef[] = [
  {
    name: "view_policy_tree", label: "政策库检索", risk: "safe",
    description: "检索政策库目录树（政策文件/资料，按分类树组织），返回匹配的政策标题与路径",
    params: {
      query: { type: "string", required: true, desc: "政策检索关键词（如 数字经济/乡村振兴/劳动法）" },
    },
    run: async (a) => safeCall(async () => {
      const { policyLibraryService } = await import("./policy-library-service.js");
      const q = String(a.query || "").trim();
      const tree = policyLibraryService.getTree();
      // 扁平化目录树并按关键词过滤
      const flat: Array<{ title: string; path: string }> = [];
      const walk = (nodes: Array<{ name?: string; title?: string; path?: string; children?: unknown[] }>, prefix = "") => {
        for (const n of nodes) {
          const title = String(n.title ?? n.name ?? "");
          const p = n.path ? String(n.path) : `${prefix}/${title}`;
          if (title) flat.push({ title, path: p });
          if (n.children) walk(n.children as any, p);
        }
      };
      walk((tree?.nodes ?? []) as any);
      const hits = flat.filter((f) => f.title.includes(q)).slice(0, 10);
      return `【政策库】${hits.length} 条（目录共 ${flat.length} 项）\n` + hits.map((h, i) => `${i + 1}. ${h.title}（${h.path}）`).join("\n");
    }),
  },
  {
    name: "view_truth_list", label: "知识页检索", risk: "safe",
    description: "检索知识页（系统沉淀的结构化知识页面，含概念/事件/观点），返回页面标题与内容",
    params: {
      query: { type: "string", required: true, desc: "知识页检索关键词" },
    },
    run: async (a) => safeCall(async () => {
      const { truthService } = await import("./truth-service.js");
      const q = String(a.query || "").trim();
      const pages = await truthService.listPages();
      const hits = (pages ?? []).filter((p: any) => String(p.title ?? "").includes(q) || String(p.compiledTruth ?? "").includes(q)).slice(0, 5);
      return `【知识页】${hits.length} 条（共 ${(pages ?? []).length} 页）\n` + hits.map((p: any, i: number) => `${i + 1}. ${p.title || "?"}\n${String(p.compiledTruth ?? "").slice(0, 200)}`).join("\n");
    }),
  },
  {
    name: "view_sciverse_search", label: "外部学术检索", risk: "safe",
    description: "检索外部学术源（Sciverse：知网/万方/期刊联盟），返回论文标题/作者/来源",
    params: {
      query: { type: "string", required: true, desc: "学术检索关键词" },
      limit: { type: "number", desc: "返回条数(默认5)" },
    },
    run: async (a) => safeCall(async () => {
      const { sciverseService } = await import("./sciverse-service.js");
      const res = await sciverseService.dispatch("search_papers", { query: String(a.query || ""), max: Math.min(Math.max(Number(a.limit) || 5, 1), 10) });
      const items = (res?.data ?? []) as Array<{ title?: string; authors?: string; journal?: string; year?: string }>;
      return `【外部学术】${items.length} 条\n` + items.map((p, i) => `${i + 1}. ${p.title || "?"} — ${p.authors || ""}（${p.journal || ""} ${p.year || ""}）`).join("\n");
    }),
  },
  {
    name: "view_skill_search", label: "技能检索", risk: "safe",
    description: "检索系统技能库（103 个自研 Skill），返回匹配技能名称与描述",
    params: {
      query: { type: "string", required: true, desc: "技能检索关键词（如 因果推断/实证/文献综述）" },
    },
    run: async (a) => safeCall(async () => {
      const { searchSkill } = await import("./skills-service.js");
      const q = String(a.query || "").trim();
      const res = await searchSkill(q, 8);
      const cands = res?.candidates ?? [];
      return `【技能库】${cands.length} 条\n` + cands.map((c, i) => `${i + 1}. ${c.skillName}（相似度 ${(c.similarity * 100).toFixed(0)}%）`).join("\n");
    }),
  },
  {
    name: "view_vault_tree", label: "资料库检索", risk: "safe",
    description: "检索资料库目录（归档资料文件树），返回匹配的资料路径",
    params: {
      query: { type: "string", required: true, desc: "资料检索关键词" },
    },
    run: async (a) => safeCall(async () => {
      const { vaultService } = await import("./vault-service.js");
      const q = String(a.query || "").trim();
      const tree = vaultService.getTree();
      const flat: string[] = [];
      const walk = (nodes: Array<{ name?: string; path?: string; children?: unknown[] }>, prefix = "") => {
        for (const n of nodes) {
          const name = String(n.name ?? "");
          const p = n.path ? String(n.path) : `${prefix}/${name}`;
          if (name) flat.push(p);
          if (n.children) walk(n.children as any, p);
        }
      };
      walk((tree?.nodes ?? []) as any);
      const hits = flat.filter((f) => f.includes(q)).slice(0, 10);
      return `【资料库】${hits.length} 条（共 ${flat.length} 项）\n` + hits.map((h, i) => `${i + 1}. ${h}`).join("\n");
    }),
  },
  {
    name: "view_memory_context", label: "记忆检索", risk: "safe",
    description: "检索系统记忆（对话上下文/经验沉淀），返回相关记忆片段",
    params: {
      query: { type: "string", required: true, desc: "记忆检索关键词" },
    },
    run: async (a) => safeCall(async () => {
      const { listConversationContexts } = await import("./memory-service.js");
      const q = String(a.query || "").trim();
      const sessions = await listConversationContexts("00000000-0000-0000-0000-000000000000", 20);
      const hits = (sessions ?? []).filter((s: any) => String(s.query ?? "").includes(q) || String(s.answerSummary ?? "").includes(q)).slice(0, 5);
      return `【记忆】${hits.length} 条\n` + hits.map((s: any, i: number) => `${i + 1}. Q: ${s.query}\n   A: ${String(s.answerSummary ?? "").slice(0, 150)}`).join("\n");
    }),
  },
];
