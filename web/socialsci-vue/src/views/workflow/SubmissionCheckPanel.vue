<script setup lang="ts">
/**
 * SubmissionCheckPanel —— 投稿前检查(统稿定稿的最后一道闸)
 *
 * 由来(2026-09-24): 真实的科研流程到这一步要做三件事 —— 选刊、按目标期刊的体例改格式、
 *   查重。写作舱此前**一件都不做**, 到"导出"就断了。
 *
 * 三项各自的真源(都是后端已有、写作舱零引用的):
 *   ① 选刊      `GET  /api/cjournal/journals` —— 80 本马理论期刊(级别/主办/主题标签)。
 *               外壳的「政经C刊科研」在用, 写作舱没接。这里按标题/主题标签匹配排序,
 *               不是简单罗列 —— 用户要的是"我这篇往哪投", 不是一份通讯录。
 *   ② 格式规范  `POST /api/quality/format` —— 按目标刊物类型给格式适配建议。
 *   ③ 查重      `POST /api/quality/plagiarism` —— N-gram 重合度。
 *               ⚠ 它需要一份**比对源文本**(后端没有语料库, 是 text-vs-text)。
 *               所以这里必须让用户明确选一篇比对文献; 不给源文本就点"查重"是耍流氓 ——
 *               那会算出一堆没意义的重合率。没选之前按钮是禁用的, 并说明为什么。
 *
 * 这一版**不**做「格式化 Word 导出」: `POST /api/format-eval/format` 收的是 docx 字节,
 *   而写作舱手上是 markdown。转 docx 要先走 paper-outline 导出, 那是另一条链路,
 *   硬接会得到一个"点了没反应"的按钮。宁可少一项, 不做假的。
 */
import { computed, onMounted, ref } from "vue";
import { toast } from "@/shared/ui";
import { q } from "@/shared/api";

const props = defineProps<{
  /** 要检查的正文(统稿页传合稿全文) */
  text: string;
  /** 研究主题 */
  topic: string;
  /** 比对源文本的候选 —— 库里的文献素材正文 */
  sources: Array<{ id: string; title: string; text: string }>;
}>();

// ── ① 选刊 ──
interface Journal { id: string; name: string; level: string; org?: string; topicTags?: string[]; style?: string }
const journals = ref<Journal[]>([]);
const journalsNote = ref("");
const picked = ref<Journal | null>(null);
const levelFilter = ref("全部");

const LEVELS = ["全部", "南核", "北核", "C扩"];

/** 按"与本文的匹配度"排 —— 命中研究主题词/标题词的排前面 */
const ranked = computed(() => {
  const list = journals.value.filter((j) => levelFilter.value === "全部" || j.level === levelFilter.value);
  const hay = `${props.topic}`.toLowerCase();
  // 用标题里出现过的 2 字以上的词做粗匹配。中文不分词, 这里退一步按**整词包含**判,
  // 命中不了就保持原序 —— 编一个像模像样的"匹配度百分比"比不排序更糟。
  const scoreOf = (j: Journal) => {
    const tags = j.topicTags ?? [];
    let s = 0;
    for (const t of tags) if (t && hay.includes(String(t).toLowerCase())) s += 2;
    if (j.style && hay.includes(String(j.style).toLowerCase())) s += 1;
    if (j.name && hay.includes(String(j.name).toLowerCase())) s += 1;
    return s;
  };
  return [...list].sort((a, b) => scoreOf(b) - scoreOf(a));
});

onMounted(async () => {
  try {
    const r = await q<{ journals?: Journal[]; total?: number }>("/cjournal/journals");
    journals.value = Array.isArray(r.journals) ? r.journals : [];
    if (!journals.value.length) journalsNote.value = "期刊库暂时读不到（后端降级）——选刊这一步先跳过，其余检查照常。";
  } catch {
    journalsNote.value = "期刊库读取失败 ——选刊这一步先跳过，其余检查照常。";
  }
});

