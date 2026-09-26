<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { ToastHost, ConfirmHost } from "./shared/ui";
import { collectDomActions, onActionInvoked, reportActions } from "./shared/actions-bridge";
import { HANDOFF_KEY, installWorkflowRouteBridge, reportSocRoute, resetHandoffClaim } from "./shared/workflow-bridge";

// ── 当前页可执行动作 → 上报 React 外壳的科研助手(V416) ──
// 全站一处接线: 只要按钮带 data-control 就会被自动收集上报, 各视图不用各自写桥接代码。
// 用 MutationObserver 而不是只在路由变化时报: 页面内部切 tab / 弹层打开都会让按钮增删,
// 路由没变但动作变了, 只看路由会漏。
const route = useRoute();
const router = useRouter();
let timer: number | undefined;
let mo: MutationObserver | undefined;

// ── V417: 外部模块投递的素材 —— 收在 soc 外壳层, 不放在 MaterialsView ──
// 教训(实测): 监听器放 MaterialsView 时, 外壳把素材投过来那一刻 iframe 还停在
// #/workflow/input → 监听器尚未注册 → 消息静默丢弃。"先 postMessage 再等接收方挂载"
// 必丢(与 ReviewView 的那条结论同源)。外壳是常驻的, 收下后再引导到素材页。
const onExternalMaterial = (e: MessageEvent) => {
  const d = e.data as { source?: string; type?: string; kind?: string; title?: string; markdown?: string } | null;
  if (d?.source !== "marxsphere-app" || d.type !== "workflow-material" || !d.markdown?.trim()) return;
  try {
    localStorage.setItem(HANDOFF_KEY, JSON.stringify({
      kind: d.kind ?? "note", title: d.title ?? "外部素材", markdown: d.markdown, at: Date.now(),
    }));
  } catch { /* localStorage 不可用时只能丢 */ }
  /**
   * ⚠ 必须放回读取标志。
   *
   * 2026-09-26 修：`claimed` 是模块级内存标志，readRaw 有内容就置 true。
   * 上一条素材被消费后它**停在 true**，于是第二条投递进来、MaterialsView 重新挂载时
   * claimHandoff 直接返回 null —— 素材在 localStorage 里躺着却永远导不进来。
   * 每次写入都是「一条新的、还没被消费的素材」，标志必须跟着回到未消费态。
   */
  resetHandoffClaim();
  // 交完再引导到素材页(读方主动取, 与编辑器交接同一套约定)
  if (!route.path.startsWith("/workflow/materials")) void router.push("/workflow/materials");
};

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

/**
 * 外壳点了某个动作 → 按 id 找回那个 DOM 元素并点击。
 *
 * 2026-09-16: 原先是 `querySelector` 取**第一个**匹配, 且 `el.disabled` 就静默放弃。
 * 两个坑:
 *   ① 上报侧虽然按 id 去重, 页面里同一个 id 仍可能有多个实例; 第一个恰好禁用时,
 *      动作会**静默失效** —— 用户点了助手里的按钮, 页面毫无反应, 也没有任何提示。
 *   ② 元素可能已不在(路由/弹层变化)。
 * 现在: 优先挑**可点的那个实例**; 全都点不了就给一句可见反馈(总比静默好)。
 */
function invokeFromShell(id: string) {
  if (!id.startsWith(`${route.path}:`)) return;
  const key = id.slice(route.path.length + 1);
  const els = Array.from(document.querySelectorAll<HTMLElement>(`[data-control="${key}"]`));
  if (!els.length) return;
  const usable = els.find((e) => !(e as HTMLButtonElement).disabled && e.getClientRects().length);
  if (usable) { usable.click(); return; }
  // 全不可点: 区分"隐藏"与"禁用", 给出可操作的说法
  const disabled = els.some((e) => (e as HTMLButtonElement).disabled);
  window.parent?.postMessage(
    { source: "marxsphere-soc", type: "action-blocked", id, reason: disabled ? "disabled" : "hidden" },
    "*"
  );
}

onMounted(() => {
  const stop = onActionInvoked(route.path, invokeFromShell);
  mo = new MutationObserver(push);
  // 看结构变化 + **disabled 属性**。
  // 只监听 childList 是不够的(实测踩到): 用户填完"任务输入"后, Vue 只是把已有按钮的
  // disabled 属性翻掉, 没有增删节点 → 不触发 → 动作表一直是旧的(「▶ 运行」永远不出现)。
  // 只过滤 disabled 而不是全属性: class/style 变动太频繁, 全监听会一直重扫。
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
  window.addEventListener("message", onExternalMaterial as unknown as EventListener);
  /**
   * 每次路由变化把"当前停在哪一页"上报外壳（2026-09-24 加）。
   *
   * 外壳要回答两个问题："离开这个工作台时它停在哪"、"回来时怎么恢复"。
   * 而 FusionPanel 的单例保活池让 iframe 常驻 —— 外壳**读不到**它的真实 hash
   * （跨源 contentWindow 访问会抛 SecurityError，FusionPanel.tsx 里已经踩过），
   * 于是只能由 iframe 自己说。放在这里而不是 main.ts：App.vue 是 RouterView 的宿主，
   * useRoute 的 watcher 拿到的 path 与用户看到的一页一一对应。
   */
  const stopRouteWatch = watch(() => route.path, (p) => { if (p) reportSocRoute("workflow", p); }, { immediate: true });
  // 外壳的下行路由指令(「返回研途写作舱」): iframe 自己 push —— 见 installWorkflowRouteBridge 的由来说明
  const stopRouteBridge = installWorkflowRouteBridge(router);
  push();
  onBeforeUnmount(() => {
    stopRouteWatch();
    stopRouteBridge();
    stop();
    mo?.disconnect();
    window.clearTimeout(timer);
    window.removeEventListener("message", onExternalMaterial as unknown as EventListener);
  });
});
</script>

<template>
  <div class="soc-shell" style="height: 100vh; display: flex; flex-direction: column; overflow: hidden">
    <RouterView />
    <ToastHost />
    <ConfirmHost />
  </div>
</template>
