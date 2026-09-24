<script setup lang="ts">
/**
 * LiteratureMatrixPanel —— 文献提取矩阵(Elicit 式「选论文集 → 定列 → 逐篇提取成表」)
 *
 * 由来(2026-09-24): `POST /api/literature/matrix` 后端早就有了, **外壳也接了**
 *   (`web/src/components/LiteratureMatrixPanel.tsx`), 但写作舱零引用 ——
 *   而"把已选文献摆成一张对照表"恰恰是写文献综述那一步最需要的东西。
 *
 * 与外壳那个面板的差别(不是重复实现):
 *   · 外壳的论文清单来自「文献库」当前那一页(`LiteraturePanel` 传的是分页后的 items),
 *     也就是"我在库里翻到哪就提取哪几篇";
 *   · 这里是**写作舱已整理的文献素材** —— 也就是这个课题真正要用、已经在写的那批。
 *
 * ⚠ 成本: 这个端点是全仓单次调用最贵的 —— 后端对**每一篇**各调一次 LLM(上限 30 篇,
 *   每篇 12k 字符 prompt)。所以这里必须把还没选时的状态说清楚, 让用户知道自己在点的是什么;
 *   同时服务端已把它纳入额度闸门(BUDGET_GATED_PREFIXES, 2026-09-24 补)。
 */
import { computed, ref } from "vue";
import { toast } from "@/shared/ui";
import { q } from "@/shared/api";
import EmptyState from "./EmptyState.vue";

interface RefEntry { title?: string; doi?: string; year?: string; author?: string; authors?: string }

const props = defineProps<{
  /** 写作舱已整理的文献素材(其 references 会被摊平成待提取的论文清单) */
  materials: Array<Record<string, unknown>>;
}>();

interface Paper { id: string; title: string }

/**
 * 待提取的论文清单 —— 取文献素材的 `references`。
 *
 * 为什么用 `title` 当 id: 后端的 `literature-matrix-service` 走的是
 * `literatureService.getDetail(paperId)`(本地文献库主键), 而这些 reference 条目
 * **未必在本地库里**(可能是手工录入或检索后只存了素材)。
 * 所以这里的 id 用标题 —— 与后端 `loadPaperText` 的兜底口径一致: 命中不了就用标题找。
 * 命不中的会在返回的 `warnings` 里点名, 面板照实显示, 不假装全都提取到了。
 */
const papers = computed<Paper[]>(() => {
  const out: Paper[] = [];
  const seen = new Set<string>();
  for (const m of props.materials ?? []) {
    const refs = m.references;
    if (!Array.isArray(refs)) continue;
    for (const r of refs as RefEntry[]) {
      const t = String(r?.title ?? "").trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push({ id: t, title: t });
    }
  }
  return out;
});

/** 内置提取列 —— 与后端/外壳同一套(研究主题/方法/数据/观点/结论/局限) */
const COMMON_COLS = [
  { key: "topic", label: "研究主题" },
  { key: "method", label: "研究方法" },
  { key: "data", label: "数据来源" },
  { key: "view", label: "核心观点" },
  { key: "conclusion", label: "主要结论" },
  { key: "limitation", label: "局限" },
];
const pickedCols = ref<string[]>(COMMON_COLS.slice(0, 3).map((c) => c.key));
const customCols = ref<{ key: string; label: string }[]>([]);
const newCol = ref("");
const allCols = computed(() => [...COMMON_COLS, ...customCols.value]);

interface MatrixCell { paperId: string; paperTitle: string; columnKey: string; value: string; quote?: string }
interface MatrixResult { papers: Array<{ id: string; title: string }>; cells: MatrixCell[]; warnings?: string[] }

const running = ref(false);
const result = ref<MatrixResult | null>(null);
const openQuote = ref("");

function toggleCol(k: string) {
  const next = pickedCols.value.includes(k) ? pickedCols.value.filter((x) => x !== k) : [...pickedCols.value, k];
  pickedCols.value = next;
}
function addCol() {
  const label = newCol.value.trim();
  if (!label) return;
  const key = "custom" + Math.random().toString(36).slice(2, 8);
  customCols.value = [...customCols.value, { key, label }];
  pickedCols.value = [...pickedCols.value, key];
  newCol.value = "";
}

