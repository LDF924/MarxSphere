// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// tabInfo/navigate 来自通用 CDP 原语(2026-09-19 抽出); 本文件其余 curl/evalJs 仍是自己的实现, 逐步收敛中
import { listTargets, navigate as cdpNavigate, tabInfo } from "./cdp-browser.js";

/**
 * cnki-citation-proxy — 知网引文网络 CDP 代理
 *
 * ✅ **当前状态: 可用(2026-09-19 复核实测, 下面每条都是量出来的)**
 *
 *   · `#refpartdiv` 结构完好: 6 个引文 tab, class 正是
 *     `references / citations / coreferences / cocitations / secondreferences / secondcitations`;
 *   · 数据**在页面上**: `fetchCnkiCitations("references")` → **10 条 + total「期刊共50条」**,
 *     `GET /api/cnki/citations/references` → 200 + 10 条;
 *   · **合成点击 `el.click()` 足以切换 tab** —— 逐个实测 6 个 tab, `li.cur` 每次都跟着变;
 *   · 某类引文为 0 是**正常结果**(页面自己写着「引证文献(0)」), 不是抓取坏了。
 *
 * ## 本轮(2026-09-19)真正修掉的三处根因
 *
 * 我一开始连报"结构已变 / 数据不下发 / 功能不可用", **全是错的**。真实原因有三个, 都与本站数据无关:
 *
 * 1. **`navigate()` 传参错**: URL 用 `JSON.stringify` 发出去, 而代理要**裸文本** —— 导航**静默失效**,
 *    检索页一直停在旧结果上 →"搜什么都打开同一篇"。`newTab()` 当年栽的是**同一个坑**(见 `cdp-browser.ts`),
 *    这个文件里犯了两次。现已改为直接复用共享实现。
 * 2. **挑错了文献**: 结果表前几行常是**报纸**(《工人日报》等), 报纸**没有引文网络**(`li=0`);
 *    取"第一个链接"必然扑空。现按 `td.data` 文本优先挑**期刊**。
 * 3. **在数据到达之前就读了**: 同一篇《数实融合…》, 一次 `#refpartdiv` 长度 **712**、有 10 条;
 *    另一次 `li=6` 但长度只有 **39**(正好是 6 个标签文字的长度) —— **标签先渲染、数据后到, 有时不到**。
 *    现改为等"长度明显超过标签"并**失败时重载重试**, 而不是等 `li>=6`。
 *
 * ⚠ 还有两个"id 记成了内容"的错(现已修): `lastOpenedTabId` 被写成**检索页**(
 *   `findCnkiTab` 据此返回检索页); 详情页 tab 只记 id 不记标题, 跨进程回退时抓到**几篇之前的旧文章**。
 *   ⇒ 教训: 报"坏了"之前先确认**测的是同一篇、同一个容器、同一套表达式**。
 *
 * ## 已知环境边界(不是本仓能修的)
 *
 * 知网的引文区**只在标签页可见时才渲染**: 后台标签(`visibilityState === "hidden"`)的
 * `#refpartdiv` 永远只有 6 个标签文字(长度恒为 **39**), 等 25 秒、重载都不变;
 * 同一个 URL 在可见标签里就有完整条目(长度 **712**、10 条)。
 *
 * 而 CDP 代理**没有"激活标签"端点**(只有 `/new /navigate /close /back /eval /click /clickAt
 * /scroll /screenshot /info /targets`), `window.focus()` 也改不了 `visibilityState`(实测仍 hidden)。
 * ⇒ 服务端**无法自己**把标签切到前台, 只能在这种情况下如实告诉用户"请把这个标签切到前台"。
 *   (这也解释了我先前那次"能抓到 10 条"为什么成功: 那是我**用真实鼠标点击**打开的、当时在前台的标签。)
 *
 * 消费者: `web/src/components/SciversePanel.tsx`(外壳「外部检索」tab)+ `web/src/lib/api.ts`
 *   的 `getCnkiCitations` / `searchCnkiOpen`, 经 `server.ts` 的 `/api/cnki/citations/:type`。
 */

/**
 * 已知边界(**不要当成 bug 去"修"**):
 *   知网一页只给 **10 条**, 页面底部有 `a.next` 与页码 1-5, 但**程序化点击翻不动**
 *   (真实鼠标点击 `a.next` 命中、`active` 仍停在 1)。所以这里只返回**当前页**,
 *   调用方展示时必须说清是"当前页 10 条", 不能暗示是全部 —— 面板文案已按此措辞。
 *
 * 通过 CDP proxy(localhost:3456)驱动浏览器知网页面:
 * 1. 找到知网详情页 tab
 * 2. 点击引文 tab(参考文献/引证文献/共引文献/同被引文献/二级参考文献/二级引证文献)
 * 3. 从 #refpartdiv 提取对应数据
 *
 * 依赖：web-access skill 的 cdp-proxy(Edge 已登录知网)
 */

