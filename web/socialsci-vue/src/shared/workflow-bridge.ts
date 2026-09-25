/**
 * 写作舱与平台其它模块的通信桥 —— V417。
 *
 * 由来（2026-09-14 实测）：写作舱（/workflow/*）此前是座孤岛 —— 既没有向外发消息的出口，
 * 也没有外部往里送数据的入口。同平台的编辑器/统计台/成果工坊之间早已互通
 * （见 EditorView.vue 的 empirical-insert-doc / App.tsx 的 empirical:open-editor-with-doc），
 * 唯独写作舱没接。
 *
 * 信道选择（照抄已验证的约定，不自造协议）：
 *   · 出（写作舱 → 别的模块）：**同窗口路由切换**，不能用 postMessage —— EditorView 的
 *     message 监听要等 onMounted 才注册，"先发再跳"必丢（ReviewView.vue:606 已踩过这个坑）。
 *     所以走 localStorage 交接 + 路由 query，读方主动取。
 *   · 入（别的模块 → 写作舱）：跨 iframe 边界，走 postMessage + `__socReady.workflow` 打标。
 *
 * 就绪打标是必须的：父级靠 `subAppReady(iframe,"workflow")` 判断能否投递，
 * 没打标会 10s 轮询超时后静默丢弃（App.tsx:649-663）。
 */

export const HANDOFF_KEY = "skf_wf_handoff";

/**
 * 写作舱 → 别的模块的**带路径**导航 —— 让用户能原路回来。
 *
 * 由来（2026-09-24 实测）：`gotoModule` 发出的是 `{type:"navigate", view}`, **只有视图名没有路径**。
 *   写作舱在第 3 步（`/workflow/materials`）跳到「数据分析」后再想回来，只能自己从左侧导航重新找
 *   —— 而且回到写作舱时落在第 1 步（外壳的 iframe src 是写死的 `/workflow/input`），
 *   第 3 步的位置**结构上就丢了**。这是单程票。
 *
 * 两条一起补：
 *   ① 带上 `path` → 外壳转达给 iframe，用户回来时还停在这一页；
 *   ② 带上 `from`  → 外壳在 chrome 上显示「← 返回研途写作舱」，一键回来。
 *
 * 与 `sendMarkdownToEditor` 的区别：那条要**送内容**（走 forward-to-module 由外壳中转）；
 *   这条只是**换页**，没有内容要交接。
 */
export function gotoWorkbenchModule(view: string, opts: { label: string; path?: string } = { label: "" }): boolean {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        {
          source: "marxsphere-soc",
          type: "navigate",
          view,
          path: opts.path,
          from: { view: "paper-outline", label: opts.label || "研途写作舱" },
        },
        "*",
      );
      return true;
    }
  } catch { /* 跨源拿不到 parent */ }
  return false;
}

/**
 * 登记"当前 iframe 停在哪个子路由" —— 供**保活池里的 iframe** 使用。
 *
 * 为什么需要：FusionPanel 把 iframe 缓存在一个隐藏宿主里保活（切走不销毁）。
 * 于是"iframe 的 src 属性"永远停在首次创建时的那个 hash，只有 `contentWindow.location.hash`
 * 才是真的。外壳拿不到后者（跨源读会抛），所以由 iframe 自己每次路由变化时上报。
 * 外壳据此判断"回来的时候本来停在哪一页"。
 */
export function reportSocRoute(view: string, path: string): void {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ source: "marxsphere-soc", type: "route", view, path }, "*");
    }
  } catch { /* 跨源拿不到 parent */ }
}

/** 外部块（文献库/评审/统计/工坊）交给写作舱的素材 —— 落到素材库供正文生成引用 */
export interface WorkflowHandoff {
  kind: "literature" | "review" | "stats" | "viz";
  title: string;
  markdown: string;
  at: number;
}

/** 写作舱 → 编辑器：把某章正文或合稿结果送去学术文本工作台 */
export function sendMarkdownToEditor(markdown: string, title: string): boolean {
  const md = String(markdown ?? "");
  if (!md.trim()) return false;
  // 交给 React 外壳转发(与 soc 侧 forward-to-module 同一路): 外壳有 subAppReady 轮询,
  //   等编辑器 iframe 的监听器就绪再投 empirical-insert-doc(该通道的时序问题已在别处踩平)。
  //   不要用 localStorage + navigate: EditorView 只在 ?new=1 时读交接(实测), 而我们给不了 query。
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        { source: "marxsphere-soc", type: "forward-to-module", route: "editor", title, markdown: md },
        "*",
      );
      return true;
    }
  } catch { /* 跨源拿不到 parent */ }
  return false;
}

