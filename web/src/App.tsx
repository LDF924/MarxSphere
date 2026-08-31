// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import { useCallback, useEffect, Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  ListChecks,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  Square,
  Trash2,
  Upload,
  XCircle,
  Zap,
  PanelLeftOpen,
  PanelRightClose,
  MessageCircle,
  BookOpen,
  Database,
  Landmark,
  Wrench,
  Boxes,
  Sun,
  Moon,
  UserRound,
  LogOut
} from "lucide-react";
import { api } from "./lib/api";
import { AuthGate, useAuth } from "./components/AuthGate";
import { BillingPanel } from "./components/BillingPanel";
import { AdminPanel } from "./components/AdminPanel";
import { ChatPanel, type ChatDraftImage } from "./components/ChatPanel";
import { cn, formatDate, formatDuration, formatMessageDate, shortId, timeGapMinutes } from "./lib/utils";
import { MarkdownMessage, renderMarkdownLines, type MarkdownCitation } from "./lib/markdown";
import type {
  ChunkRecord,
  DocumentRecord,
  EmbeddingPreview,
  EntityDetailRecord,
  EntityRecord,
  EventDetailRecord,
  EventRecord,
  McpSessionDetail,
  McpSessionRecord,
  McpMessageRecord,
  McpStreamEvent,
  McpToolCallRecord,
  ModelCallLogRecord,
  ProjectGraphRecord,
  ProjectStatsRecord,
  ChunkingMode,
  PublicAiProviderSettings,
  PublicMcpSettings,
  SearchMode,
  SearchResult,
  SearchStreamEvent,
  SourceRecord,
  UploadJobRecord
} from "./types";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { TaskPanel } from "./components/TaskPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";  // 修复4: 面板级错误边界
import { WritingCorpusPanel } from "./components/WritingCorpusPanel";
import { StructurePanel } from "./components/StructurePanel";
import { AgentConsole } from "./components/AgentConsole";
import { P2OView } from "./components/P2OView";
import { CJournalPanel } from "./components/CJournalPanel";
import { CitationVerifyPanel } from "./components/CitationVerifyPanel";
import { Background, BackgroundVariant, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ProjectGraphFlow } from "./components/ProjectGraphFlow";
import { ForceGraphPanel } from "./components/ForceGraphPanel";
import { QuickLinkPanel } from "./components/QuickLinkPanel";
import { TraversalPanel } from "./components/TraversalPanel";
import { JobsPanel } from "./components/JobsPanel";
import { InboxPanel } from "./components/InboxPanel";
import { TracePanel } from "./components/TracePanel";
import { EvalPanel } from "./components/EvalPanel";
import { ReasonPanel } from "./components/ReasonPanel";
import { AskPanel } from "./components/AskPanel";
import { SciversePanel } from "./components/SciversePanel";
import { SkillsPanel } from "./components/SkillsPanel";
import { ApiTokensPanel } from "./components/ApiTokensPanel";
import { DocsPanel } from "./components/DocsPanel";
import { AlertsPanel } from "./components/AlertsPanel";
import { AlertToast } from "./components/AlertToast";
import { MemoryPanel } from "./components/MemoryPanel";
import { VaultPanel } from "./components/VaultPanel";
import { TruthPanel } from "./components/TruthPanel";
import { LiteraturePanel } from "./components/LiteraturePanel";
import { HomePanel } from "./components/HomePanel";
import { SourcesPanel } from "./components/SourcesPanel";
import { PolicyPanel } from "./components/PolicyPanel";
import { SymbolLogo } from "./components/SymbolLogo";
import { ScenariosPanel } from "./components/ScenariosPanel";
import { EducationPanel } from "./components/EducationPanel";
import { EducationWorkspacePanel } from "./components/EducationWorkspacePanel";
import { getRegisteredView } from "./components/viewRegistry";
import { EmpiricalResearchPanel } from "./components/EmpiricalResearchPanel";
import { JupyterPanel } from "./components/JupyterPanel";
import { ImportsPanel } from "./components/ImportsPanel";
import { EngineIngestPanel } from "./components/EngineIngestPanel";
import { I18nProvider, useI18n, useLanguageController, type LanguagePreference, type SupportedLanguage } from "./i18n";

type WorkspaceView = "home" | "assistant" | "chat" | "documents" | "graph" | "mcp" | "reason" | "ask" | "sciverse" | "skills" | "vault" | "truth" | "literature" | "sources" | "policy" | "scenarios" | "jobs" | "inbox" | "trace" | "eval" | "tasks" | "agent-console" | "p2o" | "cjournal" | "corpus" | "settings" | "memory" | "docs" | "alerts" | "education" | "empirical-research" | "graphiti-ingest" | "cognee-ingest" | "billing" | "admin" | "jupyter" | "imports" | "structure" | "citation-verify" | "capability-tools";
type ResultView = "overview" | "chunks" | "events" | "entities" | "search";
type ContextPanelMode = "process" | "logs";
type ProcessStepStatus = "running" | "done" | "failed";
type ProcessStep = {
  id: string;
  title: string;
  status: ProcessStepStatus;
  detail?: string;
  payload?: unknown;
  durationMs?: number | null;
};
type RunningMcpSearch = {
  id: string;
  toolName: string;
  query: string;
  searchMode?: string;
};
type AnswerCitation = MarkdownCitation;
type DetailDrawer =
  | { type: "event"; detail: EventDetailRecord }
  | { type: "entity"; detail: EntityDetailRecord }
  | { type: "citation"; citation: AnswerCitation }
  | null;

const MODEL_LOGS_STORAGE_KEY = "sag:model-call-logs:v1";
const MODEL_LOG_CURSOR_STORAGE_KEY = "sag:model-call-log-cursor:v1";
const MAX_BROWSER_MODEL_LOGS = 200;
const DOCUMENT_RESULT_PAGE_SIZE = 10;
const DEFAULT_SEARCH_QUERY_ZH = "基于当前项目资料检索";
const DEFAULT_SEARCH_QUERY_EN = "Search current project documents";

export default function App() {
  const i18n = useLanguageController();
  return (
    <I18nProvider value={i18n}>
      <AuthGate>
        <AppShell />
      </AuthGate>
    </I18nProvider>
  );
}

