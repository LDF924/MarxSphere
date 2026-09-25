<script setup lang="ts">
/**
 * ResearchDesignPanel —— 研究设计(方法选型 / 因果识别 / 数据来源 / 伦理)
 *
 * 由来(2026-09-24): 真实流程的"框架设计"不只是章节结构 —— 还要定**怎么做**。
 *   写作舱此前只有三张方法单选卡(定性/定量/混合), 选完就没了。
 *
 * 四项的分工:
 *   ① 研究方法 —— 真源是后端 `GET /api/empirical/methods`(19 法, 分基础/因果识别/机制分析/
 *      分类模型/面板数据/匹配/证据综合), 按**研究类型**推荐其中一组。
 *      ⚠ 这是"推荐 + 自选", 不是"自动定": 方法选错整篇都白做, 这个决定必须是用户做的。
 *   ② 因果识别 —— 想声称因果就得有识别策略。把因果设计的七种家底摆出来,
 *      让用户**明确选一个或明确选"不做因果推断"** —— 后者是合法答案, 而含糊才是问题。
 *   ③ 数据来源 —— 三四项按研究类型给常见来源。**纯文本常量, 不冒充后端能力**;
 *      这张表的作用是提醒"该收集什么", 真去拿数据在「数据收集」那一步。
 *   ④ 研究伦理 —— 五个硬约束按数据类型出现, 不出现的就不显示(定性研究没有"脱敏"那一条)。
 *      这一项**没有任何后端支撑**, 是领域常识的清单; 放这里的理由是它必须在设计阶段被看到,
 *      而不是等审稿人问"你的伦理审查呢"。
 *
 * ⚠ 2026-09-25 修一处**很典型的"界面像做完了、其实是死路"**:
 *   本面板此前 `defineEmits` 数量为 0、不写库、生成时也读不到 —— 用户认真选完方法/识别策略/
 *   数据来源/伦理, 对正文**零影响**。选"双重差分"和选"不做因果推断"生成的稿子一模一样。
 *   现在: ① 选项落 `research_nodes.design` 节点(与 sections/analysis 同一套节点机制);
 *         ② 组装成设计约束块, 由 research-exec-engine 注入章节生成。
 *   为什么落节点而不是加进 workbench 快照: 快照是"工作台整包状态", 而设计是**项目级产物**,
 *   与 sections 同级 —— 放节点才能被版本历史/回滚/整包导出一并覆盖。
 */
import { computed, onMounted, ref, watch } from "vue";
import { q } from "@/shared/api";
import { getNode, putNode } from "@/shared/tasks";

const props = defineProps<{
  /** 研究类型: qualitative / quantitative / mixed(来自选题界定页选的) */
  researchMethod: string;
  /** 当前项目 id —— 没有它就不落库(面板在未建项目时也能看, 只是不存) */
  projectId?: string;
}>();

/** 保存状态: 界面必须说得出"存了没有"。静默保存是"选项刷新即丢"那类问题的温床。 */
const saveState = ref<"idle" | "saving" | "saved" | "error">("idle");
const saveError = ref("");

interface MethodRow { id: string; label: string; desc: string; category: string }
const methods = ref<MethodRow[]>([]);
const methodsNote = ref("");
const pickedMethod = ref("");

/** 研究类型 → 推荐的方法 id。定性研究推荐描述统计与元分析(证据综合),
 *  不是因为它们"定性", 而是因为定性研究里能用的量化工具就这些 —— 硬推回归是误导 */
const RECOMMEND: Record<string, string[]> = {
  quantitative: ["descriptive", "ols", "did", "panel_fe", "iv", "rdd", "psm", "logit", "ologit"],
  qualitative: ["descriptive", "meta_analysis"],
  mixed: ["descriptive", "crosstab", "ols", "logit", "mediation", "meta_analysis"],
};
const recommended = computed(() => {
  const key = String(props.researchMethod ?? "").trim();
  const ids = RECOMMEND[key] ?? RECOMMEND.quantitative;
  return methods.value.filter((m) => ids.includes(m.id));
});
const others = computed(() => {
  const ids = new Set(recommended.value.map((m) => m.id));
  return methods.value.filter((m) => !ids.has(m.id));
});

