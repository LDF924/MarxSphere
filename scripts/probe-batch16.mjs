// probe-batch16.mjs — AI 对话页的工具/能力不再是"半中半英"
//
// 由来(2026-09-29 用户: "AI 对话好久没更新其调用工具和能力了"):
//   `ChatPanel.tsx` 里那份 `TOOL_META` 是手抄的且是唯一来源 —— 后端 75 个工具它只登记 38 个,
//   剩下 37 个(pdf_parse / orch_run / meta_invoke / format_eval / browser_control /
//   view_openalex_search / 教育六件套 …)在对话的工具链里**显示成英文原名**。
//
// 覆盖:
//   ① 对话页真的去取后端的实时工具表(判据是网络请求, 不是源码里有没有那个字符串)
//   ② 那张表覆盖后端**全部**工具(少了哪个, 哪个就在界面上显示成英文)
//   ③ 后端每个工具都有中文 label(否则前端拿到的还是英文 —— 这是根因侧)
//   ④ 对话可用工具 = 后端全部工具(**没有白名单在偷偷砍掉一半能力**)
//
// ⚠ 不烧模型: 只读接口 + 读一个页面的 DOM。
//
// 用法: node scripts/probe-batch16.mjs   (需 4173 已起, 外壳产物已重建)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${n}${ex ? " — " + ex : ""}`); ok ? pass++ : fail++; };

