/**
 * editor-ai store — 还原自闭源 Pinia `editor-ai`(EditorView E:18595-18890) 的 job 域核心
 * 我方后端仅实现 jobs 域(ai/jobs + stream delta/model/done/error + cancel/retry, server.ts L9929-9954);
 * 会话(conversations)端点不存在 → UI 采用"6 tab 动作 + 断点续传"形态(闭源 AIPanel 主形态), 不建假会话。
 * 关键语义: editor.activeJobId 断点恢复 / AbortController 停止 / retryActiveJob
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { createAiJob, cancelAiJob, retryAiJob, streamAiJob } from "@/shared/editorApi";
import { q } from "@/shared/api";
import { K } from "@/shared/constants";

export type AiJobStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

export interface AiModelOption {
  id: string;
  label: string;
  provider: string;
  desc: string;
  roles: string[];
}

export const useEditorAiStore = defineStore("editor-ai", () => {
  const panelOpen = ref(false);
  const activeTab = ref("check");
  const isLoading = ref(false);
  const streamingContent = ref("");
  const currentModel = ref("");
  const activeJobId = ref("");
  const lastJobStatus = ref<AiJobStatus>("idle");
  const panelWidth = ref(420);
  const lastActionLabel = ref("");

  // ── 学术写作模型选择(后端 editor 角色, 独立于推理链 reason) ──
  const modelOptions = ref<AiModelOption[]>([]);
  const modelBusy = ref(false);

  async function loadModels(): Promise<void> {
    try {
      // 2026-09-10: 后端只返回 provider 密钥已配置的模型(此前全量返回, 选 Claude/通义千问
      //   会因端点不匹配拿到空结果且报成功)。此处再按 editor 角色过滤一层。
      const r = await q<{ current?: string; models?: AiModelOption[] }>("/editor/v1/ai/model");
      currentModel.value = r?.current ?? "";
      modelOptions.value = (r?.models ?? []).filter((m) => m.roles?.includes("editor"));
    } catch {
      /* 静默: 模型列表拉取失败不影响 AI 功能使用 */
    }
  }

  async function setModel(modelId: string): Promise<{ ok: boolean; message?: string }> {
    modelBusy.value = true;
    try {
      const r = await q<{ current?: string }>("/editor/v1/ai/model", { method: "PUT", body: { modelId } });
      currentModel.value = r?.current ?? modelId;
      return { ok: true };
    } catch (e) {
      // 带上后端真实原因(密钥未配置 / 未知模型), 不再只报"切换失败"
      return { ok: false, message: (e as Error)?.message ?? "切换失败" };
    } finally {
      modelBusy.value = false;
    }
  }

  // ── job 状态持久化(editor.activeJobId) ──
  function persistJob(jobId: string) {
    activeJobId.value = jobId;
    localStorage.setItem(K.editorActiveJobId, jobId);
    lastJobStatus.value = "running";
  }
  function clearJob() {
    activeJobId.value = "";
    localStorage.removeItem(K.editorActiveJobId);
  }

  /** 挂载恢复(闭源 recoverActiveJob): localStorage 有 jobId → retry 重排队 → 重连 stream */
  async function recoverActiveJob(handlers: { onDelta?: (t: string) => void; onDone?: (content?: string) => void } = {}): Promise<boolean> {
    const saved = localStorage.getItem(K.editorActiveJobId);
    if (!saved) return false;
    try {
      const r = await retryAiJob(saved);
      const newId = String(r?.data?.job_id ?? r?.job_id ?? saved);
      persistJob(newId);
      isLoading.value = true;
      await listenJob(newId, handlers);
      return true;
    } catch {
      clearJob();
      return false;
    } finally {
      isLoading.value = false;
    }
  }

  /** 单次动作 job(assistDocument 语义: 累积全文返回; 失败 \n错误: 尾缀) */
  async function assistDocument(action: string, text: string, context: string, documentId?: string, mode?: string): Promise<string> {
    isLoading.value = true;
    lastJobStatus.value = "running";
    lastActionLabel.value = action;
    let acc = "";
    streamingContent.value = "";
    const body: Record<string, unknown> = {
      action,
      text,
      context,
      language: "中文",
      ...(mode ? { mode } : {}),
      ...(documentId ? { document_id: documentId } : {})
    };
    try {
      const { job_id } = await createAiJob(body);
      persistJob(job_id);
      let settled: "done" | "error" = "done";
      await listenJob(job_id, {
        onDelta: (t) => {
          acc += t;
          streamingContent.value = acc;
        },
        onDone: (content) => {
          if (content) {
            acc = content;
            streamingContent.value = content;
          }
          clearJob();
        },
        onError: (message) => {
          // SSE 的 error 事件此前无人接收 → 静默失败。现在把真实原因带出去。
          settled = "error";
          lastJobStatus.value = "failed";
          acc = (acc ? acc + "\n" : "") + `\n错误: ${message}`;
          streamingContent.value = acc;
        }
      });
      // 服务端报 done 但内容为空: 不再当成功, 明确提示(此前显示一片空白却算完成)
      if (settled === "done" && !acc.trim()) {
        lastJobStatus.value = "failed";
        acc = "错误: 模型返回空内容, 请检查「写作模型」设置";
        streamingContent.value = acc;
      } else if (settled === "done") {
        lastJobStatus.value = "completed";
      }
      return acc;
    } catch (e) {
      lastJobStatus.value = "failed";
      const msg = String((e as Error).message ?? e);
      return (acc ? acc + "\n" : "") + `\n错误: ${msg}`;
    } finally {
      isLoading.value = false;
    }
  }

  /** 连接 job 流(delta/model/done/error) */
  async function listenJob(
    jobId: string,
    handlers: { onDelta?: (t: string) => void; onDone?: (content?: string) => void; onError?: (message: string) => void }
  ): Promise<void> {
    await streamAiJob(jobId, {
      onDelta: handlers.onDelta,
      onModel: (m) => {
        currentModel.value = m;
      },
      onDone: (p) => {
        lastJobStatus.value = "completed";
        handlers.onDone?.(p?.content);
      },
      onError: (e) => {
        lastJobStatus.value = "failed";
        clearJob();
        // 2026-09-10: 此前把 e.message 整个丢掉 → 调用方只能报"失败", 用户看不到真实原因
        handlers.onError?.(e?.message || "任务失败");
      }
    });
  }

  async function cancelCurrentJob(): Promise<void> {
    if (activeJobId.value) await cancelAiJob(activeJobId.value).catch(() => null);
    lastJobStatus.value = "cancelled";
    isLoading.value = false;
    clearJob();
  }

  function resetJobState() {
    clearJob();
    lastJobStatus.value = "idle";
    isLoading.value = false;
    streamingContent.value = "";
  }

  const isBusy = computed(() => isLoading.value || lastJobStatus.value === "running");

  return {
    panelOpen, activeTab, isLoading, streamingContent, currentModel, activeJobId,
    lastJobStatus, panelWidth, lastActionLabel,
    modelOptions, modelBusy, loadModels, setModel,
    persistJob, clearJob, recoverActiveJob, assistDocument, listenJob,
    cancelCurrentJob, resetJobState, isBusy
  };
});
