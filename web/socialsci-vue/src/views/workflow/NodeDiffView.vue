<script setup lang="ts">
/**
 * NodeDiffView — 章节级版本对比(V425 D3)
 *
 * 用途: 在版本历史里选一条历史, 看它**和现在**差在哪 —— 只读, 不改任何数据。
 *   在此之前"看上一版写了什么"的唯一途径是回滚(覆盖当前), 而对比本来就是个只读动作。
 *
 * 粒度是**章**而不是整个节点: 一个 sections 节点装着全部章节, 整节点对比动辄上万字,
 *   混在一起看不出"哪一章被改了"。所以先按章列出改动概览(改了几段/删了几段/加了几个字),
 *   点进去才展开那一段的段落级差异。
 *
 * 对齐策略见 shared/diff.ts(前缀/后缀对齐 + 中段按相似度贪心配对)。
 */
import { ref, computed, watch } from "vue";
import { getNodeHistoryPayload } from "@/shared/tasks";
import { diffParagraphs, diffStats, type ParaDiff } from "@/shared/diff";
import EmptyState from "./EmptyState.vue";

const props = defineProps<{
  open: boolean;
  projectId: string;
  nodeKey: string;
  nodeLabel: string;
  /** 被对比的历史版本 */
  historyId: string;
  historyVersion: number;
  /** 当前内容(payload) —— 由调用方读好传进来, 本组件不自己查当前态 */
  currentPayload: Record<string, unknown> | null;
}>();
const emit = defineEmits<{ (e: "close"): void }>();

const loading = ref(false);
const error = ref("");
const oldPayload = ref<Record<string, unknown> | null>(null);

watch(
  () => [props.open, props.historyId],
  async ([o]) => {
    if (!o || !props.historyId) return;
    loading.value = true;
    error.value = "";
    oldPayload.value = null;
    try {
      const p = await getNodeHistoryPayload(props.projectId, props.nodeKey, props.historyId);
      if (!p) { error.value = "取不到该历史版本的完整内容"; return; }
      oldPayload.value = p;
    } catch (e) {
      error.value = (e as Error).message || "加载失败";
    } finally {
      loading.value = false;
    }
  },
  { immediate: true }
);

/**
 * 把一份 payload 摊成"可比条目"。
 *
 * 不同节点装的不是一个东西: sections 节点是 `{sections: [{id,title,content}]}`(一条一章),
 *   finalize 节点是 `{mergedFullText, mergedTitle, mergedAbstract, ...}`(一条一项)。
 *   统一成 {key, label, text} 之后, 对比逻辑只需要面对一种形状。
 *   认不出来的节点就整体当一个条目 —— 至少还能看到"变了/没变", 好过什么都不显示。
 */
interface Item { key: string; label: string; text: string }
function toItems(payload: Record<string, unknown> | null): Item[] {
  if (!payload) return [];
  const secs = payload.sections;
  if (Array.isArray(secs)) {
    return secs.map((s, i) => {
      const o = (s ?? {}) as Record<string, unknown>;
      return {
        key: String(o.id ?? `idx-${i}`),
        // 前导序号与等级标出来, 否则同名章节(如两处"小结")分不清是哪一条
        label: `${i + 1}. ${String(o.title ?? "未命名章节")}`,
        text: String(o.content ?? ""),
      };
    });
  }
  const FIELDS: Array<[string, string]> = [
    ["mergedFullText", "正文"],
    ["mergedTitle", "标题"],
    ["mergedAbstract", "摘要"],
    ["mergedKeywords", "关键词"],
    ["mergedReferences", "参考文献"],
  ];
  const out: Item[] = [];
  for (const [k, label] of FIELDS) {
    const v = payload[k];
    if (typeof v === "string" && v.trim()) out.push({ key: k, label, text: v });
  }
  if (!out.length) {
    // 兜底: 把所有字符串字段拼成一个条目, 名字用真实键名(不假装知道它是什么)
    const parts = Object.entries(payload).filter(([, v]) => typeof v === "string" && v.trim());
    if (parts.length) out.push({ key: "__all__", label: "全部文本字段", text: parts.map(([k, v]) => `【${k}】\n${v}`).join("\n\n") });
  }
  return out;
}

