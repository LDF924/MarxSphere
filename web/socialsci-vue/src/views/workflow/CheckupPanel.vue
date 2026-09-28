<script setup lang="ts">
/**
 * CheckupPanel(中期检查 / 结项验收) — 上传检查表 → 逐项对着填 → 缺失项明确留空。
 *
 * ## 这两项此前被明确排除，为什么现在做、以及怎么还账
 *
 * 补齐计划里写着"中期检查、结项验收不做 —— 那些是**项目管理**不是**研究**"。
 * **这条理由是我写的，而且它站不住**：按它推，评审返修（批6）与录用出版（批9）
 * 同样不是"研究"，但那两批都做了。真正的分界线是另一条 ——
 * **这件事的数据在不在这边手上**。中期检查要的是"学院给的那张检查表"，
 * 平台没有；硬做的结果就是"生成一段放之四海皆准的套话"，用户填进真表格会被打回来。
 *
 * 所以这里的形态是**四步，没有一步是"让模型写"**（本页零 LLM 调用）：
 *   ① 上传或粘贴**你自己那份**检查表（平台不猜模板）；
 *   ② 平台拆成条目；
 *   ③ 逐项三分类，界面上用三种底色把它标出来：
 *        · 绿 `auto`      平台有真数据、已自动填好，并标明**来源**；
 *        · 黄 `manual`    平台没有，**留空等你填**；
 *        · 灰 `missing`   平台结构上就不记录（经费/签字/专家意见），**如实说，不假装**；
 *   ④ 导出 Markdown / Word 交上去。
 *
 * ## 为什么"来源"必须显示出来
 *
 * 用户拿着这份表去交差，被问到"这个数字哪来的"要答得上。没有来源的自动填写等于伪造 ——
 * 而且用户自己也分不清"哪些是平台查的、哪些是我填的"。所以每个 auto 项后面都跟着来源。
 *
 * ## 为什么 `missing` 要单独一类而不是并进 `manual`
 *
 * 合成一类，用户会对着一个空框反复找"是不是我哪步没做"。分开之后界面直接说
 * "这类内容平台不记录，请线下补" —— 这是产品的边界，该说清楚。
 */
import { ref, computed, onMounted, watch } from "vue";
import { q } from "@/shared/api";
import { useWorkflowStore } from "./stores/workflow";
import { toast } from "@/shared/ui";

type ItemKind = "auto" | "manual" | "platform_missing";
interface CheckupItem {
  seq: number; section: string; label: string;
  kind: ItemKind; value: string; autoSource: string; edited?: boolean;
}
interface CheckupDoc {
  kind: string; sourceName: string; items: CheckupItem[];
  counts: { auto: number; manual: number; platformMissing: number };
  updatedAt: string; rawText: string;
}

const KINDS: Array<{ key: string; cn: string; hint: string }> = [
  { key: "midterm", cn: "中期检查", hint: "研究做到一半时，学院/学校要的那份进度与阶段性成果材料。" },
  { key: "final", cn: "结项验收", hint: "项目结束时要交的结项材料。" },
];

const store = useWorkflowStore();
const pid = computed(() => store.taskId);

const active = ref("midterm");
const doc = ref<CheckupDoc | null>(null);
const loading = ref(true);
/** 粘贴区 —— 上传文件解析出来的文本也落到这里，用户能先看一眼再确认 */
const pasted = ref("");
const sourceName = ref("");
const busy = ref(false);
const uploading = ref(false);

const curKind = computed(() => KINDS.find((k) => k.key === active.value)!);
const hasDoc = computed(() => (doc.value?.items?.length ?? 0) > 0);

/** 按 section 分组渲染 —— 检查表本来就是一节一节写的，平铺会让人找不到位置 */
const grouped = computed(() => {
  const out: Array<{ section: string; items: CheckupItem[] }> = [];
  for (const it of doc.value?.items ?? []) {
    const last = out[out.length - 1];
    if (last && last.section === it.section) last.items.push(it);
    else out.push({ section: it.section, items: [it] });
  }
  return out;
});

