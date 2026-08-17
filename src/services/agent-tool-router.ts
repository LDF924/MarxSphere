// agent-tool-router.ts — V393-1: 真·工具调用（LLM 动态工具选择）
// 规划时不再定死工具类型: 每步执行时 LLM 从工具清单选工具+参数, 运行时调度
// 工具清单: SAG 现有能力注册表（推理/检索/写作/实证/政策等）
import { callLlm } from "../ai/llm-common.js";
import { getRoleModel, resolveModelAlias } from "./llm-model-registry.js";
import { agentModelRouter } from "./agent-model-router.js";
import { guardUserInput } from "./prompt-guard.js";  // G23: 用户输入分界防护
import path from "node:path";  // G26: checkPathAccess 固定项目根（静态 import, require 在 ESM 不可用）
import { fileURLToPath } from "node:url";
import type { Dirent } from "node:fs";  // 差距I: code_search 类型引用
import { executeToolsParallel as _executeToolsParallel } from "./agent-tool-registry.js";  // 借鉴1: 并行执行

/** Agent 可用工具注册表（name/描述/参数schema/危险级别） */
export interface AgentToolDef {
  name: string;
  label: string;
  description: string;
  /** 参数 schema（JSON Schema 简化版: {param: {type, required?, desc}}） */
  params: Record<string, { type: "string" | "number" | "boolean"; required?: boolean; desc: string }>;
  /** 危险级别: safe(直接执行) | review(需审批) | deny(默认禁止) */
  risk: "safe" | "review" | "deny";
  /** 执行器（运行时调用, 返回结果字符串） */
  run: (args: Record<string, unknown>) => Promise<string>;
  /** V396-6: 真实 token/成本采集（LLM 类工具执行后回填 usage） */
  lastUsage?: { tokensIn: number; tokensOut: number; costCents: number };
}

/** 修复2: Edge 路径探测（同步, 模块加载时缓存） */
function detectEdgePath(): string {
  const candidates = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    (process.env.LOCALAPPDATA || "") + "/Microsoft/Edge/Application/msedge.exe",
  ];
  try {
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    for (const c of candidates) {
      if (c && existsSync(c)) return c;
    }
  } catch { /* ESM 下 require 不可用 → 用默认 */ }
  return candidates[0];
}