const CDP_PROXY = process.env.CDP_PROXY_URL || "http://localhost:3456";

// V382 fix: 参数数组调用 curl, 杜绝 shell 拼接注入
function curl(args: string[], opts: { encoding?: BufferEncoding; maxBuffer?: number; timeout?: number } = {}): string {
  return execFileSync("curl", args, {
    encoding: opts.encoding ?? "utf-8",
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    timeout: opts.timeout ?? 15000,
    windowsHide: true,
  });
}


/**
 * 当前该抓的知网详情页 —— **连同标题一起记**。
 *
 * ⚠ 2026-09-19 修: 原来只存一个 `currentDetailTab`(纯 id, 进程内)。
 *   `/api/cnki/search-open` 与 `/api/cnki/citations/:type` 是**两个独立请求**, 若之间发生
 *   进程重启, 这个内存变量就空了 —— 于是抓引文**悄悄回退到"浏览器里第一个 kcms2"**,
 *   而那可能是**好几篇之前的旧文章**。表现: 刚搜的明明是 A, 引文却来自 B, 且**不报任何错**。
 *
 *   实测踩到: `search-open` 正确返回《数实融合…——基于中国省域面板数据的实证检验》,
 *   紧接着的 citations 却返回《国际科技反垄断…》(参考文献 0 条)的内容。
 *
 *   ⇒ 所以: **记 id 的同时记标题**, 取 tab 时核对标题;**核对不上就回到详情页再认一次**,
 *     而不是默认采用某个"看起来像"的 tab。这是本文件里第三次栽在"拿任意一个当刚操作的那个"上。
 */
let currentDetail: { tabId: string; title: string } | null = null;

export type CnkiCitationType =
  | "references"      // 参考文献
  | "citations"       // 引证文献
  | "coreferences"    // 共引文献
  | "cocitations"     // 同被引文献
  | "secondreferences" // 二级参考文献
  | "secondcitations"; // 二级引证文献

const TAB_CLASSES: Record<CnkiCitationType, string> = {
  references: "references",
  citations: "citations",
  coreferences: "coreferences",
  cocitations: "cocitations",
  secondreferences: "secondreferences",
  secondcitations: "secondcitations"
};

/** 中文名 —— 空结果时要把"哪一类为 0"说清楚, 用户才知道不是坏了 */
const TAB_LABELS: Record<CnkiCitationType, string> = {
  references: "参考文献",
  citations: "引证文献",
  coreferences: "共引文献",
  cocitations: "同被引文献",
  secondreferences: "二级参考文献",
  secondcitations: "二级引证文献"
};

export interface CnkiCitationResult {
  ok: boolean;
  type: CnkiCitationType;
  paperTitle?: string;
  items: Array<{ raw: string }>;
  total?: string;
  error?: string;
  tabFound?: boolean;
}

/**
 * 从检索结果页挑一篇**该打开的**文献, 返回它的详情页 URL。
 *
 * ⚠ 为什么不能直接取"第一个链接"(2026-09-19 实测):
 *   搜「数实融合对产业链供应链韧性的影响机制研究」, 结果表前 4 行**全是报纸**
 *   (《工人日报》《河北日报》《西藏日报》… 行尾 `td.data` 写着「报纸」),
 *   而**报纸没有引文网络**(详情页 `#refpartdiv li = 0`)。
 *   于是"搜索 → 打开第一篇 → 抓引文"必然扑空, 报出来像是"知网引文坏了"。
 *   用户要的是**引文数据**, 所以优先挑**期刊**(用户想找的那篇通常是期刊)。
 *
 * ⚠⚠ **不要再往这里加"优先挑有引文的那篇"** —— 做不到, 是测过的:
 *   · 结果行里**没有任何引文计数**(全行 dump 过: 已知"参考文献 0 条"的《国际科技反垄断…》
 *     与"参考文献 49 条"的《数实融合…》在结果页**属性完全一样**, 都没有 refCount 元素);
 *   · 而且只按"是期刊"并不能保证有引文 —— 有的期刊文章参考文献也是 0(实测那篇即如此)。
 *   所以"打开后可能为 0"是**数据**问题, 由调用方如实展示(「该文献的「参考文献」为 0 条」),
 *   不该假装能在这里挑出来。**我一度凭印象写了个 `a[id^=refCount]` 选择器, 它是臆造的, 已删。**
 *
 * 判别位只有: 结果行 `td.data` 的文本(实测取值 「期刊」/「报纸」/「硕士」/「博士」…)。
 */
const PICK_PAPER_EXPR = `(() => {
  var rows = Array.prototype.slice.call(document.querySelectorAll(".result-table-list tbody tr"));
  var first = null, journal = null;
  for (var i = 0; i < rows.length; i++) {
    var a = rows[i].querySelector("a[href*='kcms2/article/abstract']");
    if (!a) continue;
    var txt = (a.innerText || "").trim();
    if (txt.length <= 8 || txt.length >= 60) continue;
    if (!first) first = a.href;
    var d = rows[i].querySelector("td.data");
    var kind = d ? (d.innerText || "").trim() : "";
    if (kind.indexOf("期刊") >= 0 && !journal) { journal = a.href; break; }
  }
  return journal || first || "";
})()`;