// ── ② 格式规范 ──
/** 后端的四档目标体例(paper-quality-service 的 FORMAT_RULES) —— 选项就是它认得的那四个, 不多编 */
const FORMAT_TARGETS = ["期刊论文", "学位论文", "党校期刊", "高校学报"];
const fmtTarget = ref(FORMAT_TARGETS[0]);
const fmtRunning = ref(false);
const fmtResult = ref<Record<string, unknown> | null>(null);

async function runFormat() {
  const body = props.text.trim();
  if (body.length < 50) { toast("正文太短，还谈不上格式检查", "warning"); return; }
  fmtRunning.value = true;
  fmtResult.value = null;
  try {
    const r = await q<Record<string, unknown>>("/quality/format", {
      method: "POST",
      body: { text: body, target: fmtTarget.value },
    });
    fmtResult.value = r;
    toast("格式检查完成", "success");
  } catch (e) {
    toast(`格式检查失败：${(e as Error).message}`, "error");
  } finally {
    fmtRunning.value = false;
  }
}

// ── ③ 查重 ──
/**
 * 两条查重, 面向两个不同的问题 —— 都给, 由用户选用哪条:
 *
 *   · **库查重**(主): 拿平台文献库(500+ 篇, 全有正文)当比对库, 一条不需要用户准备任何东西。
 *     确定性 6-gram + 最长连续命中, **不调 LLM**, 秒级。写论文时最该问的是
 *     "我有没有抄到我读过的这些", 那正是这个库。
 *   · **逐篇比对**(辅): 原来的 text-vs-text, 需要用户挑一篇文献。
 *     它带 LLM, 能看出"改写过的不当引用"这类字面查不出来的问题 —— 库查重查不到那些。
 *
 * 之前这里只有后者, 于是界面上必须写"平台没有全网语料库" ——那句话**不准确**:
 *   平台没有的是全网语料, 但它有一个真语料(文献库), 而那条路当时没接。
 */
const corpusRunning = ref(false);
const corpusResult = ref<CorpusResult | null>(null);

interface CorpusMatch { id: string; title: string; overlapRatio: number; matchedGrams: number; longestRun: number; sample: string }
interface CorpusResult { ok: boolean; error?: string; corpusSize: number; queryLength: number; matches: CorpusMatch[]; verdict: string }

async function runCorpusCheck() {
  const body = props.text.trim();
  if (body.length < 50) { toast("正文太短，还谈不上查重", "warning"); return; }
  corpusRunning.value = true;
  corpusResult.value = null;
  try {
    const r = await q<CorpusResult>("/quality/plagiarism-corpus", { method: "POST", body: { text: body } });
    corpusResult.value = r;
    toast(r.verdict || "查重完成", r.matches?.some((m) => m.longestRun >= 100) ? "warning" : "success");
  } catch (e) {
    toast(`查重失败：${(e as Error).message}`, "error");
  } finally {
    corpusRunning.value = false;
  }
}

/** 逐篇比对(带 LLM) —— 需要用户挑一篇文献 */
const plgRunning = ref(false);
const plgResult = ref<Record<string, unknown> | null>(null);
const srcPick = ref("");
const showPairwise = ref(false);

async function runPlagiarism() {
  const body = props.text.trim();
  const src = props.sources.find((s) => s.id === srcPick.value);
  if (!src) { toast("请先选择一篇比对文献 —— 这条查重需要源文本", "warning"); return; }
  plgRunning.value = true;
  plgResult.value = null;
  try {
    const r = await q<Record<string, unknown>>("/quality/plagiarism", {
      method: "POST",
      body: { text: body, sourceText: src.text },
    });
    plgResult.value = r;
    toast("逐篇比对完成", "success");
  } catch (e) {
    toast(`比对失败：${(e as Error).message}`, "error");
  } finally {
    plgRunning.value = false;
  }
}

/** 结果一律"原样铺开" —— 不按字段名定制排版。理由同 DeepAnalysisPanel: 后端各服务返回结构不同,
 *  写死一套渲染等于把字段名在前端再抄一遍, 后端一改前端就静默变空(本仓踩过多次) */
