<script setup lang="ts">
/**
 * NumberCheckPanel —— 正文数字核验
 *
 * 由来(2026-09-25): 这是"真实科研"的**硬判据**。在此之前, 正文里写什么数字都没有任何约束 ——
 *   用户跑完回归拿到系数 0.312, 生成出来的正文写"系数为 0.45"也照样通过;
 *   审稿人要核的是"你正文里那个数在结果表里有没有", 而系统自己从没核过。
 *
 * 判据(三条, 都是刻意的):
 *   ① 只比对**本章依据**里的数, 不比全库 —— 依据是"用户声明这一章依据什么",
 *      引用别的文献里的数字本就不该拿本课题的数据去核;
 *   ② 允许**任意位数的四舍五入**(0.3125 写成 0.31 算对) —— 写几位小数是表述选择, 不是错误;
 *   ③ **只报告, 不改写**。系统能证明"这个数不在你的结果里", 但不能替你决定改成什么:
 *      也许它来自另一次没选进依据的分析(那是依据没选全), 也许是从别处引的(那就该标出处)。
 *      自动"修正"成最接近的系数是最糟的 —— 那会把一句标了出处的引文变成假数据。
 */
import { ref } from "vue";
import { q } from "@/shared/api";

interface Check {
  raw: string; value: number; context: string;
  status: "matched" | "unmatched"; matchedVia: string; suggestion?: string;
}
type SkipReason = "citation" | "reference" | "year" | "threshold";
interface Skipped { raw: string; reason: SkipReason; context: string }

const props = defineProps<{
  projectId: string;
  sectionId: string;
  /** 正文可以从前端传(编辑器里未保存的版本); 不传后端取节点里的 */
  content?: string;
}>();

const running = ref(false);
const result = ref<{
  checks: Check[]; matched: number; unmatched: number; basisNumbers: number; basisCount: number;
  skipped?: Skipped[]; skippedByReason?: Record<SkipReason, number>;
} | null>(null);
const error = ref("");
const showMatched = ref(false);
const showSkipped = ref(false);

const SKIP_CN: Record<SkipReason, string> = {
  citation: "引用标注里的数字", reference: "图表/公式编号", year: "年份", threshold: "显著性阈值",
};

async function run() {
  if (!props.projectId || !props.sectionId) { error.value = "请先选择章节"; return; }
  running.value = true;
  error.value = "";
  try {
    result.value = await q(`/research/projects/${props.projectId}/chapters/${encodeURIComponent(props.sectionId)}/verify-numbers`, {
      method: "POST",
      body: props.content !== undefined ? { content: props.content } : {},
    });
  } catch (e) {
    error.value = String((e as Error).message ?? e).slice(0, 160);
    result.value = null;
  } finally {
    running.value = false;
  }
}

const unmatched = () => (result.value?.checks ?? []).filter((c) => c.status === "unmatched");
const matched = () => (result.value?.checks ?? []).filter((c) => c.status === "matched");
const skippedList = () => result.value?.skipped ?? [];
/** 只列出真正跳过的类别, 不显示"跳过了 0 个引用"这种噪音 */
const skippedSummary = () => {
  const by = result.value?.skippedByReason;
  if (!by) return [];
  return (Object.keys(by) as SkipReason[]).filter((k) => by[k] > 0).map((k) => `${SKIP_CN[k]} ${by[k]}`);
};
</script>

