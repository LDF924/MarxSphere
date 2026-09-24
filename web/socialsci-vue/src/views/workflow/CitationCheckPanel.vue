<script setup lang="ts">
/**
 * CitationCheckPanel —— 引文核查(V425 第二批加法)
 *
 * 由来(2026-09-24): 后端 `POST /api/citations/verify` 是全站**已经接好**的能力
 *   (外壳的「引文核验」视图在用, `CitationVerifyPanel.tsx`), 但写作舱**零引用** ——
 *   而正文页恰恰是最需要它的地方: 引用对不对, 只有写到这里才看得出来。
 *
 * 与外壳那个面板的分工(不是重复实现):
 *   · 外壳是**单条手填** —— 你自己粘一句断言 + 一个 DOI 进去。
 *   · 这里是**批量、从正文里自动抽** —— 它读你正在写的这一章, 把带 `[n]` 标注的句子
 *     连同第 n 条参考文献配成对, 一条条送去核。
 *   真实的科研流程里要核的是几十条, 手填不现实。
 *
 * 为什么不用 LLM: `verify_claim.py` 是**纯确定性**的 —— Crossref + OpenAlex 查元数据,
 *   摘要与断言做分词余弦 + 方向性/否定冲突检测。实测一次约 1~3 秒, 不烧 token。
 *   所以这里可以放心地"一条条全跑", 不需要额度提示。
 *
 * 抽取规则刻意保守(宁可漏, 不可编):
 *   · 只认 `[1]` `[12]` 这种**方括号纯数字**标注 —— 中文论文的通行写法;
 *   · 上标圆括号 `(张三, 2020)` 一类**不猜** —— 猜错就会拿错文献去核, 得出一个
 *     看起来很专业但完全无关的结论, 比不核更糟。
 *   · 一条句子带多个标注时按标注逐个展开(同一句话对 X 和 Y 各核一次)。
 */
/**
 * 被核查的论文清单里有文献类素材才需要(见 WorkspaceView 的 storeReferences)。
 *
 * ⚠ kind 真源: 后端只接受 `note/citation/data_result/figure/file/theory/table`
 *   (server.ts 的 POST /api/research/materials 白名单), `literature` 会在那里被**静默降级**成
 *   `note`。所以判文献类必须用 `citation`。
 *   (本探针首跑就是发了一个 kind:literature, 结果存成 note, 于是两条断言假红。)
 */
import { computed, ref } from "vue";
import { toast } from "@/shared/ui";
import { q } from "@/shared/api";

interface RefEntry {
  title?: string;
  authors?: string;
  author?: string;
  source?: string;
  venue?: string;
  year?: string;
  doi?: string;
}

const props = defineProps<{
  /** 要核查的正文(章节正文或合稿全文) */
  text: string;
  /** 当前项目已入库的参考文献条目 —— 按顺序即 `[1]` `[2]` … */
  refs: RefEntry[];
}>();

type DimResult = { status: "green" | "yellow" | "white" | "red"; label: string; score: number; reason: string };
interface VerifyResult {
  ok?: boolean;
  error?: string;
  dimensions?: { metadata?: DimResult; relevance?: DimResult; support?: DimResult };
  overall?: { status: string; score: number };
}

interface CheckItem {
  /** 正文里的标注序号(1 起) */
  index: number;
  /** 去掉标注后的断言句 */
  claim: string;
  ref: RefEntry | null;
  state: "pending" | "running" | "done" | "failed";
  result?: VerifyResult;
  error?: string;
}

const CITATION_RE = /\[(\d{1,3})\]/g;

