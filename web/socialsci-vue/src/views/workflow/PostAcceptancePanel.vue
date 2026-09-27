<script setup lang="ts">
/**
 * PostAcceptancePanel(录用与传播) — 批9 的前端。
 *
 * ## 为什么这一段**没有 AI 生成**
 *
 * 三项都是"选 + 填 + 核"，不是"写"：
 *   · **版权许可 / 开放获取** —— 标准条款的**选择**。文本是固定的，让模型"写一份"
 *     等于让它复述条款，写错就是权利让渡错，而当事人当场看不出来；
 *   · **校样检查** —— 要**看到校样**才谈得上核。校样是编辑部发来的文件，平台手上没有；
 *     让模型写"检查清单"只会得到一段放之四海皆准的套话。
 *
 * 所以这里把「有哪些选项、各自什么代价」摆清楚（`hint` 逐条写在界面上），**不替用户决定**。
 * 与批5 的投稿声明同一模式。表在后端 `/research/post-acceptance/options`，前端不写死 ——
 * 两边各写一份必然漂移，而漂移的后果是"界面让你选 X、库里存成 Y"。
 *
 * ## 为什么放在「投稿与返修」区里
 *
 * 顺序就是真实顺序：投稿记录 → 意见返修 → **录用 → 出版事务 → 传播**。
 * 新开第三个区会让用户在两处找同一件事（批6/批9 的计划都明确不新建区）。
 */
import { ref, computed, onMounted, watch } from "vue";
import { q } from "@/shared/api";
import { useWorkflowStore } from "./stores/workflow";
import { toast } from "@/shared/ui";

interface OptionItem { key: string; label: string; hint: string }
interface Submission {
  id?: string; journalName: string; status: string; round: number;
  license: string; licenseNote: string; oaChoice: string; oaNote: string;
  proofChecked: boolean; proofNotes: string; acceptedOn: string;
}
interface Followup { id?: string; kind: string; title: string; detail: string; happenedOn: string }

const store = useWorkflowStore();
const pid = computed(() => store.taskId);

const licenses = ref<OptionItem[]>([]);
const oaOptions = ref<OptionItem[]>([]);
const proofList = ref<string[]>([]);

/** 只对**已录用**的投稿显示这一段 —— 还没录用时这些字段没有意义，显示了只会干扰 */
const subs = ref<Submission[]>([]);
const acceptedSubs = computed(() => subs.value.filter((s) => s.status === "accepted"));

const trans = ref<Followup[]>([]);
const dirs = ref<Followup[]>([]);

async function load() {
  if (!pid.value) return;
  try {
    const [opts, sub, fu] = await Promise.all([
      q<{ licenses: OptionItem[]; oa: OptionItem[]; proofChecklist: string[] }>("/research/post-acceptance/options"),
      q<{ submissions: Submission[] }>(`/research/projects/${pid.value}/submissions`).catch(() => ({ submissions: [] })),
      q<{ followups: Followup[] }>(`/research/projects/${pid.value}/followups`).catch(() => ({ followups: [] })),
    ]);
    licenses.value = opts.licenses ?? [];
    oaOptions.value = opts.oa ?? [];
    proofList.value = opts.proofChecklist ?? [];
    subs.value = sub.submissions ?? [];
    const all = fu.followups ?? [];
    trans.value = all.filter((f) => f.kind === "translation");
    dirs.value = all.filter((f) => f.kind === "direction");
  } catch (e) {
    toast(`读取失败: ${(e as Error).message}`, "error");
  }
}

/** 保存一条投稿（改哪个字段就整个数组回写 —— 与投稿记录那张卡同一套语义） */
async function persistSubs(next: Submission[] = subs.value) {
  if (!pid.value) return;
  try {
    const r = await q<{ submissions: Submission[] }>(`/research/projects/${pid.value}/submissions`, {
      method: "PUT", body: { submissions: next },
    });
    subs.value = r.submissions ?? next;
  } catch (e) {
    toast(`保存失败: ${(e as Error).message}`, "error");
  }
}

function setSub(id: string | undefined, key: keyof Submission, v: unknown) {
  if (!id) return;
  const next = subs.value.map((s) => (s.id === id ? { ...s, [key]: v } : s));
  subs.value = next;
  void persistSubs(next);
}

