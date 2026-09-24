<script setup lang="ts">
/**
 * DataCollectionPanel —— 数据收集(问卷生成/识别)
 *
 * 由来(2026-09-24): 真实科研流程里"选题 → 设计 → **收集数据** → 分析 → 写作"是一整条,
 *   而写作舱从"框架设计"直接跳到"生成素材", 中间"数据从哪来"这一整段是空的。
 *   后端其实有 `empirical-questionnaire-service`(问卷生成/识别/落库), 只是写作舱零引用。
 *
 * ⚠ 归属: 问卷挂在 **empirical 课题** 下(projectId 是 empirical_projects 的 id),
 *   与写作舱的 research_projects **不是同一个 id 空间**(全仓没有把它们连起来的列)。
 *   所以这里刻意**不传 projectId** —— 传写作舱的 id 会写进一个没人能再查到的位置。
 *   不归属 = 归到"未分组的问卷", 在「实证研究」工作台里能看到、能继续用。
 *   这是诚实的做法: 宁可在那边多一步挑选, 也不制造一批查不回来的孤儿数据。
 */
import { ref } from "vue";
import { toast } from "@/shared/ui";
import { q } from "@/shared/api";
import { gotoWorkbenchModule } from "@/shared/workflow-bridge";

const props = defineProps<{
  /** 研究主题 —— 生成问卷时的默认题目来源 */
  topic: string;
}>();

const mode = ref<"generate" | "recognize">("generate");
const busy = ref(false);

// ── 生成 ──
const genTitle = ref("");
const genTopic = ref("");
const genCount = ref(20);

// ── 识别 ──
const recogTitle = ref("");
const recogText = ref("");

/** 上次产出的问卷(仅用于就地反馈条数, 真正的管理在「实证研究」工作台) */
const last = ref<{ title: string; count: number } | null>(null);

function fillFromTopic() {
  if (!genTopic.value.trim() && props.topic) genTopic.value = props.topic;
  if (!genTitle.value.trim() && props.topic) genTitle.value = `${props.topic}调查问卷`;
}

async function runGenerate() {
  fillFromTopic();
  const topic = genTopic.value.trim() || props.topic.trim();
  const title = genTitle.value.trim() || `${topic || "研究"}调查问卷`;
  if (!topic) { toast("请先填写研究主题", "warning"); return; }
  busy.value = true;
  last.value = null;
  try {
    // 不传 projectId: 见文件头说明(两套 id 空间不通, 传了会变成查不回来的孤儿)
    const r = await q<{ questionnaire?: { id?: string; title?: string; questions?: unknown[] } }>(
      "/empirical/questionnaires/generate",
      { method: "POST", body: { title, topic, count: genCount.value } },
    );
    const n = r.questionnaire?.questions?.length ?? 0;
    last.value = { title: r.questionnaire?.title ?? title, count: n };
    toast(`问卷已生成：${n} 题`, "success");
  } catch (e) {
    toast(`生成失败：${(e as Error).message}`, "error");
  } finally {
    busy.value = false;
  }
}

