// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// SciversePanel.tsx — 外部学术检索面板（哲社科版 Sciverse）
// 工具选择 + 结果卡片 + read_content/relations + 无 key mock 降级
import { useState, useEffect, type FC, type ReactNode } from "react";
import { Search, BookOpen, Link2, FileText, Loader2, AlertTriangle, CheckCircle2, Database, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Textarea } from "../components/ui/textarea";
import { LlmModelSelector, TASK_ROLES } from "./LlmModelSelector";

type Tool = "semantic_search" | "search_papers" | "relations" | "read_content";
type SciverseMode = "mock" | "online" | "auto";

const MODE_KEY = "sciverse-mode";

function readStoredMode(): SciverseMode {
  const stored = localStorage.getItem(MODE_KEY);
  if (stored === "mock" || stored === "online" || stored === "auto") return stored;
  return "auto";
}

interface Hit {
  chunk_id?: string;
  doc_id?: string;
  unique_id?: string;
  title?: string;
  chunk?: string;
  abstract?: string;
  score?: number;
  offset?: number;
  publication_published_year?: number;
  publication_venue_name_unified?: string;
  author?: string;
  language?: string;
  is_content_accessible?: boolean;
  is_mock?: boolean;
}

const TOOL_LABELS: Record<Tool, string> = {
  semantic_search: "语义检索（RAG）",
  search_papers: "结构化检索",
  relations: "引文关系",
  read_content: "读全文"
};

const PLACEHOLDERS: Record<Tool, string> = {
  semantic_search: "资本下乡与农村集体经济壮大机制",
  search_papers: "查询词（可空）＋右侧过滤条件",
  relations: "输入论文 unique_id",
  read_content: "输入论文 doc_id"
};