onMounted(async () => {
  try {
    const r = await q<{ methods?: MethodRow[] }>("/empirical/methods");
    methods.value = Array.isArray(r.methods) ? r.methods : [];
    if (!methods.value.length) methodsNote.value = "方法目录暂时读不到（后端降级）——可以直接按经验填下面的识别策略。";
  } catch {
    methodsNote.value = "方法目录读取失败 ——可以直接按经验填下面的识别策略。";
  }
});

/** ② 因果识别策略 —— 七种家底 + "不做因果推断"这个合法答案 */
const IDENTIFY = [
  { id: "did", label: "双重差分 (DiD)", when: "有政策冲击，且有处理组/对照组与前后两期数据" },
  { id: "event_study", label: "事件研究", when: "关心政策前后的动态效应、要检验平行趋势" },
  { id: "iv", label: "工具变量 (2SLS)", when: "存在内生性，且能找到相关且外生的工具" },
  { id: "rdd", label: "断点回归 (RDD)", when: "处理分配由一个连续变量在阈值处决定" },
  { id: "psm", label: "倾向得分匹配", when: "可观测变量足够，想让处理组与对照组可比" },
  { id: "scm", label: "合成控制", when: "只有一个（或少数）处理单位，用多个控制单位合成反事实" },
  { id: "none", label: "不做因果推断，只做相关/描述", when: "数据不支持识别，或研究问题本就是描述性/解释性" },
];
const pickedIdentify = ref("");

/** ③ 数据来源 —— 按研究类型提醒"该收集什么" */
const DATA_SOURCES: Record<string, Array<{ label: string; hint: string }>> = {
  qualitative: [
    { label: "深度访谈", hint: "半结构化提纲 + 逐字稿；注意饱和点" },
    { label: "参与式观察", hint: "田野笔记；区分观察记录与推断" },
    { label: "文本/档案", hint: "政策文件、报刊、档案；注意版本与出处" },
    { label: "案例资料", hint: "典型案例的公开材料 + 访谈互证" },
  ],
  quantitative: [
    { label: "问卷调查", hint: "抽样框、样本量估算、量表信效度" },
    { label: "公开数据库", hint: "统计年鉴 / CFPS / CGSS / CHARLS 等" },
    { label: "行政数据", hint: "需说明获取渠道与口径" },
    { label: "实验数据", hint: "需说明随机化与平衡性检验" },
  ],
  mixed: [
    { label: "问卷调查（定量部分）", hint: "抽样与量表" },
    { label: "深度访谈（定性部分）", hint: "用于解释定量发现" },
    { label: "公开数据库", hint: "补充宏观背景" },
    { label: "案例资料", hint: "机制说明" },
  ],
};
const dataSources = computed(() => DATA_SOURCES[String(props.researchMethod ?? "").trim()] ?? DATA_SOURCES.quantitative);
const pickedData = ref<string[]>([]);
function toggleData(label: string) {
  pickedData.value = pickedData.value.includes(label)
    ? pickedData.value.filter((x) => x !== label)
    : [...pickedData.value, label];
}

/** ④ 研究伦理 —— 只在相关时出现 */
const ETHICS = computed(() => {
  const rows: Array<{ key: string; text: string }> = [];
  const qualitative = props.researchMethod === "qualitative" || props.researchMethod === "mixed";
  const quantitative = props.researchMethod === "quantitative" || props.researchMethod === "mixed";
  rows.push({ key: "consent", text: "知情同意：受访者/被试需被告知研究目的、用途与可随时退出，并留存同意记录" });
  if (qualitative) {
    rows.push({ key: "anon", text: "匿名化：访谈对象姓名、单位、地点在做逐字稿时即替换为代号，原始录音与化名对照表分开存放" });
    rows.push({ key: "quote", text: "引语使用：正文引用受访者原话需回访确认，不得改写后仍标注为直接引语" });
  }
  if (quantitative) {
    rows.push({ key: "privacy", text: "个人信息：可识别到个人的字段（身份证号、精确住址、电话）在分析前删除或做泛化处理" });
    rows.push({ key: "data", text: "数据留存：原始数据按期刊/机构要求留存备查，对外公开版须先脱敏" });
  }
  return rows;
});