/**
 * 最近一次 `searchAndOpen` 打开的详情页 tab。
 *
 * ⚠ 2026-09-19 加: `findCnkiTab` 原来**取第一个 kcms2 详情页** —— 而浏览器里同时开着多篇
 *   （比如先搜到一篇《工人日报》的报纸文章、又打开一篇期刊论文）时，会拿到**不一定是刚搜的那篇**。
 *   实测踩到：搜"数字经济"排第一的是报纸，报纸**没有引文网络**，于是 `fetch` 报
 *   「页面上未找到引文 tab」 —— 看起来像选择器过时，实际是**点错了页面**。
 *   记住自己开的那篇，让"搜索 → 打开 → 抓引文"落在同一条链上。
 */
let lastOpenedTabId = "";

/**
 * 读 tab 标题并去掉两端可能多出来的引号。
 *
 * ⚠ 本文件的 `evalJs` 会把结果再 `JSON.stringify` 一次, 于是标题可能带**外层引号** ——
 *   拿它跟 `document.title` 比对就会永远不相等(把好端端的同一篇判成"变了")。
 *   统一在这里剥掉, 免得每个调用点各写一遍。
 */
function readTitle(tabId: string): string {
  return evalJs(tabId, `document.title.replace(/ - 中国知网$/, "")`).replace(/^"|"$/g, "");
}

function findCnkiTab(): string {
  try {
    const out = curl(["-s", "-m", "5", `${CDP_PROXY}/targets`]);
    const tabs = JSON.parse(out) as Array<{ targetId: string; title: string; url: string }>;
    /**
     * 自己刚打开的那篇优先 —— 但**必须确认它还是详情页**。
     *
     * ⚠ 2026-09-19 修: 原来只判断 targetId **还在不在**, 不看它现在是什么页面。
     *   而 `searchAndOpen` 会把同一个 tab 导航成**检索页**(并把它记进 `lastOpenedTabId`),
     *   于是"刚打开的详情页"这个记录会指向一个**检索页**, `#refpartdiv` 自然找不到。
     *   这类"记录的是 id、却当成是内容"的错在本轮已经出现三次, 所以这里连内容一起校验。
     */
    if (lastOpenedTabId) {
      const me = tabs.find((t) => t.targetId === lastOpenedTabId);
      if (me && me.url.includes("kcms2")) return lastOpenedTabId;
    }
    // 否则退回任意详情页（kcms2）
    const detail = tabs.find((t) => t.title.includes("中国知网") && t.url.includes("kcms2"));
    if (detail) return detail.targetId;
    // 退回搜索页/首页
    const any = tabs.find((t) => t.title.includes("中国知网") || t.url.includes("kns.cnki.net"));
    return any?.targetId ?? "";
  } catch {
    return "";
  }
}

/** 通过 CDP eval 执行 JS（JS 写入临时文件再 curl 上传，彻底避免 shell 引号转义） */
function evalJs(targetId: string, expression: string): string {
  let tmpFile = "";
  try {
    tmpFile = path.join(os.tmpdir(), `cnki-eval-${Date.now()}-${Math.floor(Math.random() * 10000)}.js`);
    fs.writeFileSync(tmpFile, expression, "utf-8");
    const out = curl(
      ["-s", "-m", "20", "-X", "POST", `${CDP_PROXY}/eval?target=${targetId}`, "--data-binary", `@${tmpFile}`],
      { maxBuffer: 1024 * 1024 * 8, timeout: 25000 }
    );
    const parsed = JSON.parse(out);
    return parsed?.value ?? "";
  } catch (error) {
    return "";
  } finally {
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch { /* 忽略 */ }
    }
  }
}

/**
 * 通过 CDP 导航。
 *
 * ⚠⚠ 2026-09-19 修: 这里原先把 URL 用 `JSON.stringify(url)` 发出去 —— 代理要的是**裸 URL 文本**
 *   (与 `/new` 同一个约定)。传 JSON 串会让导航**静默失效**: 页面停在旧内容上, 而所有调用方
 *   都以为"已经导航过去了"。
 *
 *   后果极隐蔽, 且**本轮所有怪现象都是它长出来的**: 检索页一直停在我先前探针留下的
 *   `kw=数字经济` 结果上 → "搜什么都打开同一篇" → 而那篇恰好是**报纸**(没有引文网络)
 *   → 报"页面上未找到引文 tab" → 我据此连续写下了**三版错误结论**
 *   ("结构已变更 / 数据不下发 / 功能不可用")。
 *
 *   `newTab()` 当年栽的是**同一个坑**(见文件头那个 bug 的记录) —— 同一个错误在这个文件里
 *   犯了两次, 所以这里改成**直接用共享实现**, 不再留第二份拷贝。
 */
