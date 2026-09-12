<script setup lang="ts">
/**
 * Editor 主组件 — 还原自闭源 EditorView 默认导出(E:39364, scope data-v-8380a051)
 * 三栏布局: TopBar + SideBar(doc rail) + 编辑区(工具栏+A4 纸面) + AIPanel(右抽屉)
 * 编排语义: 1200ms 防抖自动保存 / currentContent 双向同步(JSON diff 才 setContent)
 * / 路由意图(?new=1&dialog=1 / ?new=1 / ?documentId=N) / ctrl+s 拦截 / beforeunload flush
 * / ai-apply + ai-insert-chart 事件落地(mermaid/echarts 离屏渲染 → dataURL → 插图)
 */
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { EditorContent, createAcademicEditor, type Editor } from "./tiptapSetup";
import TopBar from "./TopBar.vue";
import SideBar from "./SideBar.vue";
import AIPanel from "./AIPanel.vue";
import VersionHistory from "./VersionHistory.vue";
import { useDocumentStore } from "./stores/document";
import { useEditorAiStore } from "./stores/editorAi";
import { EVT, K } from "@/shared/constants";
import { toast } from "@/shared/ui";
import { base64ToBlob } from "@/shared/editorApi";

const route = useRoute();
const router = useRouter();
const store = useDocumentStore();
const ai = useEditorAiStore();

const versionOpen = ref(false);
const aiOpen = computed({
  get: () => ai.panelOpen,
  set: (v: boolean) => {
    ai.panelOpen = v;
  }
});
const saveTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const docReady = ref(true);
let storeSet = false; // 抑制 setContent 触发的 onUpdate 误标未保存

/**
 * store 里存的是 JSON 字符串(getJSON→JSON.stringify), 但 tiptap setContent 收到字符串会当 HTML 解析,
 * 把整段 JSON 当纯文本节点插进正文 → 保存后再读入就变成"正文里嵌着一层 JSON", 逐次开合层层嵌套。
 * 故喂给 setContent 前必须先 JSON.parse 还原成对象; 非 JSON(纯 HTML/markdown 转来的)按原样传。
 */
function parseStoredContent(content: string): Record<string, unknown> | string {
  const t = content.trim();
  if (!t.startsWith("{")) return content;
  try {
    const j = JSON.parse(t) as Record<string, unknown>;
    return j && typeof j === "object" && "type" in j ? j : content;
  } catch {
    return content;
  }
}
// ── 2026-09-10: 视图基础控件(字号/页面/缩放 — 纯 CSS 变量, 不写入文档内容) ──
const docFontSize = ref(15);
const paperMode = ref("a4");
const zoomPct = ref(100);
const paperCss = computed(() => {
  const w = paperMode.value === "a4" ? "210mm" : paperMode.value === "letter" ? "216mm" : "100%";
  const h = paperMode.value === "wide" ? "min(297mm, auto)" : "297mm";
  return { width: w, minHeight: h };
});
function setDocFontSize(v: number) { docFontSize.value = v; }
function setPaperMode(m: string) { paperMode.value = m; }
function setZoom(z: number) { zoomPct.value = Math.min(200, Math.max(50, z)); }
function stepZoom(d: number) { setZoom(zoomPct.value + d); }

const editorRef = createAcademicEditor({
  content: "",
  onUpdate: (json) => {
    if (!storeSet || !store.currentDocument) return;
    store.currentContent = JSON.stringify(json); // store 存字符串(后端契约)
    store.markUnsaved();
    scheduleAutoSave();
  }
});
const editor = computed(() => editorRef.value);

function scheduleAutoSave() {
  if (saveTimer.value) clearTimeout(saveTimer.value);
  saveTimer.value = setTimeout(async () => {
    await store.saveNow();
  }, 1200); // 闭源 1200ms 防抖
}

function flushAndSave() {
  if (saveTimer.value) {
    clearTimeout(saveTimer.value);
    saveTimer.value = null;
  }
  void store.flushSave();
}

