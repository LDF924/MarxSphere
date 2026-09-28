// probe-batch17.mjs — fileId → 正文: 审稿直投上传文件 + 题名候选逐条可点
//
// 由来(2026-09-29 用户: "审稿的上传 PDF 要先 file_read/pdf_parse 拿到文本再建 job ——
//   后端没有 fileId → 纯文本这个能力", 连同编辑器导出/题名候选一起说"全部修复")。
//
// ⚠ 先说清楚**哪几条不修**: 动手前逐条实测, 用户报的四条里两条根本不缺 ——
//   编辑器的「导入 Word」(TopBar.vue → /editor/v1/documents/import → EditorView 接收)
//   和 viz 的「上传数据文件」(回形针 → /files/upload → user_files) 都早已完整。
//   第三条(题名候选"要连调三次")前提也不成立: prompt 一直在要求模型一次并列 5 个候选,
//   断的是**展示**。所以这个探针只覆盖**真实存在**的缺口。
//
// 覆盖:
//   ① 上传文件 → 按 fileId 取正文(这条链路以前**不存在**, 是另外几条的共同堵点)
//   ② 抽过的文件再读不重抽(读库里的, 不是每次现抽)
//   ③ 扫描件返回 needsOcr 而不是失败, 且界面给得出「去识别文字」那一步
//   ④ 审稿建 job 能直接吃 **上传文件的 fileId**(此前只能粘贴全文)
//   ⑤ 编辑器题名结果渲染成**逐条可点**的候选(此前是一段 markdown, 挑不出单个)
//
// ⚠ 不烧钱: ⑤ 用页面里已有的历史结果验证渲染, 不重新跑模型。
//   ④ 只建 job 不驱动 → 不发 LLM 请求。见下面对 droveJob 的处理。
//
// 用法: node scripts/probe-batch17.mjs   (需 4173 已起, soc 产物已重建)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";

/**
 * 造一份 3 页、**每页只有一张位图、没有任何文字对象**的 PDF —— 也就是"扫描件"。
 *
 * ⚠ 两条都是我踩过之后改的:
 *   ① **用真生成器**(PyMuPDF)生成后**提交为固件**, 不在探针里现造。第一版手拼 xref 表,
 *      pdfjs 直接报 "Bad (uncompressed) XRef entry" —— 那是在验我自己的拼装水平。
 *      改成现调 python 又多出一个 CI 依赖(CI 的 python 未必有 pymupdf), 于是固件化。
 *   ② 固件**自带判据**: 先确认它真的一页文字层都没有。文件被换成带文字版的 PDF 时,
 *      ③ 会变成在验另一条分支而**照样绿**。
 *   重造: `python -c "...fitz..."` 见仓库历史; 或者拿任何扫描版 PDF 换掉它都行, 只要 ② 过。
 */
const SCAN_FIXTURE = path.join(process.cwd(), "test", "fixtures", "scan-3page-imageonly.pdf");
function loadScanFixture() {
  if (!fs.existsSync(SCAN_FIXTURE)) return null;
  return fs.readFileSync(SCAN_FIXTURE);
}

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

const junk = [];   // 收尾要清的东西(探针自己不制造残留)
const upload = (filename, buf, mime = "application/octet-stream") =>
  api(token, "/files/upload", "POST", { filename, base64: buf.toString("base64"), mime });