async function load() {
  if (!pid.value) { loading.value = false; return; }
  loading.value = true;
  try {
    const r = await q<{ doc: CheckupDoc }>(`/research/projects/${pid.value}/checkup/${active.value}`);
    doc.value = r.doc ?? null;
    sourceName.value = r.doc?.sourceName ?? "";
  } catch (e) {
    // 404/422 之外的错才提示 —— 没有检查表是**空态不是错误**
    doc.value = null;
    const msg = (e as Error).message ?? "";
    if (!/项目不存在/.test(msg)) doc.value = null;
  } finally {
    loading.value = false;
  }
}

/** 切换中期/结项时把粘贴区清掉 —— 否则会把 A 表的文本传到 B 类上去 */
function switchKind(k: string) {
  active.value = k;
  pasted.value = "";
  sourceName.value = "";
  void load();
}

/** 上传文件 → 前端只负责转成文本，解析本身走既有的 /files/extract-text（不另造通道） */
async function onPickFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const f = input.files?.[0];
  if (!f) return;
  uploading.value = true;
  try {
    const ext = (f.name.split(".").pop() ?? "").toLowerCase();
    let text = "";
    if (["txt", "md", "csv", "tsv"].includes(ext)) {
      text = await f.text();
    } else {
      const base64 = await new Promise<string>((resolve, reject) => {
        const rd = new FileReader();
        rd.onload = () => resolve(String(rd.result ?? ""));
        rd.onerror = () => reject(new Error("读取文件失败"));
        rd.readAsDataURL(f);
      });
      // 同 MaterialsView: 服务端真给了原因就原样转达; 只有连不上/被重置才提"可能太大"
      const r = await q<{ ok?: boolean; text?: string; error?: string }>("/files/extract-text", {
        method: "POST", body: { filename: f.name, base64, mime: f.type },
      }).catch((e: unknown) => ({
        ok: false as const,
        __serverMsg: typeof (e as { status?: number }).status === "number" ? String((e as { message?: string }).message ?? "") : "",
        __netErr: typeof (e as { status?: number }).status === "number" ? "" : String((e as { message?: string }).message ?? e),
      }));
      if (!r?.ok) {
        const serverMsg = String((r as { __serverMsg?: string }).__serverMsg ?? "");
        const netErr = String((r as { __netErr?: string }).__netErr ?? "");
        const detail = (r as { error?: string }).error;
        const sizeMB = (f.size / 1024 / 1024).toFixed(1);
        toast(
          detail ? detail
            : serverMsg ? serverMsg
            : netErr ? `读取失败(${f.name}, ${sizeMB}MB) —— 文件可能过大或网络中断, 请重试或换小一点的文件`
            : `没能读出这份文件(${f.name}), 请确认它不是扫描件/加密文件`,
          "error",
        );
        return;
      }
      text = (r as { text?: string }).text ?? "";
    }
    if (!text.trim()) { toast("这份文件里没读到文字（扫描件需先 OCR）", "error"); return; }
    pasted.value = text;
    sourceName.value = f.name;
    toast("已读取，确认无误后点「拆成检查项」", "success");
  } catch (e) {
    toast(`读取失败: ${(e as Error).message}`, "error");
  } finally {
    uploading.value = false;
    input.value = "";   // 同一个文件再选一次也要能触发 change
  }
}

async function parse() {
  if (!pid.value || busy.value) return;
  if (!pasted.value.trim()) { toast("先上传或粘贴检查表内容", "info"); return; }
  busy.value = true;
  try {
    const r = await q<{ ok: boolean; doc: CheckupDoc }>(`/research/projects/${pid.value}/checkup/${active.value}`, {
      method: "PUT", body: { text: pasted.value, sourceName: sourceName.value || "手动粘贴" },
    });
    doc.value = r.doc ?? null;
    const c = doc.value?.counts;
    toast(c ? `已拆成 ${doc.value?.items?.length ?? 0} 项：自动填 ${c.auto} · 待你填 ${c.manual} · 平台不记录 ${c.platformMissing}` : "已拆条", "success");
  } catch (e) {
    toast(`拆条失败: ${(e as Error).message}`, "error");
  } finally {
    busy.value = false;
  }
}