function navigate(targetId: string, url: string): boolean {
  return cdpNavigate(targetId, url);
}

/** 通过 CDP 新建 tab */
/**
 * 新建 tab 并返回 targetId。
 *
 * ⚠ 2026-09-19 修: 这里原先把 URL 用 `JSON.stringify(url)` 发出去 —— **代理要的是裸 URL 文本**
 *   (见 web-access skill 的文档: `curl -s -X POST --data-raw 'https://example.com' :3456/new`)。
 *   传 JSON 串会让 `/new` 返回**空响应**, `JSON.parse("")` 抛错被 catch 吞掉 → 返回空 targetId
 *   → 上层报"打开论文详情页失败"。
 *
 *   这个错从 2026-08 就在, 后果是 **`searchAndOpen` 从来没成功打开过任何详情页** ——
 *   表现为"知网功能有路由、有实现, 但一用就失败", 很容易被当成"知网本身不稳定"。
 *   实测对照: 裸 URL → `{"targetId":"CBC8641907…"}`; JSON 串 → 空。
 */
function newTab(url: string): string {
  try {
    const out = curl(
      ["-s", "-m", "20", "-X", "POST", `${CDP_PROXY}/new`, "--data-raw", url]
    );
    const parsed = JSON.parse(out);
    return parsed?.targetId ?? "";
  } catch {
    return "";
  }
}

/** 通过 CDP 关闭 tab */
function closeTab(targetId: string): void {
  try {
    curl(["-s", "-m", "5", `${CDP_PROXY}/close?target=${targetId}`]);
  } catch {
    // 忽略
  }
}

/**
 * 通过 CDP 真实鼠标点击元素。
 *
 * ⚠⚠ 2026-09-19 修: 这里原先把选择器用 `JSON.stringify(selector)` 发出去 —— 而代理
 *   (`/clickAt`) 要的是**裸选择器文本**, 它自己会 `JSON.stringify` 一次。
 *   多发一层引号 → `document.querySelector('"#paper-link-real"')` → **永远找不到元素**
 *   → `clickAt` 恒为 false → `searchAndOpen` **每次都走回退分支** `newTab`。
 *
 *   后果(这才是本模块所有怪现象的**总开关**): 回退开的详情页是**后台标签**
 *   (`visibilityState: "hidden"`, 且代理不支持激活标签), 而知网的引文区**只在标签可见时才渲染数据** ——
 *   实测后台页 `#refpartdiv` 永远只有 6 个标签文字、`innerText` 长度**恒为 39**,
 *   等 25 秒也不变。
 *   ⇒ 于是抓引文永远取不到东西, 我却一路把它解释成"知网改了结构 / 不下发数据"。
 *
 *   真实鼠标点击(而非 `el.click()`)在这里是**必须的**: 它会走浏览器默认行为,
 *   知网在新标签里打开详情页, 那个标签是**前台**的, 数据才会渲染。
 *   同一个"该传裸文本却传了 JSON"的错, 本文件已经犯了三次(newTab / navigate / clickAt) ——
 *   三处都已改为共用 `cdp-browser.ts` 的约定或直接发裸文本。
 */
function clickAt(targetId: string, selector: string): boolean {
  try {
    const out = curl(
      ["-s", "-m", "20", "-X", "POST", `${CDP_PROXY}/clickAt?target=${targetId}`, "-d", selector]
    );
    return out.includes('"clicked":true');
  } catch {
    return false;
  }
}

/** 找到知网搜索页 tab（用于发起新搜索；不用详情页，避免覆盖） */
function findCnkiSearchTab(): string {
  try {
    const out = curl(["-s", "-m", "5", `${CDP_PROXY}/targets`]);
    const tabs = JSON.parse(out) as Array<{ targetId: string; title: string; url: string }>;
    const search = tabs.find((t) => t.url.includes("kns.cnki.net") && t.url.includes("defaultresult"));
    return search?.targetId ?? "";
  } catch {
    return "";
  }
}