/** 写入交接内容（同窗口的其它 Vue 视图在挂载时主动取） */
export function writeHandoff(payload: WorkflowHandoff): boolean {
  try {
    localStorage.setItem(HANDOFF_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** 读后即删（否则下次手动进写作舱会被旧内容重复灌入） */
export function readHandoff(): WorkflowHandoff | null {
  try {
    const raw = localStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    localStorage.removeItem(HANDOFF_KEY);
    const parsed = JSON.parse(raw) as WorkflowHandoff;
    if (!parsed?.markdown) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 外壳 → 写作舱的**下行路由指令** —— 「返回研途写作舱」走这条。
 *
 * 为什么不能像别的工作台那样给 iframe 换个 src：FusionPanel 用**单例保活池**缓存 iframe
 * （切走不销毁，只是挪进隐藏宿主），`src` 属性在首次创建后就再没被写过 ——
 * 改 `FUSION_TABS.paperOutline.vueRoute` 或换 `tab` 对象都碰不到已经存在的那个 iframe。
 * 所以方向反过来：外壳说"去这一页"，由 iframe 自己 `router.push`。
 *
 * 时序坑（同 `onExternalMaterial` 的那条教训）：外壳可能在写作舱这一页**还没挂载**时发出来。
 * 那时没有监听器，消息静默丢失。所以这里用"待处理位"接住 —— 挂载完成后立刻消费一次。
 */
const PENDING_ROUTE_KEY = "skf_wf_pending_route";

export function installWorkflowRouteBridge(router: { push: (p: string) => unknown }): () => void {
  const go = (path: string) => {
    if (!path) return;
    void Promise.resolve(router.push(path)).catch(() => { /* 非法路径忽略 */ });
    try { localStorage.removeItem(PENDING_ROUTE_KEY); } catch { /* 忽略 */ }
  };
  const onMsg = (e: MessageEvent) => {
    const d = e.data as { source?: string; type?: string; path?: string } | null;
    if (d?.source !== "marxsphere-app" || d.type !== "workflow-route" || !d.path) return;
    go(String(d.path));
  };
  window.addEventListener("message", onMsg);
  // 挂载时先看有没有外壳在"我们还没醒"时留下的指令
  try {
    const pending = localStorage.getItem(PENDING_ROUTE_KEY);
    if (pending) go(pending);
  } catch { /* 忽略 */ }
  return () => window.removeEventListener("message", onMsg);
}

/** 外壳在投递 `workflow-route` 前调用 —— 若目标 iframe 尚未就绪，指令留在这里等它挂载 */
export function writePendingRoute(path: string): void {
  try { localStorage.setItem(PENDING_ROUTE_KEY, path); } catch { /* 忽略 */ }
}

let claimed = false;
/** 交接内容只允许被消费一次（多个视图都挂载监听时防重复导入） */
export function claimHandoff(): WorkflowHandoff | null {
  if (claimed) return null;
  const h = readHandoff();
  if (h) claimed = true;
  return h;
}

/** 打 `__socReady.workflow` 标 —— 让 React 外壳知道可以往写作舱投递了 */
export function markWorkflowReady(): void {
  const w = window as unknown as { __socReady?: Record<string, boolean> };
  w.__socReady = { ...(w.__socReady ?? {}), workflow: true };
}

/**
 * 写作舱 → 实证台的**目标课题交接**。
 *
 * 由来(2026-09-25): 写作舱能绑定一个实证课题, 但从这里点"去实证台"过去之后,
 * 实证台是**未选中课题**的状态(它刻意不自动选第一个 —— 见 EmpiricalResearchPanel 的注释),
 * 用户得在下拉里再找一遍自己刚绑的那个。跨了页面还要重新找, 就是断的。
 *
 * 走 localStorage 而不是 postMessage: 与 `writePendingRoute` 同一个理由 ——
 * 目标视图可能还没挂载, 监听器不存在, 消息会静默丢。读方挂载时主动取, 读后即删。
 */
const EMP_TARGET_KEY = "skf_wf_empirical_target";
/** ⚠ 与 React 外壳侧 `web/src/lib/workflow-bridge.ts` 的同名常量**必须是同一个字符串** */
export const __EMP_TARGET_KEY = EMP_TARGET_KEY;

export function setEmpiricalTarget(empiricalProjectId: string): void {
  try { localStorage.setItem(EMP_TARGET_KEY, String(empiricalProjectId ?? "")); } catch { /* 忽略 */ }
}

/** 读后即删 —— 否则用户以后手动进实证台会被旧目标重复选中 */
export function takeEmpiricalTarget(): string {
  try {
    const v = localStorage.getItem(EMP_TARGET_KEY) ?? "";
    if (v) localStorage.removeItem(EMP_TARGET_KEY);
    return v;
  } catch { return ""; }
}
