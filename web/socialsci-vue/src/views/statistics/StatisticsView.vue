<script setup lang="ts">
/**
 * StatisticsView — 还原自闭源 StatisticsView-C1S4N5xA.js(3329 行单组件, scope data-v-38a82752)
 * 三栏: 左方法面板(4 分类 17 法) / 中配置(上传+变量多选+动态参数+运行) / 右结果(三线表+plotly 图)
 * 状态机: 上传→选变量→校验→POST statistics-jobs→700ms 轮询+SSE 恢复→结果/错误中文化→localStorage 快照
 */
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { METHODS, methodById, groupedMethods, METHOD_CATEGORIES, normalizeVarType, varTypeMeta, isIdColumn, fmtCell, HEALTH_LABELS } from "./methodParams";
import type { MethodDef, VarDef } from "./methodParams";
import { uploadStatsFile, createStatsJob, getStatsJob, cancelStatsJob, retryStatsJob, listStatsJobs, streamStatsJob, translateStatsError } from "./statsApi";
import type { StatsJob, StatsJobResult } from "./statsApi";
import { toast } from "@/shared/ui";
import { K, uid } from "@/shared/constants";
import { ensureModuleTask } from "@/shared/tasks";

const props = defineProps<{ taskId?: string }>();

// ── 方法选择 ──
const currentTool = ref("descriptive");
const currentMethod = computed<MethodDef | null>(() => methodById(currentTool.value));
const grouped = groupedMethods();

// ── 数据文件 ──
const fileId = ref("");
const fileName = ref("");
const variables = ref<VarDef[]>([]);
const selectedVars = ref<Set<string>>(new Set());
const varSearch = ref("");
const loadingUpload = ref(false);
const uploadDragover = ref(false);
const uploadInputRef = ref<HTMLInputElement | null>(null);

// ── 任务/结果态 ──
const jobId = ref("");
const jobStatus = ref("");
const loadingRun = ref(false);
const result = ref<StatsJobResult | null>(null);
const resultVersionId = ref("");
const historyJobs = ref<StatsJob[]>([]);
const workspaceKey = ref(0);
let pollTimer: ReturnType<typeof setInterval> | null = null;
let sseCleanup: (() => void) | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
const healthState = ref("unknown"); // checking/connected/disconnected/unknown
const healthProbe = ref(0);

// ── 动态参数 ──
const toolParams = ref<Record<string, unknown>>({});
function resetParams() {
  const m = currentMethod.value;
  if (!m) return;
  toolParams.value = JSON.parse(JSON.stringify(m.defaults));
  // filter 方法的多行条件
  if (currentTool.value === "filter") {
    toolParams.value.conditions = [{ variable: "", operator: ">=", value: "" }];
    toolParams.value.logic = "and";
  }
  if (currentTool.value === "transform" && !Array.isArray(toolParams.value.transforms)) {
    toolParams.value.transforms = ["z-score"];
  }
}

// ── 派生: 需要左侧选变量的方法(闭源 Be() 排除表) ──
const NO_VAR_SELECT = new Set(["crosstab", "regression", "logistic-regression", "multivariate-anova", "mediation-moderation", "filter"]);
const needsVarSelect = computed(() => !NO_VAR_SELECT.has(currentTool.value));
const scaleOnlyMethods = new Set(["descriptive", "classify", "transform", "t-test", "anova", "correlation", "normality", "reliability", "efa"]);
const varFilterFor = computed(() => {
  const m = currentMethod.value;
  if (m?.varsFilter === "scale" || scaleOnlyMethods.has(currentTool.value)) return "scale";
  if (m?.varsFilter === "nominal") return "nominal";
  return "all";
});

const filteredVars = computed(() => {
  const kw = varSearch.value.trim().toLowerCase();
  const needScale = varFilterFor.value === "scale";
  const needNominal = varFilterFor.value === "nominal";
  return variables.value.filter((v) => {
    if (needScale && v.type !== "scale") return false;
    if (needNominal && v.type !== "nominal") return false;
    if (kw && !v.name.toLowerCase().includes(kw)) return false;
    return true;
  });
});

function toggleVar(name: string) {
  const m = currentMethod.value;
  const v = variables.value.find((x) => x.name === name);
  // anova 校验: 数值且非 ID
  if (m?.varsFilter === "scale" && v && v.type !== "scale") {
    toast("ANOVA 的分析变量必须是数值列", "warning");
    return;
  }
  if (selectedVars.value.has(name)) selectedVars.value.delete(name);
  else selectedVars.value.add(name);
  selectedVars.value = new Set(selectedVars.value);
  autoSaveDraft();
}