/** 工具注册表（V393-1: 首批 8 个核心工具; V395-1: +pdf_parse 多模态） */
export async function buildAgentTools(opts?: {
  sourceId?: string;
  stepTitle?: string;
}): Promise<AgentToolDef[]> {
  const sourceId = opts?.sourceId || "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";
  // 修复1: API base 集中配置 — AGENT_API_BASE 覆盖（局域网部署设局域网 IP）; 默认本机
  const apiBase = process.env.AGENT_API_BASE || "http://localhost:4173";
  // 修复2: Edge 路径探测 — AGENT_EDGE_PATH 覆盖; 否则探测 3 个常见安装位置
  const edgePath = process.env.AGENT_EDGE_PATH || detectEdgePath();
  const callApi = async (path: string, body: Record<string, unknown>): Promise<string> => {
    const res = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, ...body }),
    });
    const data: any = await res.json();
    return data?.trace?.hypothesis?.content || data?.content || data?.result || data?.error || JSON.stringify(data).slice(0, 500);
  };
  // V395-1: 多模态 PDF 工具（动态 import 避免启动开销）
  let pdfTool: AgentToolDef | null = null;
  try {
    const { pdfParseTool } = await import("./agent-pdf-tool.js");
    pdfTool = pdfParseTool as AgentToolDef;
  } catch { /* PyMuPDF 不可用则跳过 */ }
  // V396-6: LLM 写作工具（具名 const 以便 usage 自引用回填）
  // G3: 改走 callLlm(统一重试/退避) — 不再直连 fetch, agentContext 采集 usage 入 exec_logs
  const llmWriteTool: AgentToolDef = {
    name: "llm_write", label: "LLM写作", risk: "safe",
    description: "撰写研究段落/综述/摘要（LLM 直接生成; 自动注入语料库素材, 借鉴句式不照抄）",
    params: { topic: { type: "string", required: true, desc: "写作主题" }, length: { type: "string", desc: "长度(短/中/长)" } },
    run: async (a) => {
      // 语料库注入: 按主题召回相关素材（句式/逻辑/概念/范例）— 只借鉴表达逻辑, 不照搬原文
      let corpusHint = "";
      try {
        const { recallCorpusForWriting } = await import("./writing-corpus-service.js");
        const topic = String(a.topic || "");
        const writingModule = /综述|review/i.test(topic) ? "综述"
          : /引言|背景/i.test(topic) ? "引言"
          : /结论|总结/i.test(topic) ? "结论"
          : /讨论/i.test(topic) ? "讨论"
          : /实证|回归|分析数据/i.test(topic) ? "实证分析" : undefined;
        const rec = await recallCorpusForWriting({ writingModule, semanticGroups: ["因果", "对比", "研究缺口", "总结发现"], q: topic.slice(0, 30), limit: 2 });
        const parts: string[] = [];
        if (rec.expressions.length > 0) {
          parts.push(`【高级句式(按需替换基础词)】\n${rec.expressions.slice(0, 3).map((e) => `- ${e.expression}${e.replaceFor ? ` (替代 "${e.replaceFor}")` : ""}`).join("\n")}`);
        }
        if (rec.logics.length > 0) {
          parts.push(`【论证框架(结构可复用)】\n${rec.logics.slice(0, 2).map((l) => `- ${l.name}: ${l.structure.map((s) => s.desc).join(" → ")}`).join("\n")}`);
        }
        if (rec.concepts.length > 0) {
          parts.push(`【核心概念(确保术语准确)】\n${rec.concepts.slice(0, 3).map((c) => `- ${c.name}: ${c.definition.slice(0, 60)}${c.proposer ? ` (${c.proposer})` : ""}`).join("\n")}`);
        }
        if (rec.texts.length > 0) {
          parts.push(`【段落范例(仅模仿结构, 禁止照抄原文)】\n${rec.texts.slice(0, 1).map((t) => `- 来源[${t.writingModule}]: ${t.text.slice(0, 120)}…`).join("\n")}`);
        }
        if (parts.length > 0) corpusHint = `\n\n【语料库素材(借鉴逻辑与句式, 不得照抄原文; 用自己语言重写)】\n${parts.join("\n")}`;
      } catch { /* 语料库不可用 → 正常写作 */ }
      const r = await callLlm({
        model: agentModelRouter.routeAgentModel("write", String(a.topic || "")),
        agentContext: { action: "agent_tool_llm_write", tool: "llm_write" },
        messages: [{ role: "user", content: `撰写研究段落。主题: ${guardUserInput(String(a.topic || ""), "写作主题")}\n用中文，${a.length === "长" ? "800" : a.length === "短" ? "200" : "400"}-${a.length === "长" ? "1000" : a.length === "短" ? "300" : "600"}字，结构化。${corpusHint}` }],
        temperature: 0.3, maxTokens: 1500,
      });
      // G3: 真实 usage 回填（tool 级成本采集）
      if (r?.tokens) {
        llmWriteTool.lastUsage = { tokensIn: r.tokens.in, tokensOut: r.tokens.out, costCents: 0 };
      }
      return r?.text || (r?.error ? `（写作失败: ${r.error}）` : "（写作失败）");
    },
  };
  const tools: AgentToolDef[] = [
    // P1-1: 自有 MCP 能力接入 agent — 同进程直连服务函数（不经 MCP 协议, 零额外开销）
    // sag_search: 多路混合检索（对应 MCP sag_search; 返回结构化结果）
    {
      name: "sag_search", label: "知识库检索", risk: "safe",
      description: "SAG 知识库混合检索（BM25+向量+图谱, 返回检索片段/来源）",
      params: {
        query: { type: "string", required: true, desc: "检索问题" },
        topK: { type: "number", desc: "返回条数(默认5, 上限50)" },
        strategy: { type: "string", desc: "检索策略(multi/vector)" },
      },
      run: async (a) => {
        try {
          const { searchService } = await import("./search-service.js");
          const r = await searchService.search({
            query: String(a.query || ""),
            sourceIds: ["c609acbf-1d6e-4bd5-9ae1-92fa6c64021a"],
            topK: Math.min(Math.max(Number(a.topK) || 5, 1), 50),
            strategy: (a.strategy === "vector" ? "vector" : "multi") as any,
            returnTrace: true,
          });
          const hits = Array.isArray(r.sections) ? r.sections.slice(0, 10) : [];
          const lines: string[] = [`【知识库检索】${hits.length} 条结果`];
          for (const h of hits) {
            const text = String(h?.content ?? "").slice(0, 200);
            const src = String(h?.sourceId ?? "").slice(0, 12);
            lines.push(`- [${src}] ${text}`);
          }
          if (hits.length === 0) lines.push("（无结果 — 换关键词或确认知识库已入库）");
          return lines.join("\n");
        } catch (e: any) {
          return `（检索异常: ${String(e?.message || e).slice(0, 200)}）`;
        }
      },
    },
    // P1-1: 事件详情（对应 MCP sag_get_event）
    {
      name: "sag_get_event", label: "事件详情", risk: "safe",
      description: "按事件ID获取知识库事件详情（实体/关联/原始文本）",
      params: { eventId: { type: "string", required: true, desc: "事件ID" } },
      run: async (a) => {
        try {
          const { graphService } = await import("./graph-service.js");
          const ev = await graphService.getEvent(String(a.eventId));
          if (!ev) return "（事件不存在）";
          return JSON.stringify(ev).slice(0, 2000);
        } catch (e: any) {
          return `（事件查询异常: ${String(e?.message || e).slice(0, 200)}）`;
        }
      },
    },
    // P1-1: 文档入库（对应 MCP sag_ingest_document; 写操作需人工审批）
    {
      name: "sag_ingest", label: "文档入库", risk: "review",
      description: "将文档内容入库知识库（标题+正文+抽取实体; 需人工审批）",
      params: {
        title: { type: "string", required: true, desc: "文档标题" },
        content: { type: "string", required: true, desc: "文档正文" },
        sourceId: { type: "string", desc: "归属数据源ID(默认主库)" },
      },
      run: async (a) => {
        try {
          const { ingestionService } = await import("./ingestion-service.js");
          const r = await ingestionService.ingestDocument({
            title: String(a.title || "").slice(0, 200),
            content: String(a.content || "").slice(0, 100_000),
            sourceId: String(a.sourceId || "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a"),
            extract: true,
          });
          return `✅ 已入库: ${String(a.title).slice(0, 40)} (${r?.documentId ?? "?"})`;
        } catch (e: any) {
          return `（入库异常: ${String(e?.message || e).slice(0, 200)}）`;
        }
      },
    },
    {
      name: "sag_reason", label: "SAG推理", risk: "safe",
      description: "多路混合检索+52步推理链, 回答研究问题（三库检索）",
      params: { query: { type: "string", required: true, desc: "研究问题" } },
      run: async (a) => callApi("/api/reason/query", { query: String(a.query), mode: "adaptive" }),
    },
    {
      name: "sag_retrieve", label: "文献检索", risk: "safe",
      description: "从知识库检索相关文献内容（返回检索片段）",
      params: { query: { type: "string", required: true, desc: "检索词" }, topK: { type: "number", desc: "返回条数(默认5)" } },
      run: async (a) => callApi("/api/reason/query", { query: String(a.query), mode: "adaptive", ablation: ["hypothesis", "evaluate", "outline"] }),
    },
    llmWriteTool,
    {
      name: "concept_trace", label: "概念溯源", risk: "safe",
      description: "经典文本概念溯源与语义演变（马理论经典研究）",
      params: { concept: { type: "string", required: true, desc: "概念名" } },
      run: async (a) => {
        const res = await fetch(`${apiBase}/api/classical/concept-trace`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ concept: String(a.concept), sourceId }),
        });
        const d: any = await res.json();
        return d?.stages?.map((s: any) => `${s.era}: ${s.meaning}`).join("\n") || d?.error || "（无结果）";
      },
    },
    {
      name: "policy_search", label: "政策检索", risk: "safe",
      description: "检索政策法规原文与条文（政策库）",
      params: { keyword: { type: "string", required: true, desc: "政策关键词" } },
      run: async (a) => callApi("/api/reason/query", { query: `政策: ${a.keyword}`, mode: "adaptive" }),
    },
    // 借鉴4(DSH subagent-claude-code): 调外部 Agent 子进程（Claude Code CLI 桥）
    // 复用 ai-execute-service 的 executeWithClaude; 严格成功映射 + 超时清理
    {
      name: "agent_subagent", label: "外部Agent调用", risk: "review",
      description: "将子任务委托给外部 Agent（Claude Code CLI）执行（编程/代码任务; 需人工审批）",
      params: {
        prompt: { type: "string", required: true, desc: "委托给外部 Agent 的任务指令" },
        cwd: { type: "string", desc: "工作目录(默认项目根)" },
        timeoutMs: { type: "number", desc: "超时(毫秒, 默认120000, 上限600000)" },
      },
      run: async (a) => {
        try {
          const { executeWithClaude } = await import("./ai-execute-service.js");
          const r = await executeWithClaude({
            prompt: String(a.prompt || ""),
            cwd: a.cwd ? String(a.cwd) : undefined,
            timeoutMs: Math.min(Math.max(Number(a.timeoutMs) || 120000, 10000), 600000),
          });
          if (r.ok) {
            return `【外部Agent】Claude Code 执行完成 (${(r.tookMs ?? 0) / 1000}s)\n${String(r.output || "").slice(0, 3000)}`;
          }
          return `（外部Agent执行失败: ${String(r.error || "未知错误").slice(0, 300)}）`;
        } catch (e: any) {
          return `（外部Agent调用异常: ${String(e?.message || e).slice(0, 200)}）`;
        }
      },
    },
    {
      name: "run_code", label: "代码执行", risk: "safe",
      description: "执行 Python/JS 代码 — 本机沙箱(默认)/WSL/SSH 远程(WSL 直连; SSH 需配 AGENT_SSH_*)",
      params: {
        language: { type: "string", required: true, desc: "python 或 javascript" },
        code: { type: "string", required: true, desc: "要执行的代码（沙箱内, 禁止文件删除/系统命令/网络监听）" },
        timeoutMs: { type: "number", desc: "超时(毫秒, 默认20000, 上限60000)" },
        profile: { type: "string", desc: "沙箱级别: read-only(默认)/workspace-write/full-access" },
        target: { type: "string", desc: "计算上下文: local(默认)/wsl/WSL/ssh(AGENT_SSH_HOST)/gpu(AGENT_GPU_HOST, CUDA环境)" },
      },
      run: async (a) => {
        const lang = String(a.language || "python");
        if (!["python", "javascript"].includes(lang)) return "（language 需为 python 或 javascript）";
        const target = String(a.target || "local");
        const timeoutMs = Math.min(Math.max(Number(a.timeoutMs) || 20000, 1000), 60000);
        // wisp借鉴2: 远程计算上下文 — WSL 直连 / SSH 远程
        if (target !== "local") {
          const { executeRemoteCode } = await import("./agent-remote-exec.js");
          const r = await executeRemoteCode({
            target: target as "wsl" | "ssh",
            language: lang as "python" | "javascript",
            code: String(a.code || ""),
            timeoutMs,
          });
          const parts: string[] = [`【代码执行·${target}】${lang} · ${r.durationMs}ms`];
          if (r.stdout) parts.push(`输出:\n${r.stdout}`);
          if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
          if (r.error) parts.push(`错误: ${r.error}`);
          if (!r.stdout && !r.error) parts.push("（无输出）");
          return parts.join("\n");
        }
        const { executeCode, suggestSandboxEscalation } = await import("./code-sandbox-service.js");
        const profile = String(a.profile || "");
        const r = await executeCode({
          language: lang as "python" | "javascript",
          code: String(a.code || ""),
          timeoutMs,
          profile: (profile === "workspace-write" || profile === "full-access" ? profile : undefined) as any,
        });
        const parts: string[] = [`【代码执行】${lang} · ${r.durationMs}ms`];
        if (r.stdout) parts.push(`输出:\n${r.stdout}`);
        if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
        if (r.error) {
          parts.push(`错误: ${r.error}`);
          // 借鉴2: 升级链建议 — 低级别被拦 → 提示升级级别
          const esc = suggestSandboxEscalation(String(a.code || ""), (profile as any) || "read-only");
          if (esc.suggested !== esc.reason) parts.push(`💡 升级建议: ${esc.reason}（使用 profile 参数升级）`);
        }
        if (!r.stdout && !r.error) parts.push("（无输出）");
        return parts.join("\n");
      },
    },
    // 差距C②(DSH web-search): 学术源 web 搜索（白名单域名, Edge headless 抓取搜索结果页）
    {
      name: "web_search", label: "网页搜索", risk: "safe",
      description: "在白名单学术源搜索信息（支持多源: 学术/政策/官方; 返回结果标题+摘要）",
      params: {
        query: { type: "string", required: true, desc: "搜索关键词" },
        source: { type: "string", desc: "搜索源: academic(学术)/policy(政策)/general(通用, 默认academic)" },
        maxResults: { type: "number", desc: "最大结果数(默认5, 上限10)" },
      },
      run: async (a) => {
        const query = String(a.query || "").trim();
        if (!query) return "（query 必填）";
        const source = String(a.source || "academic");
        const maxResults = Math.min(Math.max(Number(a.maxResults) || 5, 1), 10);
        // 学术源白名单（AGENT_NET_WHITELIST 已含部分）: 用通用搜索引擎抓取 + 结果链接白名单校验
        const searchUrl = source === "policy"
          ? `https://www.gov.cn/search/zhengce/?q=${encodeURIComponent(query)}`
          : `https://cn.bing.com/search?q=${encodeURIComponent(query + (source === "academic" ? " 论文 研究" : ""))}`;
        const net = checkNetworkAccess(searchUrl);
        if (!net.allowed) return `（搜索被拦截: ${net.reason}）`;
        try {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const fs = await import("node:fs");
          const os = await import("node:os");
          const path = await import("node:path");
          const execFileAsync = promisify(execFile);
          const tmpDir = path.join(os.tmpdir(), "sag-search");
          fs.mkdirSync(tmpDir, { recursive: true });
          const outFile = path.join(tmpDir, `search-${Date.now()}.html`);
          const edge = edgePath;
          try {
            await execFileAsync(edge, [
              "--headless", "--disable-gpu", "--dump-dom",
              "--virtual-time-budget=4000",
              `--user-data-dir=${path.join(tmpDir, "profile")}`,
              searchUrl,
            ], { timeout: 45000, maxBuffer: 20 * 1024 * 1024, windowsHide: true })
              .then(({ stdout }) => fs.writeFileSync(outFile, stdout, "utf8"))
              .catch((e) => fs.writeFileSync(outFile, String(e?.stdout || e?.stderr || e), "utf8"));
          } catch { /* Edge 不可用 → 用 fetch 兜底 */ }
          const html = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
          if (!html) {
            const resp = await fetch(searchUrl, { signal: (AbortSignal as any).timeout(15000) });
            if (!resp.ok) return `（搜索失败: HTTP ${resp.status}）`;
            const text = (await resp.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            return `【搜索】${query}\n${text.slice(0, 2000)}`;
          }
          // 提取搜索结果（bing: <li class="b_algo"> 块; gov: 链接列表）
          const results: string[] = [];
          const algoBlocks = html.split(/<li[^>]*class="[^"]*b_algo[^"]*"/i).slice(1);
          for (const block of algoBlocks.slice(0, maxResults)) {
            const title = (block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || "";
            const urlMatch = (block.match(/<a[^>]*href="([^"]+)"/i) || [])[1] || "";
            const snippet = (block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "";
            const clean = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
            if (clean(title)) results.push(`- ${clean(title).slice(0, 80)}\n  ${urlMatch.slice(0, 100)}\n  ${clean(snippet).slice(0, 120)}`);
          }
          if (results.length === 0) {
            // 兜底: 提取所有链接+文本
            const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            return `【搜索】${query}（未解析出结构化结果）\n${text.slice(0, 1500)}`;
          }
          return `【搜索】${query}（${source}）\n${results.join("\n")}`;
        } catch (e: any) {
          return `（搜索异常: ${String(e?.message || e).slice(0, 200)}）`;
        }
      },
    },
    // 差距E①(Codex apply_patch): 精确补丁修改文件 — 只改差异行, 不整体覆盖
    {
      name: "apply_patch", label: "精确补丁", risk: "review",
      description: "按 Codex apply_patch 格式精确修改 agent_workspace 内文件（@@ 定位, 只改差异行; 需人工审批）",
      params: {
        patch: { type: "string", required: true, desc: "补丁内容: *** Begin Patch\n@@ file.md\n-旧行\n+新行\n 上下文行\n*** End Patch" },
      },
      run: async (a) => {
        try {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const workspace = path.join(process.env.SAG_ROOT || path.resolve(process.cwd()), "data", "agent_workspace");
          const patch = String(a.patch || "");
          // 解析补丁: 按 @@ 分割块; 跳过 *** Begin Patch 头（无 @@ 前缀）
          const rawBlocks = patch.split(/@@\s+/).filter((b) => b.trim() && !b.trim().startsWith("*** Begin Patch"));
          if (rawBlocks.length === 0) return "（补丁格式错误: 缺少 @@ 文件定位块）";
          const applied: string[] = [];
          for (const raw of rawBlocks) {
            const lines = raw.split("\n");
            // 文件行: 第一个非空行（可能带 + 前缀）
            const fileRel = lines[0].trim().replace(/^\+/, "");
            const filePath = path.resolve(workspace, fileRel);
            // 边界校验
            if (!(filePath === workspace || filePath.startsWith(workspace + path.sep))) {
              return `（路径越界: ${fileRel}）`;
            }
            if (!fs.existsSync(filePath)) return `（文件不存在: ${fileRel}）`;
            const content = fs.readFileSync(filePath, "utf8");
            const contentLines = content.split("\n");
            // 收集 hunks: - 行(删除) / + 行(新增) / 空格(上下文)
            const hunks: Array<{ oldLines: string[]; newLines: string[]; contextBefore: string[]; contextAfter: string[] }> = [];
            let cur: { oldLines: string[]; newLines: string[]; contextBefore: string[]; contextAfter: string[] } | null = null;
            for (const l of lines.slice(1)) {
              if (l.startsWith("-")) {
                if (!cur) cur = { oldLines: [], newLines: [], contextBefore: [], contextAfter: [] };
                cur.oldLines.push(l.slice(1));
              } else if (l.startsWith("+")) {
                if (!cur) cur = { oldLines: [], newLines: [], contextBefore: [], contextAfter: [] };
                cur.newLines.push(l.slice(1));
              } else if (l.startsWith(" ")) {
                if (cur) cur.contextAfter.push(l.slice(1));
                else if (hunks.length > 0) hunks[hunks.length - 1].contextAfter.push(l.slice(1));
              }
            }
            if (cur) hunks.push(cur);
            // 应用 hunks（从后往前找匹配, 防行号偏移）
            let result = contentLines;
            for (const hunk of hunks) {
              if (hunk.oldLines.length === 0) {
                // 纯新增: 在文件尾追加
                result = [...result, ...hunk.newLines];
                continue;
              }
              // 找匹配位置（允许中间有上下文）
              let matchIdx = -1;
              for (let i = 0; i <= result.length - hunk.oldLines.length; i++) {
                let ok = true;
                for (let j = 0; j < hunk.oldLines.length; j++) {
                  if (result[i + j] !== hunk.oldLines[j]) { ok = false; break; }
                }
                if (ok) { matchIdx = i; break; }
              }
              if (matchIdx < 0) return `（补丁未匹配: 文件 ${fileRel} 找不到目标行）`;
              result = [
                ...result.slice(0, matchIdx),
                ...hunk.newLines,
                ...result.slice(matchIdx + hunk.oldLines.length),
              ];
            }
            fs.writeFileSync(filePath, result.join("\n"), "utf8");
            applied.push(`${fileRel} (${hunks.length} 个 hunk)`);
          }
          return `✅ 补丁已应用: ${applied.join(", ")}`;
        } catch (e: any) {
          return `（补丁应用异常: ${String(e?.message || e).slice(0, 200)}）`;
        }
      },
    },
    // 差距E②(DSH todo包): 待办列表 — 任务执行中维护 todo 清单（写 agent_workspace/todo.md）
    {
      name: "todo_update", label: "待办管理", risk: "safe",
      description: "维护当前任务的待办清单（agent_workspace/todo.md: 待办/进行中/完成）",
      params: {
        action: { type: "string", required: true, desc: "add(添加)/done(完成)/list(查看)" },
        item: { type: "string", desc: "待办内容(action=add/done 时必填)" },
      },
      run: async (a) => {
        try {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const workspace = path.join(process.env.SAG_ROOT || path.resolve(process.cwd()), "data", "agent_workspace");
          fs.mkdirSync(workspace, { recursive: true });
          const todoPath = path.join(workspace, "todo.md");
          const action = String(a.action || "list");
          const item = String(a.item || "").trim();
          // 读现有 todo
          const existing = fs.existsSync(todoPath) ? fs.readFileSync(todoPath, "utf8") : "# Agent 待办清单\n\n## 待办\n\n## 进行中\n\n## 已完成\n";
          const parseSections = (content: string): Record<string, string[]> => {
            const out: Record<string, string[]> = {};
            let cur = "";
            for (const l of content.split("\n")) {
              const m = l.match(/^##\s*(.+)$/);
              if (m) { cur = m[1].trim(); out[cur] = out[cur] || []; }
              else if (cur && l.trim().startsWith("- ")) out[cur].push(l.trim().slice(2));
            }
            return out;
          };
          if (action === "add") {
            if (!item) return "（item 必填）";
            const sections = parseSections(existing);
            sections["待办"] = sections["待办"] || [];
            sections["待办"].push(item);
            const rebuilt = ["# Agent 待办清单", "", "## 待办", ...(sections["待办"] || []).map((s) => `- ${s}`), "", "## 进行中", ...(sections["进行中"] || []).map((s) => `- ${s}`), "", "## 已完成", ...(sections["已完成"] || []).map((s) => `- ${s}`), ""].join("\n");
            fs.writeFileSync(todoPath, rebuilt, "utf8");
            return `✅ 已添加待办: ${item}（共 ${(sections["待办"] || []).length + 1} 个待办）`;
          }
          if (action === "done") {
            if (!item) return "（item 必填）";
            const sections = parseSections(existing);
            let found = false;
            for (const sec of ["待办", "进行中"]) {
              const idx = (sections[sec] || []).findIndex((s) => s.includes(item));
              if (idx >= 0) {
                sections[sec].splice(idx, 1);
                sections["已完成"] = sections["已完成"] || [];
                sections["已完成"].push(item);
                found = true;
                break;
              }
            }
            if (!found) return `（未找到待办: ${item}）`;
            const rebuilt = ["# Agent 待办清单", "", "## 待办", ...(sections["待办"] || []).map((s) => `- ${s}`), "", "## 进行中", ...(sections["进行中"] || []).map((s) => `- ${s}`), "", "## 已完成", ...(sections["已完成"] || []).map((s) => `- ${s}`), ""].join("\n");
            fs.writeFileSync(todoPath, rebuilt, "utf8");
            return `✅ 已完成: ${item}`;
          }
          // list
          const sections = parseSections(existing);
          const parts: string[] = [];
          for (const [sec, items] of Object.entries(sections)) {
            if (items.length > 0) parts.push(`【${sec}】${items.length} 项\n${items.map((s) => `- ${s}`).join("\n")}`);
          }
          return parts.join("\n\n") || "（待办清单为空）";
        } catch (e: any) {
          return `（待办操作异常: ${String(e?.message || e).slice(0, 200)}）`;
        }
      },
    },
    // 差距G②(DSH attachment): 附件读取 — 图片(调LLM视觉描述)/文本文件(直接读)
    {
      name: "attachment_read", label: "附件读取", risk: "safe",
      description: "读取 agent_workspace 内附件: 图片(LLM 视觉描述)/文本/数据文件",
      params: {
        path: { type: "string", required: true, desc: "相对路径（agent_workspace 内）" },
        maxChars: { type: "number", desc: "文本最大读取字符数(默认4000)" },
      },
      run: async (a) => {
        try {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const workspace = path.join(process.env.SAG_ROOT || path.resolve(process.cwd()), "data", "agent_workspace");
          const rel = String(a.path || "").replace(/^[/\\]+/, "");
          const target = path.resolve(workspace, rel);
          if (!(target === workspace || target.startsWith(workspace + path.sep))) {
            return `（路径越界: ${rel}）`;
          }
          if (!fs.existsSync(target)) return "（文件不存在）";
          const ext = path.extname(target).toLowerCase();
          // 图片 → LLM 视觉描述（走多模态 API）
          if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)) {
            const base64 = fs.readFileSync(target).toString("base64");
            const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
            try {
              const { callLlm } = await import("../ai/llm-common.js");
              const { agentModelRouter } = await import("./agent-model-router.js");
              const r = await callLlm({
                model: agentModelRouter.routeAgentModel("summarize", "图片描述"),
                agentContext: { action: "agent_tool_attachment" },
                messages: [{
                  role: "user",
                  content: [
                    { type: "text", text: "请描述这张图片的关键内容（研究相关: 图表/公式/文本截图）:" },
                    { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
                  ] as any,
                }],
                maxTokens: 500,
              });
              return `【图片附件】${rel}\n${r?.text || "（图片描述失败）"}`;
            } catch (e: any) {
              return `（图片描述失败: ${String(e?.message || e).slice(0, 120)} — 图片 ${rel} 已存在, 可手动查看）`;
            }
          }
          // 文本/数据文件 → 直接读
          const content = fs.readFileSync(target, "utf8");
          const maxChars = Math.min(Math.max(Number(a.maxChars) || 4000, 100), 20000);
          return `【附件】${rel} (${content.length} 字符)\n${content.slice(0, maxChars)}`;
        } catch (e: any) {
          return `（附件读取异常: ${String(e?.message || e).slice(0, 200)}）`;
        }
      },
    },
    // 差距H④(DSH terminal): 终端命令执行 — 沙箱内 shell（受限: 黑名单+凭证隔离+超时）
    {
      name: "run_command", label: "终端命令", risk: "review",
      description: "在隔离沙箱中执行终端命令（受限目录+危险命令黑名单; 需人工审批）",
      params: {
        command: { type: "string", required: true, desc: "要执行的命令（如: dir / ls / python script.py）" },
        timeoutMs: { type: "number", desc: "超时(毫秒, 默认15000, 上限60000)" },
      },
      run: async (a) => {
        let command = String(a.command || "").trim();
        if (!command) return "（command 必填）";
        // 差距Q②(Codex command_canonicalization): 命令规范化 — 别名/冗余参数归一
        // Windows 下 dir/type 等别名映射; 去除多余空格/结尾分号
        const isWin = process.platform === "win32";
        if (isWin) {
          command = command
            .replace(/^ls\s+/, "dir ")
            .replace(/^cat\s+/, "type ")
            .replace(/^pwd\s*$/, "cd")
            .replace(/^clear\s*$/, "cls");
        }
        command = command.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
        // 危险命令黑名单（复用 code-sandbox 的）
        const DANGEROUS = [
          /rm\s+-rf|del\s+\/s|format\s|shutdown|reboot/i,
          /\.env|password|secret|api[_-]?key/i,
          /chmod|chown|mkfs|fdisk/i,
          /socket|listen\(|bind\(/i,
        ];
        for (const re of DANGEROUS) {
          if (re.test(command)) return `（命令含危险操作, 已拦截: ${command.slice(0, 40)}）`;
        }
        try {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const os = await import("node:os");
          const path = await import("node:path");
          const execFileAsync = promisify(execFile);
          // Windows 用 cmd /c, 其他用 sh -c
          const isWin = process.platform === "win32";
          const shell = isWin ? "cmd.exe" : "sh";
          const args = isWin ? ["/c", command] : ["-c", command];
          const timeout = Math.min(Math.max(Number(a.timeoutMs) || 15000, 1000), 60000);
          const sandboxDir = path.join(os.tmpdir(), "sag-command");
          const fs = await import("node:fs");
          fs.mkdirSync(sandboxDir, { recursive: true });
          const { stdout, stderr } = await execFileAsync(shell, args, {
            timeout,
            maxBuffer: 1024 * 1024,
            cwd: sandboxDir,
            // 凭证隔离（同 code-sandbox）
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(([k]) => !/(?:API_KEY|DASHSCOPE|DEEPSEEK|EMBEDDING|TOKEN|SECRET|PASSWORD)/i.test(k))
              ),
              SAG_SANDBOX: "1",
            },
            windowsHide: true,
          });
          const parts: string[] = [`【终端】${command.slice(0, 60)} (${timeout / 1000}s 上限)`];
          if (stdout) parts.push(stdout.slice(0, 3000));
          if (stderr) parts.push(`stderr: ${stderr.slice(0, 1000)}`);
          if (!stdout && !stderr) parts.push("（无输出）");
          return parts.join("\n");
        } catch (e: any) {
          return `（命令执行失败: ${String(e?.message || e).slice(0, 200)}）`;
        }
      },
    },
    // 差距I①: 代码搜索 — 搜项目源码/文档（read-only, 白名单根目录）
    {
      name: "code_search", label: "代码搜索", risk: "safe",
      description: "在项目源码中搜索关键词（文件内容/文件名, 只读; 返回文件+行号+上下文）",
      params: {
        query: { type: "string", required: true, desc: "搜索关键词（支持正则）" },
        filePattern: { type: "string", desc: "文件过滤(如 *.ts / *.md)" },
        maxResults: { type: "number", desc: "最大结果数(默认10, 上限30)" },
      },
      run: async (a) => {
        try {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const { fileURLToPath } = await import("node:url");
          const root = process.env.SAG_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
          const query = String(a.query || "").trim();
          if (!query) return "（query 必填）";
          let re: RegExp;
          try { re = new RegExp(query, "i"); } catch { re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
          const pattern = String(a.filePattern || "");
          const maxResults = Math.min(Math.max(Number(a.maxResults) || 10, 1), 30);
          const EXCLUDE_DIRS = new Set(["node_modules", "dist", ".git", ".claude", "vendor", "recovery", "data"]);
          const results: string[] = [];
          const walk = (dir: string, depth: number) => {
            if (depth > 4 || results.length >= maxResults * 3) return;
            let entries: Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const f of entries) {
              if (EXCLUDE_DIRS.has(f.name)) continue;
              const p = path.join(dir, f.name);
              if (f.isDirectory()) { walk(p, depth + 1); continue; }
              if (pattern && !f.name.endsWith(pattern.replace("*", ""))) continue;
              if (!/\.(ts|tsx|js|jsx|md|json|sql|py|css|html)$/.test(f.name)) continue;
              try {
                const content = fs.readFileSync(p, "utf8");
                const lines = content.split("\n");
                for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                  if (re.test(lines[i])) {
                    const rel = path.relative(root, p);
                    results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 100)}`);
                  }
                }
              } catch { /* 二进制/大文件跳过 */ }
            }
          };
          walk(root, 0);
          if (results.length === 0) return `（未找到匹配: ${query}）`;
          return `【代码搜索】${results.length} 处匹配\n${results.join("\n")}`;
        } catch (e: any) {
          return `（搜索异常: ${String(e?.message || e).slice(0, 200)}）`;
        }
      },
    },
    // 架构B: GitHub 工具 — 读仓库信息/issue（OAuth token 鉴权; 未授权提示）
    {
      name: "github_repo", label: "GitHub仓库", risk: "safe",
      description: "读取 GitHub 仓库信息/README/issue（需 OAuth 授权; AGENT_GITHUB_CLIENT_ID 配置）",
      params: {
        repo: { type: "string", required: true, desc: "仓库名 owner/repo" },
        action: { type: "string", desc: "readme(默认)/info/issue" },
      },
      run: async (a) => {
        try {
          const { agentOAuthService } = await import("./agent-oauth.js");
          const tok = await agentOAuthService.getOAuthToken("github");
          if (!tok) {
            return "（GitHub 未授权 — 请先配置 AGENT_GITHUB_CLIENT_ID/SECRET 并访问 /api/agent/oauth/github/start 完成授权）";
          }
          const repo = String(a.repo || "").trim();
          if (!repo || !repo.includes("/")) return "（repo 需为 owner/repo 格式）";
          const action = String(a.action || "readme");
          const url = action === "info"
            ? `https://api.github.com/repos/${repo}`
            : action === "issue"
              ? `https://api.github.com/repos/${repo}/issues?state=open&per_page=5`
              : `https://api.github.com/repos/${repo}/readme`;
          const res = await fetch(url, { headers: { Authorization: `Bearer ${tok.accessToken}`, Accept: "application/vnd.github+json" } });
          if (res.status === 401) return "（token 失效 — 请重新授权）";
          if (res.status === 404) return `（仓库不存在: ${repo}）`;
          const data: any = await res.json();
          if (action === "info") {
            return `【GitHub】${data.full_name}\n⭐ ${data.stargazers_count} · 🍴 ${data.forks_count} · 语言 ${data.language || "-"}\n${(data.description || "").slice(0, 150)}`;
          }
          if (action === "issue") {
            const issues = Array.isArray(data) ? data.slice(0, 5) : [];
            if (issues.length === 0) return "（无 open issue）";
            return `【GitHub Issues】${repo}\n${issues.map((i: any) => `- #${i.number} ${i.title}`).join("\n")}`;
          }
          // readme: base64 解码
          const content = data?.content ? Buffer.from(data.content, "base64").toString("utf8") : "（无 README）";
          return `【GitHub README】${repo}\n${content.slice(0, 2000)}`;
        } catch (e: any) {
          return `（GitHub 查询异常: ${String(e?.message || e).slice(0, 150)}）`;
        }
      },
    },
    // 架构C1: 图片理解管线 — OCR文本提取 + 图表数据结构化（多模态LLM）
    {
      name: "image_analyze", label: "图片理解", risk: "safe",
      description: "深度分析图片: OCR提取文本 + 图表数据→结构化JSON（论文图表/手稿/截图）",
      params: {
        path: { type: "string", required: true, desc: "图片相对路径（agent_workspace 内）" },
        mode: { type: "string", desc: "ocr(文本提取)/chart(图表数据JSON)/describe(综合描述, 默认)" },
      },
      run: async (a) => analyzeImageAtPath(String(a.path || ""), String(a.mode || "describe")),
    },
    // wisp借鉴1: 持久运行时 — Python 子进程常驻, 变量跨调用保持（重计算只需一次载入）
    {
      name: "runtime_exec", label: "持久Python", risk: "safe",
      description: "在持久 Python 会话中执行代码 — 变量跨调用保持（载入数据/模型一次, 后续复用）",
      params: {
        code: { type: "string", required: true, desc: "要执行的代码（与上次调用共享变量）" },
        session: { type: "string", desc: "会话名(默认default; 同名会话共享变量)" },
        reset: { type: "boolean", desc: "true=重置会话(关闭重建)" },
      },
      run: async (a) => {
        const sessionKey = String(a.session || "default");
        // 会话缓存: 同名会话复用（变量跨调用保持）
        const { createPersistentRuntime, closeSession } = await import("./agent-persistent-runtime.js");
        const { agentPersistentRuntime } = await import("./agent-persistent-runtime.js");
        // 重置 → 关闭全部会话
        if (a.reset === true) {
          for (const s of agentPersistentRuntime.persistentRuntimeStatus()) closeSession(s.sessionId);
          runtimeSessions.clear();
          return "✅ 持久运行时已重置";
        }
        // 复用缓存会话
        let rt = runtimeSessions.get(sessionKey);
        if (!rt || !rt.alive()) {
          const created = createPersistentRuntime(sessionKey);
          if (!created) return "（持久运行时创建失败）";
          rt = { ...created, alive: () => true };
          runtimeSessions.set(sessionKey, rt);
        }
        try {
          const r = await rt.exec(String(a.code || ""), 60000);
          const parts: string[] = [`【持久Python·${sessionKey}】${r.ok ? "✓" : "✗"}`];
          if (r.stdout) parts.push(r.stdout.slice(0, 3000));
          if (r.error) parts.push(`错误: ${r.error}`);
          if (!r.stdout && !r.error) parts.push("（无输出, 变量已保留供下次调用）");
          return parts.join("\n");
        } catch (e: any) {
          // 会话崩溃 → 移除缓存, 下次重建
          runtimeSessions.delete(sessionKey);
          return `（持久运行时执行失败: ${String(e?.message || e).slice(0, 150)}）`;
        }
      },
    },
    // 批次5(C2): 音频转写 — whisper 沙箱转写（不可用则 ffprobe 元数据 + 安装指引）
    {
      name: "audio_transcribe", label: "音频转写", risk: "safe",
      description: "转写音频为文本（whisper 沙箱; 本地不可用时提示安装并提供文件元数据）",
      params: {
        path: { type: "string", required: true, desc: "音频相对路径（agent_workspace 内, mp3/wav/m4a）" },
        language: { type: "string", desc: "语言(zh/en, 默认自动检测)" },
      },
      run: async (a) => {
        try {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const workspace = path.join(process.env.SAG_ROOT || path.resolve(process.cwd()), "data", "agent_workspace");
          const rel = String(a.path || "").replace(/^[/\\]+/, "");
          const target = path.resolve(workspace, rel);
          if (!(target === workspace || target.startsWith(workspace + path.sep))) return `（路径越界: ${rel}）`;
          if (!fs.existsSync(target)) return "（文件不存在）";
          const ext = path.extname(target).toLowerCase();
          const AUDIO = [".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac"];
          if (!AUDIO.includes(ext)) return `（非音频文件: ${ext}）`;
          const sizeKB = Math.round(fs.statSync(target).size / 1024);
          // 检测 whisper 可用性（沙箱内 python）
          const { executeCode } = await import("./code-sandbox-service.js");
          const probe = await executeCode({
            language: "python",
            code: "import importlib.util; print('ok' if importlib.util.find_spec('whisper') or importlib.util.find_spec('faster_whisper') else 'none')",
            timeoutMs: 15000,
          });
          if (!probe.stdout?.includes("ok")) {
            // whisper 不可用 → ffprobe 元数据 + 安装指引
            const meta = await ffprobeMeta(target);
            return `（本地 whisper 未安装 — 转写不可用）\n【文件】${rel} ${sizeKB}KB\n${meta}\n💡 安装指引: pip install faster-whisper（或配置 AGENT_WHISPER_API_KEY 走云端 API）`;
          }
          // whisper 可用 → 沙箱转写
          const lang = String(a.language || "");
          const code = [
            "import sys",
            "try:",
            "  from faster_whisper import WhisperModel",
            "  model = WhisperModel('base', device='cpu', compute_type='int8')",
            "  segs, _ = model.transcribe(sys.argv[1], language=" + (lang ? `'${lang}'` : "None") + ")",
            "  print(''.join(s.text for s in segs))",
            "except ImportError:",
            "  import whisper",
            "  m = whisper.load_model('base')",
            "  r = m.transcribe(sys.argv[1]" + (lang ? `, language='${lang}'` : "") + ")",
            "  print(r['text'])",
          ].join("\n");
          // 沙箱 cwd 是隔离目录, 需把音频复制进去
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const os = await import("node:os");
          const execFileAsync = promisify(execFile);
          const sandboxDir = path.join(os.tmpdir(), "sag-audio");
          fs.mkdirSync(sandboxDir, { recursive: true });
          const copyTarget = path.join(sandboxDir, "audio" + ext);
          fs.copyFileSync(target, copyTarget);
          const PYTHON = process.env.COGNEE_PYTHON || "";
          try {
            const { stdout } = await execFileAsync(PYTHON, ["-c", code, copyTarget], { timeout: 300000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
            return `【音频转写】${rel} (${sizeKB}KB)\n${(stdout || "").trim().slice(0, 3000)}`;
          } catch (e: any) {
            return `（转写失败: ${String(e?.message || e).slice(0, 200)}）`;
          } finally {
            try { fs.rmSync(copyTarget, { force: true }); } catch { /* ignore */ }
          }
        } catch (e: any) {
          return `（音频处理异常: ${String(e?.message || e).slice(0, 150)}）`;
        }
      },
    },
    // P1-2: 网页抓取工具 — Edge headless 白名单抓取（复用 AGENT_NET_WHITELIST 校验）
    {
      name: "web_fetch", label: "网页抓取", risk: "safe",
      description: "用 Edge headless 抓取网页可见文本（仅白名单域名, 学术源/官方源）",
      params: { url: { type: "string", required: true, desc: "要抓取的 URL" }, maxChars: { type: "number", desc: "最大返回字符数(默认3000)" } },
      run: async (a) => {
        const url = String(a.url || "");
        const net = checkNetworkAccess(url);
        if (!net.allowed) return `（网页抓取被拦截: ${net.reason}）`;
        try {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const fs = await import("node:fs");
          const os = await import("node:os");
          const path = await import("node:path");
          const execFileAsync = promisify(execFile);
          const tmpDir = path.join(os.tmpdir(), "sag-browse");
          fs.mkdirSync(tmpDir, { recursive: true });
          const outFile = path.join(tmpDir, `page-${Date.now()}.html`);
          const edge = edgePath;
          try {
            await execFileAsync(edge, [
              "--headless", "--disable-gpu", "--dump-dom",
              "--virtual-time-budget=3000",
              `--user-data-dir=${path.join(tmpDir, "profile")}`,
              url,
            ], { timeout: 45000, maxBuffer: 20 * 1024 * 1024, windowsHide: true })
              .then(({ stdout }) => fs.writeFileSync(outFile, stdout, "utf8"))
              .catch((e) => fs.writeFileSync(outFile, String(e?.stdout || e?.stderr || e), "utf8"));
          } catch { /* Edge 不可用则用 node fetch 兜底 */ }
          const html = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
          if (!html) {
            // 兜底: 直接 fetch（白名单已校验）
            const resp = await fetch(url, { signal: (AbortSignal as any).timeout(15000) });
            if (!resp.ok) return `（网页抓取失败: HTTP ${resp.status}）`;
            return (await resp.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
          }
          const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, Math.min(Number(a.maxChars) || 3000, 8000));
          const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
          return title ? `【网页】${title}\n${text}` : text || "（网页无文本内容）";
        } catch (e: any) {
          return `（网页抓取异常: ${String(e?.message || e).slice(0, 200)}）`;
        }
      },
    },
    // P1-2: 沙箱文件工具 — 受限目录内读写（agent_workspace 固定根）
    // 拆两工具: file_read 只读直接执行; file_write 写/删需人工审批（risk=review 由 executeAgentTool 前置拦截）
    {
      name: "file_read", label: "文件读取", risk: "safe",
      description: "读取受限工作目录内的文件（data/agent_workspace）",
      params: {
        path: { type: "string", required: true, desc: "相对路径（agent_workspace 内, 如 research/note.md）" },
        op: { type: "string", desc: "read(默认) 或 list(列目录)" },
      },
      run: async (a) => {
        try {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const workspace = path.join(process.env.SAG_ROOT || path.resolve(process.cwd()), "data", "agent_workspace");
          const rel = String(a.path || "").replace(/^[/\\]+/, "");
          const target = path.resolve(workspace, rel);
          if (!(target === workspace || target.startsWith(workspace + path.sep))) {
            return `（路径越界: ${rel} 超出 agent_workspace）`;
          }
          const op = String(a.op || "read");
          if (op === "list") {
            const files: string[] = [];
            const walk = (dir: string, depth: number) => {
              if (depth > 3) return;
              for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, f.name);
                if (f.isDirectory()) walk(p, depth + 1);
                else files.push(path.relative(workspace, p));
              }
            };
            if (fs.existsSync(workspace)) walk(workspace, 0);
            return `【工作目录】${files.length} 个文件\n${files.slice(0, 50).join("\n") || "（空）"}`;
          }
          if (!fs.existsSync(target)) return "（文件不存在）";
          const content = fs.readFileSync(target, "utf8");
          return `【文件】${rel} (${content.length} 字符)\n${content.slice(0, 4000)}`;
        } catch (e: any) {
          return `（文件读取异常: ${String(e?.message || e).slice(0, 200)}）`;
        }
      },
    },
    {
      name: "file_write", label: "文件写入", risk: "review",
      description: "写入/删除受限工作目录内的文件（data/agent_workspace; 需人工审批）",
      params: {
        op: { type: "string", required: true, desc: "write(写)/delete(删)" },
        path: { type: "string", required: true, desc: "相对路径（agent_workspace 内）" },
        content: { type: "string", desc: "write 时写入的内容" },
      },
      run: async (a) => {
        try {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const workspace = path.join(process.env.SAG_ROOT || path.resolve(process.cwd()), "data", "agent_workspace");
          fs.mkdirSync(workspace, { recursive: true });
          const rel = String(a.path || "").replace(/^[/\\]+/, "");
          const target = path.resolve(workspace, rel);
          if (!(target === workspace || target.startsWith(workspace + path.sep))) {
            return `（路径越界: ${rel} 超出 agent_workspace）`;
          }
          const op = String(a.op || "write");
          if (op === "write") {
            fs.writeFileSync(target, String(a.content || ""), "utf8");
            return `✅ 已写入 ${rel} (${String(a.content || "").length} 字符)`;
          }
          if (op === "delete") {
            if (fs.existsSync(target)) fs.rmSync(target, { force: true });
            return `✅ 已删除 ${rel}`;
          }
          return "（op 需为 write/delete）";
        } catch (e: any) {
          return `（文件写入异常: ${String(e?.message || e).slice(0, 200)}）`;
        }
      },
    },
    // 用户给数据(rows/columnOrder) + y/x/controls → 真实回归 → 返回系数表
    // 也支持 method="pipeline" 走数据管道（genvars/missing/winsorize/filter/describe）
    {
      name: "empirical_analysis", label: "实证分析", risk: "safe",
      description: "真实执行回归/统计/数据管道分析（Python statsmodels, 返回系数/显著性/诊断）",
      params: {
        method: { type: "string", required: true, desc: "分析类型: regression(回归)/pipeline(数据管道)/describe(描述统计)" },
        data: { type: "string", desc: "数据(JSON: {columnOrder:[列名], rows:[[值...]]}), 回归模式必填" },
        formula: { type: "string", desc: "回归公式(如 'y ~ x1 + x2 + C(group)'), 不填则用 y/x/controls 自动构造" },
        y: { type: "string", desc: "因变量列名" },
        xs: { type: "string", desc: "自变量列名(逗号分隔)" },
        controls: { type: "string", desc: "控制变量列名(逗号分隔)" },
        fe: { type: "string", desc: "固定效应列(逗号分隔, 用 C(列) 语法)" },
        cluster: { type: "string", desc: "聚类稳健标准误列" },
        steps: { type: "string", desc: "管道步骤 JSON(genvars/missing/winsorize/filter/describe)" },
      },
      run: async (a) => {
        try {
          const { runEmpirical, getEmpiricalResult } = await import("./empirical-service.js");
          const method = String(a.method || "regression");
          // 解析数据（agent 给 JSON 字符串）
          let data: { columnOrder: string[]; rows: unknown[][] } | undefined;
          if (a.data) {
            const parsed = JSON.parse(String(a.data));
            if (!Array.isArray(parsed?.columnOrder) || !Array.isArray(parsed?.rows)) {
              return "（数据格式错误: 需 {columnOrder:[列名], rows:[[值]]}）";
            }
            data = { columnOrder: parsed.columnOrder.map(String), rows: parsed.rows };
            if (data.rows.length === 0) return "（数据为空）";
          }
          // 构造 params（回归模式）
          const xs = String(a.xs || "").split(",").map((s) => s.trim()).filter(Boolean);
          const controls = String(a.controls || "").split(",").map((s) => s.trim()).filter(Boolean);
          const fe = String(a.fe || "").split(",").map((s) => s.trim()).filter(Boolean);
          const params: Record<string, unknown> = {};
          if (a.y) params.y = String(a.y).trim();
          if (xs.length > 0) params.xs = xs;
          if (controls.length > 0) params.controls = controls;
          if (fe.length > 0) params.fe = fe;
          if (a.cluster) params.cluster = String(a.cluster).trim();
          if (a.formula) params.formula = String(a.formula);
          if (a.steps) {
            try { params.steps = JSON.parse(String(a.steps)); } catch { return "（steps 参数需为 JSON）"; }
          }
          const input = {
            data: data ?? { columnOrder: [], rows: [] },
            method,
            params,
          };
          if (method !== "pipeline" && !data) return "（回归模式必须提供 data 参数: {columnOrder, rows}）";
          // 提交任务（同步 spawn Python）
          const r = await runEmpirical(input);
          if (!r.ok || !r.taskId) return `（实证分析提交失败: ${r.error || "未知错误"}）`;
          // 轮询结果（Python 运行一般 2-15s）
          for (let i = 0; i < 30; i++) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const res = await getEmpiricalResult(r.taskId);
            if (res.status === "done") {
              const out = res.result as any;
              // 格式化: 系数表/诊断
              const meta = out?.meta ?? {};
              const coeffs = out?.coefficients ?? out?.params ?? out?.coeff ?? [];
              const lines: string[] = [`【实证分析完成】方法: ${method} | 样本: ${meta?.n ?? "?"}`];
              if (Array.isArray(coeffs)) {
                for (const c of coeffs) {
                  if (typeof c === "object" && c !== null) {
                    lines.push(`  ${c.var ?? c.name ?? "?"}: β=${Number(c.coef ?? c.estimate ?? 0).toFixed(4)} (p=${Number(c.pvalue ?? c.p ?? 0).toFixed(3)}${Number(c.pvalue ?? c.p ?? 0) < 0.05 ? "**" : ""})`);
                  } else {
                    lines.push(`  ${String(c)}`);
                  }
                }
              } else if (out?.table) {
                lines.push(`  ${String(out.table).slice(0, 1200)}`);
              }
              if (out?.diagnostics && typeof out.diagnostics === "object") {
                lines.push(`【诊断】${JSON.stringify(out.diagnostics).slice(0, 400)}`);
              }
              if (out?.error) lines.push(`【错误】${String(out.error).slice(0, 200)}`);
              return lines.join("\n");
            }
            if (res.status === "error") {
              return `（实证分析失败: ${String(res.error || "未知错误").slice(0, 400)}）`;
            }
          }
          return "（实证分析超时 30s, 请稍后到实证工作台查看）";
        } catch (e: any) {
          return `（实证分析执行异常: ${String(e?.message || e).slice(0, 200)}）`;
        }
      },
    },
    // V396-6: 质量评审工具（具名 const 以便 usage 自引用）
    // G3: 改走 callLlm(统一重试/退避) — 不再直连 fetch, agentContext 采集 usage 入 exec_logs
    ...(() => {
      const reviewTool: AgentToolDef = {
        name: "review_output", label: "质量评审", risk: "safe",
        description: "评审研究产出质量, 给出问题/建议/评分",
        params: { content: { type: "string", required: true, desc: "待评审内容" } },
        run: async (a) => {
          const r = await callLlm({
            model: agentModelRouter.routeAgentModel("review", String(a.content || "")),
            agentContext: { action: "agent_tool_review", tool: "review_output" },
            messages: [{ role: "user", content: `评审以下研究产出: 1)主要问题 2)修正建议 3)总体评分(0-1)\n${String(a.content).slice(0, 1500)}` }],
            temperature: 0.1, maxTokens: 600,
          });
          // G3: 真实 usage 回填（tool 级成本采集）
          if (r?.tokens) {
            reviewTool.lastUsage = { tokensIn: r.tokens.in, tokensOut: r.tokens.out, costCents: 0 };
          }
          return r?.text || (r?.error ? `（评审失败: ${r.error}）` : "（评审失败）");
        },
      };
      return [reviewTool];
    })(),
    {
      name: "summarize", label: "内容摘要", risk: "safe",
      description: "长文本摘要（上下文压缩/步骤结果精简）",
      params: { text: { type: "string", required: true, desc: "待摘要文本" }, maxLen: { type: "number", desc: "目标字数" } },
      run: async (a) => {
        const dsKey = process.env.DEEPSEEK_API_KEY || "";
        const llmRes = await fetch(
          dsKey ? (process.env.DS_BASE_URL || "https://api.deepseek.com/v1/chat/completions") : "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${dsKey || process.env.LLM_API_KEY}` },
            body: JSON.stringify({
              model: agentModelRouter.routeAgentModel("summarize", String(a.text || "")),
              messages: [{ role: "user", content: `将以下文本压缩为 ${a.maxLen || 200} 字以内的摘要, 保留关键事实/数据/结论:\n${String(a.text).slice(0, 3000)}` }],
              temperature: 0.2, max_tokens: 400,
            }),
          }
        );
        const data: any = await llmRes.json();
        return data?.choices?.[0]?.message?.content || String(a.text).slice(0, 200);
      },
    },
    // V399: 33 视图能力工具化 — 政策库/知识页/图谱/外部学术/技能/资料库/C刊/记忆
    ...(await import("./agent-view-tools.js")).VIEW_TOOLS,
  ];
  // V395-4: 插件体系 — 合并启用插件的额外工具（agent_plugins 表; 失败静默, 不影响主工具）
  if (pdfTool) tools.push(pdfTool);
  try {
    const { collectPluginTools } = await import("./agent-plugin-service.js");
    const pluginTools = await collectPluginTools();
    tools.push(...pluginTools);
  } catch { /* 插件加载失败不影响主工具 */ }
  // 架构A1: 文件目录插件（plugins/ 目录, 热加载）
  try {
    const { collectFilePluginTools } = await import("./agent-file-plugins.js");
    const fileTools = await collectFilePluginTools();
    tools.push(...fileTools);
  } catch { /* 文件插件加载失败不影响主工具 */ }
  // 借鉴1: 注册到工具注册表（Codex registry 模式; 冲突检测防覆盖; 供并行执行/查询用）
  try {
    const { toolRegistry } = await import("./agent-tool-registry.js");
    for (const t of tools) {
      try { toolRegistry.register(t); } catch { /* 已注册跳过（重复 buildAgentTools 幂等） */ }
    }
  } catch { /* registry 不可用不影响工具构建 */ }
  // 差距D(DSH preset): 按当前模式裁剪工具集（如数据分析模式只留分析工具）
  try {
    const { filterToolsByPreset } = await import("./agent-presets.js");
    return filterToolsByPreset(tools) as AgentToolDef[];
  } catch { /* 预设不可用 → 全量工具 */ }
  return tools;
}

/** 危险工具（默认 deny, 需工具级审批开启） */
export const DENY_TOOLS = new Set<string>(["file_delete", "data_purge", "external_publish", "payment"]);

// ═══ V393-4/5: Agent 权限分级 + 工具级审批 ═══
/** Agent 角色: reader(只读) / analyst(分析) / manager(管理/写) */
export type AgentRole = "reader" | "analyst" | "manager";

/** 工具 → 最低所需角色（manager 才能用写/危险类） */
const TOOL_MIN_ROLE: Record<string, AgentRole> = {
  sag_reason: "reader",
  sag_retrieve: "reader",
  llm_write: "analyst",
  concept_trace: "reader",
  policy_search: "reader",
  empirical_analysis: "analyst",
  review_output: "analyst",
  summarize: "reader",
  // P0-2/P1-2: 行动类工具 — 代码执行/文件写操作需 manager; 网页抓取/文件读只读默认放行
  run_code: "manager",
  web_fetch: "reader",
  file_read: "reader",
  file_write: "manager",
  // 借鉴4: 外部 Agent 调用 — 执行外部进程, 需 manager 角色
  agent_subagent: "manager",
  // P1-1: MCP 能力 — 检索/事件只读放行; 入库写操作需 manager
  sag_search: "reader",
  sag_get_event: "reader",
  sag_ingest: "manager",
  // 差距C: web 搜索只读放行
  web_search: "reader",
  // 差距E: 补丁/待办（写操作需 manager）
  apply_patch: "manager",
  todo_update: "analyst",
  // 架构C1: 图片理解只读放行
  image_analyze: "reader",
  // 批次5: 音频转写（只读处理）
  audio_transcribe: "reader",
  // 差距G: 附件读取只读放行
  attachment_read: "reader",
  // wisp借鉴1: 持久运行时（有状态进程, 需 manager）
  runtime_exec: "manager",
  // 架构B: GitHub 只读查询放行（token 来自 OAuth, 不占白名单）
  github_repo: "reader",
  // 差距H: 终端命令需 manager
  run_command: "manager",
  // 差距I: 代码搜索只读放行
  code_search: "reader",
};

/** 工具白名单配置（环境变量 AGENT_TOOL_WHITELIST="tool1,tool2" 覆盖; 空=全部按角色放行） */
export function getToolWhitelist(): Set<string> | null {
  const raw = process.env.AGENT_TOOL_WHITELIST;
  if (!raw) return null;  // 未配置 → 不限制
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

// ═══════════════════════════════════════════════════════════════
// V396-7: 沙箱安全 — 网络出口白名单 + 文件路径边界 + 凭据保护
// ═══════════════════════════════════════════════════════════════

/** 网络出口白名单（AGENT_NET_WHITELIST 覆盖; 默认放行系统 API + LLM 提供方; 空=全部拒绝） */
export function getNetworkWhitelist(): Set<string> {
  const raw = process.env.AGENT_NET_WHITELIST;
  if (raw) return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  // 默认: 系统内部 API + LLM 提供方 + 常见公开学术源 + 搜索引擎（V399: 对话工具循环 web_search 需要）
  return new Set([
    "localhost", "127.0.0.1", "0.0.0.0",
    "api.deepseek.com", "dashscope.aliyuncs.com", "api.openai.com", "api.anthropic.com",
    "weixin.sogou.com", "navi.cnki.net", "crpe.ruc.edu.cn", "www.ddjjyj.com",
    "www.qstheory.cn", "cssn.cn", "www.erj.cn", "www.jjxdt.org",
    "cn.bing.com", "www.bing.com", "bing.com", "www.baidu.com", "baidu.com", "www.sogou.com",
  ]);
}

/** 网络出口校验: 检查 URL 是否在白名单内（防 SSRF: 拦截内网元数据/私有 IP） */
export function checkNetworkAccess(url: string): { allowed: boolean; reason?: string } {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // 拦截私有/环回/元数据地址（除显式允许的 localhost 系统 API）
    const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
      || host === "169.254.169.254"  // 云元数据端点(SSRF 高危)
      || /^127\./.test(host) && host !== "127.0.0.1";
    if (isPrivate) return { allowed: false, reason: `网络出口拦截: ${host} 为私有/元数据地址(防 SSRF)` };
    const whitelist = getNetworkWhitelist();
    // 白名单匹配: 精确 host 或子域(如 api.deepseek.com 允许 *.deepseek.com)
    const allowed = [...whitelist].some((w) => host === w || host.endsWith("." + w));
    if (!allowed) return { allowed: false, reason: `网络出口拦截: ${host} 不在白名单(AGENT_NET_WHITELIST 可配置)` };
    return { allowed: true };
  } catch { return { allowed: false, reason: "URL 解析失败" }; }
}

/** 文件路径边界: 只允许工作目录内的路径（防越权读写宿主文件）
 * G26: cwd 用固定项目根（SAG_ROOT 环境变量或仓库根; 不用 process.cwd() 防沙箱边界漂移）
 * 注意: Windows 下必须用 fileURLToPath（new URL().pathname 返回 /C:/... 形式导致 path.resolve 错乱） */
export function checkPathAccess(p: string): { allowed: boolean; reason?: string } {
  try {
    // G26: 固定项目根 — 优先 SAG_ROOT 环境变量, 否则模块路径推导（src/services/agent-tool-router.js → 仓库根）
    const projectRoot = process.env.SAG_ROOT
      || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const target = path.resolve(p);
    // 允许: 项目根 + 数据/恢复/脚本目录
    const allowedRoots = [projectRoot, path.join(projectRoot, "data"), path.join(projectRoot, "recovery"), path.join(projectRoot, "scripts")];
    const ok = allowedRoots.some((root) => target === root || target.startsWith(root + path.sep));
    if (!ok) return { allowed: false, reason: `文件路径拦截: ${p} 超出工作目录边界(仅允许项目/data/recovery/scripts)` };
    return { allowed: true };
  } catch { return { allowed: false, reason: "路径解析失败" }; }
}

/** 凭据保护: 工具参数/结果中出现的密钥明文打码（防凭据泄漏到日志/上下文） */
export function maskCredentials(text: string): string {
  return String(text || "")
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, "$1****")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1****")
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi, "$1****");
}