const before = computed(() => toItems(oldPayload.value));
const after = computed(() => toItems(props.currentPayload));

/** 按 key 配对(章节 id 稳定, 所以能认出"同一章的旧版与新版"), 再按"变了多少"排序 */
const rows = computed(() => {
  const bMap = new Map(before.value.map((x) => [x.key, x]));
  const aMap = new Map(after.value.map((x) => [x.key, x]));
  const keys: string[] = [];
  for (const x of before.value) keys.push(x.key);
  for (const x of after.value) if (!keys.includes(x.key)) keys.push(x.key);
  const out = keys.map((k) => {
    const b = bMap.get(k), a = aMap.get(k);
    const d = diffParagraphs(b?.text ?? "", a?.text ?? "");
    const st = diffStats(d);
    return { key: k, label: a?.label ?? b?.label ?? k, before: b?.text ?? "", after: a?.text ?? "", segs: d, stats: st, changed: st.changed + st.removed + st.added };
  });
  // 改动多的排前面 —— 用户打开对比就是想看"哪里不一样"
  return out.sort((x, y) => y.changed - x.changed);
});

const total = computed(() => rows.value.reduce((n, r) => n + r.changed, 0));
const expanded = ref<Set<string>>(new Set());
function toggle(k: string) {
  const s = new Set(expanded.value);
  if (s.has(k)) s.delete(k); else s.add(k);
  expanded.value = s;
}
const nChars = (s: string) => s.replace(/\s/g, "").length;
const KIND_LABEL: Record<ParaDiff["kind"], string> = { same: "", changed: "改写", removed: "删除", added: "新增" };
</script>

<template>
  <div v-if="open" class="nd-mask" @click.self="emit('close')">
    <div class="nd-card" data-control="workflow:diff-view">
      <header class="nd-head">
        <div>
          <h3>版本对比 · {{ nodeLabel }}</h3>
          <p class="nd-sub">左边是 v{{ historyVersion }}（历史），右边是当前内容。**只读**，不会改动任何数据。</p>
        </div>
        <button class="nd-x" data-control="workflow:diff-close" @click="emit('close')">×</button>
      </header>

      <div class="nd-body">
        <p v-if="loading" class="nd-loading">加载中…</p>
        <p v-else-if="error" class="nd-err">{{ error }}</p>
        <template v-else-if="rows.length">
          <p class="nd-sum">
            共 {{ rows.length }} 项，
            <strong :class="{ 'is-changed': total > 0 }">{{ total > 0 ? `${total} 项有改动` : "完全一致" }}</strong>
          </p>
          <div v-for="r in rows" :key="r.key" class="nd-row" :class="{ 'is-changed': r.changed > 0 }">
            <div class="nd-row-head" :data-control="`workflow:diff-row-${r.key}`" @click="toggle(r.key)">
              <span class="nd-caret">{{ expanded.has(r.key) ? "▾" : "▸" }}</span>
              <strong class="nd-row-title">{{ r.label }}</strong>
              <span class="nd-delta"> {{ nChars(r.before) }} → {{ nChars(r.after) }} 字 </span>
              <span v-if="r.stats.changed" class="nd-tag is-mod">改写 {{ r.stats.changed }}</span>
              <span v-if="r.stats.removed" class="nd-tag is-del">删 {{ r.stats.removed }} 段</span>
              <span v-if="r.stats.added" class="nd-tag is-add">增 {{ r.stats.added }} 段</span>
              <span v-if="!r.changed" class="nd-tag is-same">无改动</span>
            </div>

            <div v-if="expanded.has(r.key)" class="nd-diff">
              <div v-for="(s, i) in r.segs" :key="i" class="nd-para" :class="`is-${s.kind}`">
                <span v-if="s.kind !== 'same'" class="nd-para-tag">{{ KIND_LABEL[s.kind] }}</span>
                <template v-if="s.kind === 'same'">{{ (s as { text: string }).text }}</template>
                <template v-else-if="s.kind === 'changed'">
                  <span v-for="(g, gi) in (s as { segs: Array<{ t: string; s: string }> }).segs" :key="gi" :class="`g-${g.t}`">{{ g.s }}</span>
                </template>
                <template v-else>{{ (s as { text: string }).text }}</template>
              </div>
            </div>
          </div>
        </template>
        <EmptyState
          v-else
          size="md"
          icon="⊟"
          title="没有可对比的内容"
          hint="该历史版本与当前版本里都没有文本字段，或者取不到内容。"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.nd-mask { position: fixed; inset: 0; z-index: 97; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; }
