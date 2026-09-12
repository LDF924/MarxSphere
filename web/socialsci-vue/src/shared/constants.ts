/**
 * 共享常量与 localStorage key 总表 — 闭源解码逐条收录(任务要求: 一个不漏)
 * 来源: decoded-workflow-quick.md §1.5 + decoded-stats-viz.md §1.6/§2.5 + decoded-editor-review.md §4 + decoded-workflow-sections-input.md B5
 */

// module 枚举(闭源 index ~213150)
export const MODULES = ["workflow", "review", "statistics", "viz", "knowledge", "editor"] as const;
export type SocModule = (typeof MODULES)[number];

export const MODULE_LABELS: Record<SocModule, string> = {
  workflow: "工作流",
  review: "审稿",
  statistics: "数据分析",
  viz: "科研绘图",
  knowledge: "知识库",
  editor: "编辑器"
};

// localStorage keys
export const K = {
  authToken: "skf_auth_token", // 全局 Bearer token(闭源共享层 op; 我方回退 sag_token)
  settings: "skf_settings", // 全局设置(闭源 settings store)
  lastTaskWorkflow: "lastTask_workflow", // 最近服务端 workflow/DAG taskId(quick Yr 恢复/statistics 素材导入目标)
  dagIntakeContext: "dag_intake_context", // quick 会话草稿 {taskId,phrase1Draft,intakeRound,awaitingExecutionConfirmation,messages[],updatedAt}
  // editor
  editorActiveDocumentId: "editor.activeDocumentId",
  editorActiveJobId: "editor.activeJobId",
  adeFormatPreset: "ade-format-preset", // 4 排版预设
  adeAiPanelWidth: "ade-ai-panel-width", // AI 面板宽度 clamp 340-720
  // statistics
  statsSave: (uid: string, taskId: string) => `stats_save_${uid}_${taskId}`,
  statsSaveNoTask: (uid: string) => `stats_save_${uid}`,
  statsJob: (uid: string) => `stats_job_${uid}`,
  // viz
  vizV2: (uid: string, taskId: string) => `viz_v2_${uid}_${taskId}`,
  vizV2Guest: (taskId: string) => `viz_v2_guest_${taskId}`,
  vizV2Legacy: (taskId: string) => `viz_v2_${taskId}`,
  vizActiveJob: (uid: string) => `viz_active_job_${uid}`,
  vizSave: (uid: string, taskId: string) => `viz_save_${uid}_${taskId}`,
  vizChat: (uid: string) => `viz_chat_${uid}`,
  // workflow draft/快照
  skfDraft: "skf_draft", // input 即时草稿
  wfSave: (uid: string, taskId: string) => `wf_save_${uid}_${taskId}`,
  lastTaskWorkflowUid: (uid: string) => `lastTask_workflow_${uid}`
} as const;

// window CustomEvent 事件名(闭源 editor-review §4)
export const EVT = {
  // aiApply 已删(2026-09-12 死代码审计): AIPanel 直接经 props.editor 落文, 全项目无人派发该事件。
  aiInsertChart: "ai-insert-chart", // 图表代码 → 图片落文(AIPanel.vue:504 派发 / EditorView 监听)
  empiricalDataset: "empirical-dataset", // 统一分析台数据集 → AIPanel 图表 tab 复用
  docConflict: "doc-conflict", // 409 乐观锁冲突(扩展点: 派发方已给用户可见反馈, 无内部监听)
  // editorDocumentsChanged 已删: 两个派发点(新建/删除后)自己都调了 fetchDocuments() 刷新列表,
  //   该事件零监听 → 纯冗余派发。将来若需要"跨视图同步文档列表"再重新引入。
  editorOpenNewDocument: "editor-open-new-document",
  // authExpired 已删: 与 shared/api.ts 的 AUTH_EXPIRED_EVENT 是同一个字符串值的重复定义,
  //   改一边忘另一边就会静默失效。**以 api.ts 的 AUTH_EXPIRED_EVENT 为唯一来源**
  //   (它才是真正 dispatch 的地方; 401 → 清 token → 广播 → auth-bridge 通知父窗口)。
  // ⚠ 以下 6 个是**闭源契约**, 不是死代码 —— 2026-09-12 审计时全项目零引用, 但闭源文档
  //   明确它们的作用(见 docs/socialsci-chunks/full/decoded-editor-review.md:83 与
  //   decoded-workflow-sections-input.md:47):
  //     review SSE 桥: worker 在另一窗口写入, 由 setSSECallbacks 把回调挂到 window 全局
  //     workflow 台:   恢复 F() 注册 __rfSSEVariables/__rfSSESkills → loadNode → 续连 SSE
  //   即"闭源有实现、我方尚未移植", 与真正没人听的死代码是两回事, 故保留待接。
  // review SSE 桥(闭源 window 全局回调)
  rfSseStatus: "__rfSSEStatus",
  rfReviewToken: "__rfReviewToken",
  rfReviewError: "__rfReviewError",
  rfSseReasoning: "__rfSSEReasoning", // editor-ai reasoning 转发
  // editor-ai
  rfSseVariables: "__rfSSEVariables",
  rfSseSkills: "__rfSSESkills"
} as const;

// task 状态中文(任务卡/历史 rail/统计下拉共用)
export const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
  paused: "已暂停",
  waiting_user: "等待用户",
  in_progress: "进行中",
  draft: "草稿"
};

export const uid = (): string => {
  const t = readUserId();
  return t ? String(t).replace(/[^0-9a-zA-Z_-]/g, "") : "guest";
};

function readUserId(): string {
  try {
    const raw = localStorage.getItem("sag_user") || localStorage.getItem("sag:user") || "";
    if (raw) {
      const j = JSON.parse(raw);
      if (j?.id) return String(j.id);
    }
  } catch { /* 忽略 */ }
  // 常见落点: {uid} / {userId}
  for (const key of ["sag_uid", "sag:uid", "userId", "user_id", "uid"]) {
    const v = localStorage.getItem(key);
    if (v) return v;
  }
  return "";
}

/** 时间短格式: <1h 分钟 / <1d 小时 / <7d 天 / 日期(闭源 rail meta 语义) */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${Math.max(1, m)} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天前`;
  const dt = new Date(t);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${dt.getFullYear()}/${pad(dt.getMonth() + 1)}/${pad(dt.getDate())}`;
}

/** zh-CN 千分位 + MM-DD HH:mm(闭源 SideBar meta 格式) */
export function fmtMeta(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function zhCount(n: number | undefined | null): string {
  if (n === undefined || n === null) return "0";
  return n.toLocaleString("zh-CN");
}

/** 文件/标题净化(闭源 Word 导出文件名规则): [\\/:*?"<>|] → _ */
export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "未命名";
}
