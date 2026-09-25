<script setup lang="ts">
/**
 * FindingsView —— 研究台账(假设检验 + 发现)
 *
 * 由来(2026-09-25): 真实科研里有一条**从假设到结论再到正文**的线:
 *   提出 H1 → 用数据检验 → 记下"支持/否定"与依据(哪个回归的哪个系数) → 写进正文。
 *   写作舱此前只有这条线的**头**: 框架设计阶段 LLM 生成一批 H1..Hn 文本, 塞在 analysis
 *   节点的 jsonb 里。既不能改结论(没有那个字段), 也没有"用数据检验"这一步,
 *   更不会回到正文 —— 假设生成完就烂在 JSON 里。
 *
 * 本页把缺的两段补上, 分成两块:
 *   ① 假设检验台账 —— H1..Hn + 结论 + 依据。**结论与依据是人填的**, 系统不替你下判断;
 *      但「根据某次分析自动填依据」那个按钮会去读真实系数, 省掉手抄。
 *   ② 发现台账   —— 由**系统从分析结果里抽取**(按表头精确匹配, 不让 LLM 读数字),
 *      每行都能回到"哪次分析的哪个系数"。人只负责采纳/忽略 + 写那句话。
 *
 * ⚠ 一条刻意的设计: 发现**不能手填**。表里没有"新建发现"按钮 —— 因为没有溯源列的
 *   "发现"就是编的, 而编出来的数字一旦进了正文, 整篇论文的可信度就没了。
 *   手写的结论请放假设台账的「依据」栏(那里是研究者自己的话, 性质不同)。
 */
import { computed, onMounted, ref, watch } from "vue";
import { q } from "@/shared/api";

interface Hyp {
  id: string; code: string; text: string; verdict: string; evidenceRef: string; rationale: string;
}
interface Finding {
  id: string; jobId: string; tool: string; varName: string; coef: number | null; stdErr: number | null;
  tValue: number | null; pValue: number | null; ciLow: number | null; ciHigh: number | null;
  stars: string; nObs: number | null; rSquared: number | null; claim: string; status: string;
}
interface Analysis { id: string; tool: string; status: string; createdAt: string; hasTable: boolean }

const props = defineProps<{ projectId: string }>();

const tab = ref<"hyp" | "find">("hyp");
const loading = ref(true);
const err = ref("");

const hyps = ref<Hyp[]>([]);
const findings = ref<Finding[]>([]);
const analyses = ref<Analysis[]>([]);

const VERDICTS = [
  { id: "pending", label: "待检验" },
  { id: "supported", label: "支持" },
  { id: "partially_supported", label: "部分支持" },
  { id: "rejected", label: "否定" },
];
const VERDICT_CN: Record<string, string> = {
  pending: "待检验", supported: "支持", partially_supported: "部分支持", rejected: "否定",
};
const TOOL_CN: Record<string, string> = {
  ols: "OLS 回归", logistic: "Logistic 回归", "logistic-regression": "Logistic 回归",
  descriptive: "描述统计", correlation: "相关分析", crosstab: "交叉表",
  anova: "方差分析", "multivariate-anova": "多因素 ANOVA", ttest: "t 检验",
  mediation: "中介效应", reliability: "信度分析", factor: "因子分析",
};

const pendingCount = computed(() => hyps.value.filter((h) => h.verdict === "pending").length);
const candidateCount = computed(() => findings.value.filter((f) => f.status === "candidate").length);

async function load() {
  if (!props.projectId) { loading.value = false; return; }
  loading.value = true;
  err.value = "";
  try {
    const [h, f, a] = await Promise.all([
      q<{ hypotheses?: Hyp[] }>(`/research/projects/${props.projectId}/hypotheses`),
      q<{ findings?: Finding[] }>(`/research/projects/${props.projectId}/findings`),
      q<{ analyses?: Analysis[] }>(`/research/projects/${props.projectId}/analyses`),
    ]);
    hyps.value = h.hypotheses ?? [];
    findings.value = f.findings ?? [];
    analyses.value = a.analyses ?? [];
    void loadLinks();
  } catch (e) {
    err.value = String((e as Error).message ?? e).slice(0, 160);
  } finally {
    loading.value = false;
  }
}

// ── ① 假设台账 ──
async function saveHyps() {
  try {
    const r = await q<{ hypotheses?: Hyp[] }>(`/research/projects/${props.projectId}/hypotheses`, {
      method: "PUT",
      body: {
        hypotheses: hyps.value.map((h) => ({
          id: h.id, code: h.code, text: h.text, verdict: h.verdict,
          evidenceRef: h.evidenceRef, rationale: h.rationale,
        })),
      },
    });
    if (Array.isArray(r.hypotheses)) hyps.value = r.hypotheses;
    toastMsg.value = "台账已保存";
  } catch (e) {
    toastMsg.value = `保存失败：${(e as Error).message}`;
  }
}

