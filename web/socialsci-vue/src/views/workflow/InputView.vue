<script setup lang="ts">
/**
 * InputView(Phase1 信息录入) — 还原自闭源 InputView-DwlhRWpv.js(L616-1471)
 * 主题/字数预估/大纲 OutlineEditor/额外要求/方法 3 卡/参考文件/agent 引导提问手风琴 → submitAnalysis
 * 提交链: 校验 → 建项目(template five-stage) → 写 input 节点 → phase=2 → /workflow/sections
 */
import { ref, computed, watch, onMounted } from "vue";
import { useRouter } from "vue-router";
import OutlineEditor from "./OutlineEditor.vue";
import { useWorkflowStore } from "./stores/workflow";
import { toast } from "@/shared/ui";
import { putNode, createTask } from "@/shared/tasks";
import PhaseProgressBar from "./PhaseProgressBar.vue";

const router = useRouter();
const store = useWorkflowStore();

// ── 拖拽文件 ──
const fileDragover = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const canSubmit = computed(() => {
  const title = store.input.title.trim();
  const outline = store.input.outline.trim();
  return title.length >= 4 && !/^\d+$/.test(title) && !!outline;
});

// ── 方法选择 ──
const METHODS = [
  { id: "qualitative", label: "定性研究", desc: "案例 / 访谈 / 文本分析" },
  { id: "quantitative", label: "定量研究", desc: "问卷 / 实证 / 统计分析" },
  { id: "mixed", label: "混合方法", desc: "定性 + 定量结合" }
];

// E2: 方法自动识别(闭源: 用户未手动选择 → 系统按标题+要求启发式识别并提示)
function inferMethod(txt: string): string {
  const quantWords = ["实证", "问卷", "回归", "显著性", "中介效应", "驱动因素", "影响因素", "数据分析", "模型", "检验"];
  const qualWords = ["案例", "访谈", "文本分析", "叙事", "现象学", "扎根", "田野"];
  const qn = quantWords.filter((w) => txt.includes(w)).length;
  const ql = qualWords.filter((w) => txt.includes(w)).length;
  return qn >= 2 && ql >= 2 ? "mixed" : qn >= 2 ? "quantitative" : ql >= 2 ? "qualitative" : "";
}
const researchMethodAuto = computed(() => {
  if (store.input.researchMethod) return false;
  const txt = store.input.title + store.input.requirements;
  return txt.trim().length >= 6 && !!inferMethod(txt);
});
const methodAutoLabel = computed(() => {
  const map: Record<string, string> = { qualitative: "定性研究", quantitative: "定量研究", mixed: "混合方法" };
  const t = store.input.title + store.input.requirements;
  return map[inferMethod(t)] ?? "";
});
function pickMethod(id: string) {
  store.input.researchMethod = id;
  autoSave();
}

// ── 自动草稿(闭源 autoSaveDraft: skf_draft) ──
function autoSave() {
  try {
    localStorage.setItem(
      "skf_draft",
      JSON.stringify({ title: store.input.title, outline: store.input.outline, requirements: store.input.requirements, researchMethod: store.input.researchMethod, totalWordCount: store.input.totalWordCount })
    );
  } catch { /* 忽略 */ }
}
function loadDraft() {
  try {
    const raw = localStorage.getItem("skf_draft");
    if (!raw) return;
    const d = JSON.parse(raw);
    if (typeof d.title === "string") store.input.title = d.title;
    if (typeof d.outline === "string") store.input.outline = d.outline;
    if (typeof d.requirements === "string") store.input.requirements = d.requirements;
    if (typeof d.researchMethod === "string") store.input.researchMethod = d.researchMethod;
    if (typeof d.totalWordCount === "number") store.input.totalWordCount = d.totalWordCount;
  } catch { /* 忽略 */ }
}

// ── 参考文件解析(txt/docx/pdf; 闭源 st/Q/rt 三管道) ──
async function readFileAsText(file: File): Promise<string> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const pdfjs = await import("pdfjs-dist");
    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    let out = "";
    for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      out += tc.items.map((it: unknown) => (it as { str?: string }).str ?? "").join("") + "\n";
    }
    return out;
  }
  if (lower.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const r = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return r.value ?? "";
  }
  return await file.text();
}

