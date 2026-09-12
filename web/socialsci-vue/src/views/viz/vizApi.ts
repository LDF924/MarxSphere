/**
 * Viz 域 API 客户端 — 还原自闭源 VizView-DKRGiXDc.js + 共享 Y0 服务契约(decoded-stats-viz.md §2.4)
 * 我方后端: /api/viz/jobs(L9725-9763, viz_job_events 事件表 after=N 重放) — 前端路径 viz-jobs→viz/jobs 适配
 * PNG 三态统一 blob 化(路径/dataURL/裸 base64; He() 4 次退避重试 150ms*(attempt+1))
 */
import { q, streamSse, authedBlob, type SseHandle } from "@/shared/api";
import { K, uid } from "@/shared/constants";

export interface VizChart {
  png?: string | null;
  chartPng?: string | null;
  caption?: string;
  analysisText?: string;
  code?: string;
  chartType?: string;
  chartVersionId?: string;
  figureId?: string;
  figureIndex?: number | null;
  panelId?: string;
  svg?: string | null;
  svg_embedded?: string | null;
  svg_editable?: string | null;
  /** 该图是否用了真实数据(后端按产物 spec.sampleData 标记; 前端画"示意图"徽标) */
  sampleData?: boolean;
  dataFile?: string;
  metadata?: Record<string, unknown>;
}

export interface VizJob {
  id: string;
  status: string; // queued/running/completed/failed/cancelled
  title?: string | null;
  /** 后端列表返回的原始请求语(任务卡标题用; 此前前端未读 → 任务卡恒显示"未命名绘图任务") */
  prompt?: string | null;
  /** 该任务绑定的数据文件(/viz/data-files 同源) */
  file_id?: string | null;
  file_name?: string | null;
  input?: { message?: string; conversation?: unknown[]; fileId?: string; fileName?: string; session_id?: string };
  result?: {
    content?: string;
    plan?: string;
    thinking?: string;
    charts?: VizChart[];
    error?: { message?: string };
  };
  source_task_id?: string;
  sourceTaskId?: string;
  workflow_task_id?: string;
  created_at?: string;
  /** 失败原因(后端写在这列, 不在 result.error) */
  error?: { userMessage?: string; message?: string } | null;
  /** 后端列表返回的图数(snake_case; 前端此前读 camelCase → 恒显示 0 张图) */
  chart_count?: number;
  chartCount?: number;
}

/** 上传数据文件(viz 用: 需 parseStatus/profile 契约; parseStatus 旧后端可缺省视为 completed) */
export interface VizFileProfile {
  kind?: string;
  parseStatus?: string;
  rowCount?: number;
  columnCount?: number;
  colCount?: number;
  /** 双形态: [{name,type}] 或 string[](旧后端 M3 契约) */
  columns?: Array<{ name: string; type?: string } | string>;
  variables?: Array<{ name: string; type?: string }>;
  sampleRows?: unknown[];
}
/**
 * 上传(2026-09-11 修): 此前 POST /files/upload 用 JSON body {filename,base64,mime} —
 *   与后端契约(同名字段)一致, 但**服务端只存 fileId、不返回 profile.sampleRows 以外的列信息**,
 *   且 viz 侧只认 fileId; 现在上传后由服务端按 fileId 取数, 前端不再自带整表 CSV。
 */
export async function uploadVizFile(file: File): Promise<{ fileId: string; parseStatus?: string; profile?: VizFileProfile; parseError?: string }> {
  const b64 = await fileToBase64(file);
  return q(`/files/upload`, { method: "POST", body: { filename: file.name, base64: b64, mime: file.type || "text/csv" } });
}

/** 可作绘图数据源的已上传文件(表格类, 带行列数) */
export interface VizDataFile { fileId: string; fileName: string; rowCount: number; colCount: number }
export async function listVizDataFiles(): Promise<VizDataFile[]> {
  const r = await q<{ files: VizDataFile[] }>(`/viz/data-files`);
  return r.files ?? [];
}

