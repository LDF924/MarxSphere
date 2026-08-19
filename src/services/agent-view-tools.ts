// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
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
  // ── V399 第二批：文献库/写作语料/评测/入库监控/教育 ──
  {
    name: "view_literature_search", label: "文献库检索", risk: "safe",
    description: "检索本地文献库（500+ 论文元数据），返回论文标题/作者/主题/年份",
    params: {
      query: { type: "string", required: true, desc: "文献检索关键词" },
      limit: { type: "number", desc: "返回条数(默认5)" },
    },
    run: async (a) => safeCall(async () => {
      const { literatureService } = await import("./literature-service.js");
      const q = String(a.query || "").trim();
      const res = await literatureService.list({ keyword: q, page: 1, pageSize: Math.min(Math.max(Number(a.limit) || 5, 1), 10) });
      const items = (res?.items ?? []).slice(0, 8) as unknown as Array<{ title?: string; authors?: string | string[]; year?: string; topic?: string }>;
      return `【文献库】${res?.total ?? items.length} 条\n` + items.map((p, i) => `${i + 1}. ${p.title || "?"} — ${Array.isArray(p.authors) ? p.authors.join(", ") : p.authors || ""}（${p.year || ""} · ${p.topic || ""}）`).join("\n");
    }),
  },
  {
    name: "view_corpus_recall", label: "写作语料召回", risk: "safe",
    description: "从写作语料库召回句式/逻辑/概念/范例，用于学术写作润色（因果/对比/研究缺口等语义组）",
    params: {
      q: { type: "string", required: true, desc: "写作主题或关键词" },
      group: { type: "string", desc: "语义组(因果/对比/研究缺口/总结发现)" },
    },
    run: async (a) => safeCall(async () => {
      const { recallCorpusForWriting } = await import("./writing-corpus-service.js");
      const res = await recallCorpusForWriting({
        q: String(a.q || ""),
        semanticGroups: a.group ? [String(a.group)] : undefined,
        limit: 3
      });
      const lines: string[] = [`【写作语料】句式${res.expressions.length} 逻辑${res.logics.length} 概念${res.concepts.length} 范例${res.texts.length}`];
      res.expressions.slice(0, 2).forEach((e: any) => lines.push(`- [句式·${e.semanticGroup}] ${e.expression}`));
      res.logics.slice(0, 2).forEach((l: any) => lines.push(`- [逻辑·${l.patternType}] ${l.name}`));
      res.texts.slice(0, 2).forEach((t: any) => lines.push(`- [范例] ${String(t.text).slice(0, 120)}`));
      return lines.join("\n");
    }),
  },
  {
    name: "view_eval_report", label: "评测报告", risk: "safe",
    description: "生成 Agent 评测报告（任务完成率/步骤成功率/多轮循环率）",
    params: {
      days: { type: "number", desc: "统计天数(默认7)" },
    },
    run: async (a) => safeCall(async () => {
      const { generateAgentEvalReport } = await import("./agent-eval-service.js");
      const r = await generateAgentEvalReport(Math.min(Math.max(Number(a.days) || 7, 1), 90));
      return `【评测报告】完成率 ${Math.round((r.completionRate ?? 0) * 100)}% · 步骤成功率 ${Math.round((r.stepSuccessRate ?? 0) * 100)}% · ${r.totalTasks ?? 0} 任务 / ${r.totalSteps ?? 0} 步 · 多轮循环率 ${Math.round((r.multiLoopRate ?? 0) * 100)}%`;
    }),
  },
  {
    name: "view_ingest_status", label: "入库监控", risk: "safe",
    description: "查看知识图谱入库状态（Graphiti/Cognee 文档数与索引概况）",
    params: {
      engine: { type: "string", desc: "引擎(graphiti/cognee, 默认graphiti)" },
    },
    run: async (a) => safeCall(async () => {
      const { overview } = await import("./ingest-monitor-service.js");
      const res = await overview(String(a.engine || "graphiti") as any);
      return `【入库状态】${JSON.stringify(res).slice(0, 800)}`;
    }),
  },
  {
    name: "view_education_profile", label: "学情画像", risk: "safe",
    description: "查看自适应学习系统的学生学情画像（知识点掌握度/薄弱点）",
    params: {
      subject: { type: "string", desc: "学科(如 政治经济学)" },
    },
    run: async (a) => safeCall(async () => {
      const { getStudentProfile } = await import("./adaptive-learning-service.js");
      const profile = await getStudentProfile({ subject: String(a.subject || "") }) as Record<string, unknown>;
      return `【学情画像】${JSON.stringify(profile ?? {}).slice(0, 800)}`;
    }),
  },
  {
    name: "view_skill_run", label: "技能执行", risk: "safe",
    description: "完整加载并执行系统技能库中的自研 Skill（SKILL.md 全文 + references 方法库 + scripts），按技能流程完成科研任务",
    params: {
      skill: { type: "string", required: true, desc: "技能名称（如 causal-inference-mixtape/empirical-data-analysis）" },
      goal: { type: "string", required: true, desc: "要完成的任务目标" },
    },
    run: async (a) => safeCall(async () => {
      const { getSkillDetail } = await import("./skills-service.js");
      const detail = getSkillDetail(String(a.skill || ""));
      if (!detail) return `（技能 ${a.skill} 不存在，可用 view_skill_search 检索）`;
      // 完整加载 SKILL.md（非截断）+ references 方法库 + scripts 清单
      const md = String(detail.skillMd ?? "");
      const parts: string[] = [`【技能 ${detail.name} 完整指令】\n${md}`];
      const fs = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");
      // 用实际技能目录（name 模糊匹配后可能是带编号前缀的目录）— 从 SKILL.md 定位
      const skillDir = path.dirname(detail.skillMdPath ?? path.join(os.homedir(), ".claude", "skills", String(a.skill || ""), "SKILL.md"));
      // 读取 references 方法库（每文件前 6000 字，最多 3 个）
      const refDir = path.join(skillDir, "references");
      if (fs.existsSync(refDir)) {
        const refs = fs.readdirSync(refDir).filter((f) => f.endsWith(".md")).slice(0, 3);
        for (const ref of refs) {
          try {
            const content = fs.readFileSync(path.join(refDir, ref), "utf8").slice(0, 6000);
            parts.push(`\n【方法库 ${ref}】\n${content}`);
          } catch { /* 读取失败忽略 */ }
        }
      }
      // scripts 清单
      const scriptsDir = path.join(skillDir, "scripts");
      const scripts = fs.existsSync(scriptsDir) ? fs.readdirSync(scriptsDir) : [];
      if (scripts.length > 0) parts.push(`\n【可执行脚本】${scripts.join(", ")}（可要求 Agent 用 run_code/run_command 执行）`);
      // 限制总注入量防上下文爆炸
      return parts.join("\n\n").slice(0, 16000);
    }),
  },
  // ── V399 第三批：图谱/任务/文档/告警/Trace/Inbox/入库 ──
  {
    name: "view_graph_query", label: "知识图谱查询", risk: "safe",
    description: "查询知识图谱（实体/事件/关系，Neo4j），返回实体关联路径，用于跨文献概念关联分析",
    params: {
      query: { type: "string", required: true, desc: "实体或概念查询（如 剩余价值/资本下乡）" },
      limit: { type: "number", desc: "返回条数(默认10)" },
    },
    run: async (a) => safeCall(async () => {
      const { neo4jQuery } = await import("../db/neo4j-query.js");
      const q = String(a.query || "").trim();
      const limit = Math.min(Math.max(Number(a.limit) || 10, 1), 30);
      const entities = await neo4jQuery(11001,
        `MATCH (e:Entity) WHERE e.name CONTAINS $q RETURN e.name as name, e.id as id LIMIT ${limit}`,
        { q });
      const items = Array.isArray(entities) ? entities : [];
      if (items.length === 0) return `【知识图谱】0 条（Graphiti 11001）`;
      const lines: string[] = [`【知识图谱】${items.length} 条（Graphiti Neo4j）`];
      for (const e of items.slice(0, 10)) {
        lines.push(`- ${e.name ?? "?"}（${String(e.id ?? "").slice(0, 12)}）`);
      }
      return lines.join("\n");
    }),
  },
  {
    name: "view_task_create", label: "创建 Agent 任务", risk: "safe",
    description: "创建并执行 Agent 任务（自主规划+工具执行），返回任务 ID 与目标",
    params: {
      goal: { type: "string", required: true, desc: "任务目标（如 分析资本下乡对集体经济的影响）" },
      template: { type: "string", desc: "模板(lit_review/empirical/policy/concept)" },
    },
    run: async (a) => safeCall(async () => {
      const { createAgentTask, runAgentTask } = await import("./agent-task-service.js");
      const goal = String(a.goal || "").trim();
      const tpl = String(a.template || "");
      const task = tpl && /^(lit_review|empirical|policy|concept)$/.test(tpl)
        ? await createAgentTaskFromTemplateSafe(tpl, goal)
        : await createAgentTask({ goal });
      if (!task) return "（任务创建失败）";
      // 后台启动执行，返回任务信息（不阻塞工具循环）
      void runAgentTask(task.id, async (step) => {
        const { buildAgentTools, chooseToolByLlm, executeToolWithFallback } = await import("./agent-tool-router.js");
        const tools = await buildAgentTools({ sourceId: task.projectId || undefined });
        const chosen = await chooseToolByLlm(task.goal, step.title, tools);
        if (chosen) {
          const exec = await executeToolWithFallback(chosen.tool, chosen.args, tools);
          if (exec.ok) return { result: exec.result.substring(0, 120), detail: `【工具】${chosen.tool.label}\n${exec.result}`, source: `工具: ${chosen.tool.label}` };
        }
        const SELF_BASE = process.env.AGENT_API_BASE || "http://localhost:4173";
        const res = await fetch(SELF_BASE + "/api/reason/query", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceId: task.projectId || undefined, query: step.query, mode: "adaptive" }),
        });
        const data: any = await res.json();
        return { result: (data?.trace?.hypothesis?.content || data?.error || "（无结果）").substring(0, 120), detail: data?.trace?.hypothesis?.content || "（无结果）", source: "SAG 推理" };
      }).catch(() => {});
      return `【Agent 任务已创建】${task.id.slice(0, 8)}…\n目标: ${task.goal}\n已开始后台执行（查看: 任务面板）`;
    }),
  },
  {
    name: "view_task_status", label: "任务状态查询", risk: "safe",
    description: "查询 Agent 任务列表与执行状态（运行中/完成/失败）",
    params: {
      limit: { type: "number", desc: "返回条数(默认5)" },
    },
    run: async (a) => safeCall(async () => {
      const { listAgentTasks } = await import("./agent-task-service.js");
      const tasks = await listAgentTasks(undefined, undefined, undefined, 0, Math.min(Math.max(Number(a.limit) || 5, 1), 20));
      const items = (tasks ?? []).slice(0, 10) as unknown as Array<{ id: string; goal: string; status: string }>;
      return `【任务列表】${items.length} 条\n` + items.map((t, i) => `${i + 1}. ${String(t.goal ?? "?").slice(0, 50)} — ${t.status}（${String(t.id).slice(0, 8)}）`).join("\n");
    }),
  },
  {
    name: "view_documents_stats", label: "文档统计", risk: "safe",
    description: "统计项目文档/切片/事件/实体数量（文献库规模概览）",
    params: {
      sourceId: { type: "string", desc: "项目ID(默认主项目)" },
    },
    run: async (a) => safeCall(async () => {
      const { webuiService } = await import("./webui-service.js");
      const sourceId = String(a.sourceId || "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a");
      const stats = await webuiService.getProjectStats(sourceId);
      return `【文档统计】${JSON.stringify(stats).slice(0, 500)}`;
    }),
  },
  {
    name: "view_alerts", label: "系统告警", risk: "safe",
    description: "查看系统告警列表（未读告警/错误提示）",
    params: {
      limit: { type: "number", desc: "返回条数(默认5)" },
    },
    run: async (a) => safeCall(async () => {
      const SELF_BASE = process.env.AGENT_API_BASE || "http://localhost:4173";
      const res = await fetch(`${SELF_BASE}/api/alerts`);
      const data: any = await res.json();
      const items = (data?.alerts ?? []).slice(0, Math.min(Math.max(Number(a.limit) || 5, 1), 10)) as Array<{ message?: string; level?: string; createdAt?: string }>;
      return `【系统告警】${items.length} 条\n` + items.map((x, i) => `${i + 1}. [${x.level ?? "info"}] ${x.message ?? "?"}`).join("\n");
    }),
  },
  {
    name: "view_traces", label: "Trace 查询", risk: "safe",
    description: "查询最近检索/推理链路 Trace（执行耗时/步骤数）",
    params: {
      limit: { type: "number", desc: "返回条数(默认5)" },
    },
    run: async (a) => safeCall(async () => {
      const { traceService } = await import("./trace-service.js");
      const traces = await traceService.list({ limit: Math.min(Math.max(Number(a.limit) || 5, 1), 10) }) as unknown as Array<{ id: string; name?: string; durationMs?: number }>;
      return `【Trace】${traces.length} 条\n` + traces.map((t, i) => `${i + 1}. ${String(t.name ?? "?").slice(0, 40)} — ${t.durationMs ?? 0}ms`).join("\n");
    }),
  },
];

/** 模板任务创建（防循环依赖，内部转调） */
async function createAgentTaskFromTemplateSafe(templateId: string, goal: string) {
  const { createAgentTaskFromTemplate } = await import("./agent-task-service.js");
  return createAgentTaskFromTemplate({ templateId, goal });
}