async function syncFromDesign() {
  try {
    const r = await q<{ added?: number; total?: number }>(
      `/research/projects/${props.projectId}/hypotheses/sync`, { method: "POST" });
    await load();
    toastMsg.value = `已从框架设计导入 ${r.added ?? 0} 条假设(共 ${r.total ?? 0} 条)`;
  } catch (e) {
    toastMsg.value = `导入失败：${(e as Error).message}`;
  }
}

function addHyp() {
  hyps.value = [...hyps.value, {
    id: "", code: `H${hyps.value.length + 1}`, text: "", verdict: "pending", evidenceRef: "", rationale: "",
  }];
}

function removeHyp(i: number) {
  hyps.value = hyps.value.filter((_, j) => j !== i);
}

/**
 * 用某次分析的结果**填充**某条假设的"依据"。
 *
 * 刻意只"填文字"而不"下结论": 哪个系数对应哪条假设, 只有研究者知道
 * (一个回归里有十来个系数)。系统把真实的系数量摆出来让他挑, 但不下判断。
 */
function fillEvidence(h: Hyp) {
  const rows = findings.value.filter((f) => f.status !== "dismissed");
  if (!rows.length) { toastMsg.value = "还没有已采集的发现 —— 先去「文献与资料」页从某次分析里采集"; return; }
  const list = rows
    .map((f) => `· ${TOOL_CN[f.tool] ?? f.tool} · ${f.varName}: 系数 ${f.coef}${f.stars}`
      + (f.pValue !== null ? `, p=${f.pValue}` : "") + (f.nObs !== null ? `, N=${f.nObs}` : ""))
    .join("\n");
  h.evidenceRef = `（从下列已采集的发现中选一条写进来）\n${list}`;
}

// ── ② 发现台账 ──
async function harvest(a: Analysis) {
  harvestingId.value = a.id;
  try {
    const r = await q<{ saved?: number; skipped?: string[] }>(
      `/research/projects/${props.projectId}/findings/harvest`,
      { method: "POST", body: { jobId: a.id } });
    await load();
    toastMsg.value = `从「${TOOL_CN[a.tool] ?? a.tool}」采集到 ${r.saved ?? 0} 条发现`
      + (r.skipped?.length ? `；${r.skipped.length} 行未采集：${r.skipped[0]}` : "");
  } catch (e) {
    toastMsg.value = `采集失败：${(e as Error).message}`;
  } finally {
    harvestingId.value = "";
  }
}

async function setStatus(f: Finding, status: string) {
  try {
    await q(`/research/projects/${props.projectId}/findings/${f.id}`, { method: "PATCH", body: { status } });
    f.status = status;
  } catch (e) {
    toastMsg.value = `更新失败：${(e as Error).message}`;
  }
}

async function saveClaim(f: Finding) {
  try {
    await q(`/research/projects/${props.projectId}/findings/${f.id}`, { method: "PATCH", body: { claim: f.claim } });
    toastMsg.value = "结论句已保存";
  } catch (e) {
    toastMsg.value = `保存失败：${(e as Error).message}`;
  }
}

async function genClaims() {
  claiming.value = true;
  try {
    const r = await q<{ updated?: number }>(`/research/projects/${props.projectId}/findings/claim`, {
      method: "POST", body: { topic: "" },
    });
    await load();
    toastMsg.value = `AI 已为 ${r.updated ?? 0} 条发现写结论句（数字部分不会改，仍会被正文核验比对）`;
  } catch (e) {
    toastMsg.value = `生成失败：${(e as Error).message}`;
  } finally {
    claiming.value = false;
  }
}

const harvestingId = ref("");
const claiming = ref(false);
const toastMsg = ref("");
/** 假设 → 相关发现的匹配建议(系统给的线索, 不自动填) */
const links = ref<Record<string, { findingIds: string[]; reason: string }>>({});

async function loadLinks() {
  try {
    const r = await q<{ links?: Array<{ hypothesisId: string; code: string; findingIds: string[]; reason: string }> }>(
      `/research/projects/${props.projectId}/hypothesis-links`);
    const m: Record<string, { findingIds: string[]; reason: string }> = {};
    for (const l of r.links ?? []) m[l.hypothesisId] = { findingIds: l.findingIds, reason: l.reason };
    links.value = m;
  } catch { links.value = {}; }
}

