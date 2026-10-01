// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// handoff.ts — 跨 tab 交接(2026-10-01)
//
// 由来: 新补的 7 个能力(题录导入/共现图谱/词云/AIGC 检测/Word 成品构建/舆情/PPT)
//   第一版**全是孤岛** —— 用户评"这些与一些原有的 tab 可以打通的, 都实现各自的联动了吗"。
//   确实一条都没有, 每个面板做完就停在原地。
//
// ═══ 为什么不复用 App.tsx 里那个 pendingDemoRef ═══
//   它是个 `useRef` + 只在**挂载时**消费。两个问题:
//     ① 刷新即丢(用户点了"去文献库看"然后手滑刷新, 上下文没了);
//     ② 目标面板**已经在原地**时, 它不会重新挂载, 于是交接被静默吞掉 ——
//        而"从图谱跳到文献库"这种恰恰经常是同一棵树里的兄弟面板。
//
// ═══ 为什么落 sessionStorage 而不是 URL ═══
//   URL 方案能分享、能刷新保持, 但要把现有 hash 路由升级成带查询串的格式,
//   而 `navigateView` 只写 `#view`, 改它要碰浏览器前进/后退的恢复逻辑(见 App.tsx 的
//   popstate 处理)。为一个"点一下带个关键词过去"的需求动主路由, 风险不划算。
//   sessionStorage 足够: 同一标签页内刷新不丢, 关掉标签页即清 —— 正是要的语义。
//
// ═══ 为什么带时间戳 ═══
//   过期保护。用户半小时前点了"去筛选", 中间又干了别的, 后来切回那个 tab 时不该
//   突然被一个陈旧的筛选条件打到 —— 超过 TTL 的交接视为无效并自动清理。
import {
  Newspaper, Sparkles, FileSpreadsheet, Network, Cloud, Search, PenLine,
} from "lucide-react";

/** 一次交接: 从哪个能力来、希望目标做什么 */
export interface Handoff {
  /** 发起方(给目标界面显示"来自 XX"用) */
  from: string;
  /** 动作语义 —— 目标面板据此决定怎么消费 */
  kind: "filter" | "keyword" | "text" | "docx" | "toast" | "source";
  /** 载荷: 关键词 / 文本 / base64 等 */
  payload: Record<string, unknown>;
  /** 发起时间(ms) —— 用于过期判断 */
  at: number;
}

const KEY = "sag:handoff";
/** 交接有效期: 5 分钟。超过就当它已经不合时宜了 */
const TTL_MS = 5 * 60 * 1000;

/**
 * 交接事件名 —— **同面板内的兄弟视图靠它拿到交接**。
 *
 * ⚠ 这是踩过坑之后补的。第一版只有 sessionStorage: 目标面板**没重新挂载**时
 *   (`takeHandoff` 只写在 `useEffect(..., [])` 里) 交接就永远躺在 storage 里没人取。
 *   实测: 共现图谱和文献列表是同一个 `LiteraturePanel` 的两个子视图 —— 点图谱节点时
 *   面板根本没卸载, 于是"跳过去了但什么也没发生, 还停在图谱上"。
 *   (讽刺的是 handoff.ts 的注释里我**预言过**这个问题, 实现时还是漏了。)
 *
 * 所以: 写入后**广播一个 window 事件**, 在挂载的监听者(不限于目标面板) 立刻取用。
 * 落盘仍然保留 —— 那是给"目标还没挂载"的路径兜底的。
 */
export const HANDOFF_EVENT = "sag:handoff";

export function putHandoff(from: string, kind: Handoff["kind"], payload: Record<string, unknown>) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ from, kind, payload, at: Date.now() } satisfies Handoff));
  } catch { /* 隐私模式/配额满: 交接丢失不该让主流程崩 */ }
  // 广播: 已经在挂载态的监听者当场消费(跨面板跳转时那边还没挂载, 由 storage 兜底)
  try { window.dispatchEvent(new CustomEvent(HANDOFF_EVENT, { detail: { kind } })); } catch { /* 忽略 */ }
}

/**
 * 取出交接 —— **取出即销毁**(消费一次)。
 *
 * `kind` 传入时只认这一种: 目标面板可能同时接多种交接(比如写作舱既收"降 AIGC 文本"
 * 又收"从 PPT 取材"), 不区分的话会互相抢。
 */
export function takeHandoff(kind?: Handoff["kind"] | Handoff["kind"][]): Handoff | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const h = JSON.parse(raw) as Handoff;
    // 过期即弃
    if (!h?.at || Date.now() - h.at > TTL_MS) { sessionStorage.removeItem(KEY); return null; }
    if (kind) {
      const wanted = Array.isArray(kind) ? kind : [kind];
      if (!wanted.includes(h.kind)) return null;   // 不是给我的, 留着
    }
    sessionStorage.removeItem(KEY);
    return h;
  } catch { return null; }
}

/** 看一眼但**不消费**(用于"有待处理的交接"这类提示) */
export function peekHandoff(kind?: Handoff["kind"]): Handoff | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const h = JSON.parse(raw) as Handoff;
    if (!h?.at || Date.now() - h.at > TTL_MS) { sessionStorage.removeItem(KEY); return null; }
    if (kind && h.kind !== kind) return null;
    return h;
  } catch { return null; }
}

export function clearHandoff() {
  try { sessionStorage.removeItem(KEY); } catch { /* 忽略 */ }
}

/**
 * 交接的发起端与接收端**必须用同一个 kind 字符串**, 否则 takeHandoff 永远取不到东西,
 * 表现是"点了按钮跳过去了, 但什么也没发生" —— 静默失败。
 * 这里把 kind 集中定义, 两边都引它, 免得手抄串。
 */
export const HANDOFF_KIND = {
  /** 按关键词筛选文献库 */
  LIBRARY_KEYWORD: "filter",
  /** 送文本去改写(写作舱) */
  REWRITE_TEXT: "text",
  /** 送 docx 去格式评测 */
  DOCX_TO_EVAL: "docx",
  /** 外部条目入库(文献库) */
  INGEST_SOURCE: "source",
  /** 只是切过去并给个交代(无参数) */
  NAV_ONLY: "toast",
} as const satisfies Record<string, Handoff["kind"]>;

/**
 * 面板之间跳转的统一按钮文案。
 *
 * 带货的跳转必须**说清带什么过去** —— "去文献库"和"用「农村集体经济」筛选文献库"
 * 对用户是两件事。前端不写清, 用户到那边看见已被筛过的列表会以为界面坏了。
 */
export function handoffLabel(kind: Handoff["kind"], extra?: string): string {
  switch (kind) {
    case "filter": return extra ? `在文献库中筛选「${extra}」` : "去文献库筛选";
    case "text": return "送写作舱改写";
    case "docx": return "去格式评测";
    case "source": return "导入到文献库";
    case "toast": return "去看看";
    default: return "去看看";
  }
}
