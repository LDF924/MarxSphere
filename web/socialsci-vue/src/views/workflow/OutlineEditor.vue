<script setup lang="ts">
/**
 * OutlineEditor — 还原自参考产品 录入门 的 OutlineEditor 组件, scope data-v-e03bb037)
 * 大纲 markdown ↔ 树双向(7 类标题正则, 只收 1/2 级); 中文数序号; 加/删/移/折叠/插入模板/清除
 */
import { ref, watch, computed } from "vue";
import { confirmDialog } from "@/shared/ui";

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ (e: "update:modelValue", v: string): void; (e: "change", v: string): void }>();

interface OutlineNode {
  id: string;
  title: string;
  level: 1 | 2;
  collapsed?: boolean;
  children: OutlineNode[];
}

// 中文数字(一~二十, 参考产品 w)
const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"];
const cnOf = (i: number) => CN[i] ?? String(i + 1);

const tree = ref<OutlineNode[]>([]);
let suppress = false; // 回写抑制(防循环)
let idSeq = 0;
const newId = () => `o${idSeq++}_${Date.now()}`;

// ── 空骨架(参考产品同名函数: 3 空一级各带 2 空子节) ──
function emptySkeleton(): OutlineNode[] {
  return [0, 1, 2].map(() => ({
    id: newId(), title: "", level: 1 as const, collapsed: false,
    children: [0, 1].map(() => ({ id: newId(), title: "", level: 2 as const, children: [] as OutlineNode[] }))
  }));
}

// ── 大纲文本 → 树(参考产品同名函数: 7 类标题正则) ──
function parseOutline(text: string): OutlineNode[] {
  const lines = String(text ?? "").split("\n");
  const roots: OutlineNode[] = [];
  let cur: OutlineNode | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const t = line.trim();
    let level: number | null = null;
    let title = "";
    // ① markdown 标题 #~######
    const h = /^(#{1,6})\s+(.+)$/.exec(t);
    if (h) {
      level = h[1].length <= 2 ? 1 : 2;
      title = h[2].trim();
    }
    // ② 数字点层级: 1.1 / 1.2.3(两段及以上 → 二级; 本编辑器 serialize 只产两段 1.1)
    else if (/^\d+\.\d+(\.\d+)*/.test(t)) { level = 2; title = t.replace(/^\d+(\.\d+)+\.?\s*/, ""); }
    // ③ "1." 一级(单段数字后接 . 或 、)
    else if (/^\d+[.、]\s*/.test(t)) { level = 1; title = t.replace(/^\d+[.、]\s*/, ""); }
    // ④ 第X章(1)/第X节(2)
    else if (/^第[一二三四五六七八九十百0-9]+章/.test(t)) { level = 1; title = t.replace(/^第[一二三四五六七八九十百0-9]+章[、.\s]*/, ""); }
    else if (/^第[一二三四五六七八九十百0-9]+节/.test(t)) { level = 2; title = t.replace(/^第[一二三四五六七八九十百0-9]+节[、.\s]*/, ""); }
    // ⑤ 中文 一、(1)（一）(2)
    else if (/^[一二三四五六七八九十]+、/.test(t)) { level = 1; title = t.replace(/^[一二三四五六七八九十]+、\s*/, ""); }
    else if (/^（[一二三四五六七八九十]+）/.test(t)) { level = 2; title = t.replace(/^（[一二三四五六七八九十]+）\s*/, ""); }
    // ⑥ 缩进 bullet
    else {
      const indent = (raw.match(/^\s*/) ?? [""])[0].length;
      if (/^[-*•]/.test(t)) {
        level = indent >= 4 ? 3 : indent >= 2 ? 2 : 1;
        title = t.replace(/^[-*•]\s*/, "");
      } else {
        level = null;
        title = t;
      }
    }
    if (level === 3) level = 2; // 只收两级
    if (level === 1) {
      cur = { id: newId(), title, level: 1, children: [] };
      roots.push(cur);
    } else if (level === 2 && cur) {
      cur.children.push({ id: newId(), title, level: 2, children: [] });
    } else if (level === 2) {
      cur = { id: newId(), title, level: 1, children: [] };
      roots.push(cur);
    }
  }
  return roots;
}

// ── 树 → 大纲文本(参考产品同名函数 ──
function serialize(nodes: OutlineNode[]): string {
  return nodes
    .map((n, i) => {
      const head = `${cnOf(i)}、${n.title}`;
      const kids = n.children
        .map((c, j) => `  ${i + 1}.${j + 1} ${c.title}`)
        .join("\n");
      return kids ? `${head}\n${kids}` : head;
    })
    .join("\n");
}