async function handleFile(file: File) {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!["txt", "doc", "docx", "pdf", "md"].includes(ext)) {
    toast(`不支持的文件格式: .${ext}(支持 .txt/.docx/.pdf)`, "error");
    return;
  }
  try {
    const content = await readFileAsText(file);
    store.input.sampleFiles.push({ name: file.name, size: file.size, content: content.slice(0, 200_000) });
    toast(`已读取: ${file.name}`, "success");
    autoSave();
  } catch (e) {
    toast(`读取失败: ${(e as Error).message}`, "error");
  }
}
function onDrop(ev: DragEvent) {
  fileDragover.value = false;
  for (const f of ev.dataTransfer?.files ?? []) void handleFile(f);
}
function removeFile(i: number) {
  store.input.sampleFiles.splice(i, 1);
  autoSave();
}

// ── 澄清问答(闭源 4 态手风琴; POST /api/clarify/generate) ──
const clarify = ref<{ state: "idle" | "loading" | "done" | "error"; questions: Array<{ id: string; category: string; question: string; guidance: string; importance: string; answer?: string }>; error: string }>({
  state: "idle", questions: [], error: ""
});
let clarifyAbort: AbortController | null = null;

async function runClarify() {
  clarify.value.state = "loading";
  clarify.value.questions = [];
  clarifyAbort?.abort();
  clarifyAbort = new AbortController();
  try {
    const body = {
      title: store.input.title,
      outline: store.input.outline,
      requirements: store.input.requirements,
      researchMethod: store.input.researchMethod,
      totalWordCount: store.input.totalWordCount,
      sampleContent: store.input.sampleFiles.map((f) => f.content.slice(0, 3000)).join("\n\n").slice(0, 8000)
    };
    const r = await fetch("/api/clarify/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}`
      },
      body: JSON.stringify(body),
      signal: clarifyAbort.signal
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const qs = j?.data?.questions ?? j?.questions ?? [];
    if (!Array.isArray(qs) || !qs.length) {
      clarify.value.state = "done";
      clarify.value.questions = [];
      return;
    }
    clarify.value.state = "done";
    clarify.value.questions = qs.map((q: Record<string, unknown>) => {
      // 后端缺 id 时用 序号+question 前 12 字作稳定 key(避免随机 key 导致答案无法回填)
      const rawId = String(q.id ?? "").trim();
      const stableId = rawId || `q_${String(q.question ?? "").slice(0, 12).replace(/\s/g, "_")}`;
      return {
        id: stableId,
        category: String(q.category ?? "general"),
        question: String(q.question ?? ""),
        guidance: String(q.guidance ?? ""),
        importance: String(q.importance ?? "normal"),
        answer: store.input.clarifyAnswers[stableId] ?? store.input.clarifyAnswers[rawId] ?? ""
      };
    });
    toast(`AI 生成了 ${qs.length} 个引导问题`, "success");
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    clarify.value.state = "error";
    clarify.value.error = String((e as Error).message ?? e);
  }
}
function setAnswer(q: { id: string }, v: string) {
  store.input.clarifyAnswers[q.id] = v;
  autoSave();
}

// ── 提交(闭源 submitAnalysis → W()): 建项目 → 写 input 节点 → phase2 ──
const submitting = ref(false);
async function submitAnalysis() {
  if (submitting.value) return; // 防双击重复建项目
  if (!canSubmit.value) {
    if (store.input.title.trim().length < 4 || /^\d+$/.test(store.input.title.trim())) toast("请填写有效的研究主题(至少 4 个字符)", "warning");
    else if (!store.input.outline.trim()) toast("请填写章节大纲", "warning");
    return;
  }
  submitting.value = true;
  try {
    // researchMethod 启发式(闭源 wp: 定量/定性关键词计分)
    if (!store.input.researchMethod) {
      const txt = store.input.title + store.input.requirements;
      const quantWords = ["实证", "问卷", "回归", "显著性", "中介效应", "驱动因素", "影响因素", "数据分析", "模型"];
      const qualWords = ["案例", "访谈", "文本分析", "叙事", "现象学", "扎根"];
      const qn = quantWords.filter((w) => txt.includes(w)).length;
      const ql = qualWords.filter((w) => txt.includes(w)).length;
      store.input.researchMethod = qn >= 2 && ql >= 2 ? "mixed" : qn >= 2 ? "quantitative" : ql >= 2 ? "qualitative" : "";
    }
    const pid = await store.ensureTask(store.input.title || "未命名科研任务");
    // 建项目(若 ensureTask 未建)
    if (!pid) {
      toast("项目创建失败", "error");
      return;
    }
    // 写 input 节点(快照)
    await putNode(pid, "input", {
      title: store.input.title,
      outline: store.input.outline,
      requirements: store.input.requirements,
      researchMethod: store.input.researchMethod,
      totalWordCount: Number(store.input.totalWordCount) || 10000,
      sampleFiles: store.input.sampleFiles,
      clarifyAnswers: store.input.clarifyAnswers,
      updatedAt: new Date().toISOString()
    }).catch(() => null);
    store.phase = 2;
    store.phaseLabel = "科研架构";
    await store.saveProject();
    localStorage.removeItem("skf_draft");
    toast("提交成功, 进入科研架构分析", "success");
    void router.push("/workflow/sections");
  } catch (e) {
    toast(`提交失败: ${(e as Error).message}`, "error");
  } finally {
    submitting.value = false;
  }
}