const pickedEthics = ref<string[]>([]);
function toggleEthics(key: string) {
  pickedEthics.value = pickedEthics.value.includes(key)
    ? pickedEthics.value.filter((x) => x !== key)
    : [...pickedEthics.value, key];
}

// ═══════════════════════════════════════════════════════════════════
// 落库 + 回读(design 节点)
//
// 每次改动 600ms 防抖保存 —— 这是勾选式界面, 用户会连点好几下,
// 每点一次一个 PUT 既浪费又会让"保存中/已保存"的提示来回跳。
// ═══════════════════════════════════════════════════════════════════
const DESIGN_FIELDS = [
  { key: "methodId", label: "研究方法" },
  { key: "identifyId", label: "因果识别" },
  { key: "dataSources", label: "数据来源" },
  { key: "ethics", label: "研究伦理" },
] as const;

function payload() {
  return {
    version: 1,
    methodId: pickedMethod.value,
    identifyId: pickedIdentify.value,
    dataSources: [...pickedData.value],
    ethics: [...pickedEthics.value],
    updatedAt: new Date().toISOString(),
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** 回读期间要抑制保存 —— 否则"读出来的值"会立刻被当成"用户改的值"写回去(无谓写 + 竞态) */
let hydrating = false;

function scheduleSave() {
  if (hydrating || !props.projectId) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveState.value = "saving";
  saveTimer = setTimeout(() => { void saveNow(); }, 600);
}

async function saveNow() {
  if (!props.projectId) return;
  try {
    await putNode(props.projectId, "design", payload());
    saveState.value = "saved";
    saveError.value = "";
  } catch (e) {
    saveState.value = "error";
    saveError.value = String((e as Error).message ?? e).slice(0, 120);
  }
}

watch([pickedMethod, pickedIdentify, pickedData, pickedEthics], scheduleSave, { deep: true });

onMounted(async () => {
  if (props.projectId) {
    try {
      const node = await getNode(props.projectId, "design");
      if (node && (node.methodId || node.identifyId)) {
        hydrating = true;
        if (typeof node.methodId === "string") pickedMethod.value = node.methodId;
        if (typeof node.identifyId === "string") pickedIdentify.value = node.identifyId;
        if (Array.isArray(node.dataSources)) pickedData.value = node.dataSources.map(String);
        if (Array.isArray(node.ethics)) pickedEthics.value = node.ethics.map(String);
        await Promise.resolve();
        hydrating = false;
        saveState.value = "saved";
      }
    } catch { /* 无节点容忍: 新项目本来就没有 */ }
  }
});

// ── 导出成一段可粘贴的设计说明 ──
const summary = computed(() => {
  const m = methods.value.find((x) => x.id === pickedMethod.value);
  const id = IDENTIFY.find((x) => x.id === pickedIdentify.value);
  const lines: string[] = [];
  if (m) lines.push(`研究方法：${m.label}（${m.desc}）`);
  if (id) lines.push(`因果识别：${id.label}${id.id === "none" ? "" : ` —— ${id.when}`}`);
  if (pickedData.value.length) lines.push(`数据来源：${pickedData.value.join("、")}`);
  if (ETHICS.value.length && pickedEthics.value.length === ETHICS.value.length) lines.push("伦理：已覆盖知情同意、匿名化与数据留存要求");
  return lines;
});
</script>

<template>
  <div class="rdp">
    <!-- ① 研究方法 -->
    <section class="rdp-sec">
      <h4 class="rdp-h"><span class="rdp-n">1</span>研究方法</h4>
      <p v-if="methodsNote" class="rdp-note">{{ methodsNote }}</p>
      <template v-else>
        <p class="rdp-note">
          按当前研究类型（<strong>{{ props.researchMethod || "未指定，按定量" }}</strong>）推荐这些，也可以选其它。
        </p>
        <div class="rdp-chips">
          <button
            v-for="m in recommended" :key="m.id"
            class="rdp-chip" :class="{ on: pickedMethod === m.id }"
            :title="m.desc" :data-control="`workflow:rd-method-${m.id}`"
            @click="pickedMethod = pickedMethod === m.id ? '' : m.id"
          >{{ m.label }}</button>
        </div>
        <details class="rdp-more">
          <summary>全部方法（{{ methods.length }}）</summary>
          <div class="rdp-chips">
            <button
              v-for="m in others" :key="m.id"
              class="rdp-chip" :class="{ on: pickedMethod === m.id }"
              :title="m.desc" :data-control="`workflow:rd-method-other-${m.id}`"
              @click="pickedMethod = pickedMethod === m.id ? '' : m.id"
            >{{ m.label }}</button>
          </div>
        </details>
        <p v-if="pickedMethod" class="rdp-picked">
          选定：<strong>{{ methods.find((m) => m.id === pickedMethod)?.label }}</strong>
          — {{ methods.find((m) => m.id === pickedMethod)?.desc }}
        </p>
      </template>
    </section>

    <!-- ② 因果识别 -->
    <section class="rdp-sec">
      <h4 class="rdp-h"><span class="rdp-n">2</span>因果识别策略</h4>
      <p class="rdp-note">
        要声称"因果"就得说清凭什么。选"不做因果推断"也是完全正当的答案 —— 含糊才是问题。
      </p>
      <ul class="rdp-ident">
        <li v-for="s in IDENTIFY" :key="s.id">
          <button
            class="rdp-irow" :class="{ on: pickedIdentify === s.id }"
            :data-control="`workflow:rd-identify-${s.id}`"
            @click="pickedIdentify = pickedIdentify === s.id ? '' : s.id"
          >
            <span class="rdp-iname">{{ s.label }}</span>
            <span class="rdp-iwhen">{{ s.when }}</span>
          </button>
        </li>
      </ul>
    </section>

    <!-- ③ 数据来源 -->
    <section class="rdp-sec">
      <h4 class="rdp-h"><span class="rdp-n">3</span>数据来源</h4>
      <p class="rdp-note">设计阶段先定"要收什么"，真去收集在「数据收集」那一步。</p>
      <div class="rdp-chips">
        <button
          v-for="d in dataSources" :key="d.label"
          class="rdp-chip" :class="{ on: pickedData.includes(d.label) }"
          :title="d.hint" :data-control="`workflow:rd-data-${d.label}`"
          @click="toggleData(d.label)"
        >{{ d.label }}</button>
      </div>
    </section>

    <!-- ④ 研究伦理 -->
    <section class="rdp-sec">
      <h4 class="rdp-h"><span class="rdp-n">4</span>研究伦理</h4>
      <ul class="rdp-ethics">
        <li v-for="e in ETHICS" :key="e.key">
          <label class="rdp-erow">
            <input
              type="checkbox" :checked="pickedEthics.includes(e.key)"
              :data-control="`workflow:rd-ethics-${e.key}`"
              @change="toggleEthics(e.key)"
            />
            <span>{{ e.text }}</span>
          </label>
        </li>
      </ul>
      <p class="rdp-warn">
        这一项没有后端支撑，是领域清单 —— 勾选只表示"设计时已考虑到"，不构成伦理审查。
      </p>
    </section>

    <div v-if="summary.length" class="rdp-sum">
      <strong>设计摘要</strong>
      <ul><li v-for="(s, i) in summary" :key="i">{{ s }}</li></ul>
      <p class="rdp-save" :class="saveState">
        <template v-if="!props.projectId">未选择项目 —— 这些选择不会被保存</template>
        <template v-else-if="saveState === 'saving'">保存中…</template>
        <template v-else-if="saveState === 'saved'">已保存，生成正文时会作为约束注入</template>
        <template v-else-if="saveState === 'error'">保存失败：{{ saveError }}</template>
        <template v-else>改动会自动保存，生成正文时会作为约束注入</template>
      </p>
    </div>
  </div>
</template>

<style scoped>
.rdp { display: flex; flex-direction: column; gap: var(--wf-s3); }
.rdp-sec { border-top: 1px solid var(--wf-line-soft); padding-top: var(--wf-s3); }
.rdp-sec:first-child { border-top: 0; padding-top: 0; }
.rdp-h { display: flex; align-items: center; gap: var(--wf-s2); margin: 0 0 6px; font-size: var(--wf-f-md); color: var(--wf-text); }
.rdp-n { display: grid; place-items: center; width: 18px; height: 18px; flex-shrink: 0;
  border-radius: 50%; background: var(--wf-accent-soft); color: var(--wf-accent-hi); font-size: 10px; }
.rdp-note { margin: 0 0 8px; font-size: var(--wf-f-xs); color: var(--wf-muted); line-height: 1.7; }
.rdp-note strong { color: var(--wf-text-2); }
.rdp-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.rdp-chip {
  cursor: pointer; border-radius: var(--wf-r-pill); padding: 3px 11px; font-size: var(--wf-f-xs);
  border: 1px solid var(--wf-line-strong); background: transparent; color: var(--wf-muted);
  transition: all var(--wf-dur-fast) var(--wf-ease);
}
.rdp-chip.on { border-color: var(--wf-accent); color: var(--wf-accent-hi); background: var(--wf-accent-soft); }
.rdp-more { margin-top: 8px; }
.rdp-more > summary { cursor: pointer; font-size: var(--wf-f-xs); color: var(--wf-faint); margin-bottom: 6px; }
.rdp-picked { margin: 8px 0 0; font-size: var(--wf-f-xs); color: var(--wf-text-2); line-height: 1.6; }
.rdp-ident { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.rdp-irow {
  display: flex; align-items: baseline; gap: var(--wf-s2); width: 100%; text-align: left;
  cursor: pointer; border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-surface-2); padding: 6px 10px;
}
.rdp-irow:hover { background: var(--wf-raised); }
.rdp-irow.on { border-color: var(--wf-accent); background: var(--wf-accent-soft); }
.rdp-iname { flex-shrink: 0; font-size: var(--wf-f-sm); color: var(--wf-text); }
.rdp-iwhen { font-size: var(--wf-f-xs); color: var(--wf-muted); line-height: 1.6; }
.rdp-ethics { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.rdp-erow { display: flex; align-items: flex-start; gap: 7px; font-size: var(--wf-f-xs); color: var(--wf-muted); line-height: 1.7; cursor: pointer; }
.rdp-erow input { margin-top: 3px; flex-shrink: 0; }
.rdp-warn { margin: 8px 0 0; font-size: var(--wf-f-xs); color: var(--wf-warn); line-height: 1.6; }
.rdp-sum {
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-surface-2); padding: 8px 12px;
}
.rdp-sum strong { font-size: var(--wf-f-sm); color: var(--wf-text); }
.rdp-sum ul { list-style: none; margin: 5px 0 0; padding: 0; }
.rdp-sum li { font-size: var(--wf-f-xs); color: var(--wf-text-2); line-height: 1.7; }
.rdp-save { margin: 7px 0 0; font-size: var(--wf-f-xs); color: var(--wf-faint); line-height: 1.6; }
.rdp-save.saved { color: var(--wf-ok, var(--wf-accent-hi)); }
.rdp-save.error { color: var(--wf-warn); }
</style>
