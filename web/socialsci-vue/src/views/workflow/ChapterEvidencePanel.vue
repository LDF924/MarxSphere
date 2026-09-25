<script setup lang="ts">
/**
 * ChapterEvidencePanel —— 本章依据(每章选它依据哪些研究材料)
 *
 * 由来(2026-09-25): 在此之前**没有任何界面能把研究证据挂到某一章上**。
 *   素材页有"插入到章节"(写完之后贴进去), 但那是**先成文、再补证据**, 顺序是反的:
 *   真实科研是先定这一章依据什么数据、什么回归、哪几条假设, 再写。
 *   实测更直接的证据: 后端那条 `【可用素材】` 注入是死代码(见 research-evidence-service 文件头),
 *   且章节生成的 prompt 里**根本没有"依据"这个位置** —— 谁来都塞不进去。
 *
 * 本面板做三件事:
 *   ① 把可选的依据摆出来(素材 / 分析结果 / 假设 / 发现), 按章勾选;
 *   ② 每条可写一句"本章用它做什么" —— 同一个回归在方法章是"交代识别策略",
 *      在结果章是"报告系数", 不给这句, 模型只能猜;
 *   ③ 显示**组装后的证据块预览** —— 生成时到底给模型看了什么, 不做黑箱。
 *
 * ⚠ "分析结果"那一类的来源要说清楚: 统计结果按 user_id 存在 stats_jobs,
 *   与写作舱的 research_projects **没有外键**, 唯一的连接点是本课题第 3 步上传的
 *   那个数据文件(快照里的 statisticsFileId)。所以 fileId 为空时这一类必然是空的 ——
 *   界面要明说"先去上传数据文件", 而不是显示一个空列表让人以为没跑过分析。
 */
import { computed, onMounted, ref, watch } from "vue";
import { q } from "@/shared/api";
import { gotoWorkbenchModule, setEmpiricalTarget } from "@/shared/workflow-bridge";

interface Candidate {
  refId: string; kind: string; title?: string; materialKind?: string; hasTable?: boolean;
  code?: string; text?: string; verdict?: string; evidenceRef?: string;
  tool?: string; varName?: string; coef?: number | null; pValue?: number | null;
  stars?: string; claim?: string; status?: string; createdAt?: string;
}
interface Chosen { kind: string; refId: string; note: string }
interface EmpProject { id: string; title: string; topic: string; runsWithTables: number; unowned?: boolean }
interface EmpRun { id: string; stage: string; nTables: number; tableTitles: string[] }

const props = defineProps<{
  projectId: string;
  sectionId: string;
  sectionTitle: string;
  /** 课题的数据文件 id(快照 statisticsFileId) —— 分析结果那一类靠它才捞得到 */
  statisticsFileId?: string;
}>();

const loading = ref(true);
const loadError = ref("");
const saving = ref(false);
const saveError = ref("");
const savedAt = ref("");
const preview = ref("");
const previewOpen = ref(false);

/** 实证台绑定(见后端 bindEmpiricalProject 的注释: 实证台数据是实例级的, 界面必须如实说) */
const empOpen = ref(false);
const empBinding = ref<{ empiricalProjectId: string; empiricalTitle: string }>({ empiricalProjectId: "", empiricalTitle: "" });
const empProjects = ref<EmpProject[]>([]);
const empRuns = ref<EmpRun[]>([]);
const empBusy = ref("");
const empMsg = ref("");

/**
 * 去实证台 —— 带上当前绑定的课题, 免得过去了还要在下拉里再找一遍。
 *
 * ⚠ 先写交接再跳: 实证台读的是 localStorage, 顺序反了它会读不到。
 *   路由带 `?projectId=` 是**描述性**的(方便外链/刷新时人眼可读), 真正的传递走 localStorage
 *   —— 因为外壳的视图切换未必保留 query。
 */
function gotoEmpirical() {
  const id = empBinding.value.empiricalProjectId;
  if (id) setEmpiricalTarget(id);
  const ok = gotoWorkbenchModule("empirical-research", {
    label: "研途写作舱 · 本章依据",
    path: "/workflow/workspace",
  });
  if (!ok) empMsg.value = "当前不在外壳里（独立打开的子应用），无法跳转";
}

