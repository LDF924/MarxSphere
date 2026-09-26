<script setup lang="ts">
/**
 * SubmissionView(投稿与要件) — 投稿相关事务的落点。
 *
 * ## 为什么单开一区（用户 2026-09-26 拍板）
 *
 * 五项投稿声明（作者贡献/基金/利益冲突/致谢/数据可得性）**不是正文的一章**：
 * 期刊按自己的清单收它们，排版上放在参考文献之后。塞进章节目录会有两个后果：
 *   · 用户以为它们是正文，导出时按章节顺序排到中间；
 *   · 章节目录（第 2 步定稿的结构）被这些"非章节"污染。
 * 所以与「统稿定稿」平级、独立一区。
 *
 * ## 为什么现在就建「投稿与返修」这个容器
 *
 * 批 6 要往这里加**返修**（审稿意见 → 逐条回应 → 修订稿）。返修与声明同属"投稿之后的事务"，
 * 拆成两个区会让用户在两个地方来回找。先把容器建好，批 6 直接往里加 —— 不搬迁。
 *
 * ## 声明为什么必须人工填
 *
 * 库里**没有任何作者/基金字段**（research_projects 与 users 都没有）。
 * 而这五项：基金号编错 = 学术不端；作者贡献写错 = 署名纠纷；数据可得性写错 = 承诺给不出的数据。
 * 所以这里**不提供"AI 帮我写"** —— 只提供模板、口径说明与完整性检查。
 * 模型的唯一合法用途是润色已成文的内容，那是另一件事，不在这一版里。
 */
import { ref, computed, onMounted, watch } from "vue";
import { useWorkflowStore } from "./stores/workflow";
import { getNode, mergeNode } from "@/shared/tasks";
import { toast } from "@/shared/ui";
import { DECLARATIONS, checkDeclarations, normDeclarations, type Declarations } from "@/shared/declarations";
import WorkflowShell from "./WorkflowShell.vue";
import PhaseProgressBar from "./PhaseProgressBar.vue";

const store = useWorkflowStore();

/**
 * 声明的**真源是 `store.declarations`**，不是本页的局部 ref。
 *
 * ⚠ 这一条是修一个真 bug 时定下的：第一版只把声明写进 `declarations` 节点，
 *   而**导出的四条链路读的是 `store.declarations`**（合稿页拼 md/html、后端 ZIP）。
 *   于是"用户在这一页填完 → 去合稿页导出 → 声明段是空的" —— **不报错**，
 *   只是那段凭空消失。用户不会想到"填了却没导出来"是两个不同的存储位置造成的。
 *
 * 现在与 `sections` 同一个范式：**store 与节点双写**（见 FinalizeView 里那段
 * "必须快照+节点双写"的注释，那是同一条教训）。落库失败不影响本地编辑。
 */
const decls = computed<Declarations>(() => normDeclarations(store.declarations));
const loading = ref(true);
/** 回读期间抑制保存 —— 否则读出来的值会被当成用户输入立刻写回去（无谓写 + 竞态） */
let hydrating = false;

const problems = computed(() => checkDeclarations(decls.value));
const requiredMissing = computed(() => problems.value.filter((p) => p.kind === "missing").length);

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (hydrating || !store.taskId) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveNow(), 600);
}

/** 双写：store（导出要读）+ declarations 节点（服务端持久化） */
async function saveNow() {
  if (!store.taskId) return;
  try {
    await store.saveProject();
    await mergeNode(store.taskId, "declarations", { declarations: store.declarations });
  } catch (e) {
    toast(`声明保存失败: ${(e as Error).message}`, "error");
  }
}

async function load() {
  if (!store.taskId) { loading.value = false; return; }
  loading.value = true;
  try {
    const node = await getNode(store.taskId, "declarations");
    // 节点没有时才用快照的值（首次进入这种页时两边都可能空）
    const fromNode = normDeclarations(node?.declarations ?? node);
    hydrating = true;
    if (Object.keys(fromNode).length) store.declarations = fromNode;
    await Promise.resolve();
    hydrating = false;
  } catch {
    // 读不到就保持现有（可能来自快照）—— 不要因此把已填的清掉
  } finally {
    loading.value = false;
  }
}

/** 一键填入模板 —— **只填模板文本**, 不做任何"智能生成"。用户必须逐字核对。 */
function applyTemplate(key: string, tpl: string) {
  if (String(decls.value[key as keyof Declarations] ?? "").trim()) {
    // 已经有内容时不覆盖 —— 用户填的东西比模板重要
    toast("已有内容，未覆盖", "info");
    return;
  }
  store.declarations = { ...store.declarations, [key]: tpl };
  scheduleSave();
}

function setDecl(key: string, v: string) {
  store.declarations = { ...store.declarations, [key]: v };
  scheduleSave();
}

watch(() => store.taskId, () => void load());
onMounted(async () => {
  await store.loadProject().catch(() => null);
  await load();
});
</script>

