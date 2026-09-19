// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
/**
 * literature-browser-service.ts — 中文三大库(知网/万方/维普)的浏览器代抓检索
 *
 * 前置与边界见 `literature-browser-sources.ts` 的文件头 —— 一句话:
 *   **平台不存这三家的密码**, 借用户浏览器里的登录态去查。
 *
 * 实测(2026-09-19):
 *   · 万方: `s.wanfangdata.com.cn/paper?q=数字经济` → `找到 329,426 条文献`, 页头显示机构名 →
 *     结果卡 `.normal-list`, 解析出 `{title, type, journal, issue, abstract}`;
 *   · 维普: `qikan.cqvip.com/Qikan/Search/Index?key=K%3D…` → 60 条 `a[href*=Detail]`,
 *     容器 `.search-result-list`, 卡内含作者/刊名/核心标识/年卷期页码;
 *   · 知网: 检索页可用, 详情页有 `#refpartdiv`(引文区) —— 但**报纸类文献没有引文区**,
 *     所以"查不到引文"时要先分辨文献类型, 别当成选择器失效。
 *
 * ⚠ 解析走 **innerText 而不是枚举 DOM**: 实测在这两家的页面上
 *   `querySelectorAll("*")` 会直接抛 `Uncaught`(页面上有巨型自适应容器),
 *   而按类名取 `querySelectorAll(".normal-list")` 正常。所以解析器统一**读卡片的 innerText 再切行**。
 */
import { evalJs, findTab, newTab, navigate, tabInfo } from "./cdp-browser.js";
import { LIT_BROWSER_SOURCES, litSearchUrl, litTabMatcher, type LitSourceId } from "./literature-browser-sources.js";

export interface LitHit {
  /** 在结果里的序号(1-based) */
  index: number;
  title: string;
  /** 文献类型(期刊论文/学位论文/报纸…), 取不到就是空串 */
  type?: string;
  journal?: string;
  /** 年卷期/页码等 */
  issue?: string;
  authors?: string;
  abstract?: string;
  /** 详情页绝对 URL(能取到才给) */
  url?: string;
}

export interface LitSearchResult {
  ok: boolean;
  source: LitSourceId;
  query: string;
  /** 命中的总数(页面若能读到) */
  total?: string;
  hits: LitHit[];
  /** 打开/复用的 tab, 供后续在这个页面上继续抓(如知网的引文) */
  tabId?: string;
  /** 页面上**当前生效的筛选**(如万方的获取范围: 机构已购) —— 决定"这些结果能不能下全文" */
  filters?: string[];
  error?: string;
}