/** 知网搜索并打开一篇论文详情页，返回详情页 tab id */
export async function searchCnkiAndOpenPaper(query: string): Promise<{ ok: boolean; tabId?: string; paperTitle?: string; error?: string }> {
  let targetId = findCnkiSearchTab();
  if (!targetId) {
    // 没有知网 tab → 自动创建搜索页（登录态在浏览器 cookie 里，无需重新登录）
    targetId = newTab("https://kns.cnki.net/kns8s/defaultresult/index?korder=SU");
    if (!targetId) {
      return { ok: false, error: "无法创建知网标签页" };
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  /**
   * ⚠ 关键: 上面那个 tab 之后**只能**经由 `searchTabId` 访问, 不能再调 `findCnkiSearchTab()`。
   *
   *   实测踩到(2026-09-19): 浏览器里同时开着 4 个知网检索页(探针跑多了留下的), 而
   *   `findCnkiSearchTab()` 取的是**任意一个** `defaultresult` 页 —— 于是我们**导航 A 页**去搜
   *   「数实融合对产业链供应链…」, 却**轮询 B 页**(还停在 `kw=数字经济`, 136,915 条),
   *   挑出来的是 B 页的第一条。表现就是"搜什么都打开同一篇", 极难看出是页面对错了。
   *   原来第 4 步找详情页时**又调了一次** `findCnkiSearchTab()` 来排除自身 —— 那正是漏洞所在。
   */
  const searchTabId = targetId;

  // 1. 导航到知网搜索页（主题检索）
  const searchUrl = `https://kns.cnki.net/kns8s/defaultresult/index?korder=SU&kw=${encodeURIComponent(query)}`;
  navigate(targetId, searchUrl);
  lastOpenedTabId = targetId;

  /**
   * 导航**必须自证**: 确认页面真的带上了这次的 `kw`。
   *
   * ⚠ 为什么值得单独一步(2026-09-19): `navigate` 曾因传参错**静默失效** —— 页面停在旧结果上,
   *   而所有调用方都以为"已经导航过去了"。于是"搜什么都打开同一篇"。当时没有任何一处检查,
   *   是我人肉发现的。导航后核对 URL 里的 kw 只要一次 `tabInfo`, 却能在第一时间把这类错钉死。
   */
  let navigated = false;
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setTimeout(r, 2500));
    const cur = tabInfo(targetId);
    if (cur?.url && decodeURIComponent(cur.url).includes(query)) { navigated = true; break; }
  }
  if (!navigated) {
    const cur = tabInfo(targetId);
    return { ok: false, error: `知网检索页导航未生效(仍停在: ${decodeURIComponent(cur?.url ?? "").slice(0, 80)}) —— 请重试, 或检查 CDP 代理` };
  }

  // 2. 轮询等待论文链接出现（最多 30 秒）
  let firstLink = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((r) => setTimeout(r, 3000));
    firstLink = evalJs(targetId, PICK_PAPER_EXPR);
    if (firstLink && firstLink !== '"') break;
  }

  if (!firstLink || firstLink === '"') {
    return { ok: false, error: "搜索结果中未找到论文（可能被安全验证拦截，请手动在 Edge 完成滑块验证）" };
  }

  // 3. 在搜索页内标记论文链接，真实鼠标点击打开详情页（模拟完整用户流程，确保引文数据加载）
  evalJs(
    targetId,
    `(() => {
      const picked = ${PICK_PAPER_EXPR};
      if (!picked) return "nf";
      const t = Array.from(document.querySelectorAll("a[href*='kcms2/article/abstract']")).find(a => a.href === picked);
      if (!t) return "nf";
      t.id = "paper-link-real";
      return "ok";
    })()`
  );
  await new Promise((r) => setTimeout(r, 2000));
  // 点击**之前**先记下已开的详情页, 之后靠差集认出"刚点开的这篇"
  const beforeClickDetailIds = new Set(
    (() => {
      try {
        const out = curl(["-s", "-m", "5", `${CDP_PROXY}/targets`]);
        return (JSON.parse(out) as Array<{ targetId: string; url: string }>)
          .filter((t) => t.url.includes("kcms2"))
          .map((t) => t.targetId);
      } catch {
        return [] as string[];
      }
    })()
  );
  const clicked = clickAt(targetId, "#paper-link-real");
  if (!clicked) {
    // 回退：newTab 直接导航
    const detailTab = newTab(firstLink);
    if (!detailTab) return { ok: false, error: "打开论文详情页失败" };
    await new Promise((r) => setTimeout(r, 10000));
    const title = readTitle(detailTab);
    if (!title || title === '"') {
      closeTab(detailTab);
      return { ok: false, error: "详情页加载失败（可能触发安全验证）" };
    }
    currentDetail = { tabId: detailTab, title };
    return { ok: true, tabId: detailTab, paperTitle: title };
  }

  // 4. 真实点击后知网会打开详情页（新 tab 或当前 tab 跳转），等待并找到它
  await new Promise((r) => setTimeout(r, 10000));
  let detailTab = "";
  try {
    const out = curl(["-s", "-m", "5", `${CDP_PROXY}/targets`]);
    const tabs = JSON.parse(out) as Array<{ targetId: string; title: string; url: string }>;
    /**
     * 找**我们刚点开的那一篇**, 不能随便挑一个 kcms2。
     *
     * ⚠ 实测踩到(2026-09-19): 原来写的是"取第一个 targetId !== 搜索页的 kcms2",
     *   而浏览器里可能同时开着好几篇旧详情页 —— 于是**明明要点 A, 却把旧的那篇 B 返回了**,
     *   后续抓引文抓的是 B 的数据。和上面 `searchTabId` 是同一类错(拿"任意一个"当"刚操作的那个"),
     *   只是在两个不同步骤上各犯了一次。
     *   可靠判据: **点击之后新出现的**那个 kcms2(与点击前做差集)。
     */
    const details = tabs.filter((t) => t.url.includes("kcms2"));
    const fresh = details.find((t) => !beforeClickDetailIds.has(t.targetId));
    const fallback = details.find((t) => t.targetId !== searchTabId) ?? details[0];
    detailTab = (fresh ?? fallback)?.targetId ?? "";
  } catch {
    // 忽略
  }
  if (!detailTab) {
    return { ok: false, error: "点击后未找到详情页 tab" };
  }

  const title = readTitle(detailTab);
  const cleanTitle = title.replace(/^"|"$/g, "");
  currentDetail = { tabId: detailTab, title: cleanTitle };
  // ⚠ 这里**不要**把 lastOpenedTabId 设成 detailTab: 那个变量是给 `findCnkiTab` 用的
  //   "当前详情页"指针, 而本 tab 已是一个真正的 kcms2 详情页 —— `findCnkiTab` 自己就能找到它。
  //   反过来若是把**检索页**写进去(本函数早先的写法), 就会让 `findCnkiTab` 返回检索页(已修)。

  return { ok: true, tabId: detailTab, paperTitle: title };
}