.nd-card {
  width: min(900px, 94vw); max-height: 88vh; display: flex; flex-direction: column;
  background: var(--wf-surface); border: 1px solid var(--wf-line); border-radius: var(--wf-r);
}
.nd-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 16px 20px 12px; border-bottom: 1px solid var(--wf-line); }
.nd-head h3 { margin: 0; font-size: var(--wf-f-lg); color: var(--wf-text); }
.nd-sub { margin: 5px 0 0; font-size: var(--wf-f-sm); color: var(--wf-muted); }
.nd-x { border: 0; background: none; font-size: 22px; line-height: 1; color: var(--wf-muted); cursor: pointer; }
.nd-x:hover { color: var(--wf-text); }
.nd-body { flex: 1; overflow-y: auto; padding: 14px 20px 22px; }
.nd-sum { margin: 0 0 12px; font-size: var(--wf-f-sm); color: var(--wf-muted); }
.nd-sum .is-changed { color: #E8B54A; }
.nd-row { border-bottom: 1px solid var(--wf-line); }
.nd-row-head { display: flex; align-items: center; gap: 8px; padding: 9px 2px; cursor: pointer; flex-wrap: wrap; }
.nd-row-head:hover { background: var(--wf-raised); }
.nd-caret { color: var(--wf-faint); width: 12px; flex-shrink: 0; }
.nd-row-title { font-size: var(--wf-f-sm); color: var(--wf-text); font-weight: 600; }
.nd-delta { font-size: 11px; color: var(--wf-faint); font-variant-numeric: tabular-nums; }
.nd-tag { font-size: 11px; padding: 0 6px; border-radius: var(--wf-r-pill); border: 1px solid var(--wf-line); color: var(--wf-faint); }
.nd-tag.is-mod { color: #E8B54A; border-color: #7A6428; }
.nd-tag.is-del { color: #E1756B; border-color: #7A3A34; }
.nd-tag.is-add { color: #6FAE7C; border-color: #35603E; }
/* 无改动的行压暗 —— 打开对比时它们不该抢注意力 */
.nd-row:not(.is-changed) .nd-row-title { color: var(--wf-muted); font-weight: 400; }
.nd-diff { padding: 4px 2px 14px; }
.nd-para { position: relative; padding: 6px 10px 6px 12px; margin-bottom: 6px; border-left: 2px solid transparent; border-radius: 0 var(--wf-r-sm) var(--wf-r-sm) 0; font-size: var(--wf-f-sm); line-height: 1.85; color: var(--wf-text-2); white-space: pre-wrap; word-break: break-word; }
.nd-para.is-same { border-left-color: transparent; opacity: .55; }
.nd-para.is-changed { border-left-color: #7A6428; background: rgba(232, 181, 74, .06); }
.nd-para.is-removed { border-left-color: #7A3A34; background: rgba(225, 117, 107, .07); }
.nd-para.is-added { border-left-color: #35603E; background: rgba(111, 174, 124, .07); }
.nd-para-tag { display: inline-block; margin-right: 8px; font-size: 10px; color: var(--wf-faint); }
.g-del { background: rgba(225, 117, 107, .22); text-decoration: line-through; }
.g-add { background: rgba(111, 174, 124, .22); }
.nd-loading, .nd-err { margin: 10px 0; font-size: var(--wf-f-sm); color: var(--wf-muted); }
.nd-err { color: #E1756B; }
</style>
