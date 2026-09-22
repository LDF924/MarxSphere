<script setup lang="ts">
/**
 * DeepAnalysisPanel —— 深度分析(V425 A2)
 *
 * 由来: 后端有七项"对正文做一次深度分析"的能力, **前端引用数全为 0** ——
 *   它们各自有独立的路由、专属算法与 LLM 提示词, 却一直只有接口没有入口:
 *     /api/quality/format            格式规范适配(四检之外的第五项检查)
 *     /api/theory/premise            理论前提反思(挑出论证里没说出口的预设)
 *     /api/theory/innovation         理论创新点识别
 *     /api/theory/interdisciplinary  跨学科视角拓展
 *     /api/theory/system             理论体系建构(多条命题 → 自洽体系)
 *     /api/theory/bridge             理论与现实联结(理论命题 ↔ 现实案例)
 *     /api/classical/concept-trace   概念溯源(知识库检索 + 语义漂移)
 *
 * 为什么合成一个面板而不是七个卡片: 它们的交互形状**完全一样** ——
 *   "给几个参数 → 等一次 LLM → 看一段结构化结论"。七个各自实现会得到七份重复的表单
 *   与七份各写各的结果渲染, 而真正的差别只在 **参数名** 与 **结果字段**。
 *   所以这里把参数表抽成 CAPS 声明, 表单与结果渲染共用一套。
 *
 * 结果渲染的取舍: **不做字段级定制排版**, 而是把后端返回的每个字段原样铺出来 ——
 *   字符串成段、对象成"键: 值"、数组成条目。理由是不编造也不丢字段:
 *   这些接口的返回形状彼此不同(见各服务注释), 为每个写死一套渲染就等于把后端字段名
 *   在前端再抄一遍, 后端一改字段前端就静默变空(这类"读的字段名和写的不一致"本仓踩过多次)。
 *   原样铺开的代价是排版朴素, 收益是**返回了什么用户就看得见什么**。
 *
 * 概念溯源那条的特殊性: 它依赖**知识库检索**(sourceId), 库空时后端返回
 *   `{stages: [], error: "知识库中未检索到该概念相关文本"}` —— 这时必须把这句话原样显示,
 *   而不是渲染成一个空结果让人以为"分析完了没结论"。
 */
import { ref, computed, watch } from "vue";
import { toast } from "@/shared/ui";
import { q } from "@/shared/api";
import EmptyState from "./EmptyState.vue";

const props = defineProps<{
  /** 正文(取合稿全文; 没合稿时由调用方传章节拼接) */
  text: string;
  /** 研究主题 */
  topic: string;
  /** 核心主张/研究主线(作为 claim 的默认值, 用户可改) */
  claim: string;
  /** 章节标题列表(用作"现实案例/命题"的默认值 —— 比空表单好填得多) */
  sectionTitles: string[];
}>();

type Field = {
  key: string;
  label: string;
  type: "text" | "textarea" | "select" | "list";
  hint?: string;
  options?: string[];
  /** 默认值来源 —— 从项目现状取, 而不是写死一串常量 */
  fill: () => string;
  /**
   * 有意留空: 这一项**没有**可预填的来源(如"文档组名"是用户自己给库里的多版本起的组),
   * 必须手填。标出来是为了让探针能区分"忘了预填"与"按设计要手填" ——
   * 否则它会报一条假失败(实测: collation 就是这么被判红的)。
   */
  emptyByDesign?: boolean;
};
type Cap = {
  id: string;
  label: string;
  desc: string;
  path: string;
  fields: Field[];
  /** 参数值 → 请求体(默认就是同名字段; 需要改名的在这里做) */
  body?: (v: Record<string, string>) => Record<string, unknown>;
  /**
   * 需要用户先挑一份**知识库文档**(argument-tree / argument-structure 要 documentId,
   * intertextual 要 documentIds)。
   *
   * 为什么要这个开关: 这两项的输入不是"当前正文", 而是库里的某篇文章 ——
   *   合稿页手上只有合成稿, 拿不到 documentId。所以面板得自己把文档列出来让用户选,
   *   否则就只能继续"后端有、前端零引用"(它们此前正是这个状态)。
   */
  needsDoc?: boolean;
  /** 需要**多篇**文档(互文对照要 ≥2 篇才成对照, 后端会 400) */
  needsDocs?: boolean;
  /** HTTP 方法 —— argument-tree 是 GET(query 参数), 其余是 POST */
  method?: "GET" | "POST";
};

