/**
 * 跨"外壳 ↔ 写作舱(iframe)"的轻量交接 — 只放**两边都要用**的东西。
 *
 * 由来(2026-09-25): 写作舱能绑定一个实证课题, 但从舱里点「去实证台」过去之后,
 *   实证台是**未选中课题**的状态(它刻意不自动选第一个, 免得静默换课题), 用户得在下拉里
 *   再找一遍刚绑的那个 —— 跨了页面还要重新找, 这条路就是断的。
 *
 * 为什么用 localStorage 而不是 postMessage: 目标视图(实证台)可能**还没挂载**,
 *   那时没有监听器, 消息会静默丢。改成"写进去、读方挂载时主动取", 时序上天然安全。
 *   (同 `web/socialsci-vue/src/shared/workflow-bridge.ts` 里 writePendingRoute 的教训。)
 *
 * ⚠ 这个模块**必须能被 React 外壳 import** —— 所以它不能放在 soc 子应用目录里。
 *   两边各存一份等价实现是最坏的选择(改一处忘一处); 这里只放"契约"这一层,
 *   key 与 soc 侧 `shared/workflow-bridge.ts` 保持一致(同一个字符串, 两边各自读写)。
 */

/** 与 soc 侧 `shared/workflow-bridge.ts` 的 EMP_TARGET_KEY **必须是同一个值** */
const EMP_TARGET_KEY = "skf_wf_empirical_target";

/** 写作舱点「去实证台」时写入目标课题 */
export function setEmpiricalTarget(empiricalProjectId: string): void {
  try { localStorage.setItem(EMP_TARGET_KEY, String(empiricalProjectId ?? "")); } catch { /* 忽略 */ }
}

/** 读后即删 — 否则以后手动进实证台会被旧目标重复选中 */
export function takeEmpiricalTarget(): string {
  try {
    const v = localStorage.getItem(EMP_TARGET_KEY) ?? "";
    if (v) localStorage.removeItem(EMP_TARGET_KEY);
    return v;
  } catch { return ""; }
}

/** 两个 key 字符串必须一致的自检(开发期一眼可见, 避免两边漂移后静默失效) */
export const __EMP_TARGET_KEY = EMP_TARGET_KEY;