// ── 上传 ──
async function onUploadFile(file: File) {
  if (!file) return;
  loadingUpload.value = true;
  try {
    const r = await uploadStatsFile(file);
    if (!r.fileId) throw new Error("上传无 fileId");
    fileId.value = r.fileId;
    fileName.value = file.name;
    const prof = r.profile;
    const rawVars = prof?.variables ?? prof?.columns ?? [];
    variables.value = (Array.isArray(rawVars) ? rawVars : []).map((v) => ({
      name: String(v.name ?? v as unknown as string),
      type: normalizeVarType(v.type ?? "unknown")
    }));
    if (!variables.value.length) {
      // profile 无列定义(如纯 txt) → 无法分析
      toast("数据未识别出变量列, 请确认文件为 CSV/表格", "warning");
    }
    selectedVars.value = new Set();
    // 任务命名(闭源: 首次上传建 statistics 任务)
    await ensureModuleTask("statistics", file.name.replace(/\.[^.]+$/, ""), props.taskId).catch(() => null);
    toast("文件已加载", "success");
    autoSaveDraft();
  } catch (e) {
    toast(`上传失败: ${(e as Error).message}`, "error");
  } finally {
    loadingUpload.value = false;
  }
}

function onUploadInput(ev: Event) {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (f) void onUploadFile(f);
  (ev.target as HTMLInputElement).value = "";
}

