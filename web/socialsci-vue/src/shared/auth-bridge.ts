/**
 * auth-bridge.ts — 401 → 通知父窗口拉起登录(2026-09-12)
 *
 * 由来(死代码审计): shared/api.ts 在收到 401 时会清 token 并 dispatch
 *   `researchflow:auth-expired`, 但**全项目没有任何监听者**(soc 内、React 壳内都没有)。
 *   后果: 登录过期后 token 被清掉、界面却仍显示"已登录", 用户直到手动刷新才发现,
 *   期间所有请求都静默失败。
 *
 * 为什么用 postMessage: soc 是嵌在 React 壳里的 iframe(见 App.tsx 的
 *   `iframe[title="学术文本工作台"]`), **CustomEvent 不会跨 iframe 边界**,
 *   所以必须把"需要登录"这件事用 message 递给父窗口, 由壳调用自己的 useAuth().openLogin()。
 *
 * 只在 iframe 内生效(window.parent === window 时说明 soc 被独立打开, 无人可通知)。
 */
import { AUTH_EXPIRED_EVENT } from "./api";

const RELOGIN_MSG = { source: "marxsphere-soc", type: "auth-required" } as const;
let lastSent = 0;

export function installAuthBridge(): void {
  if (window.parent === window) return; // 独立打开 soc, 没有父窗口可通知
  window.addEventListener(AUTH_EXPIRED_EVENT, () => {
    // 多个并发请求会同时 401, 去重避免刷屏弹登录框
    const now = Date.now();
    if (now - lastSent < 3000) return;
    lastSent = now;
    try {
      window.parent.postMessage(RELOGIN_MSG, "*");
    } catch { /* 跨源被拒: 无法通知, 至少 token 已清, 刷新后会回到登录页 */ }
  });
}
