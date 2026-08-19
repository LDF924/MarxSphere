// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * cnki-citation-proxy — 知网引文网络 CDP 代理
 *
 * 通过 CDP proxy（localhost:3456）驱动浏览器知网页面：
 * 1. 找到知网详情页 tab
 * 2. 真实点击引文 tab（参考文献/引证文献/共引文献/同被引文献/二级参考文献/二级引证文献）
 * 3. 从 #refpartdiv 提取对应数据
 *
 * 依赖：web-access skill 的 cdp-proxy（Edge 已登录知网）
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
function findCnkiTab(): string {
  try {
    const out = curl(["-s", "-m", "5", `${CDP_PROXY}/targets`]);
    const tabs = JSON.parse(out) as Array<{ targetId: string; title: string; url: string }>;
    // 优先详情页（kcms2）
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
function newTab(url: string): string {
  try {
    const out = curl(
      ["-s", "-m", "20", "-X", "POST", `${CDP_PROXY}/new`, "--data-raw", JSON.stringify(url)]
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
export async function fetchCnkiCitations(type: CnkiCitationType): Promise<CnkiCitationResult> {
  // 优先用 searchAndOpen 打开的详情页 tab，但验证它仍有效（避免指向已失效 tab）
  let targetId = "";
  if (currentDetailTab) {
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
    return { ok: false, type, items: [], error: "页面上未找到引文 tab", tabFound: false };
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
      error: "该论文在知网暂无此类型引文数据（数据为空）"
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

export const cnkiCitationProxy = {
  fetch: fetchCnkiCitations,
  findTab: findCnkiTab,
  searchAndOpen: searchCnkiAndOpenPaper
};