/** 版本恢复完成(审查修复: 原 @restored 无人监听 → tiptap 正文不刷新 + 自动保存覆盖还原) */
async function onVersionRestored() {
  const id = store.currentDocument?.id;
  if (!id) return;
  const ed = editorRef.value;
  if (saveTimer.value) { clearTimeout(saveTimer.value); saveTimer.value = null; }
  // 服务端已切到目标版本 → 重拉全文刷新编辑器
  const ok = await store.fetchDocument(id);
  if (!ok) { toast("恢复后刷新文档失败", "error"); return; }
  await nextTick();
  if (!ed || !store.currentDocument) return;
  const content = store.currentContent ?? "";
  if (content.trim()) {
    storeSet = false;
    try { ed.commands.setContent(parseStoredContent(content) as never); } finally { storeSet = true; }
  }
  toast(`已恢复至目标版本并刷新正文`, "success");
}

// ── 双向同步: currentDocument 变化 → setContent(字符串内容直接喂 tiptap) ──
watch(
  () => store.currentDocument?.id,
  async () => {
    if (!store.currentDocument) return;
    await nextTick();
    const ed = editorRef.value;
    if (!ed) return;
    const content = store.currentContent ?? "";
    storeSet = false;
    try {
      // 打开空文档必须清空编辑器 — 否则上一篇正文残留, 紧接着的自动保存会把它写进新文档
      // (placeholder 是 Tiptap 装饰, 不属于 content, 清空不影响其显示)
      if (!content.trim()) {
        if (ed.state.doc.content.size > 0) ed.commands.clearContent(true);
      } else {
        const parsed = parseStoredContent(content);
        const curJson = JSON.stringify(ed.getJSON());
        const same = curJson === (typeof content === "string" ? content : "");
        if (!same) {
          ed.commands.setContent(parsed as never);
        }
      }
    } finally {
      storeSet = true;
    }
    docReady.value = true;
  }
);

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    flushAndSave();
    toast("已保存", "success");
  }
}

/** 读取并**消费**跨视图交接内容(读后即删: 否则下次手动新建文档会被旧内容覆盖) */
function readDocHandoff(): { markdown: string; title: string } | null {
  try {
    const raw = localStorage.getItem("skf_doc_handoff");
    if (!raw) return null;
    localStorage.removeItem("skf_doc_handoff");
    const d = JSON.parse(raw) as { markdown?: unknown; title?: unknown };
    const markdown = String(d?.markdown ?? "");
    if (!markdown.trim()) return null;
    return { markdown, title: String(d?.title ?? "未命名学术文档") };
  } catch {
    localStorage.removeItem("skf_doc_handoff");
    return null;
  }
}

// ── 路由意图 ──
async function handleRouteIntent() {
  const query = route.query;
  if (query.documentId) {
    const ok = await store.fetchDocument(String(query.documentId));
    if (!ok) toast("打开文档失败", "error");
    return;
  }
  if (query.new) {
    if (query.dialog) {
      window.dispatchEvent(new CustomEvent(EVT.editorOpenNewDocument));
    } else {
      // 交接内容(2026-09-12): 审稿页"把批注发到编辑器"会写这个键 + 带 ?new=1 跳转过来。
      //   由**读方主动取**, 不依赖发送方猜接收方是否已挂载(那边原本想用 postMessage 轮询)。
      const handoff = readDocHandoff();
      if (handoff) {
        const id = await store.createDocument(handoff.title || "未命名学术文档");
        if (id) {
          try {
            const { marked } = await import("marked");
            const html = (marked as unknown as { parse: (md: string) => string }).parse(handoff.markdown) as string;
            // 同 onAppInsertDoc 的做法: 写内容前关掉 store 同步, 避免把 setContent 当成用户编辑写回旧文档
            storeSet = false;
            editorRef.value?.commands.setContent(html);
            storeSet = true;
            toast(`已新建文档「${handoff.title}」`, "success");
          } catch {
            toast("内容渲染失败, 已建空文档", "warning");
          }
        } else {
          toast("创建文档失败", "error");
        }
      } else {
        await store.createDocument("未命名学术文档");
      }
    }
    void router.replace({ query: {} });
    return;
  }
  const lastId = localStorage.getItem(K.editorActiveDocumentId);
  if (lastId) {
    const ok = await store.fetchDocument(lastId);
    if (!ok) {
      localStorage.removeItem(K.editorActiveDocumentId);
    }
    // 无论成败都刷新列表(打开成功但列表未同步的场景)
    await store.fetchDocuments();
  } else {
    await store.fetchDocuments();
  }
  // editor.activeJobId → 自动开 AI 面板恢复
  const job = localStorage.getItem(K.editorActiveJobId);
  if (job) {
    ai.panelOpen = true;
    await ai.recoverActiveJob({
      onDone: (content) => {
        if (content) toast("上次任务结果已恢复", "success");
      }
    });
  }
}