/** 校样核完 → 记一条**带内容的**备注，而不只是打个勾（"核了"与"核出什么"是两回事） */
function markProofed(s: Submission) {
  setSub(s.id, "proofChecked", true);
  if (!s.proofNotes.trim()) {
    toast("已标记核对完成 —— 建议把核出的问题写进备注，否则过几天就忘了", "info");
  }
}

async function persistFollowups(nextKind: "translation" | "direction", next: Followup[]) {
  if (!pid.value) return;
  const merged = nextKind === "translation" ? [...next, ...dirs.value] : [...trans.value, ...next];
  try {
    const r = await q<{ followups: Followup[] }>(`/research/projects/${pid.value}/followups`, {
      method: "PUT", body: { followups: merged },
    });
    const all = r.followups ?? merged;
    trans.value = all.filter((f) => f.kind === "translation");
    dirs.value = all.filter((f) => f.kind === "direction");
  } catch (e) {
    toast(`保存失败: ${(e as Error).message}`, "error");
  }
}
const addTrans = () => void persistFollowups("translation", [...trans.value, { kind: "translation", title: "", detail: "", happenedOn: "" }]);
const addDir = () => void persistFollowups("direction", [...dirs.value, { kind: "direction", title: "", detail: "", happenedOn: "" }]);
function setFu(kind: "translation" | "direction", i: number, key: keyof Followup, v: string) {
  const arr = kind === "translation" ? trans.value : dirs.value;
  const next = arr.map((f, j) => (j === i ? { ...f, [key]: v } : f));
  void persistFollowups(kind, next);
}
function delFu(kind: "translation" | "direction", i: number) {
  const arr = kind === "translation" ? trans.value : dirs.value;
  void persistFollowups(kind, arr.filter((_, j) => j !== i));
}

onMounted(() => void load());
/**
 * ⚠ **必须 watch taskId**, 不能只在 onMounted 里 load 一次。
 *
 * 本面板是 `SubmissionView` 的**子组件**, 而 Vue 里**子组件的 onMounted 先于父组件执行** ——
 *   那一刻 `store.loadProject()` 还没跑完, `pid` 是空的, `load()` 第一句就 `return` 了,
 *   之后再没有任何东西把它叫醒。
 *
 * 实测后果(2026-09-27): 面板渲染了、"＋ 记一条"也能点(点击时才用 pid, 那时已就绪),
 *   但**已录用的投稿卡永远不出现**, 界面一直说"还没有已录用的投稿" ——
 *   而接口在同一个 iframe 里返回的是 `status: "accepted"`。**数据对、界面看不到。**
 *   这类"能力有了但用户看不到"正是本仓反复出现的一类。
 *   (`ReviewResponsePanel` 有这句 watch, 我新建这个面板时漏了。)
 */
watch(() => store.taskId, () => void load());
</script>

