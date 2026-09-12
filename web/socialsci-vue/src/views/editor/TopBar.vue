<script setup lang="ts">
/** TopBar — 还原自闭源 EditorView E:18101-18294: 标题+保存/版本历史/状态徽标+新建弹窗+导入 Word */
import { ref, computed } from "vue";
import { useDocumentStore } from "./stores/document";
import { editorApi } from "@/shared/editorApi";
import { EVT } from "@/shared/constants";
import { toast, confirmDialog } from "@/shared/ui";

const emit = defineEmits<{
  (e: "toggle-version-history"): void;
}>();

const store = useDocumentStore();
const showNewDialog = ref(false);
const newTitle = ref("");
const creating = ref(false);

// 保存状态徽标
const statusMeta = computed(() => {
  switch (store.saveStatus) {
    case "saving":
      return { cls: "ade-topbar__status--yellow", text: "保存中…" };
    case "unsaved":
      return { cls: "ade-topbar__status--yellow", text: "未保存" };
    case "error":
      return { cls: "ade-topbar__status--yellow", text: "保存失败" };
    default:
      return { cls: "ade-topbar__status--green", text: "已保存" };
  }
});

// 监听外部"新建文档"请求(闭源 editor-open-new-document)
window.addEventListener(EVT.editorOpenNewDocument, () => {
  showNewDialog.value = true;
});

async function handleSave() {
  if (!store.currentDocument) return;
  const ok = await store.saveNow();
  if (ok) toast("已保存", "success");
  else toast(store.saveError || "保存失败", "error");
}

async function handleCreate() {
  if (!newTitle.value.trim()) return;
  creating.value = true;
  const id = await store.createDocument(newTitle.value.trim());
  creating.value = false;
  if (id) {
    showNewDialog.value = false;
    newTitle.value = "";
    toast("文档已创建", "success");
  } else {
    toast("创建失败", "error");
  }
}

async function handleImportWord(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = String(reader.result).split(",")[1] ?? "";
    try {
      const r = await editorApi.importWord(base64, file.name);
      const html = String(r?.html ?? r?.data?.html ?? "");
      const title = String(r?.title ?? r?.data?.title ?? file.name.replace(/\.docx?$/i, ""));
      if (store.currentDocument) {
        // 有当前文档 → setContent 已由主组件经 doc-import 事件处理; 此处仅提示
        window.dispatchEvent(new CustomEvent("doc-word-import", { detail: { html, title } }));
      } else {
        const id = await store.createDocument(title);
        if (id) window.dispatchEvent(new CustomEvent("doc-word-import", { detail: { html, title, docId: id } }));
      }
      toast("Word 导入完成", "success");
    } catch (e) {
      toast(`导入失败: ${(e as Error).message}`, "error");
    }
    input.value = "";
  };
  reader.readAsDataURL(file);
}

async function handleDelete() {
  const doc = store.currentDocument;
  if (!doc) return;
  const ok = await confirmDialog({ message: `确定删除「${doc.title}」? 此操作不可恢复。`, title: "删除文档", danger: true, okText: "删除" });
  if (!ok) return;
  const done = await store.deleteDocument(doc.id);
  if (done) toast("文档已删除", "success");
}
</script>

