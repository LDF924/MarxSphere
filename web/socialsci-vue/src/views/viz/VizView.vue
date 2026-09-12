<script setup lang="ts">
/**
 * VizView — 还原自闭源 VizView-DKRGiXDc.js L3301-5031(scope data-v-df5821c7)
 * header(图表/任务 tab + 新建 + 删除二次确认) + 双栏(左 VizChatPanelV2 220-480 可拖 + 右画布)
 * 画布: 图卡 tab 条(≤8 + "+")/预览/底部三 tab(数据/图注/代码)
 * 任务视图: VizTaskWindow 列表 → select → 恢复
 */
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import VizChatPanelV2 from "./VizChatPanelV2.vue";
import { blobifyPng, getVizJob, listVizJobs, vizArtifactUrl, getVizJobDataset, K, uid, type VizJob } from "./vizApi";
import { toast, confirmDialog } from "@/shared/ui";

const viewTab = ref<"canvas" | "windows">("canvas");

// ── 图卡模型(闭源 $e() L3691-3716) ──
interface Figure {
  id: number;
  vizJobId?: string;
  chartVersionId?: string;
  chartKey?: string;
  label: string;
  png: string;
  svg?: string;
  code?: string;
  caption?: string;
  analysisText?: string;
  chartType?: string;
  sampleData?: boolean;
  dataFile?: string;
  dataSnapshot?: { fileId: string; fileName: string; columns: string[]; rows: unknown[][]; totalRows?: number; sampleData?: boolean } | null;
}
let figSeq = 1;
const figures = ref<Figure[]>([]);
const selectedIdx = ref(-1);
const selectedFigure = computed(() => (selectedIdx.value >= 0 ? figures.value[selectedIdx.value] : null));
const bottomTab = ref("data"); // data/caption/code

