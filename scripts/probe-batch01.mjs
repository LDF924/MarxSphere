// probe-batch01.mjs — 批 1 + 批 0 的真浏览器回归
//
// 覆盖:
//   ①1.2 `/workflow` 重定向到第 1 步(不再掉进"模块建设中"占位页)
//   ②1.4 版本历史入口在**五页**都可达(此前只在第 5 步)
//   ③1.5 数据分析台入 shell 导航, 且能进到 Vue 统计台并渲染
//   ④1.1 交接内容在"没有项目"时不被吃掉(localStorage 还在)
//
// 为什么必须真浏览器: 这四条全是"路由/导航/存储"的运行时行为, 类型检查与静态断言照不到。
//   尤其 ④ —— 它此前是**静默丢数据**, 没有任何报错。
//
// ⚠ 2026-09-26 写这个探针时踩的两个坑(记下来免得重犯):
//   · **外壳初始 hash 为空时一个 iframe 都不挂**(实测 iframe 数 = 0) —— 必须先
//     `location.hash = "#paper-outline"` 把写作舱视图拉起来, 否则所有查询都是 NO_IFRAME。
//     第一版没做这一步, 10 条断言全红, 而我差点当成"代码改坏了"。
//   · 判据不能写成 `!body.includes(X)` 这种**否定式** —— 当 body 取不到(返回 JSERR 字符串)时
//     它恰好成立, 于是"占位页没渲染"这条会**假通过**。否定式断言必须先把"取不到"判掉。
//
// 用法: node scripts/probe-batch01.mjs   (需 4173 已起)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${n}${ex ? " — " + ex : ""}`); ok ? pass++ : fail++; };

const api = async (token, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.ok ? r.json().catch(() => ({})) : { __status: r.status };
};

const token = await loginToken("audit", "audit123456");
if (!token) { console.error("登录失败"); process.exit(1); }

