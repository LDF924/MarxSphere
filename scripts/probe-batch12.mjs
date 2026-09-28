// probe-batch12.mjs — 素材弹层对齐参考产品(图 1–9 里真正值得补的那几项)
//
// 覆盖:
//   ① 「添加表格」弹层: 红字提示「表格请用 Tab 键分隔各列」+ 示例块 + 占位符
//   ② 「添加理论」弹层: 「支持 Markdown 格式」提示 + Markdown 说明块 + 占位符
//   ③ 手动添加弹层的**关联章节下拉** —— 这是本批实质性的一条: 原来保存时**偷偷挂到第一章**,
//      用户改不了。探针不看 DOM 有没有下拉, 而是**选一个非第一章的章节 → 保存 → 查库**
//      (判据是落库的 section_ids, 不是界面上显示什么)。
//   ④ 保存按钮在**未选章节**时禁用(参考产品图 2/3 的禁用态)
//   ⑤ 弹层拖拽: 整卡可拖 / 拖不出视口 / 不吃掉表单控件(2026-09-28 用户反馈后补)
//   ⑥ 附件体积上限: 真造一个接近**界面承诺上限**的文件走完整上传(2026-09-28 用户反馈后补; 上限 100MB 时测 99MB)
//   ⑦ 单条文献录入: 「解析引用」把整条引用拆进字段; GB/T 引用格式与摘要两个字段真的存进 references[]
//
// ⚠ **不烧模型**: 全程只做"填表 → 保存 → 上传", 没有任何 LLM 调用。
//
// 用法: node scripts/probe-batch12.mjs   (需 4173 已起, 产物已重建)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { writeFileSync, statSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openSoc } from "./lib/probe-actions.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${n}${ex ? " — " + ex : ""}`); ok ? pass++ : fail++; };

const api = async (token, path_, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path_}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/** 读 .env 拿库连接(与 probe-batch10 同款: 从当前文件往上找) */
function databaseUrl() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const p = path.join(dir, ".env");
    try {
      const line = readFileSync(p, "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
      if (line) return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
    } catch { /* 继续往上 */ }
    dir = path.dirname(dir);
  }
  return process.env.DATABASE_URL || "";
}

const token = await loginToken();
if (!token) { console.error("登录失败: 4173 未起或缺 verify 账号"); process.exit(1); }

// ── 自建一个带 ≥2 章节的项目 ──
// ⚠ 不要"从已有项目里挑一个": verify 账号下通常是空的(项目属于 admin), 挑法在 CI 上必然落空。
//   自建同时还顺手把**章节顺序**握在自己手里 —— 才能区分"选了第二个章节"与"默认第一个"。
const projRes = await api(token, "/research/projects", "POST", { title: `批12素材弹层-${Date.now()}`, status: "active" });
const projectId = (projRes.body?.data ?? projRes.body)?.id ?? projRes.body?.project?.id ?? "";
t("前置: 建得出测试项目", !!projectId, `pid=${projectId}`);
if (!projectId) {
  console.log(`\n  ❌ ${pass}/${pass + fail} 通过（建项目失败, 无法继续）`);
  process.exit(1);
}
const seed = await api(token, `/research/projects/${projectId}/nodes/sections/merge`, "PATCH", {
  patch: {
    sections: [
      { id: "p12s1", title: "第一章", level: 1, content: "内容".repeat(20) },
      { id: "p12s2", title: "第二章", level: 1, content: "内容".repeat(20) },
    ],
  },
});
t("前置: 两个章节种进去了", seed.status < 300, `status=${seed.status}`);
const firstSecId = "p12s1";
const secondSecId = "p12s2";