// ── 底部信息栏高度可拖(用户反馈④) ──
const INFO_KEY = "viz_info_h_v1";
const infoHeight = ref(260);
function loadInfoHeight() {
  try { const v = Number(localStorage.getItem(INFO_KEY)); if (v >= 120 && v <= 720) infoHeight.value = v; } catch { /* 忽略 */ }
}
function startInfoResize(e: MouseEvent) {
  const el = (e.currentTarget as HTMLElement).parentElement;
  if (!el) return;
  const startY = e.clientY;
  const startH = el.getBoundingClientRect().height;
  const move = (ev: MouseEvent) => {
    infoHeight.value = Math.max(120, Math.min(720, startH - (ev.clientY - startY)));
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    try { localStorage.setItem(INFO_KEY, String(infoHeight.value)); } catch { /* 忽略 */ }
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

// ── 对话栏宽度(220-480 拖拽, 闭源 re() L3636-3648) ──
const chatWidth = ref(420);
let chatDrag = false;
function onChatResizeDown(e: MouseEvent) {
  chatDrag = true;
  const startX = e.clientX;
  const startW = chatWidth.value;
  const move = (ev: MouseEvent) => {
    chatWidth.value = Math.min(480, Math.max(220, startW + (ev.clientX - startX)));
  };
  const up = () => {
    chatDrag = false;
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

// ── 任务视图 ──
const jobs = ref<VizJob[]>([]);
const jobsLoading = ref(false);
const selectedJobId = ref("");
const selectedJobChartIdx = ref(-1);

async function loadJobs() {
  jobsLoading.value = true;
  try {
    const { jobs: list } = await listVizJobs(20);
    jobs.value = list;
  } catch {
    jobs.value = [];
  } finally {
    jobsLoading.value = false;
  }
}

async function selectJob(job: VizJob) {
  selectedJobId.value = job.id;
  selectedJobChartIdx.value = -1;
  // 切到图表视图并恢复画布(闭源 M() 三级恢复)
  try {
    const { job: fresh } = await getVizJob(job.id);
    await restoreFromJob(fresh);
  } catch {
    toast("任务读取失败", "error");
  }
}

async function restoreFromJob(job: VizJob) {
  const charts = job.result?.charts ?? [];
  const newFigs: Figure[] = [];
  for (const c of charts) {
    const url = await blobifyPng(c.png ?? c.chartPng ?? null);
    if (!url) continue; // 缺图跳过(闭源语义)
    newFigs.push({
      id: figSeq++,
      vizJobId: job.id,
      chartVersionId: c.chartVersionId ?? "",
      chartKey: c.figureId ?? `figure:${c.figureIndex ?? ""}`,
      label: c.caption ? c.caption.slice(0, 30) : c.chartType || `Figure ${newFigs.length + 1}`,
      png: url,
      svg: c.svg ? String(c.svg) : undefined,   // 存原始引用, 导出时解析(此前提前拼前缀 → 二次拼接)`
      code: c.code,
      caption: c.caption,
      analysisText: c.analysisText,
      chartType: c.chartType,
      sampleData: (c as { sampleData?: boolean }).sampleData,
      dataFile: (c as { dataFile?: string }).dataFile
    });
  }
  // 回查该任务实际用的数据集, 绑到每张图卡 — 否则「数据」页签恒显示"暂无绑定数据",
  //   用户看不到"这张图到底用了什么数据"(2026-09-11)
  if (newFigs.length) {
    const ds = await getVizJobDataset(job.id).catch(() => null);
    if (ds) {
      const snap = {
        fileId: "",
        fileName: ds.fileName || (ds.sampleData ? "未绑定数据(示意图)" : "任务数据集"),
        columns: ds.columnOrder,
        rows: ds.rows,
        totalRows: ds.totalRows,
        sampleData: ds.sampleData,
      };
      for (const f of newFigs) f.dataSnapshot = snap;
    }
  }
  figures.value = newFigs;
  if (newFigs.length) {
    selectedIdx.value = 0;
    viewTab.value = "canvas";
    // 对话恢复
    await nextTick();
  } else {
    figures.value = [];
    selectedIdx.value = -1;
    viewTab.value = "windows";
  }
  saveCanvas();
}

// 当前会话的数据源快照(data-upload 事件维护); 实时出图的新图卡要绑它, 否则「数据」页签恒空
type DataSnap = { fileId: string; fileName: string; columns: string[]; rows: unknown[][]; totalRows?: number; sampleData?: boolean };
const curDataSnapshot = ref<DataSnap | null>(null);

// ── chart-update 事件(闭源 Xe() L3755-3851: 去重/新建图卡/选中滚动) ──
function onChartUpdate(payload: Record<string, unknown>) {
  const vizJobId = String(payload.vizJobId ?? "");
  // 图卡身份: 优先后端稳定 figureId; 无 figureId(旧后端)时按 vizJobId 合并 —
  // 同一 job 的 chart 迭代(v1/v2/v3)更新同一张图卡, 不新开(闭源 be() 语义)
  const chartKey = String(payload.figureId ?? payload.chartKey ?? payload.chartKeyRaw ?? "");
  const url = String(payload.url ?? "");
  const pngRaw = String(payload.png ?? "");
  const existing = chartKey
    ? figures.value.find((f) => f.vizJobId === vizJobId && f.chartKey === chartKey)
    : figures.value.find((f) => f.vizJobId === vizJobId);
  const label = String(payload.caption ?? payload.chartType ?? "").slice(0, 30) || (existing ? existing.label : `Figure ${figures.value.length + 1}`);
  if (existing && url) {
    existing.chartKey = chartKey || existing.chartKey;
    existing.png = url;
    existing.svg = String(payload.svg ?? payload.svgUrl ?? existing.svg ?? "");  // 原始引用, 导出时统一解析
    existing.caption = String(payload.caption ?? existing.caption ?? "");
    existing.analysisText = String(payload.analysisText ?? existing.analysisText ?? "");
    existing.code = String(payload.code ?? existing.code ?? "");
    existing.chartType = String(payload.chartType ?? existing.chartType ?? "");
    if (payload.sampleData !== undefined) existing.sampleData = Boolean(payload.sampleData);
    if (existing.chartVersionId !== String(payload.chartVersionId ?? "")) existing.chartVersionId = String(payload.chartVersionId ?? "");
  } else if (url) {
    if (figures.value.length >= 8) {
      // 超过 8 个: 滚动替换最旧? 闭源上限 8 → 直接加(无删除)
    }
    figures.value.push({
      id: figSeq++,
      vizJobId,
      chartVersionId: String(payload.chartVersionId ?? ""),
      chartKey: chartKey || `figure:${figures.value.length}`,
      label,
      png: url,
      svg: String(payload.svg ?? payload.svgUrl ?? ""),
      caption: String(payload.caption ?? ""),
      analysisText: String(payload.analysisText ?? ""),
      code: String(payload.code ?? ""),
      chartType: String(payload.chartType ?? ""),
      sampleData: payload.sampleData === true,
      // 绑上当前会话数据源, 否则「数据」页签显示"暂无绑定数据"(用户反馈)
      dataSnapshot: curDataSnapshot.value
    });
    selectedIdx.value = figures.value.length - 1;
    saveCanvas();
  }
}

// ── data-upload 事件(闭源 Oe(): 绑数据快照 + 命名任务) ──
function onDataUpload(payload: { fileId: string; fileName: string; columns: string[]; rows: unknown[][]; rowCount?: number }) {
  const snap: DataSnap = {
    fileId: payload.fileId, fileName: payload.fileName,
    columns: payload.columns, rows: payload.rows,
    totalRows: payload.rowCount,
    sampleData: !payload.columns.length,
  };
  curDataSnapshot.value = snap;
  for (const f of figures.value) {
    if (!f.dataSnapshot) f.dataSnapshot = snap;   // 未绑定的补上
    else if (!f.dataSnapshot.columns.length && payload.columns.length) f.dataSnapshot = snap; // 先绑了个没列名的, 补全
  }
  saveCanvas();
}

function onJobStatus(payload: { id: string; status: string }) {
  // 后端写的是 'done'(viz-job-service setStatus), 不是 'completed' —— 两种都认
  if (payload.status === "completed" || payload.status === "done") {
    // 120ms 后刷新任务列表(闭源 G() L3474-3485)
    setTimeout(() => void loadJobs(), 120);
  } else {
    void loadJobs();
  }
}

// ── 画布操作 ──
function selectFig(i: number) {
  selectedIdx.value = i;
}
function addEmptyFig() {
  const f: Figure = { id: figSeq++, label: `Figure ${figures.value.length + 1}`, png: "" };
  figures.value.push(f);
  selectedIdx.value = figures.value.length - 1;
  bottomTab.value = "caption";
  saveCanvas();
}
function removeFig(i: number) {
  figures.value.splice(i, 1);
  if (selectedIdx.value >= figures.value.length) selectedIdx.value = figures.value.length - 1;
  saveCanvas();
}

// ── 画布持久化(闭源 viz_save_<uid>_<taskId>: dataSnapshot≤500 行) ──
function saveCanvas() {
  try {
    const key = K.vizSave(uid(), "default");
    // blob: URL 只在当前页面生命周期有效, 存进 localStorage 刷新后必然 broken image
    //   → 不存 png/svg 的 blob 地址, 只存"曾有图"标记; 载入时按标记提示重新载入(任务视图)
    const snap = figures.value.map((f) => {
      const { png, svg, ...rest } = f;
      return {
        ...rest,
        png: "",
        svg: undefined,
        hadImage: Boolean(png) || Boolean(svg),
        dataSnapshot: f.dataSnapshot ? { ...f.dataSnapshot, rows: f.dataSnapshot.rows.slice(0, 500) } : null
      };
    });
    localStorage.setItem(key, JSON.stringify(snap));
  } catch { /* 容量容忍 */ }
}
function loadCanvas() {
  try {
    const key = K.vizSave(uid(), "default");
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      figures.value = arr.filter((f) => f && typeof f === "object");
      if (figures.value.length) selectedIdx.value = 0;
    }
  } catch { /* 解析失败忽略 */ }
}

// ── 新建/删除(闭源 confirm 语义) ──
async function newChart() {
  const ok = await confirmDialog({ message: "开始新的绘图任务? 当前画布图表将保留, 会话内容会清空。", title: "新建图表", okText: "开始" });
  if (!ok) return;
  viewTab.value = "canvas";
  figures.value = [];
  selectedIdx.value = -1;
  saveCanvas();
}

let delArmed = false;
let delTimer: ReturnType<typeof setTimeout> | null = null;
function deleteCurrent() {
  if (!delArmed) {
    delArmed = true;
    if (delTimer) clearTimeout(delTimer);
    delTimer = setTimeout(() => (delArmed = false), 3000); // 3s 内变确认
    toast("再次点击确认删除", "warning");
    return;
  }
  delArmed = false;
  figures.value = [];
  selectedIdx.value = -1;
  saveCanvas();
}

// ── 导出当前图为 png(闭源: blob → saveAs) ──
function downloadUrl(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
}
function safeName(f: Figure, ext: string) {
  return `${(f.caption || f.label || "chart").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}.${ext}`;
}

async function exportPng() {
  const f = selectedFigure.value;
  if (!f?.png) {
    toast("无可导出的图表", "warning");
    return;
  }
  try {
    const res = await fetch(f.png);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    downloadUrl(url, safeName(f, "png"));
    setTimeout(() => URL.revokeObjectURL(url), 10_000);   // 立刻 revoke 会让部分浏览器下载中断
    toast("PNG 已导出", "success");
  } catch {
    toast("导出失败", "error");
  }
}

// ── SVG 可编辑版(出版流程真正需要: 投稿系统常要矢量图) ──
/** 图卡的 SVG 源统一解析: 内联 svg / data: / 已带 /api 前缀 / 裸相对路径 都能用 */
function svgSrc(f: Figure): string {
  const raw = String(f.svg ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("data:") || raw.startsWith("<svg") || raw.startsWith("<?xml")) return raw;
  if (raw.startsWith("/")) return raw;                       // 已带前缀(/api/viz/files/...)
  if (raw.startsWith("data/")) return vizArtifactUrl(raw);   // 裸产物相对路径
  return raw;
}

async function exportSvg() {
  const f = selectedFigure.value;
  const src = f ? svgSrc(f) : "";
  if (!src) {
    toast("该图没有可编辑矢量版(SVG)", "warning");
    return;
  }
  try {
    // 内联 svg 直接落盘; 路径必须带鉴权头, 且必须检查 res.ok —
    //   否则会把 401/404 的 JSON/HTML 当 .svg 下载还提示成功
    const blob = src.startsWith("data:") || src.startsWith("<svg") || src.startsWith("<?xml")
      ? new Blob([src], { type: "image/svg+xml" })
      : await (async () => {
          const r = await fetch(src, { headers: { Authorization: `Bearer ${authToken()}` } });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.blob();
        })();
    const url = URL.createObjectURL(blob);
    downloadUrl(url, safeName(f!, "svg"));
    setTimeout(() => URL.revokeObjectURL(url), 10_000);   // 立刻 revoke 会让部分浏览器下载中断
    toast("SVG 已导出", "success");
  } catch (e) {
    toast(`SVG 导出失败: ${(e as Error).message}`, "error");
  }
}

function authToken(): string {
  try {
    return localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
  } catch { return ""; }
}

async function copyText(text: string | undefined, label: string) {
  if (!text) {
    toast(`暂无${label}`, "warning");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}已复制`, "success");
  } catch {
    toast("复制失败(浏览器未授权剪贴板)", "error");
  }
}

// ── 代码高亮(闭源 Ye(): 注释/字符串/关键字/数字 + 行号) ──
function copyFigCode() {
  const f = selectedFigure.value;
  if (f?.code) void copyText(f.code, "代码");
}

/**
 * 逐行高亮。关键: 先把「注释」与「代码」切开, 各自只着色一次。
 * 早期实现是"整体替换一遍再替换一遍", 注释包进 <span class="hl-cmt"> 后, 关键字/数字正则
 * 又会命中 span 的 class= 文本, 产出嵌套的坏 HTML(`<span <span class="hl-kw">class</span>="hl-cmt">`)。
 */
function highlightPy(code: string): string {
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const NL = String.fromCharCode(10);

  const hlCode = (raw: string): string => {
    let s = esc(raw);
    // 字符串先摘出并占位, 否则字符串里的 # 会被当注释、关键字会被二次着色
    const strs: string[] = [];
    s = s.replace(/("[^"]*"|'[^']*')/g, (m) => {
      strs.push(m);
      return "@@S" + (strs.length - 1) + "@@";
    });
    s = s.replace(/\b(def|class|import|from|return|for|in|if|else|elif|while|with|as|None|True|False|and|or|not|lambda)\b/g,
      '<span class="hl-kw">$1</span>');
    s = s.replace(/\b(plt|ax|pd|np|sns|fig|df|mpl|DATA_CSV)\b/g, '<span class="hl-fn">$1</span>');
    s = s.replace(/\b(\d+\.?\d*)\b/g, '<span class="hl-num">$1</span>');
    // 回填字符串(已转义, 直接放回)
    return s.replace(/@@S(\d+)@@/g, (_m, i) => `<span class="hl-str">${strs[Number(i)]}</span>`);
  };

  const out = String(code ?? "").split(NL).map((line) => {
    // 找注释起点: 跳过引号内的 #
    let inStr = false;
    let q = "";
    let cut = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inStr) {
        if (c === q && line[i - 1] !== "\\") inStr = false;
      } else if (c === '"' || c === "'") {
        inStr = true;
        q = c;
      } else if (c === "#") {
        cut = i;
        break;
      }
    }
    if (cut < 0) return hlCode(line);
    return hlCode(line.slice(0, cut)) + `<span class="hl-cmt">${esc(line.slice(cut))}</span>`;
  });
  return out.map((l, i) => `<div class="code-line"><span class="line-no">${i + 1}</span><span class="line-code">${l || " "}</span></div>`).join("");
}

// ── 统一分析台「送工坊精修」: 父级 postMessage 带数据与需求 → 自动上传并发起绘图 ──
const chatPanel = ref<InstanceType<typeof VizChatPanelV2> | null>(null);

async function onEmpiricalSeed(e: MessageEvent) {
  const d = e.data;
  if (!d || d.source !== "marxsphere-app" || d.type !== "empirical-viz-seed") return;
  if (!d.csv?.trim()) {
    toast("未携带数据, 请重新在分析台点击「送工坊精修」", "warning");
    return;
  }
  viewTab.value = "canvas";
  await nextTick();
  const panel = chatPanel.value as unknown as { seedFromEmpirical?: (s: { csv: string; columnOrder: string[]; message: string }) => Promise<void> } | null;
  try {
    await panel?.seedFromEmpirical?.({
      csv: String(d.csv),
      columnOrder: (d.columnOrder ?? []).map(String),
      message: String(d.message ?? "基于这份数据绘制合适的科研图表"),
    });
    toast(`已带入「${d.title ?? "分析结果"}」的数据, 正在绘图`, "success");
  } catch (err) {
    toast(`带入数据失败: ${(err as Error).message}`, "error");
  }
}

// ── 生命周期 ──
onMounted(() => {
  loadInfoHeight();
  loadCanvas();
  void loadJobs();
  window.addEventListener("message", onEmpiricalSeed as unknown as EventListener);
  // V414: 挂载完成 + 监听器已就绪 → 告知父级可以投递。
  //   父级靠轮询 document.getElementById("app") 判断"就绪"是不可靠的: #app 只是 index.html 里的
  //   静态挂载点(HTML 解析完就存在), 而本组件的 onMounted 要等动态 import 的 bundle 下载、
  //   路由解析、组件挂载之后才跑。父级据此提前 postMessage → 监听器还不存在 → 消息静默丢失
  //   (实测: 同一份代码三次验证两成一股, 随机成败)。打标由真正就绪的一方发出, 时序确定。
  (window as unknown as { __socReady?: Record<string, boolean> }).__socReady = {
    ...((window as unknown as { __socReady?: Record<string, boolean> }).__socReady ?? {}),
    viz: true,
  };
});
onUnmounted(() => {
  saveCanvas();
  if (delTimer) clearTimeout(delTimer);
  window.removeEventListener("message", onEmpiricalSeed as unknown as EventListener);
});

watch(figures, () => saveCanvas(), { deep: true });

// 导出为图片/删除的临时按钮状态由父 header 处理; 快捷引用
const chartTabList = computed(() => figures.value.map((f, i) => ({ i, label: f.label, png: f.png })));
</script>

<template>
  <div class="viz-page">
    <div class="viz-workbench">
      <!-- header -->
      <div class="viz-header">
        <div class="viz-title-row">
          <h1 class="viz-title">科研绘图</h1>
          <div class="viz-tabs">
            <button class="viz-tab" :class="{ active: viewTab === 'canvas' }" @click="viewTab = 'canvas'">图表视图</button>
            <button class="viz-tab" :class="{ active: viewTab === 'windows' }" @click="viewTab = 'windows'">任务视图</button>
          </div>
          <div class="viz-actions">
            <button class="viz-btn" @click="newChart">＋ 新建图表</button>
            <button class="viz-btn" :disabled="!selectedFigure?.png" @click="exportPng">导出为图片</button>
            <button class="viz-btn danger" :class="{ armed: delArmed }" @click="deleteCurrent">{{ delArmed ? "确认删除" : "删除" }}</button>
          </div>
        </div>
      </div>

      <!-- 主体: 双视图 -->
      <div v-if="viewTab === 'canvas'" class="viz-canvas-view">
        <!-- 左: 对话 -->
        <div class="chat-col" :style="{ width: chatWidth + 'px' }">
          <VizChatPanelV2
            ref="chatPanel"
            @chart-update="onChartUpdate"
            @data-upload="onDataUpload"
            @job-status="onJobStatus"
          />
        </div>
        <div class="chat-resizer" @mousedown="onChatResizeDown"></div>

        <!-- 右: 画布 -->
        <div class="canvas-col">
          <!-- 图卡 tab 条 -->
          <div class="fig-tabs">
            <button
              v-for="f in chartTabList"
              :key="f.i"
              class="fig-tab"
              :class="{ active: selectedIdx === f.i }"
              @click="selectFig(f.i)"
            >
              <span class="fig-dot" :class="{ has: f.png }"></span>{{ f.label }}
              <span class="fig-del" @click.stop="removeFig(f.i)">×</span>
            </button>
            <button class="fig-add" @click="addEmptyFig" title="手动添加空白图卡">+</button>
          </div>

          <!-- 预览区 -->
          <div class="fig-preview">
            <div class="preview-wrap">
              <img v-if="selectedFigure?.png" :src="selectedFigure.png" class="fig-preview-img" alt="图表预览" />
              <div v-else class="fig-preview-empty">
                <span>📈</span>
                <p>在左侧对话中描述图表需求, 或点击「+」手动添加图卡</p>
              </div>
              <!-- 真实数据 / 示意图 标注: 不让人把示意数据当真(后端 sampleData 标记) -->
              <div v-if="selectedFigure?.png" class="preview-badge" :class="{ warn: selectedFigure?.sampleData }">
                {{ selectedFigure?.sampleData ? "⚠ 示意图(无真实数据)" : "✓ 真实数据" }}
                <span v-if="!selectedFigure?.sampleData && selectedFigure?.dataFile" class="preview-badge-src">· {{ selectedFigure.dataFile }}</span>
              </div>
            </div>
          </div>

          <!-- 底部信息栏(高度可拖: 数据/图注/代码) -->
          <div class="fig-info" :style="{ height: infoHeight + 'px' }">
            <div class="info-grip" title="拖动调整高度" @mousedown="startInfoResize($event)"></div>
            <div class="info-tabs">
              <button :class="{ active: bottomTab === 'data' }" @click="bottomTab = 'data'">数据</button>
              <button :class="{ active: bottomTab === 'caption' }" @click="bottomTab = 'caption'">图注</button>
              <button :class="{ active: bottomTab === 'code' }" @click="bottomTab = 'code'">代码</button>
              <span class="info-actions">
                <button :disabled="!selectedFigure?.png" @click="exportPng">PNG</button>
                <button :disabled="!selectedFigure?.svg" @click="exportSvg">SVG</button>
                <button :disabled="!selectedFigure?.caption" @click="copyText(selectedFigure?.caption, '图注')">复制图注</button>
                <button :disabled="!selectedFigure?.code" @click="copyText(selectedFigure?.code, '代码')">复制代码</button>
              </span>
            </div>
            <div class="info-body">
              <!-- 数据快照 -->
              <template v-if="bottomTab === 'data'">
                <div v-if="selectedFigure?.dataSnapshot && selectedFigure.dataSnapshot.columns.length" class="data-snapshot">
                  <div class="data-head">
                    <strong>{{ selectedFigure.dataSnapshot.fileName }}</strong>
                    <span v-if="selectedFigure.dataSnapshot.totalRows">{{ selectedFigure.dataSnapshot.totalRows }} 行</span>
                    <span>{{ selectedFigure.dataSnapshot.columns.length }} 列</span>
                    <button class="data-clear" @click="selectedFigure.dataSnapshot = null">清除 ×</button>
                  </div>
                  <div class="data-cols">
                    <span v-for="c in selectedFigure.dataSnapshot.columns.slice(0, 8)" :key="c" class="col-chip">{{ c }}</span>
                  </div>
                  <table class="snap-table">
                    <thead><tr><th v-for="c in selectedFigure.dataSnapshot.columns.slice(0, 6)" :key="c">{{ c }}</th></tr></thead>
                    <tbody>
                      <tr v-for="(r, i) in selectedFigure.dataSnapshot.rows.slice(0, 50)" :key="i">
                        <td v-for="(c, ci) in r.slice(0, 6)" :key="ci">{{ c }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div v-else-if="selectedFigure?.dataSnapshot?.sampleData" class="info-empty warn-empty">
                  该图为<b>示意图</b> — 生成时未绑定真实数据, 数值由模型生成, 不可作为研究结论
                </div>
                <div v-else class="info-empty">暂无绑定数据 — 在左侧「选择数据源」后可回看真实数据</div>
              </template>
              <!-- 图注 -->
              <template v-if="bottomTab === 'caption'">
                <div v-if="selectedFigure?.caption" class="caption-text">{{ selectedFigure.caption }}</div>
                <div v-else class="info-empty">暂无图注, 可在左侧对话中要求 AI 生成图注</div>
                <div v-if="selectedFigure?.analysisText" class="caption-analysis">
                  <span class="caption-analysis-label">分析</span>{{ selectedFigure.analysisText }}
                </div>
              </template>
              <!-- 代码 -->
              <template v-if="bottomTab === 'code'">
                <div v-if="selectedFigure?.code" class="code-panel">
                  <div class="code-panel-head">
                    <span>python</span>
                    <button @click="copyFigCode">复制</button>
                  </div>
                  <div class="code-scroll" v-html="highlightPy(selectedFigure.code)"></div>
                  <div class="code-footer">{{ selectedFigure.code.split('\n').length }} lines</div>
                </div>
                <div v-else class="info-empty">暂无代码</div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- 任务视图 -->
      <div v-else class="viz-task-window">
        <div v-if="jobsLoading" class="task-loading">加载中…</div>
        <div v-else-if="!jobs.length" class="task-empty">
          <p>暂无绘图任务</p>
          <button class="viz-btn" @click="viewTab = 'canvas'">去创建第一个图表 →</button>
        </div>
        <div v-else class="task-grid">
          <article v-for="job in jobs" :key="job.id" class="task-card" @click="selectJob(job)">
            <div class="task-card-head">
              <h3>{{ (job.prompt || job.input?.message || job.title || "未命名绘图任务").slice(0, 40) }}</h3>
              <span class="task-status" :class="'st-' + (job.status === 'done' ? 'completed' : job.status)">{{ job.status === 'done' || job.status === 'completed' ? '已完成' : job.status === 'failed' ? '失败' : job.status === 'running' ? '运行中' : job.status }}</span>
            </div>
            <div class="task-meta">
              <span>{{ (job.created_at ?? '').slice(5, 16).replace('T', ' ') }}</span>
              <span v-if="job.file_name || job.input?.fileName">{{ job.file_name || job.input?.fileName }}</span>
              <span :class="{ 'meta-warn': !(job.file_name || job.input?.fileName) }">{{ (job.file_name || job.input?.fileName) ? "真实数据" : "示意图" }}</span>
              <span>{{ job.chart_count ?? job.chartCount ?? (job.result?.charts?.length ?? 0) }} 张图</span>
            </div>
            <div v-if="job.status === 'failed' && job.error" class="task-error">{{ (job.error.userMessage || job.error.message || "").slice(0, 80) }}</div>
          </article>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.viz-page {
  width: 100%;
  height: 100%;
  min-height: 0;
  margin: 0;
  overflow: auto;
  font-family: PingFang SC, Microsoft YaHei, sans-serif;
  background: #11192C;
}
.viz-workbench {
  width: max(100%, 1024px);
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
@media (max-width: 1100px) {
  .viz-workbench { width: 100%; overflow-x: auto; }
  .viz-canvas-view { min-width: 0 !important; }
}
.viz-header {
  flex-shrink: 0;
  border-bottom: 1px solid #222F44;
  background: #11192C;
}
.viz-title-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 18px;
}
.viz-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  color: #E8EEF7;
}
.viz-tabs {
  display: flex;
  background: #212C45;
  border-radius: 8px;
  padding: 2px;
}
.viz-tab {
  padding: 5px 14px;
  font-size: 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #8B9BB1;
  cursor: pointer;
}
.viz-tab.active { background: #11192C; color: #E8EEF7; font-weight: 600; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08); }
.viz-actions { margin-left: auto; display: flex; gap: 7px; }
.viz-btn {
  padding: 5px 13px;
  font-size: 12px;
  border: 1px solid #9bb8d8;
  border-radius: 7px;
  background: #11192C;
  color: #759FD7;
  cursor: pointer;
}
.viz-btn:hover { background: #161F33; }
.viz-btn.danger { border-color: #3A2323; color: #dc2626; }
.viz-btn.danger.armed { background: #dc2626; color: #F1F5F9; }
.viz-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.viz-canvas-view {
  flex: 1;
  min-height: 0;
  display: flex;
}
.chat-col {
  flex-shrink: 0;
  min-width: 220px;
  max-width: 480px;
  border-right: 1px solid #222F44;
  min-height: 0;
  display: flex;
}
.chat-col > * { flex: 1; min-width: 0; }
.chat-resizer {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  flex-shrink: 0;
}
.chat-resizer:hover { background: #4D84CB; }
.canvas-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #1A2333;
}
.fig-tabs {
  display: flex;
  gap: 5px;
  padding: 8px 12px;
  border-bottom: 1px solid #222F44;
  background: #11192C;
  overflow-x: auto;
  flex-shrink: 0;
}
.fig-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 11.5px;
  border: 1px solid #222F44;
  border-radius: 7px;
  background: #11192C;
  color: #8B9BB1;
  cursor: pointer;
  white-space: nowrap;
}
.fig-tab.active {
  border-color: #4D84CB;
  color: #4D84CB;
  background: #1E2A48;
}
.fig-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #222F44;
}
.fig-dot.has { background: #5FD0B4; }
.fig-del { color: #7A8AA0; font-size: 12px; }
.fig-del:hover { color: #dc2626; }
.fig-add {
  padding: 5px 11px;
  font-size: 13px;
  border: 1px dashed #9bb8d8;
  border-radius: 7px;
  background: #11192C;
  color: #759FD7;
  cursor: pointer;
}
.fig-preview {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  overflow: auto;
}
.preview-wrap { position: relative; display: inline-flex; max-width: 100%; max-height: 100%; }
.preview-badge {
  position: absolute;
  left: 8px;
  bottom: 8px;
  max-width: calc(100% - 16px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 9px;
  border-radius: 10px;
  background: rgba(20, 40, 31, 0.86);
  color: #5FD0B4;
  font-size: 10px;
}
.preview-badge.warn { background: rgba(58, 43, 17, 0.9); color: #E8B75F; }
.preview-badge-src { color: #9EC7B7; }
.fig-preview-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 4px;
  box-shadow: 0 2px 12px rgba(15, 23, 42, 0.08);
}
.fig-preview-empty {
  text-align: center;
  color: #7A8AA0;
}
.fig-preview-empty span { font-size: 42px; }
.fig-preview-empty p { font-size: 12px; }
.fig-info {
  position: relative;
  flex-shrink: 0;
  border-top: 1px solid #222F44;
  background: #11192C;
  display: flex;
  flex-direction: column;
}
.info-grip {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
  cursor: ns-resize;
  z-index: 5;
}
.info-grip::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
  width: 34px;
  height: 2px;
  border-radius: 1px;
  background: #46587A;
  opacity: 0;
  transition: opacity 0.15s;
}
.info-grip:hover::after { opacity: 1; }
.info-grip:hover { background: rgba(77, 132, 203, 0.14); }

.info-tabs {
  display: flex;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid #222F44;
  flex-shrink: 0;
}
.info-tabs button {
  padding: 7px 14px;
  font-size: 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: #8B9BB1;
  cursor: pointer;
}
.info-tabs button.active { color: #759FD7; border-bottom-color: #759FD7; font-weight: 600; }
.info-actions { margin-left: auto; display: flex; align-items: center; gap: 4px; }
.info-actions button {
  padding: 3px 9px;
  font-size: 10.5px;
  border: 1px solid #46587A;
  border-radius: 6px;
  background: #11192C;
  color: #A3B3C8;
  cursor: pointer;
}
.info-actions button:hover:not(:disabled) { border-color: #4D84CB; color: #4D84CB; }
.info-actions button:disabled { opacity: 0.4; cursor: not-allowed; }
.info-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 14px;
}
.info-empty {
  color: #7A8AA0;
  font-size: 12px;
  text-align: center;
  padding: 30px 0;
}
.info-empty.warn-empty {
  color: #d9a441;
  line-height: 1.8;
  max-width: 420px;
  margin: 0 auto;
}
.info-empty.warn-empty b { color: #E8B75F; }
.data-snapshot { display: flex; flex-direction: column; gap: 8px; }
.data-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.data-head strong { color: #E8EEF7; }
.data-head span { color: #8B9BB1; }
.data-clear {
  margin-left: auto;
  border: 0;
  background: #212C45;
  color: #8B9BB1;
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 4px;
  cursor: pointer;
}
.data-cols { display: flex; flex-wrap: wrap; gap: 4px; }
.col-chip {
  padding: 2px 8px;
  font-size: 10.5px;
  border: 1px solid #222F44;
  border-radius: 10px;
  background: #1A2333;
  color: #8B9BB1;
  font-family: ui-monospace, monospace;
}
.snap-table { border-collapse: collapse; font-size: 11px; }
.snap-table th, .snap-table td {
  border: 1px solid #222F44;
  padding: 3px 8px;
  text-align: left;
}
.snap-table th { background: #1A2333; color: #8B9BB1; }
.caption-text {
  font-size: 12.5px;
  color: #DCE6F2;
  line-height: 1.7;
  white-space: pre-wrap;
}
.caption-analysis {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed #222F44;
  font-size: 11.5px;
  color: #A3B3C8;
  line-height: 1.7;
}
.caption-analysis-label {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  background: #1E2A48;
  color: #8FD0FF;
  font-size: 10px;
}
.code-panel {
  border: 1px solid #DCE6F2;
  border-radius: 8px;
  overflow: hidden;
  background: #0f172a;
}
.code-panel-head {
  display: flex;
  justify-content: space-between;
  padding: 4px 10px;
  background: #1e293b;
  color: #7A8AA0;
  font-size: 11px;
  font-family: ui-monospace, monospace;
}
.code-panel-head button {
  border: 0;
  background: transparent;
  color: #a5b4fc;
  cursor: pointer;
  font-size: 11px;
}
.code-scroll {
  padding: 8px 10px;
  max-height: 170px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.55;
}
.code-line { display: flex; }
.line-no {
  flex: 0 0 30px;
  color: #8B9BB1;
  text-align: right;
  padding-right: 10px;
  user-select: none;
}
.line-code { color: #222F44; white-space: pre; }
.code-footer {
  padding: 4px 10px;
  border-top: 1px solid #1e293b;
  color: #8B9BB1;
  font-size: 10px;
  font-family: ui-monospace, monospace;
}
.code-scroll :deep(.hl-kw) { color: #c084fc; font-weight: 600; }
.code-scroll :deep(.hl-str) { color: #3A3020; }
.code-scroll :deep(.hl-cmt) { color: #7A8AA0; font-style: italic; }
.code-scroll :deep(.hl-num) { color: #fb923c; }
.code-scroll :deep(.hl-fn) { color: #60a5fa; }
.viz-task-window {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  scrollbar-width: thin;
  scrollbar-color: #46587A transparent;
}
.task-loading, .task-empty {
  padding: 60px;
  text-align: center;
  color: #7A8AA0;
  font-size: 13px;
}
.task-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.task-card {
  padding: 14px;
  border: 1px solid #222F44;
  border-radius: 10px;
  background: #11192C;
  cursor: pointer;
  transition: all 0.15s;
}
.task-card:hover { border-color: #93c5fd; box-shadow: 0 4px 14px rgba(37, 99, 235, 0.08); transform: translateY(-2px); }
.task-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.task-card-head h3 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: #E8EEF7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-status {
  flex-shrink: 0;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
}
.st-completed { background: #14281F; color: #5FD0B4; }
.st-failed { background: #2A1C1C; color: #dc2626; }
.st-running { background: #1E2A48; color: #2563eb; }
.st-queued { background: #212C45; color: #8B9BB1; }
.st-cancelled { background: #1A2333; color: #7A8AA0; }
.task-meta {
  display: flex;
  gap: 12px;
  margin-top: 7px;
  font-size: 11px;
  color: #7A8AA0;
}
.task-meta .meta-warn { color: #d9a441; }
.task-error {
  margin-top: 7px;
  padding: 6px 9px;
  background: #2A1C1C;
  border-radius: 6px;
  color: #dc2626;
  font-size: 11px;
}
</style>