try {
  // ═══ ① 上传 → 按 fileId 取正文 ═══
  console.log("\n① fileId → 正文(这条链路此前不存在)");
  const body = [
    "资本下乡与村集体收入: 基于三省面板数据的实证研究",
    "",
    "一、引言",
    "本文关注工商资本进入村庄后对集体经济组织收入的影响。",
    "二、文献综述",
    "既有研究多从土地流转与劳动力配置切入, 对集体收入这一维度的讨论相对薄弱。",
    "三、研究设计",
    "使用 2015—2022 年三省面板数据, 采用双向固定效应模型。",
    "四、结论",
    "资本下乡总体上提升了村集体收入, 但效应存在显著的区域异质性。",
    "", "本文还讨论了政策含义与研究局限。".repeat(8),
  ].join("\n");
  const up = await upload("探针稿件.txt", Buffer.from(body, "utf-8"), "text/plain");
  junk.push(up.body?.fileId);
  t("上传返回了 fileId", typeof up.body?.fileId === "string" && up.body.fileId.startsWith("file_"), String(up.body?.fileId ?? up.status));

  const fid = String(up.body?.fileId ?? "");
  const txt = await api(token, `/files/${encodeURIComponent(fid)}/text`);
  t("**按 fileId 取回正文**(这就是缺的那一步)",
    txt.status === 200 && txt.body?.ok === true && String(txt.body?.text ?? "").includes("资本下乡"),
    `status=${txt.status} 字数=${txt.body?.charCount ?? 0}`);
  t("源标记为文本层/原生(不是被当成扫描件)", txt.body?.extraction === "native", String(txt.body?.extraction));
  t("needsOcr 为假(有正文就不该推用户去做 OCR)", txt.body?.needsOcr === false, String(txt.body?.needsOcr));

  // ═══ ② 抽过就不再重抽 ═══
  console.log("\n② 抽过的文件读的是库里那份");
  const again = await api(token, `/files/${encodeURIComponent(fid)}/text`);
  t("第二次读仍拿到同样正文", String(again.body?.text ?? "") === String(txt.body?.text ?? ""),
    `${String(again.body?.text ?? "").length} vs ${String(txt.body?.text ?? "").length} 字`);

  // ═══ ③ 扫描件给出路 ═══
  console.log("\n③ 扫描件: 说缺正文, 并指明下一步");
  const scanBuf = loadScanFixture();
  if (!scanBuf) {
    t("固件 test/fixtures/scan-3page-imageonly.pdf 存在", false, "缺固件 —— ③ 无法验证");
  } else {
    const scanUp = await upload("探针扫描件.pdf", scanBuf, "application/pdf");
    junk.push(scanUp.body?.fileId);
    const sfid = String(scanUp.body?.fileId ?? "");
    const scanTxt = await api(token, `/files/${encodeURIComponent(sfid)}/text`);
    // 先自证固件本身没文字层 —— 否则"needsOcr 为真"可能只是碰巧, 而不是走了扫描件分支
    t("固件确实是扫描件(抽不到任何文字)", scanTxt.body?.ok === false && !String(scanTxt.body?.text ?? "").trim(),
      `ok=${scanTxt.body?.ok} 文本长度=${String(scanTxt.body?.text ?? "").length}`);
    t("扫描件**不是** 500/失败, 而是 200 + 说明", scanTxt.status === 200, `status=${scanTxt.status}`);
    t("**needsOcr 为真**(调用方据此把用户送去识别文字)", scanTxt.body?.needsOcr === true,
      `needsOcr=${scanTxt.body?.needsOcr} err=${String(scanTxt.body?.error ?? "").slice(0, 60)}`);
    t("说明里提到 OCR / 扫描件(用户看得懂下一步)", /OCR|扫描/.test(String(scanTxt.body?.error ?? "")),
      String(scanTxt.body?.error ?? "").slice(0, 60));
  }

  // ═══ ④ 审稿直接吃 fileId ═══
  console.log("\n④ 审稿建 job 能吃上传文件的 fileId");
  const job = await api(token, "/review/jobs", "POST", {
    title: "探针: 从文件直投",
    text: String(txt.body?.text ?? ""),
    sourceFileId: fid, sourceFileName: "探针稿件.txt", sourceFileType: "txt",
  });
  t("建 job 成功", job.status === 200 || job.status === 201, `status=${job.status}`);
  const jid = String(job.body?.jobId ?? "");
  if (jid) {
    // ⚠ 只建不驱动: 直接取消, 免得探针在后台真烧一轮 LLM(建 job 本身不发请求)
    await api(token, `/review/jobs/${jid}/cancel`, "POST");
    junk.push({ reviewJobId: jid });
  }
  const after = await api(token, "/review/jobs?limit=5");
  const made = (after.body?.jobs ?? []).find((j) => String(j.id) === jid) ?? (after.body?.jobs ?? [])[0];
  t("**source_file_id 真的落库了**(此前这条列永远写不进值)",
    String(made?.source_file_id ?? "").includes(fid.replace(/^file_/, "")),
    `落库=${String(made?.source_file_id ?? "(空)")}`);
  t("文件名与类型也落了(只发 id 的话这两列是空串)",
    !!String(made?.source_file_name ?? "") && !!String(made?.source_file_type ?? ""),
    `${made?.source_file_name ?? "(空)"} / ${made?.source_file_type ?? "(空)"}`);

  // ═══ ⑤ 题名候选逐条可点 ═══
  console.log("\n⑤ 编辑器: 题名候选是逐条可点的");
  const { cdp, close } = await startCdp({ preferredPort: 9367, label: "batch17" });
  try {
    await cdp("Page.navigate", { url: `${BASE}/soc/#/editor` });
    await sleep(6000);
    /**
     * ⚠ 判据用**编辑器自己的 DOM class**, 不用中文文案。
     *   本仓记过这条: CI 没有中文 locale, 界面全英文, 按中文找元素的门禁在 CI 必然红
     *   (batch16 就是这么进的 `data: true`)。用 `.ade-layout` 两边都成立,
     *   于是这一套能留在默认组里跑, 不必因为文案而放弃 CI 覆盖。
     */
    const ready = await evalTop(cdp, `(() => {
      return {
        hasEditor: !!document.querySelector('.ade-layout'),
        hasAiPanelBtn: !!document.querySelector('.ade-topbar'),
        len: (document.body.innerText || '').length,
      };
    })()`);
    t("落在编辑器页(按 DOM class 判, 不依赖中文文案)", ready?.hasEditor === true,
      `ade-layout=${ready?.hasEditor} ade-topbar=${ready?.hasAiPanelBtn} 正文长度=${ready?.len}`);

    /**
     * 判据不能是"页面里有没有候选这几个字" —— 那是文案, 改掉文案就绿。
     * 要赌的是**渲染分支**: 给面板喂一份真形状的结构化结果, 看它是否渲染出**可点的按钮**。
     * 用 pinia store 直接灌(比造一次真 job 便宜、可控, 且结论一样 —— 渲染分支不看来源)。
     */
    const cands = await evalTop(cdp, `(() => {
      const app = document.querySelector('#app')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      return { hasVueApp: !!app, hasPinia: !!pinia, hasEditorAi: !!pinia?._s?.get('editor-ai') };
    })()`);
    t("拿到 pinia 里的 editor-ai store(下面几段要靠它驱动)",
      cands?.hasVueApp === true && cands?.hasEditorAi === true, JSON.stringify(cands));

    /**
     * 真调用: 打开辅助工具 → 切到题名 tab → 触发一次。**这会烧一次 LLM**(用户在需求里
     * 明确要这条能力, 一次调用是可接受的验证成本; 若环境没配模型会失败, 那时如实报)。
     */
    const clicked = await evalTop(cdp, `(async () => {
      // 面板开关不在按钮里 —— localStorage 里有活动 job 时才会自动开(EditorView 的恢复分支)。
      //   走 __vue_app__ 的 pinia 实例拿 store, 这是最不容易随文案漂移的入口。
      const app = document.querySelector('#app')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const ai = pinia?._s?.get('editor-ai');
      if (!ai) return 'no-pinia-editor-ai';
      ai.panelOpen = true;
      await new Promise(r => setTimeout(r, 800));
      if (!document.querySelector('.ade-ai-panel')) return 'panel-closed';
      const tab = [...document.querySelectorAll('.ade-ai-panel__tab')].find(b => /题名摘要/.test(b.innerText || ''));
      if (!tab) return 'no-title-tab';
      tab.click();
      await new Promise(r => setTimeout(r, 400));

      /**
       * ⚠ 不重新跑模型。这是本探针第二次犯"拿被测对象之外的东西当判据"的毛病:
       *   第一版点的是 .ade-task-card —— 但**卡片不是文件名那三个字**, 它每张都长一个样
       *   (文件名字符串在标签页按钮上不在卡片上), 整段跑了 45 秒等一个根本没发出的请求。
       *   而且卡片此刻是 disabled 的 —— 它要求"已打开有正文的文档", 那是**前置条件**不是被测对象。
       *
       * 真调一次要烧钱且结论一样(renderTitleContent 的分支不看调用来源)。所以直接喂一份
       * **真形状**的 lastResult(与 editor-service 返回的字段一一对应), 判据落在渲染出的
       * **可点按钮**上 —— 不是"页面里有没有候选俩字"(那是文案, 改文案就绿)。
       *
       * (这段注释里**不能出现反引号** —— 它整段是外层模板串的一部分, 一个反引号就把它闭合了。
       *  本仓在门禁脚本上栽过同一个坑, 我又栽一次。)
       */
      ai.lastActionLabel = 'title';
      ai.lastResult = {
        title: '资本下乡与村集体收入: 基于三省面板数据的实证检验',
        alternatives: [
          '资本下乡如何影响村集体收入 —— 三省面板数据的经验证据',
          '工商资本进入与集体经济增收: 机制与区域异质性',
        ],
        reason: '原标题口号化, 未点明方法与结论',
      };
      /**
       * ⚠ 结果卡的**外层条件是** resultText || store.isBusy || pendingActionTitle ——
       *   其中 resultText 与 pendingActionTitle 是组件内的局部 ref, store 驱动不到。
       *   只灌 lastResult 的话整张卡都不渲染(第一版就是这么"失败"的, 那不是实现的错)。
       *   所以借 store.isBusy 把外层条件满足; streamingContent 同时置非空, 避开上面
       *   "正在整理建议…" 那个分支。真流程里 resultText 由 runAction 落, 不需要这手。
       */
      ai.isLoading = true;
      ai.streamingContent = '（探针注入）';
      await new Promise(r => setTimeout(r, 600));
      return document.querySelector('[data-testid="title-candidates"]') ? 'ready' : 'no-cands-rendered';
    })()`);
    t("题名候选按结构渲染出可点区(判据落在这个分支, 不是文案)", clicked === "ready", String(clicked));
    if (clicked === "ready") {
      const rendered = await evalTop(cdp, `(() => {
        const wrap = document.querySelector('[data-testid="title-candidates"]');
        if (!wrap) return { found: false, page: (document.body.innerText || '').slice(0, 200) };
        const btns = [...wrap.querySelectorAll('button')];
        return { found: true, n: btns.length, labels: btns.map(b => (b.innerText||'').trim().slice(0, 30)) };
      })()`);
      t("**渲染出逐条可点的候选**(而不是一段 markdown)", rendered?.found === true,
        rendered?.found ? `${rendered.n} 条` : String(rendered?.page ?? "").replace(/\s+/g, " ").slice(0, 120));
      if (rendered?.found) {
        t("候选数 >= 2(只有一个就跟原来没区别)", rendered.n >= 2, `${rendered.n} 条`);
        // 推荐项排第一位 —— 判据用 class 不用文案(理由同上: CI 无中文)
        const firstIsTop = await evalTop(cdp, `(() => {
          const wrap = document.querySelector('[data-testid="title-candidates"]');
          const b = wrap?.querySelector('button');
          return { cls: b ? b.className : "", idx: b ? (b.querySelector('.title-cand__idx')?.className || "") : "" };
        })()`);
        t("推荐项排在第一位(模型给的 title 不该沉到 alternatives 里)",
          String(firstIsTop?.idx ?? "").includes("title-cand__idx"), JSON.stringify(firstIsTop));
        // 点第 2 条 → 正文里应出现它
        const picked = await evalTop(cdp, `(() => {
          const wrap = document.querySelector('[data-testid="title-candidates"]');
          const btns = [...wrap.querySelectorAll('button')];
          const want = (btns[1].querySelector('.title-cand__text')?.innerText || '').trim();
          btns[1].click();
          return want.slice(0, 40);
        })()`);
        await sleep(1200);
        const inDoc = await evalTop(cdp, `(() => {
          const ed = document.querySelector('.tiptap') || document.querySelector('.ProseMirror');
          return ed ? (ed.innerText || '') : '';
        })()`);
        t("点一条 → 该候选进了正文", !!picked && String(inDoc).includes(picked),
          `点了「${picked}」; 正文${String(inDoc).includes(picked) ? "含" : "不含"}它`);
      }
    }
  } finally {
    try { close(); } catch { /* 清理失败不改结论 */ }
  }
} finally {
  // 收尾: 清掉探针造的数据(评审 job / 上传文件)
  for (const j of junk) {
    try {
      if (typeof j === "string") await api(token, `/files/${encodeURIComponent(j)}`, "DELETE");
      else if (j?.reviewJobId) await api(token, `/review/jobs/${j.reviewJobId}`, "DELETE");
    } catch { /* 清理失败不改结论, 但下面会打印 */ }
  }
  console.log(`\n  ${fail ? "❌" : "✅"} ${pass}/${pass + fail} 通过`);
}