/** 每个源的结果解析表达式(返回 JSON 字符串) —— 一律 innerText 切行, 见文件头 */
const PARSE_EXPR: Record<LitSourceId, string> = {
  // 万方: 卡文本形如
  //   "2.数字经济\n[期刊论文]-《中国信息界》2026年6期\n摘要：…\n在线阅读下载全文…"
  wanfang: `(() => {
    return JSON.stringify(Array.from(document.querySelectorAll(".normal-list")).slice(0, 20).map(function (e) {
      var t = e.innerText || "";
      var lines = t.split("\\n").map(function (s) { return s.trim(); }).filter(Boolean);
      var first = lines[0] || "";
      var m = first.match(/^(\\d+)\\.(.+)$/);
      var src = "";
      for (var i = 0; i < lines.length; i++) { if (/^\\[/.test(lines[i])) { src = lines[i]; break; } }
      var sm = src.match(/^\\[([^\\]]+)\\]-《([^》]+)》\\s*(.*)$/);
      var abs = "";
      for (var j = 0; j < lines.length; j++) { if (lines[j].indexOf("摘要：") === 0) { abs = lines[j].slice(3); break; } }
      var href = "";
      var a = e.querySelector("a[href*='wanfangdata']") || e.querySelector("a[href]");
      if (a && a.href) href = a.href;
      return {
        index: m ? Number(m[1]) : 0,
        title: m ? m[2].trim() : first,
        type: sm ? sm[1] : "",
        journal: sm ? sm[2] : "",
        issue: sm ? sm[3] : "",
        abstract: abs.slice(0, 200),
        url: href
      };
    })) || "[]";
  })()`,

  /**
   * 维普: **`.search-result-list` 是一个容器装着全部条目**(实测: 1 个元素, 177 行),
   *   不是一条一个 —— 第一版按"每元素一条"解析, 结果 60 条只出 1 条。
   *   改法: 读整个容器的 innerText, 按 `作者 ` 行切块(每条必有, 且是块首特征)。
   *   块内: 标题在前面几行里取最长的一条; `《刊名》` 取刊名; `NNNN年第N期页码` 取年卷期。
   */
  cqvip: `(() => {
    var c = document.querySelector(".search-result-list");
    if (!c) return "[]";
    var lines = (c.innerText || "").split("\\n").map(function (s) { return s.trim(); });
    // 以「作者 」行作为每条的分界(实测每条必有且唯一)
    var ai = [];
    for (var i = 0; i < lines.length; i++) { if (lines[i].indexOf("作者 ") === 0) ai.push(i); }
    var out = [];
    for (var b = 0; b < ai.length; b++) {
      var start = b === 0 ? 0 : ai[b - 1] + 1;
      var chunk = lines.slice(start, ai[b] + 1);
      var info = lines[ai[b]];
      var jm = info.match(/《([^》]+)》/);
      var im = info.match(/(\\d{4}年第[\\d\\-]+期[^\\s]*)/);
      var am = info.match(/作者\\s+(.{2,60}?)\\s*《/);
      /**
       * 标题 = 从「作者」行**往回**走, 第一个"不是杂项"的行。
       *
       * ⚠ 第一版取的是"块内最长的一行" —— 而**摘要在块里最长**, 于是第 N 条的标题
       *   变成了第 N-1 条的摘要(实测: 第 2 条显示成第 1 条的摘要)。
       *   条目的行序是「标题 → 认领 → 引用 → 被引量 → 序号 → 作者」, 所以往回走第一个
       *   非杂项行就是标题。
       *   注: 这段注释在**模板串内部**, 所以不能出现反引号(会提前闭合模板串) —— 用「」代替。
       */
      var title = "";
      for (var k = chunk.length - 2; k >= 0; k--) {
        var L = chunk[k];
        if (!L) continue;
        if (/^(认领|引用|被引量|在线阅读|关键词|下载PDF|免费下载|OA链接)/.test(L)) continue;
        if (/^\\d+$/.test(L)) continue;
        title = L;
        break;
      }
      // 摘要 = 作者行**之后**那条超长行
      var abs = "";
      for (var q = ai[b] + 1; q < lines.length; q++) {
        if (lines[q].indexOf("作者 ") === 0) break;
        if (lines[q].length > 40) { abs = lines[q]; break; }
      }
      if (title) out.push({
        index: out.length + 1,
        title: title,
        type: "期刊论文",
        journal: jm ? jm[1] : "",
        issue: im ? im[1] : "",
        authors: am ? am[1].trim() : "",
        abstract: abs.slice(0, 200),
        url: ""
      });
    }
    return JSON.stringify(out);
  })()`,

  // 知网: 结果表行, 文本形如 "“数字工会”何以融入…\n李润钊\n工人日报\n2026-08-27"
  cnki: `(() => {
    return JSON.stringify(Array.from(document.querySelectorAll(".result-table-list tbody tr")).slice(0, 20).map(function (e, i) {
      var t = (e.innerText || "").split("\\n").map(function (s) { return s.trim(); }).filter(Boolean);
      var a = e.querySelector("a.fz14") || e.querySelector("td.name a");
      var src = e.querySelector("td.source") || e.querySelector(".source");
      return {
        index: i + 1,
        title: a ? a.innerText.trim() : (t[0] || ""),
        type: "",
        journal: src ? src.innerText.trim() : "",
        issue: "",
        authors: t.length > 1 ? t[1] : "",
        abstract: "",
        url: a && a.href ? a.href : ""
      };
    })) || "[]";
  })()`
};

/**
 * 读页面上**筛选区的勾选状态**。
 *
 * 目的: 让用户看到"这个库上有哪些获取范围开关、现在哪个是开的"。这决定结果能不能下全文,
 *   而它藏在页面里、界面上完全看不出来。
 *
 * ⚠⚠ 两处**实测反直觉**, 别照直觉写注释:
 *   1. 万方的「机构已购」**默认并不是勾上的**(实测 on=false) —— 我一度以为它默认开着。
 *   2. 勾选态是 `label.ivu-checkbox-wrapper-checked`(**不是 innerText 里的字样**)。
 *   3. 更重要的: **点了它(以及「有全文」)结果数纹丝不动**(实测 329,426 → 329,426,
 *      URL 也不变), 连"有全文(262747)"这种教科书级该变数的筛选也一样 ——
 *      说明该 SPA 不响应这种程序化点击。**所以本函数只读"勾没勾", 不声称"筛掉了多少"**。
 *      要让筛选真生效, 得走它的表单提交路径 —— 那是另一件事, 本模块不做。
 */