const CAPS: Cap[] = [
  {
    id: "format", label: "格式规范适配", path: "/quality/format",
    desc: "按目标载体的格式规则检查标题层级、字号、行距、参考文献体例，给出逐项调整说明。",
    fields: [
      { key: "target", label: "目标载体", type: "select", options: ["期刊论文", "学位论文", "党校期刊", "高校学报"], fill: () => "期刊论文" },
    ],
    body: (v) => ({ text: props.text, target: v.target }),
  },
  {
    id: "premise", label: "理论前提反思", path: "/theory/premise",
    desc: "揭示论证中**没有说出口**的理论预设、价值立场与认识论前提，并给出替代视角。",
    fields: [
      { key: "claim", label: "核心主张", type: "text", hint: "要反思的那句判断。默认取研究主线。", fill: () => props.claim },
    ],
    body: (v) => ({ claim: v.claim, text: props.text }),
  },
  {
    id: "innovation", label: "创新点识别", path: "/theory/innovation",
    desc: "扫描正文里的研究空白/争议/延伸信号，归纳可成立的创新点及其学术价值。",
    fields: [],
  },
  {
    id: "interdisciplinary", label: "跨学科视角", path: "/theory/interdisciplinary",
    desc: "引入相邻学科的理论框架，给出应用方式与跨学科适用边界。",
    fields: [
      { key: "discipline", label: "本学科", type: "select", options: ["政治经济学", "经济学", "社会学", "政治学", "法学"], fill: () => "政治经济学" },
    ],
    body: (v) => ({ topic: props.topic, discipline: v.discipline }),
  },
  {
    id: "bridge", label: "理论与现实联结", path: "/theory/bridge",
    desc: "把理论命题落到具体案例上，说明机制并标出理论适用边界。会先按相似度筛出最相关的案例。",
    fields: [
      { key: "theory", label: "理论/框架", type: "text", fill: () => props.claim },
      { key: "realCases", label: "现实案例", type: "textarea", hint: "每行一个案例。默认填入章节标题。", fill: () => props.sectionTitles.join("\n") },
    ],
    body: (v) => ({ theory: v.theory, claim: v.claim, realCases: v.realCases }),
  },
  {
    id: "system", label: "理论体系建构", path: "/theory/system",
    desc: "把多条命题整合成一个自洽体系，检查命题间的张力与术语一致性。至少 2 条命题。",
    fields: [
      { key: "propositions", label: "命题", type: "list", hint: "每行一条，≥2 条。", fill: () => props.sectionTitles.slice(0, 4).join("\n") },
    ],
    body: (v) => ({ propositions: splitLines(v.propositions), topic: props.topic }),
  },
  {
    id: "argstruct", label: "论证结构拆解", path: "/classical/argument-structure", needsDoc: true,
    desc: "拆解指定语料文档的论证结构：核心论点、支撑论据、推理链条。选一篇知识库里的文档。",
    fields: [],
  },
  {
    id: "intertextual", label: "互文对照", path: "/classical/intertextual", needsDocs: true,
    desc: "跨文本对照同一主题的说法（哪些彼此呼应、哪些相左）。**必须选至少 2 篇** —— 一篇没法对照。",
    fields: [
      { key: "topic", label: "对照主题", type: "text", fill: () => props.topic },
    ],
  },
  {
    id: "exegesis", label: "晦涩段阐释", path: "/classical/exegesis",
    desc: "对正文里读不通的段落做逐句阐释（结合知识库检索到的相关文本）。",
    fields: [
      { key: "text", label: "待阐释文本", type: "textarea", hint: "默认取当前正文；可只贴读不通的那一段。", fill: () => props.text.slice(0, 1200) },
    ],
    body: (v) => ({ text: v.text }),
  },
  {
    id: "collation", label: "版本校勘", path: "/classical/collation",
    desc: "按**文档组名**比对同一文本的多个版本，列出异文。需要库里存在分组的多版本（如某书的多个译本）。",
    fields: [
      { key: "documentGroup", label: "文档组名", type: "text", hint: "库里给同一文本的多版本起的组名；库里没有分组时会查不到。", fill: () => "", emptyByDesign: true },
    ],
    body: (v) => ({ documentGroup: v.documentGroup }),
  },
  {
    id: "concept", label: "概念溯源", path: "/classical/concept-trace",
    desc: "从知识库检索该概念的文本片段，按思想史归纳语义演变阶段。**依赖知识库内容**，库空时查不到是正常的。",
    fields: [
      { key: "concept", label: "概念", type: "text", fill: () => props.topic },
    ],
  },
];