/** 绘图用 LLM 模型(角色 viz): 只列"所属 provider 已配密钥"的, 避免选了必然失败 */
export interface VizLlmModel { id: string; label: string; provider: string; desc: string }
export async function getVizModels(): Promise<{ models: VizLlmModel[]; current: string }> {
  const r = await q<{ usable?: VizLlmModel[]; models?: VizLlmModel[]; roleMap?: Record<string, string> }>(`/llm/models`);
  return { models: r.usable ?? r.models ?? [], current: String(r.roleMap?.viz ?? "") };
}
export async function setVizModel(modelId: string): Promise<void> {
  await q(`/llm/models`, { method: "PUT", body: { role: "viz", modelId } });
}

/** 任务的数据集(画布「数据」页签): 恢复历史任务时图卡的 dataSnapshot 是空的, 易显示"暂无绑定数据" */
export interface VizJobDataset { columnOrder: string[]; rows: string[][]; totalRows: number; fileName: string; sampleData: boolean }
export async function getVizJobDataset(jobId: string): Promise<VizJobDataset | null> {
  try {
    return await q<VizJobDataset>(`/viz/jobs/${jobId}/dataset`);
  } catch {
    return null;
  }
}

/** 后端 chart 产物 png 字段是**相对路径**(data/viz-files/...), 渲染前必须走鉴权拉取 */
export function vizArtifactUrl(rel: string): string {
  return rel.startsWith("http") ? rel : `/api/viz/files/${rel}`;
}

/** 单个文件概览(绑定已有数据源时取列名+样本用于预览) */
export async function getVizFileProfile(fileId: string): Promise<VizFileProfile | null> {
  try {
    const r = await q<{ profile?: VizFileProfile }>(`/files/${encodeURIComponent(fileId)}/profile`);
    return r.profile ?? null;
  } catch {
    return null;
  }
}

