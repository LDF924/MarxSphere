<script setup lang="ts">
/**
 * DesignRationalePanel —— 选题论证(可行性/创新性/表述/合规)
 *
 * 由来(2026-09-24): 真实科研流程的第一步不是"填个题", 而是**论证这个题能不能做、值不值得做**。
 *   写作舱此前只有"填个题" —— 而 `cjournal-service` 里早就备好了一整套选题检验
 *   (期刊库那批服务的一部分), 写作舱零引用。
 *
 * 为什么选这四项、以及为什么它们不必请示用户:
 *   · 模板腔检验 / 范围检验 —— **纯本地纯函数**(`checkTopicTemplate` / `checkTopicScope`),
 *     不调模型、不出网, 所以进页面就直接算, 用户不必点任何东西。
 *   · 编辑标准 / 主线检验 —— 调模型。这两项是**判断**, 不是字符统计, 让用户自己决定何时花这个钱。
 *
 * 刻意不做的: 不把结果揉成一个"选题得分 87 分"。四项衡量的东西彼此独立
 *   (表述像不像模板、范围收不收得拢、符不符合编辑标准、在主线上有没有偏), 合成一个分数
 *   只会把这个区别抹掉, 而区别恰恰是有用的部分。
 */
import { computed, onMounted, ref, watch } from "vue";
import { toast } from "@/shared/ui";
import { q } from "@/shared/api";

const props = defineProps<{
  /** 研究主题(选题界定页填的标题) */
  topic: string;
}>();

const t = computed(() => props.topic.trim());

// ── 本地两项(纯函数, 免费, 自动算) ──
interface TemplateCheck { isTemplate: boolean; hits: string[]; advice: string }
interface ScopeCheck { tooBroad: boolean; reasons: string[]; narrowed: string[] }
const tpl = ref<TemplateCheck | null>(null);
const scope = ref<ScopeCheck | null>(null);
const localBusy = ref(false);

async function runLocal() {
  if (!t.value) { tpl.value = null; scope.value = null; return; }
  localBusy.value = true;
  try {
    const [a, b] = await Promise.all([
      q<{ result?: TemplateCheck }>("/cjournal/template-check", { method: "POST", body: { topic: t.value } }),
      q<{ result?: ScopeCheck }>("/cjournal/scope-check", { method: "POST", body: { topic: t.value } }),
    ]);
    tpl.value = a.result ?? null;
    scope.value = b.result ?? null;
  } catch {
    // 这两项失败不该挡住页面 —— 下面的 LLM 两项照常可用
    tpl.value = null;
    scope.value = null;
  } finally {
    localBusy.value = false;
  }
}

// 主题一改就重算(这两个调用很便宜: 后端是纯函数, 没有模型也没有出网)。
// 防抖 600ms —— 边打字边发请求没必要。
let timer: number | undefined;
watch(t, () => {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void runLocal(), 600);
});
onMounted(() => void runLocal());

// ── 模型两项(要花钱, 手动触发) ──
interface EditorCheck { checks?: Array<{ standard: string; passed: boolean; feedback: string }>; verdict?: string }
interface MainlineCheck { onMainline?: boolean; assessment?: string; coreCategory?: string }
const editor = ref<EditorCheck | null>(null);
const mainline = ref<MainlineCheck | null>(null);
const llmRunning = ref(false);

async function runLlm() {
  if (!t.value) { toast("请先填写研究主题", "warning"); return; }
  llmRunning.value = true;
  editor.value = null;
  mainline.value = null;
  try {
    const [a, b] = await Promise.all([
      q<{ result?: EditorCheck }>("/cjournal/validate", { method: "POST", body: { topic: t.value } }),
      q<{ result?: MainlineCheck }>("/cjournal/mainline-check", { method: "POST", body: { topic: t.value } }),
    ]);
    editor.value = a.result ?? null;
    mainline.value = b.result ?? null;
    toast("论证完成", "success");
  } catch (e) {
    toast(`论证失败：${(e as Error).message}`, "error");
  } finally {
    llmRunning.value = false;
  }
}
</script>