let cdp, close;
try {
  ({ cdp, close } = await startCdp({ preferredPort: 31201, label: "probe-batch01", windowSize: "1440,900" }));

  await cdp("Page.navigate", { url: BASE });
  await sleep(2500);
  await evalTop(cdp, `localStorage.setItem("sag_token", ${JSON.stringify(token)}); localStorage.setItem("skf_auth_token", ${JSON.stringify(token)}); 1`);
  // ⚠ 必须先拉起写作舱视图: 外壳 hash 为空时不挂任何 iframe
  await evalTop(cdp, `(() => { location.hash = "#paper-outline"; return 1; })()`);
  await sleep(4000);

  const SOC = `document.querySelector('iframe[title^="研途写作舱"], iframe[src*="/soc/"]')`;
  /**
   * 在写作舱 iframe 里求值。
   * ⚠ expr 必须是**属性访问式或函数调用式**的表达式 —— 它的外围已经是
   *   `f.contentWindow.${expr}`, 所以:
   *     · `location.hash`            ✅
   *     · `document.querySelector(..)` ✅
   *     · `(document.body.innerText||"")` ❌ → 渲染成 `contentWindow.(...)` 直接语法错,
   *       evalTop 会把它包成 `"JSERR:SyntaxError..."` 字符串返回, 而**长度不为 0**,
   *       于是"正文长度 > 200"这类断言报错、而"不含某文案"这类**否定式**断言会**假通过**。
   *       第一版就是这么写的(正文长度恒 39), 我差点当成页面渲染坏了。
   *   要跑语句请用 runInSoc。
   */
  const inSoc = (expr) => evalTop(cdp, `(() => {
    const f = ${SOC};
    if (!f) return "NO_IFRAME";
    try { return String(f.contentWindow.${expr} ?? ""); } catch (e) { return "ERR:" + e.message; }
  })()`);
  /** 在 iframe 里执行一段**语句**(传函数体, 用 `w` 指代 window; 想取值就 `return` 出来) */
  const runInSoc = (body) => evalTop(cdp, `(() => {
    const f = ${SOC};
    if (!f) return "NO_IFRAME";
    try { const w = f.contentWindow; ${body} } catch (e) { return "ERR:" + e.message; }
  })()`);
  /** 正文文本 —— 走 runInSoc 才拿得到, 不能塞进 inSoc */
  const socText = () => runInSoc(`return (w.document.body.innerText || "");`);
  const goto = async (hash) => {
    // ⚠ 同 hash 时改 href **不会重载**, 只是改个 hash —— Vue 不会重新挂载视图,
    //   于是"刚写进 localStorage 的指针"永远不会被这一页读到。实测后果:
    //   连着两次 goto("/workflow/input") 时, 第二次是个空操作, 页面还停在第一次的状态。
    //   先弹到另一个路由再回来, 逼它真的重新挂载。
    const cur = await inSoc("location.hash");
    if (cur === `#${hash}` || cur.endsWith(hash)) {
      const bounce = hash === "/workflow/materials" ? "/workflow/input" : "/workflow/materials";
      await evalTop(cdp, `(() => { const f = ${SOC}; if (f) f.contentWindow.location.href = location.origin + "/soc/index.html#" + ${JSON.stringify(bounce)}; return 1; })()`);
      await sleep(1200);
    }
    await evalTop(cdp, `(() => {
      const f = ${SOC};
      if (!f) return "NO_IFRAME";
      f.contentWindow.location.href = location.origin + "/soc/index.html#" + ${JSON.stringify(hash)};
      return "ok";
    })()`);
    await sleep(2400);
  };

  // 前置: 写作舱 iframe 必须存在, 否则后面全是假失败
  const boot = await evalTop(cdp, `${SOC} ? "ok" : "NO_IFRAME"`);
  t("前置: 写作舱 iframe 已挂载", boot === "ok", `实测 ${boot}`);
  if (boot !== "ok") throw new Error("写作舱 iframe 没挂上, 后续断言无意义");

  console.log("\n═══ ① /workflow 重定向(1.2) ═══");
  {
    await goto("/workflow/input");
    const before = await inSoc("location.hash");
    t("前置: 能进 /workflow/input", before.includes("/workflow/input"), `实测 ${before}`);
    // 改 hash 到哨兵路径 `/workflow` —— 旧实现会命中 PlaceholderView
    await runInSoc(`w.location.hash = "#/workflow"; return "set";`);
    await sleep(2000);
    // ⚠ 重定向后 Vue 会重新挂载 input 视图; 立刻取 innerText 会拿到**空 body**。
    //   所以要等页面真的渲染出内容再断言, 否则"没有模块建设中"这句恒真 —— 假通过。
    let body = "";
    for (let i = 0; i < 10; i++) {
      await sleep(1200);
      body = await socText();
      if (body.length > 200) break;
    }
    const hash = await inSoc("location.hash");
    t("/workflow 重定向到 /workflow/input", hash.includes("/workflow/input"), `实测 hash=${hash}`);
    t("选题界定页真的渲染出来了", body.length > 200, `正文长度=${body.length}`);
    t("不含「模块建设中」占位文案", body.length > 200 && !body.includes("模块建设中"), `正文长度=${body.length}`);
  }

  console.log("\n═══ ② 版本历史入口五页可达(1.4) ═══");
  {
    const p = await api(token, "/research/projects", "POST", { title: `探针版本-${Date.now()}`, status: "active" });
    const pid = (p?.data ?? p)?.id ?? p?.project?.id;
    await api(token, `/research/projects/${pid}/nodes/input`, "PUT", {
      payload: { input: { title: "版本入口探针", outline: "一、引言", totalWordCount: 5000, researchMethod: "qualitative", requirements: "", sampleFiles: [] } },
    });
    await evalTop(cdp, `localStorage.setItem("lastTask_workflow", ${JSON.stringify(String(pid))}); 1`);

    for (const [hash, name] of [["/workflow/input", "选题界定"], ["/workflow/sections", "框架设计"], ["/workflow/materials", "文献与资料"], ["/workflow/workspace", "章节写作"], ["/workflow/finalize", "统稿定稿"]]) {
      await goto(hash);
      // 入口按钮只在 store.taskId 有值时才渲染 —— 项目刚建, 要给它时间 loadProject。
      // 轮询等它出现; 一直不出现才判失败。
      let got = "missing";
      for (let i = 0; i < 10; i++) {
        got = await inSoc(`document.querySelector('[data-control="workflow:version-history"]') ? "found" : "missing"`);
        if (got === "found") break;
        await sleep(1000);
      }
      t(`${name}页有版本历史入口`, got === "found", `实测 ${got}`);
    }
    await api(token, `/research/projects/${pid}`, "DELETE").catch(() => null);
  }

  console.log("\n═══ ③ 数据分析台进导航(1.5) ═══");
  {
    // ⚠ 导航项在**折叠的分类下拉**里 —— 展开之前 DOM 里根本没有它, 所以"未展开就找不到"
    //   是**设计如此**, 不是缺陷。第一版把这条写成断言, 恒红; 而我差点当成入口没生效。
    //   正确的验法是: 展开 → 点它 → 看是否真的到了统计台。
    const opened = await evalTop(cdp, `(() => {
      const trig = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim().startsWith("科研中心"));
      if (!trig) return "no-trigger";
      trig.click();
      return "clicked";
    })()`);
    t("能展开「科研中心」分组", opened === "clicked", `实测 ${opened}`);
    await sleep(900);

    const clicked = await evalTop(cdp, `(() => {
      const els = [...document.querySelectorAll("button,a,li,div,span")];
      // 取**最内层**匹配项: 外层容器也跟着含这段文字, 点它会落空
      const hits = els.filter((e) => (e.textContent || "").trim() === "数据分析台");
      const hit = hits[hits.length - 1];
      if (!hit) return "no-item";
      hit.click();
      return "clicked";
    })()`);
    t("导航项可点", clicked === "clicked", `实测 ${clicked}`);
    await sleep(5000);

    const r = await evalTop(cdp, `(() => {
      const f = document.querySelector('iframe[title^="数据分析台"]');
      if (!f) return JSON.stringify({ found: false, h: "", len: 0 });
      try { return JSON.stringify({ found: true, h: String(f.contentWindow.location.hash), len: (f.contentWindow.document.body.innerText || "").length }); }
      catch (e) { return JSON.stringify({ found: true, h: "ERR:" + e.message, len: 0 }); }
    })()`);
    const o = JSON.parse(String(r));
    t("外壳挂上了「数据分析台」iframe", o.found === true, `实测 ${r}`);
    t("落在 /soc/#/statistics", String(o.h).includes("/statistics"), `实测 hash=${o.h}`);
    t("统计台真的渲染出内容(不是空白)", o.len > 100, `正文长度=${o.len}`);
  }

  console.log("\n═══ ④ 无项目时不吞掉交接素材(1.1) ═══");
  {
    // 回到写作舱视图(③ 把 hash 换到 statistics 了)
    await evalTop(cdp, `(() => { location.hash = "#paper-outline"; return 1; })()`);
    await sleep(3500);
    /**
     * ⚠ 必须让 **store 真正没有 taskId**, 否则验不到那个分支。
     *   前几节建过项目, pinia store 里还留着指针 —— 只清 localStorage 没用
     *   (指针在内存里), 得**整帧重载**让 store 重新初始化。
     *   第一版没做这步: 走了"有项目 → 导入成功"的分支, localStorage 被 commit 删掉,
     *   我却把这当成"守卫生效"的反面 —— 其实是**前提不成立**, 不是代码错。
     */
    await runInSoc(`w.localStorage.removeItem("lastTask_workflow"); return "cleared";`);
    await evalTop(cdp, `(() => { ${SOC}.contentWindow.location.reload(); return 1; })()`);
    await sleep(6000);
    const noTask = await runInSoc(`return w.localStorage.getItem("lastTask_workflow") ? "has-task" : "no-task";`);
    t("前置: 整帧重载后没有任务指针", noTask === "no-task", `实测 ${noTask}`);

    const seeded = await runInSoc(`w.localStorage.setItem("skf_wf_handoff", JSON.stringify({ kind: "review", title: "探针素材", markdown: "探针内容", at: 1 })); return "seeded";`);
    t("前置: 交接内容已写入", seeded === "seeded", `实测 ${seeded}`);

    // 进资料页 → 触发 importExternalMaterials 的"没有 taskId"分支
    await goto("/workflow/materials");
    /**
     * ⚠ toast 只活 **3.2 秒**(shared/ui.ts 的默认 duration), 而 goto 本身要等 2.4s,
     *   等我再查一次就早没了 —— 第二版就是这么误判的(实测 no, 其实提示弹过)。
     *   改成进入后**立刻轮询**捕获, 并且同时盯 localStorage:
     *   提示消失 ≠ 守卫生效, 两件事要分开看。
     */
    let hinted = "no", left = "kept";
    for (let i = 0; i < 20; i++) {
      const snap = await runInSoc(`
        return JSON.stringify({
          t: (w.document.body.innerText || "").includes("先在「选题界定」创建项目") ? "yes" : "no",
          v: w.localStorage.getItem("skf_wf_handoff") ? "kept" : "gone",
        });
      `);
      try { const o = JSON.parse(snap); hinted = o.t; left = o.v; } catch { /* 忽略瞬时读失败 */ }
      if (hinted === "yes") break;
      await sleep(400);
    }
    t("没有项目时交接内容仍保留(不被吃掉)", left === "kept", `实测 localStorage=${left}`);

    /**
     * ⚠ 光看 localStorage 还在**不够** —— 这条断言会**假通过**:
     *   我第一版把 `claimed` 的声明删漏了(只留引用), `claimHandoff()` 一进来就抛
     *   ReferenceError, 该函数**根本没往下跑**, localStorage 自然没被碰。
     *   于是"内容还在"成立, 而真实行为是"整条导入链完全没工作"。
     *   这条**正向**断言(用户必须看到"先去建项目"的提示)才是真正的判据 ——
     *   它只在代码真的执行到那个分支时才出现。
     */
    t("用户拿到了「先去建项目」的提示(证明代码真的执行了)", hinted === "yes", `实测 ${hinted}`);

    await runInSoc(`w.localStorage.removeItem("skf_wf_handoff"); return "cleaned";`);
  }

  console.log("\n═══ ⑤ 无 JS 错误 ═══");
  {
    const errs = await evalTop(cdp, `JSON.stringify((window.__verifyErrs || []).slice(0, 3))`);
    t("顶层无未捕获错误", errs === "[]", String(errs).slice(0, 200));
  }
} finally {
  try { close?.(); } catch { /* 忽略 */ }
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
