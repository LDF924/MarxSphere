/**
 * document store — 还原自闭源 Pinia `gu("document")`(EditorView E:17901-18087)
 * 契约对齐我方后端(server.ts L9822-9954):
 *  - GET /documents → {data:{items,pagination}}; GET /:id → {document:{...,content_hash}}
 *  - PUT /:id body {content:string, expectedContentHash} — 409 = 他窗口已改(doc-conflict 事件)
 *  - content 存字符串(闭源独立后端语义同); 前端 currentContent 也保持字符串(经 tiptap getJSON→JSON.stringify)
 *  - 锁 5 分钟自动过期 → 60s 幂等重锁续期; editor.activeDocumentId 持久化
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { editorApi, type EditorDoc } from "@/shared/editorApi";
import { EVT, K } from "@/shared/constants";

export type SaveStatus = "saved" | "saving" | "unsaved" | "error";

export const useDocumentStore = defineStore("document", () => {
  const documents = ref<EditorDoc[]>([]);
  const pagination = ref({ total: 0 });
  const currentDocument = ref<EditorDoc | null>(null);
  const currentContent = ref<string>(""); // 当前正文(字符串; JSON 树序列化由编辑器层做)
  const contentHash = ref(""); // 服务端当前版本 hash(乐观锁基准)
  const lastSavedHash = ref("");
  const saveStatus = ref<SaveStatus>("saved");
  const lockInfo = ref<{ lockedBy?: string } | null>(null);
  const saveError = ref("");
  const loading = ref(false);

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatSerial = 0;
  let docId: string | null = null; // 当前持锁文档

  async function fetchDocuments() {
    try {
      const r = await editorApi.listDocs(1, 500);
      documents.value = r.data.items ?? [];
      pagination.value = r.data.pagination ?? { total: 0 };
    } catch (e) {
      console.error("[document] list 失败", e);
      documents.value = [];
    }
  }

  /** 打开/切换文档: 先 release → getDoc(document) → apply → acquire 锁 */
  async function fetchDocument(id: string, opts: { skipLock?: boolean } = {}): Promise<boolean> {
    if (docId && docId !== id) await releaseLock();
    try {
      const r = await editorApi.getDoc(id);
      const doc = r.document;
      if (!doc) return false;
      applyDoc(doc);
      localStorage.setItem(K.editorActiveDocumentId, id);
      if (!opts.skipLock) await acquireDocumentLock(id);
      return true;
    } catch (e) {
      console.error("[document] 打开失败", id, e);
      return false;
    }
  }

  function applyDoc(doc: EditorDoc) {
    currentDocument.value = doc;
    const content = typeof doc.content === "string" ? doc.content : doc.content != null ? JSON.stringify(doc.content) : "";
    currentContent.value = content;
    contentHash.value = doc.content_hash ?? "";
    lastSavedHash.value = hashOf(content);
    saveStatus.value = "saved";
  }

  /** 本地保存态指纹(服务端 hash 仅冲突检测用; 本地以内容串 FNV 判变更) */
  function hashOf(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  async function createDocument(title: string): Promise<string | null> {
    try {
      const r = await editorApi.createDoc(title || "未命名学术文档");
      const id = "id" in r ? r.id : r.data?.id;
      if (!id) throw new Error("创建无 id");
      await fetchDocuments();
      const opened = await fetchDocument(id, { skipLock: true });
      if (opened) await acquireDocumentLock(id);
      // 注: 此处原有 EVT.editorDocumentsChanged 事件, 已删(2026-09-12 死代码审计) —
      //   上面刚调过 fetchDocuments() 列表已是最新, 该事件**零监听**, 属纯冗余派发。
      return id;
    } catch (e) {
      console.error("[document] 新建失败", e);
      return null;
    }
  }

  async function deleteDocument(id: string): Promise<boolean> {
    try {
      await editorApi.deleteDoc(id);
      if (docId === id) stopHeartbeat();
      if (currentDocument.value?.id === id) {
        currentDocument.value = null;
        currentContent.value = "";
        localStorage.removeItem(K.editorActiveDocumentId);
      }
      await fetchDocuments();
      // 同 createDocument: 列表已在上面刷新, 此处的 EVT.editorDocumentsChanged 零监听且冗余, 已删
      return true;
    } catch (e) {
      console.error("[document] 删除失败", e);
      return false;
    }
  }

  function markUnsaved() {
    if (saveStatus.value !== "saving") saveStatus.value = "unsaved";
  }

  /** 变更检测: 内容串变化才真正 PUT */
  async function flushSave(): Promise<boolean> {
    if (!currentDocument.value) return false;
    if (hashOf(currentContent.value) === lastSavedHash.value && saveStatus.value !== "error") {
      saveStatus.value = "saved";
      return true;
    }
    return saveNow();
  }

  async function saveNow(): Promise<boolean> {
    const doc = currentDocument.value;
    if (!doc) return false;
    if (saveStatus.value === "saving") return true; // 防重入
    saveStatus.value = "saving";
    try {
      await editorApi.saveDoc(doc.id, {
        content: currentContent.value,
        expectedContentHash: contentHash.value || undefined
      });
      contentHash.value = ""; // 服务端已产生新版本; 下次保存不带基准
      lastSavedHash.value = hashOf(currentContent.value);
      saveStatus.value = "saved";
      saveError.value = "";
      // 同步列表项(word_count/updated_at; 闭源 store 保存后同步列表语义)
      const wc = currentContent.value.replace(/\s/g, "").length;
      const i = documents.value.findIndex((d) => d.id === doc.id);
      if (i >= 0) {
        documents.value[i] = { ...documents.value[i], word_count: wc, updated_at: new Date().toISOString() };
      }
      return true;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 409) {
        saveStatus.value = "error";
        saveError.value = "文档已在其他窗口被修改(版本冲突)";
        // ⚠ 2026-09-12 审计: 该事件**没有内部监听者**, 但**不是死代码** —— 上面两行已给用户
        //   可见反馈(错误态 + 文案), 事件是留给外部集成(如将来弹冲突合并对话框)的扩展点。
        //   与 editorDocumentsChanged 不同: 那个是"派发点自己已刷新列表"的纯冗余, 已删。
        window.dispatchEvent(new CustomEvent(EVT.docConflict, { detail: (e as { message?: string }).message ?? "409" }));
        return false;
      }
      saveStatus.value = "error";
      saveError.value = String((e as Error).message ?? e);
      return false;
    }
  }

  // ── 锁会话(60s 幂等续期; 我方后端锁 5 分钟自动过期) ──
  function acquireDocumentLock(id: string): Promise<unknown> {
    return (async () => {
      docId = id;
      const r = await editorApi.lockDoc(id).catch(() => null);
      lockInfo.value = r?.ok ? { lockedBy: r.lockedBy ?? undefined } : null;
      startHeartbeat(id);
      return r;
    })();
  }

  async function releaseLock(): Promise<void> {
    if (heartbeatTimer) stopHeartbeat();
    if (docId) {
      const id = docId;
      docId = null;
      await editorApi.unlockDoc(id).catch(() => null);
      lockInfo.value = null;
    }
  }

  function startHeartbeat(id: string) {
    stopHeartbeat();
    heartbeatSerial++;
    const mySerial = heartbeatSerial;
    heartbeatTimer = setInterval(async () => {
      if (docId !== id || mySerial !== heartbeatSerial) {
        stopHeartbeat();
        return;
      }
      await editorApi.lockDoc(id).catch(() => null);
    }, 60_000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  const hasContent = computed(() => currentContent.value.trim().length > 0);

  const wordCount = computed(() => currentContent.value.replace(/\s/g, "").length);

  return {
    documents, pagination, currentDocument, currentContent, contentHash, lastSavedHash,
    saveStatus, lockInfo, saveError, loading,
    fetchDocuments, fetchDocument, createDocument, deleteDocument,
    markUnsaved, saveNow, flushSave, acquireDocumentLock, releaseLock, stopHeartbeat,
    hasContent, wordCount
  };
});
