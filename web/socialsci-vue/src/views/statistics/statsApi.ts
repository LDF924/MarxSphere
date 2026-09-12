/**
 * Statistics 域 API 客户端 — 还原自闭源 StatisticsView 直连 fetch 契约(decoded-stats-viz.md §1.5)
 * 我方后端: /api/files/upload(base64 JSON) + /api/statistics-jobs 全套(M3 补) + SSE stats.* 事件
 */
import { q, streamSse, type SseHandle } from "@/shared/api";

export interface VarProfile {
  name: string;
  type: string; // categorical/binary/nominal/continuous/numeric/scale/id...
}

export interface FileUploadResult {
  fileId: string;
  filename?: string;
  rowCount?: number;
  colCount?: number;
  profile?: { variables?: VarProfile[]; columns?: VarProfile[]; sampleRows?: unknown[] };
}

/** 上传数据文件(闭源 POST /api/files/upload FormData{file}; 我方 base64 JSON) */
export async function uploadStatsFile(file: File): Promise<FileUploadResult> {
  const b64 = await fileToBase64(file);
  const r = await q<FileUploadResult>(`/files/upload`, {
    method: "POST",
    body: { filename: file.name, base64: b64, mime: file.type || "text/csv" }
  });
  return r;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

export interface StatsJobResult {
  tables?: Array<{ title: string; columns: string[]; rows: unknown[][]; footnote?: string }>;
  charts?: Array<{ config: { data: unknown; layout: Record<string, unknown> } }>;
  warnings?: string[];
  metadata?: Record<string, unknown>;
  _warnings?: string[]; // 前端警示条(本地拼装)
}

export interface StatsJob {
  id: string;
  tool: string;
  method?: string;
  status: string;
  result?: StatsJobResult | null;
  result_version_id?: string | null;
  error?: { code?: string; message?: string; detail?: string } | null;
  created_at?: string;
  source_task_id?: string;
}

/** 创建分析 job(闭源 POST /api/statistics-jobs body={tool,fileId,...}) */
export function createStatsJob(body: Record<string, unknown>): Promise<{ job: { id: string; status: string } }> {
  return q(`/statistics-jobs`, { method: "POST", body });
}

export function getStatsJob(jobId: string): Promise<{ job: StatsJob }> {
  return q(`/statistics-jobs/${jobId}`);
}

export function cancelStatsJob(jobId: string): Promise<{ job: { id: string; status: string } }> {
  return q<{ job: { id: string; status: string } }>(`/statistics-jobs/${jobId}/cancel`, { method: "POST" }).catch(() => ({ job: { id: jobId, status: "cancelled" } }));
}

export function retryStatsJob(jobId: string): Promise<{ job: { id: string; status: string } }> {
  return q<{ job: { id: string; status: string } }>(`/statistics-jobs/${jobId}/retry`, { method: "POST" }).catch(() => ({ job: { id: jobId, status: "queued" } }));
}

export function listStatsJobs(limit = 30): Promise<{ jobs: StatsJob[] }> {
  return q(`/statistics-jobs?limit=${limit}`);
}

/** SSE: 事件 stats.completed/stats.failed/stats.cancelled + job.snapshot(闭源可恢复流语义) */
export function streamStatsJob(jobId: string, handlers: { onCompleted?: (j: StatsJob) => void; onFailed?: (e?: unknown) => void; onCancelled?: () => void; onSnapshot?: (s: { status: string }) => void }): SseHandle {
  return streamSse(`/statistics-jobs/${jobId}/stream`, {
    onEvent: (event: string | null, payload: unknown) => {
      const p = payload as { result?: StatsJob["result"]; result_version_id?: string | null; error?: StatsJob["error"]; status?: string; job?: StatsJob };
      if (event === "stats.completed") {
        handlers.onCompleted?.({ id: jobId, tool: "", status: "completed", result: p.result, result_version_id: p.result_version_id });
      } else if (event === "stats.failed") handlers.onFailed?.(p.error);
      else if (event === "stats.cancelled") handlers.onCancelled?.();
      else if (event === "job.snapshot" && p.status) handlers.onSnapshot?.({ status: p.status });
    }
  });
}

/** Python 异常翻译(闭源 it(); 后端已翻, 前端兜底再翻一层) */
export function translateStatsError(raw: string): string {
  if (!raw) return "分析执行失败";
  if (/unsupported operand|数据类型不匹配/.test(raw)) return "数据类型不匹配, 请检查所选变量的取值类型";
  if (/维度错误/.test(raw)) return "维度错误: 变量列长度或分组不一致";
  if (/变量名不存在/.test(raw)) return "变量名不存在, 请重新选择变量";
  if (/缺失过多|数据缺失/.test(raw)) return "数据缺失过多或为空, 请检查数据文件";
  return raw.slice(0, 300);
}