// ── 健康检查(闭源: 15s 轮询 statistics/health) ──
async function probeHealth() {
  healthState.value = "checking";
  try {
    const r = await fetch("/api/statistics/health", { headers: { Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` } });
    healthState.value = r.ok ? "connected" : "disconnected";
  } catch {
    healthState.value = "disconnected";
  }
}

// ── 运行(闭源 ut() L1440-1665 校验链 + 创建 + 700ms 轮询) ──
function validateRun(): string | null {
  const m = currentMethod.value;
  if (!m) return "方法不存在";
  if (!fileId.value && m.needData) return "请先上传数据文件";
  if (m.needVars && !selectedVars.value.size && needsVarSelect.value) return "请至少选择一个变量";
  const sv = [...selectedVars.value];
  const err = m.validate(toolParams.value, sv);
  if (err) return err;
  return null;
}

async function runAnalysis() {
  const m = currentMethod.value;
  if (!m) return;
  const err = validateRun();
  if (err) {
    toast(err, "warning");
    return;
  }
  loadingRun.value = true;
  jobStatus.value = "queued";
  result.value = null;
  try {
    await ensureModuleTask("statistics", (fileName.value || "未命名数据分析").replace(/\.[^.]+$/, ""), props.taskId).catch(() => null);
    const sv = [...selectedVars.value];
    const body = m.build(toolParams.value, sv, fileId.value);
    body.tool = m.id;
    const { job } = await createStatsJob(body);
    jobId.value = job.id;
    localStorage.setItem(K.statsJob(uid()), job.id);
    pollJob(job.id);
  } catch (e) {
    loadingRun.value = false;
    toast(`提交失败: ${(e as Error).message}`, "error");
  }
}

function pollJob(id: string) {
  if (pollTimer) clearInterval(pollTimer);
  let ticks = 0;
  pollTimer = setInterval(async () => {
    ticks++;
    try {
      const { job } = await getStatsJob(id);
      jobStatus.value = job.status;
      if (job.status === "completed") {
        stopJobPoll();
        applyResult(job);
      } else if (job.status === "failed") {
        stopJobPoll();
        loadingRun.value = false;
        toast(translateStatsError(job.error?.message ?? "分析失败"), "error");
        refreshHistory();
      } else if (job.status === "cancelled") {
        stopJobPoll();
        loadingRun.value = false;
        toast("统计任务已取消", "warning");
      } else if (ticks > 300) {
        stopJobPoll();
        loadingRun.value = false;
        toast("分析超时", "error");
      }
    } catch {
      stopJobPoll();
      loadingRun.value = false;
      toast("任务查询失败", "error");
    }
  }, 700); // 闭源 700ms 轮询
}

function applyResult(job: StatsJob) {
  loadingRun.value = false;
  jobStatus.value = "completed";
  result.value = job.result ?? null;
  resultVersionId.value = job.result_version_id ?? "";
  const warns = job.result?.warnings ?? [];
  if (warns.length) {
    // 警示条: 有 error 标记的红, 其他琥珀
    result.value = { ...result.value, _warnings: warns } as never;
  }
  localStorage.removeItem(K.statsJob(uid()));
  toast("分析完成", "success");
  autoSaveDraft();
  void refreshHistory();
  // 图表渲染(nextTick 后)
  setTimeout(() => renderCharts(), 150);
}

function stopJobPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  sseCleanup?.();
  sseCleanup = null;
}

async function cancelCurrent() {
  if (!jobId.value) return;
  await cancelStatsJob(jobId.value).catch(() => null);
  stopJobPoll();
  loadingRun.value = false;
  jobStatus.value = "";
  localStorage.removeItem(K.statsJob(uid()));
  toast("任务已取消", "warning");
}

async function retryFailed() {
  if (!jobId.value) return;
  const { job } = await retryStatsJob(jobId.value).catch(() => ({ job: { id: jobId.value, status: "queued" } }));
  jobStatus.value = job.status;
  loadingRun.value = true;
  pollJob(jobId.value);
}

// ── 历史任务 ──
async function refreshHistory() {
  try {
    const { jobs } = await listStatsJobs(20);
    historyJobs.value = jobs;
  } catch { /* 容忍 */ }
}

function openHistoryJob(job: StatsJob) {
  jobId.value = job.id;
  if (job.status === "completed") {
    result.value = job.result ?? null;
    resultVersionId.value = job.result_version_id ?? "";
    setTimeout(() => renderCharts(), 150);
  } else if (job.status === "running" || job.status === "queued") {
    loadingRun.value = true;
    pollJob(job.id);
  } else if (job.status === "failed") {
    jobStatus.value = "failed";
  }
}

// ── 结果渲染 ──
function renderCharts() {
  const charts = result.value?.charts ?? [];
  charts.forEach((c, i) => {
    const el = document.getElementById(`chart-${i}`);
    if (!el) return;
    void loadPlotly().then((Plotly) => {
      const cfg = c.config ?? { data: [], layout: {} };
      const data = Array.isArray(cfg.data) ? cfg.data : [cfg.data];
      void Plotly.newPlot(el, data as never, (cfg.layout ?? {}) as never, { responsive: true, displayModeBar: true });
    });
  });
}

let _plotly: { newPlot: (el: HTMLElement, data: unknown, layout: unknown, cfg: Record<string, unknown>) => Promise<unknown> } | null = null;
async function loadPlotly() {
  if (_plotly) return _plotly;
  const mod = await import("plotly.js-dist-min");
  _plotly = mod.default;
  return _plotly!;
}

// ── 结果单元格 / 表格导出 ──
function cellText(v: unknown): string {
  return fmtCell(v);
}

// ── localStorage 快照(闭源 stats_save_<uid>_<taskId>/stats_save_<uid>) ──
function autoSaveDraft() {
  try {
    const key = props.taskId ? K.statsSave(uid(), props.taskId) : K.statsSaveNoTask(uid());
    localStorage.setItem(key, JSON.stringify({
      tool: currentTool.value,
      fileId: fileId.value,
      fileName: fileName.value,
      variables: variables.value,
      selectedVars: [...selectedVars.value],
      toolParams: toolParams.value,
      varSearchQuery: varSearch.value,
      resultVersionId: resultVersionId.value
    }));
  } catch { /* 存储满容忍 */ }
}

function loadDraft() {
  try {
    const key = props.taskId ? K.statsSave(uid(), props.taskId) : K.statsSaveNoTask(uid());
    const raw = localStorage.getItem(key) ?? localStorage.getItem(K.statsSaveNoTask(uid()));
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.tool) currentTool.value = d.tool;
    if (d.fileId) fileId.value = d.fileId;
    if (d.fileName) fileName.value = d.fileName;
    if (Array.isArray(d.variables)) variables.value = d.variables;
    if (Array.isArray(d.selectedVars)) selectedVars.value = new Set(d.selectedVars);
    if (d.toolParams) {
      toolParams.value = d.toolParams;
      // filter 需保底条件行
      if (currentTool.value === "filter" && !Array.isArray(toolParams.value.conditions)) {
        toolParams.value.conditions = [{ variable: "", operator: ">=", value: "" }];
      }
    }
    if (d.varSearchQuery) varSearch.value = d.varSearchQuery;
    resetParamsKeepSaved();
  } catch { /* 解析失败忽略 */ }
}

function resetParamsKeepSaved() {
  // 在 loadDraft 场景: 已恢复 toolParams, 不覆盖
}

// ── 方法切换 ──
function selectTool(id: string) {
  currentTool.value = id;
  resetParams();
  // 保留与当前方法类型匹配的已选变量(闭源切方法不清选择)
  autoSaveDraft();
}

function resetAll() {
  currentTool.value = "descriptive";
  resetParams();
  selectedVars.value = new Set();
  result.value = null;
  jobStatus.value = "";
  jobId.value = "";
  workspaceKey.value++;
}

// ── 动态参数组件渲染辅助 ──
function updateParam(key: string, val: unknown) {
  toolParams.value[key] = val;
  toolParams.value = { ...toolParams.value };
  autoSaveDraft();
}
function updateFromVars(key: string, name: string) {
  const cur = toolParams.value[key];
  if (Array.isArray(cur)) {
    const idx = cur.indexOf(name);
    const max = currentMethod.value?.fields.find((f) => f.key === key)?.fromVars?.max;
    if (idx >= 0) cur.splice(idx, 1);
    else if (!max || cur.length < max) cur.push(name);
    else toast(`最多选 ${max} 个`, "warning");
    updateParam(key, [...cur]);
  } else {
    updateParam(key, name);
  }
}
function varsFor(key: string): VarDef[] {
  const f = currentMethod.value?.fields.find((x) => x.key === key);
  const filter = f?.fromVars?.filter ?? "scale";
  return variables.value.filter((v) => {
    if (filter === "scale" && v.type !== "scale") return false;
    if (filter === "nominal" && v.type !== "nominal") return false;
    return true;
  });
}

// ── filter 条件行 ──
function addCondition() {
  const conds = toolParams.value.conditions as Array<{ variable: string; operator: string; value: string }>;
  conds.push({ variable: "", operator: ">=", value: "" });
  updateParam("conditions", [...conds]);
}
function updateCondition(idx: number, patch: Partial<{ variable: string; operator: string; value: string }>) {
  const conds = [...(toolParams.value.conditions as Array<{ variable: string; operator: string; value: string }>)];
  conds[idx] = { ...conds[idx], ...patch };
  updateParam("conditions", conds);
}
function removeCondition(idx: number) {
  const conds = [...(toolParams.value.conditions as Array<{ variable: string; operator: string; value: string }>)];
  conds.splice(idx, 1);
  updateParam("conditions", conds.length ? conds : [{ variable: "", operator: ">=", value: "" }]);
}

// ── 运行中状态文案 ──
const runLabel = computed(() => `正在执行 ${currentMethod.value?.name ?? ""} 分析…`);

// ── 生命周期 ──
onMounted(() => {
  resetParams();
  loadDraft();
  void probeHealth();
  healthTimer = setInterval(() => {
    healthProbe.value++;
    void probeHealth();
  }, 15_000); // 闭源 15s health 轮询
  void refreshHistory();
  // 恢复活动 job(闭源 stats_job_<uid> 残留 → 恢复轮询)
  const job = localStorage.getItem(K.statsJob(uid()));
  if (job) {
    void getStatsJob(job)
      .then(({ job: j }) => {
        if (["queued", "running"].includes(j.status)) {
          jobId.value = j.id;
          loadingRun.value = true;
          pollJob(j.id);
        } else {
          localStorage.removeItem(K.statsJob(uid()));
        }
      })
      .catch(() => localStorage.removeItem(K.statsJob(uid())));
  }
});

onUnmounted(() => {
  stopJobPoll();
  if (healthTimer) clearInterval(healthTimer);
  autoSaveDraft();
});

watch(() => props.taskId, () => {
  workspaceKey.value++;
  loadDraft();
});
</script>

<template>
  <div class="statistics-page" :key="workspaceKey">
    <div class="statistics-header">
      <h1 class="statistics-title">统计分析</h1>
      <div class="statistics-header-right">
        <span class="health-capsule" :class="`health-${healthState}`">{{ HEALTH_LABELS[healthState] }}</span>
        <span v-if="fileName" class="file-capsule">已加载: {{ fileName }}</span>
        <span v-else class="file-capsule file-none">未加载数据</span>
        <a class="stats-link" href="#/workflow/workspace" style="display: none">前往工作流</a>
        <button class="btn-new-stats" @click="resetAll">＋ 新建分析</button>
      </div>
    </div>

    <div class="statistics-workspace">
      <!-- 左: 方法面板 -->
      <aside class="method-panel">
        <template v-for="cat in METHOD_CATEGORIES" :key="cat">
          <div v-if="grouped[cat]?.length" class="tool-category">
            <div class="cat-title">{{ cat }}</div>
            <div class="method-grid">
              <button
                v-for="m in grouped[cat]"
                :key="m.id"
                class="method-item"
                :class="{ active: currentTool === m.id }"
                @click="selectTool(m.id)"
              >{{ m.name }}</button>
            </div>
          </div>
        </template>
      </aside>

      <!-- 中: 配置面板 -->
      <div class="config-panel">
        <!-- 上传条 -->
        <div
          class="global-upload-bar"
          :class="{ dragover: uploadDragover, loaded: !!fileId }"
          @click="uploadInputRef?.click()"
          @dragover.prevent="uploadDragover = true"
          @dragleave="uploadDragover = false"
          @drop.prevent="(ev) => { uploadDragover = false; const f = ev.dataTransfer?.files?.[0]; if (f) void onUploadFile(f); }"
        >
          <span class="upload-icon-sm">📁</span>
          <span class="upload-label-sm">
            {{ loadingUpload ? "上传中…" : fileId ? "已加载数据文件(点击可替换)" : "点击或拖拽上传数据文件(.csv/.xlsx/.xls)" }}
          </span>
          <span v-if="fileId" class="file-name-display-sm">{{ fileName }}</span>
          <input ref="uploadInputRef" type="file" accept=".csv,.xlsx,.xls" style="display: none" @change="onUploadInput" />
        </div>

        <div v-if="currentMethod" class="method-desc">
          <strong>{{ currentMethod.name }}</strong>
          <p>{{ currentMethod.desc }}</p>
        </div>

        <!-- 变量选择 -->
        <template v-if="needsVarSelect && variables.length">
          <div class="panel-section-sm var-section">
            <h3 class="section-title-sm">分析变量</h3>
            <input v-model="varSearch" class="var-search" placeholder="搜索变量…" @input="autoSaveDraft" />
            <div class="var-list">
              <div
                v-for="v in filteredVars"
                :key="v.name"
                class="var-item-mb"
                :class="{ selected: selectedVars.has(v.name) }"
                @click="toggleVar(v.name)"
              >
                <span class="var-icon-sm">#</span>
                <span class="var-name">{{ v.name }}</span>
                <span class="type-badge-sm" :class="varTypeMeta(v.type).cls">{{ varTypeMeta(v.type).label }}</span>
              </div>
              <div v-if="!filteredVars.length" class="var-empty">无匹配变量</div>
            </div>
          </div>
        </template>

        <!-- 动态参数 -->
        <div v-if="currentMethod" class="panel-section-sm">
          <h3 class="section-title-sm">参数设置</h3>
          <div class="param-body">
            <!-- 通用信息行 -->
            <p v-for="f in currentMethod.fields.filter((x) => x.kind === 'info')" :key="f.key" class="param-info">{{ f.label }}</p>

            <!-- checkbox 组 -->
            <div v-for="f in currentMethod.fields.filter((x) => x.kind === 'checkbox' && !x.options)" :key="f.key" class="checkbox-row">
              <input type="checkbox" :checked="!!toolParams[f.key]" @change="updateParam(f.key, ($event.target as HTMLInputElement).checked ? 1 : 0)" />
              <label>{{ f.label }}</label>
            </div>

            <!-- 多选 checkbox(options) -->
            <div v-for="f in currentMethod.fields.filter((x) => x.kind === 'checkbox' && !!x.options)" :key="f.key" class="checkbox-group-sm">
              <label class="param-label">{{ f.label }}</label>
              <label v-for="o in f.options" :key="String(o.value)" class="checkbox-row">
                <input
                  type="checkbox"
                  :checked="(toolParams[f.key] as unknown[])?.includes(o.value)"
                  @change="() => {
                    const arr = [...((toolParams[f.key] as unknown[]) ?? [])];
                    const i = arr.indexOf(o.value);
                    if (i >= 0) arr.splice(i, 1); else arr.push(o.value);
                    updateParam(f.key, arr);
                  }"
                />
                {{ o.label }}
              </label>
            </div>

            <!-- radio -->
            <div v-for="f in currentMethod.fields.filter((x) => x.kind === 'radio')" :key="f.key" class="radio-group-sm">
              <label class="param-label">{{ f.label }}</label>
              <label v-for="o in f.options" :key="String(o.value)" class="radio-row">
                <input type="radio" :checked="String(toolParams[f.key]) === String(o.value)" @change="updateParam(f.key, o.value)" />
                {{ o.label }}
              </label>
            </div>

            <!-- number -->
            <div v-for="f in currentMethod.fields.filter((x) => x.kind === 'number')" :key="f.key" class="param-row">
              <label>{{ f.label }}</label>
              <input
                type="number"
                class="param-input"
                :value="toolParams[f.key] as unknown"
                @input="updateParam(f.key, ($event.target as HTMLInputElement).value)"
              />
            </div>

            <!-- fromVars select(single) -->
            <div v-for="f in currentMethod.fields.filter((x) => x.kind === 'select' && !x.fromVars?.multi)" :key="f.key" class="param-row">
              <label>{{ f.label }}</label>
              <select class="param-input" :value="String(toolParams[f.key] ?? '')" @change="updateParam(f.key, ($event.target as HTMLSelectElement).value)">
                <option value="">(未选择)</option>
                <option v-for="v in varsFor(f.key)" :key="v.name" :value="v.name">{{ v.name }} ({{ varTypeMeta(v.type).label }})</option>
              </select>
            </div>

            <!-- fromVars select(multi) -->
            <div v-for="f in currentMethod.fields.filter((x) => x.kind === 'select' && !!x.fromVars?.multi)" :key="f.key" class="param-row">
              <label>{{ f.label }}</label>
              <div class="multi-var-chip-wrap">
                <button
                  v-for="v in varsFor(f.key)"
                  :key="v.name"
                  type="button"
                  class="multi-var-chip"
                  :class="{ on: (toolParams[f.key] as string[])?.includes(v.name) }"
                  @click="updateFromVars(f.key, v.name)"
                >{{ v.name }}</button>
              </div>
            </div>

            <!-- filter 条件行 -->
            <div v-if="currentTool === 'filter'" class="filter-conds">
              <div v-for="(c, i) in (toolParams.conditions as Array<{variable:string;operator:string;value:string}>)" :key="i" class="filter-cond-row">
                <select :value="c.variable" @change="updateCondition(i, { variable: ($event.target as HTMLSelectElement).value })">
                  <option value="">变量</option>
                  <option v-for="v in variables" :key="v.name" :value="v.name">{{ v.name }}</option>
                </select>
                <select :value="c.operator" @change="updateCondition(i, { operator: ($event.target as HTMLSelectElement).value })">
                  <option value=">=">&gt;=</option>
                  <option value=">">&gt;</option>
                  <option value="<=">&lt;=</option>
                  <option value="<">&lt;</option>
                  <option value="==">==</option>
                  <option value="!=">!=</option>
                </select>
                <input :value="c.value" placeholder="值" @input="updateCondition(i, { value: ($event.target as HTMLInputElement).value })" />
                <button class="cond-del" @click="removeCondition(i)">✕</button>
              </div>
              <div class="filter-ops">
                <label class="radio-row"><input type="radio" :checked="toolParams.logic === 'and'" @change="updateParam('logic', 'and')" /> AND(全部满足)</label>
                <label class="radio-row"><input type="radio" :checked="toolParams.logic === 'or'" @change="updateParam('logic', 'or')" /> OR(任一满足)</label>
                <button class="cond-add" @click="addCondition">+ 添加条件</button>
              </div>
            </div>

            <!-- 未实现参数提示 -->
            <p v-if="!currentMethod.fields.length" class="param-info">该分析方法无需额外参数。</p>
          </div>
        </div>

        <!-- 运行按钮 -->
        <div class="run-row">
          <button class="btn-run-mb" :disabled="loadingRun" @click="runAnalysis">
            {{ loadingRun ? "分析中…" : "运行分析" }}
          </button>
          <button class="btn-reset-mb" @click="resetAll">重置</button>
          <button v-if="jobStatus === 'running' || jobStatus === 'queued'" class="btn-cancel-mb" @click="cancelCurrent">取消任务</button>
          <button v-else-if="jobStatus === 'failed'" class="btn-retry-mb" @click="retryFailed">从失败任务重试</button>
        </div>
      </div>

      <!-- 右: 结果面板 -->
      <div class="results-panel">
        <div class="results-header-mb">
          <strong>分析结果</strong>
          <div class="results-actions">
            <select v-if="historyJobs.length" class="history-select" @change="openHistoryJob(historyJobs[Number(($event.target as HTMLSelectElement).value)]!)">
              <option disabled value="-1">历史分析任务</option>
              <option v-for="(h, i) in historyJobs" :key="h.id" :value="i">
                {{ h.tool }} · {{ h.status === 'completed' ? '已完成' : h.status === 'failed' ? '失败' : h.status === 'cancelled' ? '已取消' : h.status }} · {{ (h.created_at ?? '').slice(5, 16).replace('T', ' ') }}
              </option>
            </select>
            <button class="btn-clear-mb" @click="resetAll">清空</button>
          </div>
        </div>

        <!-- loading 覆盖 -->
        <div v-if="loadingRun" class="result-loading">
          <div class="spinner-mb"></div>
          <p>{{ runLabel }}</p>
        </div>

        <!-- 空态 -->
        <div v-else-if="!result" class="welcome-screen-mb">
          <div class="welcome-icon-sm">📊</div>
          <h3>统计分析工作台</h3>
          <p>上传数据 → 选择左侧 17 种分析方法 → 配置参数 → 运行分析</p>
          <p class="welcome-tags">描述统计 · t 检验 · ANOVA · 相关 · 回归 · 因子 · 中介调节 · 信度</p>
        </div>

        <!-- 结果 -->
        <template v-else>
          <div v-if="result._warnings?.length" class="warning-bar-mb">
            <div v-for="(w, i) in result._warnings" :key="i" class="warn-line">⚠ {{ w }}</div>
          </div>
          <div class="results-body-mb">
            <template v-for="(t, ti) in (result.tables ?? [])" :key="'t' + ti">
              <div class="result-table-block">
                <div class="table-title">{{ t.title }}</div>
                <table class="three-line-table-mb">
                  <thead>
                    <tr>
                      <th v-for="(c, ci) in t.columns" :key="ci">{{ c }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(r, ri) in t.rows" :key="ri" :class="{ 'even-row-mb': ri % 2 === 1 }">
                      <td v-for="(cell, ci) in r" :key="ci">{{ cellText(cell) }}</td>
                    </tr>
                  </tbody>
                </table>
                <div v-if="t.footnote" class="table-footnote">注: {{ t.footnote }}</div>
              </div>
            </template>
            <template v-for="(c, i) in (result.charts ?? [])" :key="'c' + i">
              <div class="chart-container-mb">
                <div class="chart-head">
                  <span class="chart-title-sm">{{ (c.config?.layout as Record<string, unknown>)?.title ? String(((c.config.layout as Record<string, { text?: string }>).title?.text ?? '')) : '图表' }}</span>
                </div>
                <div :id="'chart-' + i" class="chart-plot-area"></div>
              </div>
            </template>
            <div v-if="!(result.tables?.length || result.charts?.length)" class="result-empty">分析无输出内容</div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.statistics-page {
  width: 100%;
  overflow-x: auto;
  font-family: PingFang SC, Microsoft YaHei, sans-serif;
}
.statistics-page > * {
  min-width: 1080px;
}
.statistics-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  background: #11192C;
  border-bottom: 1px solid #222F44;
  position: sticky;
  top: 0;
  z-index: 10;
}
.statistics-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: #E8EEF7;
}
.statistics-header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.health-capsule {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 20px;
}
.health-connected { background: #14281F; color: #5FD0B4; }
.health-disconnected { background: #2A1C1C; color: #dc2626; }
.health-checking, .health-unknown { background: #212C45; color: #8B9BB1; }
.file-capsule {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 20px;
  background: #1E2A48;
  color: #2563eb;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-none { background: #212C45; color: #7A8AA0; }
.btn-new-stats {
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid #759FD7;
  border-radius: 7px;
  background: #11192C;
  color: #759FD7;
  cursor: pointer;
}
.btn-new-stats:hover { background: #161F33; }
.statistics-workspace {
  display: flex;
  gap: 0;
  height: calc(100dvh - 180px);
  min-height: 520px;
}
.method-panel {
  width: 260px;
  flex-shrink: 0;
  padding: 14px 12px;
  background: #1A2333;
  border-right: 1px solid #222F44;
  overflow-y: auto;
}
.tool-category { margin-bottom: 14px; }
.cat-title {
  font-size: 11px;
  font-weight: 600;
  color: #8BA4F0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
  padding-left: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.method-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}
.method-item {
  padding: 7px 6px;
  background: #212C45;
  border: 1px solid #222F44;
  border-radius: 7px;
  cursor: pointer;
  color: #8B9BB1;
  font-size: 11.5px;
  text-align: center;
  transition: all 0.2s ease;
}
.method-item:hover {
  background: #e8eaf6;
  color: #E8EEF7;
  border-color: #8BA4F0;
  transform: translateY(-1px);
}
.method-item.active {
  background: #161F33 !important;
  border-color: #9bb8d8 !important;
  color: #759FD7 !important;
  box-shadow: none !important;
}
.config-panel {
  width: min(360px, 100%);
  flex-shrink: 0;
  padding: 12px;
  background: #11192C;
  border-right: 1px solid #222F44;
  overflow-y: auto;
}
.global-upload-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: linear-gradient(135deg, #1C2740, #241F38);
  border: 2px dashed #c7d2fe;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  margin-bottom: 12px;
}
.global-upload-bar.dragover {
  border-color: #8BA4F0;
  background: #1E2A48;
  transform: scale(1.01);
}
.global-upload-bar.loaded {
  border-style: solid;
  border-color: #10b981;
  background: rgba(16, 185, 129, 0.04);
}
.upload-icon-sm { font-size: 18px; flex-shrink: 0; }
.upload-label-sm { font-size: 13px; color: #8B9BB1; white-space: nowrap; }
.file-name-display-sm {
  font-size: 12px;
  font-weight: 600;
  color: #10b981;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.method-desc {
  margin-bottom: 12px;
}
.method-desc strong { font-size: 14px; color: #E8EEF7; }
.method-desc p {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: #8B9BB1;
  line-height: 1.5;
}
.panel-section-sm {
  padding: 14px;
  background: #1A2333;
  border-radius: 10px;
  border-left: 3px solid #f97316;
  margin-bottom: 12px;
}
.var-section { border-left-color: #10b981; }
.section-title-sm {
  font-size: 12px;
  font-weight: 600;
  color: #E8EEF7;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.var-search {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 9px;
  font-size: 12px;
  border: 1px solid #222F44;
  border-radius: 6px;
  margin-bottom: 7px;
  background: #11192C;
}
.var-list {
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.var-item-mb {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 7px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
  color: #DCE6F2;
}
.var-item-mb:hover { background: #1A2333; color: #E8EEF7; }
.var-item-mb.selected { background: rgba(99, 102, 241, 0.12); color: #8BA4F0; font-weight: 500; }
.var-icon-sm { width: 18px; text-align: center; font-size: 12px; color: #7A8AA0; }
.var-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.type-badge-sm { font-size: 9px; padding: 1px 6px; border-radius: 4px; font-weight: 500; }
.type-badge-sm.scale { background: rgba(59, 130, 246, 0.15); color: #3b82f6; }
.type-badge-sm.nominal { background: rgba(99, 102, 241, 0.15); color: #8BA4F0; }
.var-empty { padding: 12px; text-align: center; color: #7A8AA0; font-size: 11px; }
.param-body { display: flex; flex-direction: column; gap: 7px; }
.param-info { margin: 0; font-size: 11.5px; color: #8B9BB1; line-height: 1.5; }
.param-label { font-size: 12px; font-weight: 600; color: #DCE6F2; }
.checkbox-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: #DCE6F2;
  cursor: pointer;
}
.checkbox-group-sm { display: flex; flex-direction: column; gap: 5px; }
.radio-group-sm { display: flex; flex-direction: column; gap: 6px; }
.radio-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #DCE6F2;
  cursor: pointer;
}
.param-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.param-row label { font-size: 12px; font-weight: 600; color: #DCE6F2; }
.param-input {
  padding: 5px 8px;
  font-size: 12px;
  border: 1px solid #222F44;
  border-radius: 6px;
  background: #11192C;
}
.multi-var-chip-wrap { display: flex; flex-wrap: wrap; gap: 4px; }
.multi-var-chip {
  padding: 3px 8px;
  font-size: 11px;
  border: 1px solid #222F44;
  border-radius: 12px;
  background: #11192C;
  color: #8B9BB1;
  cursor: pointer;
}
.multi-var-chip.on { background: #8BA4F0; color: #F1F5F9; border-color: #8BA4F0; }
.filter-conds { display: flex; flex-direction: column; gap: 5px; }
.filter-cond-row { display: flex; gap: 4px; align-items: center; }
.filter-cond-row select,
.filter-cond-row input {
  padding: 4px 6px;
  font-size: 11.5px;
  border: 1px solid #222F44;
  border-radius: 5px;
  background: #11192C;
}
.filter-cond-row select:first-child { flex: 1.4; }
.filter-cond-row select:nth-child(2) { width: 62px; }
.filter-cond-row input { flex: 1; }
.cond-del {
  border: 0;
  background: transparent;
  color: #dc2626;
  cursor: pointer;
  font-size: 12px;
}
.filter-ops {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 3px;
}
.cond-add {
  padding: 3px 9px;
  font-size: 11px;
  border: 1px dashed #9bb8d8;
  border-radius: 5px;
  background: #11192C;
  color: #759FD7;
  cursor: pointer;
}
.run-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 4px;
}
.btn-run-mb {
  background: #11192C !important;
  border: 1px solid #9bb8d8 !important;
  color: #759FD7 !important;
  padding: 8px 22px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 7px;
  cursor: pointer;
}
.btn-run-mb:hover,
.btn-report-mb:hover,
.btn-pdf-mb:hover {
  background: #161F33 !important;
  border-color: #759FD7 !important;
  color: #173a6a !important;
}
.btn-run-mb:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-reset-mb {
  padding: 8px 16px;
  font-size: 12px;
  border: 1px solid #222F44;
  border-radius: 7px;
  background: #1A2333;
  color: #8B9BB1;
  cursor: pointer;
}
.btn-cancel-mb {
  padding: 8px 14px;
  font-size: 12px;
  border: 1px solid #3A2323;
  border-radius: 7px;
  background: #2A1C1C;
  color: #dc2626;
  cursor: pointer;
}
.btn-retry-mb {
  padding: 8px 14px;
  font-size: 12px;
  border: 1px solid #3A3020;
  border-radius: 7px;
  background: #11192Cbeb;
  color: #E8B54A;
  cursor: pointer;
}
.results-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #11192C;
}
.results-header-mb {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: #1A2333;
  border-bottom: 1px solid #222F44;
}
.results-header-mb strong { font-size: 13px; color: #E8EEF7; }
.results-actions { display: flex; gap: 8px; align-items: center; }
.history-select {
  padding: 4px 8px;
  font-size: 11px;
  border: 1px solid #222F44;
  border-radius: 6px;
  background: #11192C;
  max-width: 240px;
}
.btn-clear-mb {
  padding: 4px 10px;
  font-size: 11px;
  border: 1px solid #222F44;
  border-radius: 5px;
  background: #11192C;
  color: #8B9BB1;
  cursor: pointer;
}
.result-loading {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #8B9BB1;
  font-size: 13px;
}
.spinner-mb {
  width: 40px;
  height: 40px;
  border: 3px solid #222F44;
  border-top-color: #8BA4F0;
  border-radius: 50%;
  animation: spin-mb 0.8s linear infinite;
}
@keyframes spin-mb {
  to { transform: rotate(360deg); }
}
.welcome-screen-mb {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
}
.welcome-icon-sm { font-size: 56px; opacity: 0.7; }
.welcome-screen-mb h3 { margin: 10px 0 6px; font-size: 16px; color: #E8EEF7; }
.welcome-screen-mb p { margin: 2px 0; font-size: 12px; color: #8B9BB1; }
.welcome-tags { margin-top: 10px !important; font-size: 11px !important; color: #9bb8d8 !important; }
.warning-bar-mb {
  padding: 10px 14px;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 8px;
  margin: 10px 14px;
}
.warn-line { font-size: 12px; color: #E8B54A; line-height: 1.5; }
.results-body-mb {
  background: #11192C;
  padding: 12px 16px;
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.result-table-block { width: 100%; }
.table-title {
  font-size: 13px;
  font-weight: 600;
  color: #E8EEF7;
  margin-bottom: 7px;
}
.three-line-table-mb {
  font-size: 12.5px;
  border-collapse: collapse;
  width: 100%;
}
.three-line-table-mb th {
  border-top: 2px solid #1e293b;
  border-bottom: 1px solid #475569;
  padding: 8px 14px;
  font-weight: 600;
  font-size: 12px;
  text-align: left;
  color: #E8EEF7;
  white-space: nowrap;
}
.three-line-table-mb td {
  padding: 6px 14px;
  color: #DCE6F2;
  border: none;
}
.even-row-mb td { background: #1A2333; }
.three-line-table-mb tr:last-child td {
  border-top: 2px solid #1e293b;
  border-bottom: 0;
}
.three-line-table-mb tr:last-child td {
  background: transparent;
}
.table-footnote {
  margin-top: 4px;
  font-size: 11px;
  color: #8B9BB1;
  font-style: italic;
}
.chart-container-mb {
  background: #1A2333;
  border: 1px solid #222F44;
  border-radius: 8px;
  padding: 10px;
}
.chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.chart-title-sm { font-size: 13px; font-weight: 600; color: #E8EEF7; }
.chart-plot-area { min-height: 350px; }
.result-empty { padding: 30px; text-align: center; color: #7A8AA0; font-size: 12px; }
</style>
