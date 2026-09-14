/**
 * actions-bridge.ts — 把 iframe 内的"当前页可执行动作"上报给 React 外壳(2026-09-14)
 *
 * 由来(用户反馈"科研助手并不能很好反映每一个功能页"): 外壳的科研助手靠扫
 *   `document.querySelectorAll("[data-control]")` 列出"当前页可执行"。实测 45 个视图
 *   这一栏**全是空的** —— 因为埋点只写在 EditorView.tsx 里, 而那个文件在 App.tsx 中
 *   根本没被 import(editor 视图走的是 FusionPanel iframe)。
 *
 *   soc 是 iframe, 外壳的 document.querySelector 查不到里面的 DOM —— 所以必须由
 *   **iframe 自己上报**。同 auth-bridge 的理由: CustomEvent 不跨 iframe, 只能 postMessage。
 *
 * 协议(与 auth-bridge 同一套 source 命名):
 *   soc   → 父窗口  { source: "marxsphere-soc",        type: "actions",       view, actions }
 *   父窗口 → soc     { source: "marxsphere-workbench",  type: "invoke-action", id }
 *
 * 只在 iframe 内生效(window.parent === window 时说明 soc 被独立打开, 无人可通知)。
 */

export interface WorkbenchAction {
  /** 稳定 id(同一视图内唯一); 外壳点它时按这个 id 回传 */
  id: string;
  /** 按钮上的中文文案(直接取自 DOM, 不另写一份) */
  text: string;
  disabled?: boolean;
}

const REPORT = "actions" as const;
const INVOKE = "invoke-action" as const;
const QUERY = "query-actions" as const;
const PARENT_SOURCE = "marxsphere-workbench";

/** 同一个 soc 页面里可能有多个 view 挂载(如工作台 tab 切换) —— 按 view 分别记 */
const handlers = new Map<string, (id: string) => void>();

let installed = false;
let lastReport: WorkbenchAction[] = [];
let lastView = "";

function isIframe(): boolean {
  return typeof window !== "undefined" && window.parent !== window;
}

/** 立即上报一次(动作增删后调用) */
export function reportActions(view: string, actions: WorkbenchAction[]): void {
  if (!isIframe()) return;
  lastView = view;
  lastReport = actions;
  try {
    window.parent.postMessage({ source: "marxsphere-soc", type: REPORT, view, actions }, "*");
  } catch { /* 跨源被拒: 外壳拿不到动作, 页面本身照常可用 */ }
}

/**
 * 安装调用监听(全局只装一次)。
 * 外壳点了某个动作 → 这里按 id 派发给注册的处理函数;
 * 外壳也可能反过来问一句(query-actions) → 把最近一次快照重发, 解决"外壳监听装上得比 soc 上报晚"的时序。
 */
export function installActionBridge(): void {
  if (installed || !isIframe()) return;
  installed = true;
  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { source?: string; type?: string; id?: string } | null;
    if (d?.source !== PARENT_SOURCE) return;
    if (d.type === QUERY) {
      if (lastView) reportActions(lastView, lastReport);
      return;
    }
    if (d.type !== INVOKE || !d.id) return;
    // 动作 id 全局唯一(形如 "<view>:<key>"), 直接按 id 派发给注册者
    for (const fn of handlers.values()) {
      try { fn(d.id); } catch { /* 单个处理函数出错不影响其它 */ }
    }
  });
}

/**
 * 注册某视图的动作 → 处理函数映射。
 * @param view 视图标识(与外壳 workspaceView 对应的 soc 侧名字)
 * @param invoke 收到外壳调用时执行; 应自己判断 id 是不是自己的
 * @returns 注销函数
 */
export function onActionInvoked(view: string, invoke: (id: string) => void): () => void {
  handlers.set(view, invoke);
  return () => { handlers.delete(view); };
}

/** 动作 id 统一构造: `<view>:<key>` —— 外壳回传的就是它 */
export function actionId(view: string, key: string): string {
  return `${view}:${key}`;
}

/**
 * 从当前文档里扫 `[data-control]` 按钮, 生成要上报的动作表。
 * 复用外壳那套埋点约定, 免得 Vue 侧再发明一套。
 *
 * **按 id 去重**(实测踩到): 同一个 id 常对应多个按钮(如编排页 7 个 DAG 行各一个「🎬 演示」),
 * 不去重外壳那一栏会出现 7 条一样的, 且 React 的 key 会撞。外壳调用时命中的是第一个,
 * 所以这里只留第一个、文案取它。
 */
export function collectDomActions(view: string, root?: HTMLElement | null): WorkbenchAction[] {
  const scope = root ?? document;
  const els = Array.from(scope.querySelectorAll<HTMLElement>("[data-control]"));
  const seen = new Set<string>();
  const out: WorkbenchAction[] = [];
  for (const el of els) {
    const key = el.getAttribute("data-control") ?? "";
    const id = actionId(view, key);
    const text = (el.textContent ?? "").trim().slice(0, 24);
    if (!key || !text || seen.has(id)) continue;
    seen.add(id);
    if ((el as HTMLButtonElement).disabled || !el.offsetParent) continue;   // 隐藏/禁用的不算可选动作
    out.push({ id, text, disabled: false });
  }
  return out;
}
