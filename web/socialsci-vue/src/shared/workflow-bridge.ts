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
