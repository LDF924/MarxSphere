// scripts/probe-stats-xlsx-upload.mjs — 数据分析台的 .xlsx 上传**真跑**验证
//
// 为什么单开一条: 台账里这条长期记的是「后端仅 csv/tsv 文本通道」, 实际后端**早就有**
// xlsx→CSV 通道(借 `scripts/xlsx2csv.py`), 前端 accept 也带着 .xlsx —— 记录过期。
// 但代码链完整 ≠ 能跑: 探针套件里**从来没有任何 xlsx 用例**, 所以这轮补上。
//
// 覆盖前端那一半(后端那一半在写这条之前已用 curl 实测过):
//   File 对象 → 真点/真 setInputFiles → POST /files/upload → profile 出变量 → 变量可点选 → 能配齐运行前置
//
// ⚠ xlsx 在 **node 侧**现造(fflate 打一个最小 OOXML 包), 不往仓库塞二进制 fixture:
//   归入 scripts/ 的样本会污染仓库, 而运行时造 1.5KB 字节更干净, 谁跑谁生成。
//   自检过 openpyxl 能读(缺 `<dimension>` 时 openpyxl 会报"无数据 sheet"——踩过一次)。
//
// 用法: node scripts/probe-stats-xlsx-upload.mjs   (需 4173 已起)
import { zipSync, strToU8 } from "fflate";
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, spyInstall, probeAction, waitFor, readToast } from "./lib/probe-actions.mjs";

const BASE = "http://127.0.0.1:4173";
const rows = [];
function rec(action, kind, detail) {
  rows.push({ action, kind, detail });
  const tag = kind === "ok" ? "  ok  " : kind === "dead" ? " DEAD " : kind === "gated" ? " gated" : kind === "err" ? " ERR  " : " skip ";
  console.log(`${tag} ${action} — ${detail}`);
}

/** 合成一个 openpyxl 能读的最小 .xlsx(5 个 OOXML 部件, 真 zip 容器) */
function buildXlsx() {
  const data = [
    ["id", "age", "income", "score", "gender"],
    ...Array.from({ length: 90 }, (_, i) => [
      String(i + 1), String(22 + ((i * 7) % 40)), (100 + i * 3.17).toFixed(2),
      String(40 + ((i * 11) % 60)), i % 2 ? "男" : "女",
    ]),
  ];
  const col = (i) => String.fromCharCode(65 + i);
  const cell = (ref, v, isText) =>
    isText ? `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>` : `<c r="${ref}"><v>${v}</v></c>`;
  const sheet =
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:${col(data[0].length - 1)}${data.length}"/><sheetData>` +
    data.map((r, ri) =>
      `<row r="${ri + 1}">` +
      r.map((v, ci) => cell(`${col(ci)}${ri + 1}`, v, ri === 0 || !/^-?\d+(\.\d+)?$/.test(v))).join("") +
      `</row>`
    ).join("") +
    `</sheetData></worksheet>`;
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `</Types>`),
    "_rels/.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `</Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  });
}