async function runRecognize() {
  const raw = recogText.value.trim();
  if (raw.length < 20) { toast("请粘贴问卷原文（至少 20 字）", "warning"); return; }
  busy.value = true;
  last.value = null;
  try {
    const r = await q<{ questionnaire?: { id?: string; title?: string; questions?: unknown[] } }>(
      "/empirical/questionnaires/recognize",
      { method: "POST", body: { title: recogTitle.value.trim() || "上传问卷", rawText: raw } },
    );
    const n = r.questionnaire?.questions?.length ?? 0;
    last.value = { title: r.questionnaire?.title ?? "上传问卷", count: n };
    toast(`已识别：${n} 题`, "success");
  } catch (e) {
    toast(`识别失败：${(e as Error).message}`, "error");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="dcp">
    <p class="dcp-sub">
      论文用的问卷、访谈提纲在这里产出，随后到「实证研究」里回收数据、跑统计。
      <button class="dcp-link" data-control="workflow:dc-goto-empirical" @click="gotoWorkbenchModule('empirical-research', { label: '研途写作舱 · 文献与资料', path: '/workflow/materials' })">
        前往实证研究工作台 ›
      </button>
    </p>

    <div class="dcp-tabs">
      <button class="dcp-tab" :class="{ on: mode === 'generate' }" data-control="workflow:dc-mode-generate" @click="mode = 'generate'">按主题生成</button>
      <button class="dcp-tab" :class="{ on: mode === 'recognize' }" data-control="workflow:dc-mode-recognize" @click="mode = 'recognize'">粘贴/识别已有问卷</button>
    </div>

    <!-- 生成 -->
    <div v-if="mode === 'generate'" class="dcp-form">
      <label class="dcp-row"><span>研究主题</span>
        <input v-model="genTopic" class="dcp-input" :placeholder="topic || '例：农村土地流转意愿'" data-control="workflow:dc-gen-topic" />
      </label>
      <label class="dcp-row"><span>问卷标题</span>
        <input v-model="genTitle" class="dcp-input" placeholder="留空则按主题自动命名" data-control="workflow:dc-gen-title" />
      </label>
      <label class="dcp-row dcp-row--narrow"><span>题目数量</span>
        <input v-model.number="genCount" type="number" min="5" max="80" class="dcp-input" />
      </label>
      <button class="dcp-btn dcp-btn--go" data-control="workflow:dc-generate" :disabled="busy" @click="runGenerate">
        {{ busy ? "生成中…" : "生成问卷" }}
      </button>
    </div>

    <!-- 识别 -->
    <div v-else class="dcp-form">
      <label class="dcp-row"><span>问卷标题</span>
        <input v-model="recogTitle" class="dcp-input" placeholder="留空则叫「上传问卷」" data-control="workflow:dc-recog-title" />
      </label>
      <label class="dcp-row dcp-row--col"><span>问卷原文</span>
        <textarea v-model="recogText" class="dcp-area" rows="6" placeholder="把已有问卷的题目粘进来，会识别成结构化条目…" data-control="workflow:dc-recog-text"></textarea>
      </label>
      <button class="dcp-btn dcp-btn--go" data-control="workflow:dc-recognize" :disabled="busy" @click="runRecognize">
        {{ busy ? "识别中…" : "识别问卷" }}
      </button>
    </div>

    <p v-if="last" class="dcp-ok">
      已保存「{{ last.title }}」（{{ last.count }} 题）。它在「实证研究」工作台的问卷列表里，可直接用来回收数据。
    </p>
    <p class="dcp-note">
      说明：问卷归在实证研究那边（两套课题编号不通用），所以这里不挂到本写作课题下 ——
      免得出现一份在哪儿都查不到的问卷。
    </p>
  </div>
</template>

<style scoped>
.dcp { display: flex; flex-direction: column; gap: var(--wf-s3); }
.dcp-sub { margin: 0; font-size: var(--wf-f-sm); color: var(--wf-muted); line-height: 1.7; }
.dcp-link {
  cursor: pointer; border: 0; background: transparent; padding: 0;
  color: var(--wf-accent-hi); font-size: var(--wf-f-sm); text-decoration: underline;
}
.dcp-tabs { display: flex; gap: 6px; }
.dcp-tab {
  cursor: pointer; border: 1px solid var(--wf-line-strong); border-radius: var(--wf-r-pill);
  background: transparent; color: var(--wf-muted); padding: 3px 12px; font-size: var(--wf-f-xs);
}
.dcp-tab.on { border-color: var(--wf-accent); color: var(--wf-accent-hi); background: var(--wf-accent-soft); }
.dcp-form { display: flex; flex-direction: column; gap: var(--wf-s2); align-items: stretch; }
.dcp-row { display: flex; align-items: center; gap: var(--wf-s3); font-size: var(--wf-f-sm); color: var(--wf-text-2); }
.dcp-row > span { flex: 0 0 72px; }
.dcp-row--col { align-items: flex-start; }
.dcp-row--narrow .dcp-input { max-width: 110px; }
.dcp-input, .dcp-area {
  flex: 1; min-width: 0; border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-surface-2); color: var(--wf-text); padding: 5px 9px; font-size: var(--wf-f-sm);
}
.dcp-area { resize: vertical; font-family: inherit; }
.dcp-btn {
  align-self: flex-start; cursor: pointer;
  border: 1px solid var(--wf-line-strong); border-radius: var(--wf-r-sm);
  background: transparent; color: var(--wf-text-2); padding: 5px 14px; font-size: var(--wf-f-sm);
}
.dcp-btn:disabled { opacity: .5; cursor: not-allowed; }
.dcp-btn--go { border-color: var(--wf-accent); color: var(--wf-accent-hi); }
.dcp-btn--go:hover:not(:disabled) { background: var(--wf-accent-soft); }
.dcp-ok { margin: 0; font-size: var(--wf-f-sm); color: var(--wf-ok); line-height: 1.7; }
.dcp-note { margin: 0; font-size: var(--wf-f-xs); color: var(--wf-faint); line-height: 1.6; }
</style>