/** 句子切分 —— 中文句末标点 + 换行。保留原句是为了把整句当 claim 送核 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？；!?;])\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 把正文里"带标注的句子"抽成待核清单 */
const items = computed<CheckItem[]>(() => {
  const out: CheckItem[] = [];
  const seen = new Set<string>();
  for (const sent of splitSentences(props.text ?? "")) {
    const marks = [...sent.matchAll(CITATION_RE)].map((m) => Number(m[1]));
    if (!marks.length) continue;
    const claim = sent.replace(CITATION_RE, "").trim();
    if (claim.length < 6) continue;   // 太短的残句核不出东西, 后端也要求 >=5
    for (const n of marks) {
      const key = `${n}|${claim.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ index: n, claim, ref: props.refs?.[n - 1] ?? null, state: "pending" });
    }
  }
  return out;
});

const results = ref<CheckItem[]>([]);
const running = ref(false);
const progress = ref(0);
const abort = ref(false);

/** 有标注但库里没有对应条目 / 压根没标注 —— 两种情况要说清楚, 不要都显示成"0 条" */
const noRefs = computed(() => !(props.refs?.length));
const unmatched = computed(() => items.value.filter((i) => !i.ref).length);

const STATUS_META: Record<string, { label: string; color: string }> = {
  green: { label: "通过", color: "var(--wf-ok)" },
  yellow: { label: "存疑", color: "var(--wf-warn)" },
  white: { label: "无法判定", color: "var(--wf-muted)" },
  red: { label: "疑似问题", color: "var(--wf-danger)" },
};

function refLabel(r: RefEntry | null): string {
  if (!r) return "(库中无此条)";
  const t = String(r.title ?? "").trim();
  if (!t) return "(条目无标题)";
  const y = String(r.year ?? "").trim();
  return y ? `${t}（${y}）` : t;
}

async function run() {
  if (!items.value.length) { toast("正文里没有找到 [n] 形式的引用标注", "warning"); return; }
  running.value = true;
  abort.value = false;
  results.value = items.value.map((i) => ({ ...i }));
  progress.value = 0;
  let bad = 0;
  // 串行: 每条都要出网查 Crossref/OpenAlex, 并发会被限流反而更慢
  for (const it of results.value) {
    if (abort.value) break;
    it.state = "running";
    if (!it.ref) {
      it.state = "failed";
      it.error = "正文标注了 [" + it.index + "]，但库里没有第 " + it.index + " 条参考文献";
      progress.value++;
      continue;
    }
    try {
      const r = await q<VerifyResult>("/citations/verify", {
        method: "POST",
        body: {
          claim: it.claim,
          // 有 DOI 就优先给 DOI(后端据此查 Crossref 最准), 否则退回标题
          ...(it.ref.doi?.trim() ? { referenceDoi: it.ref.doi.trim() } : { referenceTitle: it.ref.title ?? "" }),
        },
      });
      it.result = r;
      it.state = "done";
      if (r.overall?.status === "red") bad++;
    } catch (e) {
      it.state = "failed";
      it.error = (e as Error).message || "核验失败";
    }
    progress.value++;
  }
  running.value = false;
  const done = results.value.filter((i) => i.state === "done").length;
  toast(
    abort.value
      ? `已停止（完成 ${done}/${results.value.length}）`
      : bad
        ? `核验完成：${done} 条，其中 ${bad} 条疑似问题`
        : `核验完成：${done} 条，未发现疑似问题`,
    bad ? "warning" : "success",
  );
}

function stop() { abort.value = true; }

/** 汇总口径: 只统计真跑出结果的, 失败/未跑的不算, 免得把"没核"混进"没问题" */
const summary = computed(() => {
  const done = results.value.filter((i) => i.state === "done");
  const by = (s: string) => done.filter((i) => i.result?.overall?.status === s).length;
  return { total: done.length, green: by("green"), yellow: by("yellow"), white: by("white"), red: by("red") };
});
</script>

<template>
  <div class="ccp">
    <div class="ccp-head">
      <div class="ccp-title">
        <strong>引文核查</strong>
        <span class="ccp-sub">
          从正文里抽出 <code>[n]</code> 标注，逐条去 Crossref / OpenAlex 核对元数据、语境与断言支持度
        </span>
      </div>
      <div class="ccp-actions">
        <button v-if="running" class="ccp-btn ccp-btn--stop" data-control="workflow:citation-check-stop" @click="stop">
          停止
        </button>
        <button v-else class="ccp-btn ccp-btn--go" data-control="workflow:citation-check-run" :disabled="!items.length" @click="run">
          开始核查
        </button>
      </div>
    </div>

    <!-- 空态按**原因**分开说 —— 三种情况用户要做的事完全不同 -->
    <p v-if="noRefs" class="ccp-note">
      当前项目还没有参考文献条目。请先在「文献与资料」里录入，正文里的 <code>[1]</code> 才有对应的第 1 条可核。
    </p>
    <p v-else-if="!items.length" class="ccp-note">
      正文里没有找到 <code>[1]</code> 这种方括号数字标注，所以没有可核的引用。
      （上标圆括号一类写法不做猜测 —— 猜错会拿错文献去核，结论比不核更误导。）
    </p>
    <p v-else class="ccp-note">
      找到 <span class="ccp-hl">{{ items.length }}</span> 处引用
      <template v-if="unmatched"> ，其中 <span class="ccp-warn">{{ unmatched }}</span> 处在库中找不到对应条目</template>
      。核查会逐条出网查询，约每条 1~3 秒。
    </p>

    <div v-if="running || results.length" class="ccp-bar">
      <div class="ccp-bar-fill" :style="{ width: (progress / Math.max(results.length, 1) * 100) + '%' }" />
      <span class="ccp-bar-text">{{ progress }} / {{ results.length }}</span>
    </div>

    <div v-if="summary.total" class="ccp-sum">
      <span class="ccp-sum-item" style="color: var(--wf-ok)">通过 {{ summary.green }}</span>
      <span class="ccp-sum-item" style="color: var(--wf-warn)">存疑 {{ summary.yellow }}</span>
      <span class="ccp-sum-item" style="color: var(--wf-muted)">无法判定 {{ summary.white }}</span>
      <span class="ccp-sum-item" style="color: var(--wf-danger)">疑似问题 {{ summary.red }}</span>
    </div>

    <ul v-if="results.length" class="ccp-list">
      <li v-for="(it, k) in results" :key="k" class="ccp-item" :class="'is-' + it.state">
        <div class="ccp-item-head">
          <span class="ccp-idx">[{{ it.index }}]</span>
          <span class="ccp-ref" :title="refLabel(it.ref)">{{ refLabel(it.ref) }}</span>
          <span v-if="it.state === 'running'" class="ccp-tag">核验中…</span>
          <span
            v-else-if="it.state === 'done' && it.result?.overall"
            class="ccp-tag"
            :style="{ color: STATUS_META[it.result.overall.status]?.color, borderColor: STATUS_META[it.result.overall.status]?.color }"
          >
            {{ STATUS_META[it.result.overall.status]?.label ?? it.result.overall.status }}
            · {{ it.result.overall.score?.toFixed(2) }}
          </span>
          <span v-else-if="it.state === 'failed'" class="ccp-tag ccp-tag--bad">未核</span>
        </div>
        <p class="ccp-claim">{{ it.claim }}</p>
        <p v-if="it.error" class="ccp-err">{{ it.error }}</p>
        <!-- 三个维度分别铺开: 元数据真伪 / 语境相关性 / 断言支持度 -->
        <ul v-if="it.result?.dimensions" class="ccp-dims">
          <li v-for="(d, name) in it.result.dimensions" :key="name">
            <span class="ccp-dim-name">{{ d?.label }}</span>
            <span class="ccp-dim-dot" :style="{ background: STATUS_META[d?.status ?? '']?.color }" />
            <span class="ccp-dim-reason">{{ d?.reason }}</span>
          </li>
        </ul>
        <p v-else-if="it.result?.error" class="ccp-err">{{ it.result.error }}</p>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.ccp { display: flex; flex-direction: column; gap: var(--wf-s3); }
.ccp-head { display: flex; align-items: flex-start; gap: var(--wf-s3); }
.ccp-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ccp-title strong { font-size: var(--wf-f-md); color: var(--wf-text); }
.ccp-sub { font-size: var(--wf-f-xs); color: var(--wf-muted); }
.ccp-sub code, .ccp-note code {
  background: var(--wf-sunken); border-radius: 4px; padding: 1px 5px; font-size: 11px;
}
.ccp-actions { margin-left: auto; flex-shrink: 0; }
.ccp-btn {
  border-radius: var(--wf-r-sm); border: 1px solid var(--wf-line-strong);
  padding: 5px 12px; font-size: var(--wf-f-sm); cursor: pointer;
  background: transparent; color: var(--wf-text-2); transition: background var(--wf-dur-fast) var(--wf-ease);
}
.ccp-btn:hover:not(:disabled) { background: var(--wf-raised); }
.ccp-btn:disabled { opacity: .5; cursor: not-allowed; }
.ccp-btn--go { border-color: var(--wf-accent); color: var(--wf-accent-hi); }
.ccp-btn--go:hover:not(:disabled) { background: var(--wf-accent-soft); }
.ccp-btn--stop { border-color: var(--wf-danger); color: var(--wf-danger); }

.ccp-note { font-size: var(--wf-f-sm); color: var(--wf-muted); margin: 0; line-height: 1.7; }
.ccp-hl { color: var(--wf-accent-hi); font-weight: 600; }
.ccp-warn { color: var(--wf-warn); font-weight: 600; }

.ccp-bar {
  position: relative; height: 18px; border-radius: var(--wf-r-sm);
  background: var(--wf-surface-2); overflow: hidden;
}
.ccp-bar-fill { height: 100%; background: var(--wf-accent-soft); transition: width var(--wf-dur) var(--wf-ease); }
.ccp-bar-text {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-size: var(--wf-f-xs); color: var(--wf-text-2);
}

.ccp-sum { display: flex; flex-wrap: wrap; gap: var(--wf-s3); font-size: var(--wf-f-sm); }
.ccp-sum-item { font-weight: 600; }

.ccp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--wf-s2); }
.ccp-item {
  border: 1px solid var(--wf-line); border-radius: var(--wf-r);
  background: var(--wf-surface-2); padding: var(--wf-s3);
}
.ccp-item.is-failed { border-color: var(--wf-warn); }
.ccp-item-head { display: flex; align-items: center; gap: var(--wf-s2); }
.ccp-idx { font-size: var(--wf-f-sm); color: var(--wf-accent-hi); font-weight: 600; flex-shrink: 0; }
.ccp-ref {
  font-size: var(--wf-f-sm); color: var(--wf-text-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
.ccp-tag {
  margin-left: auto; flex-shrink: 0; font-size: var(--wf-f-xs);
  border: 1px solid currentColor; border-radius: var(--wf-r-pill); padding: 1px 8px; color: var(--wf-muted);
}
.ccp-tag--bad { color: var(--wf-danger); }
.ccp-claim { margin: var(--wf-s2) 0 0; font-size: var(--wf-f-sm); color: var(--wf-text); line-height: 1.7; }
.ccp-err { margin: var(--wf-s2) 0 0; font-size: var(--wf-f-xs); color: var(--wf-warn); }
.ccp-dims { list-style: none; margin: var(--wf-s2) 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.ccp-dims li { display: flex; align-items: baseline; gap: var(--wf-s2); font-size: var(--wf-f-xs); color: var(--wf-muted); }
.ccp-dim-name { flex-shrink: 0; color: var(--wf-text-2); }
.ccp-dim-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; align-self: center; }
.ccp-dim-reason { line-height: 1.6; }
</style>