async function loadEmpirical() {
  try {
    const [b, ps] = await Promise.all([
      q<{ empiricalProjectId?: string; empiricalTitle?: string }>(`/research/projects/${props.projectId}/empirical-binding`),
      q<{ projects?: EmpProject[] }>(`/research/empirical-projects`),
    ]);
    empBinding.value = { empiricalProjectId: String(b.empiricalProjectId ?? ""), empiricalTitle: String(b.empiricalTitle ?? "") };
    empProjects.value = ps.projects ?? [];
    if (empBinding.value.empiricalProjectId) await loadEmpRuns();
  } catch { /* 老后端没有这几个端点时静默降级(整块不显示) */ }
}

async function loadEmpRuns() {
  try {
    const r = await q<{ empiricalTitle?: string; runs?: EmpRun[] }>(`/research/projects/${props.projectId}/empirical-runs`);
    empRuns.value = r.runs ?? [];
  } catch { empRuns.value = []; }
}

async function bindEmpirical(id: string) {
  empBusy.value = "bind";
  empMsg.value = "";
  try {
    const r = await q<{ empiricalTitle?: string }>(`/research/projects/${props.projectId}/empirical-binding`, {
      method: "PUT", body: { empiricalProjectId: id || null },
    });
    empBinding.value = { empiricalProjectId: id, empiricalTitle: String(r.empiricalTitle ?? "") };
    if (id) await loadEmpRuns(); else empRuns.value = [];
    empMsg.value = id ? `已绑定「${r.empiricalTitle ?? ""}」` : "已解除绑定";
  } catch (e) {
    empMsg.value = `绑定失败：${(e as Error).message}`;
  } finally {
    empBusy.value = "";
  }
}

/** 从一次实证运行采集发现 —— 采完它会出现在上面「发现」那一类里, 可以勾选 */
async function harvestEmpirical(run: EmpRun) {
  empBusy.value = run.id;
  empMsg.value = "";
  try {
    const r = await q<{ saved?: number; skipped?: string[] }>(
      `/research/projects/${props.projectId}/empirical-runs/${run.id}/harvest`, { method: "POST", body: {} });
    empMsg.value = `已从「${run.stage}」采集 ${r.saved ?? 0} 条发现`
      + (r.skipped?.length ? `；${r.skipped.length} 行未采集：${r.skipped[0]}` : "");
    await load();   // 重新拉候选 —— 新采集的发现要出现在上面的清单里
  } catch (e) {
    empMsg.value = `采集失败：${(e as Error).message}`;
  } finally {
    empBusy.value = "";
  }
}

const candidates = ref<{
  materials: Candidate[]; hypotheses: Candidate[]; findings: Candidate[];
  analyses: Candidate[]; statisticsFileId: string;
}>({ materials: [], hypotheses: [], findings: [], analyses: [], statisticsFileId: "" });

/** sectionId → 已选(该章)。一次拉全项目, 切章不再请求。 */
const chosenBySection = ref<Record<string, Chosen[]>>({});
const chosen = computed<Chosen[]>(() => chosenBySection.value[props.sectionId] ?? []);

const VERDICT_CN: Record<string, string> = {
  pending: "待检验", supported: "支持", partially_supported: "部分支持", rejected: "否定",
};
const KIND_CN: Record<string, string> = {
  note: "笔记", citation: "文献", data_result: "数据结果", figure: "图表",
  file: "文件", theory: "理论", table: "表格",
};

function isChosen(kind: string, refId: string): boolean {
  return chosen.value.some((c) => c.kind === kind && c.refId === refId);
}