watch(
  () => props.modelValue,
  (v) => {
    if (suppress) return;
    tree.value = parseOutline(v ?? "");
    if (!tree.value.length) tree.value = emptySkeleton();
  },
  { immediate: true }
);

function pushOut(extra?: { skipSuppress?: boolean }) {
  if (!extra?.skipSuppress) suppress = true;
  const out = serialize(tree.value);
  emit("update:modelValue", out);
  emit("change", out);
  setTimeout(() => (suppress = false), 0);
}

// ── 行操作 ──
function addLevel1() {
  tree.value.push({ id: newId(), title: "", level: 1, children: [] });
  pushOut();
}
function addChild(i: number) {
  const n = tree.value[i];
  if (!n) return;
  n.collapsed = false;
  n.children.push({ id: newId(), title: "", level: 2, children: [] });
  pushOut();
}
function delLevel1(i: number) {
  tree.value.splice(i, 1);
  pushOut();
}
function delChild(i: number, j: number) {
  tree.value[i]?.children.splice(j, 1);
  pushOut();
}
function moveUp(i: number) {
  if (i <= 0) return;
  const [n] = tree.value.splice(i, 1);
  tree.value.splice(i - 1, 0, n);
  pushOut();
}
function moveDown(i: number) {
  if (i >= tree.value.length - 1) return;
  const [n] = tree.value.splice(i, 1);
  tree.value.splice(i + 1, 0, n);
  pushOut();
}
function toggleCollapse(i: number) {
  const n = tree.value[i];
  if (n) n.collapsed = !n.collapsed;
}
function setTitle(i: number, v: string) {
  tree.value[i].title = v;
  pushOut();
}
function setChildTitle(i: number, j: number, v: string) {
  const c = tree.value[i]?.children[j];
  if (c) c.title = v;
  pushOut();
}

// ── 插入模板(参考产品同名函数: 固定五章大纲) ──
function insertTemplate() {
  tree.value = [
    { id: newId(), title: "引言", level: 1, children: [
      { id: newId(), title: "问题提出与研究缘起", level: 2, children: [] },
      { id: newId(), title: "研究目的与意义", level: 2, children: [] },
      { id: newId(), title: "核心概念界定", level: 2, children: [] }
    ]},
    { id: newId(), title: "文献综述与分析框架", level: 1, children: [
      { id: newId(), title: "相关领域研究进展", level: 2, children: [] },
      { id: newId(), title: "现有研究的不足与本研究的切入点", level: 2, children: [] },
      { id: newId(), title: "本文的分析框架", level: 2, children: [] }
    ]},
    { id: newId(), title: "现状描述或案例呈现", level: 1, children: [
      { id: newId(), title: "数据来源与研究对象", level: 2, children: [] },
      { id: newId(), title: "主要特征与发展趋势", level: 2, children: [] }
    ]},
    { id: newId(), title: "问题分析与对策建议", level: 1, children: [
      { id: newId(), title: "存在的主要问题及成因", level: 2, children: [] },
      { id: newId(), title: "对策建议与路径选择", level: 2, children: [] }
    ]},
    { id: newId(), title: "结语", level: 1, children: [
      { id: newId(), title: "主要结论", level: 2, children: [] },
      { id: newId(), title: "研究局限与展望", level: 2, children: [] }
    ]}
  ];
  pushOut();
}
async function clearOutline() {
  // V417: 一键清空整份大纲且无确认(对比: 删单条素材都有 confirmDialog)。加确认。
  const ok = await confirmDialog({
    title: "清空目录?",
    message: "将删除当前全部章节与子节(只保留一个空骨架), 此操作不可撤销。",
    okText: "清空",
    cancelText: "取消",
    danger: true,
  });
  if (!ok) return;
  tree.value = emptySkeleton();
  pushOut();
}

const counter = computed(() => {
  const l1 = tree.value.length;
  const l2 = tree.value.reduce((s, n) => s + n.children.length, 0);
  // 无二级时退化成「N 个章节」(参考产品如此) —— "3 个一级 · 0 个二级"读起来像出错了
  return l2 === 0 ? `${l1} 个章节` : `${l1} 个一级 · ${l2} 个二级`;
});
</script>