function onWordImport(e: Event) {
  const detail = (e as CustomEvent).detail as { html?: string; title?: string };
  const ed = editorRef.value;
  if (!detail?.html || !ed) return;
  storeSet = false;
  ed.commands.setContent(detail.html as never);
  storeSet = true;
  store.markUnsaved();
  void store.saveNow();
}

// ── 2026-09-10 统一分析台「✎ 写入论文」: 父级 postMessage → markdown 转 HTML → 新文档 ──
async function onAppInsertDoc(e: MessageEvent) {
  const d = e.data;
  if (!d || d.source !== "marxsphere-app") return;
  // 统一分析台数据集 → 转给 AI 面板「图表」tab 复用(同源 window 事件传递)
  if (d.type === "empirical-dataset" && d.csv && Array.isArray(d.columnOrder)) {
    window.dispatchEvent(new CustomEvent(EVT.empiricalDataset, {
      detail: { csv: String(d.csv), columnOrder: d.columnOrder.map(String), fileName: String(d.fileName ?? "实证数据集") },
    }));
    return;
  }
  if (d.type !== "empirical-insert-doc" || !d.markdown) return;
  try {
    const { marked } = await import("marked");
    const html = (marked as unknown as { parse: (md: string) => string }).parse(String(d.markdown)) as string;
    const id = await store.createDocument(String(d.title ?? "分析结果"));
    if (!id) { toast("创建文档失败", "error"); return; }
    storeSet = false;
    editorRef.value?.commands.setContent(html);
    storeSet = true;
    store.markUnsaved();
    void store.saveNow();
    toast(`已写入论文: ${d.title ?? "分析结果"}`, "success");
  } catch (err) {
    toast(`写入失败: ${String(err)}`, "error");
  }
}

// 注: 这里原本还有 onAiApply / EVT.aiApply 监听, 已删(2026-09-12 死代码审计)。
//   AIPanel 直接经 props.editor 落文(AIPanel.vue:250-258 insertContent/insertContentAt),
//   全项目**无人派发 ai-apply** —— 监听器永远不会被触发, 只有净开销。
//   React 壳 web/src/components/EditorView.tsx 里那个同名监听同理(且该文件已零引用)。

async function onAiInsertChart(e: Event) {
  const detail = (e as CustomEvent).detail as { code: string; type: string };
  const ed = editorRef.value;
  if (!ed || !detail?.code) return;
  try {
    const code = detail.code;
    const type = String(detail.type ?? "");
    let dataUrl = "";
    if (type.startsWith("mermaid")) {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "strict" });
      const { svg } = await mermaid.render(`ins-${Date.now()}`, code);
      dataUrl = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
    } else if (type.startsWith("echarts")) {
      const echarts = await import("echarts");
      const div = document.createElement("div");
      div.style.cssText = "width:600px;height:400px;position:fixed;left:-9999px;top:0";
      document.body.appendChild(div);
      try {
        const inst = echarts.init(div);
        const option = (() => {
          try {
            return typeof code === "string" && code.trim().startsWith("{") ? JSON.parse(code) : code;
          } catch {
            return {};
          }
        })();
        inst.setOption(option);
        await new Promise((r) => setTimeout(r, 500));
        dataUrl = inst.getDataURL({ type: "png", pixelRatio: 2 });
        inst.dispose();
      } finally {
        document.body.removeChild(div);
      }
    }
    if (dataUrl) {
      ed.chain().focus().setImage({ src: dataUrl }).run();
      toast("图表已插入", "success");
    } else {
      const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      ed.chain().focus().insertContent(`<pre><code>${escaped}</code></pre>`).run();
      toast("代码已插入", "success");
    }
    store.markUnsaved();
  } catch (err) {
    toast(`图表插入失败: ${(err as Error).message}`, "error");
  }
}