/** 一条依据在界面上的主标题与副标题(四类的字段完全不同, 统一在这里映射) */
function labelOf(c: Candidate): { main: string; sub: string } {
  if (c.kind === "material") {
    return {
      main: String(c.title ?? "未命名素材"),
      sub: `${KIND_CN[String(c.materialKind)] ?? c.materialKind ?? "素材"}${c.hasTable ? " · 含表格" : ""}`,
    };
  }
  if (c.kind === "analysis") {
    return { main: `分析结果 · ${String(c.tool ?? "")}`, sub: c.createdAt ? new Date(String(c.createdAt)).toLocaleString() : "" };
  }
  if (c.kind === "hypothesis") {
    return { main: `${String(c.code ?? "")} ${String(c.text ?? "").slice(0, 60)}`, sub: VERDICT_CN[String(c.verdict)] ?? "" };
  }
  // finding
  const stars = String(c.stars ?? "");
  const coef = c.coef === null || c.coef === undefined ? "" : ` = ${c.coef}${stars}`;
  return {
    main: `${String(c.tool ?? "")} · ${String(c.varName ?? "")}${coef}`,
    sub: String(c.claim ?? "").slice(0, 70),
  };
}

function toggle(c: Candidate) {
  const list = [...chosen.value];
  const i = list.findIndex((x) => x.kind === c.kind && x.refId === c.refId);
  if (i >= 0) list.splice(i, 1);
  else list.push({ kind: c.kind, refId: c.refId, note: "" });
  chosenBySection.value = { ...chosenBySection.value, [props.sectionId]: list };
}

function setNote(kind: string, refId: string, note: string) {
  const list = chosen.value.map((x) => (x.kind === kind && x.refId === refId ? { ...x, note } : x));
  chosenBySection.value = { ...chosenBySection.value, [props.sectionId]: list };
}