/** 把建议里的发现写成这条假设的"检验依据"(仍要人点, 不自动改) */
function applyLink(h: Hyp) {
  const l = links.value[h.id];
  if (!l) return;
  const rows = l.findingIds
    .map((id) => findings.value.find((f) => f.id === id))
    .filter((f): f is Finding => !!f)
    .map((f) => `· ${TOOL_CN[f.tool] ?? f.tool} · ${f.varName}: 系数 ${f.coef}${f.stars}`
      + (f.pValue !== null ? `, p=${f.pValue}` : "") + (f.nObs !== null ? `, N=${f.nObs}` : ""));
  if (!rows.length) return;
  h.evidenceRef = `${l.reason}。候选：\n${rows.join("\n")}\n（请留下真正对应的那一条，并据此填写结论）`;
}

function starsText(f: Finding): string {
  return f.stars || (f.pValue === null ? "" : "不显著");
}

onMounted(load);
watch(() => props.projectId, () => { void load(); });
</script>

<template>
  <div class="fv">
    <div class="fv-tabs">
      <button class="fv-tab" :class="{ on: tab === 'hyp' }" data-control="workflow:ledger-tab-hyp" @click="tab = 'hyp'">
        假设检验台账<span v-if="pendingCount" class="fv-badge">{{ pendingCount }} 待检验</span>
      </button>
      <button class="fv-tab" :class="{ on: tab === 'find' }" data-control="workflow:ledger-tab-find" @click="tab = 'find'">
        发现台账<span v-if="candidateCount" class="fv-badge">{{ candidateCount }} 待采纳</span>
      </button>
    </div>

    <p v-if="err" class="fv-err">{{ err }}</p>
    <p v-else-if="loading" class="fv-note">读取中…</p>

    <!-- ═══ ① 假设检验台账 ═══ -->
    <template v-else-if="tab === 'hyp'">
      <p class="fv-hint">
        真实科研里假设要有**检验结论**才算走完。这里的结论与依据由你填 —— 系统只负责记录。
        「填依据」按钮会把已采集的真实系数列出来供你选，省掉手抄。
      </p>
      <div class="fv-actions">
        <button class="fv-btn" data-control="workflow:hyp-sync" @click="syncFromDesign">从框架设计导入假设</button>
        <button class="fv-btn" data-control="workflow:hyp-add" @click="addHyp">＋ 手填一条</button>
        <button class="fv-btn primary" data-control="workflow:hyp-save" @click="saveHyps">保存台账</button>
      </div>

      <p v-if="!hyps.length" class="fv-note">
        还没有假设。到「框架设计」跑一次框架分析会自动生成, 或点上面的「＋ 手填一条」。
      </p>

      <div v-for="(h, i) in hyps" :key="h.id || `new-${i}`" class="fv-hyp">
        <div class="fv-hyp-head">
          <input v-model="h.code" class="fv-code" :data-control="`workflow:hyp-code-${i}`" placeholder="H1" />
          <input v-model="h.text" class="fv-text" :data-control="`workflow:hyp-text-${i}`" placeholder="假设表述（如：教育年限正向影响收入）" />
          <button class="fv-x" :data-control="`workflow:hyp-del-${i}`" @click="removeHyp(i)">×</button>
        </div>
        <div class="fv-verdicts">
          <button
            v-for="v in VERDICTS" :key="v.id"
            class="fv-v" :class="{ on: h.verdict === v.id, [`v-${v.id}`]: true }"
            :data-control="`workflow:hyp-verdict-${i}-${v.id}`"
            @click="h.verdict = v.id"
          >{{ v.label }}</button>
          <span v-if="h.verdict === 'pending'" class="fv-warn">未检验的假设写进正文会变成"预期"，不是"发现"</span>
        </div>
        <div class="fv-field">
          <label>检验依据</label>
          <textarea v-model="h.evidenceRef" rows="2" :data-control="`workflow:hyp-evidence-${i}`"
                    placeholder="哪个回归的哪个系数（如：模型2 中 edu 系数 0.312, p<0.01）"></textarea>
          <div class="fv-fill-actions">
            <button class="fv-btn tiny" :data-control="`workflow:hyp-fill-${i}`" @click="fillEvidence(h)">列出全部发现</button>
            <!-- 系统的匹配建议: 只把"看起来相关的那几条"摆出来, 仍要人点一下才写进去 -->
            <button v-if="links[h.id]" class="fv-btn tiny on" :data-control="`workflow:hyp-link-${i}`" @click="applyLink(h)">
              用建议的 {{ links[h.id].findingIds.length }} 条
            </button>
            <span v-if="links[h.id]" class="fv-warn faint">{{ links[h.id].reason }}（需你确认）</span>
          </div>
        </div>
        <div class="fv-field">
          <label>说明（可选）</label>
          <input v-model="h.rationale" :data-control="`workflow:hyp-rationale-${i}`" placeholder="与理论预期不符时的解释、稳健性情况等" />
        </div>
      </div>
    </template>

    <!-- ═══ ② 发现台账 ═══ -->
    <template v-else>
      <p class="fv-hint">
        发现由**系统从分析结果里抽取**（按表头精确匹配，不让模型读数字），每一条都能回到哪次分析的哪个系数。
        采纳后, 就能在「本章依据」里把它配给某一章。
      </p>

      <div v-if="analyses.length" class="fv-harvest">
        <span class="fv-harvest-label">从分析结果采集：</span>
        <button
          v-for="a in analyses" :key="a.id"
          class="fv-btn tiny" :disabled="harvestingId === a.id || a.status !== 'completed'"
          :data-control="`workflow:ledger-harvest-${a.id}`"
          @click="harvest(a)"
        >{{ TOOL_CN[a.tool] ?? a.tool }}{{ harvestingId === a.id ? " 采集中…" : "" }}</button>
      </div>
      <p v-else class="fv-note">本课题还没有跑过分析 —— 到「数据分析」页跑一次回归再来采集。</p>

      <div v-if="findings.length" class="fv-actions">
        <button class="fv-btn" :disabled="claiming" data-control="workflow:find-claim" @click="genClaims">
          {{ claiming ? "生成中…" : "AI 为已采集的发现写结论句" }}
        </button>
      </div>
      <p v-if="findings.length" class="fv-tiny">
        AI 只负责措辞：数字写在提示词里不许改，写完之后正文里的数字仍会被逐条核验比对。
      </p>

      <p v-if="!findings.length" class="fv-note">台账还是空的。用上面的按钮从某次分析里采集。</p>

      <div v-for="f in findings" :key="f.id" class="fv-find" :class="{ adopted: f.status === 'adopted', dismissed: f.status === 'dismissed' }">
        <div class="fv-find-head">
          <span class="fv-tool">{{ TOOL_CN[f.tool] ?? f.tool }}</span>
          <span class="fv-var">{{ f.varName }}</span>
          <span class="fv-coef">{{ f.coef }}<em>{{ f.stars }}</em></span>
          <span class="fv-stat">
            <template v-if="f.stdErr !== null">SE {{ f.stdErr }}</template>
            <template v-if="f.tValue !== null"> · t={{ f.tValue }}</template>
            <template v-if="f.pValue !== null"> · p={{ f.pValue }}</template>
            <template v-if="f.ciLow !== null && f.ciHigh !== null"> · 95%CI [{{ f.ciLow }}, {{ f.ciHigh }}]</template>
            <template v-if="f.nObs !== null"> · N={{ f.nObs }}</template>
            <template v-if="f.rSquared !== null"> · R²={{ f.rSquared }}</template>
          </span>
          <span class="fv-status">{{ starsText(f) }}</span>
        </div>
        <div class="fv-field">
          <label>结论句</label>
          <input v-model="f.claim" :data-control="`workflow:find-claim-${f.id}`" placeholder="如：教育年限与收入呈显著正相关（系数 0.312，1% 水平显著）"
                 @blur="saveClaim(f)" />
        </div>
        <div class="fv-find-actions">
          <button class="fv-btn tiny" :class="{ on: f.status === 'adopted' }"
                  :data-control="`workflow:find-adopt-${f.id}`" @click="setStatus(f, f.status === 'adopted' ? 'candidate' : 'adopted')">
            {{ f.status === "adopted" ? "已采纳" : "采纳" }}
          </button>
          <button class="fv-btn tiny" :class="{ on: f.status === 'dismissed' }"
                  :data-control="`workflow:find-dismiss-${f.id}`" @click="setStatus(f, f.status === 'dismissed' ? 'candidate' : 'dismissed')">
            {{ f.status === "dismissed" ? "已忽略" : "忽略" }}
          </button>
        </div>
      </div>
    </template>

    <p v-if="toastMsg" class="fv-toast">{{ toastMsg }}</p>
  </div>