watch(() => store.input.title, () => autoSave());
watch(() => store.input.outline, () => autoSave());

onMounted(async () => {
  await store.loadProject().catch(() => null);
  // 草稿仅在「无已存项目输入」时恢复(否则旧草稿会覆盖服务端快照的项目内容)
  const hasSaved = !!store.taskId && !!(store.input.title || store.input.outline);
  if (!hasSaved) loadDraft();
});
</script>

<template>
  <div class="workflow-page max-w-4xl mx-auto px-6 py-8 pb-16 min-w-0 h-full overflow-y-auto" data-assistant-async-busy="false">
    <PhaseProgressBar />
    <h1 class="wf-h1">信息录入</h1>
    <p class="wf-sub">填写研究主题、论文框架与基本信息, AI 将据此生成科研架构。</p>

    <!-- 研究主题 -->
    <section class="wf-card">
      <label class="wf-label">
        研究主题
        <span class="req-star">*</span>
      </label>
      <input
        v-model="store.input.title"
        class="wf-input"
        placeholder="例如:数字经济背景下中小企业融资困境与对策研究"
        data-assistant-control="workflow_research_title"
      />
    </section>

    <!-- 字数预估 -->
    <section class="wf-card">
      <label class="wf-label">字数预估</label>
      <input
        v-model.number="store.input.totalWordCount"
        type="number"
        min="3000"
        max="50000"
        step="1000"
        class="wf-input"
        data-assistant-control="workflow_total_word_count"
      />
      <p class="wf-note">字数估算仅计算正文整体工作量(不含摘要、关键词、参考文献等内容),AI 智能体将按此字数进行科研分配。</p>
    </section>

    <!-- 大纲(OutlineEditor) -->
    <section class="wf-card">
      <label class="wf-label">
        研究框架(章节大纲)
        <span class="req-star">*</span>
      </label>
      <OutlineEditor v-model="store.input.outline" />
      <!-- sr-only 同步真源(DOM 自动化/爬虫可见) -->
      <textarea class="sr-only" :value="store.input.outline" data-assistant-control="workflow_outline" tabindex="-1" aria-hidden="true" style="position: absolute; width: 1px; height: 1px; opacity: 0"></textarea>
    </section>

    <!-- 额外要求 -->
    <section class="wf-card">
      <label class="wf-label">额外要求</label>
      <input
        v-model="store.input.requirements"
        class="wf-input"
        placeholder="例如: 近3年文献 / 实证方法 / 8000-10000字 / 江苏省中小企业"
        data-assistant-control="workflow_requirements"
      />
    </section>

    <!-- 研究方法 -->
    <section class="wf-card">
      <label class="wf-label">研究方法</label>
      <div class="method-grid">
        <button
          v-for="m in METHODS"
          :key="m.id"
          type="button"
          class="method-card"
          :class="{ selected: store.input.researchMethod === m.id }"
          :aria-pressed="store.input.researchMethod === m.id"
          :data-assistant-control="'workflow_method_' + m.id"
          @click="pickMethod(m.id)"
        >
          <strong>{{ m.label }}</strong>
          <small>{{ m.desc }}</small>
        </button>
      </div>
      <p class="wf-note">如不确定可跳过, 系统将根据标题和目录自动识别。</p>
      <p v-if="researchMethodAuto" class="auto-detect-note">📎 已根据标题和目录自动识别: {{ methodAutoLabel }}</p>
    </section>

    <!-- 参考文件 -->
    <section class="wf-card">
      <label class="wf-label">参考文件(可选)</label>
      <div
        class="drop-zone"
        :class="{ dragover: fileDragover }"
        @click="fileInput?.click()"
        @dragover.prevent="fileDragover = true"
        @dragleave="fileDragover = false"
        @drop.prevent="onDrop"
      >
        <p>点击或拖拽上传参考文件(.pdf/.doc/.docx/.txt/.md)</p>
        <input ref="fileInput" type="file" multiple accept=".pdf,.doc,.docx,.txt,.md" style="display: none" @change="(ev) => { for (const f of (ev.target as HTMLInputElement).files ?? []) void handleFile(f); (ev.target as HTMLInputElement).value = ''; }" />
      </div>
      <div v-if="store.input.sampleFiles.length" class="file-list">
        <div v-for="(f, i) in store.input.sampleFiles" :key="i" class="file-row">
          <span class="file-icon">📄</span>
          <span class="file-name">{{ f.name }}</span>
          <span class="file-size">{{ (f.size / 1024).toFixed(0) }}KB</span>
          <span class="file-status ok">✓ 已读取</span>
          <button class="file-remove" @click="removeFile(i)">移除</button>
        </div>
      </div>
    </section>

    <!-- agent 引导提问 -->
    <section class="wf-card">
      <div class="clarify-head">
        <label class="wf-label" style="margin: 0">Agent 引导提问</label>
        <span class="rec-badge">推荐</span>
      </div>
      <div v-if="clarify.state === 'idle'" class="clarify-idle">
        <button type="button" class="btn-secondary" @click="runClarify">AI 分析我的研究</button>
        <p>大模型理解内容并生成针对性问题, 最长约 3 分钟</p>
      </div>
      <div v-else-if="clarify.state === 'loading'" class="clarify-loading">
        <span class="mini-spinner"></span>
        <p>AI 正在分析你的研究... 调用大模型理解内容并生成针对性问题, 最长约 3 分钟</p>
      </div>
      <div v-else-if="clarify.state === 'error'" class="clarify-error">
        <p>⚠ 引导问题生成失败: {{ clarify.error }}</p>
        <button type="button" class="btn-secondary" @click="runClarify">重新生成引导问题</button>
      </div>
      <div v-else-if="!clarify.questions.length" class="clarify-done-empty">
        <p>AI 未发现需要补充的引导问题。</p>
        <button type="button" class="btn-secondary" @click="runClarify">重新分析</button>
      </div>
      <div v-else class="clarify-list">
        <div v-for="q in clarify.questions" :key="q.id" class="clarify-item">
          <div class="cq-head">
            <span class="cq-cat">{{ q.category }}</span>
            <span v-if="q.importance === '高'" class="cq-imp">核心问题</span>
          </div>
          <p class="cq-question">{{ q.question }}</p>
          <p class="cq-guidance">{{ q.guidance }}</p>
          <textarea v-model="q.answer" class="cq-input" rows="2" placeholder="你的回答…" @input="setAnswer(q, ($event.target as HTMLTextAreaElement).value)"></textarea>
        </div>
      </div>
    </section>

    <!-- 底部操作 -->
    <div class="wf-actions">
      <button type="button" class="btn-back" @click="router.push('/workflow')">返回</button>
      <button
        type="button"
        class="btn-primary"
        :disabled="!canSubmit"
        data-assistant-control="workflow_submit_analysis"
        @click="submitAnalysis"
      >开始思考科研架构</button>
    </div>
  </div>