/** 逐项保存。用 change 而不是 input —— 逐字保存会把半截内容写进库（声明页是防抖，这里条目多更该省） */
async function setItem(seq: number, v: string) {
  if (!pid.value) return;
  const prev = doc.value;
  // 乐观更新：改完立刻看到，失败再回滚（逐条请求，慢的话界面会卡在旧值上）
  if (doc.value) {
    doc.value = { ...doc.value, items: doc.value.items.map((i) => (i.seq === seq ? { ...i, value: v, edited: true } : i)) };
  }
  try {
    const r = await q<{ ok: boolean; doc: CheckupDoc }>(`/research/projects/${pid.value}/checkup/${active.value}/items/${seq}`, {
      method: "PATCH", body: { value: v },
    });
    if (r.doc) doc.value = r.doc;
  } catch (e) {
    doc.value = prev;
    toast(`保存失败: ${(e as Error).message}`, "error");
  }
}

async function copyMd() {
  if (!pid.value) return;
  try {
    const r = await q<{ markdown: string }>(`/research/projects/${pid.value}/checkup/${active.value}/export`);
    await navigator.clipboard.writeText(r.markdown ?? "");
    toast("已复制到剪贴板（Markdown）", "success");
  } catch (e) {
    toast(`导出失败: ${(e as Error).message}`, "error");
  }
}

/**
 * 导出 Word —— 节点由**后端**拼好（`?format=docx`），本页只把它转给既有的
 * `/paper-outline/export`（那里有 python-docx 与一整套版式参数，不在这里重写一遍）。
 *
 * ⚠ 不在前端把 Markdown 解析成节点 —— 两条导出路径必须同源，否则会出现
 *   "复制出来有来源标注、Word 里没有"（本仓在投稿声明那处踩过完全一样的坑）。
 */