<template>
  <div class="outline-editor">
    <!-- 工具栏(闭源: 三个同款白底描边小按钮, 之间用 | 分隔; 清除目录文字更淡) -->
    <div class="oe-toolbar">
      <button class="oe-btn" type="button" @click="addLevel1">+ 一级章节</button>
      <span class="oe-sep">|</span>
      <button class="oe-btn" type="button" @click="insertTemplate" data-control="workflow:insert-template">插入模板</button>
      <span class="oe-sep">|</span>
      <button class="oe-btn dim" type="button" @click="clearOutline">清除目录</button>
      <span class="oe-count">{{ counter }}</span>
    </div>

    <!-- 空态 -->
    <div v-if="!tree.length" class="oe-empty">
      <p>目录为空, 请添加章节或插入模板</p>
      <button type="button" class="oe-empty-link" data-control="workflow:insert-template-empty" @click="insertTemplate">插入模板</button>
    </div>

    <!-- 树 -->
    <div v-else class="oe-tree">
      <div v-for="(n, i) in tree" :key="n.id" class="oe-level1" :class="{ 'is-collapsed': n.collapsed }">
        <div class="oe-row l1">
          <span class="oe-index">{{ cnOf(i) }}</span>
          <input
            class="oe-title-input"
            :value="n.title"
            placeholder="输入一级标题"
            @input="setTitle(i, ($event.target as HTMLInputElement).value)"
          />
          <!-- 闭源把「+ 子节」与折叠箭头放在 input **之后**的常显小组里(`w-6 h-6` 图标钮,
               不参与 .group:hover 揭示), 只有 ↑↓✕ 是悬停才出现的 .op-btn。
               2026-09-16 修: 我方原先「+ 子节」混在悬停组里当文字按钮(.op-btn-sm), 且折叠箭头
               摆在 input 之前的行首、任何情况都渲染 —— 位置与显隐规则两处都不对。 -->
          <div class="oe-inline-ops">
            <button type="button" class="op-btn-add" title="添加子节" @click="addChild(i)">+</button>
            <button
              v-if="n.children.length"
              type="button" class="op-btn-add" :title="n.collapsed ? '展开' : '折叠'"
              @click="toggleCollapse(i)"
            >{{ n.collapsed ? "▶" : "▼" }}</button>
          </div>
          <div class="oe-ops">
            <button type="button" class="op-btn" :disabled="i === 0" title="上移" @click="moveUp(i)">↑</button>
            <button type="button" class="op-btn" :disabled="i === tree.length - 1" title="下移" @click="moveDown(i)">↓</button>
            <button type="button" class="op-btn op-btn-danger" title="删除" @click="delLevel1(i)">✕</button>
          </div>
        </div>
        <!-- 子节(闭源树形缩进: 竖线 + 缩进块) -->
        <div v-if="!n.collapsed" class="oe-children tree-branch">
          <div v-for="(c, j) in n.children" :key="c.id" class="oe-row l2 tree-child">
            <span class="oe-index sub">{{ i + 1 }}.{{ j + 1 }}</span>
            <input
              class="oe-title-input sub"
              :value="c.title"
              placeholder="输入二级标题"
              @input="setChildTitle(i, j, ($event.target as HTMLInputElement).value)"
            />
            <div class="oe-ops">
              <button type="button" class="op-btn-sm" title="删除子节" @click="delChild(i, j)">✕</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.outline-editor {
  border: 1px solid var(--wf-line-hard);
  border-radius: 10px;
  overflow: hidden;
  background: var(--wf-surface);
}
.oe-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--wf-raised);
  background: #141E33;
  flex-wrap: wrap;
}
.oe-btn {
  padding: 4px 11px;
  font-size: 12px;
  border: 1px solid var(--wf-line-hard);
  border-radius: 6px;
  background: var(--wf-surface);
  /* V417: 原为 #374151(近黑)压深蓝黑底, 对比度 ≈1.7:1, 文字几乎不可见 —— 深色化时漏改。
     取 #C7D2E0 与同目录 .oe-count(var(--wf-muted)) 同一色系但更亮, 对比度 ≈11:1(WCAG AA 要求 4.5:1)。 */
  color: #C7D2E0;
  cursor: pointer;
}
/* 参考产品三个工具按钮同款白底描边; 「清除目录」文字更淡(破坏性操作用弱视觉) */
.oe-btn.dim { color: var(--wf-faint); }
.oe-sep { color: var(--wf-line-hard); font-size: 11px; }
.oe-btn:hover { filter: brightness(0.97); }
.oe-count { margin-left: auto; font-size: 11px; color: var(--wf-muted); }
.oe-empty { padding: 34px 16px; text-align: center; }
.oe-empty p { margin: 0 0 10px; color: var(--wf-muted); font-size: 13px; }
.oe-empty-link {
  color: #4D84CB;
  font-size: 13px;
  text-decoration: underline;
  border: 0;
  background: none;
  cursor: pointer;
}
/* V420b: 一级章节改成两列网格 —— 原先每行都是一条横贯整页的长条(输入框被拉到 1200px+),
   而章节名通常很短, 右半行全是空的。两列后一屏能看到双倍章节, 也省纵向滚动。
   `grid-auto-rows` 不设, 让各行按自身内容高度; 折叠/展开时只影响自己那一格。 */
