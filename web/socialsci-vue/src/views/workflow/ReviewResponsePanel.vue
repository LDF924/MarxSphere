<script setup lang="ts">
/**
 * ReviewResponsePanel(审稿意见与逐条回应) — 批6 的主体。
 *
 * ## 为什么要有这一块
 *
 * 平台此前**没有"外部审稿意见"这个概念**(全流程审计结论):
 *   · `/api/review/*` 是**单向的"我方当审稿人"** —— 入参只有稿件全文, 吃不了外部意见;
 *   · `phase5_revise` 吃的是**系统自审报告**, 而且报告里的逐条 issue **根本没进 prompt**;
 *   · 场景卡 S30「审稿意见回应」是**纯提示文案**, 指向用户本机的技能包。
 * 于是真实科研里最硬的一环是空白: 意见要**逐条**回应, 且"我没改"与"我改了但没改到位"
 * 是两回事 —— 编辑部要的正是这个区分。
 *
 * ## 落库, 不是 localStorage
 *
 * 参考产品那份"逐条复核"(ReviewView 的 verdicts)只存 localStorage, 换个浏览器就没了。
 * 而这是**要交给编辑部的材料** —— 丢了等于白干一轮返修。所以一律走后端。
 *
 * ## 状态由后端派生
 *
 * `status` 不从这里传: 填了`呼应方式`就是已处理, 没填就是待处理。两个字段描述同一件事,
 * 各传各的迟早出现"已修改但状态是待处理"这种自相矛盾的行。
 */
import { ref, computed, onMounted, watch } from "vue";
import { q } from "@/shared/api";
import { useWorkflowStore } from "./stores/workflow";
import { toast } from "@/shared/ui";

const store = useWorkflowStore();

interface Item {
  id?: string; round: number; reviewerLabel: string; seq: number;
  kind: string; quote: string; comment: string;
  response: string; responseType: string; status: string; revisionRefs: number[];
}

interface Submission {
  id?: string; journalName: string; submittedOn: string; status: string; note: string; round: number;
}

const SUB_STATUS_CN: Record<string, string> = {
  submitted: "已投出", under_review: "外审中", revision_requested: "退修",
  accepted: "已录用", rejected: "已拒稿", withdrawn: "已撤稿",
};

const KIND_CN: Record<string, string> = {
  revise: "修改类", question: "质疑类", supplement: "补充类", reject: "拒绝类",
};
const RESP_CN: Record<string, string> = {
  revised: "已修改", responded: "已回应", disagreed: "未采纳",
};

const items = ref<Item[]>([]);
const rounds = ref<number[]>([]);
const activeRound = ref<number | null>(null);
const loading = ref(true);
const busy = ref(false);
const pasteText = ref("");
const letter = ref("");
/**
 * 投稿记录 —— 与意见条目同一区, 因为它们是**同一件事的两段**:
 * "投给谁/什么时候投的" 与 "收到的意见" 分开放, 用户会找不到自己投的是哪一稿。
 */
const subs = ref<Submission[]>([]);

const pid = computed(() => store.taskId);

/** 当前轮次的条目 —— 逐条处理时只看一轮, 避免第二轮的意见混进来 */
const shown = computed(() =>
  activeRound.value === null ? items.value : items.value.filter((i) => i.round === activeRound.value));

const stats = computed(() => {
  const s = shown.value;
  return { total: s.length, done: s.filter((i) => i.responseType).length };
});

async function load() {
  if (!pid.value) { loading.value = false; return; }
  loading.value = true;
  try {
    const [r, s] = await Promise.all([
      q<{ items: Item[]; rounds: number[] }>(`/research/projects/${pid.value}/review-responses`),
      q<{ submissions: Submission[] }>(`/research/projects/${pid.value}/submissions`).catch(() => ({ submissions: [] })),
    ]);
    items.value = r.items ?? [];
    rounds.value = r.rounds ?? [];
    subs.value = s.submissions ?? [];
    if (activeRound.value === null && rounds.value.length) activeRound.value = rounds.value[rounds.value.length - 1];
  } catch (e) {
    toast(`读取审稿意见失败: ${(e as Error).message}`, "error");
  } finally {
    loading.value = false;
  }
}

