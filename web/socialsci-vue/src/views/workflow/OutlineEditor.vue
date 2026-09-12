<script setup lang="ts">
/**
 * OutlineEditor — 还原自闭源 InputView-DwlhRWpv.js 的 OutlineEditor 组件(L125-573, scope data-v-e03bb037)
 * 大纲 markdown ↔ 树双向(7 类标题正则, 只收 1/2 级); 中文数序号; 加/删/移/折叠/插入模板/清除
 */
import { ref, watch, computed } from "vue";

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ (e: "update:modelValue", v: string): void; (e: "change", v: string): void }>();

interface OutlineNode {
  id: string;
  title: string;
  level: 1 | 2;
  collapsed?: boolean;
  children: OutlineNode[];
}

// 中文数字(一~二十, 闭源 w)
const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"];
const cnOf = (i: number) => CN[i] ?? String(i + 1);

const tree = ref<OutlineNode[]>([]);
let suppress = false; // 回写抑制(防循环)
let idSeq = 0;
const newId = () => `o${idSeq++}_${Date.now()}`;

// ── 空骨架(闭源 k(): 3 空一级各带 2 空子节) ──
function emptySkeleton(): OutlineNode[] {
  return [0, 1, 2].map(() => ({
    id: newId(), title: "", level: 1 as const, collapsed: false,
    children: [0, 1].map(() => ({ id: newId(), title: "", level: 2 as const, children: [] as OutlineNode[] }))
  }));
}

// ── 大纲文本 → 树(闭源 L() L171-225: 7 类标题正则) ──
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

// ── 树 → 大纲文本(闭源 B() L226-243) ──
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

// ── 插入模板(闭源 $(): 固定五章大纲) ──
function insertTemplate() {
  tree.value = [
    { id: newId(), title: "引言", level: 1, children: [
      { id: newId(), title: "问题提出与研究缘起", level: 2, children: [] },
      { id: newId(), title: "研究目的与意义", level: 2, children: [] },
      { id: newId(), title: "核心概念界定", level: 2, children: [] }
    ]},
    { id: newId(), title: "文献综述与分析框架", level: 1, children: [
      { id: newId(), title: "国内外研究现状", level: 2, children: [] },
      { id: newId(), title: "理论基础与分析框架", level: 2, children: [] },
      { id: newId(), title: "研究述评", level: 2, children: [] }
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
function clearOutline() {
  tree.value = emptySkeleton();
  pushOut();
}

const counter = computed(() => {
  const l1 = tree.value.length;
  const l2 = tree.value.reduce((s, n) => s + n.children.length, 0);
  return `${l1} 个一级 · ${l2} 个二级`;
});
</script>

<template>
  <div class="outline-editor">
    <!-- 工具栏 -->
    <div class="oe-toolbar">
      <button class="oe-btn primary" type="button" @click="addLevel1">+ 一级章节</button>
      <button class="oe-btn" type="button" @click="insertTemplate" data-assistant-control="workflow_outline_insert_template">插入模板</button>
      <button class="oe-btn" type="button" @click="clearOutline">清除目录</button>
      <span class="oe-count">{{ counter }}</span>
    </div>

    <!-- 空态 -->
    <div v-if="!tree.length" class="oe-empty">
      <p>目录为空, 请添加章节或插入模板</p>
      <button type="button" class="oe-empty-link" data-assistant-control="workflow_outline_insert_template_empty" @click="insertTemplate">插入模板</button>
    </div>

    <!-- 树 -->
    <div v-else class="oe-tree">
      <div v-for="(n, i) in tree" :key="n.id" class="oe-level1" :class="{ 'is-collapsed': n.collapsed }">
        <div class="oe-row l1">
          <span class="oe-index">{{ cnOf(i) }}</span>
          <button type="button" class="oe-collapse" :class="{ collapsed: n.collapsed }" title="折叠/展开" @click="toggleCollapse(i)">▼</button>
          <input
            class="oe-title-input"
            :value="n.title"
            placeholder="输入一级标题"
            @input="setTitle(i, ($event.target as HTMLInputElement).value)"
          />
          <div class="oe-ops">
            <button type="button" class="op-btn-sm" title="添加子节" @click="addChild(i)">+ 子节</button>
            <button type="button" class="op-btn" :disabled="i === 0" title="上移" @click="moveUp(i)">↑</button>
            <button type="button" class="op-btn" :disabled="i === tree.length - 1" title="下移" @click="moveDown(i)">↓</button>
            <button type="button" class="op-btn op-btn-danger" title="删除" @click="delLevel1(i)">✕</button>
          </div>
        </div>
        <!-- 子节 -->
        <div v-if="!n.collapsed" class="oe-children">
          <div v-for="(c, j) in n.children" :key="c.id" class="oe-row l2">
            <span class="oe-index sub">{{ i + 1 }}.{{ j + 1 }}</span>
            <input
              class="oe-title-input sub"
              :value="c.title"
              placeholder="输入二级标题"
              @input="setChildTitle(i, j, ($event.target as HTMLInputElement).value)"
            />
            <div class="oe-ops">
              <button type="button" class="op-btn-sm op-btn-danger" title="删除子节" @click="delChild(i, j)">✕</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.outline-editor {
  border: 1px solid #46587A;
  border-radius: 10px;
  overflow: hidden;
  background: #11192C;
}
.oe-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid #1A2333;
  background: #141E33;
  flex-wrap: wrap;
}
.oe-btn {
  padding: 4px 11px;
  font-size: 12px;
  border: 1px solid #46587A;
  border-radius: 6px;
  background: #11192C;
  color: #374151;
  cursor: pointer;
}
.oe-btn.primary {
  background: #dc2626;
  border-color: #dc2626;
  color: #F1F5F9;
}
.oe-btn:hover { filter: brightness(0.97); }
.oe-count { margin-left: auto; font-size: 11px; color: #8B9BB1; }
.oe-empty { padding: 34px 16px; text-align: center; }
.oe-empty p { margin: 0 0 10px; color: #8B9BB1; font-size: 13px; }
.oe-empty-link {
  color: #dc2626;
  font-size: 13px;
  text-decoration: underline;
  border: 0;
  background: none;
  cursor: pointer;
}
.oe-level1 { border-bottom: 1px solid #1A2333; }
.oe-level1:last-child { border-bottom: 0; }
.oe-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px;
}
.oe-row.l1 { background: #11192C; }
.oe-row.l2 { padding-left: 44px; background: #161F33; }
.oe-index {
  flex-shrink: 0;
  min-width: 22px;
  text-align: center;
  padding: 2px 6px;
  border-radius: 5px;
  background: #dc2626;
  color: #F1F5F9;
  font-size: 11px;
  font-weight: 600;
}
.oe-index.sub {
  background: #9ca3af;
  font-size: 10px;
  min-width: 34px;
}
.oe-collapse {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border: 0;
  background: transparent;
  color: #8B9BB1;
  font-size: 9px;
  cursor: pointer;
  transition: transform 0.15s;
}
.oe-collapse.collapsed { transform: rotate(-90deg); }
.oe-title-input {
  flex: 1;
  min-width: 0;
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
  color: #8B9BB1;
  font-size: 12px;
  cursor: pointer;
}
.op-btn:hover:not(:disabled) { background: #2A1C1C; color: #dc2626; }
.op-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.op-btn-sm {
  padding: 1px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #8B9BB1;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.op-btn-sm:hover { background: #2A1C1C; color: #dc2626; }
.op-btn-danger:hover { color: #dc2626; }
</style>