async function exportWord() {
  if (!pid.value) return;
  busy.value = true;
  try {
    const r = await q<{ ok: boolean; paperTitle: string; nodes: Array<Record<string, unknown>> }>(
      `/research/projects/${pid.value}/checkup/${active.value}/export?format=docx`);
    const r2 = await q<{ ok: boolean; base64?: string }>("/paper-outline/export", {
      method: "POST",
      body: { paperTitle: r.paperTitle || `${store.title || "未命名"} · ${curKind.value.cn}`, nodes: r.nodes ?? [] },
    });
    if (!r2.base64) throw new Error("后端未返回文档内容");
    downloadBase64(r2.base64, `${safeName(store.title || "未命名")}-${curKind.value.cn}.docx`,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    toast("Word 已导出", "success");
  } catch (e) {
    toast(`导出失败: ${(e as Error).message}`, "error");
  } finally {
    busy.value = false;
  }
}

function safeName(s: string): string { return String(s).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60); }
function downloadBase64(base64: string, fileName: string, mime: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

onMounted(() => void load());
/**
 * ⚠ 必须 watch taskId —— 本面板是 `ProposalsView` 的子组件，而 Vue 里
 *   **子组件的 onMounted 先于父组件执行**：那一刻 `store.loadProject()` 还没跑完，
 *   `pid` 是空的，`load()` 第一句就 return 了，之后再没有东西把它叫醒。
 *   （批9 的 PostAcceptancePanel 就是漏了这句，症状是"数据对、界面看不到"。）
 */
watch(() => store.taskId, () => void load());
</script>

<template>
  <div class="cu">
    <div class="cu-head">
      <h2 class="cu-h2">中期检查与结项验收</h2>
      <span class="cu-muted">上传你自己那份检查表 —— 平台按你的表逐项填，填不了的不编</span>
    </div>

    <p v-if="!pid" class="cu-muted">先选择一个研究项目。</p>

    <template v-else>
      <nav class="cu-tabs">
        <button
          v-for="k in KINDS" :key="k.key"
          class="cu-tab" :class="{ 'is-on': active === k.key }"
          :data-control="`workflow:cu-tab-${k.key}`"
          @click="switchKind(k.key)"
        >{{ k.cn }}</button>
      </nav>
      <p class="cu-hint">{{ curKind.hint }}</p>

      <!-- ① 上传 / 粘贴 -->
      <section class="cu-sec">
        <h3 class="cu-h3">① 上传你的检查表</h3>
        <p class="cu-hint">
          支持 PDF / Word / TXT / CSV / Markdown —— 或者直接把表格内容粘贴进下面的框。
          <b>平台不预设模板</b>：每所学校、每个项目类型的表都不一样，猜一个不如让你传自己的。
        </p>
        <div class="cu-row">
          <label class="cu-file">
            <input type="file" accept=".pdf,.docx,.txt,.md,.csv,.tsv" :disabled="uploading"
              data-control="workflow:cu-file" @change="onPickFile" />
            <span>{{ uploading ? "读取中…" : "选择文件" }}</span>
          </label>
          <span v-if="sourceName" class="cu-muted">来源：{{ sourceName }}</span>
        </div>
        <textarea
          v-model="pasted" class="cu-ta" rows="8"
          placeholder="把检查表的条目粘到这里，例如：&#10;一、研究工作进展情况&#10;1. 项目名称&#10;2. 已完成章节数&#10;3. 经费使用情况"
          data-control="workflow:cu-paste"
        ></textarea>
        <div class="cu-row">
          <button class="cu-btn cu-btn-primary" :disabled="busy" data-control="workflow:cu-parse" @click="parse">
            {{ busy ? "拆条中…" : (hasDoc ? "重新拆条（覆盖现有）" : "拆成检查项") }}
          </button>
          <span class="cu-muted">上传或粘贴会<b>替换</b>这一类已有的表 —— 不会并排留两份。</span>
        </div>
      </section>

      <!-- ② 逐项填写 -->
      <section v-if="loading" class="cu-sec"><p class="cu-muted">读取中…</p></section>
      <section v-else-if="!hasDoc" class="cu-sec">
        <p class="cu-hint" data-control="workflow:cu-empty">
          这一类还没上传检查表。上面传一份，平台会把它拆成条目，能自动填的先把项目里已有的数据填进去。
        </p>
      </section>
      <section v-else class="cu-sec">
        <div class="cu-sec-head">
          <h3 class="cu-h3">② 逐项核对</h3>
          <span class="cu-counts" data-control="workflow:cu-counts">
            <span class="cu-c cu-c-auto">自动填 {{ doc?.counts.auto }}</span>
            <span class="cu-c cu-c-manual">待你填 {{ doc?.counts.manual }}</span>
            <span class="cu-c cu-c-missing">平台不记录 {{ doc?.counts.platformMissing }}</span>
          </span>
          <button class="cu-btn cu-btn-sm" data-control="workflow:cu-copy" @click="copyMd">复制 Markdown</button>
          <button class="cu-btn cu-btn-sm" :disabled="busy" data-control="workflow:cu-word" @click="exportWord">导出 Word</button>
        </div>

        <div v-for="(g, gi) in grouped" :key="gi" class="cu-group">
          <h4 v-if="g.section" class="cu-group-h">{{ g.section }}</h4>
          <div v-for="it in g.items" :key="it.seq" class="cu-item" :class="`is-${it.kind}`">
            <div class="cu-item-head">
              <span class="cu-label">{{ it.label }}</span>
              <span v-if="it.kind === 'auto'" class="cu-tag cu-tag-auto" :title="`来源：${it.autoSource}`">
                自动填 · {{ it.autoSource }}</span>
              <span v-else-if="it.kind === 'platform_missing'" class="cu-tag cu-tag-missing">平台不记录</span>
              <span v-else class="cu-tag cu-tag-manual">待填</span>
              <span v-if="it.edited" class="cu-tag cu-tag-edited" title="你改过这一项，平台不会再覆盖">已手改</span>
            </div>
            <input
              class="cu-in" :value="it.value"
              :placeholder="it.kind === 'platform_missing' ? '平台不记录这类内容，请线下补' : '（待填）'"
              :data-control="`workflow:cu-item-${it.seq}`"
              @change="setItem(it.seq, ($event.target as HTMLInputElement).value)"
            />
          </div>
        </div>

        <p class="cu-hint cu-foot">
          ⚠ 灰色的项是<b>平台结构上就不记录</b>的内容（经费 / 签字 / 专家意见等）—— 导出的表里留空，
          请线下补齐。这不是"哪一步没做"，是工具的边界。
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.cu { border: 1px solid var(--wf-line); border-radius: var(--wf-r); background: var(--wf-surface); padding: 14px 16px; }
.cu-head { display: flex; align-items: baseline; gap: 10px; }
.cu-h2 { margin: 0; font-size: 15px; font-weight: 600; color: var(--wf-text); }
.cu-h3 { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--wf-text); }
.cu-muted { font-size: 12px; color: var(--wf-muted); }
.cu-hint { font-size: 12px; color: var(--wf-faint); margin: 4px 0 8px; line-height: 1.7; }
.cu-tabs { display: flex; gap: 6px; margin-top: 10px; }
.cu-tab {
  font-size: 12.5px; padding: 4px 13px; cursor: pointer; border-radius: var(--wf-r-pill);
  border: 1px solid var(--wf-line); background: var(--wf-bg); color: var(--wf-muted);
}
.cu-tab.is-on { border-color: var(--wf-accent, #6FBF8B); color: var(--wf-accent, #6FBF8B); }
.cu-sec { border-top: 1px dashed var(--wf-line-soft); padding-top: 12px; margin-top: 12px; }
.cu-sec-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cu-counts { display: flex; gap: 6px; }
.cu-c { font-size: 11.5px; padding: 1px 8px; border-radius: var(--wf-r-pill); border: 1px solid var(--wf-line); }
.cu-c-auto { color: #6FBF8B; border-color: #6FBF8B; }
.cu-c-manual { color: #D9A441; border-color: #D9A441; }
.cu-c-missing { color: var(--wf-faint); }
.cu-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
.cu-file { position: relative; overflow: hidden; display: inline-block; }
.cu-file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.cu-file span {
  display: inline-block; font-size: 12.5px; padding: 4px 12px; border-radius: var(--wf-r-pill);
  border: 1px solid var(--wf-line); background: var(--wf-bg); color: var(--wf-text); cursor: pointer;
}
.cu-ta {
  width: 100%; box-sizing: border-box; background: var(--wf-bg); color: var(--wf-text);
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm, 6px);
  padding: 8px 10px; font-size: 12.5px; font-family: inherit; line-height: 1.7; resize: vertical;
}
.cu-btn {
  font-size: 12.5px; padding: 4px 12px; cursor: pointer; border-radius: var(--wf-r-pill);
  border: 1px solid var(--wf-line); background: var(--wf-bg); color: var(--wf-text);
}
.cu-btn:disabled { opacity: .5; cursor: not-allowed; }
.cu-btn-sm { font-size: 11.5px; padding: 2px 10px; margin-left: auto; }
.cu-btn-sm + .cu-btn-sm { margin-left: 0; }
.cu-btn-primary { border-color: var(--wf-accent, #6FBF8B); color: var(--wf-accent, #6FBF8B); }
.cu-group { margin-top: 12px; }
.cu-group-h { margin: 0 0 6px; font-size: 12.5px; color: var(--wf-muted); font-weight: 600; }
.cu-item { border-left: 3px solid var(--wf-line); padding: 6px 0 6px 10px; margin-bottom: 6px; }
.cu-item.is-auto { border-left-color: #6FBF8B; }
.cu-item.is-manual { border-left-color: #D9A441; }
.cu-item.is-platform_missing { border-left-color: var(--wf-line-strong, var(--wf-line)); opacity: .72; }
.cu-item-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cu-label { font-size: 12.5px; color: var(--wf-text); }
.cu-tag { font-size: 11px; padding: 0 6px; border-radius: var(--wf-r-pill); border: 1px solid var(--wf-line); }
.cu-tag-auto { color: #6FBF8B; border-color: #6FBF8B; }
.cu-tag-manual { color: #D9A441; border-color: #D9A441; }
.cu-tag-missing { color: var(--wf-faint); }
.cu-tag-edited { color: var(--wf-muted); }
.cu-in {
  width: 100%; box-sizing: border-box; margin-top: 4px;
  background: var(--wf-bg); color: var(--wf-text); border: 1px solid var(--wf-line);
  border-radius: var(--wf-r-sm, 6px); padding: 4px 8px; font-size: 12.5px; font-family: inherit;
}
.cu-foot { margin-top: 14px; border-top: 1px dashed var(--wf-line-soft); padding-top: 10px; }
</style>