<template>
  <div class="drp">
    <p class="drp-sub">
      先把题立住，再往下走。前两项是本地规则（不花钱，改题即重算）；后两项要调模型判断。
    </p>

    <p v-if="!t" class="drp-note">还没有研究主题 —— 在上方「研究主题」里填写后，这里会自动给出论证。</p>

    <template v-else>
      <!-- ① 表述 -->
      <div class="drp-card" :class="tpl?.isTemplate ? 'is-warn' : 'is-ok'">
        <div class="drp-card-head">
          <span class="drp-num">1</span>
          <strong>表述</strong>
          <span class="drp-tag" :class="tpl?.isTemplate ? 'is-warn' : 'is-ok'">
            {{ tpl ? (tpl.isTemplate ? "疑似模板腔" : "未见模板腔") : (localBusy ? "检查中…" : "—") }}
          </span>
        </div>
        <p v-if="tpl?.advice" class="drp-body">{{ tpl.advice }}</p>
        <ul v-if="tpl?.hits?.length" class="drp-list">
          <li v-for="(h, i) in tpl.hits" :key="i">命中：{{ h }}</li>
        </ul>
      </div>

      <!-- ② 范围 -->
      <div class="drp-card" :class="scope?.tooBroad ? 'is-warn' : 'is-ok'">
        <div class="drp-card-head">
          <span class="drp-num">2</span>
          <strong>范围</strong>
          <span class="drp-tag" :class="scope?.tooBroad ? 'is-warn' : 'is-ok'">
            {{ scope ? (scope.tooBroad ? "偏宽" : "范围合适") : (localBusy ? "检查中…" : "—") }}
          </span>
        </div>
        <ul v-if="scope?.reasons?.length" class="drp-list">
          <li v-for="(r, i) in scope.reasons" :key="i">{{ r }}</li>
        </ul>
        <div v-if="scope?.narrowed?.length" class="drp-narrow">
          <span class="drp-narrow-label">收窄建议</span>
          <ul class="drp-list">
            <li v-for="(n, i) in scope.narrowed" :key="i">{{ n }}</li>
          </ul>
        </div>
      </div>

      <button class="drp-btn drp-btn--go" data-control="workflow:design-run" :disabled="llmRunning" @click="runLlm">
        {{ llmRunning ? "论证中…" : "评估创新性与编辑标准" }}
      </button>

      <!-- ③ 编辑标准 -->
      <div v-if="editor" class="drp-card">
        <div class="drp-card-head">
          <span class="drp-num">3</span>
          <strong>编辑标准</strong>
          <span v-if="editor.verdict" class="drp-verdict">{{ editor.verdict }}</span>
        </div>
        <ul class="drp-list">
          <li v-for="(c, i) in editor.checks ?? []" :key="i" class="drp-check">
            <span class="drp-dot" :class="c.passed ? 'is-ok' : 'is-warn'" />
            <span class="drp-check-name">{{ c.standard }}</span>
            <span class="drp-check-fb">{{ c.feedback }}</span>
          </li>
        </ul>
      </div>

      <!-- ④ 主线 -->
      <div v-if="mainline" class="drp-card" :class="mainline.onMainline ? 'is-ok' : 'is-warn'">
        <div class="drp-card-head">
          <span class="drp-num">4</span>
          <strong>研究主线</strong>
          <span class="drp-tag" :class="mainline.onMainline ? 'is-ok' : 'is-warn'">
            {{ mainline.onMainline ? "在主线上" : "可能偏离主线" }}
          </span>
        </div>
        <p v-if="mainline.coreCategory" class="drp-note">命中核心范畴：{{ mainline.coreCategory }}</p>
        <p v-if="mainline.assessment" class="drp-body">{{ mainline.assessment }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.drp { display: flex; flex-direction: column; gap: var(--wf-s2); }
.drp-sub { margin: 0 0 var(--wf-s1); font-size: var(--wf-f-xs); color: var(--wf-muted); line-height: 1.7; }
.drp-note { margin: 0; font-size: var(--wf-f-xs); color: var(--wf-faint); line-height: 1.6; }
.drp-card {
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-surface-2); padding: 8px 11px;
}
.drp-card.is-ok { border-left: 3px solid var(--wf-ok); }
.drp-card.is-warn { border-left: 3px solid var(--wf-warn); }
.drp-card-head { display: flex; align-items: center; gap: var(--wf-s2); }
.drp-num {
  display: grid; place-items: center; width: 16px; height: 16px; flex-shrink: 0;
  border-radius: 50%; background: var(--wf-accent-soft); color: var(--wf-accent-hi); font-size: 10px;
}
.drp-card-head strong { font-size: var(--wf-f-sm); color: var(--wf-text); }
.drp-tag {
  margin-left: auto; font-size: var(--wf-f-xs);
  border: 1px solid currentColor; border-radius: var(--wf-r-pill); padding: 1px 8px;
}
.drp-tag.is-ok { color: var(--wf-ok); }
.drp-tag.is-warn { color: var(--wf-warn); }
.drp-verdict { margin-left: auto; font-size: var(--wf-f-xs); color: var(--wf-text-2); }
.drp-body { margin: 6px 0 0; font-size: var(--wf-f-xs); color: var(--wf-text-2); line-height: 1.7; }
.drp-list { list-style: none; margin: 5px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.drp-list li { font-size: var(--wf-f-xs); color: var(--wf-muted); line-height: 1.6; }
.drp-narrow { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--wf-line-soft); }
.drp-narrow-label { font-size: var(--wf-f-xs); color: var(--wf-accent-hi); }
.drp-check { display: flex; align-items: baseline; gap: 6px; }
.drp-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; align-self: center; }
.drp-dot.is-ok { background: var(--wf-ok); }
.drp-dot.is-warn { background: var(--wf-warn); }
.drp-check-name { flex-shrink: 0; color: var(--wf-text-2); }
.drp-check-fb { color: var(--wf-muted); }
.drp-btn {
  align-self: flex-start; cursor: pointer;
  border: 1px solid var(--wf-line-strong); border-radius: var(--wf-r-sm);
  background: transparent; color: var(--wf-text-2); padding: 5px 14px; font-size: var(--wf-f-sm);
}
.drp-btn:disabled { opacity: .5; cursor: not-allowed; }
.drp-btn--go { border-color: var(--wf-accent); color: var(--wf-accent-hi); }
.drp-btn--go:hover:not(:disabled) { background: var(--wf-accent-soft); }
</style>