/** 统计任务 → 其输入原始数据(统计结果重绘: 拿同一份数据画图, 而不是文字描述) */
export interface StatsJobBrief { id: string; tool: string; method?: string; status: string; created_at?: string }
export async function listStatsJobs(limit = 20): Promise<StatsJobBrief[]> {
  const r = await q<{ jobs: StatsJobBrief[] }>(`/statistics-jobs?limit=${limit}`);
  return r.jobs ?? [];
}
export async function getStatsJobDataset(jobId: string, rows = 5000): Promise<{ columnOrder: string[]; rows: unknown[][]; totalRows: number; fileName: string; fileId: string } | null> {
  try {
    return await q(`/statistics-jobs/${jobId}/dataset?rows=${rows}`);
  } catch {
    return null; // 该分析任务没有可用数据文件
  }
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

/** 建/复用绘图会话(闭源: job 需 session 存在; 返回 session id) */
export async function ensureVizSession(sessionId?: string, title = "未命名绘图会话"): Promise<string> {
  if (sessionId && sessionId.startsWith("v2_")) {
    // 本地生成 id 需落服务端 → 检查是否存在, 不存在则建
    try {
      const { sessions } = await q<{ sessions: Array<{ id: string }> }>(`/viz/sessions`);
      const hit = (sessions ?? []).find((x) => x.id === sessionId);
      if (hit) return hit.id;
    } catch { /* 容忍 */ }
  }
  const r = await q<{ id: string }>(`/viz/sessions`, { method: "POST", body: { title } });
  return r.id;
}

/** 创建绘图 job — 后端返回 {job_id}(实测); body 含 journalConfig(Nature 默认)/modelConfig 全契约 */
export async function createVizJob(body: Record<string, unknown>): Promise<{ job: { id: string; status: string } }> {
  const r = await q<{ job_id?: string; job?: { id: string; status: string } }>(`/viz/jobs`, { method: "POST", body });
  if (r.job) return { job: r.job };
  return { job: { id: String(r.job_id ?? ""), status: "queued" } };
}

export function getVizJob(jobId: string): Promise<{ job: VizJob }> {
  return q(`/viz/jobs/${jobId}`);
}

export function listVizJobs(limit = 20): Promise<{ jobs: VizJob[] }> {
  return q(`/viz/jobs?limit=${limit}`);
}

export function cancelVizJob(jobId: string): Promise<unknown> {
  return q(`/viz/jobs/${jobId}/cancel`, { method: "POST" }).catch(() => null);
}

export function retryVizJob(jobId: string): Promise<unknown> {
  return q(`/viz/jobs/${jobId}/retry`, { method: "POST" }).catch(() => null);
}

/** 绘图默认期刊参数(闭源 VizChatPanelV2 默认值 1:1) */
export const DEFAULT_JOURNAL_CONFIG = {
  journal: "nature",
  layout: "single-column",
  colorScheme: "nature-default",
  dpi: 600,
  fontSize: 7,
  fontFamily: "Arial",
  axisLineWidth: 0.8,
  dataLineWidth: 1,
  widthMm: 89,
  heightMm: 62.3
};

/**
 * viz job SSE — 闭源 13 事件协议: plan/delta/thinking/tool_status/tool/chart/svg/code/critique/
 * critique_fix/error/done/viz.completed + viz.failed/viz.cancelled(事件映射 UI 在 ChatPanel)
 */
export function streamVizJob(
  jobId: string,
  handlers: {
    onEvent?: (event: string | null, payload: Record<string, unknown>) => void;
    onDone?: () => void;
    onError?: (err: Error) => void;
    signal?: AbortSignal;
  }
): SseHandle {
  return streamSse(`/viz/jobs/${jobId}/stream`, {
    onEvent: (event, payload) => handlers.onEvent?.(event, (payload ?? {}) as Record<string, unknown>),
    onDone: () => handlers.onDone?.(),
    onError: (e) => handlers.onError?.(e),
    signal: handlers.signal
  });
}

/** 后端心跳(闭源 GET /api/viz2/status 30s; 我方无 → 打 statistics/health 兜底) */
export async function vizBackendStatus(): Promise<"connected" | "disconnected"> {
  try {
    const r = await fetch("/api/viz/jobs?limit=1", {
      headers: { Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` }
    });
    return r.ok ? "connected" : "disconnected";
  } catch {
    return "disconnected";
  }
}

/**
 * PNG 三态统一 blob/url 化(闭源 He() L3718 附近: 4 次重试 150ms*(attempt+1) 退避)
 * 返回: {url} — 路径以 / 开头 → fetch blob; data: → 解码; 裸 base64 → 补齐前缀
 */
export async function blobifyPng(png: string | null | undefined, attempt = 0): Promise<string | null> {
  if (!png) return null;
  const src = String(png);
  try {
    if (src.startsWith("data:")) return src; // dataURL 直接用
    if (src.startsWith("/")) {
      // 路径 → blob(authedBlob 内部拼 /api 前缀; 已是 /api 开头则剥掉)
      const p = src.startsWith("/api") ? src.slice(4) : src;
      const blob = await authedBlob(p);
      return URL.createObjectURL(blob);
    }
    if (src.startsWith("data/")) {
      // 相对产物路径(viz 后端 pngRel: data/viz-files/...) → 鉴权取图
      const blob = await authedBlob(`/viz/files/${src}`);
      return URL.createObjectURL(blob);
    }
    if (/^[A-Za-z0-9+/=]+$/.test(src) && src.length > 100) {
      return `data:image/png;base64,${src}`;
    }
    return src;
  } catch {
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      return blobifyPng(png, attempt + 1);
    }
    return null;
  }
}

// ── localStorage 键(viz_v2_<uid>_<taskId> 等; uid() 由 constants 提供) ──
export function vizLocalKey(taskId?: string): string {
  const u = uid();
  if (taskId) return K.vizV2(u, taskId);
  return K.vizSave(u, "default");
}
export { K, uid };