<template>
  <div class="pa">
    <div class="pa-head">
      <h2 class="pa-h2">录用与传播</h2>
      <span class="pa-muted">录用之后的出版事务与成果去向</span>
    </div>

    <p v-if="!pid" class="pa-muted">先选择一个研究项目。</p>

    <template v-else>
      <!-- ① 出版事务：只对**已录用**的投稿显示 -->
      <section class="pa-sec">
        <h3 class="pa-h3">出版事务</h3>
        <p v-if="!acceptedSubs.length" class="pa-hint" data-control="workflow:pa-no-accepted">
          还没有「已录用」的投稿。上面把某条投稿的状态改成<b>已录用</b>后，这里会出现版权许可、
          开放获取与校样核对。
        </p>

        <article v-for="s in acceptedSubs" :key="s.id" class="pa-card" data-control="workflow:pa-sub">
          <div class="pa-card-head">
            <strong>{{ s.journalName || "未填期刊" }}</strong>
            <span class="pa-muted">第 {{ s.round }} 轮</span>
            <label class="pa-inline">
              录用日期
              <input
                class="pa-in" type="date" :value="s.acceptedOn"
                :data-control="`workflow:pa-accepted-on-${s.id}`"
                @change="setSub(s.id, 'acceptedOn', ($event.target as HTMLInputElement).value)"
              />
            </label>
          </div>

          <!-- 版权许可 -->
          <div class="pa-field">
            <label class="pa-label">版权许可</label>
            <select
              class="pa-in" :value="s.license"
              :data-control="`workflow:pa-license-${s.id}`"
              @change="setSub(s.id, 'license', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">请选择</option>
              <option v-for="o in licenses" :key="o.key" :value="o.key">{{ o.label }}</option>
            </select>
            <!-- hint 逐条写出来 —— 用户选的是"权利让渡多少", 光看名字猜不出来 -->
            <p v-if="licenses.find((o) => o.key === s.license)" class="pa-hint">
              {{ licenses.find((o) => o.key === s.license)?.hint }}
            </p>
            <input
              class="pa-in pa-in-wide" :value="s.licenseNote" placeholder="备注（期刊给的模板、编辑部要求…）"
              :data-control="`workflow:pa-license-note-${s.id}`"
              @change="setSub(s.id, 'licenseNote', ($event.target as HTMLInputElement).value)"
            />
          </div>

          <!-- 开放获取 -->
          <div class="pa-field">
            <label class="pa-label">开放获取</label>
            <select
              class="pa-in" :value="s.oaChoice"
              :data-control="`workflow:pa-oa-${s.id}`"
              @change="setSub(s.id, 'oaChoice', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">请选择</option>
              <option v-for="o in oaOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
            </select>
            <p v-if="oaOptions.find((o) => o.key === s.oaChoice)" class="pa-hint">
              {{ oaOptions.find((o) => o.key === s.oaChoice)?.hint }}
            </p>
            <input
              class="pa-in pa-in-wide" :value="s.oaNote" placeholder="备注（APC 额度、embargo 期限…）"
              :data-control="`workflow:pa-oa-note-${s.id}`"
              @change="setSub(s.id, 'oaNote', ($event.target as HTMLInputElement).value)"
            />
          </div>

          <!-- 校样核对 -->
          <div class="pa-field">
            <label class="pa-label">
              校样核对
              <span v-if="s.proofChecked" class="pa-done">已完成</span>
            </label>
            <!-- 清单是**给人对着核**的，不是勾选框 —— 逐条勾选会把"看过清单"变成"核过了"。
                 这里只把该核什么列出来，完成与否由用户自己对这份校样负责。 -->
            <ul class="pa-checklist">
              <li v-for="(c, i) in proofList" :key="i">{{ c }}</li>
            </ul>
            <p class="pa-hint">
              ⚠ 校样阶段**只能改排版与事实错误**，内容改动要重走流程 —— 别趁机大改。
            </p>
            <textarea
              class="pa-ta" :value="s.proofNotes" rows="2"
              placeholder="核出了什么（如「基金编号少了一位，已改」）"
              :data-control="`workflow:pa-proof-notes-${s.id}`"
              @change="setSub(s.id, 'proofNotes', ($event.target as HTMLTextAreaElement).value)"
            ></textarea>
            <button
              v-if="!s.proofChecked" class="pa-btn" data-control="workflow:pa-proof-done"
              @click="markProofed(s)"
            >标记核对完成</button>
          </div>
        </article>
      </section>

      <!-- ② 成果转化 -->
      <section class="pa-sec">
        <div class="pa-head2">
          <h3 class="pa-h3">成果转化</h3>
          <button class="pa-btn pa-btn-sm" data-control="workflow:pa-add-trans" @click="addTrans">＋ 记一条</button>
        </div>
        <p v-if="!trans.length" class="pa-hint">论文发表之后被引、被转载、被采纳 —— 记在这里。</p>
        <div v-for="(f, i) in trans" :key="f.id ?? i" class="pa-row">
          <input class="pa-in pa-in-wide" :value="f.title" placeholder="如：被《中国社会科学文摘》转载"
            :data-control="`workflow:pa-trans-title-${i}`" @change="setFu('translation', i, 'title', ($event.target as HTMLInputElement).value)" />
          <input class="pa-in" type="date" :value="f.happenedOn"
            :data-control="`workflow:pa-trans-date-${i}`" @change="setFu('translation', i, 'happenedOn', ($event.target as HTMLInputElement).value)" />
          <input class="pa-in pa-in-wide" :value="f.detail" placeholder="详情（期号/采纳单位…）"
            :data-control="`workflow:pa-trans-detail-${i}`" @change="setFu('translation', i, 'detail', ($event.target as HTMLInputElement).value)" />
          <button class="pa-del" :data-control="`workflow:pa-trans-del-${i}`" @click="delFu('translation', i)">×</button>
        </div>
      </section>

      <!-- ③ 后续研究方向 -->
      <section class="pa-sec">
        <div class="pa-head2">
          <h3 class="pa-h3">后续研究方向</h3>
          <button class="pa-btn pa-btn-sm" data-control="workflow:pa-add-dir" @click="addDir">＋ 记一条</button>
        </div>
        <p v-if="!dirs.length" class="pa-hint">这篇留下的尾巴：样本还能扩、识别策略还能换、新冒出来的问题 —— 记下来，下次开题用得上。</p>
        <div v-for="(f, i) in dirs" :key="f.id ?? i" class="pa-row">
          <input class="pa-in pa-in-wide" :value="f.title" placeholder="如：把样本扩到县域层面"
            :data-control="`workflow:pa-dir-title-${i}`" @change="setFu('direction', i, 'title', ($event.target as HTMLInputElement).value)" />
          <input class="pa-in pa-in-wide" :value="f.detail" placeholder="为什么值得做 / 怎么做"
            :data-control="`workflow:pa-dir-detail-${i}`" @change="setFu('direction', i, 'detail', ($event.target as HTMLInputElement).value)" />
          <button class="pa-del" :data-control="`workflow:pa-dir-del-${i}`" @click="delFu('direction', i)">×</button>
        </div>
      </section>

      <p class="pa-hint pa-foot">
        可复现材料（数据 / 脚本 / 结果）在「统稿定稿」页的<b>整包导出</b>里 —— 导出包里会有
        <code>复现材料/</code> 一节，含原始数据与回归脚本。
      </p>
    </template>
  </div>