async function handleExport() {
  const ed = editorRef.value;
  if (!ed || !store.currentDocument) {
    // 审查修复: 无已打开文档时点击曾静默无反应
    toast("请先新建或打开一篇文档再导出", "warning");
    return;
  }
  const html = ed.getHTML();
  const title = store.currentDocument.title || "未命名学术文档";
  try {
    const res = await fetch(`/api/editor/v1/documents/${store.currentDocument.id}/export`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}`
      },
      body: JSON.stringify({ html, title, format_options: {} })
    });
    const ct = res.headers.get("content-type") || "";
    let blob: Blob;
    if (ct.includes("application/json")) {
      const j = await res.json();
      if (!j?.ok || !j?.base64) throw new Error(j?.error?.message ?? "导出失败");
      blob = base64ToBlob(j.base64, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    } else {
      blob = await res.blob();
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[\\/:*?"<>|]/g, "_")}.docx`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Word 导出完成", "success");
  } catch (err) {
    toast(`导出失败: ${(err as Error).message}`, "error");
  }
}

function exec(fn: (ed: Editor) => void) {
  const ed = editorRef.value;
  if (ed) fn(ed);
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener(EVT.aiInsertChart, onAiInsertChart as EventListener);
  window.addEventListener("doc-word-import", onWordImport as EventListener);
  window.addEventListener("message", onAppInsertDoc as unknown as EventListener);
  // V414: 同 VizView —— 监听器就绪后打标, 供父级判断可投递(替代不可靠的 #app 轮询)
  (window as unknown as { __socReady?: Record<string, boolean> }).__socReady = {
    ...((window as unknown as { __socReady?: Record<string, boolean> }).__socReady ?? {}),
    editor: true,
  };
  window.addEventListener("beforeunload", flushAndSave);
  void handleRouteIntent();
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener(EVT.aiInsertChart, onAiInsertChart as EventListener);
  window.removeEventListener("doc-word-import", onWordImport as EventListener);
  window.removeEventListener("message", onAppInsertDoc as unknown as EventListener);
  window.removeEventListener("beforeunload", flushAndSave);
  if (saveTimer.value) clearTimeout(saveTimer.value);
  void store.releaseLock();
  editorRef.value?.destroy();
});
</script>