/** 提取引文数据：先点击 tab，再从 refpartdiv 提取条目 */
export async function fetchCnkiCitations(
  type: CnkiCitationType,
  /**
   * 指定在哪个详情页 tab 上抓。
   *
   * 用途(2026-09-19): 检索结果里挑中的是**某一篇**, 而 `searchAndOpen` 只打开搜索结果的**第一篇** ——
   *   实测搜「数字经济」第一篇是《工人日报》的**报纸**文章, 报纸**没有引文网络**,
   *   于是抓引文报"页面上未找到引文 tab", 看起来像选择器失效, 实际是**点错了文献类型**。
   *   调用方拿到检索结果的 `url` 后自己开 tab, 再把这个 tabId 传进来。
   */
  targetIdOverride?: string
): Promise<CnkiCitationResult> {
  // 优先用调用方指定的 tab; 其次用 searchAndOpen 打开的那篇
  let targetId = targetIdOverride && evalJs(targetIdOverride, "document.title") ? targetIdOverride : "";
  if (!targetId && currentDetail) {
    /**
     * ⚠ **核对标题**, 不是只核对 id 还在不在。
     *
     *   原来写的是"该 id 还在、且 url 含 kcms2"就采用 —— 但浏览器里同时开着多篇旧详情页时,
     *   我们记的那条可能早已过期/指向别的文章。实测: 刚搜的《数实融合…》, 抓到的却是
     *   《国际科技反垄断…》的内容, **而且不报错**。记了标题就能一眼拒掉。
     *   真的被导航走了(标题变了)→ 视为失效, 交给 `findCnkiTab` 按内容重新认。
     */
    const live = listTargets().find((t) => t.targetId === currentDetail!.tabId);
    if (live && live.url.includes("kcms2")) {
      const nowTitle = readTitle(currentDetail.tabId);
      const want = currentDetail.title;
      // 标题相同(或我们当初没记到标题)才算同一篇
      if (!want || nowTitle === want || (nowTitle && want && (nowTitle.includes(want) || want.includes(nowTitle)))) {
        targetId = currentDetail.tabId;
      }
    }
  }
  if (!targetId) targetId = findCnkiTab();
  if (!targetId) {
    return {
      ok: false,
      type,
      items: [],
      error: "未找到知网详情页 tab——请确保 Edge 中已登录知网并打开论文详情页"
    };
  }

  /**
   * ⚠ 先分辨"**被安全验证挡住**"与"**这篇没有引文区**" —— 两者表现一样(都找不到引文 tab),
   *   但处置完全不同: 前者要用户本人去点验证码, 后者是正常情况(报纸/资讯类没有引文网络)。
   *   实测(2026-09-19): 连开几篇详情页后知网会弹 `kns.cnki.net/verify/home?captchaType=clickWord`。
   *   若不分辨, 用户会一直以为"这个功能坏了"。
   */
  try {
    const cur = tabInfo(targetId);
    if (cur?.url && /\/verify\//.test(cur.url)) {
      return {
        ok: false,
        type,
        items: [],
        error: "知网要求人机验证——请在浏览器里完成验证后重试(验证码只能由你本人完成)"
      };
    }
  } catch {
    /* 读不到 URL 就按原路继续 */
  }

  // 注: 这里曾有一段"滚动到引文区触发懒加载"的代码, 注释写着"滚动后点击才触发数据请求" ——
  //   实测**不需要**: 数据本就随页面下发(`#refpartdiv` 里直接就有 10 条), 合成点击也足以切 tab。
  //   删掉它省 2 秒, 也免得把"需要滚动"这个错误认知留在代码里。

  /**
   * 1. 等引文区**真的带上数据**, 不是只等那 6 个标签。
   *
   * ⚠⚠ 这是本模块最隐蔽的一处时序问题(2026-09-19 实测钉死):
   *   同一篇《数实融合对产业链供应链韧性的影响机制研究——基于中国省域面板数据的实证检验》,
   *   第一次打开时 `#refpartdiv` 的 `li=6`、`innerText` 长度 **712**、有条目;
   *   后来再打开, 同一个 `li=6` 但 `innerText` 只有 **39** —— **正好只等于 6 个标签文字的长度**,
   *   一个条目都没有。也就是说: **标签先渲染、数据后到, 有时干脆不到。**
   *
   *   所以"等 `li >= 6`"是**不够**的(那只能说明标签在)。真正的判据是**区里有条目或计数**,
   *   即 `innerText` 长度明显超过标签本身(> 120)。
   *
   *   等不到就**重载一次页面**再等 —— 实测重载后常能拿到数据。两次都空才算"这篇没有"。
   *   这一步是本轮排查的终点: 我先前所有"数据不下发 / 结构变了"的结论,
   *   都是**在数据尚未到达的时刻读了一次**就下的。
   */
  const refpartReady = async (): Promise<{ lis: number; len: number }> => {
    const raw = evalJs(
      targetId,
      `(function(){ var rp=document.querySelector("#refpartdiv"); return JSON.stringify({ lis: rp?rp.querySelectorAll("li").length:-1, len: rp?(rp.innerText||"").length:-1 }); })()`
    );
    try {
      return JSON.parse(raw) as { lis: number; len: number };
    } catch {
      return { lis: -1, len: -1 };
    }
  };

  let state = { lis: -1, len: -1 };
  let reloaded = false;
  for (let i = 0; i < 14; i += 1) {
    state = await refpartReady();
    // 6 个标签齐全, 且文本明显超过标签本身 ⇒ 数据到了
    if (state.lis >= 6 && state.len > 120) break;
    // 标签在但没数据, 熬了 4 轮还没来 ⇒ 重载一次再等
    if (state.lis >= 6 && state.len <= 120 && i === 3 && !reloaded) {
      reloaded = true;
      const cur = tabInfo(targetId);
      if (cur?.url) cdpNavigate(targetId, cur.url);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (state.lis < 6) {
    return { ok: false, type, items: [], error: "页面上未找到引文 tab —— 多为该文献类型没有引文网络(报纸/资讯类), 或详情页被安全验证拦截", tabFound: false };
  }
  if (state.len <= 120) {
    /**
     * 标签在、数据没来。**最可能是"标签页在后台"** —— 实测这是知网的硬行为:
     *   后台标签(`document.visibilityState === "hidden"`)的 `#refpartdiv` **永远只渲染 6 个标签文字**,
     *   `innerText` 长度**恒为 39**, 等 25 秒不变、重载也不变; 而同一个 URL 在**可见**标签里
     *   就有完整条目(长度 712、10 条)。
     *
     * ⚠ 所以这里要**说清是环境原因**, 不能含糊成"抓取失败" —— 我先前就是含糊过去,
     *   一路把它误读成"知网改了结构 / 不下发数据"。
     *   目前的 CDP 代理**没有"激活标签"端点**(只有 /new /navigate /close /back /eval /click /clickAt
     *   /scroll /screenshot /info /targets), 而 `window.focus()` 也改不了 visibilityState
     *   (实测仍是 hidden)。因此服务端**无法自己**把标签切到前台。
     */
    const vis = evalJs(targetId, "document.visibilityState");
    const hidden = vis.replace(/^"|"$/g, "") === "hidden";
    return {
      ok: false,
      type,
      items: [],
      error: hidden
        ? "该文献详情页当前在**后台标签**, 知网的引文区在后台不渲染数据 —— 请在浏览器里把这个知网标签切到前台, 再点一次"
        : "引文区只渲染出标签、数据未加载(已重载重试) —— 稍后再点一次"
    };
  }

  const cls = TAB_CLASSES[type];
  const markResult = evalJs(
    targetId,
    `(() => { const tabs = Array.from(document.querySelectorAll("#refpartdiv li")); const t = tabs.find(x => (x.className || "").includes("${cls}")); if (!t) return "notfound"; t.click(); return "ok:" + (t.innerText || "").trim(); })()`
  );
  if (!markResult.startsWith("ok")) {
    return { ok: false, type, items: [], error: `页面上没有「${TAB_LABELS[type]}」这一类引文 tab(实测 6 类 tab 通常会一起出现)`, tabFound: false };
  }

  // 3. 等待数据加载后提取（重试 5 次，每次 4 秒——tab 切换后数据异步加载）
  let raw = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((r) => setTimeout(r, 4000));
    raw = evalJs(
      targetId,
      `(() => {
        // 从 refpartdiv 整体文本解析（数据可能是 li 或 div 结构）
        const el = document.querySelector("#refpartdiv");
        if (!el) return JSON.stringify({items: [], counts: []});
        const NL = String.fromCharCode(10);
        const lines = el.innerText.split(NL).map(s => s.trim()).filter(Boolean);
        const TAB_NAMES = ["引文网络", "参考文献", "引证文献", "共引文献", "同被引文献", "二级参考文献", "二级引证文献", "节点文献"];
        const items = lines
          .filter(l => !TAB_NAMES.includes(l))
          .filter(l => /^[\\[［][0-9]+[\\]］]/.test(l))
          .map(l => {
            const m = l.match(/[0-9]+/);
            return {raw: l, seq: m ? parseInt(m[0], 10) : 9999};
          });
        items.sort((a, b) => a.seq - b.seq);
        const counts = lines.filter(l => /共[\\s]*[0-9]+[\\s]*条/.test(l)).slice(0, 2);
        return JSON.stringify({items: items.slice(0, 200), counts: counts});
      })()`
    );
    if (raw.includes('"items"') && !raw.includes('"items":[]')) break;
  }

  let parsed: { active?: string; items?: Array<{ raw: string; seq: number }>; counts?: string[] } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  const items = (parsed.items ?? []).map(({ raw }) => ({ raw }));
  if (items.length === 0) {
    return {
      ok: true,
      type,
      items: [],
      total: parsed.counts?.[0],
      // 实测: 某一类引文为 0 是**正常结果**(页面自己写着「引证文献(0)」), 不是抓取失败。
      //   只有 6 个 tab 都不在时才该报错(见上面的 markResult 分支)。
      //   ⚠ 措辞要**说明**而不是**报错**: 面板会把这句直接显示给用户(空态解释)。
      error: `该文献的「${TAB_LABELS[type]}」为 0 条(知网页面对此类引文本身计数为 0, 属正常结果)`
    };
  }

  return {
    ok: true,
    type,
    items,
    total: parsed.counts?.[0],
    paperTitle: evalJs(targetId, `document.title.replace(/ - 中国知网$/, "")`)
  };
}

/**
 * 读**当前浏览器**里的知网登录身份。
 *
 * 产品前提(必须说清, 别让界面暗示我们在存密码): **我们不保存知网的账号密码**。
 *   知网访问走的是用户自己浏览器里的登录态(知网写下的 `Ecp_LoginStuts` cookie)。
 *   本函数只是**把它读出来显示给用户看**, 好让用户知道"现在拿谁的身份在查"。
 *
 * 实测(2026-09-19, 用户的 Edge): `{UserName:"GZ0041", ShowName:"南宁师范大学", UserType:"bk"}` ——
 *   `bk` 表示机构账号(学校/单位订阅), 这也是"机构订阅"模式的判定依据。
 */
export interface CnkiIdentity {
  ok: boolean;
  loggedIn: boolean;
  /** 账号名(如 GZ0041) */
  userName?: string;
  /** 显示名(如 南宁师范大学) */
  showName?: string;
  /** 账号类型: bk(机构/包库) / 个人登录等其他值 */
  userType?: string;
  /** 是否机构订阅身份 */
  isInstitution?: boolean;
  error?: string;
}

export async function readCnkiIdentity(): Promise<CnkiIdentity> {
  const tabId = findCnkiTab();
  if (!tabId) return { ok: false, loggedIn: false, error: "浏览器里没有知网标签页 —— 请先在 Edge 里打开知网" };
  try {
    const raw = evalJs(
      tabId,
      `(() => { const m = document.cookie.match(/Ecp_LoginStuts=([^;]+)/); return m ? decodeURIComponent(m[1]) : ""; })()`
    );
    const cookie = String(raw ?? "").trim();
    if (!cookie) return { ok: true, loggedIn: false };
    const parsed = JSON.parse(cookie) as { UserName?: string; ShowName?: string; UserType?: string };
    const decodeName = (v?: string) => {
      if (!v) return "";
      try { return decodeURIComponent(v); } catch { return v; }
    };
    const userType = String(parsed.UserType ?? "");
    return {
      ok: true,
      loggedIn: Boolean(parsed.UserName || parsed.ShowName),
      userName: String(parsed.UserName ?? ""),
      showName: decodeName(parsed.ShowName),
      userType,
      // bk = 包库/机构订阅; 个人账号知网给的是别的值
      isInstitution: userType === "bk"
    };
  } catch (e) {
    return { ok: false, loggedIn: false, error: String((e as Error)?.message ?? e).slice(0, 160) };
  }
}

export const cnkiCitationProxy = {
  fetch: fetchCnkiCitations,
  findTab: findCnkiTab,
  searchAndOpen: searchCnkiAndOpenPaper,
  readIdentity: readCnkiIdentity
};