const splitLines = (s: string) => String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);

const activeId = ref(CAPS[0].id);
const active = computed(() => CAPS.find((c) => c.id === activeId.value) ?? CAPS[0]);
const values = ref<Record<string, Record<string, string>>>({});
const running = ref(false);
const error = ref("");
/** 当前能力的返回体(未跑过为 null) */
const result = ref<Record<string, unknown> | null>(null);

function valsOf(cap: Cap): Record<string, string> {
  if (!values.value[cap.id]) {
    const v: Record<string, string> = {};
    for (const f of cap.fields) v[f.key] = f.fill();
    values.value = { ...values.value, [cap.id]: v };
  }
  return values.value[cap.id];
}
function switchTo(id: string) {
  activeId.value = id;
  result.value = null;
  error.value = "";
  void valsOf(active.value);
}

/** 缺必填项时按钮禁用 —— 而不是点下去拿一个 400 */
const ready = computed(() => {
  const cap = active.value;
  const v = valsOf(cap);
  // 文档型能力没选文档就是没输入 —— 直接禁用按钮, 而不是打一个必然 400 的请求
  if (cap.needsDoc && !docId.value) return false;
  // 互文对照后端要求 ≥2 篇(实测 1 篇 -> 400 "需要 topic 和至少 2 个 documentIds")
  if (cap.needsDocs && docIds.value.length < 2) return false;
  if (cap.id === "system") return splitLines(v.propositions).length >= 2;
  if (cap.id === "concept") return !!v.concept?.trim();
  if (cap.fields.some((f) => f.key === "claim")) return !!v.claim?.trim();
  return true;
});

// ── 知识库文档(只有 needsDoc 的能力需要) ──
const docs = ref<Array<{ id: string; title: string }>>([]);
const docsLoaded = ref(false);
const docId = ref("");
/** 多篇能力用的选择(互文对照要 ≥2 篇) */
const docIds = ref<string[]>([]);
const toggleDoc = (id: string) => {
  const i = docIds.value.indexOf(id);
  if (i >= 0) docIds.value = docIds.value.filter((x) => x !== id);
  else docIds.value = [...docIds.value, id];
};

/**
 * 懒加载文档列表 —— 只在切到 needsDoc 的能力时才拉。
 * 合稿页平时不需要它, 每次进来都查一遍是白花一次请求。
 * 拉不到(网络/权限)就留空列表, 界面会提示"没有可选文档", 不阻断其它能力。
 */
/**
 * 拉**语料文档**(source_chunks 系), 不是编辑器文档。
 *
 * ⚠ 2026-09-22 修, 踩了两个坑:
 *   ① 我第一版用的是 `editorApi.listDocs()` —— 那是「学术文本工作台」的编辑器文档,
 *      而 argument-structure / argument-tree 读的是 `source_chunks`(知识库入库的语料)。
 *      两份文档集毫无关系, 结果选出来的 id 后端的 getDocChunks 一条都查不到,
 *      返回"未找到该文档的章节内容";
 *   ② 列表要**先有 source 再列它的文档**(/api/sources/:id/documents) —— 语料是按库组织的。
 * 修法: 先取可用数据源, 再取第一个源下的文档。
 */
async function ensureDocs() {
  if (docsLoaded.value) return;
  docsLoaded.value = true;
  try {
    const sr = await q<{ sources?: Array<{ id: string; name?: string }> }>("/research/available-sources");
    const src = sr.sources?.[0];
    if (!src) { docs.value = []; return; }
    const dr = await q<{ documents?: Array<{ id: string; title?: string }> }>(`/sources/${src.id}/documents`);
    docs.value = (dr.documents ?? []).map((d) => ({ id: d.id, title: d.title || "未命名文档" }));
    if (docs.value.length && !docId.value) docId.value = docs.value[0].id;
  } catch { docs.value = []; }
}
watch(() => active.value.needsDoc, (need) => { if (need) void ensureDocs(); }, { immediate: true });

