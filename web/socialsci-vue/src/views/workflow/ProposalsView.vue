<script setup lang="ts">
/**
 * ProposalsView(申报与审查) — 开题报告 / 基金申报 / 伦理审查 / 预注册。
 *
 * ## 为什么单开一页
 *
 * 这四份材料是**项目开始之前**就要交的, 与写作舱后面五步(选题→框架→实施→资料→写作→定稿)
 * 在时间上**不重叠** —— 塞进任何一步都会让那一步名不副实。而它们又都属于同一个场景:
 * "把研究方案写成能交上去的文书"。
 *
 * ## 为什么上下文由后端自己取, 本页只传 kind
 *
 * 研究设计在设计节点里、假设台账在 hypotheses 表里 —— 都**已经填过一遍**了。
 * 让用户在生成前再填一次"你的方法是什么、假设有哪些", 是这类工具最常见的浪费。
 * 后端会自己把这两样取出来当上下文(见 server.ts 那段注释), 本页只负责触发与呈现。
 *
 * ## 为什么生成是同步的、要等一分钟
 *
 * 七节逐节生成(见 proposal-service 的注释: 一次出全文会撞 maxTokens, 且后几节会写虚)。
 * 所以**必须有等待反馈** —— 本仓踩过"点了没反应, 用户以为按钮死了"的坑。
 */
import { ref, computed, onMounted, watch } from "vue";
import { q } from "@/shared/api";
import { useWorkflowStore } from "./stores/workflow";
import { toast } from "@/shared/ui";
import WorkflowShell from "./WorkflowShell.vue";
import PhaseProgressBar from "./PhaseProgressBar.vue";

interface Spec { key: string; cn: string; audience: string; sections: Array<{ title: string; spec: string }> }
interface Doc { content?: string; title?: string; generatedAt?: string; editedAt?: string }

const store = useWorkflowStore();
const specs = ref<Spec[]>([]);
const docs = ref<Record<string, Doc>>({});
const active = ref("proposal");
const loading = ref(true);
const generating = ref(false);
const editing = ref(false);
const draft = ref("");

const pid = computed(() => store.taskId);
const cur = computed(() => specs.value.find((s) => s.key === active.value));
const curDoc = computed(() => docs.value[active.value] ?? {});

async function load() {
  if (!pid.value) { loading.value = false; return; }
  loading.value = true;
  try {
    const [sp, d] = await Promise.all([
      q<{ specs: Spec[] }>(`/research/proposals/specs`),
      q<{ proposals: Record<string, Doc> }>(`/research/projects/${pid.value}/proposals`).catch(() => ({ proposals: {} })),
    ]);
    specs.value = sp.specs ?? [];
    docs.value = d.proposals ?? {};
  } catch (e) {
    toast(`读取失败: ${(e as Error).message}`, "error");
  } finally {
    loading.value = false;
  }
}

async function generate() {
  if (!pid.value || generating.value) return;
  generating.value = true;
  try {
    const r = await q<{ ok: boolean; content: string; title: string; error?: string }>(
      `/research/projects/${pid.value}/proposals/generate`,
      { method: "POST", body: { kind: active.value } });
    if (!r.ok) { toast(r.error ?? "生成失败", "error"); return; }
    docs.value = { ...docs.value, [active.value]: { content: r.content, title: r.title, generatedAt: new Date().toISOString() } };
    /**
     * ⚠ 部分小节失败时后端**仍然 ok=true**(它会把失败的小节写成占位文本并带回 error)。
     *   这里必须把那个 error 显示出来 —— 否则用户拿到一份缺两节的材料却以为生成完整了,
     *   而这是要交上去的东西。
     */
    if (r.error) toast(r.error, "info");
    else toast(`${r.title} 已生成`, "success");
  } catch (e) {
    toast(`生成失败: ${(e as Error).message}`, "error");
  } finally {
    generating.value = false;
  }
}

function startEdit() {
  draft.value = curDoc.value.content ?? "";
  editing.value = true;
}

async function saveEdit() {
  if (!pid.value) return;
  try {
    await q(`/research/projects/${pid.value}/proposals/${active.value}`, { method: "PUT", body: { content: draft.value } });
    docs.value = { ...docs.value, [active.value]: { ...curDoc.value, content: draft.value, editedAt: new Date().toISOString() } };
    editing.value = false;
    toast("已保存", "success");
  } catch (e) {
    toast(`保存失败: ${(e as Error).message}`, "error");
  }
}

async function exportAll() {
  if (!pid.value) return;
  try {
    const r = await q<{ markdown: string }>(`/research/projects/${pid.value}/proposals/export`);
    await navigator.clipboard.writeText(r.markdown ?? "");
    toast("合集已复制到剪贴板", "success");
  } catch (e) {
    toast(`导出失败: ${(e as Error).message}`, "error");
  }
}

/** 已生成几份 —— 头部给一个总览, 免得用户在四个页签之间点来点去才知道自己有哪些 */
const generatedCount = computed(() => Object.values(docs.value).filter((d) => String(d?.content ?? "").trim()).length);

watch(() => store.taskId, () => void load());
onMounted(async () => { await store.loadProject().catch(() => null); await load(); });
</script>