<template>
  <div class="ncp">
    <p class="ncp-hint">
      核对本章正文里出现的数字能否对上「本章依据」里的数据。只报告不修改 ——
      对不上不等于写错（可能引自别的文献，那就该标出处），但每一个都值得你自己看一眼。
    </p>

    <div class="ncp-actions">
      <button class="ncp-btn" :disabled="running" :data-control="`workflow:verify-numbers-${sectionId}`" @click="run">
        {{ running ? "核验中…" : "核验本章数字" }}
      </button>
      <span v-if="result" class="ncp-sum">
        依据里共 {{ result.basisNumbers }} 个数（来自 {{ result.basisCount }} 项）
        · 命中 <strong :class="{ ok: result.matched }">{{ result.matched }}</strong>
        · 未命中 <strong :class="{ bad: result.unmatched }">{{ result.unmatched }}</strong>
      </span>
    </div>

    <p v-if="error" class="ncp-err">{{ error }}</p>

    <p v-if="result && !result.checks.length" class="ncp-note">
      本章正文里没有可比对的数字（年份、章节号这类不算统计量，已跳过）。
    </p>
    <p v-else-if="result && !result.basisNumbers" class="ncp-note">
      本章还没有依据里的数字 —— 先在上面「本章依据」里勾选数据/分析结果，否则无从比对。
    </p>

    <!-- 未命中: 这是要人看的那一类, 默认展开 -->
    <ul v-if="unmatched().length" class="ncp-list">
      <li v-for="(c, i) in unmatched()" :key="`u${i}`" class="ncp-item bad">
        <span class="ncp-num">{{ c.raw }}</span>
        <span class="ncp-ctx">{{ c.context }}</span>
        <span v-if="c.suggestion" class="ncp-tip">{{ c.suggestion }}</span>
        <span v-else class="ncp-tip faint">依据里找不到相近的数</span>
      </li>
    </ul>

    <template v-if="matched().length">
      <button class="ncp-toggle" :data-control="`workflow:verify-toggle-matched-${sectionId}`" @click="showMatched = !showMatched">
        {{ showMatched ? "收起" : "展开" }}已对上的 {{ matched().length }} 个数
      </button>
      <ul v-if="showMatched" class="ncp-list">
        <li v-for="(c, i) in matched()" :key="`m${i}`" class="ncp-item">
          <span class="ncp-num ok">{{ c.raw }}</span>
          <span class="ncp-ctx">{{ c.context }}</span>
          <span class="ncp-tip faint">{{ c.matchedVia }}</span>
        </li>
      </ul>
    </template>

    <!-- 跳过了什么 —— 不做静默过滤。
         如果这条核验悄悄漏掉正文里一半的数字, 那份"全部对上"的报告就是假的;
         把跳过的东西摆出来, 人才判断得了这次核验的覆盖面到底有多大。 -->
    <template v-if="skippedList().length">
      <button class="ncp-toggle" :data-control="`workflow:verify-toggle-skipped-${sectionId}`" @click="showSkipped = !showSkipped">
        {{ showSkipped ? "收起" : "展开" }}已跳过 {{ skippedList().length }} 个（{{ skippedSummary().join(" · ") }}）
      </button>
      <ul v-if="showSkipped" class="ncp-list">
        <li v-for="(s, i) in skippedList()" :key="`s${i}`" class="ncp-item">
          <span class="ncp-num">{{ s.raw }}</span>
          <span class="ncp-ctx">{{ s.context }}</span>
          <span class="ncp-tip faint">{{ SKIP_CN[s.reason] }} —— 不属于本研究结果，不比对</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.ncp { display: flex; flex-direction: column; gap: 8px; }
.ncp-hint { margin: 0; font-size: var(--wf-f-xs); color: var(--wf-muted); line-height: 1.75; }
.ncp-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ncp-btn {
  cursor: pointer; border-radius: var(--wf-r-sm); padding: 4px 12px; font-size: var(--wf-f-xs);
  border: 1px solid var(--wf-accent); background: var(--wf-accent-soft); color: var(--wf-accent-hi);
}
.ncp-btn:disabled { opacity: 0.5; cursor: default; }
.ncp-sum { font-size: var(--wf-f-xs); color: var(--wf-muted); }
.ncp-sum strong.ok { color: var(--wf-accent-hi); }
.ncp-sum strong.bad { color: var(--wf-warn); }
.ncp-note { margin: 2px 0; font-size: var(--wf-f-xs); color: var(--wf-faint); line-height: 1.7; }
.ncp-err { margin: 2px 0; font-size: var(--wf-f-xs); color: var(--wf-warn); }
.ncp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.ncp-item {
  display: grid; grid-template-columns: auto 1fr; gap: 6px 9px; align-items: baseline;
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-surface-2); padding: 5px 9px;
}
.ncp-item.bad { border-color: var(--wf-warn); }
.ncp-num { font-size: var(--wf-f-sm); color: var(--wf-text); font-variant-numeric: tabular-nums; }
.ncp-num.ok { color: var(--wf-accent-hi); }
.ncp-ctx { font-size: 11px; color: var(--wf-muted); line-height: 1.6; overflow: hidden; text-overflow: ellipsis; }
.ncp-tip { grid-column: 2; font-size: 11px; color: var(--wf-warn); line-height: 1.6; }
.ncp-tip.faint { color: var(--wf-faint); }
.ncp-toggle {
  align-self: flex-start; cursor: pointer; border: 0; background: transparent;
  color: var(--wf-faint); font-size: 11px; padding: 0; text-decoration: underline;
}
.ncp-toggle:hover { color: var(--wf-muted); }
</style>