/** V393-4: 工具角色授权检查 — 角色不足返回 false */
export function checkToolRole(toolName: string, role: AgentRole): boolean {
  const minRole = TOOL_MIN_ROLE[toolName] ?? "reader";
  const rank: Record<AgentRole, number> = { reader: 0, analyst: 1, manager: 2 };
  return rank[role] >= rank[minRole];
}

/** V393-5: 工具级审批 — 白名单外的 deny 工具拦截; review 工具需审批标记 */
export function checkToolPolicy(
  toolName: string,
  role: AgentRole,
  whitelist?: Set<string> | null
): { allowed: boolean; reason?: string; requiresApproval?: boolean } {
  // 1. 危险工具默认禁止（除非白名单显式开启）
  if (DENY_TOOLS.has(toolName)) {
    if (whitelist && whitelist.has(toolName)) {
      return { allowed: true, requiresApproval: true };  // 白名单开启 → 需审批
    }
    return { allowed: false, reason: `工具 ${toolName} 被安全策略禁止（AGENT_TOOL_WHITELIST 可开启）` };
  }
  // 2. 白名单模式: 配置了白名单则只允许白名单内工具
  if (whitelist && !whitelist.has(toolName)) {
    return { allowed: false, reason: `工具 ${toolName} 不在白名单（AGENT_TOOL_WHITELIST）` };
  }
  // 3. 角色授权
  if (!checkToolRole(toolName, role)) {
    return { allowed: false, reason: `工具 ${toolName} 需要 ${TOOL_MIN_ROLE[toolName]} 角色（当前 ${role}）` };
  }
  return { allowed: true };
}