async function load() {
  loading.value = true;
  loadError.value = "";
  try {
    const [ev, cand] = await Promise.all([
      q<{ bySection?: Record<string, Chosen[]> }>(`/research/projects/${props.projectId}/evidence`),
      q<typeof candidates.value>(
        `/research/projects/${props.projectId}/evidence-candidates${props.statisticsFileId ? `?fileId=${encodeURIComponent(props.statisticsFileId)}` : ""}`
      ),
    ]);
    chosenBySection.value = ev.bySection ?? {};
    candidates.value = {
      materials: cand.materials ?? [], hypotheses: cand.hypotheses ?? [],
      findings: cand.findings ?? [], analyses: cand.analyses ?? [],
      statisticsFileId: String(cand.statisticsFileId ?? ""),
    };
  } catch (e) {
    loadError.value = String((e as Error).message ?? e).slice(0, 160);
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  saveError.value = "";
  try {
    await q(`/research/projects/${props.projectId}/evidence/${encodeURIComponent(props.sectionId)}`, {
      method: "PUT",
      body: { refs: chosen.value },
    });
    savedAt.value = new Date().toLocaleTimeString();
  } catch (e) {
    saveError.value = String((e as Error).message ?? e).slice(0, 160);
  } finally {
    saving.value = false;
  }
}

async function showPreview() {
  previewOpen.value = true;
  preview.value = "读取中…";
  try {
    const r = await q<{ text?: string; used?: number; dropped?: number }>(
      `/research/projects/${props.projectId}/evidence/${encodeURIComponent(props.sectionId)}/preview`
    );
    preview.value = r.text
      ? `用到 ${r.used ?? 0} 条${r.dropped ? `, ${r.dropped} 条已失效被忽略` : ""}\n\n${r.text}`
      : "本章还没有依据 —— 生成时不会注入任何研究材料。";
  } catch (e) {
    preview.value = `读取失败: ${String((e as Error).message ?? e).slice(0, 120)}`;
  }
}

onMounted(() => { void load(); void loadEmpirical(); });
// 切章 / 切项目都要重拉(依据是按章存的, 缓存了会显示上一章的)
watch(() => [props.projectId, props.sectionId], () => { void load(); });
watch(() => props.projectId, () => { void loadEmpirical(); });
</script>

<template>
  <div class="cep">
    <p class="cep-hint">
      为<strong>本章</strong>选它依据的研究材料。生成正文时, 选中的内容会作为「本章依据」注入,
      其中的数字必须在正文里原样引用 —— 没有依据的地方模型会写「待补数据」而不是编一个。
    </p>

    <p v-if="loadError" class="cep-err">读取失败：{{ loadError }}</p>
    <p v-else-if="loading" class="cep-loading">读取中…</p>

    <template v-else>
      <!-- 素材 -->
      <details class="cep-sec" open>
        <summary>素材（{{ candidates.materials.length }}）</summary>
        <p v-if="!candidates.materials.length" class="cep-empty">这个课题还没有素材。在「文献与资料」页添加。</p>
        <ul v-else class="cep-list">
          <li v-for="c in candidates.materials" :key="c.refId">
            <label class="cep-row" :class="{ on: isChosen('material', c.refId) }">
              <input type="checkbox" :checked="isChosen('material', c.refId)"
                     :data-control="`workflow:evidence-material-${c.refId}`" @change="toggle(c)" />
              <span class="cep-main">{{ labelOf(c).main }}</span>
              <span class="cep-sub">{{ labelOf(c).sub }}</span>
            </label>
          </li>
        </ul>
      </details>

      <!-- 分析结果 -->
      <details class="cep-sec" open>
        <summary>分析结果（{{ candidates.analyses.length }}）</summary>
        <p v-if="!statisticsFileId" class="cep-empty">
          本课题还没有关联数据文件。到「文献与资料」页上传数据文件后, 这里会列出跑过的分析。
        </p>
        <p v-else-if="!candidates.analyses.length" class="cep-empty">
          这个数据文件还没有跑过分析。到「数据分析」页跑一次回归再来。
        </p>
        <ul v-else class="cep-list">
          <li v-for="c in candidates.analyses" :key="c.refId">
            <label class="cep-row" :class="{ on: isChosen('analysis', c.refId) }">
              <input type="checkbox" :checked="isChosen('analysis', c.refId)"
                     :data-control="`workflow:evidence-analysis-${c.refId}`" @change="toggle(c)" />
              <span class="cep-main">{{ labelOf(c).main }}</span>
              <span class="cep-sub">{{ labelOf(c).sub }}</span>
            </label>
          </li>
        </ul>
      </details>

      <!-- 假设 -->
      <details class="cep-sec">
        <summary>假设台账（{{ candidates.hypotheses.length }}）</summary>
        <p v-if="!candidates.hypotheses.length" class="cep-empty">
          还没有假设。到「框架设计」页跑一次框架分析, 或在「假设检验」台账里手填。
        </p>
        <ul v-else class="cep-list">
          <li v-for="c in candidates.hypotheses" :key="c.refId">
            <label class="cep-row" :class="{ on: isChosen('hypothesis', c.refId) }">
              <input type="checkbox" :checked="isChosen('hypothesis', c.refId)"
                     :data-control="`workflow:evidence-hypothesis-${c.refId}`" @change="toggle(c)" />
              <span class="cep-main">{{ labelOf(c).main }}</span>
              <span class="cep-sub">{{ labelOf(c).sub }}</span>
            </label>
          </li>
        </ul>
      </details>

      <!-- 发现(B) -->
      <details class="cep-sec">
        <summary>发现（{{ candidates.findings.length }}）</summary>
        <p v-if="!candidates.findings.length" class="cep-empty">
          还没有采集到发现。到「发现台账」页从某次分析里采集。
        </p>
        <ul v-else class="cep-list">
          <li v-for="c in candidates.findings" :key="c.refId">
            <label class="cep-row" :class="{ on: isChosen('finding', c.refId) }">
              <input type="checkbox" :checked="isChosen('finding', c.refId)"
                     :data-control="`workflow:evidence-finding-${c.refId}`" @change="toggle(c)" />
              <span class="cep-main">{{ labelOf(c).main }}</span>
              <span class="cep-sub">{{ labelOf(c).sub }}</span>
            </label>
          </li>
        </ul>
      </details>

      <!-- 实证台（因果推断结果）——
           放在最后一节: 它要用户先做一次"绑定"这个额外动作, 不该挡在前面。
           这一块的存在理由是**别的通道都够不着它**: 实证台的 DiD/IV/RDD/PSM 走
           /api/empirical/run, 结果落 empirical_pipeline_runs, **不写 stats_jobs** ——
           上面那条"分析结果"按数据文件连接的路子, 对实证台完全不成立。 -->
      <details class="cep-sec emp-sec">
        <summary>
          实证台（因果推断结果）
          <span v-if="empBinding.empiricalProjectId" class="emp-bound">已绑定：{{ empBinding.empiricalTitle }}</span>
        </summary>
        <p class="cep-hint">
          实证台的 DiD / IV / RDD / PSM / 合成控制等结果存在它自己的 id 空间里，与本课题不通。
          绑一个实证课题后，它的运行结果就能采集成本课题的「发现」。
        </p>
        <!-- ⚠ 这句话必须留着。实证台的数据是**实例级**的（empirical_projects 没有 user_id，
             它的路由也没有登录校验），不写清楚会让人以为"写作舱里看得见"= "这是我的私有数据"。 -->
        <p class="emp-warn">
          ⚠ 实证台的读取接口尚未全部强制归属校验 —— 标了「历史未归属」的是本功能之前建的课题，
          归属已无法确认，请只绑你自己知道的那些。
        </p>

        <div class="emp-row">
          <select
            class="emp-select" :value="empBinding.empiricalProjectId"
            :disabled="empBusy === 'bind'" data-control="workflow:emp-bind-select"
            @change="bindEmpirical(($event.target as HTMLSelectElement).value)"
          >
            <option value="">（不绑定）</option>
            <option v-for="p in empProjects" :key="p.id" :value="p.id">
              {{ p.unowned ? "⚠ " : "" }}{{ p.title }}（{{ p.runsWithTables }} 次有结果{{ p.unowned ? " · 历史未归属" : "" }}）
            </option>
          </select>
          <button
            v-if="empBinding.empiricalProjectId"
            class="cep-btn" :disabled="empBusy === 'bind'"
            data-control="workflow:emp-unbind" @click="bindEmpirical('')"
          >解除绑定</button>
          <!-- 反跳: 带着课题去实证台。没有它, 用户过去后还要在下拉里重新找刚绑的那个。 -->
          <button
            v-if="empBinding.empiricalProjectId"
            class="cep-btn primary"
            data-control="workflow:emp-goto" @click="gotoEmpirical"
          >去实证台 →</button>
        </div>

        <template v-if="empBinding.empiricalProjectId">
          <p v-if="!empRuns.length" class="cep-empty">
            这个实证课题还没有跑出表格结果。到「实证研究」页跑一次（如 DiD / IV），再回来。
          </p>
          <ul v-else class="cep-list">
            <li v-for="r in empRuns" :key="r.id" class="emp-run">
              <span class="cep-main">{{ r.stage }}</span>
              <span class="cep-sub">{{ r.nTables }} 张表{{ r.tableTitles.length ? ` · ${r.tableTitles.slice(0, 2).join(" / ")}` : "" }}</span>
              <button
                class="cep-btn tiny" :disabled="empBusy === r.id"
                :data-control="`workflow:emp-harvest-${r.id}`" @click="harvestEmpirical(r)"
              >{{ empBusy === r.id ? "采集中…" : "采集为发现" }}</button>
            </li>
          </ul>
        </template>
        <p v-if="empMsg" class="emp-msg">{{ empMsg }}</p>
      </details>

      <!-- 已选 + 用途说明 -->
      <section v-if="chosen.length" class="cep-picked">
        <h4>已选 {{ chosen.length }} 条</h4>
        <div v-for="c in chosen" :key="`${c.kind}:${c.refId}`" class="cep-picked-row">
          <span class="cep-tag">{{ { material: "素材", analysis: "分析", hypothesis: "假设", finding: "发现" }[c.kind] ?? c.kind }}</span>
          <input
            class="cep-note" :value="c.note" maxlength="200"
            :data-control="`workflow:evidence-note-${c.refId}`"
            placeholder="本章用它做什么？（如：报告 x 对 y 的回归系数）"
            @input="setNote(c.kind, c.refId, ($event.target as HTMLInputElement).value)"
          />
        </div>
      </section>

      <div class="cep-actions">
        <button class="cep-btn primary" :disabled="saving" :data-control="`workflow:evidence-save-${sectionId}`" @click="save">
          {{ saving ? "保存中…" : "保存本章依据" }}
        </button>
        <button class="cep-btn" :data-control="`workflow:evidence-preview-${sectionId}`" @click="showPreview">预览注入内容</button>
        <span v-if="savedAt" class="cep-saved">已保存 {{ savedAt }}</span>
        <span v-if="saveError" class="cep-err">{{ saveError }}</span>
      </div>

      <pre v-if="previewOpen" class="cep-preview">{{ preview }}</pre>
    </template>
  </div>
</template>

<style scoped>
.cep { display: flex; flex-direction: column; gap: 10px; }
.cep-hint { margin: 0; font-size: var(--wf-f-xs); color: var(--wf-muted); line-height: 1.75; }
.cep-hint strong { color: var(--wf-text-2); }
.cep-loading, .cep-empty { margin: 4px 0; font-size: var(--wf-f-xs); color: var(--wf-faint); line-height: 1.7; }
.cep-err { margin: 4px 0; font-size: var(--wf-f-xs); color: var(--wf-warn); line-height: 1.6; }
.cep-sec { border-top: 1px solid var(--wf-line-soft); padding-top: 7px; }
.cep-sec > summary { cursor: pointer; font-size: var(--wf-f-xs); color: var(--wf-text-2); }
.cep-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.cep-row {
  display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px;
  cursor: pointer; border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-surface-2); padding: 4px 9px;
}
.cep-row:hover { background: var(--wf-raised); }
.cep-row.on { border-color: var(--wf-accent); background: var(--wf-accent-soft); }
.cep-row input { flex-shrink: 0; }
.cep-main { font-size: var(--wf-f-xs); color: var(--wf-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cep-sub { font-size: var(--wf-f-xs); color: var(--wf-faint); white-space: nowrap; }
.cep-picked { border-top: 1px solid var(--wf-line-soft); padding-top: 7px; }
.cep-picked h4 { margin: 0 0 6px; font-size: var(--wf-f-xs); color: var(--wf-text-2); }
.cep-picked-row { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 7px; margin-bottom: 4px; }
.cep-tag {
  font-size: 10px; padding: 1px 7px; border-radius: var(--wf-r-pill);
  background: var(--wf-accent-soft); color: var(--wf-accent-hi); white-space: nowrap;
}
.cep-note {
  width: 100%; font-size: var(--wf-f-xs); color: var(--wf-text); line-height: 1.6;
  background: var(--wf-surface-2); border: 1px solid var(--wf-line);
  border-radius: var(--wf-r-sm); padding: 4px 8px;
}
.cep-note::placeholder { color: var(--wf-faint); }
.cep-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cep-btn {
  cursor: pointer; border-radius: var(--wf-r-sm); padding: 4px 12px; font-size: var(--wf-f-xs);
  border: 1px solid var(--wf-line-strong); background: transparent; color: var(--wf-muted);
}
.cep-btn:hover { color: var(--wf-text); }
.cep-btn.primary { border-color: var(--wf-accent); color: var(--wf-accent-hi); background: var(--wf-accent-soft); }
.cep-btn:disabled { opacity: 0.5; cursor: default; }
.cep-saved { font-size: var(--wf-f-xs); color: var(--wf-faint); }
.cep-preview {
  margin: 0; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  font-size: 11px; line-height: 1.7; color: var(--wf-text-2);
  background: var(--wf-surface-2); border: 1px solid var(--wf-line);
  border-radius: var(--wf-r-sm); padding: 8px 10px;
}
/* 实证台块 —— 单独给一条左边线, 因为它的数据边界与其它几类不同(实例级共享) */
.emp-sec { border-left: 2px solid var(--wf-warn); padding-left: 9px; }
.emp-bound { font-size: 11px; color: var(--wf-accent-hi); margin-left: 4px; }
.emp-warn { margin: 4px 0 6px; font-size: 11px; line-height: 1.65; color: var(--wf-warn); }
.emp-row { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
.emp-select {
  flex: 1; min-width: 0; background: var(--wf-surface-2); border: 1px solid var(--wf-line);
  border-radius: var(--wf-r-sm); padding: 4px 8px; font-size: var(--wf-f-xs); color: var(--wf-text);
}
.emp-run { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 8px; }
.emp-msg { margin: 6px 0 0; font-size: var(--wf-f-xs); color: var(--wf-accent-hi); line-height: 1.6; }
.cep-btn.tiny { padding: 2px 8px; font-size: 11px; }
</style>