<template>
  <div class="ade-layout" :class="{ 'ade-layout--ai-open': aiOpen }">
    <TopBar @toggle-version-history="versionOpen = !versionOpen" />
    <div class="ade-layout__body">
      <SideBar />
      <div class="ade-editor-area">
        <div class="ade-editor-toolbar">
          <div class="ade-editor-toolbar__row">
            <!-- 2026-09-10: 字号/缩放/页面大小基础视图控件 -->
            <select class="ade-view-ctl" :value="docFontSize" title="正文字号"
              @change="setDocFontSize(Number(($event.target as HTMLSelectElement).value))">
              <option v-for="s in [12, 13, 14, 15, 16, 18, 20, 24]" :key="s" :value="s">{{ s }}pt</option>
            </select>
            <select class="ade-view-ctl" :value="paperMode" title="页面大小"
              @change="setPaperMode(($event.target as HTMLSelectElement).value)">
              <option value="a4">A4</option>
              <option value="letter">信纸</option>
              <option value="wide">页宽</option>
            </select>
            <button class="ade-toolbar-btn" title="缩小视图" @click="stepZoom(-10)">−</button>
            <select class="ade-view-ctl ade-view-ctl--zoom" :value="zoomPct" title="页面缩放"
              @change="setZoom(Number(($event.target as HTMLSelectElement).value))">
              <option v-for="z in [50, 75, 90, 100, 125, 150, 175, 200]" :key="z" :value="z">{{ z }}%</option>
            </select>
            <button class="ade-toolbar-btn" title="放大视图" @click="stepZoom(10)">＋</button>
            <span class="ade-toolbar-divider"></span>
            <button class="ade-toolbar-btn" @click="exec((ed) => ed.chain().focus().undo().run())" title="撤销">↩</button>
            <button class="ade-toolbar-btn" @click="exec((ed) => ed.chain().focus().redo().run())" title="重做">↪</button>
            <span class="ade-toolbar-divider"></span>
            <button class="ade-toolbar-btn ade-toolbar-btn--strong" @click="exec((ed) => ed.chain().focus().toggleBold().run())"><b>B</b></button>
            <button class="ade-toolbar-btn ade-toolbar-btn--strong" @click="exec((ed) => ed.chain().focus().toggleItalic().run())"><i>I</i></button>
            <button class="ade-toolbar-btn ade-toolbar-btn--strong" @click="exec((ed) => ed.chain().focus().toggleUnderline().run())"><u>U</u></button>
            <button class="ade-toolbar-btn ade-toolbar-btn--strong" @click="exec((ed) => ed.chain().focus().toggleStrike().run())"><s>S</s></button>
            <span class="ade-toolbar-divider"></span>
            <button class="ade-toolbar-btn" @click="exec((ed) => ed.chain().focus().toggleHeading({ level: 1 }).run())">H1</button>
            <button class="ade-toolbar-btn" @click="exec((ed) => ed.chain().focus().toggleHeading({ level: 2 }).run())">H2</button>
            <button class="ade-toolbar-btn" @click="exec((ed) => ed.chain().focus().toggleHeading({ level: 3 }).run())">H3</button>
            <button class="ade-toolbar-btn" @click="exec((ed) => ed.chain().focus().setParagraph().run())">P</button>
            <span class="ade-toolbar-divider"></span>
            <button class="ade-toolbar-btn" @click="exec((ed) => ed.chain().focus().toggleBulletList().run())">• 列表</button>
            <button class="ade-toolbar-btn" @click="exec((ed) => ed.chain().focus().toggleOrderedList().run())">1. 列表</button>
            <button class="ade-toolbar-btn" @click="exec((ed) => ed.chain().focus().toggleBlockquote().run())">引用</button>
            <button class="ade-toolbar-btn" @click="exec((ed) => ed.chain().focus().toggleCodeBlock().run())">&lt;/&gt;</button>
            <span class="ade-toolbar-divider"></span>
            <button class="ade-toolbar-btn" @click="exec((ed) => ed.chain().focus().setTextAlign('left').run())" title="左对齐">左</button>
            <button class="ade-toolbar-btn" @click="exec((ed) => ed.chain().focus().setTextAlign('center').run())" title="居中">中</button>
            <button class="ade-toolbar-btn" @click="exec((ed) => ed.chain().focus().setTextAlign('right').run())" title="右对齐">右</button>
            <span class="ade-toolbar-right">
              <button class="ade-toolbar-btn" @click="handleExport" title="导出 Word">导出 Word</button>
              <button class="ade-toolbar-btn ade-toolbar-btn--assist" :class="{ active: aiOpen }" @click="aiOpen = !aiOpen">辅助工具</button>
            </span>
          </div>
        </div>
        <div class="ade-editor-tiptap-wrap" :style="{ '--ade-zoom': zoomPct / 100 }">
          <div class="tiptap"
            :style="{
              '--ade-doc-font-size': docFontSize + 'px',
              ...paperCss,
              transform: zoomPct !== 100 ? 'scale(var(--ade-zoom))' : undefined,
              transformOrigin: 'top center',
              marginBottom: zoomPct !== 100 ? `calc(${paperMode === 'wide' ? '100px' : '297mm'} * (${1 - zoomPct / 100}))` : undefined
            }">
            <EditorContent v-if="editor" :editor="editor" />
            <div v-else style="padding: 60px; text-align: center; color: #7A8AA0">编辑器加载中…</div>
          </div>
        </div>
        <div class="ade-statusbar">
          <span>{{ store.wordCount }} 字</span>
          <span v-if="store.lockInfo" style="color: #7A8AA0">· 已锁定</span>
        </div>
      </div>
      <AIPanel v-if="aiOpen" :editor="editor ?? null" />
    </div>
    <VersionHistory :document-id="store.currentDocument?.id ?? null" :is-open="versionOpen" @close="versionOpen = false" @restored="onVersionRestored" />
  </div>
</template>