/**
 * V393-4/5: 执行工具（含角色+白名单+风险校验）
 * @param role Agent 角色（reader/analyst/manager）
 */
/** 差距M②: 工具结果缓存 — 只读工具同参数命中缓存（LRU, 默认 50 条, TTL 5 分钟） */
const toolResultCache = new Map<string, { result: string; ts: number }>();
/** wisp借鉴1: 持久运行时会话缓存（同名会话复用, 变量跨调用保持） */
const runtimeSessions = new Map<string, { sessionId: string; exec: (code: string, timeoutMs?: number) => Promise<any>; close: () => void; alive: () => boolean }>();
const TOOL_CACHE_MAX = 50;
const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;
/** 可缓存工具（只读无副作用） */
const CACHEABLE_TOOLS = new Set(["sag_retrieve", "sag_search", "sag_get_event", "concept_trace", "policy_search", "summarize", "file_read", "code_search", "web_search", "web_fetch"]);

function toolCacheKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}:${JSON.stringify(args).slice(0, 300)}`;
}

function toolCacheGet(toolName: string, args: Record<string, unknown>): string | null {
  if (!CACHEABLE_TOOLS.has(toolName)) return null;
  const key = toolCacheKey(toolName, args);
  const hit = toolResultCache.get(key);
  if (hit && Date.now() - hit.ts < TOOL_CACHE_TTL_MS) {
    console.log(`[agent] 差距M② 工具缓存命中: ${toolName}`);
    return hit.result;
  }
  if (hit) toolResultCache.delete(key);
  return null;
}

function toolCacheSet(toolName: string, args: Record<string, unknown>, result: string): void {
  if (!CACHEABLE_TOOLS.has(toolName)) return;
  const key = toolCacheKey(toolName, args);
  toolResultCache.set(key, { result, ts: Date.now() });
  if (toolResultCache.size > TOOL_CACHE_MAX) {
    const oldest = toolResultCache.keys().next().value;
    if (oldest) toolResultCache.delete(oldest);
  }
}

/** 批次5: ffprobe 元数据（音频时长/码率; 不可用返回提示） */
async function ffprobeMeta(filePath: string): Promise<string> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", filePath], { timeout: 10000, windowsHide: true });
    const j = JSON.parse(stdout);
    const fmt = j?.format || {};
    const durSec = Number(fmt.duration || 0);
    return `时长 ${Math.round(durSec)}s · 码率 ${Math.round(Number(fmt.bit_rate || 0) / 1000)}kbps · 格式 ${fmt.format_name || "?"}`;
  } catch {
    return "（ffprobe 不可用 — 安装 ffmpeg 后可显示时长信息）";
  }
}

/**
 * V398: 图片理解（AI 对话页多模态复用）— 主进程直调 callLlm，不经 MCP stdio runner。
 * path 为相对路径（data/agent_workspace 内），与 image_analyze 工具同一实现。
 */
export async function analyzeImageAtPath(relPath: string, mode = "describe"): Promise<string> {
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const workspace = path.join(process.env.SAG_ROOT || path.resolve(process.cwd()), "data", "agent_workspace");
    const rel = String(relPath || "").replace(/^[/\\]+/, "");
    const target = path.resolve(workspace, rel);
    if (!(target === workspace || target.startsWith(workspace + path.sep))) return `（路径越界: ${rel}）`;
    if (!fs.existsSync(target)) return "（文件不存在）";
    const ext = path.extname(target).toLowerCase();
    const IMAGES = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
    if (!IMAGES.includes(ext)) return `（非图片文件: ${ext || "未知"} — 仅支持 png/jpg/jpeg/gif/webp/bmp）`;
    const sizeKB = Math.round(fs.statSync(target).size / 1024);
    if (sizeKB > 2048) return `（图片 ${sizeKB}KB 过大 — 请压缩至 2MB 内再分析（多模态 token 成本与分辨率成正比））`;
    const base64 = fs.readFileSync(target).toString("base64");
    const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
    const modePrompt: Record<string, string> = {
      ocr: "提取图片中全部可见文字（OCR）, 按阅读顺序输出。如有表格, 用 Markdown 表格呈现。只输出提取的文本。",
      chart: "分析图片中的图表（柱状图/折线图/散点图/表格）: 1) 图表类型 2) 轴含义 3) 数据点提取为结构化 JSON（完整数值）。只输出 JSON: {\"chartType\":\"...\",\"axes\":{...},\"data\":[...],\"insight\":\"...\"}",
      describe: "综合描述图片: 1) 图片类型(图表/文本截图/照片) 2) 关键内容 3) 与研究相关的要点。",
    };
    const { callLlm } = await import("../ai/llm-common.js");
    const { agentModelRouter } = await import("./agent-model-router.js");
    const r = await callLlm({
      model: agentModelRouter.routeAgentModel("summarize", "图片分析"),
      agentContext: { action: "agent_tool_image_analyze" },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: modePrompt[mode] || modePrompt.describe },
          { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
        ] as any,
      }],
      maxTokens: 800,
    });
    return `【图片理解·${mode}】${rel} (${sizeKB}KB)\n${r?.text || "（分析失败）"}`;
  } catch (e: any) {
    return `（图片分析异常: ${String(e?.message || e).slice(0, 150)}）`;
  }
}

export async function executeAgentTool(
  tool: AgentToolDef,
  args: Record<string, unknown>,
  opts?: { role?: AgentRole; whitelist?: Set<string> | null; taskId?: string }  // V396-12: taskId 用于工具生命周期事件
): Promise<{ ok: boolean; result: string; risk: string; requiresApproval?: boolean; denied?: boolean }> {
  const role = opts?.role ?? "manager";  // 默认 manager（兼容旧调用）
  const whitelist = opts?.whitelist !== undefined ? opts.whitelist : getToolWhitelist();
  // 策略检查（危险工具/白名单/角色）
  const policy = checkToolPolicy(tool.name, role, whitelist);
  if (!policy.allowed) {
    return { ok: false, result: policy.reason || "策略拒绝", risk: "deny", denied: true };
  }
  if (tool.risk === "review" || policy.requiresApproval) {
    return { ok: false, result: `工具 ${tool.name} 需要人工审批`, risk: "review", requiresApproval: true };
  }
  // 差距I②(Codex approval modes): 自主级别判定 — suggest 需逐步审批/auto-edit 仅高危/full-auto 全自动
  try {
    const { requiresApprovalByAutonomy, getAutonomyLevel, AUTONOMY_LABELS } = await import("./agent-autonomy.js");
    const minRole = TOOL_MIN_ROLE[tool.name] ?? "reader";
    if (requiresApprovalByAutonomy(tool.risk, minRole, role)) {
      return { ok: false, result: `工具 ${tool.name} 需要审批（当前自主级别: ${AUTONOMY_LABELS[getAutonomyLevel()]}）`, risk: "review", requiresApproval: true };
    }
  } catch { /* 自主级别不可用 → 走原审批逻辑 */ }
  // 借鉴5(Codex Guardian): 策略文件层审查 — 风险等级 × 用户授权度 → 判定
  try {
    const { guardianReview } = await import("./agent-guardian-service.js");
    const g = guardianReview(tool.name, args, "high");  // agent 步骤由任务目标授权 → high
    if (g.verdict === "deny") {
      return { ok: false, result: `Guardian 安全策略拒绝: ${g.reason}`, risk: "deny", denied: true };
    }
    if (g.verdict === "review") {
      return { ok: false, result: `Guardian 安全策略升级审查: ${g.reason}`, risk: "review", requiresApproval: true };
    }
  } catch { /* guardian 不可用 → 原有策略检查已兜底 */ }
  // V396-7: 沙箱执行环境检查 — 网络出口/文件路径/凭据打码
  // 网络类参数: url/link/site/api_url 等 → 白名单校验
  for (const [k, v] of Object.entries(args)) {
    const sv = String(v || "");
    // G26: 值域校验 — 不只按键名, 值内容含 http(s):// 或路径分隔符也触发沙箱检查
    //（防键名伪装: 如 {query: "http://169.254.169.254/..."} 或 {text: "/etc/passwd"}）
    const isUrlValue = /^https?:\/\//i.test(sv);
    const isPathValue = /(^|[\\/])([^\\/]+)[\\/]|^[\\/]|[A-Za-z]:[\\/]/.test(sv) && !isUrlValue;
    if ((/url|link|site|href|endpoint/i.test(k) || isUrlValue) && (sv.startsWith("http") || isUrlValue)) {
      const net = checkNetworkAccess(sv);
      if (!net.allowed) {
        // 差距S①(Codex network_approval): SSRF 高危(私有IP/元数据)直接拒绝; 白名单外普通域名 → 需人工审批
        if (/私有|元数据|SSRF|URL 解析/.test(net.reason || "")) {
          return { ok: false, result: net.reason || "网络拦截", risk: "deny", denied: true };
        }
        return { ok: false, result: `网络审批: ${net.reason} — 白名单外域名需人工确认`, risk: "review", requiresApproval: true };
      }
    }
    if ((/path|file|dir/i.test(k) || isPathValue) && (sv.includes("\\") || sv.includes("/"))) {
      const p = checkPathAccess(sv);
      if (!p.allowed) return { ok: false, result: p.reason || "路径拦截", risk: "deny", denied: true };
    }
  }
  // 凭据打码: 工具输入中的密钥明文 → 打码后再执行
  const safeArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    safeArgs[k] = /key|token|secret|password|auth/i.test(k) ? maskCredentials(String(v)) : v;
  }
  // V396-12: 工具生命周期事件 — tool_start（前端渲染工具卡片）
  const { publishAgentProgress } = await import("./agent-progress.js").catch(() => ({ publishAgentProgress: null as any }));
  if (publishAgentProgress && opts?.taskId) {
    publishAgentProgress({ type: "tool_start", taskId: opts.taskId, data: { tool: tool.name, label: tool.label, args: JSON.stringify(safeArgs).slice(0, 200) } });
  }
  // 差距D(DSH hooks): 工具调用前后钩子
  try {
    const { agentHooks } = await import("./agent-hooks.js");
    void agentHooks.emit("tool_before", { taskId: opts?.taskId, tool: tool.name, args: JSON.stringify(safeArgs).slice(0, 200) });
  } catch { /* 钩子失败不阻塞 */ }
  try {
    const t0 = Date.now();
    // 差距M②: 工具结果缓存 — 只读工具同参数命中直接返回（LRU 50 条, TTL 5 分钟）
    const cached = toolCacheGet(tool.name, safeArgs);
    if (cached !== null) {
      if (publishAgentProgress && opts?.taskId) {
        publishAgentProgress({ type: "tool_complete", taskId: opts.taskId, data: { tool: tool.name, durationMs: 0, resultPreview: cached.slice(0, 80), cached: true } });
      }
      return { ok: true, result: cached, risk: tool.risk, requiresApproval: false };
    }
    // 工具级超时熔断: 默认 90s（覆盖调用方没设超时的工具; AGENT_TOOL_TIMEOUT_MS 可调）
    const TOOL_TIMEOUT_MS = Math.min(Math.max(parseInt(process.env.AGENT_TOOL_TIMEOUT_MS || "90000", 10), 5000), 600000);
    const result = await Promise.race([
      tool.run(safeArgs),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`工具 ${tool.name} 执行超时（>${Math.round(TOOL_TIMEOUT_MS / 1000)}s, AGENT_TOOL_TIMEOUT_MS 可调）`)), TOOL_TIMEOUT_MS)),
    ]);
    // 差距M②: 写缓存
    toolCacheSet(tool.name, safeArgs, result);
    // V396-7: 结果中的凭据也打码（防泄漏到日志/上下文）
    const safeResult = maskCredentials(result);
    // 差距D(DSH hooks): 工具完成钩子
    try {
      const { agentHooks } = await import("./agent-hooks.js");
      void agentHooks.emit("tool_after", { taskId: opts?.taskId, tool: tool.name, ok: true, durationMs: Date.now() - t0 });
    } catch { /* 钩子失败不阻塞 */ }
    // V396-12: tool_complete 事件
    if (publishAgentProgress && opts?.taskId) {
      publishAgentProgress({ type: "tool_complete", taskId: opts.taskId, data: { tool: tool.name, durationMs: Date.now() - t0, resultPreview: safeResult.slice(0, 150) } });
    }
    // V396-6: 真实 token/成本采集（LLM 类工具 usage 回填）
    const usage = tool.lastUsage;
    if (usage && (usage.tokensIn > 0 || usage.tokensOut > 0)) {
      // 按 token 估算成本（¥/1M tokens 近似: 输入 0.5 元, 输出 2 元）
      const costCents = Math.round((usage.tokensIn * 0.5 + usage.tokensOut * 2) / 10000);
      // 记录到 exec_logs（tool 级别真实用量）— G7: taskId 透传, 归因到具体任务
      try {
        const { logAgentExec } = await import("./agent-exec-log.js");
        await logAgentExec({
          taskId: opts?.taskId,
          action: "tool_usage", tool: tool.name,
          inputSummary: `tokens_in=${usage.tokensIn} tokens_out=${usage.tokensOut}`,
          outputSummary: `cost=${costCents}分(真实用量)`,
          tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costCents,
          durationMs: Date.now() - t0, status: "ok", spanType: "LLM",
        });
      } catch { /* usage 记录失败不阻塞 */ }
    }
    return { ok: true, result: safeResult, risk: tool.risk, requiresApproval: false };
  } catch (e: any) {
    // V396-12: tool_error 事件
    if (publishAgentProgress && opts?.taskId) {
      publishAgentProgress({ type: "tool_error", taskId: opts.taskId, data: { tool: tool.name, error: String(e?.message || e).slice(0, 150) } });
    }
    return { ok: false, result: `工具 ${tool.name} 执行失败: ${String(e?.message || e).slice(0, 200)}`, risk: tool.risk };
  }
}

/**
 * V393-1: LLM 动态工具选择 — 给定步骤目标和上下文, LLM 选工具+参数
 * 返回 { tool, args } 或 null（LLM 选择失败时回退类型调度）
 */
export async function chooseToolByLlm(
  goal: string,
  stepTitle: string,
  tools: AgentToolDef[],
  extraContext?: string
): Promise<{ tool: AgentToolDef; args: Record<string, unknown> } | null> {
  const toolList = tools.map((t) => {
    const params = Object.entries(t.params)
      .map(([k, v]) => `${k}${v.required ? "(必填)" : ""}:${v.type} — ${v.desc}`)
      .join("; ");
    return `- ${t.name}: ${t.description} | 参数: ${params}`;
  }).join("\n");
  try {
    const model = resolveModelAlias(getRoleModel("plan"));
    const r = await callLlm({
      model,
      messages: [{
        role: "user",
        content: `你是工具调度器。根据当前任务目标, 从工具清单中选择**最合适的一个工具**并给出参数。
