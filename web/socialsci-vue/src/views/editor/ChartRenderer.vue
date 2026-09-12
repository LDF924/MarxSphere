<script setup lang="ts">
/**
 * ChartRenderer — 还原自闭源 ChartRenderer-DVxWvy7W.js(scope data-v-4f047ab7)
 * mermaid: 懒加载 mermaid → render().svg → DOMPurify(svg 白名单) → v-html
 * echarts: 懒加载 echarts → init(div 350px) → setOption → ResizeObserver 自适应
 * 样式: 外框 1px #222F44 radius 12 / error #F08A8A 12px / mermaid 白底居中 / echarts 高 350px
 */
import { ref, watch, onMounted, onUnmounted } from "vue";
import DOMPurify from "dompurify";

const props = defineProps<{ code?: string; chartType?: string }>();
const html = ref("");
const error = ref("");
const mermaidRef = ref<HTMLDivElement | null>(null);
const echartsRef = ref<HTMLDivElement | null>(null);
let echartsInstance: { setOption: (o: unknown) => void; dispose: () => void; resize: () => void } | null = null;
let resizeObserver: ResizeObserver | null = null;

async function render() {
  error.value = "";
  html.value = "";
  const code = props.code || "";
  const type = props.chartType || "";
  if (!code || !type) return;
  try {
    if (type.startsWith("mermaid")) {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "strict" });
      const { svg } = await mermaid.render(`chart-${Date.now()}`, code);
      html.value = DOMPurify.sanitize(svg, { ADD_TAGS: ["svg"], ADD_ATTR: ["viewBox", "xmlns"] });
    } else if (type.startsWith("echarts")) {
      const echarts = await import("echarts");
      if (!echartsRef.value) return;
      const parsed = (() => {
        try {
          return typeof code === "string" && code.trim().startsWith("{") ? JSON.parse(code) : code;
        } catch {
          return code;
        }
      })();
      if (!echartsInstance) {
        echartsInstance = echarts.init(echartsRef.value);
        resizeObserver = new ResizeObserver(() => echartsInstance?.resize());
        resizeObserver.observe(echartsRef.value);
      }
      echartsInstance.setOption(parsed);
    } else {
      error.value = `未知图表类型: ${type}`;
    }
  } catch (e) {
    error.value = `${type === "mermaid" || type.startsWith("mermaid") ? "图表" : type}渲染失败: ${(e as Error).message}`;
  }
}

watch([() => props.code, () => props.chartType], () => void render(), { immediate: false });
onMounted(() => {
  if (props.code && props.chartType) void render();
  // echarts 容器渲染时机: nextTick 后
  setTimeout(() => {
    if (props.code && props.chartType && props.chartType.startsWith("echarts")) void render();
  }, 0);
});
onUnmounted(() => {
  resizeObserver?.disconnect();
  echartsInstance?.dispose();
  echartsInstance = null;
});
</script>

<template>
  <div class="ade-chart-renderer">
    <div v-if="error" class="ade-chart-renderer__error">{{ error }}</div>
    <div v-else-if="chartType?.startsWith('mermaid') && html" class="ade-chart-renderer__mermaid" v-html="html"></div>
    <div v-else-if="chartType?.startsWith('echarts')" ref="echartsRef" class="ade-chart-renderer__echarts"></div>
  </div>
</template>

<style scoped>
.ade-chart-renderer {
  width: 100%;
  min-height: 220px;
  border: 1px solid #222F44;
  border-radius: 12px;
  overflow: hidden;
  background: #11192C;
  box-shadow: 0 1px 3px #0000000a;
}
.ade-chart-renderer__error {
  padding: 16px;
  color: #F08A8A;
  font-size: 12px;
  font-weight: 500;
}
.ade-chart-renderer__mermaid {
  padding: 20px;
  display: flex;
  justify-content: center;
  background: #141E33;
}
.ade-chart-renderer__mermaid :deep(svg) {
  max-width: 100%;
  height: auto;
}
.ade-chart-renderer__echarts {
  width: 100%;
  height: 350px;
}
</style>