async function persistSubs(next: Submission[] = subs.value) {
  if (!pid.value) return;
  busy.value = true;
  try {
    const r = await q<{ submissions: Submission[] }>(`/research/projects/${pid.value}/submissions`, {
      method: "PUT",
      body: { submissions: next },
    });
    subs.value = r.submissions ?? next;
  } catch (e) {
    toast(`投稿记录保存失败: ${(e as Error).message}`, "error");
  } finally {
    busy.value = false;
  }
}

/**
 * 本地日期 `YYYY-MM-DD`。
 *
 * ⚠ **不能用 `new Date().toISOString().slice(0,10)`** —— 那是 UTC 日期,
 *   在东八区的**每天 00:00–07:59** 会退回前一天。而"投稿日期差一天"是要被编辑部抓的。
 *   (后端 review-response-service 里那个 `toDateStr` 是配套的另一半: 读出时也不走 UTC。
 *    两半缺一, 就会写对读错或写错读对。探针 ⑥ 锁的就是这一对。)
 */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addSubmission() {
  const next = [...subs.value, {
    journalName: "", submittedOn: todayLocal(),
    status: "submitted", note: "", round: rounds.value.length || 1,
  }];
  subs.value = next;
  void persistSubs(next);
}

function setSub(i: number, key: keyof Submission, v: string) {
  const next = subs.value.map((x, j) => (j === i ? { ...x, [key]: v } : x));
  subs.value = next;
  void persistSubs(next);
}

function removeSub(i: number) {
  const next = subs.value.filter((_, j) => j !== i);
  subs.value = next;
  void persistSubs(next);
}

async function persist(next: Item[] = items.value) {
  if (!pid.value) return;
  busy.value = true;
  try {
    const r = await q<{ items: Item[]; rounds: number[] }>(`/research/projects/${pid.value}/review-responses`, {
      method: "PUT",
      body: { items: next },
    });
    items.value = r.items ?? next;
    rounds.value = r.rounds ?? rounds.value;
  } catch (e) {
    toast(`保存失败: ${(e as Error).message}`, "error");
  } finally {
    busy.value = false;
  }
}

/**
 * 粘贴导入。**先预览再落库** —— 拆条是启发式, 拆错了用户得能看见并改,
 * 而不是等写进库才发现"怎么多了一条/少了一条"。
 */
const preview = ref<Array<{ reviewerLabel: string; comment: string }> | null>(null);

async function doPreview() {
  if (!pasteText.value.trim() || !pid.value) return;
  try {
    const r = await q<{ count: number; parts: Array<{ reviewerLabel: string; comment: string }> }>(
      `/research/projects/${pid.value}/review-responses/split-preview`,
      { method: "POST", body: { text: pasteText.value } });
    preview.value = r.parts ?? [];
    if (!preview.value.length) toast("没有解析出任何意见", "info");
  } catch (e) {
    toast(`解析失败: ${(e as Error).message}`, "error");
  }
}

async function confirmImport() {
  if (!pasteText.value.trim() || !pid.value) return;
  busy.value = true;
  try {
    const r = await q<{ ok: boolean; added: number; items: Item[]; rounds: number[] }>(
      `/research/projects/${pid.value}/review-responses/import`,
      { method: "POST", body: { text: pasteText.value } });
    if (!r.ok) { toast(r.added ? "" : "导入失败", "error"); return; }
    items.value = r.items ?? [];
    rounds.value = r.rounds ?? [];
    if (rounds.value.length) activeRound.value = rounds.value[rounds.value.length - 1];
    pasteText.value = "";
    preview.value = null;
    toast(`已导入 ${r.added} 条意见`, "success");
  } catch (e) {
    toast(`导入失败: ${(e as Error).message}`, "error");
  } finally {
    busy.value = false;
  }
}

function setField(it: Item, key: keyof Item, v: string) {
  const next = items.value.map((x) => (x === it ? { ...x, [key]: v } : x));
  items.value = next;
  void persist(next);
}

