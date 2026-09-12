<script setup lang="ts">
/** VersionHistory 抽屉 — 还原自闭源 EditorView E:19953-20143: 版本列表 + 恢复(confirm 提示"当前内容将自动备份为新版本") */
import { ref, watch, onMounted } from "vue";
import { editorApi } from "@/shared/editorApi";
import { toast, confirmDialog } from "@/shared/ui";
import { fmtMeta, zhCount } from "@/shared/constants";

const props = defineProps<{ documentId: string | null; isOpen: boolean }>();
const emit = defineEmits<{ (e: "close"): void; (e: "restored"): void }>();

const versions = ref<Array<{ id: string; version_num: number; created_at: string; change_summary?: string; word_count?: number }>>([]);
const loading = ref(false);

async function load() {
  if (!props.documentId) return;
  loading.value = true;
  try {
    versions.value = await editorApi.versions(props.documentId);
  } catch {
    versions.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.documentId, props.isOpen] as const,
  ([docId, open]) => {
    if (open && docId) void load();
  }
);
onMounted(() => {
  if (props.isOpen && props.documentId) void load();
});

async function restore(v: { id: string; version_num: number }) {
  const ok = await confirmDialog({
    message: `恢复到 v${v.version_num}? 当前内容将自动备份为新版本。`,
    title: "恢复版本",
    okText: "恢复"
  });
  if (!ok) return;
  try {
    await editorApi.restoreVersion(props.documentId!, v.id);
    toast(`已恢复至 v${v.version_num}`, "success");
    emit("restored");
    void load();
  } catch (e) {
    toast(`恢复失败: ${(e as Error).message}`, "error");
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="fixed inset-0 z-[60] flex justify-end bg-black/10" @click.self="emit('close')">
      <div class="ade-version-history" :class="{ 'ade-version-history--open': isOpen }">
        <div class="flex items-center justify-between px-4 py-3" style="border-bottom: 1px solid #222F44">
          <h3 style="margin: 0; font-size: 14px; font-weight: 700; color: #E8EEF7">版本历史</h3>
          <button class="border-0 bg-transparent text-lg text-[#7A8AA0]" @click="emit('close')">×</button>
        </div>
        <div style="flex: 1; overflow-y: auto; padding: 8px">
          <div v-if="loading" style="padding: 24px; text-align: center; color: #7A8AA0; font-size: 12px">加载中…</div>
          <div v-else-if="!versions.length" style="padding: 24px; text-align: center; color: #7A8AA0; font-size: 12px">暂无版本记录</div>
          <div
            v-for="v in versions"
            :key="v.id"
            class="ade-version-item"
            style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 10px; border-radius: 7px; margin-bottom: 3px; cursor: pointer"
            @click="restore(v)"
          >
            <div style="display: flex; flex-direction: column; gap: 2px; min-width: 0">
              <span style="font-size: 12.5px; font-weight: 600; color: #E8EEF7">v{{ v.version_num }}<span v-if="v.change_summary" style="color: #8B9BB1; font-weight: 400; margin-left: 6px">{{ v.change_summary }}</span></span>
              <span style="font-size: 10.5px; color: #7A8AA0">{{ fmtMeta(v.created_at) }} · {{ zhCount(v.word_count) }} 字</span>
            </div>
            <span style="font-size: 11px; color: #2563eb; white-space: nowrap">恢复</span>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ade-version-history {
  width: min(300px, 100%);
  max-width: 88vw;
  height: 100%;
  background: #11192C;
  border-left: 1px solid #222F44;
  display: flex;
  flex-direction: column;
  box-shadow: -12px 0 32px rgba(15, 23, 42, 0.08);
}
.ade-version-item:hover {
  background: #1A2333;
}
</style>