async function run() {
  if (!papers.value.length) { toast("还没有可提取的文献（请先在文献素材里录入参考文献条目）", "warning"); return; }
  const cols = allCols.value.filter((c) => pickedCols.value.includes(c.key));
  if (!cols.length) { toast("请至少选择一列要提取的内容", "warning"); return; }
  if (papers.value.length > 30) { toast(`最多一次提取 30 篇，当前 ${papers.value.length} 篇`, "warning"); return; }
  running.value = true;
  result.value = null;
  try {
    const r = await q<MatrixResult>(`/literature/matrix`, {
      method: "POST",
      body: { paperIds: papers.value.slice(0, 30).map((p) => p.id), columns: cols },
    });
    result.value = r;
    const cells = r?.cells?.length ?? 0;
    toast(cells ? `提取完成：${cells} 个单元格` : "提取完成，但没有取到内容", cells ? "success" : "warning");
  } catch (e) {
    toast(`提取失败：${(e as Error).message}`, "error");
  } finally {
    running.value = false;
  }
}

/** 矩阵渲染: 行=论文, 列=提取项 */
const matrix = computed(() => {
  const r = result.value;
  if (!r) return { rows: [] as Array<{ paper: { id: string; title: string }; cells: Record<string, { value: string; quote?: string }> }>, cols: [] as typeof COMMON_COLS };
  const cols = allCols.value.filter((c) => pickedCols.value.includes(c.key));
  const rows = (r.papers ?? []).map((p) => {
    const cells: Record<string, { value: string; quote?: string }> = {};
    for (const c of cols) {
      const hit = r.cells.find((x) => x.paperId === p.id && x.columnKey === c.key);
      cells[c.key] = { value: hit?.value ?? "", ...(hit?.quote ? { quote: hit.quote } : {}) };
    }
    return { paper: p, cells };
  });
  return { rows, cols };
});

