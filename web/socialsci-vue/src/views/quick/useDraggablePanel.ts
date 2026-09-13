// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/views/quick/useDraggablePanel.ts — V415: 让浮层能自由拖动并记住位置
//
// 由来(2026-09-13 用户反馈): 节点大卡片、科研助手都是钉死在某个角的浮层, 挡着内容也挪不开。
// 两个浮层要的行为一模一样, 所以抽成一个 composable —— 抄两遍迟早只改一处。
//
// 位置存 localStorage 而不是后端: 它属于"用户对这台设备的界面偏好", 与课题/编排数据无关,
// 刷新后仍在, 换设备各按各的。
import { ref, onMounted, type Ref } from "vue";

export interface DragPos { x: number; y: number }

/**
 * @param storageKey localStorage 键(每个浮层一个)
 * @param fallback   没存过位置时的默认位置。可传函数 —— 默认位置常要看容器尺寸(如"贴右边")。
 * @param bounds     拖动边界(可选)。**必须与 left/top 所属的坐标系一致**:
 *                   浮层用 `left: pos.x` 定位时, x 是相对**定位祖先**的, 不是相对视口。
 *                   默认按视口算 —— 只有当浮层的定位祖先是整个页面时才正确。
 *                   (踩过的坑: 面板在画布容器内, 却按视口算默认位置 → 直接跑到屏幕外,
 *                    鼠标够不到, 表现成"拖不动"。)
 */
export function useDraggablePanel(
  storageKey: string,
  fallback: DragPos | (() => DragPos),
  bounds?: () => { w: number; h: number },
) {
  const resolve = (): DragPos => (typeof fallback === "function" ? fallback() : { ...fallback });
  const measure = () => bounds?.() ?? { w: window.innerWidth, h: window.innerHeight };
  const pos = ref<DragPos>({ x: 0, y: 0 });
  const dragging = ref(false);

  onMounted(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const p = JSON.parse(raw) as DragPos;
        if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) { pos.value = p; return; }
      }
    } catch { /* 坏数据就当没存过 */ }
    pos.value = resolve();
  });

  /** 从把手按下开始拖。用 pointer 事件: 拖出窗口也能继续, 松手必结束 */
  function startDrag(ev: PointerEvent) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const origin = { ...pos.value };
    dragging.value = true;

    const move = (e: PointerEvent) => {
      // 夹在容器内: 拖出去就再也抓不回来了
      const { w, h } = measure();
      pos.value = {
        x: Math.min(Math.max(0, w - 80), Math.max(0, origin.x + (e.clientX - startX))),
        y: Math.min(Math.max(0, h - 50), Math.max(0, origin.y + (e.clientY - startY))),
      };
    };
    const up = () => {
      dragging.value = false;
      try { localStorage.setItem(storageKey, JSON.stringify(pos.value)); } catch { /* 存不下就只在本次会话生效 */ }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /** 回到默认位置(把手双击 / 菜单里"复位") */
  function reset() {
    pos.value = resolve();
    try { localStorage.removeItem(storageKey); } catch { /* 忽略 */ }
  }

  return { pos: pos as Ref<DragPos>, dragging, startDrag, reset };
}