<style scoped>
.ade-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 0;
  width: 100%;
  background: #1A2333;
  color: #DCE6F2;
  overflow: hidden;
  font-family: PingFang SC, Microsoft YaHei, sans-serif;
}
.ade-layout__body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.ade-editor-area {
  flex: 1;
  min-width: 280px; /* 防窄窗/AI 面板展开时被挤成 0 */
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.ade-editor-toolbar {
  flex-shrink: 0;
  min-height: 44px;
  border-bottom: 1px solid #222F44;
  background: #11192C;
  display: flex;
  align-items: center;
  padding: 6px 16px;
  position: relative;
}
.ade-editor-toolbar__row {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: nowrap;          /* 永不折行: 宽窗一行排满, 窄窗横向滚动 */
  overflow-x: auto;           /* 放不下时横向滚动, 不乱排 */
  width: 100%;                /* 占满整个工具栏, 不再 cap 1120 */
  /* 右簇绝对定位: 预留右侧空间, 防止内容被右簇遮挡 */
  padding-right: 190px;
  scrollbar-width: thin;
}
.ade-toolbar-btn__spacer {
  display: none;
}
.ade-toolbar-right {
  position: absolute;
  top: 6px;                  /* = toolbar padding, 与 row 同起点, 按钮与行内按钮完全同高 */
  right: 16px;
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  background: #11192C;
  padding-left: 10px;
}
.ade-toolbar-btn {
  height: 27px;
  padding: 0 9px;
  border: 1px solid #222F44;
  border-radius: 5px;
  background: #11192C;
  color: #DCE6F2;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
}
.ade-toolbar-btn:hover {
  background: #1E2A48;
  border-color: #2A3A55;
}
.ade-toolbar-divider {
  width: 1px;
  height: 18px;
  background: #222F44;
  margin: 0 3px;
}
.ade-view-ctl {
  height: 27px;
  border: 1px solid #222F44;
  border-radius: 5px;
  background: #11192C;
  color: #DCE6F2;
  font-size: 11px;
  padding: 0 5px;
  cursor: pointer;
  font-family: inherit;
}
.ade-view-ctl--zoom {
  min-width: 60px;
  text-align: center;
}
.ade-toolbar-btn--strong {
  min-width: 29px;
  padding: 0 4px;
}
.ade-toolbar-btn--assist.active {
  background: #1E2A48;
  border-color: #2563eb;
  color: #2563eb;
}
.ade-editor-tiptap-wrap {
  flex: 1;
  overflow: auto;
  padding: 24px;
  display: flex;
  justify-content: center;
  background: #1A2333;
}
.tiptap {
  background: #11192C;
  width: 210mm;
  min-height: 297mm;
  padding: 56px 64px;
  box-shadow: 0 4px 24px rgba(15, 23, 42, 0.14);
  font-family: var(--ade-doc-font-family, "SimSun", serif);
  font-size: var(--ade-doc-font-size, 15px);
  line-height: var(--ade-doc-line-height, 1.85);
  color: #DCE6F2;
  flex-shrink: 0;
}
.tiptap :deep(.ade-editor-prose) {
  outline: none;
  min-height: 240mm;
}
.tiptap :deep(p) {
  margin: var(--ade-doc-paragraph-margin, 5px) 0;
  text-indent: var(--ade-doc-first-line-indent, 2em);
}
.tiptap :deep(h1) {
  font-size: 24px;
  text-indent: 0;
}
.tiptap :deep(h2) {
  font-size: 20px;
  text-indent: 0;
}
.tiptap :deep(h3) {
  font-size: 16px;
  text-indent: 0;
}
.tiptap :deep(ul),
.tiptap :deep(ol) {
  text-indent: 0;
}
.tiptap :deep(li) {
  text-indent: 0;
}
.tiptap :deep(img) {
  max-width: 100%;
}
.tiptap :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 10px 0;
}
.tiptap :deep(th),
.tiptap :deep(td) {
  border: 1px solid #46587A;
  padding: 5px 9px;
  text-align: left;
  vertical-align: top;
}
.tiptap :deep(blockquote) {
  border-left: 3px solid #46587A;
  margin: 8px 0;
  padding: 2px 0 2px 12px;
  color: #8B9BB1;
}
.tiptap :deep(pre) {
  background: #E8EEF7;
  color: #222F44;
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
  text-indent: 0;
}
.tiptap :deep(hr) {
  border: 0;
  border-top: 1px solid #46587A;
  margin: 18px 0;
}
.ade-statusbar {
  flex-shrink: 0;
  height: 26px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  border-top: 1px solid #222F44;
  background: #11192C;
  color: #8B9BB1;
  font-size: 11px;
}
</style>