const tmpDir = mkdtempSync(path.join(tmpdir(), "probe12-"));
const { cdp, close } = await startCdp({ preferredPort: 9361, label: "batch12" });
try {
  await openSoc(cdp, BASE, "/workflow/materials", token, projectId, 9000);
  // 关掉可能挡路的助手面板
  await evalTop(cdp, `(() => { document.querySelectorAll('.assistant-close,.modal-x').forEach(b => b.click()); return true; })()`);
  await sleep(700);

  /** 打开某个手动添加弹层(点页面自己的按钮) */
  const openManual = async (control) => {
    await evalTop(cdp, `(() => { document.querySelectorAll('.modal-mask .modal-x').forEach(b => b.click()); return true; })()`);
    await sleep(500);
    const ok = await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="${control}"]'); if (!b) return false; b.click(); return true; })()`);
    await sleep(900);
    return ok === true;
  };
  const readDialog = async () => evalTop(cdp, `(() => {
    const box = document.querySelector('.modal-mask .modal-card');
    if (!box) return null;
    const hint = box.querySelector('.f-hint-warn');
    const sel = box.querySelector('select');
    return {
      title: (box.querySelector('h3')?.innerText || '').trim(),
      hint: hint ? (hint.innerText||'').trim() : '',
      placeholder: (box.querySelector('textarea')?.getAttribute('placeholder') || ''),
      example: (box.querySelector('.f-example')?.innerText || '').trim(),
      hasSectionSelect: !!sel,
      sectionOptions: sel ? [...sel.querySelectorAll('option')].map(o => (o.innerText||'').trim()) : [],
      sectionValue: sel ? sel.value : null,
      saveDisabled: !!box.querySelector('[data-control="workflow:save-manual"]')?.disabled,
      hasGbRef: !!box.querySelector('input[placeholder^="GB/T"]'),
      hasAbstract: !!box.querySelector('input[placeholder^="摘要"]'),
      hasParseBtn: !!box.querySelector('[data-control="workflow:parse-one-ref"]'),
    };
  })()`);

  // ── ① 添加表格 ──
  console.log("\n① 添加表格弹层");
  if (await openManual("workflow:manual-table")) {
    const d = await readDialog();
    t("「表格请用 Tab 键分隔各列」提示在(参考产品图 2 的红字)", (d?.hint || "").includes("Tab 键分隔各列"), d?.hint ?? "");
    t("占位符是「粘贴表格数据（用 Tab 键分隔各列）」", (d?.placeholder || "").includes("Tab 键分隔各列"), d?.placeholder ?? "");
    t("示例块三行内容在", (d?.example || "").includes("2020") && (d?.example || "").includes("52%"), (d?.example || "").split("\n")[0] ?? "");
    t("关联章节下拉在", d?.hasSectionSelect === true, JSON.stringify(d?.sectionOptions?.slice(0, 3)));
    t("保存按钮**默认可用**(章节已默认选中第一章, 不挡原有操作)",
      d?.saveDisabled === false && d?.sectionValue === firstSecId, `disabled=${d?.saveDisabled} value=${d?.sectionValue}`);
    // 改成"未选" → 保存必须禁用(参考产品图 2 的禁用态)
    await evalTop(cdp, `(() => {
      const sel = document.querySelector('.modal-mask .modal-card select');
      if (!sel) return false;
      sel.value = '';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    const d2 = await readDialog();
    t("清空章节后保存按钮变禁用", d2?.saveDisabled === true, `disabled=${d2?.saveDisabled}`);
  } else {
    t("打开「添加表格」弹层", false, "入口不存在");
  }

  // ── ② 添加理论 ──
  console.log("\n② 添加理论弹层");
  if (await openManual("workflow:manual-theory")) {
    const d = await readDialog();
    t("「支持 Markdown 格式」提示在", (d?.hint || "").includes("支持 Markdown 格式"), d?.hint ?? "");
    t("占位符提到理论框架/概念定义", (d?.placeholder || "").includes("理论框架") || (d?.placeholder || "").includes("概念定义"), d?.placeholder ?? "");
    t("Markdown 说明块含加粗/标题/引用三行",
      (d?.example || "").includes("加粗") && (d?.example || "").includes("标题层级") && (d?.example || "").includes("引用"),
      (d?.example || "").replace(/\n/g, " | ").slice(0, 90));
    t("表格那条提示**不**出现在理论弹层(条件是按类型走的)",
      !(d?.hint || "").includes("Tab"), d?.hint ?? "(空)");
  } else {
    t("打开「添加理论」弹层", false, "入口不存在");
  }

  // ── ③ 章节真的落库(本批实质) ──
  console.log("\n③ 手动添加的章节归属真的落库");
  if (await openManual("workflow:manual-table")) {
    // 选**第二个**章节(不是默认的第一个) —— 这样"真改了"与"还是默认"能区分开
    /**
     * ⚠ 这里的 `\\t` / `\\n` 是**双反斜杠, 不能省**。
     *
     * 踩过(2026-09-28): 写成单反斜杠 `\t`/`\n` 时, 是**外层模板字符串**先把它解释成
     * 真正的制表符与**换行** —— 那个换行落进内层单引号 JS 字符串里, 就是
     * `'年份<TAB>大型企业<真换行>2020…'` ⇒ **语法错误**。
     * 而 `evalTop` 遇到页面侧的语法/运行时错误是**返回 `"JSERR:…"` 而不是抛出**
     * (见 cdp-editor.mjs 的实现) —— 于是这次调用"成功"返回、填充一个字都没发生,
     * 下游只看到"填了保存按钮却是灰的 / toast 说请填写标题", 看着像产品坏了。
     * 症状与真正的产品缺陷**长得一模一样**, 所以诊断信息里必须带上 `fillRet`。
     */
    const fillRet = await evalTop(cdp, `(() => {
      const box = document.querySelector('.modal-mask .modal-card');
      if (!box) return 'NO_MODAL';
      const sel = box.querySelector('select');
      if (!sel) return 'NO_SELECT';
      sel.value = ${JSON.stringify(secondSecId)};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const inputs = box.querySelectorAll('input');
      const set = (el, v) => { if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
      set(inputs[0], 'probe12-章节归属');
      set(box.querySelector('textarea'), '年份\\t大型企业\\n2020\\t45%');
      // 返回值带上"填完那一刻"的实况 —— 下一步若发现没填上, 就能立刻分辨是"没填进去"还是"被重置了"
      return JSON.stringify({
        sel: sel.value,
        titleVal: inputs[0]?.value ?? null,
        opts: [...sel.querySelectorAll('option')].map(o => o.value),
      });
    })()`);
    await sleep(600);
    const before = await api(token, `/research/materials?projectId=${encodeURIComponent(projectId)}`);
    const nBefore = (before.body?.materials ?? []).length;
    /**
     * 保存前的**实况快照** —— 这一行是诊断, 不是装饰。
     * 第一版这里直接点保存, 结果"素材没存下来"(toast=「请填写标题」), 而单跑同样的动作却能存。
     * 两处差异必须看得见才能定位: 弹层里有几个 input、**分别是谁**(靠 placeholder 认)、
     * 章节选中的是谁、保存按钮禁没禁。只报"没存上"等于没查。
     */
    const preSave = await evalTop(cdp, `(() => {
      const box = document.querySelector('.modal-mask .modal-card');
      if (!box) return null;
      return {
        selectValue: box.querySelector('select')?.value ?? null,
        inputs: [...box.querySelectorAll('input')].map(x => ({ ph: x.placeholder || '', v: x.value })),
        textarea: box.querySelector('textarea')?.value ?? null,
        saveDisabled: !!box.querySelector('[data-control="workflow:save-manual"]')?.disabled,
        modalCount: document.querySelectorAll('.modal-mask').length,
      };
    })()`);
    await evalTop(cdp, `(() => { document.querySelector('[data-control="workflow:save-manual"]')?.click(); return true; })()`);
    await sleep(2200);
    const toastText = (await evalTop(cdp, `(() => {
      const t = [...document.querySelectorAll('div')].filter(d => ((d.getAttribute('style')||'').includes('fixed')));
      return t.map(d => (d.innerText||'').split('\\n')[0].trim()).filter(Boolean).join(' | ').slice(0, 120);
    })()`)) || "";
    const after = await api(token, `/research/materials?projectId=${encodeURIComponent(projectId)}`);
    const list = after.body?.materials ?? [];
    const made = list.find((m) => String(m.title ?? "").includes("probe12-章节归属"));
    t("素材真的存下来了", !!made && list.length > nBefore,
      `before=${nBefore} after=${list.length} 填充=${fillRet} 保存前=${JSON.stringify(preSave)} toast=「${toastText}」`);
    const ids = made ? (Array.isArray(made.sectionIds) ? made.sectionIds : made.sectionId ? [made.sectionId] : []) : [];
    t("**落库的章节是选中的那一个**(不是默认第一章)", ids.length > 0 && ids[0] === secondSecId,
      `落库=${JSON.stringify(ids)} 期望=${secondSecId} 第一章=${firstSecId}`);
    if (made) { await api(token, `/research/materials/${made.id}`, "DELETE").catch(() => {}); }
  } else {
    t("打开发表弹层做章节归属验证", false, "入口不存在");
  }

  // ── ④/⑤ 单条文献录入 ──
  console.log("\n④ 单条文献: 解析引用 / GB 引用 / 摘要");
  if (await openManual("workflow:manual-literature")) {
    const d = await readDialog();
    t("有「粘贴完整引用」框与「解析引用」按钮", d?.hasParseBtn === true);
    t("有 GB/T 引用格式字段", d?.hasGbRef === true);
    t("有 摘要/备注 字段", d?.hasAbstract === true);
    // 真填一条: 用 raw 驱动「解析引用」, 再看字段是否被填上
    await evalTop(cdp, `(() => {
      const ta = document.querySelector('.modal-mask .modal-card .rf-raw');
      if (!ta) return false;
      ta.value = '张三, 李四. 数字化转型研究[J]. 管理世界, 2023, 35(1): 1-10.';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);    await sleep(400);
    await evalTop(cdp, `(() => { document.querySelector('[data-control="workflow:parse-one-ref"]')?.click(); return true; })()`);
    await sleep(900);
    const parsed = await evalTop(cdp, `(() => {
      const box = document.querySelector('.modal-mask .modal-card');
      const ins = [...box.querySelectorAll('.rf-grid input, .rf-in.full')];
      return ins.map(x => x.value).filter(Boolean);
    })()`);
    t("「解析引用」把整条引用拆进了字段", Array.isArray(parsed) && parsed.length >= 2,
      JSON.stringify(parsed));
  } else {
    t("打开「手动添加文献」弹层", false, "入口不存在");
  }

  /**
   * ── ⑤ 弹层拖拽(2026-09-28 用户反馈后改的三处) ─────────────────────────────
   *
   * 用户原话:「弹出来的卡片**不能全部任意位置**放置鼠标进行拖拽」。
   * 实测确实是: 拖拽只挂在标题栏上, 而卡片里**大面积是文字** —— 在正文上按住, 一点反应都没有。
   *
   * 这一组同时锁住三件事, 每一条都对应一个真实故障:
   *   ① 正文上也能拖(原来只能拖标题栏);
   *   ② **拖不出去** —— 原来能拖到标题栏跑出视口, 而卡片比视口高时**再也抓不回来**(实测过);
   *   ③ 表单控件没被拖拽吃掉 —— 放宽到整卡可拖最容易误伤的就是它。
   *
   * ⚠ 还有一条不靠断言、靠**第 ② 步的副作用**验到: 拖到卡片**外面**松手时,
   *   浏览器把 click 派发到共同祖先 `.modal-mask`, 而 `@click.self` 会判定"点了遮罩" →
   *   **弹层自己关了**。所以第 ② 步拖完之后卡片还在不在, 本身就是一条判据。
   */
  console.log("\n⑤ 弹层拖拽: 整卡可拖 / 拖不出视口 / 不吃掉控件");
  if (await openManual("workflow:manual-table")) {
    const mouse = (ty, x, y, extra = {}) => cdp("Input.dispatchMouseEvent", { type: ty, x, y, ...extra });
    const cardBox = () => evalTop(cdp, `(() => {
      const c = document.querySelector('.modal-mask .modal-card');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    const dragFrom = async (x, y, dx, dy) => {
      await mouse("mousePressed", x, y, { button: "left", clickCount: 1 });
      await sleep(90);
      await mouse("mouseMoved", x + dx, y + dy, { button: "left", buttons: 1 });
      await sleep(90);
      await mouse("mouseReleased", x + dx, y + dy, { button: "left" });
      await sleep(450);
    };

    const b0 = await cardBox();
    if (b0) {
      // ① 在一个**非控件**的正文点按住拖(红字提示那行只是一句话, 没有交互)
      const grab = await evalTop(cdp, `(() => {
        const el = document.querySelector('.modal-mask .modal-card .f-hint-warn');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      t("前置: 找得到正文里的非控件抓取点", !!grab, grab ? JSON.stringify(grab) : "没找到 .f-hint-warn");
      if (grab) {
        await dragFrom(grab.x, grab.y, 110, 36);
        const b1 = await cardBox();
        t("① 在**正文**上拖也能动(不再只有标题栏)", !!b1 && (b1.x !== b0.x || b1.y !== b0.y),
          b1 ? `位移 dx=${b1.x - b0.x} dy=${b1.y - b0.y}` : "卡片没了");
      }

      // ② 往左上猛拖 —— 必须被钳住, 且标题栏要留在视口里
      const b2 = (await cardBox()) ?? b0;
      await dragFrom(b2.x + b2.w / 2, b2.y + 18, -b2.x - 200, -b2.y - 200);
      const b3 = await cardBox();
      const vh = await evalTop(cdp, "innerHeight");
      t("② 往左上猛拖后**标题栏仍在视口内**(抓手够得着)",
        !!b3 && b3.y >= 0 && b3.y < Number(vh) - 40, b3 ? `卡片 y=${b3.y} / 视口高 ${vh}` : "卡片没了");
      //    ← 卡片还在 = "拖到卡片外松手"没有被误判成"点遮罩关闭"
      t("② 拖到卡片**外**松手不会把弹层关掉(click.self 误判)",
        !!b3, b3 ? "卡片仍在" : "弹层被误关了");

      // ③ 表单控件没被当成抓手
      const before = await cardBox();
      const selPt = await evalTop(cdp, `(() => {
        const el = document.querySelector('.modal-mask .modal-card select');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (before && selPt) {
        await dragFrom(selPt.x, selPt.y, 70, 50);
        const after = await cardBox();
        t("③ 在「关联章节」下拉上拖**不会**把卡片拖走(控件仍可用)",
          !!after && after.x === before.x && after.y === before.y,
          after ? `位移 dx=${after.x - before.x} dy=${after.y - before.y}` : "卡片没了");
      } else {
        t("③ 找得到表单控件做这条断言", false, "没找到 select");
      }
    }
    await evalTop(cdp, `(() => { document.querySelectorAll('.modal-mask .modal-x').forEach(b => b.click()); return true; })()`);
    await sleep(400);
  } else {
    t("打开弹层做拖拽断言", false, "入口不存在");
  }

  /**
   * ── ⑥ 体积上限: 界面承诺多少, 就得真能传多少 ──────────────────────────────
   *
   * ⚠ 这条是**补出来的**, 来自一个真实投诉: 用户传 25MB 附件被拒, 界面说
   *   「文件解析失败(不支持的类型?)」—— 把"太大"报成了"格式不对"。
   *
   * 根因不在前端也不在格式, 而在**两条独立的限制没对齐**:
   *   ① 前端按 25MB 放行(界面副标题也写 25MB);
   *   ② 文件走 JSON+base64 上传, base64 把体积撑到 **4/3 倍** ⇒ 25MB 文件 = 33.3MB 请求体;
   *   ③ Fastify 全局 `bodyLimit` 当时是 **30MB** ⇒ 请求体在**读完之前**就被拒, 客户端
   *      拿到的是 ECONNRESET 而不是一个 4xx。实测天花板: 22MB(29.3MB)过, 23MB(30.7MB)挂。
   *
   * 所以这里**真的造一个接近上限的文件**再走一次真 UI —— 而不是断言"文案写着 25MB"。
   * 判据用 24.9MB(留一点余量给 PDF 自身头部/尾部的开销, 免得把"刚好超一点"测成假失败)。
   */
  console.log("\n⑥ 附件体积上限: 接近 25MB 的文件真能传");
  const bigPath = path.join(tmpDir, "probe12-big.pdf");
  {
    // 手搓一个最小合法 PDF 并填充到目标体积(PDF 忽略 `%` 注释行, 所以填充是合法的)
    // ⚠ 这里要跟着**界面上承诺的上限**走: 界面写 100MB 就测 ~99MB。
    //   测一个远低于上限的文件是**证明不了**那条承诺的(我第一版就是测 24.9MB,
    //   而当时上限是 25MB —— 那还没问题; 上限涨到 100MB 之后再测 24.9MB 就成了空断言)。
    const padBytes = Math.floor(99 * 1024 * 1024);
    const body = Buffer.from("BT /F1 14 Tf 20 100 Td (Hello PDF) Tj ET");
    const pad = Buffer.concat([Buffer.from("%"), Buffer.alloc(Math.max(0, padBytes - body.length - 20), 0x78), Buffer.from("\n")]);
    const stream = Buffer.concat([body, Buffer.from("\n"), pad]);
    const objs = [
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
      `4 0 obj<</Length ${stream.length}>>stream\n`,
      "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
    ];
    const parts = [Buffer.from("%PDF-1.4\n")];
    const offsets = [];
    for (const [i, o] of objs.entries()) {
      offsets.push(parts.reduce((n, p) => n + p.length, 0));
      parts.push(Buffer.from(o));
      if (i === 3) { parts.push(stream, Buffer.from("\nendstreamendobj\n")); } else { parts.push(Buffer.from("\n")); }
    }
    const bodyLen = parts.reduce((n, p) => n + p.length, 0);
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
    xref += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${bodyLen}\n%%EOF\n`;
    parts.push(Buffer.from(xref));
    writeFileSync(bigPath, Buffer.concat(parts));
  }
  const bigMB = (statSync(bigPath).size / 1024 / 1024).toFixed(1);
  t(`前置: 造出 ${bigMB}MB 的样本文件(贴近界面承诺的 100MB)`, statSync(bigPath).size > 95 * 1024 * 1024, `${bigMB}MB`);

  const bigProj = await api(token, "/research/projects", "POST", { title: `批12体积-${Date.now()}`, status: "active" });
  const bigPid = (bigProj.body?.data ?? bigProj.body)?.id ?? bigProj.body?.project?.id ?? "";
  await api(token, `/research/projects/${bigPid}/nodes/sections/merge`, "PATCH", { patch: { sections: [{ id: "b1", title: "第一章", level: 1 }] } });
  await openSoc(cdp, BASE, "/workflow/materials", token, bigPid, 9000);
  await evalTop(cdp, `(() => { document.querySelectorAll('.assistant-close,.modal-x').forEach(b => b.click()); return true; })()`);
  await sleep(700);
  const { root: bigRoot } = await cdp("DOM.getDocument", { depth: -1 });
  const bigInput = await cdp("DOM.querySelector", { nodeId: bigRoot.nodeId, selector: 'input[type=file][accept*=".docx"]' });
  // 不 await: 大文件时这个 CDP 调用可能很久, 但页面已经在处理了
  cdp("DOM.setFileInputFiles", { files: [bigPath], nodeId: bigInput.nodeId }).catch(() => {});
  let bigOk = "";
  for (let i = 1; i <= 30; i++) {
    await sleep(3000);
    const m = await api(token, `/research/materials?projectId=${encodeURIComponent(bigPid)}`);
    const hit = (m.body?.materials ?? []).find((x) => String(x.title ?? "").includes("probe12-big"));
    if (hit) { bigOk = `落库成功(${String(hit.contentMd ?? "").length} 字)`; break; }
  }
  t(`接近上限(${bigMB}MB)的附件真能传上去`, !!bigOk, bigOk || "90 秒内没有落库 —— 很可能撞上了 bodyLimit 或内存");
} finally {
  console.log(`\n  ${fail ? "❌" : "✅"} ${pass}/${pass + fail} 通过`);
  try { close(); } catch { /* 清理失败不改结论 */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
}
process.exit(fail ? 1 : 0);