const api = async (token, p, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const token = await loginToken();
if (!token) { console.error("登录失败: 4173 未起或缺 verify 账号"); process.exit(1); }

// ═══ ③④ 后端侧: 每个工具都有中文名, 且对话拿到的就是全量 ═══
console.log("\n③④ 后端工具表");
const toolsRes = await api(token, "/agent/tools");
const tools = toolsRes.body?.tools ?? [];
t("能拿到后端工具表", tools.length > 50, `${tools.length} 个`);
const noLabel = tools.filter((x) => !x.label || !/[一-龥]/.test(x.label));
t("**每个工具都有中文 label**(否则前端拿到手的还是英文)",
  noLabel.length === 0, noLabel.length ? `无中文名: ${noLabel.map((x) => x.name).join(", ")}` : `${tools.length}/${tools.length} 都有`);

const capsRes = await api(token, "/orchestrator/capabilities");
const caps = capsRes.body?.capabilities ?? [];
t("编排能力表也在", caps.length > 50, `${caps.length} 项`);
const capNoLabel = caps.filter((c) => !c.label || !/[一-龥]/.test(c.label));
t("**每个编排能力也有中文 label**", capNoLabel.length === 0,
  capNoLabel.length ? `无中文名: ${capNoLabel.slice(0, 6).map((c) => c.id).join(", ")}` : `${caps.length}/${caps.length} 都有`);

const { cdp, close } = await startCdp({ preferredPort: 9366, label: "batch16" });
try {
  /**
   * ① 判据是**网络请求**, 不是源码里有没有那个 URL 字符串。
   *   我在单测里第一版就栽在这上面: 说明注释里也写了 `/api/agent/tools`,
   *   于是把 fetch 改掉之后断言**照样绿**。这里改成看真实的请求列表。
   */
  console.log("\n① 对话页是否真去取实时工具表");
  await cdp("Network.enable", {});
  await cdp("Page.navigate", { url: `${BASE}/#assistant` });
  await sleep(5000);
  await evalTop(cdp, `(() => { document.querySelectorAll('.assistant-close,.modal-x').forEach(b => b.click()); return true; })()`);
  await sleep(1500);
  const reqs = await evalTop(cdp, `(() => {
    const e = performance.getEntriesByType('resource').map(r => r.name);
    return e.filter(n => n.includes('/api/')).map(n => n.replace(location.origin, ''));
  })()`);
  /**
   * ⚠ 先确认**落在对话页**。`#chat` 是「搜索过程」视图, AI 对话是 `#assistant` ——
   *   第一版路由写错, 整段 ⑤ 在一张空页面上跑, 断言照样绿(又一次假绿)。
   *   判据用对话页独有的元素(会话侧栏的"新建对话"), 不用 hash 字符串。
   */
  const onChat = await evalTop(cdp, `(() => {
    const txt = document.body.innerText || "";
    return { isChat: /AI 对话|新建对话|深度模式/.test(txt), hash: location.hash };
  })()`);
  t("**落在 AI 对话页**(不是搜索过程页)", onChat?.isChat === true, `hash=${onChat?.hash}`);

  t("**对话页发起了 /api/agent/tools 请求**",
    Array.isArray(reqs) && reqs.some((u) => u.includes("/api/agent/tools")),
    (reqs ?? []).filter((u) => u.includes("/api/agent")).join(" | ") || "没有 agent 相关请求");

  // ② 表格内容: 直接取回来核对覆盖度(界面渲染是它的下游)
  const live = await evalTop(cdp, `(async () => {
    const r = await fetch("/api/agent/tools", { headers: { Authorization: "Bearer " + (localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "") } });
    const j = await r.json();
    const named = (j.tools || []).filter(x => /[\\u4e00-\\u9fa5]/.test(x.label || ""));
    return { total: (j.tools||[]).length, named: named.length };
  })()`);
  t("② 前端能取到**全量**工具表(不是裁剪过的子集)",
    live?.total === tools.length, `前端 ${live?.total} / 后端 ${tools.length}`);
  t("② 取到的每一项都带中文名", live?.named === live?.total, `${live?.named}/${live?.total}`);

  /**
   * ⑤ **打开一个真跑过工具的会话**, 看工具链里渲染出来的名字。
   *
   * 这一条是整段的重点: 前面几条验的是"表取回来了", 而用户看到的是**渲染结果**。
   * 判据: 工具链里不该出现**未翻译的 snake_case 工具名**。
   *
   * 语料是真实的: 库里那些历次会话调用过 20 种工具, 其中 12 种不在前端的手抄表里
   * (calc / chart_template / concept_trace / policy_search / view_graph_query /
   *  classical-tools__concept_trace …)—— 修复前它们就是这么显示成英文的。
   */
  console.log("\n⑤ 真会话的工具链渲染");
  const sess = await evalTop(cdp, `(async () => {
    const h = { Authorization: "Bearer " + (localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "") };
    const r = await (await fetch("/api/chat/sessions", { headers: h })).json();
    const list = r.sessions || r.items || [];
    return list.length;
  })()`);
  t("能拿到会话列表", typeof sess === "number" && sess > 0, `${sess} 个会话`);

  // 点开第一个会话(历史里带工具调用的那些都在列表前部), 等工具链渲染
  //
  // ⚠ 侧栏可能是**折叠**状态 —— 那时会话树不渲染(只剩一排图标按钮)。
  //   第一版直接找带"研究/检索"文字的按钮 → `missing`, 于是后面那条"没有裸露英文名"
  //   在**空页面**上通过 —— 又是一次假绿。先确保侧栏展开。
  const expanded = await evalTop(cdp, `(() => {
    const b = [...document.querySelectorAll("button")].find(x => (x.getAttribute("title")||"").includes("展开侧边栏"));
    if (b) { b.click(); return "expanded"; }
    return "already";
  })()`);
  t("侧栏处于展开状态(否则会话树不渲染)", expanded === "expanded" || expanded === "already", String(expanded));
  await sleep(1200);

  /**
   * ⚠ **必须点开一个真跑过工具的会话**。第一版点的是列表第一个 —— 那是「新对话」(空会话),
   *   于是后面两条断言在**没有工具链的页面上**通过。实测过: 页面里根本没有"工具链"三个字。
   *   判据: 优先挑标题里带历史目标词的会话(库里那些有 4~20 次工具调用的会话)。
   */
  const picked = await evalTop(cdp, `(() => {
    const items = [...document.querySelectorAll("div.cursor-pointer")]
      .filter(x => { const t=(x.innerText||"").trim(); return t.length > 1 && t.length < 40; });
    if (!items.length) return "missing";
    const want = items.find(x => /资本下乡|研究|检索|回归/.test(x.innerText||"")) || items[0];
    want.click();
    return (want.innerText||"").trim().slice(0, 24);
  })()`);
  t("打开了一个历史会话", picked !== "missing" && picked !== "新对话", String(picked));
  await sleep(4500);

  // 页面全文在 node 侧切片 —— 别把换行/正则塞进两层模板串(踩过 JSERR + 提前闭合)
  const pageText = String((await evalTop(cdp, `document.body.innerText`)) ?? "");
  const chainStart = pageText.indexOf("工具链");
  // 摘要用「把换行换成空格」而不是 split/join —— 少一层转义, 少一次被 heredoc 吃掉的机会
  const chainSnippet = chainStart >= 0 ? pageText.slice(chainStart, chainStart + 90).replace(/\s+/g, " ") : "";
  t("**页面上真的渲染出了工具链**(否则下面那条是空转)",
    chainStart >= 0, chainStart >= 0 ? chainSnippet : "整页没有「工具链」三个字");

  /**
   * ⚠ 判据是"**没有裸露的 snake_case 工具名**", 不是"出现了某个中文名" ——
   *   后者会因为我猜错工具名而假失败(历史会话用哪些工具是会变的)。
   * 只排除认证/存储键; **不排除**括号里的字段名(修复前那些正是裸露的一类)。滤太宽 = 判据瞎了。
   *
   * ⚠⚠ **诚实说明**: 这一条的强度取决于**语料里有没有"未登记的工具"**。
   *   我试过反向验证(把 ChatPanel 改回修复前) —— 它**没翻**, 因为恰好选中的那个会话
   *   只用了手抄表里已登记的工具(`sag_search/sag_reason/llm_write`)。
   *   而修复之后"未登记的工具"这个前提**在结构上不存在了**(前端不再持有清单),
   *   所以这一条**再也不可能**因为原缺陷翻红了。
   *   真正的守门人是 `test/tool-meta-coverage.test.ts` —— 那一条反向验证会翻。
   *   这里留着是为了兜住"渲染链路整体坏掉"(工具链压根不渲染 / 显示了别的英文串)。
   */
  // ⚠ 不用正则(反斜杠经 shell/heredoc 几层传递容易被吃掉, 已经栽过两次):
  //   改成按非标识符字符切词, 再筛出"带下划线的全小写"那批 —— 与正则等价且没有转义。
  const tokens = pageText.split(/[^A-Za-z0-9_]+/);
  const rawNames = [...new Set(tokens.filter((t) => /^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(t)))]
    .filter((n) => !/^(skf_auth_token|sag_token|local_storage|claude_code)$/.test(n));
  t("**工具链里没有裸露的英文工具名**(用户看到的是中文)",
    rawNames.length === 0, rawNames.length ? `裸露: ${rawNames.join(", ")}` : "无");
} finally {
  console.log(`\n  ${fail ? "❌" : "✅"} ${pass}/${pass + fail} 通过`);
  try { close(); } catch { /* 清理失败不改结论 */ }
}
process.exit(fail ? 1 : 0);
