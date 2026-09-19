// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// tabInfo 来自通用 CDP 原语(2026-09-19 抽出); 本文件其余 curl/evalJs 仍是自己的实现, 逐步收敛中
import { tabInfo } from "./cdp-browser.js";

/**
 * cnki-citation-proxy — 知网引文网络 CDP 代理
 *
 * ⚠⚠ **当前状态: 对不上知网的新结构, 引文抓取实际不可用(2026-09-19 实测)**。
 *
 *   本模块假定引文在 `#refpartdiv` 内以 `[N] …` 行成列。**实测该结构已不存在**:
 *     · `#refpartdiv` 只剩 `H5.module-title` + `UL.module-tab`(6 个 tab 名) + `#MapArea`;
 *     · `#MapArea` 内 `#references` 现在是一个 **`<a class="ReferLinkOn">参考文献</a>` 链接**,
 *       不再是列表容器; 所有 `nxgp-*` 容器 `li=0`、字节为 0;
 *     · 引文内容改成了**点链接跳转**, 不再是页面内展开。
 *   ⇒ 结果: 要么报"页面上未找到引文 tab", 要么报"该论文暂无引文数据" —— **两种都不准**,
 *     真实原因是容器结构换过。**别把它当成"这篇没数据"。**
 *
 *   佐证: 同一时间两篇详情页(`#refpartdiv` 分别 =1 / =0)**都是 0 条引文**;
 *         且两篇都通过了一次验证码, 排除了"被验证页挡住"这条原因。
 *
 *   消费者: 目前**只有 `web/src/lib/api.ts` 的一层封装, 没有任何 UI 调用** ——
 *     也就是说它现在既不工作、也没人用。要恢复需要按新结构重写抓取(那是新的一摊调研,
 *     而且知网会再改); 在那之前**不要把它接进界面**, 否则用户看到的是"这个功能坏了"。
 *
 *   仍然可靠的用途: `searchAndOpen`(检索并打开详情页)与 `readIdentity`(读登录身份) —— 实测可用。
 *
 * 原设计(已失效, 留档): 通过 CDP proxy(localhost:3456)驱动浏览器知网页面：
 * 1. 找到知网详情页 tab
 * 2. 真实点击引文 tab(参考文献/引证文献/共引文献/同被引文献/二级参考文献/二级引证文献)
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


// 当前打开的知网详情页 tab（searchAndOpen 设置，fetch 优先使用）
let currentDetailTab = "";

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

export interface CnkiCitationResult {
  ok: boolean;
  type: CnkiCitationType;
  paperTitle?: string;
  items: Array<{ raw: string }>;
  total?: string;
  error?: string;
  tabFound?: boolean;
}

/** 找到知网 tab（优先详情页 kcms2，退回任意知网 tab） */
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

