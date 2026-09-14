<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { RouterView, useRoute } from "vue-router";
import { ToastHost, ConfirmHost } from "./shared/ui";
import { collectDomActions, onActionInvoked, reportActions } from "./shared/actions-bridge";

// ── 当前页可执行动作 → 上报 React 外壳的科研助手(V416) ──
// 全站一处接线: 只要按钮带 data-control 就会被自动收集上报, 各视图不用各自写桥接代码。
// 用 MutationObserver 而不是只在路由变化时报: 页面内部切 tab / 弹层打开都会让按钮增删,
// 路由没变但动作变了, 只看路由会漏。
const route = useRoute();
let timer: number | undefined;
let mo: MutationObserver | undefined;

const push = () => {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    // FusionPanel 有个"单例保活池": 切走的 iframe 不会销毁, 只是被移到一个 left:-9999px 的
    // 隐藏宿主里继续活着(见 FusionPanel.tsx)。那种状态下**不要上报** —— 否则科研助手的
    // "当前页可执行"会混进别的工作台的按钮, 点下去还会改到看不见的那个页面。
    if (window.innerWidth === 0 || document.hidden) { reportActions(route.path, []); return; }
    reportActions(route.path, collectDomActions(route.path));
  }, 250);
};

/** 外壳点了某个动作 → 按 id 找回那个 DOM 元素并点击(元素可能已不在, 找不到就静默) */
function invokeFromShell(id: string) {
  if (!id.startsWith(`${route.path}:`)) return;
  const key = id.slice(route.path.length + 1);
  const el = document.querySelector<HTMLElement>(`[data-control="${key}"]`);
  if (el && !(el as HTMLButtonElement).disabled) el.click();
}

onMounted(() => {
  const stop = onActionInvoked(route.path, invokeFromShell);
  mo = new MutationObserver(push);
  // 看结构变化 + **disabled 属性**。
  // 只监听 childList 是不够的(实测踩到): 用户填完"任务输入"后, Vue 只是把已有按钮的
  // disabled 属性翻掉, 没有增删节点 → 不触发 → 动作表一直是旧的(「▶ 运行」永远不出现)。
  // 只过滤 disabled 而不是全属性: class/style 变动太频繁, 全监听会一直重扫。
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
  push();
  onBeforeUnmount(() => { stop(); mo?.disconnect(); window.clearTimeout(timer); });
});
</script>

<template>
  <div class="soc-shell" style="height: 100vh; display: flex; flex-direction: column; overflow: hidden">
    <RouterView />
    <ToastHost />
    <ConfirmHost />
  </div>
</template>