<template>
  <WorkflowShell>
  <div class="workflow-page wf-page">
    <PhaseProgressBar />
    <div class="wf-body">
      <div class="wf-head">
        <h1 class="wf-h1">投稿与要件</h1>
        <p class="wf-sub">投稿前要交给期刊的声明与材料。这些内容**只能由你填** —— 系统不做生成。</p>
      </div>

      <!-- 完整性总览 —— 放在最上面, 让人一眼看到还缺什么 -->
      <section class="sv-card sv-overview">
        <h2 class="sv-h2">要件完整性</h2>
        <p v-if="loading" class="sv-muted">读取中…</p>
        <template v-else-if="!problems.length">
          <p class="sv-ok" data-assistant-clear="1">必需的声明都已填写，可以随稿提交。</p>
        </template>
        <template v-else>
          <p class="sv-warn" data-assistant-clear="1">
            还有 <strong>{{ problems.length }}</strong> 项需要处理{{ requiredMissing ? `（其中 ${requiredMissing} 项必填留空）` : "" }}：
          </p>
          <ul class="sv-problems">
            <li v-for="p in problems" :key="p.key">
              <span class="sv-badge" :class="p.kind === 'missing' ? 'is-missing' : 'is-thin'">
                {{ p.kind === "missing" ? "待填" : "偏短" }}
              </span>
              <span class="sv-p-label">{{ p.label }}</span>
              <span class="sv-p-detail">{{ p.detail }}</span>
            </li>
          </ul>
        </template>
      </section>

      <!-- 五项声明 -->
      <section v-for="d in DECLARATIONS" :key="d.key" class="sv-card">
        <h2 class="sv-h2">
          {{ d.label }}
          <span v-if="d.required" class="sv-req">必填</span>
          <span v-else class="sv-opt">可选</span>
          <button
            class="sv-tpl" type="button"
            :data-control="`workflow:decl-tpl-${d.key}`"
            @click="applyTemplate(d.key, d.template)"
          >填入模板</button>
        </h2>
        <p class="sv-hint">{{ d.hint }}</p>
        <textarea
          class="sv-input"
          :value="decls[d.key] ?? ''"
          :placeholder="d.placeholder"
          :data-control="`workflow:decl-${d.key}`"
          rows="3"
          @input="setDecl(d.key, ($event.target as HTMLTextAreaElement).value)"
        ></textarea>
        <p class="sv-tpl-line">参照：{{ d.template }}</p>
      </section>

      <!-- 返修区占位 —— 批 6 在此落地。先留清晰的位置, 而不是等做的时候再改结构 -->
      <section class="sv-card sv-future">
        <h2 class="sv-h2">审稿意见与返修</h2>
        <p class="sv-muted">
          投稿后收到审稿意见、逐条回应、生成修订稿 —— 这一块正在建设中。
          届时与上面的声明同在本区，投稿相关的事不必两处找。
        </p>
      </section>
    </div>
  </div>
  </WorkflowShell>
</template>

<style scoped>
.workflow-page { width: 100%; box-sizing: border-box; }
.wf-head { margin-bottom: 16px; }
.wf-h1 { margin: 0; font-size: 22px; font-weight: 700; color: var(--wf-text); }
.wf-sub { margin: 4px 0 0; font-size: 13px; color: var(--wf-muted); }

.sv-card {
  border: 1px solid var(--wf-line); border-radius: var(--wf-r);
  background: var(--wf-surface); padding: 14px 16px; margin-bottom: 14px;
}
.sv-h2 {
  margin: 0 0 8px; font-size: 15px; font-weight: 600; color: var(--wf-text);
  display: flex; align-items: baseline; gap: 8px;
}
.sv-req { font-size: 11px; color: #E0714F; border: 1px solid #E0714F; border-radius: var(--wf-r-pill); padding: 0 6px; }
.sv-opt { font-size: 11px; color: var(--wf-faint); border: 1px solid var(--wf-line); border-radius: var(--wf-r-pill); padding: 0 6px; }
.sv-tpl {
  margin-left: auto; font-size: 12px; padding: 3px 10px; cursor: pointer;
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-raised); color: var(--wf-muted);
}
.sv-tpl:hover { color: var(--wf-text); border-color: var(--wf-line-strong); }
.sv-hint { margin: 0 0 8px; font-size: 12.5px; color: var(--wf-muted); line-height: 1.7; }
.sv-input {
  width: 100%; box-sizing: border-box; resize: vertical; min-height: 64px;
  padding: 8px 10px; font-size: 13px; line-height: 1.7; font-family: inherit;
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-raised); color: var(--wf-text);
}
.sv-input:focus { outline: none; border-color: var(--wf-line-strong); }
.sv-tpl-line { margin: 6px 0 0; font-size: 12px; color: var(--wf-faint); }
.sv-muted { margin: 6px 0 0; font-size: 13px; color: var(--wf-muted); line-height: 1.7; }

.sv-overview { border-color: var(--wf-line-strong); }
.sv-ok { margin: 4px 0 0; font-size: 13px; color: #6FBF8B; }
.sv-warn { margin: 4px 0 8px; font-size: 13px; color: var(--wf-text-2); }
.sv-problems { list-style: none; margin: 0; padding: 0; }
.sv-problems li { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; font-size: 12.5px; }
.sv-badge { font-size: 11px; padding: 0 6px; border-radius: var(--wf-r-pill); flex-shrink: 0; }
.sv-badge.is-missing { color: #E0714F; border: 1px solid #E0714F; }
.sv-badge.is-thin { color: #D9A441; border: 1px solid #D9A441; }
.sv-p-label { color: var(--wf-text); }
.sv-p-detail { color: var(--wf-faint); }
.sv-future { border-style: dashed; }
</style>
