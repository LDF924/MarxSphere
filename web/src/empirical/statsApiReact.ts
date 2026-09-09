// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// statsApiReact.ts — 实证统计 17 法 API 客户端(React 版, 2026-09-09 统一分析台融合用)
// 契约同 web/socialsci-vue/src/views/statistics/statsApi.ts: 上传 → fileId → statistics-jobs → 轮询
// 注: request 为 lib/api.ts 内部函数, 此处直连 fetch(带与 api.ts 相同的 Authorization 头)
function authToken(): string {
  try {
    return localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
  } catch { return ""; }
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body != null && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = data?.error?.message ?? data?.error ?? `请求失败：${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data as T;
}

export interface StatsJobResult {
  tables?: Array<{ title: string; columns: string[]; rows: unknown[][]; footnote?: string }>;
  charts?: Array<{ config: { data: unknown; layout: Record<string, unknown> } }>;
  warnings?: string[];
  metadata?: Record<string, unknown>;
}

export interface StatsJob {
  id: string;
  tool: string;
  status: string;
  result?: StatsJobResult | null;
  result_version_id?: string | null;
  error?: { code?: string; message?: string; detail?: string } | null;
  created_at?: string;
}

/** 上传数据文件(base64 JSON) → fileId + 变量画像 */
export async function uploadStatsFileReact(file: File): Promise<{ fileId: string; filename?: string; rowCount?: number; colCount?: number; profile?: { variables?: Array<{ name: string; type: string }>; columns?: Array<{ name: string; type: string }> } }> {
  const b64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
  return apiFetch(`/api/files/upload`, {
    method: "POST",
    body: JSON.stringify({ filename: file.name, base64: b64, mime: file.type || "text/csv" }),
  });
}

/** 创建分析 job */
export async function createStatsJobReact(body: Record<string, unknown>): Promise<{ job: { id: string; status: string } }> {
  return apiFetch(`/api/statistics-jobs`, { method: "POST", body: JSON.stringify(body) });
}

export async function getStatsJobReact(jobId: string): Promise<{ job: StatsJob }> {
  return apiFetch(`/api/statistics-jobs/${jobId}`);
}

export async function listStatsJobsReact(limit = 20): Promise<{ jobs: StatsJob[] }> {
  return apiFetch(`/api/statistics-jobs?limit=${limit}`);
}

export async function cancelStatsJobReact(jobId: string): Promise<{ job: { id: string; status: string } }> {
  return apiFetch<{ job: { id: string; status: string } }>(`/api/statistics-jobs/${jobId}/cancel`, { method: "POST" })
    .catch(() => ({ job: { id: jobId, status: "cancelled" } }));
}

export async function retryStatsJobReact(jobId: string): Promise<{ job: { id: string; status: string } }> {
  return apiFetch<{ job: { id: string; status: string } }>(`/api/statistics-jobs/${jobId}/retry`, { method: "POST" })
    .catch(() => ({ job: { id: jobId, status: "queued" } }));
}

/** 历史任务列表(React 版统计法历史回看) */
export async function listStatsJobsReactAll(limit = 30): Promise<{ jobs: StatsJob[] }> {
  return apiFetch(`/api/statistics-jobs?limit=${limit}`);
}