function setResponseType(it: Item, v: string) {
  // 再点一次同一个 = 撤销(让用户能改回"未处理")
  const chosen = it.responseType === v ? "" : v;
  const next = items.value.map((x) => (x === it ? { ...x, responseType: chosen } : x));
  items.value = next;
  void persist(next);
}

function removeItem(it: Item) {
  const next = items.value.filter((x) => x !== it);
  items.value = next;
  void persist(next);
}

async function genLetter() {
  if (!pid.value) return;
  try {
    const r = await q<{ markdown: string }>(`/research/projects/${pid.value}/review-responses/letter`, {
      method: "POST",
      body: { items: items.value, title: store.title || "" },
    });
    letter.value = r.markdown ?? "";
  } catch (e) {
    toast(`生成失败: ${(e as Error).message}`, "error");
  }
}

async function copyLetter() {
  try {
    await navigator.clipboard.writeText(letter.value);
    toast("已复制到剪贴板", "success");
  } catch {
    toast("复制失败，请手动选中", "error");
  }
}

watch(() => store.taskId, () => void load());
onMounted(() => void load());
</script>

<template>
  <div class="rr">
    <div class="rr-head">
      <h2 class="rr-h2">审稿意见与逐条回应</h2>
      <span v-if="stats.total" class="rr-stat">
        {{ stats.total }} 条 · 已处理 {{ stats.done }} / {{ stats.total }}
      </span>
    </div>

    <p v-if="!pid" class="rr-muted">先选择一个研究项目。</p>
    <p v-else-if="loading" class="rr-muted">读取中…</p>

    <template v-else>
      <!-- ① 投稿记录 -->
      <section class="rr-sec rr-sec-first">
        <div class="rr-head2">
          <h3 class="rr-h3">投稿记录</h3>
          <button class="rr-btn rr-btn-sm" :disabled="busy" data-control="workflow:sub-add" @click="addSubmission">＋ 记一次投稿</button>
        </div>
        <p v-if="!subs.length" class="rr-hint">
          还没记录。记下投给哪个刊、什么时候投的 —— 收到意见时才知道这批意见对应的是哪一稿。
        </p>
        <div v-for="(s, i) in subs" :key="s.id ?? i" class="rr-sub" :data-control="`workflow:sub-row-${i}`">
          <input
            class="rr-in rr-in-j" :value="s.journalName" placeholder="期刊名"
            :data-control="`workflow:sub-journal-${i}`"
            @change="setSub(i, 'journalName', ($event.target as HTMLInputElement).value)"
          />
          <input
            class="rr-in" type="date" :value="s.submittedOn"
            :data-control="`workflow:sub-date-${i}`"
            @change="setSub(i, 'submittedOn', ($event.target as HTMLInputElement).value)"
          />
          <select
            class="rr-in" :value="s.status"
            :data-control="`workflow:sub-status-${i}`"
            @change="setSub(i, 'status', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="(cn, k) in SUB_STATUS_CN" :key="k" :value="k">{{ cn }}</option>
          </select>
          <input
            class="rr-in rr-in-n" :value="s.note" placeholder="备注（稿号等）"
            :data-control="`workflow:sub-note-${i}`"
            @change="setSub(i, 'note', ($event.target as HTMLInputElement).value)"
          />
          <button class="rr-del" :data-control="`workflow:sub-del-${i}`" title="删除" @click="removeSub(i)">×</button>
        </div>
      </section>

      <!-- ② 粘贴导入 -->
      <section class="rr-sec">
        <h3 class="rr-h3">录入审稿意见</h3>
        <p class="rr-hint">
          把编辑部/审稿人发来的意见**整段**粘进来，系统按编号拆成条目。
          拆条**不改写原文**（原文要原样引用给对方）。
        </p>
        <textarea
          v-model="pasteText"
          class="rr-paste"
          rows="5"
          placeholder="1. 引言部分缺少问题意识……&#10;2. 表 2 中 x 的系数与正文不一致……"
          data-control="workflow:rr-paste"
        ></textarea>
        <div class="rr-row">
          <button class="rr-btn" :disabled="!pasteText.trim() || busy" data-control="workflow:rr-preview" @click="doPreview">
            预览拆分
          </button>
          <button v-if="preview" class="rr-btn rr-primary" :disabled="busy" data-control="workflow:rr-import" @click="confirmImport">
            确认导入 {{ preview.length }} 条
          </button>
        </div>
        <div v-if="preview" class="rr-preview" data-control="workflow:rr-preview-list">
          <div v-for="(p, i) in preview" :key="i" class="rr-preview-row">
            <span class="rr-seq">{{ i + 1 }}</span>
            <span v-if="p.reviewerLabel" class="rr-label">{{ p.reviewerLabel }}</span>
            <span class="rr-preview-text">{{ p.comment }}</span>
          </div>
        </div>
      </section>

      <!-- ② 逐条回应 -->
      <section v-if="items.length" class="rr-sec">
        <div class="rr-head2">
          <h3 class="rr-h3">逐条回应</h3>
          <select v-if="rounds.length > 1" v-model.number="activeRound" class="rr-round" data-control="workflow:rr-round">
            <option v-for="r in rounds" :key="r" :value="r">第 {{ r }} 轮</option>
          </select>
        </div>
        <p class="rr-hint">
          「未采纳」的意见**不会**进入修订稿 —— 那是你明确不想改的。
          「已修改」「已回应」的会连同你的表态一起送进修订。
        </p>

        <article v-for="it in shown" :key="it.id ?? it.seq" class="rr-item" :data-control="`workflow:rr-item-${it.seq}`">
          <div class="rr-item-head">
            <span class="rr-seq">{{ it.seq + 1 }}</span>
            <select
              class="rr-kind" :value="it.kind"
              :data-control="`workflow:rr-kind-${it.seq}`"
              @change="setField(it, 'kind', ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="(cn, k) in KIND_CN" :key="k" :value="k">{{ cn }}</option>
            </select>
            <span v-if="it.reviewerLabel" class="rr-label">{{ it.reviewerLabel }}</span>
            <span v-if="it.responseType" class="rr-done">{{ RESP_CN[it.responseType] }}</span>
            <button class="rr-del" :data-control="`workflow:rr-del-${it.seq}`" title="删除这条" @click="removeItem(it)">×</button>
          </div>

          <label class="rr-fl">意见原文</label>
          <textarea
            class="rr-ta" :value="it.comment" rows="3"
            :data-control="`workflow:rr-comment-${it.seq}`"
            @change="setField(it, 'comment', ($event.target as HTMLTextAreaElement).value)"
          ></textarea>

          <label class="rr-fl">作者回应</label>
          <textarea
            class="rr-ta" :value="it.response" rows="3"
            placeholder="对这条意见的处置说明（会写进回应信）"
            :data-control="`workflow:rr-response-${it.seq}`"
            @change="setField(it, 'response', ($event.target as HTMLTextAreaElement).value)"
          ></textarea>

          <div class="rr-acts">
            <button
              v-for="(cn, k) in RESP_CN" :key="k"
              class="rr-chip" :class="{ 'is-on': it.responseType === k }"
              :data-control="`workflow:rr-resp-${k}-${it.seq}`"
              @click="setResponseType(it, k)"
            >{{ cn }}</button>
          </div>
        </article>
      </section>

      <!-- ③ 回应信 -->
      <section v-if="items.length" class="rr-sec">
        <h3 class="rr-h3">回应信</h3>
        <p class="rr-hint">
          交给编辑部的逐条回复。**未处理的条目也会列出并标注** —— 瞒着不写，编辑一审就会发现少一条。
        </p>
        <div class="rr-row">
          <button class="rr-btn rr-primary" data-control="workflow:rr-gen-letter" @click="genLetter">生成回应信</button>
          <button v-if="letter" class="rr-btn" data-control="workflow:rr-copy-letter" @click="copyLetter">复制</button>
        </div>
        <pre v-if="letter" class="rr-letter" data-control="workflow:rr-letter">{{ letter }}</pre>
      </section>
    </template>
  </div>