</template>

<style scoped>
.fv { display: flex; flex-direction: column; gap: 10px; }
.fv-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--wf-line-soft); padding-bottom: 7px; }
.fv-tab {
  cursor: pointer; border: 1px solid transparent; border-radius: var(--wf-r-sm);
  background: transparent; color: var(--wf-muted); font-size: var(--wf-f-sm);
  padding: 4px 10px; display: flex; align-items: center; gap: 6px;
}
.fv-tab.on { border-color: var(--wf-line-strong); color: var(--wf-text); background: var(--wf-surface-2); }
.fv-badge {
  font-size: 10px; padding: 0 6px; border-radius: var(--wf-r-pill);
  background: var(--wf-accent-soft); color: var(--wf-accent-hi);
}
.fv-hint { margin: 0; font-size: var(--wf-f-xs); color: var(--wf-muted); line-height: 1.75; }
.fv-note { margin: 2px 0; font-size: var(--wf-f-xs); color: var(--wf-faint); line-height: 1.7; }
.fv-tiny { margin: 0; font-size: 11px; color: var(--wf-faint); line-height: 1.6; }
.fv-err { margin: 2px 0; font-size: var(--wf-f-xs); color: var(--wf-warn); }
.fv-toast { margin: 4px 0 0; font-size: var(--wf-f-xs); color: var(--wf-accent-hi); line-height: 1.6; }
.fv-actions { display: flex; gap: 7px; flex-wrap: wrap; }
.fv-btn {
  cursor: pointer; border-radius: var(--wf-r-sm); padding: 4px 11px; font-size: var(--wf-f-xs);
  border: 1px solid var(--wf-line-strong); background: transparent; color: var(--wf-muted);
}
.fv-btn:hover { color: var(--wf-text); }
.fv-btn.primary { border-color: var(--wf-accent); color: var(--wf-accent-hi); background: var(--wf-accent-soft); }
.fv-btn.tiny { padding: 2px 8px; font-size: 11px; }
.fv-btn.on { border-color: var(--wf-accent); color: var(--wf-accent-hi); background: var(--wf-accent-soft); }
.fv-btn:disabled { opacity: 0.45; cursor: default; }
.fv-hyp, .fv-find {
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-surface-2); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
}
.fv-find.adopted { border-color: var(--wf-accent); }
.fv-find.dismissed { opacity: 0.5; }
.fv-hyp-head { display: grid; grid-template-columns: 64px 1fr auto; gap: 6px; align-items: center; }
.fv-code, .fv-text, .fv-field input, .fv-field textarea {
  width: 100%; background: var(--wf-surface); border: 1px solid var(--wf-line);
  border-radius: var(--wf-r-sm); padding: 4px 8px; font-size: var(--wf-f-xs);
  color: var(--wf-text); line-height: 1.6; font-family: inherit;
}
.fv-field input::placeholder, .fv-field textarea::placeholder, .fv-text::placeholder { color: var(--wf-faint); }
.fv-field textarea { resize: vertical; }
.fv-x {
  cursor: pointer; border: 0; background: transparent; color: var(--wf-faint);
  font-size: 15px; line-height: 1; padding: 2px 4px;
}
.fv-x:hover { color: var(--wf-warn); }
.fv-verdicts { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.fv-v {
  cursor: pointer; border: 1px solid var(--wf-line-strong); border-radius: var(--wf-r-pill);
  background: transparent; color: var(--wf-muted); font-size: 11px; padding: 2px 9px;
}
.fv-v.on { color: var(--wf-accent-hi); border-color: var(--wf-accent); background: var(--wf-accent-soft); }
.fv-v.v-rejected.on { color: var(--wf-warn); border-color: var(--wf-warn); background: transparent; }
.fv-warn { font-size: 11px; color: var(--wf-warn); }
.fv-field { display: grid; grid-template-columns: 66px 1fr auto; gap: 6px; align-items: start; }
.fv-field label { font-size: var(--wf-f-xs); color: var(--wf-muted); padding-top: 5px; }
.fv-fill-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; grid-column: 2 / -1; }
.fv-warn.faint { color: var(--wf-faint); }
.fv-harvest { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.fv-harvest-label { font-size: var(--wf-f-xs); color: var(--wf-muted); }
.fv-find-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.fv-tool { font-size: var(--wf-f-xs); color: var(--wf-muted); }
.fv-var { font-size: var(--wf-f-sm); color: var(--wf-text); }
.fv-coef { font-size: var(--wf-f-sm); color: var(--wf-accent-hi); }
.fv-coef em { font-style: normal; }
.fv-stat { font-size: 11px; color: var(--wf-faint); }
.fv-status { font-size: 11px; color: var(--wf-muted); margin-left: auto; }
.fv-find-actions { display: flex; gap: 6px; }
</style>