<template>
  <WorkflowShell>
    <div class="workflow-page">
      <header class="wf-head">
        <h1 class="wf-h1">申报与审查</h1>
        <p class="wf-sub">
          研究开始前要交的材料：开题报告 / 基金申报 / 伦理审查 / 预注册。
          自动带上项目里已填的**研究设计**与**假设台账** —— 不用重填一遍。
        </p>
      </header>
      <PhaseProgressBar />

      <div class="pp-wrap">
        <p v-if="!pid" class="pp-muted">先选择一个研究项目。</p>
        <p v-else-if="loading" class="pp-muted">读取中…</p>

        <template v-else>
          <nav class="pp-tabs">
            <button
              v-for="s in specs" :key="s.key"
              class="pp-tab" :class="{ 'is-on': active === s.key }"
              :data-control="`workflow:pp-tab-${s.key}`"
              @click="active = s.key; editing = false"
            >
              {{ s.cn }}
              <span v-if="String(docs[s.key]?.content ?? '').trim()" class="pp-dot" title="已生成">·</span>
            </button>
            <span class="pp-count">已生成 {{ generatedCount }} / {{ specs.length }}</span>
            <button v-if="generatedCount > 1" class="pp-btn pp-btn-sm" data-control="workflow:pp-export" @click="exportAll">复制合集</button>
          </nav>

          <p v-if="cur" class="pp-audience">面向：{{ cur.audience }} · 共 {{ cur.sections.length }} 节</p>

          <section class="pp-card">
            <div class="pp-actions">
              <button class="pp-btn pp-btn-primary" :disabled="generating" data-control="workflow:pp-generate" @click="generate">
                {{ generating ? "生成中…（逐节生成，约一分钟）" : (curDoc.content ? "重新生成" : "生成") }}
              </button>
              <button v-if="curDoc.content && !editing" class="pp-btn" data-control="workflow:pp-edit" @click="startEdit">编辑</button>
              <button v-if="editing" class="pp-btn pp-btn-primary" data-control="workflow:pp-save" @click="saveEdit">保存</button>
              <button v-if="editing" class="pp-btn" data-control="workflow:pp-cancel" @click="editing = false">取消</button>
              <span v-if="curDoc.editedAt" class="pp-meta">已手改</span>
              <span v-else-if="curDoc.generatedAt" class="pp-meta">已生成</span>
            </div>

            <p v-if="generating" class="pp-wait" data-control="workflow:pp-wait">
              正在逐节生成，请勿关闭页面。某一节失败不会中断整份 —— 失败的小节会写成待补提示。
            </p>

            <textarea
              v-if="editing"
              v-model="draft" class="pp-editor" rows="24"
              data-control="workflow:pp-editor"
            ></textarea>

            <pre
              v-else-if="curDoc.content"
              class="pp-doc" data-control="workflow:pp-doc"
            >{{ curDoc.content }}</pre>

            <div v-else class="pp-empty">
              <p>还没生成。点上面的「生成」——</p>
              <p class="pp-muted">
                系统会按这一类材料的**固定节次**逐节写，并自动带上项目里已有的研究设计与假设。
                生成后可以逐字手改 —— 这是要签字交上去的材料，能改是底线。
              </p>
            </div>
          </section>
        </template>
      </div>
    </div>
  </WorkflowShell>
</template>

<style scoped>
.workflow-page { width: 100%; box-sizing: border-box; }
.wf-head { margin-bottom: 16px; }
.wf-h1 { margin: 0; font-size: 22px; font-weight: 700; color: var(--wf-text); }
.wf-sub { margin: 4px 0 0; font-size: 13px; color: var(--wf-muted); line-height: 1.7; }
.pp-wrap { margin-top: 14px; }
.pp-muted { font-size: 13px; color: var(--wf-muted); }
.pp-tabs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pp-tab {
  font-size: 13px; padding: 5px 13px; cursor: pointer; border-radius: var(--wf-r-pill);
  border: 1px solid var(--wf-line); background: var(--wf-surface); color: var(--wf-muted);
}
.pp-tab.is-on { border-color: var(--wf-accent, #6FBF8B); color: var(--wf-accent, #6FBF8B); }
.pp-dot { color: var(--wf-accent, #6FBF8B); font-weight: 700; }
.pp-count { margin-left: auto; font-size: 12px; color: var(--wf-faint); }
.pp-audience { font-size: 12px; color: var(--wf-faint); margin: 10px 0 0; }
.pp-card {
  margin-top: 10px; border: 1px solid var(--wf-line); border-radius: var(--wf-r);
  background: var(--wf-surface); padding: 14px 16px;
}
.pp-actions { display: flex; align-items: center; gap: 8px; }
.pp-meta { margin-left: auto; font-size: 11px; color: var(--wf-faint); }
.pp-btn {
  font-size: 12.5px; padding: 5px 12px; cursor: pointer; border-radius: var(--wf-r-pill);
  border: 1px solid var(--wf-line); background: var(--wf-bg); color: var(--wf-text);
}
.pp-btn:disabled { opacity: .5; cursor: not-allowed; }
.pp-btn-sm { font-size: 11.5px; padding: 3px 10px; }
.pp-btn-primary { border-color: var(--wf-accent, #6FBF8B); color: var(--wf-accent, #6FBF8B); }
.pp-wait { font-size: 12.5px; color: #D9A441; margin: 10px 0 0; }
.pp-doc, .pp-editor {
  margin-top: 12px; width: 100%; box-sizing: border-box; background: var(--wf-bg);
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm, 6px);
  padding: 12px 14px; font-size: 13px; line-height: 1.85; color: var(--wf-text);
  white-space: pre-wrap; font-family: inherit; max-height: 620px; overflow: auto;
}
.pp-editor { resize: vertical; min-height: 420px; }
.pp-empty { margin-top: 12px; font-size: 13px; color: var(--wf-text); line-height: 1.8; }
.pp-empty .pp-muted { margin-top: 6px; }
</style>