</template>

<style scoped>
.pa { border: 1px solid var(--wf-line); border-radius: var(--wf-r); background: var(--wf-surface); padding: 14px 16px; }
.pa-head { display: flex; align-items: baseline; gap: 10px; }
.pa-head2 { display: flex; align-items: center; gap: 8px; }
.pa-h2 { margin: 0; font-size: 15px; font-weight: 600; color: var(--wf-text); }
.pa-h3 { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--wf-text); }
.pa-muted { font-size: 12px; color: var(--wf-muted); }
.pa-hint { font-size: 12px; color: var(--wf-faint); margin: 4px 0 6px; line-height: 1.65; }
.pa-sec { border-top: 1px dashed var(--wf-line-soft); padding-top: 12px; margin-top: 12px; }
.pa-card { border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm, 6px); padding: 10px 12px; margin-top: 8px; background: var(--wf-bg); }
.pa-card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; font-size: 13px; color: var(--wf-text); }
.pa-inline { margin-left: auto; font-size: 12px; color: var(--wf-muted); display: flex; align-items: center; gap: 6px; }
.pa-field { margin-top: 8px; }
.pa-label { display: block; font-size: 12px; color: var(--wf-muted); margin-bottom: 3px; }
.pa-done { font-size: 11px; color: #6FBF8B; border: 1px solid #6FBF8B; border-radius: var(--wf-r-pill); padding: 0 6px; margin-left: 6px; }
.pa-in {
  background: var(--wf-bg); color: var(--wf-text); border: 1px solid var(--wf-line);
  border-radius: var(--wf-r-sm, 6px); padding: 4px 8px; font-size: 12.5px; font-family: inherit;
}
.pa-in-wide { width: 100%; box-sizing: border-box; }
.pa-checklist { margin: 4px 0 4px; padding-left: 18px; font-size: 12px; color: var(--wf-muted); line-height: 1.7; }
.pa-ta {
  width: 100%; box-sizing: border-box; background: var(--wf-bg); color: var(--wf-text);
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm, 6px);
  padding: 6px 8px; font-size: 12.5px; font-family: inherit; resize: vertical; margin-bottom: 6px;
}
.pa-btn {
  font-size: 12.5px; padding: 4px 12px; cursor: pointer; border-radius: var(--wf-r-pill);
  border: 1px solid var(--wf-line); background: var(--wf-bg); color: var(--wf-text);
}
.pa-btn-sm { font-size: 11.5px; padding: 2px 10px; margin-left: auto; }
.pa-row { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
.pa-row .pa-in { flex: 1 1 140px; min-width: 0; }
.pa-del { background: none; border: none; color: var(--wf-faint); cursor: pointer; font-size: 15px; line-height: 1; padding: 0 4px; }
.pa-del:hover { color: #E0714F; }
.pa-foot { margin-top: 14px; border-top: 1px dashed var(--wf-line-soft); padding-top: 10px; }
.pa-foot code { background: var(--wf-bg); padding: 1px 4px; border-radius: 3px; }
</style>
