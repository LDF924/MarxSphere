// scripts/verify-site-content.mjs — 站点内容页门禁: 四个 tab 真渲染 + 帮助条目的跳转真生效
//
// 由来（2026-09-15 用户报"站点内容需要全量更新"）：
//   这一页是**纯静态数据**驱动的(公告/帮助/条款/资源导航), 不接后端、不进单测,
//   于是内容停在 2026-09-06 也没人发现。更实际的问题是: 帮助里写"进入「科研工作台 DAG」"
//   但菜单实际叫「课题流程编排」—— 用户照着找不到入口, 而页面上没有任何可点的路径。
//   本次给帮助条目加了「前往对应工作台」按钮, 这个脚本把两件事钉住:
//     ① 换 tab 能切出对应内容(三个 tab 各自的关键字)
//     ② 帮助条目里的跳转按钮**真的把外壳切到目标视图**(不能是死按钮)
//
// 用法: node scripts/verify-site-content.mjs   (前置: 4173 已起)
import { startCdp, loginToken, sleep, verdict } from "./lib/cdp-editor.mjs";

const BASE = "http://127.0.0.1:4173";

async function main() {
  const { ev, cdp, close } = await startCdp({ preferredPort: 31031, label: "scripts/verify-site-content.mjs", tmpPrefix: "edge-site-content" });
  const results = [];
  try {
    const token = await loginToken();
    if (!token) { console.error("ERR 登录失败(admin/admin123)"); process.exit(1); }

    await cdp("Page.navigate", { url: `${BASE}/` });
    await sleep(3000);
    await ev(`localStorage.setItem('sag_token', ${JSON.stringify(token)}); true;`);
    await cdp("Page.navigate", { url: `${BASE}/#site-content` });
    await sleep(3500);

    /** 点某个 tab, 返回面板正文 */
    const openTab = async (label) => {
      await ev(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
        if (b) b.click();
        return !!b;
      })()`);
      await sleep(900);
      return ev(`document.body.innerText || ""`);
    };

    // ① 默认落在公告 tab, 且有本次更新的条目(09-15 安全审计)
    const announce = await ev(`document.body.innerText || ""`);
    results.push({
      name: "公告 tab: 渲染且含 09-15 新条目",
      pass: /2026-09-15/.test(announce) && /安全审计整改/.test(announce),
      detail: /2026-09-15/.test(announce) ? "命中 09-15" : "未见 09-15 条目",
    });

    // ② 帮助中心: 条目默认**折叠**(<details>), innerText 取不到正文 ——
    //    所以先展开再断言。不展开的话这个用例测的只是问题行, 答案写错也照样绿。
    const help = await openTab("帮助中心");
    results.push({
      name: "帮助 tab: 渲染",
      pass: /如何开始一个科研项目/.test(help),
      detail: /如何开始一个科研项目/.test(help) ? "命中首条" : "首条缺失",
    });

    /** 展开所有 <details>, 返回展开后的正文 */
    const expandHelp = async () => {
      await ev(`(() => {
        const all = [...document.querySelectorAll('details')];
        for (const d of all) d.open = true;
        return all.length;
      })()`);
      await sleep(700);
      return ev(`document.body.innerText || ""`);
    };
    const helpOpen = await expandHelp();
    results.push({
      name: "帮助 tab: 入口名与菜单一致(课题流程编排, 非旧名)",
      // 断言**正文里的入口名**(带书名号的完整串), 不能用 /科研工作台/ 这种宽匹配 ——
      // 面板顶部徽标就叫「科研工作台」, 三个 tab 都常驻, 宽匹配必然假红。
      pass: /「课题流程编排」/.test(helpOpen) && !/「科研工作台 DAG」/.test(helpOpen),
      detail: /「课题流程编排」/.test(helpOpen) ? "已对齐菜单名" : "展开后仍未找到新入口名",
    });

    // ③ 条款: 本轮补的安全事实在页面上
    const legal = await openTab("条款与隐私");
    results.push({
      name: "条款 tab: 含加密存储与开源许可事实",
      pass: /AES-256-GCM/.test(legal) && /AGPL-3\.0/.test(legal),
      detail: /AES-256-GCM/.test(legal) ? "命中" : "缺加密说明",
    });

    // ④ 资源导航: 医学类已清, 平台真接入的资源在
    const resources = await openTab("学术资源导航");
    results.push({
      name: "资源 tab: 无医学类残留 + 内置接入标注",
      pass: !/PubMed|生物医学/.test(resources) && /已内置接入/.test(resources),
      detail: /PubMed|生物医学/.test(resources) ? "仍有医学条目" : "干净",
    });

    // ⑤ 跳转真生效: 帮助页点「前往对应工作台」→ 外壳真的切视图。
    //    注意必须先**展开** —— 跳转按钮在折叠状态下根本没渲染进 DOM,
    //    上一版没展开就点, clicked=false 却因为 || 短路没暴露出来, 等于没测。
    await openTab("帮助中心");
    await expandHelp();
    const clicked = await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /前往对应工作台/.test(x.textContent || ''));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(1800);
    const after = await ev(`location.hash`);
    results.push({
      name: "帮助: 「前往对应工作台」真跳转",
      pass: clicked === true && /dag-workbench/.test(String(after)),
      detail: `点击=${clicked} → hash=${after}`,
    });

    // ⑥ 无 CDP 异常(ev 遇到页面异常会返回 "JSERR:...")
    const all = [announce, help, legal, resources].join("\n");
    results.push({ name: "无页面 JS 异常", pass: !/JSERR:/.test(all), detail: /JSERR:/.test(all) ? all.slice(all.indexOf("JSERR:"), all.indexOf("JSERR:") + 80) : "干净" });
  } finally {
    close();
  }
  verdict(results);
}

main().catch((e) => { console.error("ERR", e?.message || e); process.exit(1); });