const api = async (token, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const { cdp, close } = await startCdp({ preferredPort: 31079, label: "probe-stats-xlsx" });
try {
  const token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败");

  // ── A. 后端半条链(不经浏览器): base64 → /files/upload → xlsx2csv → profile ──
  //   先钉死后端, 这样后面前端若失败, 能立刻分清是"后端不认"还是"前端没送对"。
  const xlsx = buildXlsx();
  const up = await api(token, "/files/upload", "POST", {
    filename: "probe_xlsx_sample.xlsx",
    base64: Buffer.from(xlsx).toString("base64"),
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const prof = up.json?.profile ?? {};
  const vars = (prof.variables ?? []).map((v) => v.name);
  rec("后端 xlsx→profile", up.status === 200 && prof.kind === "csv" && vars.length === 5 ? "ok" : "err",
    `HTTP ${up.status} kind=${prof.kind} rows=${prof.rowCount} cols=${prof.columnCount} vars=${JSON.stringify(vars)}`);

  // ── B. 前端半条链: 真把 File 塞进 input → 走 onUploadInput ──
  await openSoc(cdp, BASE, "/statistics", token);
  await spyInstall(cdp);
  // File 对象没法跨进程传给页面, 用 base64 在页面里重建(与真实上传的字节完全一致)
  await evalTop(cdp, `(() => {
    window.__xlsxB64 = ${JSON.stringify(Buffer.from(xlsx).toString("base64"))};
    window.__mkFile = () => {
      const bin = atob(window.__xlsxB64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return new File([u8], "probe_xlsx_sample.xlsx",
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    };
    return true;
  })()`);

  // `input.files` 是**只读**的 —— 必须用 DataTransfer 造 FileList。
  //   (这条已经在别处踩过: 直接赋值静默失败, 表现为"点了没反应")
  //
  // ⚠ 必须在 `dispatchEvent` **之前**读取文件名。`onUploadInput` 处理完会
  //   `input.value = ""`(好让你重选同一个文件), 那会**同步清空 FileList** ——
  //   在 dispatch 之后读 `files[0]` 必然 undefined(第一版就这么写的, 红了一次)。
  const picked = await evalTop(cdp, `(() => {
    const inp = document.querySelector('input[type=file][accept*="xlsx"]');
    if (!inp) return 'no-input';
    const dt = new DataTransfer();
    dt.items.add(window.__mkFile());
    inp.files = dt.files;
    const info = inp.files.length + ':' + inp.files[0].name;  // 先取, 再触发
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return info;
  })()`);
  rec("把 xlsx 交给上传框", String(picked).startsWith("1:") ? "ok" : "err", `input.files=${picked}`);

  // 上传是同步链(转 CSV 在服务端 spawn python), 等界面出现文件名
  const uploaded = await waitFor(cdp, `!!document.querySelector('.file-name-display-sm')`, { timeout: 90000, every: 1500 });
  const state = await evalTop(cdp, `(() => {
    const n = document.querySelector('.file-name-display-sm');
    const chips = [...document.querySelectorAll('.var-item-mb .var-name')].map(e => e.textContent.trim());
    const sel = [...document.querySelectorAll('.var-item-mb.selected .var-name')].map(e => e.textContent.trim());
    const uploadLabel = document.querySelector('.upload-label-sm');
    return { name: n ? n.textContent.trim() : '', chips, sel, label: uploadLabel ? uploadLabel.textContent.trim() : '' };
  })()`);
  rec("界面认下这个文件", uploaded && /probe_xlsx_sample/.test(state?.name ?? "") ? "ok" : "err",
    `文件名="${state?.name ?? "(空)"}" 上传条="${(state?.label ?? "").slice(0, 26)}"`);

  // ── C. 最要紧的一步: profile 里的变量**真的出现在界面上** ──
  //   "上传成功"很容易假过(后端返 200 就够了), 但用户要的是能选变量接着跑。
  //
  // ⚠ 别断言"5 列全在"。默认方法(描述统计)是 **`scaleOnly`**, 界面**故意**只列尺度变量 ——
  //   `gender` 不出现是**对的**, 断言它必须出现会得到一个恒红的假失败(第一版就这么写的)。
  //   所以拆成两条: 尺度列在上(且非尺度列被正确挡掉) + **切到不过滤的方法后 5 列齐**。
  const SCALE = ["id", "age", "income", "score"];
  const NON_SCALE = ["gender"];
  const got = state?.chips ?? [];
  rec("尺度变量列渲染(默认方法只列 scale)",
    SCALE.every((w) => got.includes(w)) && NON_SCALE.every((w) => !got.includes(w)) ? "ok" : "err",
    `界面变量=${JSON.stringify(got)}`);

  // ── D. 切到「频数分析」→ 非尺度列露出来 ──
  //   证的是同一件事的另一面: xlsx 的**名义列**也真进来了(默认视图里被 scaleOnly 挡着看不见)。
  //   ⚠ 频数分析是 `varsFilter: "nominal"` —— 界面此时**只列 gender 是对的**,
  //     别断言"5 列全在"(那不是它的语义, 会得到一个恒红的假失败 —— 第二版就是这么写的)。
  const switchTo = async (name) => evalTop(cdp, `(() => {
    const b = [...document.querySelectorAll('.method-item')].find(x => x.textContent.trim() === ${JSON.stringify(name)});
    if (!b) return 'no-method';
    b.click();
    return 'clicked';
  })()`);
  const toNominal = await switchTo("频数分析");
  await sleep(1200);
  const nominalVars = await evalTop(cdp, `[...document.querySelectorAll('.var-item-mb .var-name')].map(e => e.textContent.trim())`);
  rec("切到名义方法后非尺度列出现", toNominal === "clicked" && (nominalVars ?? []).includes("gender") ? "ok" : "err",
    `方法切换=${toNominal} 界面变量=${JSON.stringify(nominalVars)}`);

  // ── E. 切回尺度方法 → 变量可点选(选中态真变) ──
  const back = await switchTo("描述统计");
  await sleep(1200);
  const pick = await probeAction(cdp, ".var-item-mb", { wait: 1200 });
  const after = await evalTop(cdp, `[...document.querySelectorAll('.var-item-mb')].map(e => e.className.includes('selected') ? 1 : 0).join('')`);
  rec("变量可点选", back === "clicked" && /1/.test(String(after)) ? "ok" : "dead",
    `切回=${back} 点击=${pick.clicked} 选中位图=${after}`);

  // ── F. 运行前置齐了(不再被"请先上传数据文件/请至少选择一个变量"挡下) ──
  //
  // ⚠ 不能在页面里**一口气循环点击**。每次点选都会 `selectedVars = new Set(...)` 触发重渲染,
  //   Vue 会把列表节点换掉 —— 循环里剩下的 `el` 已经是**脱离文档的旧节点**, `el.click()` 静默无效。
  //   实测表现: 只选中 1 个(而不是 4 个), 看起来像"产品只能选一个"(假失败)。
  //   正确做法: **每次点击之间重新查询**(点一个 → 回 node 侧 → 再查再点)。
  for (const name of ["id", "age", "income", "score"]) {
    await evalTop(cdp, `(() => {
      const el = [...document.querySelectorAll('.var-item-mb')]
        .find(e => e.querySelector('.var-name')?.textContent.trim() === ${JSON.stringify(name)});
      if (el && !el.className.includes('selected')) el.click();
      return true;
    })()`);
    await sleep(250);
  }
  const sel = await evalTop(cdp, `[...document.querySelectorAll('.var-item-mb.selected .var-name')].map(e => e.textContent.trim())`);
  rec("尺度变量可选中(运行前置)", (sel ?? []).length >= 4 ? "ok" : "err", `已选=${JSON.stringify(sel)}`);

  // 这里**故意不点运行**: 运行会真起 Python 分析任务, 归 support-views 那条探针管;
  //   本条只管"xlsx 能不能进来、变量能不能用", 边界清楚。

  console.log("\n════════ 汇总 ════════");
  for (const x of rows) console.log(`${x.kind.padEnd(6)} ${x.action}`);
  const bad = rows.filter((x) => x.kind === "err" || x.kind === "dead");
  console.log(bad.length ? `\n❌ ${bad.length} 项异常` : `\n✅ ${rows.length} 项全部通过`);
  if (bad.length) process.exitCode = 1;
} catch (e) {
  console.error("探针异常:", e.message, e.stack?.split("\n")[1] ?? "");
  process.exitCode = 1;
} finally {
  await close();
}
