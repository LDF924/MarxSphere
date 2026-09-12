<script setup lang="ts">
/** SideBar 文档 rail — 还原自闭源 EditorView E:18305-18448: 文档列表(千分位字数 + MM-DD HH:mm + 删除) */
import { useDocumentStore } from "./stores/document";
import { zhCount, fmtMeta } from "@/shared/constants";
import { toast } from "@/shared/ui";

const store = useDocumentStore();

async function select(id: string) {
  if (store.currentDocument?.id === id) return;
  if (store.saveStatus === "unsaved" || store.saveStatus === "saving") {
    await store.flushSave();
  }
  const ok = await store.fetchDocument(id);
  if (!ok) toast("打开文档失败", "error");
}

async function remove(id: string, title: string) {
  if (!window.confirm(`确定删除「${title}」?`)) return;
  const done = await store.deleteDocument(id);
  if (done) toast("已删除", "success");
}
</script>

<template>
  <div class="ade-document-rail">
    <div class="ade-document-rail__header">
      <div>
        <h2>文档列表</h2>
        <span>{{ store.pagination.total }} 篇</span>
      </div>
    </div>
    <div v-if="store.documents.length" class="ade-document-rail__list">
      <div
        v-for="doc in store.documents"
        :key="doc.id"
        class="ade-document-entry"
        :class="{ 'is-active': store.currentDocument?.id === doc.id }"
      >
        <button type="button" class="ade-document-entry__main" @click="select(doc.id)">
          <span class="ade-document-entry__title">{{ doc.title || "未命名" }}</span>
          <span class="ade-document-entry__meta">{{ zhCount(doc.word_count) }} 字 · {{ fmtMeta(doc.updated_at) }}</span>
        </button>
        <button type="button" class="ade-document-entry__delete" title="删除" @click.stop="remove(doc.id, doc.title)">
          ✕
        </button>
      </div>
    </div>
    <div v-else class="ade-document-rail__empty">暂无文档</div>
  </div>
</template>

<style scoped>
.ade-document-rail {
  width: 218px;
  min-width: 218px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #222F44;
  background: #11192C;
}
.ade-document-rail__header {
  min-height: 54px;
  padding: 10px 10px 9px 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid #222F44;
}
.ade-document-rail__header > div {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.ade-document-rail__header h2 {
  margin: 0;
  color: #E8EEF7;
  font-size: 13px;
  font-weight: 700;
}
.ade-document-rail__header > div span {
  color: #7A8AA0;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.ade-document-rail__list {
  min-height: 0;
  padding: 6px;
  flex: 1;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #46587A transparent;
}
.ade-document-entry {
  position: relative;
  margin-bottom: 2px;
  border-left: 2px solid transparent;
}
.ade-document-entry.is-active {
  border-left-color: #2563eb;
  background: #1E2A48;
}
.ade-document-entry__main {
  width: 100%;
  min-height: 52px;
  padding: 8px 29px 7px 9px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.ade-document-entry__main:hover {
  background: #1A2333;
}
.ade-document-entry__title {
  width: 100%;
  overflow: hidden;
  color: #DCE6F2;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ade-document-entry__meta {
  color: #7A8AA0;
  font-size: 10px;
  line-height: 1.2;
  white-space: nowrap;
}
.ade-document-entry__delete {
  position: absolute;
  top: 9px;
  right: 6px;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #a1a1aa;
  opacity: 0;
  cursor: pointer;
}
.ade-document-entry:hover .ade-document-entry__delete {
  opacity: 1;
}
.ade-document-entry__delete:hover {
  background: #3A2323;
  color: #E06B6B;
}
.ade-document-rail__empty {
  padding: 28px 12px;
  color: #8B9BB1;
  font-size: 11px;
  text-align: center;
}
</style>
