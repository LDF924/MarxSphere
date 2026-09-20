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
    // 解包在**契约层**做: 消费者(VersionHistory.vue)把返回值直接当数组用(v-for / .length)。
    // 2026-09-20 修——原实现直接 `return q(...)` 把整个响应体当数组返回, 于是版本列表
    //   永远是空的(渲染「暂无版本记录」的兄弟分支), 恢复按钮也就无从点起。
    //   同时按版本号映射字段: 后端用 version/content_len, 闭源契约与模板用 version_num/word_count。
    const r = await q<{ items?: Array<Record<string, unknown>> }>(`/editor/v1/documents/${id}/versions`);
    return (r.items ?? []).map((v) => ({
      id: String(v.id ?? v.version ?? ""),
      version_num: Number(v.version_num ?? v.version ?? 0),
      created_at: String(v.created_at ?? ""),
      word_count: Number(v.word_count ?? v.content_len ?? 0),
      change_summary: v.change_summary === undefined || v.change_summary === null ? undefined : String(v.change_summary),
      title: v.title === undefined ? undefined : String(v.title),
      by_editor: v.by_editor === undefined ? undefined : String(v.by_editor),
    }));
  },
  async restoreVersion(id, versionId) {
    // 后端真实形态是 POST /documents/:docId/restore {version} —— 按版本号回档。
    // 闭源把版本 id 放进路径段, 我方没有版本行 id, 用版本号(上面映射时 id 就取的是版本号)。
    return q(`/editor/v1/documents/${id}/restore`, { method: "POST", body: { version: Number(versionId) } });
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

export function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64.replace(/^data:[^;]+;base64,/, ""));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export { authedBlob };