当前步骤: ${stepTitle}
任务目标: ${goal}
${extraContext ? `已有上下文: ${extraContext.slice(0, 300)}\n` : ""}
工具清单:
${toolList}
只返回 JSON: {"tool":"工具名","args":{"参数名":"值"}}
要求: 参数值必须具体（从任务目标中提取, 不要用占位符）; 若任务不需要任何工具, 返回 {"tool":"none","args":{}}`,
      }],
      temperature: 0.1, maxTokens: 300,
    });
    const text = (r?.text ?? "").trim().replace(/```json|```/g, "");
    const parsed = JSON.parse(text);
    if (!parsed.tool || parsed.tool === "none") return null;
    const tool = tools.find((t) => t.name === parsed.tool);
    if (!tool) return null;
    // 参数校验: 必填参数必须有值
    const args: Record<string, unknown> = {};
    for (const [k, def] of Object.entries(tool.params)) {
      const v = parsed.args?.[k];
      if (def.required && (v === undefined || v === null || v === "")) {
        // 必填缺失 → 用步骤 query/title 兜底
        args[k] = goal;
      } else if (v !== undefined) {
        args[k] = v;
      }
    }
    // 差距L④(Codex function_tool): 参数 schema 强化 — 类型/范围校验, 非法则返回 null(调用方回退)
    for (const [k, def] of Object.entries(tool.params)) {
      const v = args[k];
      if (v === undefined) continue;
      if (def.type === "number") {
        const num = Number(v);
        if (Number.isNaN(num)) { console.log(`[agent] 参数 ${k} 类型错误(需number): ${String(v).slice(0, 30)}`); return null; }
        args[k] = num;
        // 范围约束（desc 含 min/max 时）
        const min = Number((def.desc.match(/min[=:]?\s*(\d+)/i) || [])[1]);
        const max = Number((def.desc.match(/max[=:]?\s*(\d+)/i) || [])[1]);
        if (!Number.isNaN(min) && num < min) { console.log(`[agent] 参数 ${k}=${num} 低于下限 ${min}`); return null; }
        if (!Number.isNaN(max) && num > max) { console.log(`[agent] 参数 ${k}=${num} 超过上限 ${max}`); return null; }
      } else if (def.type === "boolean") {
        if (typeof v !== "boolean" && v !== "true" && v !== "false") { console.log(`[agent] 参数 ${k} 类型错误(需boolean)`); return null; }
        args[k] = v === true || v === "true";
      } else if (def.type === "string" && typeof v !== "string") {
        args[k] = String(v);
      }
    }
    return { tool, args };
  } catch {
    return null;  // LLM 选择失败 → 调用方回退类型调度
  }
}

// ═══ V393-8: 工具失败自愈降级链 ═══
/** 工具降级链: 主工具失败 → 依次尝试替代工具 */
const TOOL_FALLBACK_CHAIN: Record<string, string[]> = {
  sag_reason: ["sag_retrieve", "policy_search", "summarize"],   // 推理挂 → 检索 → 政策 → 摘要
  sag_retrieve: ["policy_search", "summarize"],
  concept_trace: ["sag_retrieve", "sag_reason"],
  policy_search: ["sag_retrieve"],
  llm_write: ["summarize"],
  review_output: ["summarize"],
  empirical_analysis: ["sag_reason"],
  // P1-1: MCP 能力降级 — 检索挂 → 推理兜底; 事件查询挂 → 检索兜底
  sag_search: ["sag_reason", "sag_retrieve"],
  sag_get_event: ["sag_search"],
  sag_ingest: ["file_write"],
};

/**
 * V393-8: 带降级链的工具执行 — 主工具失败自动尝试替代工具（如 Cognee 挂→切 PG 检索）
 * @returns 成功时 ok=true 并标注 usedFallback; 全链失败返回最后错误
 */
export async function executeToolWithFallback(
  primary: AgentToolDef,
  args: Record<string, unknown>,
  allTools: AgentToolDef[],
  opts?: { role?: AgentRole; whitelist?: Set<string> | null }
): Promise<{ ok: boolean; result: string; risk: string; usedFallback?: string }> {
  // 1. 主工具
  const primaryRes = await executeAgentTool(primary, args, opts);
  if (primaryRes.ok) return { ...primaryRes, usedFallback: undefined };
  // 主工具被策略拒绝（denied）→ 不降级（安全策略不绕过）
  if (primaryRes.denied) return primaryRes;
  // 2. 降级链
  const chain = TOOL_FALLBACK_CHAIN[primary.name] || [];
  for (const altName of chain) {
    const alt = allTools.find((t) => t.name === altName);
    if (!alt) continue;
    const altRes = await executeAgentTool(alt, { ...args, query: String(args.query || args.topic || args.concept || args.keyword || "") }, opts);
    if (altRes.ok) {
      console.log(`[agent] V393-8 fallback: ${primary.name} → ${alt.name}`);
      return { ...altRes, usedFallback: alt.name };
    }
  }
  // 3. 全链失败 → 返回主工具错误
  return primaryRes;
}

export const agentToolRouter = {
  buildAgentTools,
  chooseToolByLlm,
  executeAgentTool,
  executeToolWithFallback,
  DENY_TOOLS,
  checkToolRole,
  checkToolPolicy,
  getToolWhitelist,
  // V396-7: 沙箱守卫
  checkNetworkAccess,
  checkPathAccess,
  maskCredentials,
  getNetworkWhitelist,
  // 借鉴1: 并行执行（Codex parallel tools 模式）
  executeToolsParallel: (calls: Array<{ tool: AgentToolDef; args: Record<string, unknown> }>, opts?: { role?: AgentRole; whitelist?: Set<string> | null }) =>
    _executeToolsParallel(calls, executeAgentTool, opts),
};