function flatten(v: unknown, depth = 0): Array<{ k: string; v: string }> {
  if (v === null || v === undefined) return [];
  if (typeof v === "string") return [{ k: "", v }];
  if (typeof v === "number" || typeof v === "boolean") return [{ k: "", v: String(v) }];
  if (Array.isArray(v)) return v.flatMap((x, i) => flatten(x, depth + 1).map((r) => ({ k: r.k || `[${i + 1}]`, v: r.v })));
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
    flatten(x, depth + 1).map((r) => ({ k: r.k ? `${k} · ${r.k}` : k, v: r.v })));
}
const fmtRows = computed(() => flatten(fmtResult.value).filter((r) => r.v.trim()));
const plgRows = computed(() => flatten(plgResult.value).filter((r) => r.v.trim()));
</script>

<template>
  <div class="sub">
    <!-- ① 选刊 -->
    <section class="sub-sec">
      <h4 class="sub-h"><span class="sub-n">1</span>选刊</h4>
      <p v-if="journalsNote" class="sub-note">{{ journalsNote }}</p>
      <template v-else>
        <div class="sub-levels">
          <button
            v-for="l in LEVELS" :key="l"
            class="sub-chip" :class="{ on: levelFilter === l }"
            :data-control="`workflow:sub-level-${l}`"
            @click="levelFilter = l"
          >{{ l }}</button>
          <span class="sub-count">{{ ranked.length }} 本</span>
        </div>
        <ul class="sub-journals">
          <li v-for="j in ranked" :key="j.id">
            <button
              class="sub-jrow" :class="{ on: picked?.id === j.id }"
              :data-control="`workflow:sub-journal-${j.id}`"
              @click="picked = picked?.id === j.id ? null : j"
            >
              <span class="sub-jname">{{ j.name }}</span>
              <span class="sub-jlevel">{{ j.level }}</span>
              <span class="sub-jorg">{{ j.org }}</span>
              <span v-if="j.topicTags?.length" class="sub-jtags">{{ j.topicTags.slice(0, 3).join(" / ") }}</span>
            </button>
          </li>
        </ul>
        <p v-if="picked" class="sub-picked">
          目标刊：<strong>{{ picked.name }}</strong>
          <template v-if="picked.org"> · {{ picked.org }}</template>
        </p>
      </template>
    </section>

    <!-- ② 格式规范 -->
    <section class="sub-sec">
      <h4 class="sub-h"><span class="sub-n">2</span>格式规范</h4>
      <p class="sub-note">
        按目标体例，逐条给出需要调整的地方。
        <template v-if="!picked">（先选刊会更贴切，不选也能跑。）</template>
      </p>
      <div class="sub-actions">
        <select v-model="fmtTarget" class="sub-select sub-select--target" data-control="workflow:sub-format-target">
          <option v-for="t in FORMAT_TARGETS" :key="t" :value="t">按{{ t }}体例</option>
        </select>
        <button class="sub-btn sub-btn--go" data-control="workflow:sub-format-run" :disabled="fmtRunning" @click="runFormat">
          {{ fmtRunning ? "检查中…" : "开始格式检查" }}
        </button>
      </div>
      <ul v-if="fmtRows.length" class="sub-rows">
        <li v-for="(r, i) in fmtRows" :key="i"><span v-if="r.k" class="sub-rk">{{ r.k }}</span><span class="sub-rv">{{ r.v }}</span></li>
      </ul>
    </section>

    <!-- ③ 查重 -->
    <section class="sub-sec">
      <h4 class="sub-h"><span class="sub-n">3</span>查重</h4>

      <!-- 主路径: 库查重。不需要用户准备任何东西 -->
      <p class="sub-note">
        与<strong>平台文献库</strong>比对（库里的论文全都有正文）。确定性字面重合检测，不调用模型，秒级出结果。
      </p>
      <div class="sub-actions">
        <button class="sub-btn sub-btn--go" data-control="workflow:sub-corpus-run" :disabled="corpusRunning" @click="runCorpusCheck">
          {{ corpusRunning ? "比对中…" : "与文献库比对" }}
        </button>
      </div>
      <template v-if="corpusResult?.ok">
        <p class="sub-verdict" :class="{ 'is-bad': (corpusResult.matches?.[0]?.longestRun ?? 0) >= 100 }">
          {{ corpusResult.verdict }}
        </p>
        <p class="sub-note">
          比对库 {{ corpusResult.corpusSize }} 篇 · 正文去噪后 {{ corpusResult.queryLength }} 字 ·
          命中 {{ corpusResult.matches.length }} 篇
        </p>
        <ul v-if="corpusResult.matches.length" class="sub-matches">
          <li v-for="m in corpusResult.matches" :key="m.id">
            <div class="sub-mrow">
              <span class="sub-mtitle" :title="m.title">{{ m.title }}</span>
              <span class="sub-mrun" :class="{ 'is-bad': m.longestRun >= 100, 'is-warn': m.longestRun >= 30 && m.longestRun < 100 }">
                最长连续 {{ m.longestRun }} 字
              </span>
              <span class="sub-mratio">重合率 {{ (m.overlapRatio * 100).toFixed(1) }}%</span>
            </div>
            <p v-if="m.sample" class="sub-msample">{{ m.sample }}</p>
          </li>
        </ul>
      </template>
      <p v-else-if="corpusResult && !corpusResult.ok" class="sub-note sub-note--warn">{{ corpusResult.error }}</p>

      <!-- 辅路径: 逐篇比对(带 LLM)。需要挑一篇文献, 默认收起 -->
      <details class="sub-pairwise">
        <summary>与某篇文献逐篇比对（带模型判断，能看出改写过的引用问题）</summary>
        <p class="sub-note">
          跟<strong>选定的那一篇</strong>比较。这条带模型，能识别"改写过的不当引用"——上面那条字面查重看不出来。
        </p>
        <div class="sub-src">
          <select v-model="srcPick" class="sub-select" data-control="workflow:sub-src-pick">
            <option value="">选择比对文献…</option>
            <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.title }}</option>
          </select>
          <button
            class="sub-btn sub-btn--go"
            data-control="workflow:sub-plg-run"
            :disabled="plgRunning || !srcPick"
            :title="!srcPick ? '请先选择一篇比对文献' : ''"
            @click="runPlagiarism"
          >{{ plgRunning ? "比对中…" : "开始比对" }}</button>
        </div>
        <p v-if="!sources.length" class="sub-note sub-note--warn">
          库里还没有可用于逐篇比对的文献正文 —— 这条需要源文本，没有就无法比对（上面的库查重不受影响）。
        </p>
        <ul v-if="plgRows.length" class="sub-rows">
          <li v-for="(r, i) in plgRows" :key="i"><span v-if="r.k" class="sub-rk">{{ r.k }}</span><span class="sub-rv">{{ r.v }}</span></li>
        </ul>
      </details>
    </section>
  </div>