function findCnkiTab(): string {
  try {
    const out = curl(["-s", "-m", "5", `${CDP_PROXY}/targets`]);
    const tabs = JSON.parse(out) as Array<{ targetId: string; title: string; url: string }>;
    // 自己刚打开的那篇优先（它才是用户/调用方要抓的对象）
    if (lastOpenedTabId && tabs.some((t) => t.targetId === lastOpenedTabId)) return lastOpenedTabId;
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

/** 通过 CDP 导航 */
function navigate(targetId: string, url: string): boolean {
  try {
    curl(
      ["-s", "-m", "20", "-X", "POST", `${CDP_PROXY}/navigate?target=${targetId}`, "--data-raw", JSON.stringify(url)]
    );
    return true;
  } catch {
    return false;
  }
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

/** 通过 CDP 真实鼠标点击元素 */
function clickAt(targetId: string, selector: string): boolean {
  try {
    const out = curl(
      ["-s", "-m", "20", "-X", "POST", `${CDP_PROXY}/clickAt?target=${targetId}`, "-d", JSON.stringify(selector)]
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

/** 知网搜索并打开第一篇论文详情页，返回详情页 tab id */
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

  // 1. 导航到知网搜索页（主题检索）
  const searchUrl = `https://kns.cnki.net/kns8s/defaultresult/index?korder=SU&kw=${encodeURIComponent(query)}`;
  navigate(targetId, searchUrl);
  lastOpenedTabId = targetId;

  // 2. 轮询等待论文链接出现（最多 30 秒）
  let firstLink = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((r) => setTimeout(r, 3000));
    firstLink = evalJs(
      targetId,
      `(() => {
        const links = Array.from(document.querySelectorAll("a[href*='kcms2/article/abstract']"));
        const target = links.find(a => (a.innerText || "").trim().length > 8 && (a.innerText || "").trim().length < 60);
        return target ? target.href : "";
      })()`
    );
    if (firstLink && firstLink !== '"') break;
  }

  if (!firstLink || firstLink === '"') {
    return { ok: false, error: "搜索结果中未找到论文（可能被安全验证拦截，请手动在 Edge 完成滑块验证）" };
  }

  // 3. 在搜索页内标记论文链接，真实鼠标点击打开详情页（模拟完整用户流程，确保引文数据加载）
  evalJs(
    targetId,
    `(() => { const links = Array.from(document.querySelectorAll("a[href*='kcms2/article/abstract']")); const t = links.find(a => (a.innerText || "").trim().length > 8 && (a.innerText || "").trim().length < 60); if (!t) return "nf"; t.id = "paper-link-real"; return "ok"; })()`
  );
  await new Promise((r) => setTimeout(r, 2000));
  const clicked = clickAt(targetId, "#paper-link-real");
  if (!clicked) {
    // 回退：newTab 直接导航
    const detailTab = newTab(firstLink);
    if (!detailTab) return { ok: false, error: "打开论文详情页失败" };
    await new Promise((r) => setTimeout(r, 10000));
    const title = evalJs(detailTab, `document.title.replace(/ - 中国知网$/, "")`);
    if (!title || title === '"') {
      closeTab(detailTab);
      return { ok: false, error: "详情页加载失败（可能触发安全验证）" };
    }
    currentDetailTab = detailTab;
    return { ok: true, tabId: detailTab, paperTitle: title };
  }

  // 4. 真实点击后知网会打开详情页（新 tab 或当前 tab 跳转），等待并找到它
  await new Promise((r) => setTimeout(r, 10000));
  let detailTab = "";
  try {
    const out = curl(["-s", "-m", "5", `${CDP_PROXY}/targets`]);
    const tabs = JSON.parse(out) as Array<{ targetId: string; url: string }>;
    // 找所有 kcms2 详情页（排除搜索页自身）
    const details = tabs.filter((t) => t.url.includes("kcms2"));
    if (details.length > 0) {
      // 优先取不是搜索页的那个；若搜索页自身跳转成了详情页，也用它
      const notSearch = details.find((t) => t.targetId !== targetId) ?? details[0];
      detailTab = notSearch.targetId;
    }
  } catch {
    // 忽略
  }
  if (!detailTab) {
    return { ok: false, error: "点击后未找到详情页 tab" };
  }

  const title = evalJs(detailTab, `document.title.replace(/ - 中国知网$/, "")`);
  currentDetailTab = detailTab;

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
  // 优先用调用方指定的 tab; 其次用 searchAndOpen 打开的(并验证仍有效, 避免指向已失效 tab)
  let targetId = targetIdOverride && evalJs(targetIdOverride, "document.title") ? targetIdOverride : "";
  if (!targetId && currentDetailTab) {
    try {
      const out = curl(["-s", "-m", "5", `${CDP_PROXY}/targets`]);
      const tabs = JSON.parse(out) as Array<{ targetId: string; url: string }>;
      const stillValid = tabs.some((t) => t.targetId === currentDetailTab && t.url.includes("kcms2"));
      if (stillValid) {
        // 额外验证 CDP session 可用（attach 失败则视为失效）
        const probe = evalJs(currentDetailTab, `document.title`);
        if (probe) targetId = currentDetailTab;
      }
    } catch {
      // 忽略，走 findCnkiTab
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

  // 0. 滚动到引文区域（知网懒加载：滚动后点击 tab 才触发数据请求）
  evalJs(
    targetId,
    `(() => { const el = document.querySelector("#refpartdiv"); if (el) { el.scrollIntoView({block: "center"}); return "scrolled"; } return "no el"; })()`
  );
  await new Promise((r) => setTimeout(r, 2000));

  // 1. 标记目标 tab 元素（点击前先确保 tab 存在）
  const cls = TAB_CLASSES[type];
  const markResult = evalJs(
    targetId,
    `(() => { const tabs = Array.from(document.querySelectorAll("#refpartdiv li")); const t = tabs.find(x => (x.className || "").includes("${cls}")); if (!t) return "notfound"; t.click(); return "ok:" + (t.innerText || "").trim(); })()`
  );
  if (!markResult.startsWith("ok")) {
    /**
     * ⚠ 这句**措辞不准, 会把人带偏**: "没有引文 tab" 让人以为页面没这个功能区。
     *   实测(2026-09-19) 6 个引文 tab **都在**(在 `UL.module-tab` 里), 只是**不在 `#refpartdiv li` 里**
     *   —— 也就是本模块依赖的那层结构没了。真实原因是**知网改版**, 不是"页面没有引文功能"。
     */
    return { ok: false, type, items: [], error: "知网的引文区结构已变更(本模块仍按旧结构 #refpartdiv li 查找) —— 引文抓取当前不可用, 详见文件头", tabFound: false };
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
      // ⚠ 这句以前会被当成"这篇确实没有引文"。但实测**新结构下所有容器都是空的**,
      //   所以它更可能是"抓取对不上结构"而不是"没数据"。措辞必须把两种可能都说出来。
      error: "未解析到引文条目 —— 可能是该文献确无此类引文(如报纸/资讯类), 也可能是知网的引文容器结构已变更(实测 2026-09 已变)"
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