async function run() {
  const cap = active.value;
  if (!ready.value) return;
  running.value = true;
  error.value = "";
  result.value = null;
  try {
    const v = valsOf(cap);
    const base = cap.body ? cap.body(v) : { topic: props.topic, text: props.text, ...v };
    // 文档型能力把选中的文档并进去 —— 后端要 documentId(documentIds 那项用数组包一下)
    const body = cap.needsDoc
      ? { ...base, documentId: docId.value }
      : cap.needsDocs
        ? { ...base, documentIds: docIds.value, perDoc: 3 }
        : base;
    const r = await q<Record<string, unknown>>(cap.path, { method: "POST", body });
    result.value = r ?? {};
    /**
     * 后端**主动报告查不到**时要当作提示而不是成功: 概念溯源在知识库为空时返回
     * `{stages: [], error: "..."}`(HTTP 200)。按成功报会让人以为"分析过了、没结论"。
     */
    const softErr = typeof r?.error === "string" ? r.error : "";
    toast(softErr ? softErr : `${cap.label}完成`, softErr ? "warning" : "success");
  } catch (e) {
    error.value = (e as Error).message || "分析失败";
    toast(`${cap.label}失败: ${error.value}`, "error");
  } finally {
    running.value = false;
  }
}

/**
 * 结果字段渲染: 跳过路由信息与纯技术字段, 其余原样铺开。
 *
 * 显式给出 computed 的泛型 —— 两个 return 分支类型不一致时(空数组的字面量 vs Object.entries
 * 的元组) TS 会推断成联合类型, 模板里 `b.k` / `b.v` 就取不到。
 */
const SKIP = new Set(["topic", "discipline", "target", "concept", "claim", "theory", "rules"]);
const blocks = computed<Array<{ k: string; v: unknown }>>(() => {
  const r = result.value;
  if (!r) return [];
  return Object.entries(r)
    .filter(([k, v]) => !SKIP.has(k) && v !== null && v !== undefined && !(Array.isArray(v) && !v.length) && v !== "" && v !== false)
    .map(([k, v]) => ({ k, v }));
});

/** 把一个任意值摊成可读行 —— 数组逐条, 对象按"值"展开, 标量直接转文本 */
function lines(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (typeof v === "string") return [v];
  if (typeof v === "number" || typeof v === "boolean") return [String(v)];
  if (Array.isArray(v)) return v.flatMap(lines);
  const o = v as Record<string, unknown>;
  const vals = Object.values(o).map((x) => (typeof x === "string" || typeof x === "number" ? String(x) : "")).filter(Boolean);
  return vals.length ? [vals.join(" · ")] : [];
}
/** 对象的原始键值对(结果里的对象条目要保留键名才看得出"哪一项是什么") */
function pairs(v: unknown): Array<[string, string]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => typeof x === "string" || typeof x === "number")
    .map(([k, x]) => [k, String(x)]);
}
function isObjList(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null && !Array.isArray(v[0]);
}
</script>