</template>

<style scoped>
.sub { display: flex; flex-direction: column; gap: var(--wf-s4); }
.sub-sec { border-top: 1px solid var(--wf-line-soft); padding-top: var(--wf-s3); }
.sub-sec:first-child { border-top: 0; padding-top: 0; }
.sub-h { display: flex; align-items: center; gap: var(--wf-s2); margin: 0 0 var(--wf-s2); font-size: var(--wf-f-md); color: var(--wf-text); }
.sub-n {
  display: grid; place-items: center; width: 18px; height: 18px; flex-shrink: 0;
  border-radius: 50%; background: var(--wf-accent-soft); color: var(--wf-accent-hi); font-size: 10px;
}
.sub-note { margin: 0 0 var(--wf-s2); font-size: var(--wf-f-xs); color: var(--wf-muted); line-height: 1.7; }
.sub-note--warn { color: var(--wf-warn); }
.sub-note strong { color: var(--wf-text-2); }
.sub-levels { display: flex; align-items: center; gap: 6px; margin-bottom: var(--wf-s2); }
.sub-chip {
  cursor: pointer; border-radius: var(--wf-r-pill); padding: 2px 10px; font-size: var(--wf-f-xs);
  border: 1px solid var(--wf-line-strong); background: transparent; color: var(--wf-muted);
}
.sub-chip.on { border-color: var(--wf-accent); color: var(--wf-accent-hi); background: var(--wf-accent-soft); }
.sub-count { font-size: var(--wf-f-xs); color: var(--wf-faint); margin-left: auto; }
.sub-journals {
  list-style: none; margin: 0; padding: 0; max-height: 240px; overflow-y: auto;
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm); background: var(--wf-surface-2);
}
.sub-jrow {
  display: flex; align-items: center; gap: var(--wf-s2); width: 100%; text-align: left;
  cursor: pointer; border: 0; border-bottom: 1px solid var(--wf-line-soft);
  background: transparent; padding: 6px 10px; color: var(--wf-text-2);
}
.sub-jrow:hover { background: var(--wf-raised); }
.sub-jrow.on { background: var(--wf-accent-soft); }
.sub-jname { font-size: var(--wf-f-sm); color: var(--wf-text); flex-shrink: 0; }
.sub-jlevel { font-size: var(--wf-f-xs); color: var(--wf-accent-hi); flex-shrink: 0; }
.sub-jorg { font-size: var(--wf-f-xs); color: var(--wf-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub-jtags { margin-left: auto; font-size: var(--wf-f-xs); color: var(--wf-muted); flex-shrink: 0; }
.sub-picked { margin: var(--wf-s2) 0 0; font-size: var(--wf-f-sm); color: var(--wf-text-2); }
.sub-actions { display: flex; gap: var(--wf-s2); }
.sub-src { display: flex; gap: var(--wf-s2); }
.sub-select {
  flex: 1; min-width: 0; border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-surface-2); color: var(--wf-text); padding: 5px 9px; font-size: var(--wf-f-sm);
}
.sub-select--target { flex: 0 0 auto; width: auto; }
.sub-btn {
  cursor: pointer; flex-shrink: 0; border: 1px solid var(--wf-line-strong); border-radius: var(--wf-r-sm);
  background: transparent; color: var(--wf-text-2); padding: 5px 12px; font-size: var(--wf-f-sm);
  transition: background var(--wf-dur-fast) var(--wf-ease);
}
.sub-btn:hover:not(:disabled) { background: var(--wf-raised); }
.sub-btn:disabled { opacity: .5; cursor: not-allowed; }
.sub-btn--go { border-color: var(--wf-accent); color: var(--wf-accent-hi); }
.sub-btn--go:hover:not(:disabled) { background: var(--wf-accent-soft); }
.sub-rows { list-style: none; margin: var(--wf-s2) 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.sub-rows li { font-size: var(--wf-f-xs); line-height: 1.7; color: var(--wf-muted); }
.sub-rk { color: var(--wf-text-2); margin-right: 6px; }
.sub-rk::after { content: "："; }

/* 库查重结果(V425 加法) */
.sub-verdict { margin: var(--wf-s2) 0 0; font-size: var(--wf-f-sm); color: var(--wf-ok); line-height: 1.7; }
.sub-verdict.is-bad { color: var(--wf-danger); }
.sub-matches { list-style: none; margin: var(--wf-s2) 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.sub-matches > li {
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-surface-2); padding: 7px 10px;
}
.sub-mrow { display: flex; align-items: baseline; gap: var(--wf-s2); }
.sub-mtitle { font-size: var(--wf-f-xs); color: var(--wf-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.sub-mrun { flex-shrink: 0; font-size: var(--wf-f-xs); color: var(--wf-muted); }
.sub-mrun.is-warn { color: var(--wf-warn); }
.sub-mrun.is-bad { color: var(--wf-danger); font-weight: 600; }
.sub-mratio { margin-left: auto; flex-shrink: 0; font-size: var(--wf-f-xs); color: var(--wf-faint); }
/* 命中片段: 等宽 + 可换行, 供人工核对是不是真抄 */
.sub-msample {
  margin: 5px 0 0; padding: 5px 8px; border-left: 2px solid var(--wf-line-strong);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; line-height: 1.6; color: var(--wf-muted); word-break: break-all;
}
.sub-pairwise { margin-top: var(--wf-s3); border-top: 1px dashed var(--wf-line-soft); padding-top: var(--wf-s2); }
.sub-pairwise > summary { cursor: pointer; font-size: var(--wf-f-xs); color: var(--wf-faint); }
.sub-pairwise[open] > summary { margin-bottom: var(--wf-s2); }
</style>