</template>

<style scoped>
.rr { border: 1px solid var(--wf-line); border-radius: var(--wf-r); background: var(--wf-surface); padding: 14px 16px; }
.rr-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
.rr-head2 { display: flex; align-items: baseline; gap: 10px; }
.rr-h2 { margin: 0; font-size: 15px; font-weight: 600; color: var(--wf-text); }
.rr-h3 { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--wf-text); }
.rr-stat { font-size: 12px; color: var(--wf-muted); margin-left: auto; }
.rr-muted { font-size: 13px; color: var(--wf-muted); margin: 6px 0 0; }
.rr-hint { font-size: 12px; color: var(--wf-faint); margin: 4px 0 8px; line-height: 1.6; }
.rr-sec { border-top: 1px dashed var(--wf-line-soft); padding-top: 12px; margin-top: 12px; }
/* 第一条小节紧贴标题, 不该多出一道分隔线 */
.rr-sec-first { border-top: none; padding-top: 10px; }
.rr-in {
  background: var(--wf-bg); color: var(--wf-text); border: 1px solid var(--wf-line);
  border-radius: var(--wf-r-sm, 6px); padding: 3px 7px; font-size: 12px;
  font-family: inherit; min-width: 0;
}
.rr-in-j { flex: 1.6; }
.rr-in-n { flex: 1.4; }
.rr-btn-sm { font-size: 11.5px; padding: 2px 9px; margin-left: auto; }
.rr-sub { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
.rr-paste, .rr-ta {
  width: 100%; box-sizing: border-box; background: var(--wf-bg); color: var(--wf-text);
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm, 6px);
  padding: 7px 9px; font-size: 12.5px; line-height: 1.6; resize: vertical;
  font-family: inherit;
}
.rr-row { display: flex; gap: 8px; margin-top: 8px; }
.rr-btn {
  font-size: 12.5px; padding: 5px 12px; cursor: pointer; border-radius: var(--wf-r-pill);
  border: 1px solid var(--wf-line); background: var(--wf-bg); color: var(--wf-text);
}
.rr-btn:disabled { opacity: .45; cursor: not-allowed; }
.rr-primary { border-color: var(--wf-accent, #6FBF8B); color: var(--wf-accent, #6FBF8B); }
.rr-preview { margin-top: 10px; border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm, 6px); padding: 8px 10px; background: var(--wf-bg); }
.rr-preview-row { display: flex; gap: 8px; font-size: 12px; padding: 3px 0; align-items: baseline; }
.rr-preview-text { color: var(--wf-muted); flex: 1; }
.rr-seq {
  font-size: 11px; color: var(--wf-faint); border: 1px solid var(--wf-line);
  border-radius: var(--wf-r-pill); min-width: 18px; text-align: center; flex-shrink: 0;
}
.rr-label { font-size: 11px; color: var(--wf-faint); }
.rr-round { font-size: 12px; margin-left: auto; background: var(--wf-bg); color: var(--wf-text); border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm, 6px); padding: 2px 6px; }
.rr-item { border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm, 6px); padding: 9px 11px; margin-top: 9px; background: var(--wf-bg); }
.rr-item-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.rr-kind { font-size: 11.5px; background: var(--wf-bg); color: var(--wf-text); border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm, 6px); padding: 1px 5px; }
.rr-done { font-size: 11px; color: #6FBF8B; border: 1px solid #6FBF8B; border-radius: var(--wf-r-pill); padding: 0 6px; }
.rr-del { margin-left: auto; background: none; border: none; color: var(--wf-faint); cursor: pointer; font-size: 15px; line-height: 1; padding: 0 4px; }
.rr-del:hover { color: #E0714F; }
.rr-fl { display: block; font-size: 11px; color: var(--wf-faint); margin: 6px 0 3px; }
.rr-acts { display: flex; gap: 6px; margin-top: 7px; }
.rr-chip {
  font-size: 11.5px; padding: 2px 9px; cursor: pointer; border-radius: var(--wf-r-pill);
  border: 1px solid var(--wf-line); background: var(--wf-bg); color: var(--wf-muted);
}
.rr-chip.is-on { border-color: #6FBF8B; color: #6FBF8B; }
.rr-letter {
  margin-top: 10px; padding: 10px 12px; background: var(--wf-bg);
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm, 6px);
  font-size: 12px; line-height: 1.7; white-space: pre-wrap; color: var(--wf-text);
  max-height: 420px; overflow: auto; font-family: inherit;
}
</style>