const FILTERS_EXPR: Record<LitSourceId, string> = {
  wanfang: `(() => {
    var boxes = Array.prototype.slice.call(document.querySelectorAll(".facet-list-box"));
    var out = [];
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      var scope = box.previousElementSibling ? (box.previousElementSibling.textContent || "").trim().slice(0, 8) : "";
      var labels = Array.prototype.slice.call(box.querySelectorAll("label"));
      var on = [];
      for (var j = 0; j < labels.length; j++) {
        if (String(labels[j].className).indexOf("checked") >= 0) on.push((labels[j].textContent || "").trim().slice(0, 16));
      }
      var mark = [];
      for (var k = 0; k < on.length; k++) mark.push(on[k] + "(已勾)");
      // 把整组的候选项也带上, 让用户知道**有哪些可选项**(不只当前勾的)
      var all = [];
      for (var q = 0; q < labels.length; q++) {
        var tx = (labels[q].textContent || "").trim().slice(0, 16);
        if (tx) all.push(tx);
      }
      if (all.length) out.push((scope ? scope + ": " : "") + all.join(" / ") + (mark.length ? " (已勾: " + mark.join(", ") + ")" : ""));
    }
    return JSON.stringify(out);
  })()`,
  cqvip: `(() => {
    // 维普的筛选在「聚类」区, 勾选态同样是 class 带 checked
    var on = [];
    var items = Array.prototype.slice.call(document.querySelectorAll(".cluster-item"));
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].className).indexOf("active") >= 0 || String(items[i].className).indexOf("checked") >= 0) {
        on.push((items[i].textContent || "").trim().slice(0, 18));
      }
    }
    return JSON.stringify(on.slice(0, 6));
  })()`,
  cnki: `(() => {
    var on = [];
    var items = Array.prototype.slice.call(document.querySelectorAll(".result-table-list .filter-item, .filters .cur, .group-item .cur"));
    for (var i = 0; i < items.length; i++) on.push((items[i].textContent || "").trim().slice(0, 18));
    return JSON.stringify(on.slice(0, 6));
  })()`
};

/** 读页面上"共 N 条"之类的总数(取不到就不给) */
const TOTAL_EXPR = `(() => {
  var m = document.body.innerText.match(/找到\\s*([\\d,]+)\\s*条/);
  if (m) return m[1];
  m = document.body.innerText.match(/([\\d,]+)\\s*条(?:结果|文献)/);
  return m ? m[1] : "";
})()`;

function parseHits(json: string): LitHit[] {
  try {
    const arr = JSON.parse(json) as LitHit[];
    return Array.isArray(arr) ? arr.filter((h) => h && h.title) : [];
  } catch {
    return [];
  }
}

/**
 * 在指定源的**已登录浏览器**里检索。
 *
 * 复用用户已经开着的该站 tab(它带着登录态); 没有就新开一个 —— 但**新开的 tab 通常没有登录态**,
 * 所以返回时会带上 `needsLogin` 提示, 让用户去那家登一次。
 */
export async function searchInBrowserSource(
  source: LitSourceId,
  query: string,
  opts: { reuseTab?: boolean; maxWaitMs?: number } = {}
): Promise<LitSearchResult & { needsLogin?: boolean }> {
  const def = LIT_BROWSER_SOURCES.find((s) => s.id === source);
  if (!def) return { ok: false, source, query, hits: [], error: `未知文献源: ${source}` };

  const url = litSearchUrl(source, query);
  if (!url) return { ok: false, source, query, hits: [], error: "无法构造检索 URL" };

  // 优先复用该站已开的 tab(登录态在那儿); 没有就新开
  let tabId = opts.reuseTab === false ? "" : findTab(litTabMatcher(source));
  if (!tabId) {
    tabId = newTab(url);
    if (!tabId) return { ok: false, source, query, hits: [], error: "无法打开浏览器标签页(请确认 CDP 代理已启动)" };
  } else {
    navigate(tabId, url);
  }

  // 轮询等结果出现(各家渲染时间不同)
  const deadline = Date.now() + (opts.maxWaitMs ?? 30000);
  let hits: LitHit[] = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const info = tabInfo(tabId);
    // 被弹到登录/验证页 → 明确说"需要登录", 不要含糊成"没结果"
    if (info && /verify|login|passport|sso/i.test(info.url) && !/Search|paper\?|defaultresult/.test(info.url)) {
      return { ok: false, source, query, hits: [], tabId, needsLogin: true, error: `需要先在浏览器里登录${def.name}` };
    }
    try {
      hits = parseHits(evalJs(tabId, PARSE_EXPR[source]));
    } catch {
      hits = [];
    }
    if (hits.length) break;
  }

  let total = "";
  try {
    total = evalJs(tabId, TOTAL_EXPR);
  } catch {
    /* 取不到就不给 */
  }

  let filters: string[] = [];
  try {
    const fj = evalJs(tabId, FILTERS_EXPR[source]);
    const arr = JSON.parse(fj) as string[];
    filters = Array.isArray(arr) ? arr.filter((x) => x && x.trim()) : [];
  } catch {
    /* 取不到就不给 —— 筛选读不出来不该让整次检索失败 */
  }

  if (!hits.length) {
    return { ok: true, source, query, hits: [], tabId, total, error: "页面上没有解析到结果(可能是空结果, 或该站页面结构变了)" };
  }
  return { ok: true, source, query, hits, tabId, total, filters };
}