.oe-tree { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 0 18px; align-items: start; }
@media (max-width: 1380px) { .oe-tree { grid-template-columns: minmax(0, 1fr); } }
.oe-level1 { border-bottom: 1px solid var(--wf-raised); min-width: 0; }
.oe-level1:last-child { border-bottom: 0; }
.oe-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px;
}
.oe-row.l1 { background: var(--wf-surface); }
.oe-row.l2 { padding-left: 44px; background: var(--wf-sunken); }
.oe-index {
  flex-shrink: 0;
  min-width: 22px;
  text-align: center;
  padding: 2px 6px;
  border-radius: 5px;
  /* 参考产品一级序号是**纯红字无底块**(text-sm font-bold text-red-500 w-8), 不是红底药丸 */
  background: transparent;
  color: #E88A8A;
  font-size: 13px;
  font-weight: 700;
}
.oe-index.sub {
  background: transparent;
  color: var(--wf-muted);
  font-size: 11px;
  font-weight: 600;
  min-width: 34px;
}
/*
 * 子节树形 —— 逐条对齐参考产品 InputView-D7ddvbNn.css:
 *   .tree-branch{margin-left:28px;padding-left:20px;border-left:1.5px solid}
 *   .tree-child:before{left:-20px;top:50%;width:16px;height:1.5px}   ← 水平连接线
 *   .tree-child-last:after{left:-21px;bottom:0;width:3px;height:50%} ← 末行遮住下半段竖线
 * 2026-09-16 修: 我方原先只有竖线 + 缩进(20/12), **没有任何水平连接线** ——
 *   子节与父章之间的树形关系看不出来, 缩进量也小一档。
 */
.oe-children.tree-branch {
  position: relative;
  margin-left: 28px;
  padding-left: 20px;
  border-left: 1.5px solid var(--wf-raised);
}
.oe-row.l2.tree-child { position: relative; padding-top: 6px; padding-bottom: 6px; }
/* 水平连接短线(从竖线连到子节行) */
.oe-row.l2.tree-child::before {
  content: "";
  position: absolute;
  left: -20px;
  top: 50%;
  width: 16px;
  height: 1.5px;
  background: var(--wf-raised);
}
/* 末行: 用背景色遮住竖线的下半段, 让树"收住"(参考产品 tree-child-last 语义) */
.oe-row.l2.tree-child:last-child::after {
  content: "";
  position: absolute;
  left: -21px;
  bottom: 0;
  width: 3px;
  height: 50%;
  background: var(--wf-surface);
  pointer-events: none;
}
/* 参考产品常显小组: 两个 `w-6 h-6 rounded` 图标钮(蓝 hover), 与悬停才出的 .op-btn 分开 */
.oe-inline-ops { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.op-btn-add {
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--wf-muted);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s;
}
.op-btn-add:hover { color: #6FA8F5; background: #16203A; }
.oe-title-input {
  flex: 1;
  min-width: 0;
  /* 这条 `68ch` 上限与 InputView 那条同病: 它是给全宽页写的, 而本控件有 `flex: 1`,
     已经撑满剩余的 500px(实测) —— 914px 的上限够不到, 属于死规则。
     收进令牌只为统一口径, 行为不变。 */
  max-width: var(--wf-field-max, 120ch);
  border: 0;
  padding: 5px 2px;
  font-size: 13px;
  background: transparent;
  outline: none;
}
.oe-title-input.sub { font-size: 12.5px; }
.oe-title-input:focus { border-bottom: 1px solid #bfdbfe; }
.oe-ops { display: flex; gap: 2px; align-items: center; flex-shrink: 0; opacity: 0; transition: opacity 0.15s; }
.oe-row:hover .oe-ops { opacity: 1; }
.op-btn {
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--wf-muted);
  font-size: 12px;
  cursor: pointer;
}
.op-btn:hover:not(:disabled) { background: #2A1C1C; color: #4D84CB; }
.op-btn:disabled { opacity: 0.3; cursor: not-allowed; }
/* 参考产品 .op-btn-sm{width:18px;height:18px;font-size:10px} —— 2026-09-16 修:
   我方原先是 `padding:1px 6px` 的文字按钮, 尺寸随文案变。现在只用于子节行的 ✕,
   与 .op-btn 一样走「悬停才显形」(.oe-row:hover .oe-ops / 子节行同理)。 */
.op-btn-sm {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--wf-muted);
  font-size: 10px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}
.op-btn-sm:hover { background: #2A1C1C; color: #4D84CB; }
.op-btn-danger:hover { color: #dc2626; }
</style>