<template>
  <header class="ade-topbar">
    <div class="ade-topbar__inner">
      <div class="ade-topbar__left">
        <div class="ade-topbar__logo">论</div>
        <div class="ade-topbar__title-group">
          <span class="ade-topbar__title">在线学术文本编辑器</span>
          <span class="ade-topbar__subtitle">{{ store.currentDocument?.title || "未打开文档" }}</span>
        </div>
        <span class="ade-topbar__status" :class="statusMeta.cls">{{ statusMeta.text }}</span>
      </div>
      <div class="ade-topbar__right">
        <button class="ade-topbar__new-btn" @click="showNewDialog = true">＋ 新建文档</button>
        <label class="ade-topbar__action-btn" style="cursor: pointer">
          导入 Word
          <input type="file" accept=".docx,.doc" style="display: none" @change="handleImportWord" />
        </label>
        <button v-if="store.currentDocument" class="ade-topbar__action-btn" @click="handleSave">保存</button>
        <button class="ade-topbar__action-btn" @click="emit('toggle-version-history')">版本历史</button>
        <button v-if="store.currentDocument" class="ade-topbar__action-btn" style="color: #E06B6B" @click="handleDelete">删除</button>
      </div>
    </div>

    <!-- 新建文档弹窗(闭源自绘形态) -->
    <Teleport to="body">
      <div v-if="showNewDialog" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/20" @click.self="showNewDialog = false">
        <div class="relative w-[520px] max-w-[95vw] rounded-2xl bg-[#11192C] shadow-xl">
          <div class="flex items-center justify-between border-b px-6 py-4">
            <h3 class="text-lg font-bold text-[#E8EEF7]">新建文档</h3>
            <button class="text-2xl text-[#7A8AA0] hover:text-[#A3B3C8]" @click="showNewDialog = false">×</button>
          </div>
          <div class="space-y-4 p-6">
            <div>
              <label class="mb-1.5 block text-sm font-medium text-[#C3D2E5]">文档标题</label>
              <input
                v-model="newTitle"
                class="w-full rounded-lg border border-[#2A3A55] px-3 py-2 text-sm focus:border-[#4D84CB] focus:outline-none"
                placeholder="例如: 数字经济与中小企业融资约束研究"
                @keydown.enter="handleCreate"
              />
            </div>
          </div>
          <div class="flex justify-end gap-3 border-t px-6 py-4">
            <button class="rounded-lg border border-[#222F44] px-4 py-2 text-sm text-[#A3B3C8] hover:bg-[#1A2333]" @click="showNewDialog = false">取消</button>
            <button class="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50" :disabled="creating || !newTitle.trim()" @click="handleCreate">
              {{ creating ? "创建中…" : "创建" }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </header>
</template>

<style scoped>
/* 已迁移 EditorView-CkEB1QCK.css ade-topbar 段(data-v-500ac1b8 等价) */
.ade-topbar {
  background: #11192C;
  border-bottom: 1px solid #222F44;
  flex-shrink: 0;
  position: sticky;
  top: 0;
  z-index: 30;
}
.ade-topbar__inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
}
.ade-topbar__left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.ade-topbar__logo {
  width: 36px;
  height: 36px;
  border-radius: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #2563eb;
  flex-shrink: 0;
  color: #F1F5F9;
  font-weight: 700;
  font-size: 15px;
}
.ade-topbar__title-group {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ade-topbar__title {
  font-size: 12px;
  font-weight: 400;
  color: #8B9BB1;
  line-height: 1.3;
}
.ade-topbar__subtitle {
  font-size: 16px;
  font-weight: 700;
  color: #E8EEF7;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40vw;
}
.ade-topbar__right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ade-topbar__new-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 600;
  border: 1.5px solid #2563eb;
  border-radius: 6px;
  background: #11192C;
  color: #2563eb;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
  font-family: inherit;
}
.ade-topbar__new-btn:hover {
  background: #1E2A48;
  color: #1d4ed8;
}
.ade-topbar__action-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid #222F44;
  border-radius: 6px;
  background: #11192C;
  color: #8B9BB1;
  cursor: pointer;
  transition: all 0.18s ease;
  white-space: nowrap;
}
.ade-topbar__action-btn:hover {
  background: #1E2A48;
  border-color: #2A3A55;
  color: #2563eb;
}
.ade-topbar__status {
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 2px;
  font-weight: 500;
  white-space: nowrap;
}
.ade-topbar__status--green {
  background: #14281F;
  color: #5FD0B4;
}
.ade-topbar__status--yellow {
  background: #11192Cbeb;
  color: #E8B54A;
}
.ade-topbar__status--gray {
  background: #1A2333;
  color: #8B9BB1;
}
</style>