<template>
  <section class="da-card" data-control="workflow:deep-analysis">
    <header class="da-head">
      <div>
        <h3 class="da-title">深度分析</h3>
        <p class="da-sub">七项针对**成稿**的分析能力。每项独立跑、独立出结论，跑完不自动改动正文。</p>
      </div>
    </header>

    <!-- 能力选择: 一行 chip。选中的那个在下面展开它的参数表 -->
    <div class="da-chips">
      <button
        v-for="c in CAPS" :key="c.id"
        class="da-chip" :class="{ on: activeId === c.id }"
        :data-control="`workflow:deep-${c.id}`"
        @click="switchTo(c.id)"
      >{{ c.label }}</button>
    </div>

    <div class="da-body">
      <div class="da-params">
        <p class="da-desc">{{ active.desc }}</p>

        <!-- 文档型能力: 先选一篇知识库文档(它的输入不是当前正文, 是库里的文章) -->
        <div v-if="active.needsDoc" class="da-field">
          <label class="da-label">知识库文档</label>
          <select v-if="docs.length" v-model="docId" class="da-input" data-control="workflow:deep-doc">
            <option v-for="d in docs" :key="d.id" :value="d.id">{{ d.title }}</option>
          </select>
          <p v-else class="da-hint">
            没有可选文档 —— 这一项读的是**知识库入库的语料**（不是编辑器里的稿件），
            请先在「知识库 / 文献处理」里导入并处理文档。
          </p>
        </div>

        <!-- 多篇: 勾选(互文对照要至少 2 篇) -->
        <div v-if="active.needsDocs" class="da-field">
          <label class="da-label">对照文档（已选 {{ docIds.length }} 篇）</label>
          <div v-if="docs.length" class="da-doclist">
            <label v-for="d in docs" :key="d.id" class="da-docitem" :class="{ on: docIds.includes(d.id) }">
              <input type="checkbox" :checked="docIds.includes(d.id)" @change="toggleDoc(d.id)" />
              <span>{{ d.title }}</span>
            </label>
          </div>
          <p v-else class="da-hint">没有可选文档 —— 请先在「知识库 / 文献处理」里导入并处理文档。</p>
        </div>
        <div v-for="f in active.fields" :key="f.key" class="da-field">
          <label class="da-label">{{ f.label }}</label>
          <select v-if="f.type === 'select'" v-model="valsOf(active)[f.key]" class="da-input">
            <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
          </select>
          <input v-else-if="f.type === 'text'" v-model="valsOf(active)[f.key]" class="da-input" />
          <textarea v-else v-model="valsOf(active)[f.key]" class="da-input da-area" :rows="f.type === 'list' ? 5 : 4"></textarea>
          <span v-if="f.hint" class="da-hint">{{ f.hint }}</span>
        </div>
        <p v-if="active.fields.length === 0" class="da-hint">这一项不需要参数，直接对当前正文分析。</p>
        <div class="da-run-row">
          <button
            class="da-run" :disabled="running || !ready"
            data-control="workflow:deep-run"
            @click="run"
          >{{ running ? "分析中…（这类分析要跑一次完整 LLM，通常 20 秒到 1 分钟）" : "开始分析" }}</button>
          <span v-if="!props.text" class="da-hint">当前没有正文可分析，请先完成合稿或在创作台生成章节。</span>
        </div>
        <p v-if="error" class="da-err">{{ error }}</p>
      </div>

      <div class="da-result">
        <template v-if="result">
          <!-- 后端主动说"查不到"时原样显示 —— 这不是失败, 但也不是"分析完了没结论" -->
          <p v-if="typeof result.error === 'string'" class="da-soft">{{ result.error }}</p>
          <div v-for="b in blocks" :key="b.k" class="da-block">
            <h4 class="da-block-title">{{ b.k }}</h4>
            <!-- 对象数组: 每条一张小卡, 保留键名 -->
            <ul v-if="isObjList(b.v)" class="da-items">
              <li v-for="(it, i) in (b.v as Array<Record<string, unknown>>)" :key="i" class="da-item">
                <span v-for="([k, val]) in pairs(it)" :key="k" class="da-kv">
                  <em>{{ k }}</em>{{ val }}
                </span>
                <span v-if="!pairs(it).length" class="da-kv">{{ lines(it).join(" ") }}</span>
              </li>
            </ul>
            <ul v-else-if="Array.isArray(b.v)" class="da-bullets">
              <li v-for="(l, i) in lines(b.v)" :key="i">{{ l }}</li>
            </ul>
            <p v-else-if="typeof b.v === 'object'" class="da-text">
              <span v-for="([k, val]) in pairs(b.v)" :key="k" class="da-kv"><em>{{ k }}</em>{{ val }}</span>
            </p>
            <p v-else class="da-text">{{ lines(b.v).join(" ") }}</p>
          </div>
          <p v-if="!blocks.length" class="da-hint">后端返回了空结果 —— 没有可展示的字段。</p>
        </template>
        <EmptyState
          v-else
          size="md"
          icon="◎"
          title="还没跑过分析"
          hint="左侧选一项能力、确认参数后开始。结果会显示在这里，不会自动改正文 —— 要不要采纳由你决定。"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.da-card {
  margin-top: 24px; padding: 20px 22px 22px;
  background: var(--wf-surface); border: 1px solid var(--wf-line); border-radius: var(--wf-r);
}
.da-head { margin-bottom: 14px; }
.da-title { margin: 0; font-size: var(--wf-f-lg); color: var(--wf-text); }
.da-sub { margin: 5px 0 0; font-size: var(--wf-f-sm); color: var(--wf-muted); max-width: 76ch; line-height: 1.6; }
.da-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.da-chip {
  padding: 6px 13px; border: 1px solid var(--wf-line); border-radius: var(--wf-r-pill);
  background: var(--wf-raised); color: var(--wf-text-2); font-size: var(--wf-f-sm); cursor: pointer;
  transition: border-color .15s, color .15s, background .15s;
}
.da-chip:hover { border-color: var(--wf-line-strong); color: var(--wf-text); }
.da-chip.on { border-color: var(--wf-accent); color: var(--wf-text); background: var(--wf-accent-soft); font-weight: 600; }
/* 两栏: 左参数(固定宽, 表单不需要宽) / 右结果(结论要读, 给足宽) */
.da-body { display: grid; grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); gap: 22px; align-items: start; }
.da-desc { margin: 0 0 12px; font-size: var(--wf-f-sm); color: var(--wf-text-2); line-height: 1.7; }
.da-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 11px; }
.da-label { font-size: var(--wf-f-sm); font-weight: 600; color: var(--wf-text-2); }
.da-input {
  width: 100%; box-sizing: border-box; padding: 7px 11px;
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-raised); color: var(--wf-text); font-size: var(--wf-f-sm); font-family: inherit;
}
.da-area { resize: vertical; line-height: 1.6; }
.da-hint { font-size: var(--wf-f-sm); color: var(--wf-faint); line-height: 1.6; }
.da-doclist { max-height: 190px; overflow-y: auto; border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm); background: var(--wf-raised); }
.da-docitem { display: flex; align-items: center; gap: 7px; padding: 5px 9px; font-size: var(--wf-f-sm); color: var(--wf-text-2); cursor: pointer; }
.da-docitem:hover { background: var(--wf-surface); }
.da-docitem.on { color: var(--wf-text); background: var(--wf-accent-soft); }
.da-run-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
.da-run {
  padding: 8px 18px; border: 1px solid var(--wf-accent); border-radius: var(--wf-r-sm);
  background: var(--wf-accent-soft); color: var(--wf-text); font-size: var(--wf-f-sm); font-weight: 600; cursor: pointer;
}
.da-run:disabled { opacity: .5; cursor: not-allowed; }
.da-err { margin: 10px 0 0; font-size: var(--wf-f-sm); color: #E1756B; }
.da-soft { margin: 0 0 12px; padding: 9px 12px; border-radius: var(--wf-r-sm);
  background: var(--wf-raised); border: 1px solid var(--wf-line-strong); color: var(--wf-text-2); font-size: var(--wf-f-sm); line-height: 1.7; }
.da-result { min-height: 180px; }
.da-block { margin-bottom: 16px; }
.da-block-title {
  margin: 0 0 7px; font-size: var(--wf-f-sm); font-weight: 600; color: var(--wf-muted);
  font-family: ui-monospace, monospace; letter-spacing: .02em;
}
.da-items { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 7px; }
.da-item {
  display: flex; flex-direction: column; gap: 3px;
  padding: 9px 12px; border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-raised); font-size: var(--wf-f-sm); color: var(--wf-text-2); line-height: 1.7;
}
.da-bullets { margin: 0; padding-left: 18px; font-size: var(--wf-f-sm); color: var(--wf-text-2); line-height: 1.8; }
.da-text { margin: 0; font-size: var(--wf-f-sm); color: var(--wf-text-2); line-height: 1.8; }
/* 键名压暗、值正常: 结果里同一层级字段名重复出现, 压暗后正文才读得下去 */
.da-kv { display: block; }
.da-kv em { font-style: normal; color: var(--wf-faint); margin-right: 6px; }
/**
 * 窄了就纵向堆叠 —— 用**容器查询**而不是视口媒体查询。
 *
 * ⚠ 2026-09-22 修(实测踩到): 原来写的是 `@media (max-width: 1080px)`, 判的是**视口宽**,
 *   可这个面板实际受限于**它所在那一列的宽度**。合稿页是两栏, 左栏在 1280 视口下只有 509px ——
 *   断点根本不触发, 于是结果栏被挤成 **141px**(实测 grid-template-columns: "300px 140.969px"),
 *   结论文本已经完全没法读; 1600 视口下反而是正常的 304px。
 *   **视口宽不等于容器宽**, 这类"断点永远不在需要时触发"的错很容易整片漏过去。
 *   容器查询直接按"我拿到多宽"决定, 与父级怎么排无关。
 */
.da-card { container-type: inline-size; }
@container (max-width: 620px) {
  .da-body { grid-template-columns: minmax(0, 1fr); gap: 16px; }
}
</style>
