/**
 * Editor 域 API 客户端 — 还原自闭源 EditorView-CaKgg_bg.js E:17804-17900(Axios baseURL /api/editor/v1)
 * 我方后端已实现同前缀端点(server.ts L9822-9954, 含 content_hash 乐观锁 + ai job SSE)
 */
import { q, authedBlob } from "./api";

export interface EditorDoc {
  id: string;
  title: string;
  content?: unknown; // 后端存字符串(闭源独立后端语义: JSON 序列化); 前端读写保持字符串
  content_hash?: string;
  word_count?: number;
  updated_at?: string;
  created_at?: string;
}

export interface EditorApi {
  listDocs(page?: number, pageSize?: number): Promise<{ data: { items: EditorDoc[]; pagination: { total: number } } }>;
  getDoc(id: string): Promise<{ document: EditorDoc }>;
  createDoc(title: string): Promise<{ id: string } | { data: EditorDoc }>;
  saveDoc(id: string, patch: { content?: unknown; expectedContentHash?: string; title?: string }): Promise<unknown>;
  deleteDoc(id: string): Promise<unknown>;
  lockDoc(id: string): Promise<{ ok: boolean; lockedBy?: string }>;
  unlockDoc(id: string): Promise<unknown>;
  versions(id: string): Promise<Array<{ id: string; version_num: number; created_at: string; change_summary?: string; word_count?: number }>>;
  restoreVersion(id: string, versionId: string): Promise<unknown>;
  importWord(fileBase64: string, fileName: string): Promise<{ data?: { html?: string; title?: string }; html?: string; title?: string }>;
}

export const editorApi: EditorApi = {
  async listDocs(page = 1, pageSize = 100) {
    return q(`/editor/v1/documents?page=${page}&page_size=${pageSize}`);
  },
  async getDoc(id) {
    return q<{ document: EditorDoc }>(`/editor/v1/documents/${id}`);
  },
  async createDoc(title) {
    return q(`/editor/v1/documents`, { method: "POST", body: { title } });
  },
  async saveDoc(id, patch) {
    return q(`/editor/v1/documents/${id}`, { method: "PUT", body: patch });
  },
  async deleteDoc(id) {
    return q(`/editor/v1/documents/${id}`, { method: "DELETE" });
  },
  async lockDoc(id) {
    return q<{ ok: boolean; lockedBy?: string }>(`/editor/v1/documents/${id}/lock`, { method: "POST" }).catch(() => ({ ok: false as boolean }));
  },
  async unlockDoc(id) {
    return q(`/editor/v1/documents/${id}/unlock`, { method: "POST" });
  },
  async versions(id) {
    return q(`/editor/v1/documents/${id}/versions`);
  },
  async restoreVersion(id, versionId) {
    return q(`/editor/v1/documents/${id}/versions/${versionId}/restore`, { method: "POST" });
  },
  async importWord(fileBase64, fileName) {
    // 我方后端走 base64 JSON(闭源 multipart; 语义等价)
    return q(`/editor/v1/documents/import`, { method: "POST", body: { filename: fileName, base64: fileBase64 } });
  }
};

export interface AiJobSseHandlers {
  onDelta?: (content: string) => void;
  onModel?: (model: string) => void;
  onDone?: (payload: { content?: string; message_id?: string; conversation_id?: string }) => void;
  onError?: (err: { message: string; is_retriable?: boolean }) => void;
}

/** 创建 editor-ai job(闭源 body: {action,text,context,language,document_id} 或 {message,conversation_id,...}) */
export function createAiJob(body: Record<string, unknown>): Promise<{ job_id: string }> {
  return q(`/editor/v1/ai/jobs`, { method: "POST", body });
}

export function cancelAiJob(jobId: string): Promise<unknown> {
  return q(`/editor/v1/ai/jobs/${jobId}/cancel`, { method: "POST" }).catch(() => null);
}

export function retryAiJob(jobId: string): Promise<{ data?: { job_id: string }; job_id?: string }> {
  return q<{ data?: { job_id: string }; job_id?: string }>(`/editor/v1/ai/jobs/${jobId}/retry`, { method: "POST" }).catch(() => ({}));
}

/** ai/jobs/:id/stream — SSE 事件 delta/model/done/error(手写 \n\n 帧解析) */
export async function streamAiJob(
  jobId: string,
  handlers: AiJobSseHandlers,
  signal?: AbortSignal
): Promise<void> {
  const url = `/api/editor/v1/ai/jobs/${jobId}/stream`;
  const headers: Record<string, string> = {};
  const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, signal });
  if (!res.ok || !res.body) {
    handlers.onError?.({ message: "后台作业连接失败", is_retriable: true });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let ev = "";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trimStart();
        }
        if (!data) continue;
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(data); } catch { /* 非 json 忽略 */ }
        if (ev === "delta") handlers.onDelta?.(String(payload.content ?? ""));
        else if (ev === "model") handlers.onModel?.(String(payload.model ?? ""));
        else if (ev === "done") {
          handlers.onDone?.({
            content: payload.content !== undefined ? String(payload.content) : undefined,
            message_id: payload.message_id !== undefined ? String(payload.message_id) : undefined,
            conversation_id: payload.conversation_id !== undefined ? String(payload.conversation_id) : undefined
          });
          return;
        } else if (ev === "error") {
          handlers.onError?.({ message: String(payload.message ?? "任务出错"), is_retriable: Boolean(payload.is_retriable) });
          return;
        }
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") handlers.onError?.({ message: String((e as Error).message ?? e), is_retriable: false });
  }
}

/** 文档内容 JSON 树 → 排序键规范化字符串(闭源 canonicalStringify Aa(), 对象键排序 — 变更检测核心) */
export function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalStringify(v)).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

/** 导出 docx(闭源 POST /documents/:id/export body {html,title,format_options} → blob) */
export async function exportDocxBlob(docId: string, html: string, title: string, formatOptions: Record<string, unknown>): Promise<Blob> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/editor/v1/documents/${docId}/export`, {
    method: "POST",
    headers,
    body: JSON.stringify({ html, title, format_options: formatOptions })
  });
  if (!res.ok) throw new Error(`导出失败(${res.status})`);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await res.json();
    if (j?.ok && j?.base64) return base64ToBlob(j.base64, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    throw new Error(j?.error?.message ?? "导出失败");
  }
  return res.blob();
}

export function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64.replace(/^data:[^;]+;base64,/, ""));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export { authedBlob };