export function SciversePanel() {
  const [tool, setTool] = useState<Tool>("semantic_search");
  const [query, setQuery] = useState("");
  const [extra, setExtra] = useState("");
  const [results, setResults] = useState<{ hits: Hit[]; total?: number; detail?: ReactNode } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [mode, setMode] = useState<SciverseMode>(() => readStoredMode());
  // 数据源：sciverse 外部学术 / policy 中国政府网政策
  const [sourceType, setSourceType] = useState<"sciverse" | "policy">("sciverse");
  // 政策检索结果
  const [policyItems, setPolicyItems] = useState<Array<{ title: string; url: string; date: string; level: string; summary?: string }>>([]);
  // 知网引文网络
  const [cnkiType, setCnkiType] = useState<"references" | "citations" | "coreferences" | "cocitations" | "secondreferences" | "secondcitations">("references");
  const [cnkiItems, setCnkiItems] = useState<Array<{ raw: string }>>([]);
  const [cnkiLoading, setCnkiLoading] = useState(false);
  const [cnkiPaperTitle, setCnkiPaperTitle] = useState("");
  const [cnkiError, setCnkiError] = useState<string | null>(null);
  const [cnkiQuery, setCnkiQuery] = useState("");
  const [cnkiSearching, setCnkiSearching] = useState(false);
  // AI 分析（面板 → Claude Code）
  const [aiOutput, setAiOutput] = useState("");
  const [aiRunning, setAiRunning] = useState(false);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");

  useEffect(() => {
    api.aiExecuteStatus().then((s) => setAiAvailable(s.available)).catch(() => setAiAvailable(false));
  }, []);

  /** 2026-08-07 改 LLM API 直调（替代 Claude CLI）：自动附带当前引文数据 */
  const runWithClaude = async () => {
    const userPrompt = aiPrompt.trim();
    if (!userPrompt && cnkiItems.length === 0) {
      setAiOutput("请输入指令，或先提取引文数据后直接分析");
      return;
    }
    setAiRunning(true);
    setAiOutput("");
    const prompt = [
      "你是马克思主义政治经济学研究助手。",
      userPrompt ? `用户指令：${userPrompt}` : "请分析以下知网引文数据：",
      cnkiItems.length > 0 ? `当前论文：《${cnkiPaperTitle}》 | 引文类型：${CNKI_TABS.find((t) => t.key === cnkiType)?.label ?? cnkiType}` : "",
      cnkiItems.length > 0 ? "引文条目：" : "",
      ...cnkiItems.slice(0, 30).map((i, idx) => `${idx + 1}. ${i.raw}`),
      "",
      userPrompt ? "" : "请输出：1) 引文主题聚类（2-4 组）2) 核心作者/机构 3) 与农业农村现代化、资本下乡研究的关联 4) 值得关注的 3 篇文献及理由。用中文，简洁专业。"
    ].filter(Boolean).join("\n");
    try {
      // LLM API 直调（模型用注册表 reason 角色，用户可选）
      const result = await api.executeLlm({ prompt });
      setAiOutput(result.ok ? result.output : `执行失败: ${result.output.slice(0, 500)}`);
    } catch (err) {
      setAiOutput(`调用失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAiRunning(false);
    }
  };

  const CNKI_TABS: Array<{ key: typeof cnkiType; label: string }> = [
    { key: "references", label: "参考文献" },
    { key: "citations", label: "引证文献" },
    { key: "coreferences", label: "共引文献" },
    { key: "cocitations", label: "同被引文献" },
    { key: "secondreferences", label: "二级参考文献" },
    { key: "secondcitations", label: "二级引证文献" }
  ];

  /** 在知网搜索论文并打开详情页（联动引文网络） */
  const searchCnki = async (query: string) => {
    if (!query.trim()) return;
    setCnkiSearching(true);
    setCnkiError(null);
    setCnkiItems([]);
    try {
      const data = await api.searchCnkiOpen(query.trim());
      if (data.ok) {
        setCnkiPaperTitle(data.paperTitle ?? "");
        // 自动提取参考文献
        await loadCnkiCitations("references");
      } else {
        setCnkiError(data.error ?? "知网搜索失败");
      }
    } catch (err) {
      setCnkiError(err instanceof Error ? err.message : String(err));
    } finally {
      setCnkiSearching(false);
    }
  };

  const loadCnkiCitations = async (type: typeof cnkiType) => {
    setCnkiType(type);
    setCnkiLoading(true);
    setCnkiError(null);
    setCnkiItems([]);
    try {
      const data = await api.getCnkiCitations(type);
      if (data.ok) {
        setCnkiItems(data.items);
        setCnkiPaperTitle(data.paperTitle ?? "");
        // 联动知识页：引文数据沉淀为证据
        try {
          const paperTitle = data.paperTitle ?? "";
          const evidence = data.items.slice(0, 5).map((i) => ({
            title: paperTitle ? `${paperTitle} 引文` : "知网引文",
            content: i.raw.slice(0, 300)
          })).filter((e) => e.content);
          if (evidence.length > 0 && paperTitle) {
            await api.associateSearch(paperTitle, evidence);
          }
        } catch { /* 联动失败不影响主流程 */ }
      } else {
        setCnkiError(data.error ?? "获取失败");
      }
    } catch (err) {
      setCnkiError(err instanceof Error ? err.message : String(err));
    } finally {
      setCnkiLoading(false);
    }
  };

  const changeMode = (next: SciverseMode) => {
    setMode(next);
    localStorage.setItem(MODE_KEY, next);
  };

  // 初始探测是否配置了 key
  useEffect(() => {
    api.sciverseStatus().then((status) => setConfigured(status.configured)).catch(() => setConfigured(false));
  }, []);

  const runSearch = async () => {
    if (sourceType === "policy") {
      if (!query.trim()) return;
      setLoading(true);
      setError(null);
      try {
        const data = await api.searchPolicy({ keyword: query.trim(), pageSize: 10 });
        if (data.error) {
          setError(data.error);
        } else {
          setPolicyItems(data.items);
          setResults({ hits: [], total: data.count });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
      return;
    }
    if (!query.trim() && tool !== "search_papers") return;
    await executeTool(tool, query.trim(), extra);
  };

  const executeTool = async (t: Tool, q: string, extraParams: string) => {
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const params: Record<string, unknown> = { query: q };
      if (t === "search_papers") {
        // 结构化过滤：从 extra 解析简单的 年份/作者/语言
        const filters: string[] = extraParams.split(/[;,，\n]/).map((item) => item.trim()).filter(Boolean);
        for (const f of filters) {
          const m = f.match(/^年份\s*[:：]?\s*(\d{4})$/);
          if (m) params.year_from = Number(m[1]);
        }
        const langMatch = extraParams.match(/语言\s*[:：]?\s*(zh|en|中文|英文)/);
        if (langMatch) params.language = langMatch[1] === "中文" ? "zh" : langMatch[1] === "英文" ? "en" : langMatch[1];
        const authorMatch = extraParams.match(/作者\s*[:：]?\s*([^\s,;，；]+)/);
        if (authorMatch) params.authors = [authorMatch[1]];
      }
      if (t === "read_content") params.doc_id = q;
      if (t === "relations") params.unique_id = q;
      params.mode = mode;
      const response = await api.sciverseSearch(t, params);
      setConfigured(response.configured);
      if (response.error) {
        setError(response.error);
        return;
      }
      setResults(parseResults(t, response.data));
      // 联动知识页：检索结果沉淀为证据（语义/结构化检索时）
      try {
        const hits = (response.data as { hits?: Hit[]; results?: Hit[] })?.hits ?? (response.data as { results?: Hit[] })?.results ?? [];
        const evidence = hits.slice(0, 3).map((h) => ({
          title: h.title || "外部检索结果",
          content: (h.abstract || h.chunk || h.title || "").slice(0, 300)
        })).filter((e) => e.content);
        if (evidence.length > 0 && q.trim()) {
          await api.associateSearch(q, evidence);
        }
      } catch { /* 联动失败不影响主流程 */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const parseResults = (t: Tool, data: unknown): { hits: Hit[]; total?: number } => {
    if (t === "semantic_search") {
      const d = data as { results?: Hit[] };
      return { hits: d?.results ?? [] };
    }
    if (t === "search_papers") {
      const d = data as { results?: Hit[]; total?: number };
      return { hits: d?.results ?? [], total: d?.total };
    }
    if (t === "relations") {
      const d = data as { results?: Hit[]; total_count?: number };
      return { hits: d?.results ?? [], total: d?.total_count };
    }
    return { hits: [] };
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto w-full max-w-[1400px] space-y-4">
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">外部学术检索（Sciverse）</h2>
          <span className={cn(
            "ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
            configured === null ? "bg-muted text-muted-foreground" :
            configured ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
          )}>
            {configured === null ? <Loader2 className="h-3 w-3 animate-spin" /> :
              configured ? <><CheckCircle2 className="h-3 w-3" />已配置</> :
                <><AlertTriangle className="h-3 w-3" />未配置 Key（Mock 模式）</>}
          </span>
        </div>

        {(configured === false && mode !== "mock") && (
          <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
            <p className="font-medium">
              {mode === "online" ? "当前为「在线」模式，但未配置 SCIVERSE_API_TOKEN — 检索将失败" : "未配置 SCIVERSE_API_TOKEN — 当前为 Mock 演示数据"}
            </p>
            <p className="mt-1 text-xs">
              到 <a href="https://sciverse.space" target="_blank" rel="noreferrer" className="underline">sciverse.space</a> 控制台「密钥」页申请 sv-xxx，填入
              <code className="mx-1 rounded bg-yellow-100 px-1">~/.claude/mcp.json</code> 的 sciverse.env，或 SAG <code className="mx-1 rounded bg-yellow-100 px-1">.env</code> 的 SCIVERSE_API_TOKEN。
            </p>
          </div>
        )}

        {/* 数据源选择（统一检索入口）*/}
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
          <span className="text-sm font-medium">数据源：</span>
          <button
            type="button"
            className={cn(
              "rounded-md px-3 py-1 text-sm transition-colors",
              sourceType === "sciverse" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
            )}
            onClick={() => { setSourceType("sciverse"); setResults(null); setPolicyItems([]); }}
          >
            学术文献（Sciverse）
          </button>
          <button
            type="button"
            className={cn(
              "rounded-md px-3 py-1 text-sm transition-colors",
              sourceType === "policy" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
            )}
            onClick={() => { setSourceType("policy"); setResults(null); setPolicyItems([]); }}
          >
            政策文件（gov.cn）
          </button>
        </div>

        {/* 双模式切换（GBrain 式 localStorage） */}
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
          <span className="text-sm font-medium">模式：</span>
          <button
            type="button"
            className={cn(
              "rounded-md px-3 py-1 text-sm transition-colors",
              mode === "auto" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
            )}
            onClick={() => changeMode("auto")}
          >
            自动（{configured ? "有 key→在线" : "无 key→沙箱"}）
          </button>
          <button
            type="button"
            className={cn(
              "rounded-md px-3 py-1 text-sm transition-colors",
              mode === "mock" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
            )}
            onClick={() => changeMode("mock")}
          >
            沙箱（Mock）
          </button>
          <button
            type="button"
            className={cn(
              "rounded-md px-3 py-1 text-sm transition-colors",
              mode === "online" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
            )}
            onClick={() => changeMode("online")}
          >
            在线（真实 API）
          </button>
          <span className="ml-auto text-xs text-muted-foreground">刷新后保持选择</span>
        </div>

        {/* 工具选择 */}
        <div className="flex flex-wrap gap-2">
          {(Object.keys(TOOL_LABELS) as Tool[]).map((t) => (
            <button
              key={t}
              type="button"
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm transition-colors",
                tool === t ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-accent"
              )}
              onClick={() => { setTool(t); setResults(null); }}
            >
              {t === "semantic_search" ? <Search className="mr-1 inline h-3.5 w-3.5" /> :
                t === "search_papers" ? <BookOpen className="mr-1 inline h-3.5 w-3.5" /> :
                t === "relations" ? <Link2 className="mr-1 inline h-3.5 w-3.5" /> :
                  <FileText className="mr-1 inline h-3.5 w-3.5" />}
              {TOOL_LABELS[t]}
            </button>
          ))}
        </div>

        {/* 输入区 */}
        <Card className="p-4">
          {/* 当前工具简介（随工具切换更新） */}
          <div className="mb-2 flex items-start gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2">
            <span className="mt-0.5 shrink-0 text-primary">
              {tool === "semantic_search" ? <Search className="h-3.5 w-3.5" /> :
                tool === "search_papers" ? <BookOpen className="h-3.5 w-3.5" /> :
                tool === "relations" ? <Link2 className="h-3.5 w-3.5" /> :
                  <FileText className="h-3.5 w-3.5" />}
            </span>
            <div className="min-w-0 text-xs leading-5 text-muted-foreground">
              {tool === "semantic_search" && (
                <>最常用：输入自然语言研究问题（如「资本下乡对农村集体经济的双重效应」），按<strong className="font-medium text-foreground">语义理解</strong>返回最相关的论文原文片段 + 相关度评分。</>
              )}
              {tool === "search_papers" && (
                <>按<strong className="font-medium text-foreground">结构化条件</strong>精确找论文：年份范围、期刊、作者等（如「2020-2024 年、某期刊、关于资本流动的论文」）。</>
              )}
              {tool === "relations" && (
                <>论文<strong className="font-medium text-foreground">引文关系</strong>追踪：输入一篇论文的 unique_id，查「谁引用了它 / 它引用了谁」，做文献滚雪球。</>
              )}
              {tool === "read_content" && (
                <>对搜索结果中<strong className="font-medium text-foreground">开放获取（OA）</strong>的论文直接读正文原文：输入 doc_id 按字节区间读取全文。</>
              )}
            </div>
          </div>
          <Textarea
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={PLACEHOLDERS[tool]}
            rows={tool === "read_content" || tool === "relations" ? 1 : 2}
            className="mb-2"
          />
          {tool === "search_papers" && (
            <input
              value={extra}
              onChange={(event) => setExtra(event.target.value)}
              placeholder="过滤条件：年份:2024，语言:zh，作者:xxx（逗号分隔）"
              className="mb-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          )}
          <div className="flex items-center gap-2">
            <Button onClick={() => void runSearch()} disabled={loading || (!query.trim() && tool !== "search_papers")}>
              {loading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Search className="mr-1 h-4 w-4" />}
              检索
            </Button>
            {/* 2026-08-07 LLM 模型选择（检索任务：仅查询改写） */}
            <LlmModelSelector roles={TASK_ROLES.search} />
          </div>
        </Card>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {sourceType === "policy" && policyItems.length > 0 && (
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">找到 {policyItems.length} 条政策</div>
            {policyItems.map((item, index) => (
              <Card key={index} className="p-4">
                <div className="font-medium leading-snug">{item.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {item.date} · {item.level === "state_council" ? "国务院" : item.level || "政策"}
                </div>
                {item.summary && <p className="mt-2 text-sm text-muted-foreground">{item.summary}</p>}
                {item.url && (
                  <a href={item.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-primary underline">
                    查看原文 →
                  </a>
                )}
              </Card>
            ))}
          </div>
        )}

        {results && (
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              {results.total !== undefined ? `共 ${results.total} 条` : `${results.hits.length} 条结果`}
            </div>
            {results.hits.length === 0 && <div className="text-sm text-muted-foreground">无结果</div>}
            {results.hits.map((hit, index) => (
              <Card key={index} className="p-4">
                {hit.is_mock && <span className="mr-2 rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-700">Mock</span>}
                <div className="font-medium">{hit.title || "(无标题)"}</div>
                {hit.score !== undefined && (
                  <div className="mt-0.5 text-xs text-muted-foreground">相关度 {hit.score.toFixed(3)}</div>
                )}
                <p className="mt-1 text-sm text-muted-foreground">{hit.chunk || hit.abstract}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {hit.author && <span>{hit.author}</span>}
                  {hit.publication_published_year && <span>{hit.publication_published_year}</span>}
                  {hit.publication_venue_name_unified && <span>{hit.publication_venue_name_unified}</span>}
                  {hit.language && <span>{hit.language}</span>}
                  {hit.doc_id && <code className="rounded bg-muted px-1">doc_id:{hit.doc_id.slice(0, 12)}…</code>}
                  {hit.unique_id && <code className="rounded bg-muted px-1">id:{hit.unique_id.slice(0, 12)}…</code>}
                </div>
                {hit.doc_id && tool === "semantic_search" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => void executeTool("read_content", hit.doc_id ?? "", "")}
                  >
                    <FileText className="mr-1 h-3.5 w-3.5" /> 读原文
                  </Button>
                )}
                {hit.title && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => void searchCnki(hit.title ?? "")}
                    disabled={cnkiSearching}
                  >
                    <Link2 className="mr-1 h-3.5 w-3.5" /> 查知网引文
                  </Button>
                )}
              </Card>
            ))}
          </div>
        )}

        {/* 知网引文网络（CDP 代理） */}
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Link2 className="h-4 w-4 text-primary" /> 知网引文网络
            <span className="text-xs text-muted-foreground">搜索论文 → 知网打开详情 → 联动引文数据</span>
          </div>
          {/* 搜索框 */}
          <div className="mb-3 flex gap-2">
            <input
              value={cnkiQuery}
              onChange={(event) => setCnkiQuery(event.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void searchCnki(cnkiQuery); }}
              placeholder="输入论文标题在知网检索（如：资本下乡对农村集体经济的双重效应）"
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <Button onClick={() => void searchCnki(cnkiQuery)} disabled={cnkiSearching || !cnkiQuery.trim()}>
              {cnkiSearching ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Search className="mr-1 h-4 w-4" />}
              知网检索
            </Button>
            {/* 2026-08-07 LLM 模型选择（知网检索：仅查询改写） */}
            <LlmModelSelector roles={TASK_ROLES.search} />
          </div>
          <div className="mb-3 flex flex-wrap gap-1">
            {CNKI_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => void loadCnkiCitations(tab.key)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs transition-colors",
                  cnkiType === tab.key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {cnkiLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />提取中…</div>
          ) : cnkiError ? (
            <div className="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">{cnkiError}</div>
          ) : cnkiItems.length > 0 ? (
            <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
              <div className="text-xs text-muted-foreground">{cnkiPaperTitle ? `《${cnkiPaperTitle.slice(0, 40)}》` : ""} · 共 {cnkiItems.length} 条（当前页）</div>
              {cnkiItems.map((item, i) => (
                <div key={i} className="rounded bg-muted/30 px-2 py-1 text-xs leading-5">{item.raw}</div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">输入论文标题检索，或在 Edge 打开知网详情页后点击上方 tab 提取</div>
          )}

          {/* AI 执行：面板 → Claude Code（带自定义输入框） */}
          <div className="mt-3 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={aiPrompt}
                onChange={(event) => setAiPrompt(event.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void runWithClaude(); }}
                placeholder="输入指令交给 Claude 执行（如：把引文按年份分组统计；留空则分析引文主题）"
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              />
              <Button size="sm" onClick={() => void runWithClaude()} disabled={aiRunning || aiAvailable === false}>
                {aiRunning ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
                {aiRunning ? "执行中…" : "执行"}
              </Button>
              {/* 2026-08-07 LLM 模型选择（LLM API 直调：reason 角色，显示与调用一致） */}
              <LlmModelSelector roles={TASK_ROLES.search} />
              {aiOutput && (
                <div className="w-full max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-primary/20 bg-primary/5 p-3 text-xs leading-5">
                  {aiOutput}
                </div>
              )}
            </div>
          </div>
        </Card>
      </div>
    </section>
  );
}