</template>

<style scoped>

.workflow-page { width: 100%; box-sizing: border-box; }
.wf-h1 { margin: 0 0 4px; font-size: 22px; font-weight: 700; color: #E8EEF7; }
.wf-sub { margin: 0 0 18px; font-size: 13px; color: #8B9BB1; }
.wf-card {
  background: #11192C;
  border: 1px solid #222F44;
  border-radius: 12px;
  padding: 16px 18px;
  margin-bottom: 14px;
}
.wf-label { display: flex; align-items: center; gap: 4px; font-size: 14px; font-weight: 600; color: #E8EEF7; margin-bottom: 8px; }
.req-star { color: #dc2626; }
.wf-input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  border: 1px solid #46587A;
  border-radius: 8px;
  font-size: 13.5px;
  background: #11192C;
  outline: none;
}
.wf-input:focus { border-color: #E67E7E; box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.12); }
.wf-note { margin: 6px 0 0; font-size: 11.5px; color: #8B9BB1; line-height: 1.5; }
.method-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
/* E2 自动识别提示 */
.auto-detect-note {
  margin: 6px 0 0; font-size: 12px; color: #E8B54A; background: #11192Cbeb;
  border: 1px dashed #C9A23C; border-radius: 7px; padding: 6px 10px;
}

.method-card {
  padding: 14px;
  border: 2px solid #1A2333;
  border-radius: 12px;
  background: #11192C;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
}
.method-card strong { font-size: 14px; color: #E8EEF7; }
.method-card small { font-size: 11.5px; color: #8B9BB1; }
.method-card.selected { border-color: #dc2626; background: #2A1C1C; box-shadow: 0 1px 4px rgba(220, 38, 38, 0.1); }
.drop-zone {
  border: 2px dashed #46587A;
  border-radius: 10px;
  padding: 22px;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s;
}
.drop-zone.dragover { border-color: #dc2626; background: #2A1C1C; }
.drop-zone p { margin: 0; font-size: 13px; color: #8B9BB1; }
.file-list { margin-top: 8px; display: flex; flex-direction: column; gap: 5px; }
.file-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border: 1px solid #222F44; border-radius: 7px; font-size: 12.5px;
}
.file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #DCE6F2; }
.file-size { color: #7A8AA0; font-size: 11px; }
.file-status.ok { color: #5FD0B4; font-size: 11.5px; }
.file-remove { border: 0; background: none; color: #dc2626; font-size: 12px; cursor: pointer; }
.clarify-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.rec-badge { font-size: 10px; padding: 2px 8px; background: #dc2626; color: #F1F5F9; border-radius: 8px; }
.clarify-idle, .clarify-loading, .clarify-error, .clarify-done-empty { text-align: center; padding: 14px 0; }
.clarify-idle p, .clarify-loading p, .clarify-error p, .clarify-done-empty p { font-size: 12px; color: #8B9BB1; margin: 8px 0 0; }
.clarify-error p { color: #dc2626; }
.btn-secondary {
  padding: 7px 16px;
  border: 1px solid #222F44;
  border-radius: 8px;
  background: #11192C;
  color: #DCE6F2;
  font-size: 13px;
  cursor: pointer;
}
.mini-spinner {
  display: inline-block;
  width: 18px; height: 18px;
  border: 2px solid #222F44; border-top-color: #dc2626;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.clarify-list { display: flex; flex-direction: column; gap: 10px; }
.clarify-item { border: 1px solid #222F44; border-radius: 10px; padding: 12px; }
.cq-head { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.cq-cat {
  font-size: 10.5px; padding: 2px 9px; border-radius: 9px;
  background: #1E2A48; color: #8BA4F0;
}
.cq-imp { font-size: 10px; padding: 2px 7px; background: #3A2323; color: #dc2626; border-radius: 8px; font-weight: 600; }
.cq-question { margin: 0 0 4px; font-size: 13.5px; color: #E8EEF7; font-weight: 600; }
.cq-guidance { margin: 0 0 8px; font-size: 12px; color: #8B9BB1; }
.cq-input {
  width: 100%; box-sizing: border-box;
  padding: 7px 10px; border: 1px solid #222F44; border-radius: 7px;
  font-size: 12.5px; font-family: inherit; resize: vertical;
}
.wf-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
.btn-back {
  padding: 10px 22px;
  border: 1px solid #222F44;
  border-radius: 9px;
  background: #11192C;
  color: #8B9BB1;
  font-size: 14px;
  cursor: pointer;
}
.btn-primary {
  padding: 10px 26px;
  border: 0;
  border-radius: 9px;
  background: #dc2626;
  color: #F1F5F9;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary:hover { background: #E06B6B; }
.btn-primary:disabled { background: #46587A; cursor: not-allowed; }
.sr-only { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
</style>