function exportCsv() {
  const m = matrix.value;
  if (!m.rows.length) return;
  const esc = (s: string) => `"${String(s ?? "").replace(/"/g, '""').replace(/[\r\n]+/g, " ")}"`;
  const head = ["文献", ...m.cols.map((c) => c.label)].map(esc).join(",");
  const body = m.rows.map((r) => [r.paper.title, ...m.cols.map((c) => r.cells[c.key]?.value ?? "")].map(esc).join(","));
  // BOM: 不带头 Excel 打开中文是乱码
  const blob = new Blob(["﻿" + [head, ...body].join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "文献提取矩阵.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}
</script>

<template>
  <div class="lmp">
    <p class="lmp-sub">
      把已整理的文献摆成一张对照表，一列一项内容。每篇各调一次模型提取，所以
      <strong>选几列、提取几篇</strong>都直接影响耗时与用量。
    </p>

    <EmptyState
      v-if="!papers.length"
      title="还没有可提取的文献"
      hint="先在「文献与资料」里录入文献素材（含参考文献条目），再回来做提取矩阵。"
    />

    <template v-else>
      <div class="lmp-cols">
        <span class="lmp-cols-label">提取列</span>
        <button
          v-for="c in allCols" :key="c.key"
          class="lmp-chip" :class="{ on: pickedCols.includes(c.key) }"
          :data-control="`workflow:matrix-col-${c.key}`"
          @click="toggleCol(c.key)"
        >{{ c.label }}</button>
        <input v-model="newCol" class="lmp-newcol" placeholder="自定义列…" @keyup.enter="addCol" />
        <button v-if="newCol.trim()" class="lmp-addcol" data-control="workflow:matrix-addcol" @click="addCol">+ 添加</button>
      </div>

      <div class="lmp-actions">
        <span class="lmp-count">共 {{ papers.length }} 篇文献 · 已选 {{ pickedCols.length }} 列</span>
        <button class="lmp-btn lmp-btn--go" data-control="workflow:matrix-run" :disabled="running || !pickedCols.length" @click="run">
          {{ running ? "提取中…" : "开始提取" }}
        </button>
        <button v-if="matrix.rows.length" class="lmp-btn" data-control="workflow:matrix-export" @click="exportCsv">导出 CSV</button>
      </div>

      <!-- warnings 照实显示: 后端对那些"在本地库里找不到"的论文会点名, 藏起来会让人以为全提取到了 -->
      <p v-if="result?.warnings?.length" class="lmp-warn">
        {{ result.warnings.length }} 条提示：{{ result.warnings.slice(0, 3).join("；") }}
      </p>

      <div v-if="matrix.rows.length" class="lmp-table-wrap">
        <table class="three-line-table lmp-table">
          <thead>
            <tr>
              <th class="lmp-th-paper">文献</th>
              <th v-for="c in matrix.cols" :key="c.key">{{ c.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in matrix.rows" :key="row.paper.id">
              <td class="lmp-td-paper" :title="row.paper.title">{{ row.paper.title }}</td>
              <td v-for="c in matrix.cols" :key="c.key">
                <span v-if="row.cells[c.key]?.value">{{ row.cells[c.key].value }}</span>
                <span v-else class="lmp-empty">—</span>
                <button
                  v-if="row.cells[c.key]?.quote"
                  class="lmp-quote-btn"
                  @click="openQuote = openQuote === row.paper.id + c.key ? '' : row.paper.id + c.key"
                >引文</button>
                <p v-if="row.cells[c.key]?.quote && openQuote === row.paper.id + c.key" class="lmp-quote">
                  {{ row.cells[c.key].quote }}
                </p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lmp { display: flex; flex-direction: column; gap: var(--wf-s3); }
.lmp-sub { margin: 0; font-size: var(--wf-f-sm); color: var(--wf-muted); line-height: 1.7; }
.lmp-sub strong { color: var(--wf-text-2); }
.lmp-cols { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.lmp-cols-label { font-size: var(--wf-f-xs); color: var(--wf-faint); margin-right: 2px; }
.lmp-chip {
  cursor: pointer; border-radius: var(--wf-r-pill); padding: 3px 11px;
  font-size: var(--wf-f-xs); background: transparent;
  border: 1px solid var(--wf-line-strong); color: var(--wf-muted);
  transition: all var(--wf-dur-fast) var(--wf-ease);
}
.lmp-chip.on { border-color: var(--wf-accent); color: var(--wf-accent-hi); background: var(--wf-accent-soft); }
.lmp-newcol {
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-surface-2); color: var(--wf-text); padding: 3px 9px; font-size: var(--wf-f-xs); width: 110px;
}
.lmp-addcol {
  cursor: pointer; border: 1px solid var(--wf-line-strong); border-radius: var(--wf-r-sm);
  background: transparent; color: var(--wf-text-2); padding: 3px 9px; font-size: var(--wf-f-xs);
}
.lmp-actions { display: flex; align-items: center; gap: var(--wf-s2); }
.lmp-count { font-size: var(--wf-f-xs); color: var(--wf-faint); }
.lmp-btn {
  cursor: pointer; border: 1px solid var(--wf-line-strong); border-radius: var(--wf-r-sm);
  background: transparent; color: var(--wf-text-2); padding: 5px 12px; font-size: var(--wf-f-sm);
  transition: background var(--wf-dur-fast) var(--wf-ease);
}
.lmp-btn:hover:not(:disabled) { background: var(--wf-raised); }
.lmp-btn:disabled { opacity: .5; cursor: not-allowed; }
.lmp-btn--go { margin-left: auto; border-color: var(--wf-accent); color: var(--wf-accent-hi); }
.lmp-btn--go:hover:not(:disabled) { background: var(--wf-accent-soft); }
.lmp-warn { margin: 0; font-size: var(--wf-f-xs); color: var(--wf-warn); line-height: 1.6; }
.lmp-table-wrap { overflow-x: auto; }
.lmp-table { font-size: var(--wf-f-xs); }
.lmp-th-paper, .lmp-td-paper { max-width: 220px; }
.lmp-td-paper { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lmp-empty { color: var(--wf-faint); }
.lmp-quote-btn {
  margin-left: 6px; cursor: pointer; border: 0; background: transparent;
  color: var(--wf-accent-hi); font-size: 10px; text-decoration: underline; padding: 0;
}
.lmp-quote {
  margin: 4px 0 0; padding: 4px 7px; border-left: 2px solid var(--wf-line-strong);
  color: var(--wf-muted); font-size: var(--wf-f-xs); line-height: 1.6;
}
</style>