function AppShell() {
  const { language, preference: languagePreference, setPreference: setLanguagePreference, t } = useI18n();
  // V399: 登录状态（header 登录按钮/用户菜单）
  const { user: authUser, openLogin, logout: authLogout } = useAuth();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  // V399: 用户菜单点击外部关闭
  useEffect(() => {
    if (!userMenuOpen) return;
    const close = () => setUserMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [userMenuOpen]);
  const [projects, setProjects] = useState<SourceRecord[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [projectStats, setProjectStats] = useState<ProjectStatsRecord | null>(null);
  const [projectGraph, setProjectGraph] = useState<ProjectGraphRecord | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [selectedDocument, setSelectedDocument] = useState<DocumentRecord | null>(null);
  const [chunks, setChunks] = useState<ChunkRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [entities, setEntities] = useState<EntityRecord[]>([]);
  const [sessionsByProjectId, setSessionsByProjectId] = useState<Record<string, McpSessionRecord[]>>({});
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
  const [mcpDetail, setMcpDetail] = useState<McpSessionDetail | null>(null);
  const [aiSettings, setAiSettings] = useState<PublicAiProviderSettings | null>(null);
  const [mcpSettings, setMcpSettings] = useState<PublicMcpSettings | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("assistant");
  const [modeBadge, setModeBadge] = useState<{ mode: "preview" | "full" | "degraded"; mcpPoolSize: number; health?: { neo4j: { graphiti: boolean; cognee: boolean }; pythonProcesses: number; label: string } } | null>(null);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);  // V390: 运行模式切换菜单展开状态
  // 待播放的 demo 查询（Hero 按钮 → AskPanel 自动检索）
  const pendingDemoRef = useRef<string | null>(null);

  // ── V398: AI 对话页状态（assistant 视图）──
  const [chatSessions, setChatSessions] = useState<McpSessionRecord[]>([]);
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<McpMessageRecord[]>([]);
  const [chatToolCalls, setChatToolCalls] = useState<McpToolCallRecord[]>([]);
  const [chatPendingUser, setChatPendingUser] = useState("");
  const [chatStreamingText, setChatStreamingText] = useState("");
  const [chatReasoning, setChatReasoning] = useState("");
  const [chatRunningTool, setChatRunningTool] = useState<string | null>(null);
  const [chatIsRunning, setChatIsRunning] = useState(false);
  const [chatModel, setChatModel] = useState("");
  const [chatWebSearch, setChatWebSearch] = useState(false);
  /** V399: 深度模式 — 质量优先（文献必查/推理深化/轮次 20），Composer 开关 */
  const [chatDeepMode, setChatDeepMode] = useState(false);
  /** V399: 思考强度三档（low/high/max）— 控制思考链充分程度 */
  const [chatReasoningEffort, setChatReasoningEffort] = useState<"low" | "high" | "max">("high");
  /** V399: 待审批工具弹窗 {approvalId, toolName, arguments} */
  const [chatApproval, setChatApproval] = useState<{ approvalId: string; toolName: string; arguments: Record<string, unknown> } | null>(null);
  const [chatModels, setChatModels] = useState<Array<{ id: string; label: string }>>([]);
  const [chatCollapsed, setChatCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem("sag:chat:collapsed:v1") === "1";
    } catch {
      return false;
    }
  });
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return window.localStorage.getItem("sag:theme:v1") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  /** V399: 顶栏「项目」弹出面板 */
  const [projectPanelOpen, setProjectPanelOpen] = useState(false);
  const chatAbortRef = useRef<AbortController | null>(null);
  /** V425: 会话切换请求序号 — 竞态防护：响应回来时若序号已过期（期间又切了会话）则丢弃 */
  const chatSessionReqSeqRef = useRef(0);
  /** V399: 流式落库清理 — assistant 消息追加后统一清空流式态（历史消息已渲染，无闪现） */
  const lastStreamedAssistantRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chatMessages.length || !chatStreamingText) return;
    const last = chatMessages[chatMessages.length - 1];
    if (last?.role === "assistant" && last.id !== lastStreamedAssistantRef.current) {
      lastStreamedAssistantRef.current = last.id;
      // 延迟一帧让历史消息渲染完成，再清流式态（避免闪现）
      window.setTimeout(() => {
        setChatStreamingText("");
        setChatReasoning("");
      }, 50);
    }
  }, [chatMessages, chatStreamingText]);

  // 主题切换
  function toggleTheme() {
    const next: "dark" | "light" = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.classList.toggle("light", next === "light");
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      window.localStorage.setItem("sag:theme:v1", next);
    } catch { /* ignore */ }
  }

  // 侧边栏折叠持久化
  useEffect(() => {
    try {
      window.localStorage.setItem("sag:chat:collapsed:v1", chatCollapsed ? "1" : "0");
    } catch { /* ignore */ }
  }, [chatCollapsed]);

  // 加载模型列表
  useEffect(() => {
    fetch("/api/llm/models")
      .then((r) => r.json())
      .then((d) => {
        const models = (d.models ?? []) as Array<{ id: string; label: string; provider: string; desc: string; roles: string[] }>;
        setChatModels(models.map((m) => ({ id: m.id, label: `${m.label}（${m.provider}）` })));
        setChatModel((prev) => prev || (d.roleMap?.reason ?? models[0]?.id ?? ""));
      })
      .catch(() => {});
  }, []);

  // 加载会话列表；无会话时自动新建
  const loadChatSessions = useCallback(async () => {
    try {
      const { sessions } = await api.listChatSessions();
      setChatSessions(sessions);
      if (sessions.length > 0) {
        if (!chatSessionId || !sessions.some((s) => s.id === chatSessionId)) {
          setChatSessionId(sessions[0].id);
        }
      } else {
        const { session } = await api.createMcpSession({ kind: "chat" });
        setChatSessions((prev) => [session, ...prev]);
        setChatSessionId(session.id);
      }
    } catch { /* 服务未就绪时静默 */ }
  }, [chatSessionId]);

  useEffect(() => {
    void loadChatSessions();
  }, [loadChatSessions]);

  // 切换会话 → 加载消息
  const selectChatSession = useCallback((sessionId: string) => {
    // V399: 切换立即清空（防止停留上一个会话内容）+ 每次都重新拉取（不信任 loaded 缓存）
    // V425: 请求序号防竞态 — 慢响应回来时若已切到别的会话，丢弃旧数据
    const reqSeq = ++chatSessionReqSeqRef.current;
    setChatSessionId(sessionId);
    chatAbortRef.current?.abort();
    setChatMessages([]);
    setChatToolCalls([]);
    setChatStreamingText("");
    setChatReasoning("");
    void api.getMcpSession(sessionId).then((detail) => {
      if (reqSeq !== chatSessionReqSeqRef.current) return;
      setChatMessages(detail.messages);
      setChatToolCalls(detail.toolCalls);
      setChatModel((prev) => prev || (detail.session.model ?? ""));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!chatSessionId) return;
    // V399: 挂载/变更时拉取（始终拉最新，不信任 loaded 缓存）
    const reqSeq = ++chatSessionReqSeqRef.current;
    void api.getMcpSession(chatSessionId).then((detail) => {
      if (reqSeq !== chatSessionReqSeqRef.current) return;
      setChatMessages(detail.messages);
      setChatToolCalls(detail.toolCalls);
      setChatModel((prev) => prev || (detail.session.model ?? ""));
    }).catch(() => {});
  }, [chatSessionId]);

  // 发送消息
  async function sendChatMessage(content: string, images: ChatDraftImage[], webSearch: boolean, deepMode?: boolean, docs?: ChatDraftImage[]) {
    if (!chatSessionId || chatIsRunning) return;
    chatAbortRef.current?.abort();
    const controller = new AbortController();
    chatAbortRef.current = controller;
    setChatIsRunning(true);
    setChatPendingUser(content);
    setChatStreamingText("");
    setChatReasoning("");
    setChatRunningTool(null);
    try {
      await api.streamChatMessage(chatSessionId, { content, images, webSearch, deepMode, reasoningEffort: chatReasoningEffort, docs }, (event) => {
        switch (event.type) {
          case "message":
            if (event.message.role === "user") {
              setChatPendingUser("");
              setChatMessages((prev) => [...prev, event.message]);
            } else {
              // V399: 落库后由 useEffect 观察 messages 变化统一清空流式态
              // （避免流式气泡与历史消息双渲染/闪现）
              setChatMessages((prev) => [...prev, event.message]);
            }
            break;
          case "assistant_delta":
            setChatStreamingText((prev) => prev + event.delta);
            break;
          case "reasoning_delta":
            setChatReasoning((prev) => prev + event.delta);
            break;
          case "tool_start":
            setChatRunningTool(event.toolName);
            break;
          case "tool_end":
            setChatRunningTool(null);
            setChatToolCalls((prev) => [...prev, event.toolCall]);
            break;
          case "model":
            setChatModel(event.model);
            break;
          case "tool_approval":
            setChatApproval({ approvalId: event.approvalId, toolName: event.toolName, arguments: event.arguments });
            break;
          case "done":
            setChatMessages(event.detail.messages);
            setChatToolCalls(event.detail.toolCalls);
            break;
          case "error":
            setError(event.message);
            break;
          default:
            break;
        }
      }, { signal: controller.signal });
      // 发送完成后刷新会话列表（autoTitle 可能已更新标题）
      const { sessions } = await api.listChatSessions();
      setChatSessions(sessions);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(String(err instanceof Error ? err.message : err));
      }
    } finally {
      setChatIsRunning(false);
      setChatPendingUser("");
      setChatStreamingText("");
      setChatReasoning("");
      setChatRunningTool(null);
      chatAbortRef.current = null;
    }
  }

  // 新建会话
  async function createChatSession() {
    if (chatIsRunning) return;
    try {
      const { session } = await api.createMcpSession({ kind: "chat" });
      setChatSessions((prev) => [session, ...prev]);
      setChatMessages([]);
      setChatToolCalls([]);
      setChatStreamingText("");
      setChatReasoning("");
      setChatSessionId(session.id);
    } catch { /* ignore */ }
  }

  // 重命名 / 删除会话
  async function renameChatSession(sessionId: string, title: string) {
    try {
      const { session } = await api.renameMcpSession(sessionId, title);
      setChatSessions((prev) => prev.map((s) => s.id === sessionId ? session : s));
    } catch { /* ignore */ }
  }

  async function deleteChatSession(sessionId: string) {
    try {
      await api.deleteMcpSession(sessionId);
      const remaining = chatSessions.filter((s) => s.id !== sessionId);
      setChatSessions(remaining);
      if (chatSessionId === sessionId) {
        if (remaining.length > 0) {
          // V399: 切到下一个会话（useEffect 自动拉取，此处只清空防残留）
          setChatSessionId(remaining[0].id);
          setChatMessages([]);
          setChatToolCalls([]);
        } else {
          const { session } = await api.createMcpSession({ kind: "chat" });
          setChatSessions([session]);
          setChatSessionId(session.id);
          setChatMessages([]);
          setChatToolCalls([]);
        }
      }
    } catch { /* ignore */ }
  }

  function stopChatMessage() {
    chatAbortRef.current?.abort();
  }

  /** V399: 撤回/删除任意消息（提问可撤回、AI 回答可删除） */
  async function recallChatMessage(messageId: string) {
    if (!chatSessionId || chatIsRunning) return;
    // 若删除的是当前正在发送/回复关联的消息，先中止
    if (messageId === chatMessages[chatMessages.length - 1]?.id) {
      chatAbortRef.current?.abort();
    }
    try {
      await api.deleteMcpMessage(chatSessionId, messageId);
      setChatMessages((prev) => prev.filter((m) => m.id !== messageId));
      // 该消息的工具调用一并移除（撤回后重发避免残留）
      setChatToolCalls((prev) => prev.filter((t) => t.messageId !== messageId));
    } catch { /* 删除失败静默（刷新后仍可见） */ }
  }

  /** V399: 工具审批（前端弹窗 → 批准/拒绝 review 工具） */
  async function approveChatTool(approvalId: string, approved: boolean) {
    setChatApproval(null);
    try {
      await api.approveChatTool(approvalId, approved);
    } catch { /* 审批失败静默 */ }
  }

  // 加载运行模式徽标（GBrain 模式徽标）
  useEffect(() => {
    api.getMode().then(setModeBadge).catch(() => {});
  }, []);

  // 模式切换（写入 mode.json，重启后生效）
  const switchModeTo = async (target: "preview" | "full") => {
    if (!modeBadge || modeBadge.mode === target) return;
    try {
      await api.switchMode(target);
      setModeBadge((prev) => prev ? { ...prev, mode: target } : prev);
      setError(`已选择「${target === "full" ? "完整模式（推理+MCP 池）" : "预览模式（省内存）"}」，重启服务后生效`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const [resultView, setResultView] = useState<ResultView>("overview");
  const [contextPanelMode, setContextPanelMode] = useState<ContextPanelMode>("process");
  const [drawer, setDrawer] = useState<DetailDrawer>(null);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [showArchivedDocuments, setShowArchivedDocuments] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [status, setStatus] = useState(() => t("正在加载 MarxSphere...", "Loading MarxSphere..."));
  const [error, setError] = useState("");
  const [uploadJobs, setUploadJobs] = useState<UploadJobRecord[]>([]);
  const [isUploadQueueExpanded, setIsUploadQueueExpanded] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  // V415: 设置就地保存反馈（sticky 保存栏旁显示成功/失败）
  const [settingsSaveStatus, setSettingsSaveStatus] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState(() => t(DEFAULT_SEARCH_QUERY_ZH, DEFAULT_SEARCH_QUERY_EN));
  const [searchMode, setSearchMode] = useState<SearchMode>("fast");
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [processSteps, setProcessSteps] = useState<ProcessStep[]>([]);
  const [modelLogs, setModelLogs] = useState<ModelCallLogRecord[]>(() => loadStoredModelLogs());
  const [modelLogCursor, setModelLogCursor] = useState(() => loadStoredModelLogCursor());
  const [isSearching, setIsSearching] = useState(false);
  const [mcpInput, setMcpInput] = useState("");
  const [isMcpRunning, setIsMcpRunning] = useState(false);
  const [pendingUserMessage, setPendingUserMessage] = useState("");
  const [streamingAssistantText, setStreamingAssistantText] = useState("");
  const [runningMcpSearches, setRunningMcpSearches] = useState<RunningMcpSearch[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const searchStartedAtRef = useRef<number | null>(null);
  const refreshedUploadJobsRef = useRef<Set<string>>(new Set());
  const modelLogCursorRef = useRef(modelLogCursor);
  const pendingSessionIdRef = useRef<string | null>(null);
  const mcpAbortControllerRef = useRef<AbortController | null>(null);

  // 视图导航：切换标签产生浏览器历史，支持返回/前进
  const navigateView = (view: WorkspaceView, params?: { demo?: string }) => {
    // 记录待播放的 demo 查询（AskPanel 挂载时消费）
    if (params?.demo) {
      pendingDemoRef.current = params.demo;
    }
    if (view === workspaceView) return;
    setWorkspaceView(view);
    // 用 hash 记录视图状态（SPA 内 pushState 不刷新页面）
    const current = window.location.hash.replace(/^#/, "");
    const newHash = view === "home" ? "" : view;
    if (current !== newHash) {
      try {
        window.history.pushState({ view }, "", `#${newHash}`);
      } catch { /* 忽略 */ }
    }
  };

  // 浏览器返回/前进 → 恢复视图
  useEffect(() => {
    // 初始从 hash 恢复（刷新后保持）
    const initialHash = window.location.hash.replace(/^#/, "");
    const validViews: WorkspaceView[] = ["assistant", "chat", "documents", "graph", "mcp", "reason", "ask", "sciverse", "skills", "vault", "truth", "literature", "sources", "policy", "scenarios", "jobs", "inbox", "trace", "eval", "tasks", "agent-console", "p2o", "cjournal", "corpus", "settings", "memory", "docs", "alerts", "education", "empirical-research", "graphiti-ingest", "cognee-ingest", "billing", "admin", "jupyter", "imports", "structure", "citation-verify"];
    if (initialHash && validViews.includes(initialHash as WorkspaceView)) {
      setWorkspaceView(initialHash as WorkspaceView);
    }
    const handlePopState = (event: PopStateEvent) => {
      const view = (event.state as { view?: WorkspaceView } | null)?.view;
      if (view) setWorkspaceView(view);
      else {
        // 无 state 时从 hash 恢复
        const hash = window.location.hash.replace(/^#/, "");
        if (validViews.includes(hash as WorkspaceView)) setWorkspaceView(hash as WorkspaceView);
        else setWorkspaceView("assistant");
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  const visibleDocuments = useMemo(
    () => documents.filter((document) => showArchivedDocuments || !document.archivedAt),
    [documents, showArchivedDocuments]
  );

  const hasActiveUploads = useMemo(
    () => uploadJobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING"),
    [uploadJobs]
  );

  useEffect(() => {
    if (hasActiveUploads) {
      setIsUploadQueueExpanded(true);
      return;
    }
    if (uploadJobs.length > 0) {
      setIsUploadQueueExpanded(false);
    }
  }, [hasActiveUploads, uploadJobs.length]);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    setSearchQuery((current) => {
      if (current === DEFAULT_SEARCH_QUERY_ZH || current === DEFAULT_SEARCH_QUERY_EN) {
        return t(DEFAULT_SEARCH_QUERY_ZH, DEFAULT_SEARCH_QUERY_EN);
      }
      return current;
    });
  }, [language, t]);

  useEffect(() => {
    if (aiSettings?.defaultSearchMode) {
      setSearchMode(aiSettings.defaultSearchMode);
    }
  }, [aiSettings?.defaultSearchMode]);

  useEffect(() => {
    if (!selectedProjectId) return;
    setExpandedProjectIds((current) => {
      if (current.has(selectedProjectId)) return current;
      const next = new Set(current);
      next.add(selectedProjectId);
      return next;
    });
  }, [selectedProjectId]);

  useEffect(() => {
    modelLogCursorRef.current = modelLogCursor;
    window.localStorage.setItem(MODEL_LOG_CURSOR_STORAGE_KEY, String(modelLogCursor));
  }, [modelLogCursor]);

  useEffect(() => {
    persistModelLogs(modelLogs);
  }, [modelLogs]);

  useEffect(() => {
    void loadProjects();
    // V447: 后端可能未就绪（迁移中），重试直到加载成功（避免 projects 永久空列表）
    let retries = 0;
    const timer = setInterval(() => {
      retries++;
      if (retries > 10) { clearInterval(timer); return; }
      void loadProjects();
    }, 5000);
    return () => clearInterval(timer);
  }, [showArchivedProjects]);

  useEffect(() => {
    if (!selectedProjectId) {
      setDocuments([]);
      setSelectedDocumentId("");
      setSelectedDocument(null);
      setProjectStats(null);
      setProjectGraph(null);
      setMcpDetail(null);
      return;
    }
    void loadProjectWorkspace(selectedProjectId);
  }, [selectedProjectId, showArchivedDocuments]);

  useEffect(() => {
    if (!selectedDocumentId) {
      setSelectedDocument(null);
      setChunks([]);
      setEvents([]);
      setEntities([]);
      return;
    }
    void loadDocumentWorkspace(selectedDocumentId);
  }, [selectedDocumentId]);

  useEffect(() => {
    // V425: setTimeout 链 + in-flight 标志 — 防止慢请求期间 setInterval 反复触发造成请求堆积；
    // 只要队列里还有活跃任务就持续轮询（一轮结束再排下一轮，重试间隔 1000ms）
    let cancelled = false;
    let inFlight = false;
    let timer = 0;
    const poll = () => {
      if (cancelled || inFlight) return;
      const activeJobs = uploadJobs.filter((job) => job.status === "QUEUED" || job.status === "RUNNING");
      if (activeJobs.length === 0) return;
      inFlight = true;
      void pollUploadJobs(activeJobs.map((job) => job.id)).finally(() => {
        inFlight = false;
        if (!cancelled && uploadJobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING")) {
          timer = window.setTimeout(poll, 1000);
        }
      });
    };
    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [uploadJobs]);

  useEffect(() => {
    if (contextPanelMode !== "logs" && !hasActiveUploads && !isSearching && !isMcpRunning) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void syncModelLogs();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [contextPanelMode, hasActiveUploads, isSearching, isMcpRunning]);

  async function bootstrap() {
    try {
      setError("");
      const [projectsResponse, settingsResponse, mcpSettingsResponse, activeJobsResponse] = await Promise.all([
        api.listProjects(showArchivedProjects),
        api.getAiSettings(),
        api.getMcpSettings(),
        api.listActiveUploadJobs()
      ]);
      setProjects(projectsResponse.projects);
      void refreshSessionsForProjects(projectsResponse.projects.map((project) => project.id));
      setAiSettings(settingsResponse.settings);
      setMcpSettings(mcpSettingsResponse.settings);
      // 恢复服务端活跃上传任务（后台脚本/上次刷新创建的 job）→ 轮询自动接管
      if (activeJobsResponse.jobs.length > 0) {
        setUploadJobs((current) => {
          const known = new Set(current.map((job) => job.id));
          const restored = activeJobsResponse.jobs.filter((job) => !known.has(job.id));
          return [...restored, ...current].slice(0, 20);
        });
      }
      const firstActiveProject = projectsResponse.projects.find((project) => !project.archivedAt);
      if (firstActiveProject) {
        setSelectedProjectId(firstActiveProject.id);
      } else {
        setStatus(t("请先创建项目", "Create a project first"));
      }
      await syncModelLogs();
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus(t("加载失败", "Failed to load"));
    }
  }

  async function loadProjects() {
    try {
      const response = await api.listProjects(showArchivedProjects);
      setProjects(response.projects);
      void refreshSessionsForProjects(response.projects.map((project) => project.id));
      if (selectedProjectId && !response.projects.some((project) => project.id === selectedProjectId)) {
        setSelectedProjectId("");
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function loadProjectWorkspace(projectId: string) {
    try {
      setError("");
      const [documentsResponse, sessionsResponse, statsResponse, graphResponse] = await Promise.all([
        api.listDocuments(projectId, showArchivedDocuments),
        api.listMcpSessions(projectId),
        api.getProjectStats(projectId),
        api.getProjectGraph(projectId)
      ]);
      setDocuments(documentsResponse.documents);
      setSessionsByProjectId((current) => ({
        ...current,
        [projectId]: sessionsResponse.sessions
      }));
      setProjectStats(statsResponse.stats);
      setProjectGraph(graphResponse.graph);
      if (documentsResponse.documents[0] && !documentsResponse.documents.some((item) => item.id === selectedDocumentId)) {
        setSelectedDocumentId(documentsResponse.documents[0].id);
      }
      if (!documentsResponse.documents[0]) {
        setSelectedDocumentId("");
      }
      const preferredSessionId = pendingSessionIdRef.current;
      const sessionToOpen = preferredSessionId && sessionsResponse.sessions.some((session) => session.id === preferredSessionId)
        ? preferredSessionId
        : sessionsResponse.sessions[0]?.id;
      pendingSessionIdRef.current = null;
      if (sessionToOpen) {
        await loadMcpSession(sessionToOpen);
      } else {
        setMcpDetail(null);
      }
      setStatus(t("就绪", "Ready"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function loadDocumentWorkspace(documentId: string) {
    try {
      setError("");
      const [documentResponse, chunksResponse, eventsResponse, entitiesResponse] = await Promise.all([
        api.getDocument(documentId),
        api.listChunks(documentId),
        api.listEvents(documentId),
        api.listEntities(documentId)
      ]);
      setSelectedDocument(documentResponse.document);
      setChunks(chunksResponse.chunks);
      setEvents(eventsResponse.events);
      setEntities(entitiesResponse.entities);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function pollUploadJobs(jobIds: string[]) {
    try {
      const responses = await Promise.all(jobIds.map((jobId) => api.getUploadJob(jobId)));
      const latestJobs = responses.map((response) => response.job);
      setUploadJobs((current) => current.map((job) => latestJobs.find((latest) => latest.id === job.id) ?? job));
      // V425: 不再在此重复 syncModelLogs — 上传/日志面板的 653-661 轮询循环统一负责
      const completedJobs = latestJobs.filter((job) => job.status === "COMPLETED" && job.documentId);
      for (const job of completedJobs) {
        if (refreshedUploadJobsRef.current.has(job.id)) {
          continue;
        }
        refreshedUploadJobsRef.current.add(job.id);
        if (selectedProjectId) {
          await loadProjectWorkspace(selectedProjectId);
        }
        if (job.documentId) {
          setSelectedDocumentId(job.documentId);
          setResultView("overview");
        }
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function syncModelLogs() {
    try {
      const response = await api.listModelCallLogs(modelLogCursorRef.current);
      if (response.latestSequence < modelLogCursorRef.current) {
        modelLogCursorRef.current = 0;
        setModelLogCursor(0);
        setModelLogs([]);
        if (response.latestSequence === 0) {
          return;
        }
        const freshResponse = await api.listModelCallLogs(0);
        if (freshResponse.logs.length > 0) {
          setModelLogs(freshResponse.logs.slice(-MAX_BROWSER_MODEL_LOGS));
        }
        modelLogCursorRef.current = freshResponse.latestSequence;
        setModelLogCursor(freshResponse.latestSequence);
        return;
      }
      if (response.logs.length > 0) {
        setModelLogs((current) => mergeModelLogs(current, response.logs));
      }
      if (response.latestSequence > modelLogCursorRef.current) {
        modelLogCursorRef.current = response.latestSequence;
        setModelLogCursor(response.latestSequence);
      }
    } catch (err) {
      console.warn("Failed to sync model logs", err);
    }
  }

  function setActivityPanelMode(mode: ContextPanelMode) {
    setContextPanelMode(mode);
    if (mode === "logs") {
      void syncModelLogs();
    }
  }

  async function refreshSessionsForProjects(projectIds: string[]) {
    const uniqueProjectIds = [...new Set(projectIds.filter(Boolean))];
    if (uniqueProjectIds.length === 0) {
      setSessionsByProjectId({});
      return;
    }
    try {
      const entries = await Promise.all(uniqueProjectIds.map(async (projectId) => {
        const response = await api.listMcpSessions(projectId);
        return [projectId, response.sessions] as const;
      }));
      setSessionsByProjectId((current) => {
        const next = { ...current };
        for (const [projectId, projectSessions] of entries) {
          next[projectId] = projectSessions;
        }
        return next;
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function clearModelLogs() {
    try {
      const response = await api.listModelCallLogs(modelLogCursorRef.current);
      if (response.latestSequence !== modelLogCursorRef.current) {
        modelLogCursorRef.current = response.latestSequence;
        setModelLogCursor(response.latestSequence);
      }
    } catch (err) {
      console.warn("Failed to sync model log cursor before clearing", err);
    }
    setModelLogs([]);
    window.localStorage.removeItem(MODEL_LOGS_STORAGE_KEY);
    window.localStorage.setItem(MODEL_LOG_CURSOR_STORAGE_KEY, String(modelLogCursorRef.current));
    setStatus(t("已清空浏览器缓存中的原始日志", "Raw logs in browser cache have been cleared"));
  }

  // V444: 项目面板边缘拖拽拉伸（ew=横 / ns=纵 / se=对角）
  function dragResize(e: React.MouseEvent, dir: "ew" | "ns" | "se") {
    const panel = document.getElementById("project-panel");
    if (!panel) return;
    const startX = e.clientX, startY = e.clientY;
    const startW = panel.offsetWidth, startH = panel.offsetHeight;
    const onMove = (ev: MouseEvent) => {
      if (dir !== "ns") panel.style.width = Math.max(240, Math.min(480, startW + (ev.clientX - startX))) + "px";
      if (dir !== "ew") panel.style.height = Math.max(260, Math.min(window.innerHeight * 0.85, startH + (ev.clientY - startY))) + "px";
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  async function createProject() {
    const name = newProjectName.trim();
    if (!name) return false;
    try {
      setError("");
      const response = await api.createProject({ name });
      setNewProjectName("");
      await loadProjects();
      setSelectedProjectId(response.project.id);
      // V446: 新建成功后不跳转视图 — 留在当前视图（项目面板原地刷新看到新项目）。
      // 原 setWorkspaceView("home") 会把用户弹回首页（"闪出到首页"）；V444 的"chat 无分支"已由
      // 不跳转解决（项目面板是 overlay，不依赖 workspaceView）
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    }
  }

  async function renameProject(project: SourceRecord, name: string) {
    const nextName = name.trim();
    if (!nextName || nextName === project.name) return false;
    setError("");
    try {
      await api.updateProject(project.id, { name: nextName });
      await loadProjects();
      setStatus(t(`已重命名项目为「${nextName}」。`, `Project renamed to "${nextName}".`));
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    }
  }

  async function archiveOrRestoreProject(project: SourceRecord) {
    const confirmText = project.archivedAt
      ? t(`恢复项目「${project.name}」？`, `Restore project "${project.name}"?`)
      : t(`归档项目「${project.name}」？`, `Archive project "${project.name}"?`);
    if (!window.confirm(confirmText)) return;
    try {
      if (project.archivedAt) {
        await api.restoreProject(project.id);
      } else {
        await api.archiveProject(project.id);
      }
      await loadProjects();
      if (!project.archivedAt && selectedProjectId === project.id) {
        setSelectedProjectId("");
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function permanentlyDeleteProject(project: SourceRecord) {
    const confirmed = window.confirm(t(
      `永久删除项目「${project.name}」？\n\n这会级联删除该项目下的文档、切片、事件、实体和相关关系，且不可恢复。`,
      `Permanently delete project "${project.name}"?\n\nThis will cascade delete documents, chunks, events, entities, and relations under this project. This action cannot be undone.`
    ));
    if (!confirmed) {
      setError("");
      setStatus(t("已取消永久删除项目。", "Permanent project deletion canceled."));
      return;
    }
    try {
      setError("");
      await api.deleteProject(project.id);
      await loadProjects();
      if (selectedProjectId === project.id) {
        setSelectedProjectId("");
      }
      setStatus(t(`已永久删除项目「${project.name}」。`, `Project "${project.name}" has been permanently deleted.`));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function renameDocument(document: DocumentRecord) {
    const title = window.prompt(t("请输入新的文档名称", "Enter a new document name"), document.title)?.trim();
    if (!title || title === document.title) return;
    try {
      await api.updateDocument(document.id, { title });
      await loadProjectWorkspace(document.sourceId);
      if (selectedDocumentId === document.id) {
        await loadDocumentWorkspace(document.id);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function archiveOrRestoreDocument(document: DocumentRecord) {
    const confirmText = document.archivedAt
      ? t(`恢复文档「${document.title}」？`, `Restore document "${document.title}"?`)
      : t(`归档文档「${document.title}」？`, `Archive document "${document.title}"?`);
    if (!window.confirm(confirmText)) return;
    try {
      if (document.archivedAt) {
        await api.restoreDocument(document.id);
      } else {
        await api.archiveDocument(document.id);
      }
      await loadProjectWorkspace(document.sourceId);
      if (!document.archivedAt && selectedDocumentId === document.id) {
        setSelectedDocumentId("");
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function permanentlyDeleteDocument(document: DocumentRecord) {
    const confirmed = window.confirm(t(
      `永久删除文档「${document.title}」？\n\n这会删除相关切片、事件、实体关系，且不可恢复。`,
      `Permanently delete document "${document.title}"?\n\nThis will delete related chunks, event relations, and entity relations. This action cannot be undone.`
    ));
    if (!confirmed) {
      setError("");
      setStatus(t("已取消永久删除文档。", "Permanent document deletion canceled."));
      return;
    }
    try {
      setError("");
      await api.deleteDocument(document.id);
      await loadProjectWorkspace(document.sourceId);
      if (selectedDocumentId === document.id) {
        setSelectedDocumentId("");
      }
      setStatus(t(`已永久删除文档「${document.title}」。`, `Document "${document.title}" has been permanently deleted.`));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleUploadFiles(files: File[]) {
    if (!selectedProjectId) {
      setError(t("请先创建或选择项目，再添加文档。", "Create or select a project before adding documents."));
      return;
    }
    if (files.length === 0) {
      return;
    }
    const invalidFile = files.find((file) => {
      const extension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
      return ![".md", ".txt"].includes(extension) || file.size === 0 || file.size > 5 * 1024 * 1024;
    });
    if (invalidFile) {
      setError(t(
        `文件「${invalidFile.name}」不符合要求：只支持非空 .md/.txt，单个文件不超过 5MB。`,
        `File "${invalidFile.name}" is invalid: only non-empty .md/.txt files up to 5 MB are supported.`
      ));
      return;
    }
    try {
      setError("");
      setStatus(t(`已提交 ${files.length} 个文档处理任务`, `${files.length} document processing job(s) submitted`));
      for (const file of files) {
        setStatus(t(`正在读取：${file.name}`, `Reading: ${file.name}`));
        const content = await file.text();
        const response = await api.createUploadJob({
          sourceId: selectedProjectId,
          title: file.name.replace(/\.[^.]+$/, ""),
          fileName: file.name,
          content
        });
        refreshedUploadJobsRef.current.delete(response.job.id);
        setUploadJobs((current) => [response.job, ...current].slice(0, 20));
      }
      setStatus(t("文档正在处理中", "Documents are being processed"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  function resetProcess(title: string, detail?: string) {
    setContextPanelMode("process");
    setProcessSteps([{
      id: makeStepId("start"),
      title,
      detail,
      status: "running"
    }]);
  }

  function addProcessStep(step: Omit<ProcessStep, "id"> & { id?: string }) {
    setProcessSteps((current) => [...current, {
      id: step.id ?? makeStepId("step"),
      title: step.title,
      detail: step.detail,
      status: step.status,
      payload: step.payload,
      durationMs: step.durationMs
    }]);
  }

  function upsertProcessStep(step: ProcessStep) {
    setProcessSteps((current) => {
      const existingIndex = current.findIndex((item) => item.id === step.id);
      if (existingIndex === -1) {
        return [...current, step];
      }
      return current.map((item, index) => {
        if (index !== existingIndex) return item;
        return {
          ...item,
          title: step.title,
          detail: step.detail,
          status: step.status,
          payload: step.payload ?? item.payload,
          durationMs: step.durationMs ?? item.durationMs
        };
      });
    });
  }

  function finishRunningSteps() {
    setProcessSteps((current) => current.map((step) => (
      step.status === "running" ? { ...step, status: "done" } : step
    )));
  }

  function appendMessageToDetail(message: McpMessageRecord) {
    setMcpDetail((current) => {
      if (!current || current.session.id !== message.sessionId) return current;
      if (current.messages.some((item) => item.id === message.id)) return current;
      return {
        ...current,
        messages: [...current.messages, message]
      };
    });
  }

  function appendToolCallToDetail(toolCall: McpToolCallRecord) {
    setMcpDetail((current) => {
      if (!current || current.session.id !== toolCall.sessionId) return current;
      if (current.toolCalls.some((item) => item.id === toolCall.id)) return current;
      return {
        ...current,
        toolCalls: [...current.toolCalls, toolCall]
      };
    });
  }

  function handleMcpStreamEvent(event: McpStreamEvent) {
    if (event.type === "stage") {
      return;
    }
    if (event.type === "message") {
      appendMessageToDetail(event.message);
      if (event.message.role === "user") {
        setPendingUserMessage("");
      }
      if (event.message.role === "assistant") {
        setStreamingAssistantText("");
      }
      return;
    }
    if (event.type === "assistant_delta") {
      setStreamingAssistantText((current) => current + event.delta);
      return;
    }
    if (event.type === "tool_start") {
      if (event.toolName === "sag_search") {
        setRunningMcpSearches((current) => [
          ...current,
          buildRunningMcpSearch(event.toolName, event.arguments, language)
        ]);
        resetProcess(t("MCP 搜索语句", "MCP search query"), getMcpSearchQuery(event.arguments, language));
        addProcessStep({
          id: "mcp-sag-search-running",
          title: t("MarxSphere 检索执行中", "MarxSphere retrieval is running"),
          detail: t(
            "MCP 工具已发起 sag_search，正在实时接收 SAG 内部检索阶段。",
            "The MCP tool has started sag_search and is receiving SAG internal retrieval stages in real time."
          ),
          status: "running",
          payload: event.arguments
        });
      }
      return;
    }
    if (event.type === "search_progress") {
      upsertProcessStep({
        id: `search-${event.event.key}`,
        title: event.event.title,
        detail: event.event.detail,
        status: event.event.status,
        payload: event.event.payload,
        durationMs: event.event.durationMs
      });
      return;
    }
    if (event.type === "tool_end") {
      appendToolCallToDetail(event.toolCall);
      if (event.toolCall.toolName === "sag_search") {
        if (event.toolCall.status === "FAILED") {
          setProcessSteps([{
            id: makeStepId("sag-search-failed"),
            title: t("MarxSphere 检索失败", "MarxSphere retrieval failed"),
            detail: event.toolCall.error ?? t("工具返回失败", "Tool returned a failure"),
            status: "failed"
          }]);
          return;
        }
        const parsed = parseToolResponse(event.toolCall.result);
        const trace = extractSearchTrace(parsed);
        if (trace) {
          setProcessSteps([
            buildMcpSearchQueryStep(event.toolCall, language),
            ...buildTraceProcessSteps(trace, t("MarxSphere 检索链路", "MarxSphere retrieval trace"), language),
            ...buildMcpSearchResultSteps(parsed, language)
          ]);
        } else {
          setProcessSteps([
            buildMcpSearchQueryStep(event.toolCall, language),
            {
              id: makeStepId("sag-search-no-trace"),
              title: t("MarxSphere 检索链路", "MarxSphere retrieval trace"),
              detail: t("工具返回了检索结果，但没有返回 trace 字段。", "The tool returned retrieval results but did not include a trace field."),
              status: "failed",
              payload: parsed
            }
          ]);
        }
      }
      return;
    }
    if (event.type === "done") {
      if (event.detail) {
        setMcpDetail(event.detail);
      }
      finishRunningSteps();
      setStatus(t("对话完成", "Conversation complete"));
      return;
    }
    if (event.type === "error") {
      addProcessStep({
        title: t("执行失败", "Execution failed"),
        detail: event.message,
        status: "failed"
      });
      setError(event.message);
    }
  }

  function handleSearchStreamEvent(event: SearchStreamEvent) {
    if (event.type === "step") {
      upsertProcessStep({
        id: `search-${event.key}`,
        title: event.title,
        detail: event.detail,
        status: event.status,
        payload: event.payload,
        durationMs: event.durationMs
      });
      return;
    }
    if (event.type === "done") {
      setSearchResult(event.result);
      finishRunningSteps();
      addProcessStep({
        id: "search-complete",
        title: t("检索完成", "Search complete"),
        detail: t(`返回 ${event.result.sections.length} 个切片结果`, `${event.result.sections.length} chunk result(s) returned`),
        status: "done",
        payload: {
          traceId: event.result.traceId,
          sections: event.result.sections.map((section) => ({
            heading: section.heading,
            contentPreview: section.content.slice(0, 160),
            score: section.score,
            rank: section.rank
          }))
        },
        durationMs: searchStartedAtRef.current == null
          ? undefined
          : Math.round(performance.now() - searchStartedAtRef.current)
      });
      setStatus(t("检索完成", "Search complete"));
      return;
    }
    if (event.type === "error") {
      addProcessStep({
        title: t("检索失败", "Search failed"),
        detail: event.message,
        status: "failed"
      });
      setError(event.message);
    }
  }

  async function runSearch() {
    if (!selectedProjectId) {
      setError(t("请先选择项目。", "Select a project first."));
      return;
    }
    if (!searchQuery.trim()) {
      setError(t("请输入检索问题。", "Enter a search question."));
      return;
    }
    setIsSearching(true);
    setSearchResult(null);
    searchStartedAtRef.current = performance.now();
    resetProcess(t("开始检索", "Start search"), searchQuery.trim());
    try {
      setError("");
      await api.streamSearch({
        query: searchQuery.trim(),
        sourceIds: [selectedProjectId],
        searchMode
      }, handleSearchStreamEvent);
      await syncModelLogs();
    } catch (err) {
      await syncModelLogs();
      setError(getErrorMessage(err));
      addProcessStep({
        title: t("检索失败", "Search failed"),
        detail: getErrorMessage(err),
        status: "failed"
      });
    } finally {
      setIsSearching(false);
    }
  }

  async function createMcpSession() {
    if (!selectedProjectId) {
      setError(t("请先选择项目。", "Select a project first."));
      return;
    }
    const response = await api.createMcpSession({ sourceIds: [selectedProjectId] });
    const sessionsResponse = await api.listMcpSessions(selectedProjectId);
    setSessionsByProjectId((current) => ({
      ...current,
      [selectedProjectId]: sessionsResponse.sessions
    }));
    await loadMcpSession(response.session.id);
    setWorkspaceView("chat");
  }

  async function loadMcpSession(sessionId: string) {
    const detail = await api.getMcpSession(sessionId);
    setMcpDetail(detail);
  }

  async function clearCurrentMcpSession() {
    if (!mcpDetail) {
      setError(t("请先选择对话。", "Select a conversation first."));
      return;
    }
    if (!window.confirm(t(
      "清空当前对话记录？\n\n这会删除该会话里的消息和工具调用记录，但会保留会话本身。",
      "Clear the current conversation history?\n\nThis will delete messages and tool call records in this session, while keeping the session itself."
    ))) {
      return;
    }
    try {
      setError("");
      const detail = await api.clearMcpSession(mcpDetail.session.id);
      setMcpDetail(detail);
      setProcessSteps([]);
      setSearchResult(null);
      setStatus(t("对话记录已清空", "Conversation history cleared"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function deleteMcpSessionById(projectId: string, sessionId: string, sessionTitle: string) {
    if (!window.confirm(t(
      `删除对话「${sessionTitle}」？\n\n这会永久删除该会话、消息和工具调用记录，且不可恢复。`,
      `Delete conversation "${sessionTitle}"?\n\nThis will permanently delete the session, messages, and tool call records. This action cannot be undone.`
    ))) {
      return;
    }
    try {
      setError("");
      await api.deleteMcpSession(sessionId);
      const sessionsResponse = await api.listMcpSessions(projectId || undefined);
      if (projectId) {
        setSessionsByProjectId((current) => ({
          ...current,
          [projectId]: sessionsResponse.sessions
        }));
      }
      // 若删除的是当前选中会话，清空详情
      if (mcpDetail?.session.id === sessionId) {
        setMcpDetail(null);
      }
      setStatus(t("已删除对话。", "Conversation deleted."));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function deleteCurrentMcpSession() {
    if (!mcpDetail) {
      setError(t("请先选择对话。", "Select a conversation first."));
      return;
    }
    await deleteMcpSessionById(selectedProjectId || "", mcpDetail.session.id, mcpDetail.session.title);
  }

  async function sendMcpMessage() {
    const content = mcpInput.trim();
    if (!content || !selectedProjectId) return;
    let sessionId = mcpDetail?.session.id;
    const abortController = new AbortController();
    mcpAbortControllerRef.current = abortController;
    setIsMcpRunning(true);
    setPendingUserMessage(content);
    setStreamingAssistantText("");
    setRunningMcpSearches([]);
    setMcpInput("");
    setContextPanelMode("process");
    setProcessSteps([]);
    try {
      setError("");
      if (!sessionId) {
        const response = await api.createMcpSession({ sourceIds: [selectedProjectId] });
        sessionId = response.session.id;
        const sessionsResponse = await api.listMcpSessions(selectedProjectId);
        setSessionsByProjectId((current) => ({
          ...current,
          [selectedProjectId]: sessionsResponse.sessions
        }));
        await loadMcpSession(sessionId);
      }
      await api.streamMcpMessage(sessionId, content, handleMcpStreamEvent, { signal: abortController.signal });
      await syncModelLogs();
      await refreshSessionsForProjects([selectedProjectId]);
    } catch (err) {
      await syncModelLogs();
      if (isAbortError(err)) {
        setStatus(t("已停止生成", "Generation stopped"));
        if (sessionId) {
          await loadMcpSession(sessionId);
          await refreshSessionsForProjects([selectedProjectId]);
        }
        addProcessStep({
          title: t("已停止", "Stopped"),
          detail: t("你手动停止了本轮 MCP 对话。", "You manually stopped this MCP conversation turn."),
          status: "done"
        });
        return;
      }
      setError(getErrorMessage(err));
      addProcessStep({
        title: t("对话失败", "Conversation failed"),
        detail: getErrorMessage(err),
        status: "failed"
      });
    } finally {
      if (mcpAbortControllerRef.current === abortController) {
        mcpAbortControllerRef.current = null;
      }
      setPendingUserMessage("");
      setStreamingAssistantText("");
      setIsMcpRunning(false);
    }
  }

  function stopMcpMessage() {
    if (!isMcpRunning) return;
    setStatus(t("正在停止生成...", "Stopping generation..."));
    mcpAbortControllerRef.current?.abort();
  }

  async function openEventDetail(eventId: string) {
    try {
      setDrawer({ type: "event", detail: await api.getEvent(eventId) });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function openEntityDetail(entityId: string) {
    try {
      setDrawer({ type: "entity", detail: await api.getEntity(entityId) });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function saveAiSettings(input: SettingsInput) {
    setIsSavingSettings(true);
    try {
      setError("");
      const response = await api.updateAiSettings(input);
      setAiSettings(response.settings);
      setStatus(t("设置已保存", "Settings saved"));
      // V415: 就地成功提示（sticky 保存栏上显示）
      setSettingsSaveStatus({ kind: "ok", message: t("✓ 设置已保存", "✓ Settings saved") });
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      // V415: 就地失败提示（白名单 400 等错误直接显示在保存栏旁，不再只看顶部红条）
      setSettingsSaveStatus({ kind: "error", message: t("保存失败：", "Save failed: ") + message });
    } finally {
      setIsSavingSettings(false);
    }
  }

  function toggleSettings() {
    const target: WorkspaceView = workspaceView === "settings" ? "chat" : "settings";
    navigateView(target);
  }

  function toggleProjectExpanded(projectId: string) {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  async function selectProjectSession(projectId: string, sessionId: string) {
    setWorkspaceView("chat");
    setExpandedProjectIds((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
    if (selectedProjectId !== projectId) {
      pendingSessionIdRef.current = sessionId;
      setSelectedProjectId(projectId);
      return;
    }
    pendingSessionIdRef.current = null;
    await loadMcpSession(sessionId);
  }

  const showActivityPanel = workspaceView === "chat" || workspaceView === "reason";
  // 活动面板折叠（finesse 升级：可折叠释放主区域宽度）
  const [activityCollapsed, setActivityCollapsed] = useState(false);

  return (
    <>
      {/* 全局告警 toast（轮询新告警，点击跳转告警中心） */}
      <AlertToast onOpenAlerts={() => navigateView("alerts")} />
      {/* 运行模式徽标（左下角用户菜单上方：收起式小徽标，点击展开切换；不挡内容） */}
      {/* V399: 运行模式/健康状态 — 已移入顶栏（项目按钮左侧） */}
      {/* 宇宙背景层：紫调深空渐变 + 山峰地平线 + 亮星 + 星尘 + 星环（纯CSS必渲染） */}
      <div className="cosmos-bg">
        <div className="cosmos-alpine" />
        <div className="cosmos-ridge" />
        <div className="cosmos-bright-stars" />
        <div className="cosmos-ring" />
        <div className="cosmos-stars" />
        <div className="cosmos-graph-watermark" />
      </div>
      {workspaceView === "home" ? (
        // V396-18: 父容器补 flex-col — HomePanel 的 flex-1 overflow-y-auto 依赖父级 flex 才生效
        <div className="relative z-10 flex h-dvh min-h-0 flex-col overflow-hidden">
          <HomePanel onChangeView={(view) => navigateView(view)} />
        </div>
      ) : workspaceView !== "jupyter" && getRegisteredView(workspaceView) ? (
        // 架构A3: 插件面板（registerView 注册的视图优先渲染；未命中走下方硬编码 switch）
        // 2026-08-27: 插件面板包 ErrorBoundary + 完整布局容器（h-dvh 防空白页）
        (() => {
          const entry = getRegisteredView(workspaceView)!;
          const P = entry.component;
          return (
            <div className="grid h-dvh min-h-0 grid-cols-1 overflow-hidden text-foreground isolate">
              <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
                <header className="relative z-50 flex min-h-16 shrink-0 items-center justify-start gap-3 border-b border-border bg-background/80 px-4 py-2 backdrop-blur-md md:px-6">
                  <button
                    type="button"
                    onClick={() => navigateView("home")}
                    className="flex shrink-0 items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-accent/40"
                  >
                    <SymbolLogo size={28} />
                  </button>
                  <span className="text-sm font-semibold">{entry.label}</span>
                </header>
                <main className="min-h-0 flex-1 overflow-y-auto p-4">
                  <ErrorBoundary>
                    <P />
                  </ErrorBoundary>
                </main>
              </div>
            </div>
          );
        })()
      ) : (
      <div className="grid h-dvh min-h-0 grid-cols-1 overflow-hidden text-foreground isolate">
      {/* V399: 项目列移入顶栏「项目」弹出面板 — 主区域全宽 */}

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <header className="relative z-50 flex min-h-16 shrink-0 items-center justify-start gap-3 border-b border-border bg-background/80 px-4 py-2 backdrop-blur-md md:px-6">
          {/* V399: 品牌区（移出项目面板，顶栏最左；点击回首页） */}
          <button
            type="button"
            onClick={() => navigateView("home")}
            title={t("返回首页", "Back to home")}
            className="flex shrink-0 items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-accent/40"
          >
            <SymbolLogo size={28} />
            <span className="hidden flex-col items-start leading-tight lg:flex">
              <span className="text-sm font-semibold">MarxSphere</span>
              <span className="text-[10px] text-muted-foreground">{t("马理论 AI 科研中枢", "Marxist theory AI research hub")}</span>
            </span>
          </button>
          {workspaceView === "settings" ? null : (
            <MainWorkspaceTabs
              view={workspaceView}
              onChange={(view) => navigateView(view)}
            />
          )}
          {/* V399: 运行模式按钮（项目左侧；弹出健康+切换菜单） */}
          {modeBadge ? (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setModeMenuOpen((v) => !v)}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs text-muted-foreground transition-colors",
                  modeMenuOpen ? "border-primary/50 bg-primary/10 text-foreground" : "border-border/60 hover:border-primary/40 hover:text-foreground"
                )}
                title={modeBadge.health?.label ?? "切换运行模式（重启后生效）"}
              >
                <span className={cn("h-2 w-2 rounded-full",
                  modeBadge.mode === "full" ? "bg-green-500"
                    : modeBadge.mode === "degraded" ? "bg-amber-500"
                    : "bg-blue-500")} />
                {modeBadge.mode === "full" ? "完整"
                  : modeBadge.mode === "degraded" ? "降级"
                  : "预览"}
              </button>
              {modeMenuOpen && (
                <div className="absolute right-0 top-9 z-50 w-60 rounded-lg border border-border bg-background/95 p-2 shadow-xl backdrop-blur">
                  <div className="mb-1.5 px-1 text-[10px] text-muted-foreground">
                    {modeBadge.health?.label ?? "运行模式 · 重启后生效"}
                  </div>
                  {modeBadge.health ? (
                    <div className="mb-1.5 space-y-0.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <span className={cn("h-1.5 w-1.5 rounded-full", modeBadge.health.neo4j.graphiti ? "bg-green-500" : "bg-red-500")} />
                        Graphiti Neo4j {modeBadge.health.neo4j.graphiti ? "在线" : "未连接"}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className={cn("h-1.5 w-1.5 rounded-full", modeBadge.health.neo4j.cognee ? "bg-green-500" : "bg-red-500")} />
                        Cognee Neo4j {modeBadge.health.neo4j.cognee ? "在线" : "未连接"}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className={cn("h-1.5 w-1.5 rounded-full", modeBadge.health.pythonProcesses > 0 ? "bg-green-500" : "bg-red-500")} />
                        Python 进程 {modeBadge.health.pythonProcesses} 个
                      </div>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => { setModeMenuOpen(false); void switchModeTo("preview"); }}
                    className={cn(
                      "flex w-full shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-left text-xs transition-colors",
                      modeBadge.mode === "preview"
                        ? "border-blue-400/50 bg-blue-500/15 text-blue-400"
                        : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", modeBadge.mode === "preview" ? "bg-blue-500" : "bg-muted-foreground/40")} />
                    <div className="min-w-0">
                      <div className="font-medium leading-tight">预览模式</div>
                      <div className="text-[10px] leading-tight text-muted-foreground">省内存 · 无推理/MCP 池</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setModeMenuOpen(false); void switchModeTo("full"); }}
                    className={cn(
                      "mt-1 flex w-full shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-left text-xs transition-colors",
                      modeBadge.mode === "full"
                        ? "border-green-400/50 bg-green-500/15 text-green-400"
                        : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", modeBadge.mode === "full" ? "bg-green-500" : "bg-muted-foreground/40")} />
                    <div className="min-w-0">
                      <div className="font-medium leading-tight">完整模式</div>
                      <div className="text-[10px] leading-tight text-muted-foreground">推理 · MCP 池 {modeBadge.mcpPoolSize} 实例</div>
                    </div>
                  </button>
                </div>
              )}
            </div>
          ) : null}
          {/* V399: 设置按钮（模式/项目之间；原 ProjectRail 移除后补回） */}
          <button
            type="button"
            onClick={toggleSettings}
            title={t("全局设置", "Global settings")}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors",
              workspaceView === "settings" ? "border-primary/50 bg-primary/10 text-foreground" : "border-border/60 hover:border-primary/40 hover:text-foreground"
            )}
          >
            <Settings className="h-4 w-4" />
          </button>
          {/* V399: 顶栏「项目」按钮（原左侧常驻项目列移入弹出面板） */}
          <button
            type="button"
            onClick={() => { setProjectPanelOpen((v) => !v); if (!projectPanelOpen) void loadProjects(); }}
            title={t("项目（文献库）", "Projects")}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs text-muted-foreground transition-colors",
              projectPanelOpen ? "border-primary/50 bg-primary/10 text-foreground" : "border-border/60 hover:border-primary/40 hover:text-foreground"
            )}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            项目
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === "dark" ? t("切换到浅色主题", "Switch to light theme") : t("切换到深色主题", "Switch to dark theme")}
            className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          {/* V399: 登录/用户按钮（主题右侧；未登录显示登录，已登录显示用户名菜单） */}
          <div className="relative shrink-0">
            {authUser ? (
              <>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setUserMenuOpen((v) => !v); }}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-border/60 px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                    {authUser.username.charAt(0).toUpperCase()}
                  </span>
                  <span className="max-w-20 truncate">{authUser.username}</span>
                </button>
                {userMenuOpen ? (
                  <div className="absolute right-0 top-9 z-50 w-52 rounded-lg border border-border bg-background/95 p-2 shadow-xl backdrop-blur" onClick={(e) => e.stopPropagation()}>
                    <div className="border-b border-border/60 px-2 pb-1.5 pt-0.5 text-xs">
                      <div className="font-medium">{authUser.username}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {authUser.role === "admin" ? "管理员" : "普通用户"} · {authUser.plan === "pro" ? "专业版" : authUser.plan === "enterprise" ? "企业版" : "免费版"}
                      </div>
                    </div>
                    {/* V399: 退出登录升级为显眼按钮（图标+红描边） */}
                    <button
                      type="button"
                      onClick={() => { setUserMenuOpen(false); authLogout(); }}
                      className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-red-400/40 bg-red-500/10 px-3 py-2 text-left text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                      退出登录
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <button
                type="button"
                onClick={openLogin}
                className="flex h-8 items-center gap-1.5 rounded-md border border-border/60 px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                <UserRound className="h-3.5 w-3.5" />
                登录
              </button>
            )}
          </div>
        </header>

        {/* V399: 项目弹出面板（顶栏「项目」按钮，替代原左侧常驻列） */}
        {projectPanelOpen ? (
          <div className="relative z-40">
            <div
              className="fixed inset-0 z-30"
              onClick={() => setProjectPanelOpen(false)}
              aria-hidden
            />
            <div id="project-panel" className="absolute left-4 top-1 z-40 w-[300px] min-w-[240px] max-w-[480px] h-[400px] min-h-[260px] max-h-[85vh] overflow-auto rounded-xl border border-border bg-background/95 shadow-xl backdrop-blur">
              {/* V444: 边缘双向箭头手柄 — 右缘 ↔ 横拉、底缘 ↕ 纵拉、角 ⤡ 对角拉 */}
              {/* 右边缘 */}
              <div
                className="absolute -right-[3px] top-0 bottom-0 z-50 w-[6px] cursor-ew-resize"
                style={{ boxShadow: "inset -1px 0 0 rgba(148,163,184,.25)" }}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); dragResize(e, "ew"); }}
              />
              {/* 底边缘 */}
              <div
                className="absolute -bottom-[3px] left-0 right-0 z-50 h-[6px] cursor-ns-resize"
                style={{ boxShadow: "inset 0 -1px 0 rgba(148,163,184,.25)" }}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); dragResize(e, "ns"); }}
              />
              {/* 右下角 */}
              <div
                className="absolute -bottom-[3px] -right-[3px] z-50 h-[12px] w-[12px] cursor-se-resize"
                style={{ background: "linear-gradient(135deg, transparent 50%, rgba(148,163,184,.7) 50%)" }}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); dragResize(e, "se"); }}
              />
              <ProjectRail
                projects={projects}
                selectedProjectId={selectedProjectId}
                sessionsByProjectId={sessionsByProjectId}
                expandedProjectIds={expandedProjectIds}
                selectedSessionId={mcpDetail?.session.id ?? ""}
                isSessionBusy={isMcpRunning}
                isSettingsOpen={workspaceView === "settings"}
                showArchived={showArchivedProjects}
                newProjectName={newProjectName}
                onNewProjectNameChange={setNewProjectName}
                onCreateProject={createProject}
                onSelectProject={(projectId) => {
                  setSelectedProjectId(projectId);
                  setProjectPanelOpen(false);
                  if (workspaceView === "settings") {
                    setWorkspaceView("chat");
                  }
                }}
                onToggleProjectExpanded={toggleProjectExpanded}
                onRenameProject={renameProject}
                onArchiveOrRestoreProject={(project) => void archiveOrRestoreProject(project)}
                onDeleteProject={(project) => void permanentlyDeleteProject(project)}
                onToggleArchived={setShowArchivedProjects}
                onOpenSettings={toggleSettings}
                onCreateSession={() => void createMcpSession()}
                onSelectProjectSession={(projectId, sessionId) => void selectProjectSession(projectId, sessionId)}
                onDeleteSession={(projectId, sessionId) => {
                  const session = sessionsByProjectId[projectId]?.find((s) => s.id === sessionId);
                  void deleteMcpSessionById(projectId, sessionId, session?.title ?? t("对话", "Conversation"));
                }}
                onGoHome={() => { setProjectPanelOpen(false); navigateView("home"); }}
              />
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="border-b border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-red-400 md:px-6">
            {error}
          </div>
        ) : null}

        <div className={cn(
          "grid min-h-0 flex-1 transition-[grid-template-columns] duration-300",
          showActivityPanel && !activityCollapsed
            ? "grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]"
            : "grid-cols-1"
        )}>
          <main key={workspaceView} className="view-fade-in flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-border bg-background">
            {workspaceView === "settings" ? (
              <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
                <SettingsPanel
                  settings={aiSettings}
                  isSaving={isSavingSettings}
                  language={language}
                  languagePreference={languagePreference}
                  onLanguagePreferenceChange={setLanguagePreference}
                  saveStatus={settingsSaveStatus}
                  onSave={(input) => void saveAiSettings(input)}
                />
                <div className="mx-auto mt-4 max-w-4xl">
                  <ApiTokensPanel />
                </div>
              </section>
            ) : workspaceView === "assistant" ? (
              <ChatPanel
                sessions={chatSessions}
                activeSessionId={chatSessionId}
                messages={chatMessages}
                toolCalls={chatToolCalls}
                pendingUserContent={chatPendingUser}
                streamingText={chatStreamingText}
                reasoningText={chatReasoning}
                isRunning={chatIsRunning}
                runningToolName={chatRunningTool}
                model={chatModel}
                webSearch={chatWebSearch}
                deepMode={chatDeepMode}
                reasoningEffort={chatReasoningEffort}
                collapsed={chatCollapsed}
                models={chatModels}
                onSelectSession={selectChatSession}
                onCreateSession={() => void createChatSession()}
                onRenameSession={(sessionId, title) => void renameChatSession(sessionId, title)}
                onDeleteSession={(sessionId) => void deleteChatSession(sessionId)}
                onSend={(content, images, webSearch) => void sendChatMessage(content, images, webSearch)}
                onStop={stopChatMessage}
                onRecall={(messageId) => void recallChatMessage(messageId)}
                onApproveTool={(approvalId, approved) => void approveChatTool(approvalId, approved)}
                approval={chatApproval}
                onModelChange={setChatModel}
                onWebSearchChange={setChatWebSearch}
                onDeepModeChange={setChatDeepMode}
                onReasoningEffortChange={setChatReasoningEffort}
                onToggleCollapsed={() => setChatCollapsed((v) => !v)}
                onOpenCitation={(citation) => setDrawer({ type: "citation", citation })}
                onGoToView={(view) => navigateView(view)}
              />
            ) : workspaceView === "documents" ? (
              <ProjectDocumentsWorkspace
                project={selectedProject}
                documents={visibleDocuments}
                selectedDocumentId={selectedDocumentId}
                selectedDocument={selectedDocument}
                chunks={chunks}
                events={events}
                entities={entities}
                projectStats={projectStats}
                resultView={resultView}
                showArchivedDocuments={showArchivedDocuments}
                hasActiveUploads={hasActiveUploads}
                uploadJobs={uploadJobs}
                isUploadQueueExpanded={isUploadQueueExpanded}
                searchQuery={searchQuery}
                searchMode={searchMode}
                searchResult={searchResult}
                isSearching={isSearching}
                fileInputRef={fileInputRef}
                onUploadFiles={(files) => void handleUploadFiles(files)}
                onToggleUploadQueue={() => setIsUploadQueueExpanded((current) => !current)}
                onSelectDocument={setSelectedDocumentId}
                onRenameDocument={(document) => void renameDocument(document)}
                onArchiveOrRestoreDocument={(document) => void archiveOrRestoreDocument(document)}
                onDeleteDocument={(document) => void permanentlyDeleteDocument(document)}
                onSetResultView={setResultView}
                onToggleArchivedDocuments={setShowArchivedDocuments}
                onSearchQueryChange={setSearchQuery}
                onSearchModeChange={setSearchMode}
                onSearch={() => void runSearch()}
                onOpenEvent={(eventId) => void openEventDetail(eventId)}
                onOpenEntity={(entityId) => void openEntityDetail(entityId)}
              />
            ) : workspaceView === "graph" ? (
              <ProjectGraphWorkspace
                project={selectedProject}
                graph={projectGraph}
                onOpenEvent={(eventId) => void openEventDetail(eventId)}
                onOpenEntity={(entityId) => void openEntityDetail(entityId)}
              />
            ) : workspaceView === "mcp" ? (
              <ProjectMcpWorkspace
                project={selectedProject}
                settings={mcpSettings}
              />
            ) : workspaceView === "reason" ? (
              <ReasonPanel onReasonStart={() => {
                // V214: 推理开始时清空右侧面板——只展示本次推理的搜索过程和原始日志
                setProcessSteps([]);
                setModelLogs([]);
                modelLogCursorRef.current = 0;
                setModelLogCursor(0);
                window.localStorage.removeItem(MODEL_LOG_CURSOR_STORAGE_KEY);
              }} />
            ) : workspaceView === "jobs" ? (
              <JobsPanel />
            ) : workspaceView === "inbox" ? (
              <InboxPanel />
            ) : workspaceView === "tasks" ? (
              <ErrorBoundary><TaskPanel /></ErrorBoundary>
            ) : workspaceView === "agent-console" ? (
              <ErrorBoundary><AgentConsole /></ErrorBoundary>
            ) : workspaceView === "p2o" ? (
              <P2OView />
            ) : workspaceView === "citation-verify" ? (
              <CitationVerifyPanel />
            ) : workspaceView === "cjournal" ? (
              <CJournalPanel />
            ) : workspaceView === "corpus" ? (
              <ErrorBoundary><WritingCorpusPanel /></ErrorBoundary>
            ) : workspaceView === "billing" ? (
              <BillingPanel />
            ) : workspaceView === "admin" ? (
              <AdminPanel />
            ) : workspaceView === "alerts" ? (
              <AlertsPanel />
            ) : workspaceView === "trace" ? (
              <TracePanel />
            ) : workspaceView === "eval" ? (
              <EvalPanel />
            ) : workspaceView === "ask" ? (
              <AskPanel pendingDemo={pendingDemoRef.current} />
            ) : workspaceView === "sciverse" ? (
              <SciversePanel />
            ) : workspaceView === "sources" ? (
              <SourcesPanel />
            ) : workspaceView === "skills" ? (
              <SkillsPanel />
            ) : workspaceView === "docs" ? (
              <DocsPanel />
            ) : workspaceView === "memory" ? (
              <MemoryPanel />
            ) : workspaceView === "policy" ? (
              <PolicyPanel />
            ) : workspaceView === "vault" ? (
              <VaultPanel />
            ) : workspaceView === "truth" ? (
              <TruthPanel />
            ) : workspaceView === "literature" ? (
              <LiteraturePanel />
            ) : workspaceView === "scenarios" ? (
              <ScenariosPanel onChangeView={(view) => navigateView(view)} />
            ) : workspaceView === "education" ? (
              <EducationWorkspacePanel />
            ) : workspaceView === "graphiti-ingest" ? (
              <EngineIngestPanel engine="graphiti" />
            ) : workspaceView === "cognee-ingest" ? (
              <EngineIngestPanel engine="cognee" />
            ) : workspaceView === "empirical-research" ? (
              <EmpiricalResearchPanel />
            ) : workspaceView === "jupyter" ? (
              <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
                <ErrorBoundary><JupyterPanel /></ErrorBoundary>
              </section>
            ) : workspaceView === "imports" ? (
              <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
                <ErrorBoundary><ImportsPanel /></ErrorBoundary>
              </section>
            ) : workspaceView === "structure" ? (
              <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
                <ErrorBoundary><StructurePanel /></ErrorBoundary>
              </section>
            ) : (
              <ConversationWorkspace
                project={selectedProject}
                detail={mcpDetail}
                input={mcpInput}
                isRunning={isMcpRunning}
                pendingUserMessage={pendingUserMessage}
                streamingAssistantText={streamingAssistantText}
                runningMcpSearches={runningMcpSearches}
                onInputChange={setMcpInput}
                onClearSession={() => void clearCurrentMcpSession()}
                onDeleteSession={() => void deleteCurrentMcpSession()}
                onOpenCitation={(citation) => setDrawer({ type: "citation", citation })}
                onStop={() => stopMcpMessage()}
                onSend={() => void sendMcpMessage()}
              />
            )}
          </main>

          {showActivityPanel && !activityCollapsed ? (
            <ActivityPanel
              className="hidden lg:flex"
              mode={contextPanelMode}
              processSteps={processSteps}
              modelLogs={modelLogs}
              onSetMode={setActivityPanelMode}
              onRefreshModelLogs={() => void syncModelLogs()}
              onClearModelLogs={() => void clearModelLogs()}
              onCollapse={() => setActivityCollapsed(true)}
            />
          ) : null}
          {showActivityPanel && activityCollapsed ? (
            <div className="hidden items-center lg:flex">
              <button
                type="button"
                onClick={() => setActivityCollapsed(false)}
                title={t("展开活动面板", "Expand activity panel")}
                className="flex h-10 w-7 items-center justify-center rounded-md border border-border/60 text-muted-foreground/60 transition-colors hover:border-primary/40 hover:text-foreground"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {drawer ? (
        <DetailDrawer
          drawer={drawer}
          onClose={() => setDrawer(null)}
          onOpenEvent={(eventId) => void openEventDetail(eventId)}
          onOpenEntity={(entityId) => void openEntityDetail(entityId)}
        />
      ) : null}
      </div>
      )}
    </>
  );
}

function ProjectRail(props: {
  projects: SourceRecord[];
  selectedProjectId: string;
  sessionsByProjectId: Record<string, McpSessionRecord[]>;
  expandedProjectIds: Set<string>;
  selectedSessionId: string;
  isSessionBusy: boolean;
  isSettingsOpen: boolean;
  showArchived: boolean;
  newProjectName: string;
  onNewProjectNameChange: (value: string) => void;
  onCreateProject: () => Promise<boolean>;
  onSelectProject: (projectId: string) => void;
  onToggleProjectExpanded: (projectId: string) => void;
  onRenameProject: (project: SourceRecord, name: string) => Promise<boolean>;
  onArchiveOrRestoreProject: (project: SourceRecord) => void;
  onDeleteProject: (project: SourceRecord) => void;
  onToggleArchived: (value: boolean) => void;
  onOpenSettings: () => void;
  onCreateSession: () => void;
  onSelectProjectSession: (projectId: string, sessionId: string) => void;
  onDeleteSession: (projectId: string, sessionId: string) => void;
  onGoHome: () => void;
}) {
  const { t } = useI18n();
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);
  // V446: 新建项目失败提示（ProjectRail 内本地 state，避免 setError 作用域问题）
  const [createError, setCreateError] = useState("");
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [renameProjectTarget, setRenameProjectTarget] = useState<SourceRecord | null>(null);
  const [renameProjectName, setRenameProjectName] = useState("");
  const [isRenamingProject, setIsRenamingProject] = useState(false);
  const canCreateProject = props.newProjectName.trim().length > 0 && !isCreatingProject;
  const canRenameProject = Boolean(renameProjectTarget)
    && renameProjectName.trim().length > 0
    && renameProjectName.trim() !== renameProjectTarget?.name
    && !isRenamingProject;

  function openCreateProjectDialog() {
    props.onNewProjectNameChange("");
    setCreateProjectDialogOpen(true);
  }

  function closeCreateProjectDialog() {
    if (isCreatingProject) return;
    props.onNewProjectNameChange("");
    setCreateProjectDialogOpen(false);
  }

  function openRenameProjectDialog(project: SourceRecord) {
    setCreateProjectDialogOpen(false);
    setRenameProjectTarget(project);
    setRenameProjectName(project.name);
  }

  function closeRenameProjectDialog() {
    if (isRenamingProject) return;
    setRenameProjectTarget(null);
    setRenameProjectName("");
  }

  async function submitCreateProject() {
    if (!canCreateProject) return;
    setIsCreatingProject(true);
    try {
      const created = await props.onCreateProject();
      if (created) {
        setCreateProjectDialogOpen(false);
      }
    } catch (err) {
      // V446: 捕获创建失败（原只有 finally，异常向上传播可能触发错误边界/闪退）
      setCreateError(getErrorMessage(err));
      setCreateProjectDialogOpen(false);
    } finally {
      setIsCreatingProject(false);
    }
  }

  async function submitRenameProject() {
    if (!renameProjectTarget || !canRenameProject) return;
    setIsRenamingProject(true);
    try {
      const renamed = await props.onRenameProject(renameProjectTarget, renameProjectName);
      if (renamed) {
        setRenameProjectTarget(null);
        setRenameProjectName("");
      }
    } finally {
      setIsRenamingProject(false);
    }
  }

  return (
    <>
      <aside className="relative z-10 flex h-full min-h-0 flex-col overflow-y-auto border-r border-border scrollbar-thin">
        {/* V399: 品牌区/设置已移入顶栏 — 面板直接以「项目」列表开头 */}

        <div className="flex items-center justify-between px-4 py-3">
          <div className="text-xs font-medium text-muted-foreground">{t("项目", "Projects")}</div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={props.showArchived} onChange={(event) => props.onToggleArchived(event.target.checked)} />
            {t("归档", "Archived")}
          </label>
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3 scrollbar-thin">
          <button
            type="button"
            className="mb-2 flex w-full items-center gap-2 rounded-md border border-dashed border-border bg-background/60 px-3 py-2 text-left text-sm font-medium text-muted-foreground hover:bg-background hover:text-foreground"
            onClick={openCreateProjectDialog}
          >
            <Plus className="h-4 w-4 shrink-0" />
            {t("新建项目", "New project")}
          </button>
          {props.projects.length === 0 ? (
            <EmptyLine text={t("暂无项目，请先新建项目。", "No projects yet. Create a project first.")} />
          ) : props.projects.map((project) => {
          const selected = project.id === props.selectedProjectId;
          const menuOpen = openProjectMenuId === project.id;
          const expanded = props.expandedProjectIds.has(project.id);
          const projectSessions = props.sessionsByProjectId[project.id] ?? [];
          const closeMenu = () => setOpenProjectMenuId(null);
          return (
            <div key={project.id} className={cn("group relative rounded-md", selected && "bg-accent")}>
              <div className="flex items-start gap-1">
                <button
                  type="button"
                  className="ml-1 mt-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                  title={expanded ? t("收起项目对话", "Collapse project conversations") : t("展开项目对话", "Expand project conversations")}
                  aria-label={expanded
                    ? t(`收起项目对话：${project.name}`, `Collapse project conversations: ${project.name}`)
                    : t(`展开项目对话：${project.name}`, `Expand project conversations: ${project.name}`)}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeMenu();
                    props.onToggleProjectExpanded(project.id);
                  }}
                >
                  <ChevronRight className={cn("h-4 w-4 transition-transform", expanded && "rotate-90")} />
                </button>
                <button
                  className="flex min-w-0 flex-1 items-start gap-2 rounded-md py-2 pr-1 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    closeMenu();
                    props.onSelectProject(project.id);
                  }}
                >
                  {expanded || selected ? (
                    <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Folder className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{project.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {project.archivedAt ? t("已归档", "Archived") : shortId(project.id)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={cn(
                    "mr-2 mt-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus:bg-background focus:text-foreground",
                    menuOpen || selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                  title={t("项目操作", "Project actions")}
                  aria-label={t(`项目操作：${project.name}`, `Project actions: ${project.name}`)}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenProjectMenuId((current) => current === project.id ? null : project.id);
                  }}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </div>
              {menuOpen ? (
                <div
                  className="absolute right-2 top-9 z-50 w-28 rounded-md border border-border bg-background p-1 shadow-sm"
                  role="menu"
                >
                  <ProjectMenuItem
                    onClick={() => {
                      closeMenu();
                      openRenameProjectDialog(project);
                    }}
                  >
                    {t("重命名", "Rename")}
                  </ProjectMenuItem>
                  <ProjectMenuItem
                    onClick={() => {
                      closeMenu();
                      props.onArchiveOrRestoreProject(project);
                    }}
                  >
                    {project.archivedAt ? t("恢复", "Restore") : t("归档", "Archive")}
                  </ProjectMenuItem>
                  <ProjectMenuItem
                    danger
                    onClick={() => {
                      closeMenu();
                      props.onDeleteProject(project);
                    }}
                  >
                    {t("永久删除", "Delete forever")}
                  </ProjectMenuItem>
                </div>
              ) : null}
              {expanded && !props.isSettingsOpen ? (
                <div className="space-y-1 pb-2 pl-9 pr-2">
                  {selected ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={props.onCreateSession}
                      disabled={props.isSessionBusy}
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0" />
                      {t("新建对话", "New chat")}
                    </button>
                  ) : null}
                  {projectSessions.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("暂无对话", "No chats")}</div>
                  ) : projectSessions.map((session) => {
                    const sessionSelected = session.id === props.selectedSessionId;
                    return (
                      <button
                        key={session.id}
                        type="button"
                        className={cn(
                          "group/row flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
                          sessionSelected && "bg-accent text-foreground"
                        )}
                        onClick={() => props.onSelectProjectSession(project.id, session.id)}
                        disabled={props.isSessionBusy}
                        title={session.title}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{session.title}</span>
                        </span>
                        {!props.isSessionBusy && (
                          <span
                            role="button"
                            tabIndex={-1}
                            className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive group-hover/row:inline-flex"
                            title={t("删除会话", "Delete session")}
                            onClick={(event) => {
                              event.stopPropagation();
                              props.onDeleteSession(project.id, session.id);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
          })}
        </div>
      </aside>

      {createProjectDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
          {/* V444: resize（双向拉伸）+ overflow-auto（内部滚动）+ 更大默认尺寸 */}
          <div className="w-[520px] max-w-[92vw] h-[300px] max-h-[85vh] min-h-[220px] min-w-[320px] overflow-auto rounded-lg border border-border bg-background p-4 shadow-lg resize" role="dialog" aria-modal="true" aria-labelledby="create-project-title">
            <div id="create-project-title" className="text-sm font-semibold">{t("新建项目", "New project")}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("输入项目名称后创建，文档和对话都会归属到这个项目。", "Enter a project name. Documents and chats will belong to this project.")}</p>
            <Input
              autoFocus
              className="mt-4"
              value={props.newProjectName}
              onChange={(event) => props.onNewProjectNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  closeCreateProjectDialog();
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitCreateProject();
                }
              }}
              placeholder={t("项目名称", "Project name")}
              disabled={isCreatingProject}
            />
            {createError ? <div className="mt-2 text-xs text-red-400">{createError}</div> : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closeCreateProjectDialog} disabled={isCreatingProject}>
                {t("取消", "Cancel")}
              </Button>
              <Button size="sm" onClick={() => void submitCreateProject()} disabled={!canCreateProject}>
                {isCreatingProject ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("确定", "Confirm")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {renameProjectTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
          <div className="w-full max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg" role="dialog" aria-modal="true" aria-labelledby="rename-project-title">
            <div id="rename-project-title" className="text-sm font-semibold">{t("重命名项目", "Rename project")}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("输入新的项目名称。", "Enter a new project name.")}</p>
            <Input
              autoFocus
              className="mt-4"
              value={renameProjectName}
              onChange={(event) => setRenameProjectName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  closeRenameProjectDialog();
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitRenameProject();
                }
              }}
              placeholder={t("项目名称", "Project name")}
              disabled={isRenamingProject}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closeRenameProjectDialog} disabled={isRenamingProject}>
                {t("取消", "Cancel")}
              </Button>
              <Button size="sm" onClick={() => void submitRenameProject()} disabled={!canRenameProject}>
                {isRenamingProject ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("确定", "Confirm")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ProjectMenuItem({ children, danger, onClick }: { children: ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "block w-full rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
        danger && "text-red-600 hover:text-red-700"
      )}
      role="menuitem"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Mega Menu 导航（V397）：34 个 tab 按 7 大分类折叠，悬停展开分类面板 */
type NavCategory = {
  key: string;
  label: string;
  icon: ReactNode;
  dot: string;             // 分类主色（与子项 GROUP_DOTS 同体系）
  items: Array<{ value: Exclude<WorkspaceView, "settings">; label: string }>;
};

function MainWorkspaceTabs(props: {
  view: WorkspaceView;
  onChange: (view: Exclude<WorkspaceView, "settings">) => void;
}) {
  const { t } = useI18n();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  /** 导航分组色点（finesse：分组视觉标识，色相按职能区分；后台/系统组不显示色点更干净） */
  const GROUP_DOTS: Record<string, string> = {
    assistant: "hsl(43 96% 60%)", chat: "hsl(43 96% 60%)", reason: "hsl(43 96% 60%)", ask: "hsl(43 96% 60%)",
    literature: "hsl(150 45% 50%)", sciverse: "hsl(150 45% 50%)", scenarios: "hsl(150 45% 50%)", education: "hsl(160 60% 45%)", "empirical-research": "hsl(160 60% 45%)",
    truth: "hsl(214 60% 55%)", memory: "hsl(214 60% 55%)", documents: "hsl(214 60% 55%)", "graphiti-ingest": "hsl(214 60% 55%)", "cognee-ingest": "hsl(214 60% 55%)", graph: "hsl(214 60% 55%)", sources: "hsl(214 60% 55%)",
    policy: "hsl(28 70% 55%)", vault: "hsl(28 70% 55%)",
    skills: "hsl(280 50% 60%)", mcp: "hsl(280 50% 60%)",
    alerts: "hsl(25 90% 55%)",
    // 后台/系统组（灰）: Jobs/任务/Trace/评测/Inbox/账户计费/运营管理/文档中心
    jobs: "hsl(220 10% 55%)", tasks: "hsl(220 10% 55%)", trace: "hsl(220 10% 55%)", eval: "hsl(220 10% 55%)", inbox: "hsl(220 10% 55%)", billing: "hsl(220 10% 55%)", admin: "hsl(220 10% 55%)", "agent-console": "hsl(220 10% 55%)", docs: "hsl(220 10% 55%)",
    // 科研工具（绿，归文献研究组）: PDF2Obsidian/政经C刊科研/写作语料库
    p2o: "hsl(150 45% 50%)", cjournal: "hsl(150 45% 50%)", corpus: "hsl(150 45% 50%)",
  };

  const categories: NavCategory[] = [
    {
      key: "core",
      label: t("对话推理", "Reasoning"),
      icon: <MessageCircle className="h-3.5 w-3.5" />,
      dot: "hsl(43 96% 60%)",
      items: [
        { value: "assistant", label: t("AI对话", "AI Chat") },
        { value: "chat", label: t("MCP工具检索", "MCP Search") },
        { value: "reason", label: t("推理工作台", "Reason Lab") },
        { value: "ask", label: t("Ask检索", "Ask") },
      ],
    },
    {
      key: "literature",
      label: t("科研中心", "Research"),
      icon: <BookOpen className="h-3.5 w-3.5" />,
      dot: "hsl(150 45% 50%)",
      items: [
        { value: "literature", label: t("文献库", "Library") },
        { value: "sciverse", label: t("外部检索", "Sciverse") },
        { value: "scenarios", label: t("场景", "Scenarios") },
        { value: "education", label: t("教育", "Education") },
        { value: "empirical-research", label: t("实证研究", "Empirical") },
        { value: "jupyter", label: t("Notebook 工作台", "Notebook") },   // 2026-08-27: 轻量 notebook (ScienceX 通用计算)
        { value: "imports", label: t("文献管理", "Imports") },            // 2026-08-27: Zotero/RSS/论文搜索/S3/SSH/双链笔记 (Agentero 对照)
        { value: "structure", label: t("结构解析", "Structure") },        // 2026-08-29: 图/表/公式/算法解析 (Agentero 对照)
        { value: "citation-verify", label: t("引文核验", "Citation Verify") },  // V399: 三维核验 (citation-lab 移植)
        { value: "p2o", label: t("PDF2Obsidian", "PDF2Obsidian") },
        { value: "cjournal", label: t("政经C刊科研", "C-Journal") },
        { value: "corpus", label: t("写作语料库", "Corpus") },
      ],
    },
    {
      key: "knowledge",
      label: t("知识中心", "Knowledge"),
      icon: <Database className="h-3.5 w-3.5" />,
      dot: "hsl(214 60% 55%)",
      items: [
        { value: "truth", label: t("知识页", "Truth") },
        { value: "memory", label: t("记忆", "Memory") },
        { value: "documents", label: t("PG入库", "PG Ingest") },
        { value: "graphiti-ingest", label: t("Graphiti入库", "Graphiti Ingest") },
        { value: "cognee-ingest", label: t("Cognee入库", "Cognee Ingest") },
        { value: "graph", label: t("图谱", "Graph") },
        { value: "sources", label: t("数据源", "Sources") },
      ],
    },
    {
      key: "policy",
      label: t("政策资料", "Archive"),
      icon: <Landmark className="h-3.5 w-3.5" />,
      dot: "hsl(28 70% 55%)",
      items: [
        { value: "policy", label: t("政策库", "Policy") },
        { value: "vault", label: t("资料库", "Vault") },
      ],
    },
    {
      key: "tools",
      label: t("技能工具", "Tools"),
      icon: <Wrench className="h-3.5 w-3.5" />,
      dot: "hsl(280 50% 60%)",
      items: [
        { value: "skills", label: t("技能", "Skills") },
        { value: "mcp", label: "MCP" },
      ],
    },
    {
      key: "system",
      label: t("系统管理", "System"),
      icon: <Boxes className="h-3.5 w-3.5" />,
      dot: "hsl(220 10% 55%)",
      items: [
        { value: "jobs", label: t("Jobs", "Jobs") },
        { value: "tasks", label: t("任务", "Tasks") },
        { value: "agent-console", label: t("Agent控制台", "Agent") },
        { value: "trace", label: t("Trace", "Trace") },
        { value: "eval", label: t("评测", "Eval") },
        { value: "alerts", label: t("告警", "Alerts") },
        { value: "inbox", label: t("Inbox", "Inbox") },
        { value: "billing", label: t("账户计费", "Billing") },
        { value: "admin", label: t("运营管理", "Admin") },
        { value: "docs", label: t("文档中心", "Docs Hub") },
      ],
    },
  ];

  const currentCategory = categories.find((c) => c.items.some((item) => item.value === props.view));

  // 点击外部关闭面板
  useEffect(() => {
    if (!openKey) return;
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current && event.target instanceof Node && !containerRef.current.contains(event.target)) {
        setOpenKey(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openKey]);

  return (
    <div
      ref={containerRef}
      className="flex w-full min-w-0 max-w-full flex-wrap items-center gap-1"
    >
      {categories.map((cat, idx) => {
        const active = currentCategory?.key === cat.key;
        return (
          <div
            key={cat.key}
            className="relative shrink-0"
            onMouseEnter={() => setOpenKey(cat.key)}
            onMouseLeave={() => setOpenKey(null)}
          >
            <button
              type="button"
              className={cn(
                "nav-pill flex items-center gap-1",
                active && "nav-pill-active"
              )}
              onClick={() => setOpenKey(cat.key)}
              aria-haspopup="menu"
              aria-expanded={openKey === cat.key}
            >
              <span
                className="nav-dot"
                style={{ backgroundColor: cat.dot }}
                aria-hidden="true"
              />
              {cat.icon}
              {cat.label}
              <ChevronDown className={cn("h-3 w-3 opacity-60 transition-transform", openKey === cat.key && "rotate-180")} />
            </button>

            {openKey === cat.key ? (
              <div
                className={cn(
                  "mega-menu-panel absolute top-full z-50 min-w-44 max-w-[calc(100vw-16px)] rounded-lg border border-white/10 bg-card pb-2 pl-2 pr-2 pt-2.5 shadow-[0_8px_30px_rgba(0,0,0,0.55)]",
                  // 右侧分类（文档/后台等）面板右对齐，防窄屏右侧溢出；左侧分类左对齐
                  idx >= 4 ? "right-0" : "left-0"
                )}
                role="menu"
              >
                <div className="mb-1.5 flex items-center gap-1.5 border-b border-border/60 px-2 pb-2">
                  <span className="nav-dot" style={{ backgroundColor: cat.dot }} aria-hidden="true" />
                  <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{cat.label}</span>
                </div>
                {cat.items.map((item) => {
                  const isActive = props.view === item.value;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      role="menuitem"
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                        isActive && "bg-accent/60 font-medium text-primary"
                      )}
                      onClick={() => {
                        // 点击子项后保持面板展开（用户要求）
                        props.onChange(item.value);
                      }}
                    >
                      <span
                        className="nav-dot"
                        style={{ backgroundColor: GROUP_DOTS[item.value] || "hsl(220 10% 55%)" }}
                        aria-hidden="true"
                      />
                      {item.label}
                      {isActive ? <ChevronRight className="ml-auto h-3 w-3 text-primary" /> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ConversationWorkspace(props: {
  project: SourceRecord | null;
  detail: McpSessionDetail | null;
  input: string;
  isRunning: boolean;
  pendingUserMessage: string;
  streamingAssistantText: string;
  runningMcpSearches: RunningMcpSearch[];
  onInputChange: (value: string) => void;
  onClearSession: () => void;
  onDeleteSession: () => void;
  onOpenCitation: (citation: AnswerCitation) => void;
  onStop: () => void;
  onSend: () => void;
}) {
  const { t } = useI18n();
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ block: "end" });
  }, [props.detail?.messages.length, props.pendingUserMessage, props.streamingAssistantText, props.isRunning, props.runningMcpSearches.length]);

  if (!props.project) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6">
        <EmptyState title={t("先创建项目", "Create a project first")} description={t("项目是文档、切片、事件、实体和 MCP 对话的共同归属。", "A project contains documents, chunks, events, entities, and MCP chats.")} />
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 md:flex-nowrap md:items-center md:px-6">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{props.detail?.session.title ?? t("新对话", "New chat")}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {props.detail ? `${formatModelName(props.detail.session.model, t)} · ${shortId(props.detail.session.id)}` : t("新建会话后开始测试 MCP 工具", "Create a chat to test MCP tools")}
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={props.onClearSession} disabled={!props.detail || props.isRunning}>
            <RotateCcw className="h-4 w-4" />
            {t("清空记录", "Clear history")}
          </Button>
          <Button variant="outline" size="sm" onClick={props.onDeleteSession} disabled={!props.detail || props.isRunning}>
            <Trash2 className="h-4 w-4" />
            {t("删除对话", "Delete chat")}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {!props.detail || props.detail.messages.length === 0 ? (
            <EmptyState
              icon={<MessageSquare className="h-6 w-6" />}
              title={t("还没有对话", "No conversation yet")}
              description={t("输入问题后，系统会通过 MCP 工具检索当前项目资料。", "Ask a question and the system will retrieve current project documents through MCP tools.")}
            />
          ) : props.detail.messages.map((message, messageIndex) => {
            const citations = getMessageCitations(message);
            const prev = messageIndex > 0 ? props.detail!.messages[messageIndex - 1] : null;
            const showDivider = prev != null && timeGapMinutes(prev.createdAt, message.createdAt) >= 30;
            return (
              <Fragment key={message.id}>
                {showDivider ? (
                  <div className="flex items-center gap-3 py-1" aria-hidden>
                    <div className="h-px flex-1 bg-border" />
                    <span className="shrink-0 text-[11px] text-muted-foreground/70">{formatMessageDate(message.createdAt)}</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                ) : null}
                <div className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
                  <div className={cn(
                    "message-pop-in max-w-[86%] rounded-lg px-3 py-2 text-sm leading-6",
                    message.role === "user" ? "bg-primary text-primary-foreground" : "border border-border bg-muted/35"
                  )}>
                    <div className="mb-1 flex items-center gap-2 text-xs opacity-70">
                      {formatMessageRole(message.role, t)}
                      <span>{formatDate(message.createdAt)}</span>
                    </div>
                    <MarkdownMessage
                      content={formatMessageContent(message.content, t)}
                      citations={citations}
                      onOpenCitation={props.onOpenCitation}
                    />
                    {message.role === "assistant" && citations.length > 0 ? (
                      <CitationStrip citations={citations} onOpenCitation={props.onOpenCitation} />
                    ) : null}
                  </div>
                </div>
              </Fragment>
            );
          })}

          {props.pendingUserMessage ? (
            <div className="flex justify-end">
              <div className="max-w-[86%] rounded-lg bg-primary px-3 py-2 text-sm leading-6 text-primary-foreground">
                <div className="mb-1 flex items-center gap-2 text-xs opacity-70">{t("用户", "User")}</div>
                <MarkdownMessage content={props.pendingUserMessage} />
              </div>
            </div>
          ) : null}

          {props.isRunning ? (
            <div className="flex justify-start">
              <RunningMcpSearchPanel searches={props.runningMcpSearches} />
            </div>
          ) : null}

          {props.streamingAssistantText ? (
            <div className="flex justify-start">
              <div className="max-w-[86%] rounded-lg border border-border bg-muted/35 px-3 py-2 text-sm leading-6">
                <div className="mb-1 flex items-center gap-2 text-xs opacity-70">{t("助手", "Assistant")}</div>
                <MarkdownMessage content={formatMessageContent(props.streamingAssistantText, t)} />
              </div>
            </div>
          ) : null}

          <div ref={scrollAnchorRef} />
        </div>
      </div>

      <div className="shrink-0 border-t border-border bg-background px-4 py-1.5 md:px-6">
        <div className="mx-auto flex max-w-3xl gap-2 rounded-lg border border-border p-2 transition-all duration-150 hover:border-primary/40 hover:shadow-[0_0_16px_hsl(214_55%_55%/0.10)] focus-within:border-primary/60 focus-within:shadow-[0_0_0_3px_hsl(214_55%_55%/0.12),0_0_18px_hsl(214_55%_55%/0.18)]">
          <Textarea
            className="h-10 min-h-10 flex-1 border-0 focus-visible:ring-0"
            value={props.input}
            onChange={(event) => props.onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!props.isRunning && props.input.trim()) {
                  props.onSend();
                }
              }
            }}
            placeholder={t("基于当前项目资料提问...", "Ask about the current project documents...")}
          />
          <Button
            className="self-end"
            variant={props.isRunning ? "destructive" : "default"}
            onClick={props.isRunning ? props.onStop : props.onSend}
            disabled={!props.isRunning && !props.input.trim()}
          >
            {props.isRunning ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            {props.isRunning ? t("停止", "Stop") : t("发送", "Send")}
          </Button>
        </div>
      </div>
    </section>
  );
}

function RunningMcpSearchPanel(props: { searches: RunningMcpSearch[] }) {
  const { t } = useI18n();
  const searchCount = props.searches.length;
  return (
    <div className="max-w-[86%] rounded-lg border border-border bg-muted/35 px-3 py-2 text-sm leading-6">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        <span className="font-medium text-foreground">{t("正在使用 MCP 检索", "Using MCP retrieval")}</span>
        <Badge className="border-border bg-background text-muted-foreground">{t(`${searchCount} 次搜索`, `${searchCount} search(es)`)}</Badge>
      </div>
      {searchCount === 0 ? (
        <div className="text-sm text-muted-foreground">{t("正在分析问题，等待 MCP 搜索语句...", "Analyzing the question and waiting for MCP search queries...")}</div>
      ) : (
        <div className="space-y-1.5">
          {props.searches.map((search, index) => (
            <div key={search.id} className="rounded-md border border-border bg-background/70 px-2.5 py-1.5">
              <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                  {t(`搜索 ${index + 1}：`, `Search ${index + 1}:`)}
                </span>
                <span className="min-w-0 flex-1 break-words text-sm text-foreground">
                  {search.query}
                </span>
              </div>
              {search.searchMode ? (
                <div className="mt-1 text-xs text-muted-foreground">{t("模式", "Mode")}：{search.searchMode}</div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CitationStrip(props: { citations: AnswerCitation[]; onOpenCitation: (citation: AnswerCitation) => void }) {
  const { t } = useI18n();
  return (
    <div className="mt-3 border-t border-border pt-2">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{t("引用原文", "Source citations")}</div>
      <div className="flex flex-wrap gap-1.5">
        {props.citations.map((citation) => (
          <button
            key={`${citation.index}-${citation.chunkId}`}
            type="button"
            className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-background px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            title={citation.heading || citation.chunkId}
            onClick={() => props.onOpenCitation(citation)}
          >
            {citation.index}
          </button>
        ))}
      </div>
    </div>
  );
}

function ProjectDocumentsWorkspace(props: {
  project: SourceRecord | null;
  documents: DocumentRecord[];
  selectedDocumentId: string;
  selectedDocument: DocumentRecord | null;
  chunks: ChunkRecord[];
  events: EventRecord[];
  entities: EntityRecord[];
  projectStats: ProjectStatsRecord | null;
  resultView: ResultView;
  showArchivedDocuments: boolean;
  hasActiveUploads: boolean;
  uploadJobs: UploadJobRecord[];
  isUploadQueueExpanded: boolean;
  searchQuery: string;
  searchMode: SearchMode;
  searchResult: SearchResult | null;
  isSearching: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onUploadFiles: (files: File[]) => void;
  onToggleUploadQueue: () => void;
  onSelectDocument: (documentId: string) => void;
  onRenameDocument: (document: DocumentRecord) => void;
  onArchiveOrRestoreDocument: (document: DocumentRecord) => void;
  onDeleteDocument: (document: DocumentRecord) => void;
  onSetResultView: (view: ResultView) => void;
  onToggleArchivedDocuments: (value: boolean) => void;
  onSearchQueryChange: (value: string) => void;
  onSearchModeChange: (value: SearchMode) => void;
  onSearch: () => void;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  const { language, t } = useI18n();
  const [resultTitleQuery, setResultTitleQuery] = useState("");
  const [resultPage, setResultPage] = useState(1);
  // 论文分享（2026-08-29, frowang /s/:token 分享模式: 生成链接复制发给他人）
  const [shareBusyDocId, setShareBusyDocId] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const searchableResultView = props.resultView === "chunks" || props.resultView === "events" || props.resultView === "entities";
  const normalizedResultTitleQuery = normalizeKeyword(resultTitleQuery);
  const filteredChunks = useMemo(
    () => filterByKeyword(props.chunks, normalizedResultTitleQuery, (chunk) => chunk.heading || t("未命名切片", "Untitled chunk")),
    [normalizedResultTitleQuery, props.chunks]
  );
  const filteredEvents = useMemo(
    () => filterByKeyword(props.events, normalizedResultTitleQuery, (event) => event.title),
    [normalizedResultTitleQuery, props.events]
  );
  const filteredEntities = useMemo(
    () => filterByKeyword(props.entities, normalizedResultTitleQuery, (entity) => entity.name),
    [normalizedResultTitleQuery, props.entities]
  );
  const activeResultCount = props.resultView === "chunks"
    ? filteredChunks.length
    : props.resultView === "events"
      ? filteredEvents.length
      : props.resultView === "entities"
        ? filteredEntities.length
        : 0;
  const activeTotalCount = props.resultView === "chunks"
    ? props.chunks.length
    : props.resultView === "events"
      ? props.events.length
      : props.resultView === "entities"
        ? props.entities.length
        : 0;
  const resultPageCount = Math.max(1, Math.ceil(activeResultCount / DOCUMENT_RESULT_PAGE_SIZE));
  const currentResultPage = Math.min(resultPage, resultPageCount);
  const paginatedChunks = useMemo(
    () => paginateItems(filteredChunks, currentResultPage, DOCUMENT_RESULT_PAGE_SIZE),
    [currentResultPage, filteredChunks]
  );
  const paginatedEvents = useMemo(
    () => paginateItems(filteredEvents, currentResultPage, DOCUMENT_RESULT_PAGE_SIZE),
    [currentResultPage, filteredEvents]
  );
  const paginatedEntities = useMemo(
    () => paginateItems(filteredEntities, currentResultPage, DOCUMENT_RESULT_PAGE_SIZE),
    [currentResultPage, filteredEntities]
  );

  useEffect(() => {
    setResultPage(1);
  }, [normalizedResultTitleQuery, props.resultView, props.selectedDocumentId]);

  // 生成分享链接并复制到剪贴板
  const handleCreateShare = async (documentId: string) => {
    setShareBusyDocId(documentId);
    setShareUrl(null);
    try {
      const r = await api.createPaperShare(documentId);
      const url = `${window.location.origin}${r.url}`;
      setShareUrl(url);
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // 剪贴板不可用时仍展示链接, 用户可手动复制
      }
    } catch (e) {
      setShareUrl(null);
    } finally {
      setShareBusyDocId(null);
    }
  };

  useEffect(() => {
    if (resultPage > resultPageCount) {
      setResultPage(resultPageCount);
    }
  }, [resultPage, resultPageCount]);

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{t("项目文档", "Project documents")}</h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {props.project?.name ?? t("请选择项目", "Select a project")}
            {props.selectedDocument ? ` · ${props.selectedDocument.title}` : ""}
          </p>
        </div>
        {props.project ? (
          <Button size="sm" onClick={() => props.fileInputRef.current?.click()}>
            {props.hasActiveUploads ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {t("添加文档", "Add document")}
          </Button>
        ) : null}
      </div>

      <input
        ref={props.fileInputRef}
        type="file"
        className="hidden"
        multiple
        accept=".md,.txt,text/markdown,text/plain"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.currentTarget.value = "";
          props.onUploadFiles(files);
        }}
      />

      {!props.project ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState title={t("没有项目", "No project")} description={t("创建项目后，才能上传文档并查看处理结果。", "Create a project before uploading documents and viewing processing results.")} />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto border-r border-border p-4 scrollbar-thin">
            <div className="mb-4 grid grid-cols-2 gap-2">
              <Metric label={t("文档", "Documents")} value={props.projectStats?.documentCount ?? props.documents.length} />
              <Metric label={t("切片", "Chunks")} value={props.projectStats?.chunkCount ?? props.chunks.length} />
              <Metric label={t("事件", "Events")} value={props.projectStats?.eventCount ?? props.events.length} />
              <Metric label={t("实体", "Entities")} value={props.projectStats?.entityCount ?? props.entities.length} />
            </div>

            {props.uploadJobs.length > 0 ? (
              <UploadJobsPanel
                jobs={props.uploadJobs}
                expanded={props.isUploadQueueExpanded}
                onToggle={props.onToggleUploadQueue}
              />
            ) : null}

            <PanelSection
              title={t("文档", "Documents")}
              action={(
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={props.showArchivedDocuments}
                    onChange={(event) => props.onToggleArchivedDocuments(event.target.checked)}
                  />
                  {t("归档", "Archived")}
                </label>
              )}
            >
              {props.documents.length === 0 ? (
                <EmptyLine text={t("当前项目还没有文档。", "The current project has no documents yet.")} />
              ) : props.documents.map((document) => (
                <div key={document.id} className={cn("rounded-md border border-border", document.id === props.selectedDocumentId && "bg-accent")}>
                  <button
                    className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm"
                    onClick={() => props.onSelectDocument(document.id)}
                  >
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{document.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {document.archivedAt ? t("已归档", "Archived") : `${document.parseStatus} · ${formatDate(document.createdAt)}`}
                      </span>
                    </span>
                  </button>
                  {document.id === props.selectedDocumentId ? (
                    <div className="flex flex-wrap gap-1 px-3 pb-2">
                      <MiniButton onClick={() => props.onRenameDocument(document)}>{t("重命名", "Rename")}</MiniButton>
                      <MiniButton onClick={() => props.onArchiveOrRestoreDocument(document)}>
                        {document.archivedAt ? t("恢复", "Restore") : t("归档", "Archive")}
                      </MiniButton>
                      <MiniButton danger onClick={() => props.onDeleteDocument(document)}>{t("永久删除", "Delete forever")}</MiniButton>
                      <MiniButton onClick={() => void handleCreateShare(document.id)}>
                        {shareBusyDocId === document.id ? t("生成中…", "Creating…") : t("分享链接", "Share link")}
                      </MiniButton>
                      {shareUrl && shareBusyDocId === null && (
                        <span className="w-full truncate rounded bg-emerald-500/10 px-2 py-1 font-mono text-[11px] text-emerald-700" title={shareUrl}>
                          ✓ {t("已复制: ", "Copied: ")}{shareUrl}
                        </span>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
            </PanelSection>
          </div>

          <div className="min-h-0 overflow-y-auto p-4 scrollbar-thin md:p-6">
            <div className="flex flex-wrap gap-2">
              {(["overview", "chunks", "events", "entities", "search"] as ResultView[]).map((view) => (
                <button
                  key={view}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                    props.resultView === view && "bg-accent text-foreground"
                  )}
                  onClick={() => props.onSetResultView(view)}
                >
                  {resultViewLabel(view, language)}
                </button>
              ))}
            </div>

            <div className="mt-4">
              {searchableResultView ? (
                <ResultTitleSearch
                  label={resultViewLabel(props.resultView, language)}
                  query={resultTitleQuery}
                  totalCount={activeTotalCount}
                  matchedCount={activeResultCount}
                  onQueryChange={setResultTitleQuery}
                  onClear={() => setResultTitleQuery("")}
                />
              ) : null}
              {props.resultView === "overview" ? (
                <OverviewPanel document={props.selectedDocument} chunks={props.chunks} events={props.events} entities={props.entities} />
              ) : null}
              {props.resultView === "chunks" ? <ChunksPanel chunks={paginatedChunks} hasFilter={Boolean(normalizedResultTitleQuery)} /> : null}
              {props.resultView === "events" ? (
                <EventsPanel events={paginatedEvents} hasFilter={Boolean(normalizedResultTitleQuery)} onOpenEvent={props.onOpenEvent} onOpenEntity={props.onOpenEntity} />
              ) : null}
              {props.resultView === "entities" ? (
                <EntitiesPanel entities={paginatedEntities} hasFilter={Boolean(normalizedResultTitleQuery)} onOpenEntity={props.onOpenEntity} />
              ) : null}
              {searchableResultView && activeResultCount > DOCUMENT_RESULT_PAGE_SIZE ? (
                <PaginationControls
                  className="mt-4"
                  page={currentResultPage}
                  pageSize={DOCUMENT_RESULT_PAGE_SIZE}
                  totalCount={activeResultCount}
                  onPageChange={setResultPage}
                />
              ) : null}
              {props.resultView === "search" ? (
                <SearchPanel
                  query={props.searchQuery}
                  searchMode={props.searchMode}
                  result={props.searchResult}
                  isSearching={props.isSearching}
                  onQueryChange={props.onSearchQueryChange}
                  onSearchModeChange={props.onSearchModeChange}
                  onSearch={props.onSearch}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ProjectGraphWorkspace(props: {
  project: SourceRecord | null;
  graph: ProjectGraphRecord | null;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  const { t, language } = useI18n();
  const graph = props.graph;
  const [view, setView] = useState<"graph" | "force" | "quicklink" | "traversal">("graph");
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string>>(new Set());
  // shared canvas：快速建联/遍历的 mini 图数据（实体/事件节点 + 边）
  const [sharedNodes, setSharedNodes] = useState<Array<{ id: string; label: string; kind: "entity" | "event" }>>([]);
  const [sharedEdges, setSharedEdges] = useState<Array<{ source: string; target: string; label?: string }>>([]);

  if (!props.project) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6">
        <EmptyState title={t("先创建项目", "Create a project first")} description={t("项目里有文档、事件和实体后，图谱会在这里显示。", "The graph appears after the project has documents, events, and entities.")} />
      </section>
    );
  }

  const viewTabs: Array<{ value: typeof view; label: string }> = [
    { value: "graph", label: t("图谱", "Graph") },
    { value: "force", label: t("力导向", "Force") },
    { value: "traversal", label: t("关系查询", "Traversal") },
    { value: "quicklink", label: t("快速建联", "Quick links") }
  ];

  const showSharedGraph = (nodes: Array<{ id: string; label: string; kind: "entity" | "event" }>, edges: Array<{ source: string; target: string; label?: string }>) => {
    setSharedNodes(nodes);
    setSharedEdges(edges);
  };

  // 无图谱数据：仅「快速建联」可用（不依赖实体/事件），其余显示空态
  const hasGraph = graph != null && graph.entities.length > 0 && graph.events.length > 0;

  if (!hasGraph) {
    return (
      <section className="flex min-h-0 flex-1 flex-col p-2 md:p-4">
        <div className="mb-2 grid grid-cols-4 gap-0 rounded-md border border-border p-1 text-sm">
          {viewTabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setView(tab.value)}
              className={`rounded px-2 py-1.5 text-center ${view === tab.value ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {view === "quicklink" ? (
          <div className="min-h-0 flex-1">
            <QuickLinkPanel onShowInGraph={(triples) => {
              const nodes: Array<{ id: string; label: string; kind: "entity" | "event" }> = [];
              const edges: Array<{ source: string; target: string; label?: string }> = [];
              const seen = new Set<string>();
              for (const triple of triples) {
                if (!seen.has(triple.subject)) { seen.add(triple.subject); nodes.push({ id: triple.subject, label: triple.subject, kind: "entity" }); }
                if (!seen.has(triple.object)) { seen.add(triple.object); nodes.push({ id: triple.object, label: triple.object, kind: "entity" }); }
                edges.push({ source: triple.subject, target: triple.object, label: triple.relationLabel });
              }
              showSharedGraph(nodes, edges);
            }} />
            {sharedNodes.length > 0 && (
              <MiniGraphView nodes={sharedNodes} edges={sharedEdges} onClose={() => { setSharedNodes([]); setSharedEdges([]); }} />
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6">
            <EmptyState title={t("暂无图谱数据", "No graph data yet")} description={t("上传并完成提取后，可以查看实体、事件和关系。", "Upload documents and finish extraction to view entities, events, and relations.")} />
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col p-2 md:p-4">
      {/* 视图切换 tab */}
      <div className="mb-2 grid grid-cols-4 gap-0 rounded-md border border-border p-1 text-sm">
        {viewTabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setView(tab.value)}
            className={`rounded px-2 py-1.5 text-center ${view === tab.value ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {view === "graph" && (
          <ProjectGraphFlow
            graph={graph}
            language={language}
            highlightedNodeIds={highlightedNodeIds}
            onOpenEvent={props.onOpenEvent}
            onOpenEntity={props.onOpenEntity}
          />
        )}
        {view === "force" && (
          <ForceGraphPanel
            graph={graph}
            language={language}
            onOpenEntity={props.onOpenEntity}
          />
        )}
        {view === "quicklink" && (
          <QuickLinkPanel
            onShowInGraph={(triples) => {
              // 构造 mini 图：三元组 → 节点（subject/object）+ 边（verb）
              const nodes: Array<{ id: string; label: string; kind: "entity" | "event" }> = [];
              const edges: Array<{ source: string; target: string; label?: string }> = [];
              const seen = new Set<string>();
              for (const triple of triples) {
                if (!seen.has(triple.subject)) {
                  seen.add(triple.subject);
                  nodes.push({ id: triple.subject, label: triple.subject, kind: "entity" });
                }
                if (!seen.has(triple.object)) {
                  seen.add(triple.object);
                  nodes.push({ id: triple.object, label: triple.object, kind: "entity" });
                }
                edges.push({ source: triple.subject, target: triple.object, label: triple.relationLabel });
              }
              showSharedGraph(nodes, edges);
            }}
          />
        )}
        {view === "traversal" && (
          <TraversalPanel
            graph={graph}
            onHighlight={(entityIds) => {
              setHighlightedNodeIds(new Set(entityIds));
              setView("graph");
            }}
          />
        )}
        {/* 共享 mini 画布：快速建联结果 → 力导向展示 */}
        {sharedNodes.length > 0 && (
          <MiniGraphView nodes={sharedNodes} edges={sharedEdges} onClose={() => { setSharedNodes([]); setSharedEdges([]); }} />
        )}
      </div>
    </section>
  );
}

/** 迷你力导向视图：快速建联抽取的三元组 → 节点+带标签边 */
function MiniGraphView(props: {
  nodes: Array<{ id: string; label: string; kind: "entity" | "event" }>;
  edges: Array<{ source: string; target: string; label?: string }>;
  onClose: () => void;
}) {
  const flowNodes: Node[] = props.nodes.map((n, index) => ({
    id: n.id,
    position: { x: 60 + (index % 4) * 160, y: 40 + Math.floor(index / 4) * 70 },
    data: { label: n.label },
    style: {
      width: 130,
      borderRadius: 6,
      border: "1px solid #d4d4d8",
      background: n.kind === "entity" ? "#ffffff" : "#f8fafc",
      color: "#111827",
      fontSize: 12,
      fontWeight: 600,
      padding: "8px 10px"
    }
  }));
  const flowEdges: Edge[] = props.edges.map((e, index) => ({
    id: `edge-${index}`,
    source: e.source,
    target: e.target,
    label: e.label ?? "",
    style: { stroke: "#111827", strokeWidth: 1.5 },
    labelStyle: { fontSize: 10, fill: "#6b7280" }
  }));
  return (
    <div className="relative mt-2 h-56 overflow-hidden rounded-lg border border-border bg-background">
      <ReactFlow nodes={flowNodes} edges={flowEdges} fitView fitViewOptions={{ padding: 0.2 }} nodesDraggable nodesConnectable={false} proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <button
        type="button"
        onClick={props.onClose}
        className="absolute right-2 top-2 z-10 rounded-md border border-border bg-background/95 px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
      >
        ✕
      </button>
    </div>
  );
}

function ActivityPanel(props: {
  className?: string;
  mode: ContextPanelMode;
  processSteps: ProcessStep[];
  modelLogs: ModelCallLogRecord[];
  onSetMode: (mode: ContextPanelMode) => void;
  onRefreshModelLogs: () => void;
  onClearModelLogs: () => void;
  /** finesse 升级：面板自身折叠按钮 */
  onCollapse?: () => void;
}) {
  const { t } = useI18n();
  return (
    <aside className={cn("flex min-h-0 flex-col bg-background", props.className)}>
      <div className="border-b border-border p-4">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{contextPanelModeLabel(props.mode, t)}</h2>
            <p className="mt-1 truncate text-xs text-muted-foreground">{t("搜索链路与模型原始调用", "Search trace and raw model calls")}</p>
          </div>
          {props.onCollapse && (
            <button
              type="button"
              onClick={props.onCollapse}
              title={t("折叠面板", "Collapse panel")}
              className="shrink-0 rounded-md border border-border/60 p-1 text-muted-foreground/60 transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 rounded-md border border-border p-1">
          {(["process", "logs"] as ContextPanelMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={cn(
                "rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
                props.mode === mode && "bg-accent text-foreground"
              )}
              onClick={() => props.onSetMode(mode)}
            >
              {contextPanelModeLabel(mode, t)}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
        {props.mode === "logs" ? (
          <RawLogsPanel
            logs={props.modelLogs}
            onRefresh={props.onRefreshModelLogs}
            onClear={props.onClearModelLogs}
          />
        ) : (
          <ProcessPanel steps={props.processSteps} />
        )}
      </div>
    </aside>
  );
}

function ProcessPanel({ steps }: { steps: ProcessStep[] }) {
  const { t } = useI18n();
  if (steps.length === 0) {
    return (
      <EmptyState
        icon={<ListChecks className="h-6 w-6" />}
        title={t("还没有搜索过程", "No search trace yet")}
        description={t("每次对话或检索都会清空这里，并展示新的执行链路。", "Each chat or search clears this panel and shows the latest execution trace.")}
      />
    );
  }

  return (
    <div className="space-y-2">
      {steps.map((step, index) => (
        <Card key={step.id} className={cn(step.status === "failed" && "border-red-400/30 bg-red-500/10")}>
          <CardContent className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px]",
                      step.status === "done" && "bg-green-100 text-green-700",
                      step.status === "failed" && "bg-red-100 text-red-700",
                      step.status === "running" && "bg-primary/15 text-primary",
                      step.status !== "done" && step.status !== "failed" && step.status !== "running" && "bg-muted text-muted-foreground"
                    )}
                  >
                    {step.status === "done" ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : step.status === "failed" ? (
                      <XCircle className="h-3.5 w-3.5" />
                    ) : step.status === "running" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <div className="truncate text-sm font-semibold">{step.title}</div>
                </div>
                {step.detail ? (
                  <div className="mt-1 pl-7 text-xs leading-5 text-muted-foreground">{step.detail}</div>
                ) : null}
              </div>
              <Badge className={processStatusClassName(step.status)}>
                {processStatusLabel(step.status, t)}
              </Badge>
            </div>
            {step.durationMs != null ? (
              <div className="pl-7 text-xs text-muted-foreground">{t(`耗时：${formatDuration(step.durationMs)}`, `Duration: ${formatDuration(step.durationMs)}`)}</div>
            ) : null}
            {step.payload !== undefined ? (
              <div className="pl-7">
                <JsonBlock title={t("数据", "Data")} value={step.payload} compact />
              </div>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function RawLogsPanel(props: {
  logs: ModelCallLogRecord[];
  onRefresh: () => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const latestLogs = [...props.logs].sort((a, b) => b.sequence - a.sequence);
  const RENDER_LIMIT = 30;  // V213: 只渲染最新30条，避免全量渲染卡顿
  const visibleLogs = latestLogs.slice(0, RENDER_LIMIT);
  const llmLogCount = props.logs.filter((log) => log.kind === "llm").length;
  const embeddingLogCount = props.logs.filter((log) => log.kind === "embedding").length;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-xs text-muted-foreground">
          <div>{t(`浏览器缓存 ${props.logs.length} 条`, `Browser cache: ${props.logs.length} item(s)`)}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge className="border-border bg-muted text-muted-foreground">LLM {llmLogCount}</Badge>
            <Badge className="border-border bg-muted text-muted-foreground">Embedding {embeddingLogCount}</Badge>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={props.onRefresh}>
            {t("同步日志", "Sync logs")}
          </Button>
          <Button variant="outline" size="sm" onClick={props.onClear} disabled={props.logs.length === 0}>
            <Trash2 className="h-4 w-4" />
            {t("删除日志", "Delete logs")}
          </Button>
        </div>
      </div>
      {latestLogs.length === 0 ? (
        <EmptyState title={t("暂无原始日志", "No raw logs yet")} description={t("上传、检索或对话触发 LLM / Embedding 后会显示原始请求和返回。", "Raw requests and responses appear after upload, search, or chat triggers LLM / Embedding calls.")} />
      ) : visibleLogs.map((log) => (
        <Card key={log.id} className={cn(log.status === "FAILED" && "border-red-400/30 bg-red-500/10")}>
          <CardContent className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge>{log.kind === "llm" ? "LLM" : "Embedding"}</Badge>
                  <div className="truncate text-sm font-semibold">{log.operation}</div>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  #{log.sequence} · {formatDate(log.createdAt)} · {log.durationMs} {t("毫秒", "ms")}
                </div>
              </div>
              <Badge className={log.status === "FAILED" ? "border-red-400/40 bg-red-500/15 text-red-400" : ""}>
                {log.status === "FAILED" ? t("失败", "Failed") : t("成功", "Succeeded")}
              </Badge>
            </div>
            <JsonBlock title={t("请求", "Request")} value={log.request} compact preserveRaw />
            {log.response !== undefined ? <JsonBlock title={t("返回", "Response")} value={log.response} compact preserveRaw /> : null}
            {log.error ? (
              <div className="rounded-md bg-red-500/10 p-2 text-xs leading-5 text-red-400">{log.error}</div>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function UploadJobsPanel({ jobs, expanded, onToggle }: {
  jobs: UploadJobRecord[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const activeCount = jobs.filter((job) => job.status === "QUEUED" || job.status === "RUNNING").length;
  const completedCount = jobs.filter((job) => job.status === "COMPLETED").length;
  const failedCount = jobs.filter((job) => job.status === "FAILED").length;
  const latestJob = jobs[0];
  return (
    <section className="mb-4">
      <button
        type="button"
        className="mb-2 flex w-full items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-left hover:bg-accent"
        onClick={onToggle}
      >
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">{t("处理队列", "Processing queue")}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {activeCount > 0
              ? t(`${activeCount} 个任务处理中`, `${activeCount} job(s) processing`)
              : t(`已收起：完成 ${completedCount}，失败 ${failedCount}`, `Collapsed: ${completedCount} completed, ${failedCount} failed`)}
            {latestJob ? t(` · 最近：${latestJob.title || latestJob.fileName}`, ` · Latest: ${latestJob.title || latestJob.fileName}`) : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {activeCount > 0 ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
          <Badge>{expanded ? t("收起", "Collapse") : t("展开", "Expand")}</Badge>
        </div>
      </button>
      {expanded ? (
        <div className="space-y-2">
          {jobs.map((job) => (
            <Card key={job.id} className={cn(job.status === "FAILED" && "border-red-400/30 bg-red-500/10")}>
              <CardContent className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{job.title || job.fileName}</div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">{job.fileName}</div>
                  </div>
                  <Badge className={job.status === "FAILED" ? "border-red-400/40 bg-red-500/15 text-red-400" : ""}>
                    {uploadStatusLabel(job.status, t)}
                  </Badge>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full bg-primary transition-all",
                      job.status === "FAILED" && "bg-red-500"
                    )}
                    style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="min-w-0 truncate">{uploadStageLabel(job.stage, t)} · {job.message}</span>
                  <span className="shrink-0">{Math.round(job.progress)}%</span>
                </div>
                {job.totalChunks ? (
                  <div className="text-xs text-muted-foreground">
                    {t(`切片进度：${job.currentChunk ?? 0}/${job.totalChunks}`, `Chunk progress: ${job.currentChunk ?? 0}/${job.totalChunks}`)}
                  </div>
                ) : null}
                {job.status === "COMPLETED" ? (
                  <div className="text-xs text-muted-foreground">
                    {t(`已生成 ${job.chunkCount ?? 0} 个切片，${job.eventCount ?? 0} 个事件`, `Generated ${job.chunkCount ?? 0} chunk(s), ${job.eventCount ?? 0} event(s)`)}
                  </div>
                ) : null}
                {job.error ? (
                  <div className="text-xs text-red-700">{job.error}</div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function OverviewPanel(props: {
  document: DocumentRecord | null;
  chunks: ChunkRecord[];
  events: EventRecord[];
  entities: EntityRecord[];
}) {
  const { t } = useI18n();
  if (!props.document) {
    return <EmptyState title={t("未选择文档", "No document selected")} description={t("选择文档后可查看处理结果。", "Select a document to view processing results.")} />;
  }
  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="space-y-2">
          <div className="text-sm font-semibold">{props.document.title}</div>
          <div className="text-xs text-muted-foreground">{t("处理状态", "Processing status")}：{props.document.parseStatus}</div>
          <div className="text-xs text-muted-foreground">{t("创建时间", "Created at")}：{formatDate(props.document.createdAt)}</div>
        </CardContent>
      </Card>
      <div className="grid grid-cols-3 gap-2">
        <Metric label={t("切片", "Chunks")} value={props.chunks.length} />
        <Metric label={t("事件", "Events")} value={props.events.length} />
        <Metric label={t("实体", "Entities")} value={props.entities.length} />
      </div>
      <Card>
        <CardContent className="space-y-2">
          <div className="text-sm font-semibold">{t("Embedding 状态", "Embedding status")}</div>
          <div className="grid grid-cols-3 gap-2">
            <Metric label={t("切片向量", "Chunk vectors")} value={props.chunks.filter((chunk) => Boolean(chunk.embedding)).length} />
            <Metric label={t("事件向量", "Event vectors")} value={props.events.filter((event) => Boolean(event.titleEmbedding || event.contentEmbedding)).length} />
            <Metric label={t("实体向量", "Entity vectors")} value={props.entities.filter((entity) => Boolean(entity.embedding)).length} />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("列表卡片会显示维度和前 8 位样本，用来确认向量已经真实写入数据库。", "List cards show dimensions and the first 8 sample values to confirm vectors were written to the database.")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function ResultTitleSearch(props: {
  label: string;
  query: string;
  totalCount: number;
  matchedCount: number;
  onQueryChange: (value: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="mb-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 pl-8"
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={t(`按${props.label}标题搜索`, `Search ${props.label} titles`)}
          />
        </div>
        {props.query.trim() ? (
          <Button variant="ghost" size="sm" onClick={props.onClear}>{t("清空", "Clear")}</Button>
        ) : null}
      </div>
      <div className="text-xs text-muted-foreground">
        {props.query.trim()
          ? t(`匹配 ${props.matchedCount}/${props.totalCount}`, `Matched ${props.matchedCount}/${props.totalCount}`)
          : t(`共 ${props.totalCount} 条`, `${props.totalCount} total`)}
      </div>
    </div>
  );
}

function PaginationControls(props: {
  page: number;
  pageSize: number;
  totalCount: number;
  className?: string;
  onPageChange: (page: number) => void;
}) {
  const { t } = useI18n();
  const pageCount = Math.max(1, Math.ceil(props.totalCount / props.pageSize));
  const from = props.totalCount === 0 ? 0 : (props.page - 1) * props.pageSize + 1;
  const to = Math.min(props.page * props.pageSize, props.totalCount);
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3", props.className)}>
      <div className="text-xs text-muted-foreground">
        {t(`第 ${props.page}/${pageCount} 页 · ${from}-${to} / ${props.totalCount} 条`, `Page ${props.page}/${pageCount} · ${from}-${to} / ${props.totalCount}`)}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={props.page <= 1}
          onClick={() => props.onPageChange(Math.max(1, props.page - 1))}
        >
          <ChevronLeft className="h-4 w-4" />
          {t("上一页", "Previous")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={props.page >= pageCount}
          onClick={() => props.onPageChange(Math.min(pageCount, props.page + 1))}
        >
          {t("下一页", "Next")}
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function ChunksPanel({ chunks, hasFilter }: { chunks: ChunkRecord[]; hasFilter?: boolean }) {
  const { t } = useI18n();
  if (chunks.length === 0) {
    return hasFilter
      ? <EmptyState title={t("没有匹配的切片", "No matching chunks")} description={t("换一个标题关键字再试。", "Try another title keyword.")} />
      : <EmptyState title={t("暂无切片", "No chunks yet")} description={t("文档处理后会在这里展示切片。", "Chunks appear here after document processing.")} />;
  }
  return (
    <div className="space-y-2">
      {chunks.map((chunk) => (
        <Card key={chunk.id}>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="truncate text-sm font-medium">{chunk.heading || t("未命名切片", "Untitled chunk")}</div>
              <Badge>{t(`排序 ${chunk.rank}`, `Rank ${chunk.rank}`)}</Badge>
            </div>
            <p className="line-clamp-5 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{chunk.content}</p>
            <EmbeddingPreviewBlock title={t("切片 Embedding", "Chunk Embedding")} preview={chunk.embedding} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function EventsPanel(props: {
  events: EventRecord[];
  hasFilter?: boolean;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  const { t } = useI18n();
  if (props.events.length === 0) {
    return props.hasFilter
      ? <EmptyState title={t("没有匹配的事件", "No matching events")} description={t("换一个标题关键字再试。", "Try another title keyword.")} />
      : <EmptyState title={t("暂无事件", "No events yet")} description={t("开启抽取后，事件会显示关联实体。", "Events and related entities appear after extraction is enabled.")} />;
  }
  return (
    <div className="space-y-2">
      {props.events.map((event) => (
        <Card key={event.id}>
          <CardContent className="space-y-2">
            <button className="w-full text-left text-sm font-semibold hover:underline" onClick={() => props.onOpenEvent(event.id)}>
              {event.title}
            </button>
            <p className="line-clamp-3 text-sm text-muted-foreground">{event.summary || event.content}</p>
            <div className="flex flex-wrap gap-1">
              {(event.entities ?? []).length === 0 ? (
                <Badge>{t(`${event.entityCount ?? 0} 个实体`, `${event.entityCount ?? 0} entities`)}</Badge>
              ) : (event.entities ?? []).map((entity) => (
                <button key={entity.id} onClick={() => props.onOpenEntity(entity.id)}>
                  <Badge>{entity.name}</Badge>
                </button>
              ))}
            </div>
            <div className="grid min-w-0 gap-2">
              <EmbeddingPreviewBlock title={t("标题 Embedding", "Title Embedding")} preview={event.titleEmbedding} />
              <EmbeddingPreviewBlock title={t("内容 Embedding", "Content Embedding")} preview={event.contentEmbedding} />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function EntitiesPanel(props: {
  entities: EntityRecord[];
  hasFilter?: boolean;
  onOpenEntity: (entityId: string) => void;
}) {
  const { t } = useI18n();
  if (props.entities.length === 0) {
    return props.hasFilter
      ? <EmptyState title={t("没有匹配的实体", "No matching entities")} description={t("换一个标题关键字再试。", "Try another title keyword.")} />
      : <EmptyState title={t("暂无实体", "No entities yet")} description={t("事件抽取后会在这里聚合实体。", "Entities are aggregated here after event extraction.")} />;
  }
  return (
    <div className="space-y-2">
      {props.entities.map((entity) => (
        <button key={entity.id} className="w-full min-w-0 max-w-full rounded-md border border-border p-3 text-left hover:bg-accent" onClick={() => props.onOpenEntity(entity.id)}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{entity.name}</div>
              <div className="text-xs text-muted-foreground">{entity.type}</div>
            </div>
            <Badge>{t(`${entity.eventCount ?? 0} 事件`, `${entity.eventCount ?? 0} events`)}</Badge>
          </div>
          <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{entity.description || entity.normalizedName}</p>
          <div className="mt-2 min-w-0">
            <EmbeddingPreviewBlock title={t("实体 Embedding", "Entity Embedding")} preview={entity.embedding} />
          </div>
        </button>
      ))}
    </div>
  );
}

function SearchPanel(props: {
  query: string;
  searchMode: SearchMode;
  result: SearchResult | null;
  isSearching: boolean;
  onQueryChange: (value: string) => void;
  onSearchModeChange: (value: SearchMode) => void;
  onSearch: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/25 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Zap className="h-4 w-4" />
          {t("检索模式", "Search mode")}
        </div>
        <div className="flex rounded-md border border-border bg-background p-0.5">
          {([
            { value: "fast" as const, label: t("极速", "Fast") },
            { value: "standard" as const, label: t("标准", "Standard") }
          ]).map((mode) => (
            <button
              key={mode.value}
              className={cn(
                "rounded px-3 py-1 text-xs text-muted-foreground hover:text-foreground",
                props.searchMode === mode.value && "bg-foreground text-background hover:text-background"
              )}
              onClick={() => props.onSearchModeChange(mode.value)}
              type="button"
            >
              {mode.label}
            </button>
          ))}
        </div>
        <div className="basis-full text-xs text-muted-foreground">
          {props.searchMode === "fast"
            ? t("实体全文匹配 + qwen3-rerank，不走 LLM 过滤。", "Entity full-text matching + qwen3-rerank, without LLM filtering.")
            : t("LLM 抽取查询实体 + LLM 重排，适合对比质量。", "LLM extracts query entities + LLM reranking, useful for quality comparison.")}
        </div>
      </div>
      <div className="flex gap-2">
        <Input value={props.query} onChange={(event) => props.onQueryChange(event.target.value)} placeholder={t("输入检索问题", "Enter a search question")} />
        <Button size="sm" onClick={props.onSearch} disabled={props.isSearching}>
          {props.isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        </Button>
      </div>
      {props.result ? (
        <div className="space-y-2">
          {props.result.sections.map((section) => (
            <Card key={section.chunkId}>
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate text-sm font-medium">{section.heading || t("结果切片", "Result chunk")}</div>
                  <Badge>{typeof section.score === "number" ? section.score.toFixed(3) : "–"}</Badge>
                </div>
                <p className="line-clamp-5 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{section.content}</p>
              </CardContent>
            </Card>
          ))}
          <JsonBlock title={t("检索链路", "Search trace")} value={props.result.trace ?? { traceId: props.result.traceId }} compact />
        </div>
      ) : (
        <EmptyState title={t("还没有检索结果", "No search results yet")} description={t("检索范围固定为当前项目。", "The search scope is fixed to the current project.")} />
      )}
    </div>
  );
}

type SettingsInput = {
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey?: string;
  clearEmbeddingApiKey?: boolean;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string;
  clearLlmApiKey?: boolean;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
};

const DEFAULT_SEARCH_TOP_K = 10;
const DEFAULT_CHUNKING_MODE: ChunkingMode = "heading_strict";
const DEFAULT_CHUNK_TOKEN_LIMIT = 512;
const DEFAULT_CHUNK_OVERLAP_TOKENS = 100;

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.trunc(value), max));
}

function normalizeChunkingMode(value: unknown): ChunkingMode {
  return value === "token" ? "token" : DEFAULT_CHUNKING_MODE;
}

// V438: 按 base URL 推断服务商（设置页下拉回显用）
function providerDetect(baseUrl: string): string {
  if (baseUrl.includes("deepseek")) return "deepseek";
  if (baseUrl.includes("302ai")) return "302ai";
  if (baseUrl.includes("openai")) return "openai";
  return "custom";
}

function SettingsPanel(props: {
  settings: PublicAiProviderSettings | null;
  isSaving: boolean;
  language: SupportedLanguage;
  languagePreference: LanguagePreference;
  onLanguagePreferenceChange: (preference: LanguagePreference) => void;
  onSave: (input: SettingsInput) => void;
  /** V415: 就地保存反馈（成功/失败），替代远处全局 status */
  saveStatus?: { kind: "ok" | "error"; message: string } | null;
}) {
  const { t } = useI18n();
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [embeddingDimensions, setEmbeddingDimensions] = useState(1024);
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [clearEmbeddingApiKey, setClearEmbeddingApiKey] = useState(false);
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [clearLlmApiKey, setClearLlmApiKey] = useState(false);
  const [llmTimeoutMs, setLlmTimeoutMs] = useState(60000);
  const [llmMaxRetries, setLlmMaxRetries] = useState(2);
  const [defaultSearchMode, setDefaultSearchMode] = useState<SearchMode>("fast");
  const [defaultSearchTopK, setDefaultSearchTopK] = useState(10);
  const [defaultChunkingMode, setDefaultChunkingMode] = useState<ChunkingMode>("heading_strict");
  const [chunkTokenLimit, setChunkTokenLimit] = useState(512);
  const [chunkOverlapTokens, setChunkOverlapTokens] = useState(100);
  // V395: Agent 运行时设置(全局沙箱级别/自主级别) — 独立持久化到 /api/agent/settings
  const [agentSandboxProfile, setAgentSandboxProfile] = useState("read-only");
  const [agentAutonomy, setAgentAutonomy] = useState("auto-edit");
  useEffect(() => {
    void fetch("/api/agent/settings").then((r) => r.json()).then((d) => {
      const s = d.settings || {};
      if (s.sandbox_profile) setAgentSandboxProfile(s.sandbox_profile);
      if (s.autonomy) setAgentAutonomy(s.autonomy);
    }).catch(() => {});
  }, []);
  const saveAgentRuntime = (key: string, value: string) => {
    void fetch("/api/agent/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });
  };

  useEffect(() => {
    if (!props.settings) return;
    setEmbeddingBaseUrl(props.settings.embeddingBaseUrl);
    setEmbeddingModel(props.settings.embeddingModel);
    setEmbeddingDimensions(props.settings.embeddingDimensions);
    setEmbeddingApiKey("");
    setClearEmbeddingApiKey(false);
    setLlmBaseUrl(props.settings.llmBaseUrl);
    setLlmModel(props.settings.llmModel);
    setLlmApiKey("");
    setClearLlmApiKey(false);
    setLlmTimeoutMs(props.settings.llmTimeoutMs);
    setLlmMaxRetries(props.settings.llmMaxRetries);
    setDefaultSearchMode(props.settings.defaultSearchMode);
    setDefaultSearchTopK(boundedInteger(props.settings.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, 50));
    setDefaultChunkingMode(normalizeChunkingMode(props.settings.defaultChunkingMode));
    const normalizedTokenLimit = boundedInteger(props.settings.chunkTokenLimit, DEFAULT_CHUNK_TOKEN_LIMIT, 64, 8192);
    setChunkTokenLimit(normalizedTokenLimit);
    setChunkOverlapTokens(
      boundedInteger(props.settings.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, normalizedTokenLimit - 1)
    );
  }, [props.settings]);

  useEffect(() => {
    setChunkOverlapTokens((current) => Math.min(current, Math.max(0, chunkTokenLimit - 1)));
  }, [chunkTokenLimit]);

  if (!props.settings) return <EmptyState title={t("正在加载设置", "Loading settings")} description={t("请稍候。", "Please wait.")} />;

  return (
    <form
      className="mx-auto grid max-w-4xl gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave({
          embeddingBaseUrl,
          embeddingModel,
          embeddingDimensions,
          embeddingApiKey,
          clearEmbeddingApiKey,
          llmBaseUrl,
          llmModel,
          llmApiKey,
          clearLlmApiKey,
          llmTimeoutMs,
          llmMaxRetries,
          defaultSearchMode,
          defaultSearchTopK,
          defaultChunkingMode,
          chunkTokenLimit,
          chunkOverlapTokens
        });
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{t("全局设置", "Global settings")}</h2>
          <p className="text-xs text-muted-foreground">{t("密钥只显示配置状态，不回显明文。", "Keys only show configuration status and are never echoed in plaintext.")}</p>
        </div>
        <div className="text-xs text-muted-foreground">{t("更新于", "Updated")} {formatDate(props.settings.updatedAt)}</div>
      </div>

      <SettingsCard title={t("界面", "Interface")} badge={props.language === "zh" ? "中文" : "English"}>
        <div className="space-y-3 md:col-span-2">
          <div className="text-sm font-medium">{t("界面语言", "Interface language")}</div>
          <div className="flex w-fit rounded-md border border-border bg-background p-0.5">
            {([
              { value: "auto" as const, label: t("自动", "Auto") },
              { value: "zh" as const, label: "中文" },
              { value: "en" as const, label: "English" }
            ]).map((option) => (
              <button
                key={option.value}
                type="button"
                className={cn(
                  "rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground",
                  props.languagePreference === option.value && "bg-foreground text-background hover:text-background"
                )}
                onClick={() => props.onLanguagePreferenceChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            {t(
              `当前显示语言：${props.language === "zh" ? "中文" : "英文"}。自动模式会根据浏览器语言选择。`,
              `Current display language: ${props.language === "zh" ? "Chinese" : "English"}. Auto mode follows the browser language.`
            )}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="AI Provider" badge="302.ai">
        <Field label={t("Embedding 接口地址", "Embedding API base URL")}>
          <Input value={embeddingBaseUrl} onChange={(event) => setEmbeddingBaseUrl(event.target.value)} />
        </Field>
        <Field label={t("Embedding 模型", "Embedding model")}>
          <Input value={embeddingModel} onChange={(event) => setEmbeddingModel(event.target.value)} />
        </Field>
        <Field label={t("向量维度（数据库固定）", "Vector dimensions (database fixed)")}>
          <Input type="number" min={1024} max={1024} value={embeddingDimensions} disabled onChange={(event) => setEmbeddingDimensions(Number(event.target.value))} />
        </Field>
        <Field label={t(`Embedding 密钥：${props.settings.hasEmbeddingApiKey ? "已配置" : "未配置"}`, `Embedding key: ${props.settings.hasEmbeddingApiKey ? "configured" : "not configured"}`)}>
          <Input
            type="password"
            value={embeddingApiKey}
            onChange={(event) => {
              setEmbeddingApiKey(event.target.value);
              if (event.target.value.trim()) setClearEmbeddingApiKey(false);
            }}
            placeholder={t("留空不修改", "Leave blank to keep unchanged")}
          />
        </Field>
        <Field label={t("LLM 服务商（自动填地址+模型）", "LLM provider (auto-fills base URL & model)")}>
          <select
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={providerDetect(llmBaseUrl)}
            onChange={(event) => {
              const v = event.target.value;
              if (v === "302ai") setLlmBaseUrl("https://api.302ai.cn/v1");
              else if (v === "deepseek") setLlmBaseUrl("https://api.deepseek.com/v1");
              else if (v === "openai") setLlmBaseUrl("https://api.openai.com/v1");
              // V449: 服务商联动 — 同步 LLM_MODEL（后端写 .env + 当前进程生效）
              if (v === "deepseek" || v === "302ai") {
                void fetch("/api/llm/provider-sync", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ provider: v }),
                }).catch(() => {});
              }
            }}
          >
            <option value="302ai">阿里云百炼 302AI</option>
            <option value="deepseek">DeepSeek</option>
            <option value="openai">OpenAI 兼容</option>
            <option value="custom">自定义</option>
          </select>
        </Field>
        <Field label={t("LLM 接口地址", "LLM API base URL")}>
          <Input value={llmBaseUrl} onChange={(event) => setLlmBaseUrl(event.target.value)} />
        </Field>
        {/* 2026-08-07 模型注册表：各角色模型选择（替换原单一 LLM 模型文本框） */}
        <Field label={t("LLM 模型（角色配置）", "LLM models (per-role)")}>
          <div className="w-full rounded-md border border-border/70 bg-background/40 p-2">
            <ModelRoleSettings />
          </div>
        </Field>
        <Field label={t("超时毫秒", "Timeout in ms")}>
          <Input type="number" min={1} value={llmTimeoutMs} onChange={(event) => setLlmTimeoutMs(Number(event.target.value))} />
        </Field>
        <Field label={t("重试次数", "Retry count")}>
          <Input type="number" min={0} max={10} value={llmMaxRetries} onChange={(event) => setLlmMaxRetries(Number(event.target.value))} />
        </Field>
        <Field label={t(`LLM 密钥：${props.settings.hasLlmApiKey ? "已配置" : "未配置"}`, `LLM key: ${props.settings.hasLlmApiKey ? "configured" : "not configured"}`)}>
          <Input
            type="password"
            value={llmApiKey}
            onChange={(event) => {
              setLlmApiKey(event.target.value);
              if (event.target.value.trim()) setClearLlmApiKey(false);
            }}
            placeholder={t("留空不修改", "Leave blank to keep unchanged")}
          />
        </Field>
      </SettingsCard>

      <SettingsCard title={t("检索", "Search")} badge={defaultSearchMode === "fast" ? t("极速", "Fast") : t("标准", "Standard")}>
        <div className="space-y-3 md:col-span-2">
          <div className="text-sm font-medium">{t("默认检索模式", "Default search mode")}</div>
          <div className="flex w-fit rounded-md border border-border bg-background p-0.5">
            {([
              { value: "fast" as const, label: t("极速模式", "Fast mode"), description: t("实体全文匹配 + qwen3-rerank，不调用 LLM 抽 key 和过滤。", "Entity full-text matching + qwen3-rerank, without LLM key extraction or filtering.") },
              { value: "standard" as const, label: t("标准模式", "Standard mode"), description: t("LLM 抽取查询实体 + LLM 重排，适合质量对比。", "LLM extracts query entities + LLM reranking, useful for quality comparison.") }
            ]).map((mode) => (
              <button
                key={mode.value}
                type="button"
                className={cn(
                  "rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground",
                  defaultSearchMode === mode.value && "bg-foreground text-background hover:text-background"
                )}
                onClick={() => setDefaultSearchMode(mode.value)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            {defaultSearchMode === "fast"
              ? t("默认使用极速链路：问题直接匹配实体库，最后用 qwen3-rerank 选 top-k。", "Default fast path: match the question directly against the entity store, then use qwen3-rerank to select top-k.")
              : t("默认使用标准链路：先由 LLM 识别查询实体，最后由 LLM 选择候选事件。", "Default standard path: first let the LLM identify query entities, then let the LLM choose candidate events.")}
          </div>
        </div>
        <Field label={t("默认 Top-K", "Default top-k")}>
          <Input
            type="number"
            min={1}
            max={50}
            value={defaultSearchTopK}
            onChange={(event) => setDefaultSearchTopK(Number(event.target.value))}
          />
        </Field>
        <div className="space-y-3 md:col-span-2">
          <div className="text-sm font-medium">{t("默认切片模式", "Default chunking mode")}</div>
          <div className="flex w-fit rounded-md border border-border bg-background p-0.5">
            {([
              { value: "heading_strict" as const, label: t("标题严格", "Heading strict") },
              { value: "token" as const, label: t("Token 强制", "Token window") }
            ]).map((mode) => (
              <button
                key={mode.value}
                type="button"
                className={cn(
                  "rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground",
                  defaultChunkingMode === mode.value && "bg-foreground text-background hover:text-background"
                )}
                onClick={() => setDefaultChunkingMode(mode.value)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            {defaultChunkingMode === "heading_strict"
              ? t("默认与 benchmark 一致：遇到新标题就形成独立切片，不按 token 合并短片段。", "Matches the benchmark default: each heading section becomes an independent chunk without token-based merging.")
              : t("强制按 token 窗口切片，并按 overlap 保留上下文。", "Force token-window chunking and keep context with overlap.")}
          </div>
        </div>
        <Field label={t("Token 数", "Token limit")}>
          <Input
            type="number"
            min={64}
            max={8192}
            value={chunkTokenLimit}
            onChange={(event) => setChunkTokenLimit(Number(event.target.value))}
          />
        </Field>
        <Field label={t("Overlap tokens", "Overlap tokens")}>
          <Input
            type="number"
            min={0}
            max={Math.max(0, chunkTokenLimit - 1)}
            value={chunkOverlapTokens}
            onChange={(event) => setChunkOverlapTokens(Number(event.target.value))}
          />
        </Field>
      </SettingsCard>

      <SettingsCard title={t("危险操作", "Danger zone")} badge={t("谨慎", "Careful")}>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={clearEmbeddingApiKey}
            onChange={(event) => {
              setClearEmbeddingApiKey(event.target.checked);
              if (event.target.checked) setEmbeddingApiKey("");
            }}
          />
          {t("清空 Embedding 密钥", "Clear Embedding key")}
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={clearLlmApiKey}
            onChange={(event) => {
              setClearLlmApiKey(event.target.checked);
              if (event.target.checked) setLlmApiKey("");
            }}
          />
          {t("清空 LLM 密钥", "Clear LLM key")}
        </label>
      </SettingsCard>

      {/* V395: Agent 运行时设置(全局沙箱级别 — 影响整个 AI Agent 工具执行) */}
      <SettingsCard title={t("Agent 运行时", "Agent runtime")} badge={t("全局", "Global")}>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t("沙箱级别控制 AI Agent 代码/命令执行的隔离强度(影响 run_code/run_command 全部工具)", "Sandbox level controls isolation strength for all Agent code/command execution (run_code / run_command)")}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <select
              value={agentSandboxProfile}
              onChange={(e) => { setAgentSandboxProfile(e.target.value); saveAgentRuntime("sandbox_profile", e.target.value); }}
              className="rounded border border-border bg-background px-2 py-1.5 text-sm"
            >
              <option value="read-only">read-only(只读, 默认)</option>
              <option value="workspace-write">workspace-write(工作区可写)</option>
              <option value="full-access">full-access(完全访问, 危险操作门控)</option>
            </select>
            <span className="text-xs text-muted-foreground">
              {agentSandboxProfile === "read-only" ? "禁止一切文件写/网络/进程操作"
                : agentSandboxProfile === "workspace-write" ? "仅允许 agent_workspace 内读写"
                : "完全访问(危险命令默认禁止, 需 sidecar 门控)"}
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <select
              value={agentAutonomy}
              onChange={(e) => { setAgentAutonomy(e.target.value); saveAgentRuntime("autonomy", e.target.value); }}
              className="rounded border border-border bg-background px-2 py-1.5 text-sm"
            >
              <option value="suggest">suggest(建议)</option>
              <option value="auto-edit">auto-edit(自动编辑)</option>
              <option value="full-auto">full-auto(全自动)</option>
            </select>
            <span className="text-xs text-muted-foreground">{t("自主级别: 高危操作的人工介入程度", "Autonomy: human-in-the-loop level for high-risk operations")}</span>
          </label>
        </div>
      </SettingsCard>

      {/* V415: 保存栏 sticky 固定底部 — 长表单滚动时保存按钮始终可见；成功/失败就地提示 */}
      <div className="sticky bottom-2 z-10 mt-2 flex items-center justify-end gap-3 rounded-lg border border-border bg-background/90 px-4 py-3 shadow-lg backdrop-blur">
        {props.saveStatus ? (
          <span className={cn("text-sm", props.saveStatus.kind === "ok" ? "text-emerald-500" : "text-red-400")}>
            {props.saveStatus.message}
          </span>
        ) : null}
        <Button type="submit" disabled={props.isSaving}>
          {props.isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("保存设置", "Save settings")}
        </Button>
      </div>
    </form>
  );
}

function ProjectMcpWorkspace({ project, settings }: { project: SourceRecord | null; settings: PublicMcpSettings | null }) {
  const { t } = useI18n();
  if (!project) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6">
        <EmptyState title={t("先选择项目", "Select a project first")} description={t("MCP server 会绑定到当前项目，选择项目后可查看对应的接入配置和工具说明。", "The MCP server binds to the current project. Select a project to view integration config and tool details.")} />
      </section>
    );
  }
  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto grid max-w-4xl gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{t("项目 MCP", "Project MCP")}</h2>
            <p className="text-xs text-muted-foreground">{t("当前项目 ID 会写入 MCP server 启动配置，工具调用时不再传项目参数。", "The current project ID is written into the MCP server config, so tool calls do not pass project parameters.")}</p>
          </div>
          <Badge>{project.name}</Badge>
        </div>
        <McpSettingsCard project={project} settings={settings} />
        <McpToolsCard />
        {/* W5: MCP 沙箱规则说明 */}
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="mb-1 text-xs font-medium text-amber-700">🛡 MCP 工具沙箱（W5 已启用）</div>
          <div className="space-y-0.5 text-[11px] text-amber-700/80">
            <div>· 网络出口白名单：工具 URL 参数必须命中白名单（拦截私有 IP/云元数据防 SSRF）</div>
            <div>· 文件路径边界：仅允许项目/data/recovery/scripts 目录</div>
            <div>· 子进程 env 裁剪：过滤 AWS/Azure/GitHub 等高危密钥，白名单模式继承</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function McpToolsCard() {
  const { t } = useI18n();
  const [data, setData] = useState<{ servers: Array<{ serverId: string; serverName: string; description: string; tools: string[]; toolDescriptions: Array<{ name: string; desc: string; group: string; schema?: Record<string, { type: string; description: string; required?: boolean }>; example?: Record<string, unknown> }>; connected: boolean }>; total: number } | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState("全部");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedTool, setExpandedTool] = useState<string | null>(null);

  useEffect(() => {
    api.getMcpTools()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
    api.getMcpStatus()
      .then((s) => setStatusMap(s.status))
      .catch(() => {});
  }, []);

  // 过滤：按分组 + 搜索词
  const filteredServers = (data?.servers ?? []).map((server) => {
    const filtered = server.toolDescriptions.filter((tool) => {
      const matchGroup = groupFilter === "全部" || tool.group === groupFilter;
      const matchSearch = !searchQuery.trim()
        || tool.name.toLowerCase().includes(searchQuery.trim().toLowerCase())
        || tool.desc.includes(searchQuery.trim());
      return matchGroup && matchSearch;
    });
    return { ...server, filteredTools: filtered };
  }).filter((server) => server.filteredTools.length > 0);

  const groups = ["全部", "检索", "入库", "管理"];

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{t("MCP 工具大全", "MCP Tools")}</h3>
          <Badge>{data ? `${data.total} 个工具` : ""}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* 筛选下拉 */}
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            {groups.map((g) => <option key={g} value={g}>{g === "全部" ? "全部工具" : `${g}工具`}</option>)}
          </select>
          {/* 搜索框 */}
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("搜索函数名，如 cognee / ingest…", "Search cognee / ingest…")}
            className="w-44 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </CardHeader>
      <CardContent className="!block">
      {loading ? (
        <div className="text-sm text-muted-foreground">{t("正在获取工具列表…", "Loading tools…")}</div>
      ) : error ? (
        <div className="text-sm text-red-600">{error}</div>
      ) : (
        <div className="space-y-4">
          {/* 图例 */}
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_hsl(160_84%_55%)]" /> 工作中
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-muted-foreground/40" /> 未连接
            </span>
          </div>

          {filteredServers.length === 0 && (
            <div className="text-sm text-muted-foreground">{t("无匹配工具", "No matching tools")}</div>
          )}

          {filteredServers.map((server) => {
            const isLive = statusMap[server.serverId] ?? false;
            return (
              <div key={server.serverId} className={cn(
                "rounded-lg border p-3 transition-colors",
                isLive ? "border-emerald-400/40 bg-emerald-400/5" : "border-border"
              )}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "h-2.5 w-2.5 shrink-0 rounded-full",
                      isLive ? "bg-emerald-400 shadow-[0_0_8px_hsl(160_84%_55%/0.9)]" : "bg-muted-foreground/40"
                    )} />
                    <div>
                      <div className="text-sm font-medium">{server.serverName}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{server.description}</div>
                    </div>
                  </div>
                  <span className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-xs",
                    isLive ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"
                  )}>
                    {isLive ? `${server.filteredTools.length} 工具 · 工作中` : `${server.filteredTools.length} 工具`}
                  </span>
                </div>

                {/* 工具列表：可展开卡片（SAG 风格） */}
                <div className="mt-3 space-y-1.5">
                  {server.filteredTools.map((tool) => {
                    const toolKey = `${server.serverId}:${tool.name}`;
                    const isExpanded = expandedTool === toolKey;
                    return (
                      <div key={toolKey} className={cn("rounded-md border border-border", isExpanded && "border-foreground/30 bg-muted/20")}>
                        <button
                          type="button"
                          className="flex w-full items-start gap-2 p-2.5 text-left"
                          aria-expanded={isExpanded}
                          onClick={() => setExpandedTool(isExpanded ? null : toolKey)}
                        >
                          <ChevronRight className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", isExpanded && "rotate-90")} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-semibold text-foreground">{tool.name}</span>
                              <span className="rounded bg-accent px-1 py-0.5 text-[10px] font-medium text-muted-foreground">{tool.group}</span>
                            </div>
                            <div className="mt-0.5 text-xs text-muted-foreground">{tool.desc}</div>
                          </div>
                          <span className="shrink-0 text-xs text-muted-foreground">{isExpanded ? "收起" : "展开"}</span>
                        </button>
                        {isExpanded && (
                          <div className="space-y-2 border-t border-border p-2.5">
                            {tool.schema && Object.keys(tool.schema).length > 0 && (
                              <JsonBlock title={t("输入参数 Schema", "Input schema")} value={tool.schema} compact preserveRaw />
                            )}
                            {tool.example && (
                              <JsonBlock title={t("调用示例", "Call example")} value={tool.example} compact preserveRaw />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      </CardContent>
    </Card>
  );
}

function McpSettingsCard({ project, settings }: { project: SourceRecord; settings: PublicMcpSettings | null }) {
  const { t } = useI18n();
  const [expandedToolName, setExpandedToolName] = useState<string | null>(null);

  if (!settings) {
    return (
      <SettingsCard title="MCP" badge={t("加载中", "Loading")}>
        <div className="text-sm text-muted-foreground">{t("正在加载 MCP 信息。", "Loading MCP information.")}</div>
      </SettingsCard>
    );
  }
  const externalClientConfig = settings.clientConfigs.find((clientConfig) => clientConfig.id === "stdio-npm")
    ?? settings.clientConfigs[0]
    ?? null;
  const externalClientConfigValue = externalClientConfig
    ? replaceMcpProjectPlaceholder(externalClientConfig.config, project.id)
    : null;
  return (
    <SettingsCard title="MCP" badge={t("自动可用", "Auto available")}>
      <PanelInfo
        label={t("当前项目", "Current project")}
        value={`${project.name} / ${project.id}`}
        multiline
      />
      <PanelInfo
        label={t("项目绑定", "Project binding")}
        value={t("MCP server 启动时读取 SAG_MCP_SOURCE_ID，所有工具默认只访问这个项目。", "The MCP server reads SAG_MCP_SOURCE_ID at startup, and all tools access only this project by default.")}
        multiline
      />
      <PanelInfo label={t("工具超时", "Tool timeout")} value={t(`${settings.toolTimeoutMs} 毫秒`, `${settings.toolTimeoutMs} ms`)} />
      {externalClientConfig && externalClientConfigValue ? (
        <div className="space-y-3 md:col-span-2">
          <div>
            <div className="text-xs font-medium text-muted-foreground">mcpServers JSON</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("复制给其他 Agent 后会直接绑定当前项目；切换项目后这里会自动换成对应项目 ID。", "Copy this to another agent to bind directly to the current project. Switching projects updates the project ID automatically.")}
            </div>
          </div>
          <CopyableCodeBlock
            label={t("JSON 配置", "JSON config")}
            value={JSON.stringify(externalClientConfigValue, null, 2) ?? ""}
          />
        </div>
      ) : null}
      <div className="md:col-span-2">
        <div className="mb-2 text-xs font-medium text-muted-foreground">{t("可用工具", "Available tools")}</div>
        <div className="grid gap-2">
          {settings.tools.map((tool) => (
            <McpToolCard
              key={tool.name}
              tool={tool}
              expanded={expandedToolName === tool.name}
              onToggle={() => setExpandedToolName((current) => current === tool.name ? null : tool.name)}
            />
          ))}
        </div>
      </div>
    </SettingsCard>
  );
}

function replaceMcpProjectPlaceholder(value: unknown, projectId: string): unknown {
  if (typeof value === "string") {
    return value === "__SAG_LITE_PROJECT_ID__" ? projectId : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceMcpProjectPlaceholder(item, projectId));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceMcpProjectPlaceholder(item, projectId)])
    );
  }
  return value;
}

function McpToolCard({
  tool,
  expanded,
  onToggle
}: {
  tool: PublicMcpSettings["tools"][number];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={cn("rounded-md border border-border", expanded && "border-foreground/30 bg-muted/20")}>
      <button
        type="button"
        className="flex w-full items-start gap-3 p-3 text-left"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <ChevronRight className={cn("mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{tool.name}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{tool.description}</div>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{expanded ? t("收起", "Collapse") : t("展开", "Expand")}</span>
      </button>
      {expanded ? (
        <div className="space-y-3 border-t border-border p-3 pt-3">
          <JsonBlock title={t("输入参数 Schema", "Input schema")} value={tool.inputSchema} compact preserveRaw />
          <JsonBlock title={t("调用示例", "Call example")} value={tool.example} compact preserveRaw />
        </div>
      ) : null}
    </div>
  );
}

function CopyableCodeBlock({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? t("已复制", "Copied") : t("复制", "Copy")}
        </Button>
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs leading-5">
        {value}
      </pre>
    </div>
  );
}

function DetailDrawer(props: {
  drawer: Exclude<DetailDrawer, null>;
  onClose: () => void;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  const { t } = useI18n();
  const drawer = props.drawer;
  return (
    <div className="fixed inset-0 z-20 bg-black/20" role="presentation" onClick={props.onClose}>
      <aside
        className="absolute inset-y-0 right-0 flex w-full max-w-[440px] flex-col border-l border-border bg-background shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">
              {drawer.type === "event"
                ? drawer.detail.event.title
                : drawer.type === "entity"
                  ? drawer.detail.entity.name
                  : t(`引用 ${drawer.citation.index}`, `Citation ${drawer.citation.index}`)}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {drawer.type === "event"
                ? t("事件详情", "Event details")
                : drawer.type === "entity"
                  ? t("实体详情", "Entity details")
                  : t("引用原文", "Source citation")}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={props.onClose}>{t("关闭", "Close")}</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
          {drawer.type === "event" ? (
            <EventDetailPanel detail={drawer.detail} onOpenEntity={props.onOpenEntity} />
          ) : drawer.type === "entity" ? (
            <EntityDetailPanel detail={drawer.detail} onOpenEvent={props.onOpenEvent} />
          ) : (
            <CitationDetailPanel citation={drawer.citation} />
          )}
        </div>
      </aside>
    </div>
  );
}

function EventDetailPanel({ detail, onOpenEntity }: { detail: EventDetailRecord; onOpenEntity: (entityId: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <PanelInfo label={t("所属文档", "Source document")} value={detail.document?.title ?? t("未知文档", "Unknown document")} />
      <PanelInfo label={t("事件内容", "Event content")} value={detail.event.content || detail.event.summary} multiline />
      <PanelSection title={t("关联实体", "Related entities")}>
        <div className="flex flex-wrap gap-2">
          {detail.entities.length === 0 ? <EmptyLine text={t("暂无关联实体。", "No related entities.")} /> : detail.entities.map((entity) => (
            <button key={entity.id} onClick={() => onOpenEntity(entity.id)}>
              <Badge>{entity.name}</Badge>
            </button>
          ))}
        </div>
      </PanelSection>
      <PanelSection title={t("关联切片", "Related chunk")}>
        {detail.chunk ? (
          <Card>
            <CardContent>
              <div className="mb-2 text-xs text-muted-foreground">{detail.chunk.heading || t(`排序 ${detail.chunk.rank ?? 0}`, `Rank ${detail.chunk.rank ?? 0}`)}</div>
              <p className="whitespace-pre-wrap text-sm leading-6">{detail.chunk.content}</p>
            </CardContent>
          </Card>
        ) : <EmptyLine text={t("没有关联切片。", "No related chunk.")} />}
      </PanelSection>
    </div>
  );
}

function EntityDetailPanel({ detail, onOpenEvent }: { detail: EntityDetailRecord; onOpenEvent: (eventId: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <PanelInfo label={t("类型", "Type")} value={detail.entity.type} />
      <PanelInfo label={t("描述", "Description")} value={detail.entity.description || detail.entity.normalizedName} multiline />
      <PanelSection title={t(`关联事件（${detail.events.length}）`, `Related events (${detail.events.length})`)}>
        <div className="space-y-2">
          {detail.events.length === 0 ? <EmptyLine text={t("暂无关联事件。", "No related events.")} /> : detail.events.map((event) => (
            <button key={event.id} className="w-full rounded-md border border-border p-3 text-left hover:bg-accent" onClick={() => onOpenEvent(event.id)}>
              <div className="text-sm font-medium">{event.title}</div>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{event.summary || event.content}</p>
            </button>
          ))}
        </div>
      </PanelSection>
    </div>
  );
}

function CitationDetailPanel({ citation }: { citation: AnswerCitation }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <PanelInfo label={t("切片标题", "Chunk title")} value={citation.heading || t(`引用 ${citation.index}`, `Citation ${citation.index}`)} />
      <div className="grid grid-cols-2 gap-3">
        <PanelInfo label={t("排序", "Rank")} value={citation.rank == null ? "-" : String(citation.rank)} />
        <PanelInfo label={t("得分", "Score")} value={citation.score == null ? "-" : citation.score.toFixed(4)} />
      </div>
      {citation.query ? <PanelInfo label={t("搜索语句", "Search query")} value={citation.query} multiline /> : null}
      <PanelInfo label={t("切片 ID", "Chunk ID")} value={citation.chunkId} />
      {citation.documentId ? <PanelInfo label={t("文档 ID", "Document ID")} value={citation.documentId} /> : null}
      <PanelSection title={t("原文块", "Original chunk")}>
        <Card>
          <CardContent>
            <p className="whitespace-pre-wrap break-words text-sm leading-6">{citation.content}</p>
          </CardContent>
        </Card>
      </PanelSection>
    </div>
  );
}

/** 2026-08-07 模型注册表：各角色模型配置（设置页用，复用 /api/llm/models） */
function ModelRoleSettings() {
  const [models, setModels] = useState<any[]>([]);
  const [roleMap, setRoleMap] = useState<Record<string, string>>({});
  useEffect(() => {
    fetch("/api/llm/models")
      .then((r) => r.json())
      .then((d) => {
        setModels(d.models || []);
        setRoleMap(d.roleMap || {});
      })
      .catch(() => {});
  }, []);
  const ROLE_LABELS: Record<string, string> = {
    reason: "推理合成", judge: "评测打分", review: "评审", plan: "规划", verify: "题型复核", strategy: "策略决策",
  };
  const setRole = async (role: string, modelId: string) => {
    await fetch("/api/llm/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, modelId }),
    });
    setRoleMap((prev) => ({ ...prev, [role]: modelId }));
  };
  return (
    <div className="space-y-1.5">
      <div className="mb-1 text-[10px] text-muted-foreground">可用模型：{models.map((m) => m.id).join(" / ")}</div>
      {Object.entries(ROLE_LABELS).map(([role, label]) => (
        <div key={role} className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
          <select
            value={roleMap[role] || "deepseek-chat"}
            onChange={(e) => void setRole(role, e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.id}</option>
            ))}
          </select>
        </div>
      ))}
      <div className="mt-1 text-[10px] text-muted-foreground/70">切换立即生效：推理/评测/评审/规划/复核/策略各自独立选模型</div>
    </div>
  );
}

function SettingsCard({ title, badge, children }: { title: string; badge: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge>{badge}</Badge>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">{children}</CardContent>
    </Card>
  );
}

function PanelSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {action}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function PanelInfo({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn("break-words text-sm", multiline && "whitespace-pre-wrap leading-6")}>{value}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-muted/35 px-2 py-2">
      <div className="text-base font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function MiniButton({ children, danger, onClick }: { children: ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "rounded px-2 py-1 text-xs text-muted-foreground hover:bg-background hover:text-foreground",
        danger && "text-red-600 hover:text-red-700"
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

function EmbeddingPreviewBlock({ title, preview }: { title: string; preview?: EmbeddingPreview | null }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-muted/30 p-2 text-left">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">{title}</span>
        <Badge className="shrink-0">{preview ? t(`${preview.dimensions} 维`, `${preview.dimensions} dims`) : t("未生成", "Not generated")}</Badge>
      </div>
      {preview ? (
        <code className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
          [{preview.sample.map((value) => formatEmbeddingNumber(value)).join(", ")}{preview.dimensions > preview.sample.length ? ", ..." : ""}]
        </code>
      ) : (
        <div className="text-xs text-muted-foreground">{t("数据库中还没有这个向量。", "This vector is not in the database yet.")}</div>
      )}
    </div>
  );
}

function getMessageCitations(message: McpMessageRecord): AnswerCitation[] {
  const value = message.metadata.citations;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeAnswerCitation)
    .filter((citation): citation is AnswerCitation => citation !== null)
    .slice(0, 5);
}

function normalizeAnswerCitation(value: unknown): AnswerCitation | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const index = typeof value.index === "number" ? value.index : Number(value.index);
  const chunkId = typeof value.chunkId === "string" ? value.chunkId : "";
  const sourceId = typeof value.sourceId === "string" ? value.sourceId : "";
  const content = typeof value.content === "string" ? value.content : "";
  if (!Number.isInteger(index) || index <= 0 || !chunkId || !sourceId || !content) {
    return null;
  }
  return {
    index,
    chunkId,
    sourceId,
    documentId: typeof value.documentId === "string" ? value.documentId : undefined,
    heading: typeof value.heading === "string" ? value.heading : undefined,
    content,
    rank: typeof value.rank === "number" ? value.rank : undefined,
    score: typeof value.score === "number" ? value.score : undefined,
    query: typeof value.query === "string" ? value.query : undefined
  };
}

function JsonBlock({ title, value, compact, preserveRaw }: { title: string; value: unknown; compact?: boolean; preserveRaw?: boolean }) {
  const { t } = useI18n();
  const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const renderedValue = preserveRaw ? content : formatDataContent(content, t);
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      <pre className={cn("overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs leading-5", compact ? "max-h-64" : "max-h-96")}>
        {renderedValue}
      </pre>
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div className="rounded-md px-3 py-2 text-xs text-muted-foreground">{text}</div>;
}

function EmptyState({ title, description, icon }: { title: string; description: string; icon?: ReactNode }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-border p-6 text-center">
      {icon ? <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent/30 text-primary/70">{icon}</div> : null}
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</div>
    </div>
  );
}

function resultViewLabel(view: ResultView, language: SupportedLanguage) {
  if (view === "overview") return language === "en" ? "Overview" : "概览";
  if (view === "chunks") return language === "en" ? "Chunks" : "切片";
  if (view === "events") return language === "en" ? "Events" : "事件";
  if (view === "entities") return language === "en" ? "Entities" : "实体";
  return language === "en" ? "Search" : "检索";
}

function filterByKeyword<T>(items: T[], keyword: string, getTitle: (item: T) => string) {
  if (!keyword) return items;
  return items.filter((item) => normalizeKeyword(getTitle(item)).includes(keyword));
}

function paginateItems<T>(items: T[], page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  return items.slice(offset, offset + pageSize);
}

function normalizeKeyword(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function contextPanelModeLabel(mode: ContextPanelMode, t: (zh: string, en: string) => string) {
  if (mode === "process") return t("搜索过程", "Search trace");
  return t("原始日志", "Raw logs");
}

function loadStoredModelLogs(): ModelCallLogRecord[] {
  try {
    const raw = window.localStorage.getItem(MODEL_LOGS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ModelCallLogRecord[];
    return Array.isArray(parsed) ? parsed.slice(-MAX_BROWSER_MODEL_LOGS) : [];
  } catch {
    return [];
  }
}

function loadStoredModelLogCursor(): number {
  const raw = window.localStorage.getItem(MODEL_LOG_CURSOR_STORAGE_KEY);
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function mergeModelLogs(current: ModelCallLogRecord[], incoming: ModelCallLogRecord[]): ModelCallLogRecord[] {
  const byId = new Map<string, ModelCallLogRecord>();
  for (const log of [...current, ...incoming]) {
    byId.set(log.id, log);
  }
  return [...byId.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-MAX_BROWSER_MODEL_LOGS);
}

function persistModelLogs(logs: ModelCallLogRecord[]) {
  for (const limit of [MAX_BROWSER_MODEL_LOGS, 100, 50, 20]) {
    try {
      window.localStorage.setItem(MODEL_LOGS_STORAGE_KEY, JSON.stringify(logs.slice(-limit)));
      return;
    } catch {
      // localStorage may exceed quota because embedding responses contain full vectors.
    }
  }
  try {
    window.localStorage.removeItem(MODEL_LOGS_STORAGE_KEY);
  } catch {
    // Ignore storage failures; logs are diagnostic-only.
  }
}

function uploadStatusLabel(status: UploadJobRecord["status"], t: (zh: string, en: string) => string) {
  if (status === "QUEUED") return t("排队中", "Queued");
  if (status === "RUNNING") return t("处理中", "Processing");
  if (status === "COMPLETED") return t("完成", "Completed");
  return t("失败", "Failed");
}

function uploadStageLabel(stage: UploadJobRecord["stage"], t: (zh: string, en: string) => string) {
  if (stage === "QUEUED") return t("排队", "Queued");
  if (stage === "READING") return t("读取文件", "Reading file");
  if (stage === "PARSING") return t("解析文档", "Parsing document");
  if (stage === "CHUNKING") return t("生成切片", "Generating chunks");
  if (stage === "EMBEDDING_CHUNKS") return t("切片向量化", "Embedding chunks");
  if (stage === "EXTRACTING_EVENTS") return t("抽取事件", "Extracting events");
  if (stage === "EMBEDDING_EVENTS") return t("事件与实体向量化", "Embedding events and entities");
  if (stage === "WRITING_GRAPH") return t("写入图谱", "Writing graph");
  if (stage === "COMPLETED") return t("处理完成", "Completed");
  return t("处理失败", "Failed");
}

function processStatusLabel(status: ProcessStepStatus, t: (zh: string, en: string) => string) {
  if (status === "running") return t("运行中", "Running");
  if (status === "failed") return t("失败", "Failed");
  return t("完成", "Done");
}

function processStatusClassName(status: ProcessStepStatus) {
  if (status === "failed") return "border-red-400/40 bg-red-500/15 text-red-400";
  if (status === "running") return "border-blue-400/50 bg-blue-500/15 text-blue-400";
  return "";
}

function makeStepId(prefix: string) {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${randomId}`;
}

function buildSearchProcessSteps(result: SearchResult, language: SupportedLanguage): ProcessStep[] {
  const trace = result.trace ?? { traceId: result.traceId };
  const t = (zh: string, en: string) => language === "en" ? en : zh;
  return [
    {
      id: makeStepId("search-start"),
      title: t("开始检索", "Start search"),
      detail: t(
        `查询：${searchTraceText(trace, "query") ?? "当前问题"}；模式：${searchModeLabel(searchTraceText(trace, "searchMode"), language)}`,
        `Query: ${searchTraceText(trace, "query") ?? "current question"}; mode: ${searchModeLabel(searchTraceText(trace, "searchMode"), language)}`
      ),
      status: "done"
    },
    ...buildTraceProcessSteps(trace, t("检索链路", "Search trace"), language),
    {
      id: makeStepId("search-result"),
      title: t("生成结果", "Generate results"),
      detail: t(`返回 ${result.sections.length} 个切片结果`, `${result.sections.length} chunk result(s) returned`),
      status: "done",
      payload: {
        traceId: result.traceId,
        sections: result.sections.map((section) => ({
          chunkId: section.chunkId,
          heading: section.heading,
          score: section.score,
          rank: section.rank
        }))
      }
    }
  ];
}

function buildTraceProcessSteps(trace: unknown, groupTitle: string, language: SupportedLanguage): ProcessStep[] {
  const t = (zh: string, en: string) => language === "en" ? en : zh;
  const record = isPlainRecord(trace) ? trace : {};
  const timings = isPlainRecord(record.timings) ? record.timings : {};
  const orderedSteps: Array<{
    key: string;
    title: string;
    detail: string;
    payload?: unknown;
  }> = [
    {
      key: "queryEmbedding",
      title: t("查询向量化", "Query embedding"),
      detail: t("把用户问题转成向量，用于召回相关事件和切片。", "Convert the user question into a vector for recalling related events and chunks.")
    },
    {
      key: "step1Bm25Entities",
      title: t("BM25 匹配查询实体", "BM25 match query entities"),
      detail: countSummary(record.recalledEntities, t("个实体", "entities"), language),
      payload: record.recalledEntities
    },
    {
      key: "step1ExtractEntities",
      title: t("抽取查询实体", "Extract query entities"),
      detail: entitySummary(record.queryEntities, language),
      payload: record.queryEntities
    },
    {
      key: "step2RetrieveEntities",
      title: t("召回相关实体", "Retrieve related entities"),
      detail: countSummary(record.recalledEntities, t("个实体", "entities"), language),
      payload: record.recalledEntities
    },
    {
      key: "step3EntityEvents",
      title: t("实体关联事件", "Entity-linked events"),
      detail: countSummary(record.entityEvents ?? record.entityEventIds, t("个事件", "events"), language),
      payload: eventPayload(record, "entityEvents", "entityEventIds")
    },
    {
      key: "step3QueryEvents",
      title: t("标题向量召回事件", "Title-vector event recall"),
      detail: countSummary(record.queryEvents ?? record.queryEventIds, t("个事件", "events"), language),
      payload: eventPayload(record, "queryEvents", "queryEventIds")
    },
    {
      key: "step4FetchDetails",
      title: t("读取候选事件详情", "Fetch candidate event details"),
      detail: countSummary(record.eventSnapshots, t("个候选事件", "candidate events"), language),
      payload: record.eventSnapshots
    },
    {
      key: "step5Expand",
      title: t("事件扩展", "Event expansion"),
      detail: countSummary(record.expandedEvents ?? record.expandedEventIds, t("个事件", "events"), language),
      payload: eventPayload(record, "expandedEvents", "expandedEventIds")
    },
    {
      key: "step6CoarseRank",
      title: t("粗排事件", "Coarse-rank events"),
      detail: countSummary(record.coarseRankedEvents ?? record.coarseRankedEventIds, t("个候选", "candidates"), language),
      payload: eventPayload(record, "coarseRankedEvents", "coarseRankedEventIds")
    },
    {
      key: "step7LlmRerank",
      title: t("LLM 重排", "LLM rerank"),
      detail: countSummary(record.rerankedEvents ?? record.rerankedEventIds, t("个候选", "candidates"), language),
      payload: eventPayload(record, "rerankedEvents", "rerankedEventIds")
    },
    {
      key: "step7RerankModel",
      title: t("Rerank 模型重排", "Rerank model rerank"),
      detail: countSummary(record.rerankedEvents ?? record.rerankedEventIds, t("个候选", "candidates"), language),
      payload: eventPayload(record, "rerankedEvents", "rerankedEventIds")
    },
    {
      key: "step8FetchChunks",
      title: t("回取关联切片", "Fetch related chunks"),
      detail: t("读取最终事件关联的原文切片，作为回答上下文。", "Fetch original chunks linked to the final events as answer context.")
    }
  ];

  const steps: ProcessStep[] = orderedSteps
    .filter((step) => step.key in timings || step.payload !== undefined)
    .map((step) => ({
      id: makeStepId(step.key),
      title: step.title,
      detail: step.detail,
      status: "done" as const,
      durationMs: numberOrNull(timings[step.key]),
      payload: step.payload
    }));

  const fallbackReason = searchTraceText(record, "fallbackReason");
  if (fallbackReason) {
    steps.push({
      id: makeStepId("fallback"),
      title: t("降级路径", "Fallback path"),
      detail: fallbackReason,
      status: "done"
    });
  }

  if (steps.length === 0) {
    steps.push({
      id: makeStepId("trace"),
      title: groupTitle,
      detail: t("工具返回了链路数据，但没有包含可拆解的阶段字段。", "The tool returned trace data but did not include decomposable stage fields."),
      status: "done",
      payload: trace
    });
  }

  return steps;
}

function buildToolProcessPayload(toolCall: McpToolCallRecord, language: SupportedLanguage) {
  return {
    [language === "en" ? "arguments" : "参数"]: toolCall.arguments,
    [language === "en" ? "result" : "结果"]: parseToolResponse(toolCall.result),
    [language === "en" ? "error" : "错误"]: toolCall.error ?? undefined
  };
}

function buildRunningMcpSearch(toolName: string, args: Record<string, unknown>, language: SupportedLanguage): RunningMcpSearch {
  const query = typeof args.query === "string" && args.query.trim()
    ? args.query.trim()
    : language === "en" ? `${toolName} did not provide a query argument` : `${toolName} 未提供 query 参数`;
  const searchMode = typeof args.searchMode === "string" ? searchModeLabel(args.searchMode, language) : undefined;
  return {
    id: makeStepId("running-mcp-search"),
    toolName,
    query,
    searchMode
  };
}

function getMcpSearchQuery(args: Record<string, unknown>, language: SupportedLanguage) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const mode = typeof args.searchMode === "string"
    ? language === "en" ? `; mode: ${searchModeLabel(args.searchMode, language)}` : `；模式：${searchModeLabel(args.searchMode, language)}`
    : "";
  return query
    ? `query: ${query}${mode}`
    : language === "en" ? "MCP called sag_search, but the arguments did not include a query field." : "MCP 调用了 sag_search，但参数里没有 query 字段。";
}

function buildMcpSearchQueryStep(toolCall: McpToolCallRecord, language: SupportedLanguage): ProcessStep {
  const query = typeof toolCall.arguments.query === "string" ? toolCall.arguments.query : "";
  return {
    id: makeStepId("mcp-search-query"),
    title: language === "en" ? "MCP search query" : "MCP 搜索语句",
    detail: getMcpSearchQuery(toolCall.arguments, language),
    status: "done",
    durationMs: toolCall.durationMs,
    payload: {
      query,
      strategy: toolCall.arguments.strategy,
      subStrategy: toolCall.arguments.subStrategy,
      searchMode: toolCall.arguments.searchMode,
      topK: toolCall.arguments.topK,
      returnTrace: toolCall.arguments.returnTrace
    }
  };
}

function buildMcpSearchResultSteps(result: unknown, language: SupportedLanguage): ProcessStep[] {
  if (!isPlainRecord(result) || !Array.isArray(result.sections)) {
    return [];
  }
  return [{
    id: makeStepId("mcp-search-result"),
    title: language === "en" ? "MarxSphere returned chunks" : "MarxSphere 返回切片",
    detail: language === "en" ? `${result.sections.length} chunk result(s) returned` : `返回 ${result.sections.length} 个切片结果`,
    status: "done",
    payload: {
      traceId: result.traceId,
      sections: result.sections.map((section) => {
        if (!isPlainRecord(section)) {
          return section;
        }
        return {
          heading: section.heading,
          contentPreview: typeof section.content === "string" ? section.content.slice(0, 160) : "",
          score: section.score,
          rank: section.rank
        };
      })
    }
  }];
}

function parseToolResponse(value: unknown): unknown {
  if (!isPlainRecord(value) || !Array.isArray(value.content)) {
    return value;
  }
  const text = value.content
    .map((item) => isPlainRecord(item) && item.type === "text" ? String(item.text ?? "") : "")
    .filter(Boolean)
    .join("\n");
  if (!text) {
    return value;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractSearchTrace(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  if (isPlainRecord(value.trace)) return value.trace;
  if ("timings" in value || "traceId" in value || "recalledEntities" in value || "queryEventIds" in value) {
    return value;
  }
  return null;
}

function searchTraceText(record: unknown, key: string) {
  if (!isPlainRecord(record)) return null;
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function searchModeLabel(value: string | null, language: SupportedLanguage) {
  if (value === "fast") return language === "en" ? "Fast" : "极速";
  if (value === "standard") return language === "en" ? "Standard" : "标准";
  return language === "en" ? "Default" : "默认";
}

function entitySummary(value: unknown, language: SupportedLanguage) {
  if (Array.isArray(value)) {
    if (value.length === 0) return language === "en" ? "No query entities identified" : "没有识别到查询实体";
    return language === "en" ? `${value.length} query entity/entities identified` : `识别到 ${value.length} 个查询实体`;
  }
  return language === "en" ? "Identify key entities in the user question" : "识别用户问题中的关键实体";
}

function countSummary(value: unknown, unit: string, language: SupportedLanguage) {
  if (Array.isArray(value)) return `${value.length} ${unit}`;
  return language === "en" ? "Waiting for the previous step" : "等待上一步结果";
}

function eventPayload(record: Record<string, unknown>, eventKey: string, idKey: string) {
  const direct = record[eventKey];
  if (Array.isArray(direct) && direct.length > 0) {
    return direct;
  }
  const ids = record[idKey];
  const snapshots = record.eventSnapshots;
  if (!Array.isArray(ids) || !Array.isArray(snapshots)) {
    return undefined;
  }
  const snapshotById = new Map(
    snapshots
      .filter(isPlainRecord)
      .map((event) => [String(event.id ?? ""), event])
  );
  const events = ids
    .map((id) => snapshotById.get(String(id)))
    .filter(Boolean);
  return events.length > 0 ? events : undefined;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown) {
  return (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError");
}

function formatModelName(model: string | null | undefined, t: (zh: string, en: string) => string) {
  if (!model) return t("未知模型", "Unknown model");
  if (model === "local-rule-fallback") return t("本地规则回退", "Local rule fallback");
  return model;
}

function formatMessageRole(role: string, t: (zh: string, en: string) => string) {
  if (role === "user") return t("用户", "User");
  if (role === "assistant") return t("助手", "Assistant");
  if (role === "tool") return t("工具", "Tool");
  return t("系统", "System");
}

function formatToolStatus(status: "PENDING" | "SUCCEEDED" | "FAILED", t: (zh: string, en: string) => string) {
  if (status === "SUCCEEDED") return t("成功", "Succeeded");
  if (status === "FAILED") return t("失败", "Failed");
  return t("等待中", "Pending");
}

function formatEmbeddingNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(5) : "0.00000";
}

function formatMessageContent(content: string, t: (zh: string, en: string) => string) {
  return formatDataContent(content, t)
    .replaceAll("sources", t("项目", "projects"))
    .replaceAll("source", t("项目", "project"))
    .replaceAll("Sources", t("项目", "Projects"))
    .replaceAll("Source", t("项目", "Project"))
    .replaceAll("来源", t("项目", "project"))
    .replaceAll("trace", t("检索链路", "trace"))
    .replaceAll(
      "Mock LLM planner completed MCP tool calls.",
      t("模拟 LLM 规划器已完成 MCP 工具调用。", "Mock LLM planner completed MCP tool calls.")
    )
    .replace(
      "当前未配置 LLM_API_KEY，已使用有限 fallback 通过真实 MCP client 测试工具。",
      t(
        "当前未配置 LLM 密钥，已使用有限本地规则回退，并通过真实 MCP 客户端测试工具。",
        "LLM key is not configured. A limited local rule fallback was used to test tools through the real MCP client."
      )
    )
    .replace(
      "当前 fallback 支持列出 sources、检索 search、查询 event。请尝试：列出 sources，并搜索 SAG multi search。",
      t(
        "当前本地规则回退支持列出项目、执行检索、查询事件。请尝试：列出项目，并搜索 SAG 多路检索。",
        "The local fallback supports listing projects, searching, and querying events. Try listing projects and searching SAG multi-search."
      )
    )
    .replace(
      "已通过 MCP 调用 sag_search，并返回检索结果和 trace。",
      t("已通过 MCP 调用 sag_search，并返回检索结果和检索链路。", "Called sag_search through MCP and returned retrieval results and trace.")
    );
}

function formatDataContent(content: string, t: (zh: string, en: string) => string) {
  const project = t("项目", "project");
  const projectList = t("项目列表", "project list");
  const projectIds = t("项目ID列表", "project ID list");
  const projectId = t("项目ID", "project ID");
  return content
    .replaceAll("sourceIds", projectIds)
    .replaceAll("sourceId", projectId)
    .replaceAll("source_id", projectId)
    .replaceAll("sources", projectList)
    .replaceAll("source", project)
    .replaceAll("Sources", projectList)
    .replaceAll("Source", project)
    .replaceAll("projects", projectList)
    .replaceAll("projectIds", projectIds)
    .replaceAll("projectId", projectId)
    .replaceAll("来源", project);
}
