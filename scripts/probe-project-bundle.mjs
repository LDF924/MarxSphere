// scripts/probe-project-bundle.mjs — 项目整包导出(V425 A3)的真实下载探针
//
// 为什么不只看"按钮发了请求":
//   这个功能的产出是**一个文件**。请求 200 而文件没落盘(Content-Disposition 写错、
//   blob 没转成下载、URL 没 revoke 导致空文件)全都会漏过去。
//   所以这里让 Chromium 真下载到临时目录, 再**打开那个 zip 校验结构** ——
//   路径从文件名到内容逐层验, 至少要能看到 README.md 与 论文.md 两个条目。
//
// 用 CDP 的 Browser.setDownloadBehavior 指定落盘目录(headless 默认不允许下载)。
//
// 用法: API_BASE=http://127.0.0.1:4373 WEB=http://127.0.0.1:4373 node scripts/probe-project-bundle.mjs
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, dismissOverlays } from "./lib/probe-actions.mjs";
import { mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = process.env.WEB || "http://127.0.0.1:4173";
const SUFFIX = "/soc/index.html";
const API_BASE = process.env.API_BASE || "http://127.0.0.1:4173";

const rows = [];
const rec = (k, ok, d) => { rows.push({ k, ok }); console.log(`${ok ? "  ok  " : "FAIL  "}${k}${d ? " — " + d : ""}`); };

const api = async (tk, p, m = "GET", b) => {
  const r = await fetch(`${API_BASE}/api${p}`, {
    method: m, headers: { Authorization: `Bearer ${tk}`, ...(b ? { "Content-Type": "application/json" } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const tk = await loginToken("audit", "audit123456");
const p = await api(tk, "/research/projects", "POST", { title: `整包探针-${Date.now()}` });
const pid = p.json?.id;
if (!pid) { console.error("建项目失败", JSON.stringify(p).slice(0, 200)); process.exit(1); }

// 种一个有内容的项目: 两章正文 + 合稿 + 一条素材 + 一个阶段版本。
//   包是"有什么导出什么", 空项目也能出包 —— 所以种子必须**有内容**, 否则断言测的是空包。
await api(tk, `/research/projects/${pid}/workbench`, "PUT", {
  snapshot: {
    input: { title: "整包探针", outline: "一、引言", totalWordCount: 6000, researchMethod: "qualitative", requirements: "" },
    sections: [
      { id: "s0", title: "引言", level: 1, order: 0, content: "引言正文。".repeat(30) },
      { id: "s1", title: "研究设计", level: 1, order: 1, content: "设计正文。".repeat(30) },
    ],
    mergedTitle: "整包探针论文", mergedAbstract: "摘要", mergedKeywords: "关键词甲; 关键词乙",
    mergedFullText: "合稿正文。".repeat(120), mergedReferences: "[1] 李四. 测试文献[J]. 某刊, 2021(1): 1-9.",
  },
});
await api(tk, "/research/materials", "POST", { projectId: pid, kind: "theory", title: "探针理论素材", contentMd: "素材正文内容" });
await api(tk, `/research/projects/${pid}/publish`, "POST", { label: "phase4_text" });

/**
 * 复现材料的种子(批9): 一个绑定的实证课题 + 数据版本 + 一次**带脚本**的回归。
 *
 * ⚠ 必须走 `/empirical/regression/run` 而不是 `/empirical/run` —— 只有前者会写
 *   `stata_code`(分析脚本)那一列。我第一版走错了端点, 于是把"脚本缺失"误判成
 *   功能没做(实测复现过: 走 run 时包里只有结果没有脚本)。
 * ⚠ 数据单元格以 `=` 开头, 是**特意**的: 用来验 CSV 注入防护有没有生效
 *   (见下面 "CSV 无未转义的公式起始字符" 那条断言)。
 */
const ep = await api(tk, "/empirical/projects", "POST", { title: `整包探针实证-${Date.now()}`, topic: "T" });
const empId = ep.json?.project?.id ?? ep.json?.id;
const seedRows = [
  ["=cmd|' /C calc'!A0", 1, 0],
  ["正常值", 2, 1],
  ["含,逗号", 3, 0],
  ['含"引号"', 4, 1],
];
await api(tk, "/empirical/data-versions", "POST", {
  projectId: empId, name: "探针样本", columns: ["y", "x", "z"], rows: seedRows,
});
const reg = await api(tk, "/empirical/regression/run", "POST", {
  projectId: empId,
  data: { columnOrder: ["y", "x", "z"], rows: seedRows },
  spec: { dep: "y", core: ["x"], controls: ["z"], model: "ols" },
  code: "use \"$DATA\"\ngen cons = 1\nreg y x z",
});
if (reg.json?.taskId) {
  // 等任务完成 + tracker 落库(两个轮询周期, 与 probe-research-evidence 同一课)
  for (let i = 0; i < 25; i++) {
    await sleep(1500);
    const st = await api(tk, `/empirical/result/${reg.json.taskId}`);
    if (st.json?.status === "done" || st.json?.status === "error") break;
  }
  for (let i = 0; i < 8; i++) {
    await sleep(1500);
    const rr = await api(tk, `/empirical/projects/${empId}/pipeline`);
    if ((rr.json?.runs ?? []).length) break;
  }
}
await api(tk, `/research/projects/${pid}/empirical-binding`, "PUT", { empiricalProjectId: empId });
// 声明段(批5 的口径: 导出读 store 快照里的 declarations)
await api(tk, `/research/projects/${pid}/workbench`, "PUT", {
  snapshot: { declarations: { authorship: "张三：研究设计", funding: "国家社科基金 20BJL001", conflict: "无。" } },
});

const dlDir = mkdtempSync(path.join(tmpdir(), "bundle-dl-"));
const { cdp, close } = await startCdp({ preferredPort: 31093, label: "probe-project-bundle" });

try {
  await cdp("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir, eventsEnabled: true });
  await openSoc(cdp, BASE, "/workflow/finalize", tk, pid, 7500, SUFFIX);
  await dismissOverlays(cdp);
  await sleep(900);

  const btn = await evalTop(cdp, `(() => {
    const b = document.querySelector('[data-control="workflow:export-bundle"]');
    return b ? { text: (b.innerText||'').trim(), disabled: !!b.disabled } : null;
  })()`);
  rec("整包导出入口存在且可点", !!btn && !btn.disabled, btn ? `文案="${btn.text}" 禁用=${btn.disabled}` : "未找到 data-control");

  if (btn && !btn.disabled) {
    await evalTop(cdp, `(() => { document.querySelector('[data-control="workflow:export-bundle"]').click(); return 1; })()`);
    // 打包 + 下载: 本地几十 KB 的包通常 1s 内落盘, 给足 20s 容错(Python 生成 docx 要几秒)
    let files = [];
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      files = readdirSync(dlDir).filter((f) => f.endsWith(".zip"));
      if (files.length) break;
    }
    rec("点导出后 zip 真落盘", files.length > 0, files.length ? `目录内: ${files.join(", ")}` : `20s 内 ${dlDir} 无 .zip`);
    if (files.length) {
      const fp = path.join(dlDir, files[0]);
      const buf = readFileSync(fp);
      rec("落盘文件是合法 zip(PK 魔数)", buf.subarray(0, 2).toString("latin1") === "PK" && buf.length > 500,
        `${buf.length} 字节, 头=${buf.subarray(0, 4).toString("hex")}`);
      // 走中央目录列出条目名(UTF-8 名带 EFS 标志) —— 比只看大小能证明"内容真进去了"
      const names = [];
      for (let i = 0; i + 46 <= buf.length; i++) {
        if (buf.readUInt32LE(i) === 0x02014b50) {
          const n = buf.readUInt16LE(i + 28);
          names.push(buf.subarray(i + 46, i + 46 + n).toString("utf8"));
        }
      }
      const want = ["README.md", "论文.md", "章节/01-引言.md", "素材清单.md", "版本沿革.md", "研究信息.md"];
      rec("zip 内含全部关键条目", want.every((w) => names.includes(w)),
        `缺=[${want.filter((w) => !names.includes(w)).join(",")}] 实际=[${names.join(", ")}]`);
      const readme = (() => {
        const i = buf.indexOf(Buffer.from("README.md", "utf8"));
        return i >= 0 ? "有" : "无";
      })();
      rec("zip 里能定位到 README(解压首页)", readme === "有", `README 条目 ${readme}`);
      // 章节数必须与播种一致 —— 只出论文不出章节是"整包"最容易少的一块
      const chap = names.filter((n) => n.startsWith("章节/")).length;
      rec("章节逐篇导出(2 章)", chap === 2, `实测 ${chap} 个章节文件`);
      // 文件名: Content-Disposition 里的中文名不该变成 project-export.zip(那是 fallback)
      rec("下载文件名用了项目标题(非 fallback)", files[0].includes("整包探针"),
        `文件名="${files[0]}"`);

      /**
       * ⑨ 复现材料(批9, 2026-09-27) —— 这个包从"论文打包"变成**研究可复现包**。
       *
       * 此前包里只有成品的文字, 而"别人能不能照着重跑一遍"要的三样一样没有:
       * 数据 / 分析脚本 / 分析结果。三样**平台里本来就存着**
       * (empirical_data_versions.data、empirical_pipeline_runs.stata_code / python_result),
       * 只是没打进包里。
       *
       * ⚠ 验证要点不是"有没有这个目录", 而是**里面有没有真东西**:
       *   一个空的 `复现材料/` 目录会在界面上看着像做完了。
       */
      const reproNames = names.filter((n) => n.startsWith("复现材料/"));
      rec("包内有复现材料一节", reproNames.length > 0, `条目: ${reproNames.join(", ") || "无"}`);
      rec("复现材料含数据 CSV", reproNames.some((n) => n.startsWith("复现材料/数据/") && n.endsWith(".csv")),
        `数据条目: ${reproNames.filter((n) => n.startsWith("复现材料/数据/")).join(", ") || "无"}`);
      rec("复现材料含分析脚本", reproNames.some((n) => n.startsWith("复现材料/脚本/")),
        `脚本条目: ${reproNames.filter((n) => n.startsWith("复现材料/脚本/")).join(", ") || "无"}`);
      rec("复现材料含分析结果", reproNames.some((n) => n.startsWith("复现材料/结果/")),
        `结果条目: ${reproNames.filter((n) => n.startsWith("复现材料/结果/")).join(", ") || "无"}`);
      rec("复现材料有自己的 README(讲清从哪开始、缺什么)", reproNames.includes("复现材料/README.md"),
        `含=${reproNames.includes("复现材料/README.md")}`);

      // 数据 CSV 的内容要真的是那张表, 不是空壳: 解出条目看头两行
      const csvName = reproNames.find((n) => n.startsWith("复现材料/数据/") && n.endsWith(".csv"));
      if (csvName) {
        // 用 fflate 解压(探针环境里有; 手写 deflate 太容易假通过)
        const { unzipSync, strFromU8 } = await import("fflate");
        const files2 = unzipSync(new Uint8Array(buf));
        const csv = files2[csvName] ? strFromU8(files2[csvName]) : "";
        const lines = csv.split(/\r?\n/).filter((l) => l.trim());
        rec("CSV 内容是真数据(表头 + ≥1 数据行)", lines.length >= 2 && lines[0].includes(","),
          `${lines.length} 行, 首行="${(lines[0] ?? "").slice(0, 50)}"`);
        /**
         * ⚠ BOM 要查**原始字节**, 不能查解码后的字符。
         *   第一版写的是 `csv.charCodeAt(0) === 0xfeff`, 恒假 —— 因为 `fflate.strFromU8`
         *   **自己会剥掉 BOM**(实测: 喂它带 BOM 的字节, 解出来首字符是 'y' 不是 U+FEFF)。
         *   于是"BOM 没写对"这个结论是我**判据看不到被测对象**造成的假失败 ——
         *   源码里那个 BOM 一直是好的(`ef bb bf`)。
         */
        const rawCsv = files2[csvName];
        const hasBom = rawCsv && rawCsv[0] === 0xef && rawCsv[1] === 0xbb && rawCsv[2] === 0xbf;
        rec("CSV 带 BOM(Excel 打开中文列名不乱码)", !!hasBom,
          `首 3 字节=${rawCsv ? [...rawCsv.slice(0, 3)].map((b) => b.toString(16)).join(" ") : "无"}`);
        /**
         * ⚠ CSV 注入防护: 以 `= + - @` 开头的单元格会被 Excel 当公式**执行**。
         *   导出的是用户自己的数据, 但问卷数据可能是别人填的 —— 用户打开自己导出的
         *   CSV 不该被执行代码。这里断言"没有未加保护的公式起始字符"。
         */
        const risky = lines.slice(1).some((l) =>
          l.split(",").some((c) => /^[=+@]/.test(c.trim())));
        rec("CSV 无未转义的公式起始字符(防注入)", !risky, `有风险行=${risky}`);

        // 脚本内容要真是代码, 不是占位
        const doName = reproNames.find((n) => n.startsWith("复现材料/脚本/"));
        if (doName) {
          const code = files2[doName] ? strFromU8(files2[doName]) : "";
          rec("分析脚本内容非空且像代码", code.trim().length > 10 && /reg\s|use\s|import\s|gen\s/.test(code),
            `${code.trim().length} 字符, 首行="${(code.split("\n")[0] ?? "").slice(0, 40)}"`);
        }
      }
    }
  }
} catch (e) {
  console.error("探针异常:", e.message);
} finally {
  try { await api(tk, `/research/projects/${pid}`, "DELETE"); } catch { /* 忽略 */ }
  // 实证课题要单独删 —— 它不在 research_projects 里, 探针收尾清不掉它就会逐轮累积
  try { if (empId) await api(tk, `/empirical/projects/${empId}`, "DELETE"); } catch { /* 忽略 */ }
  close();
  try { rmSync(dlDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
void statSync;

console.log("\n" + "=".repeat(50));
const fail = rows.filter((r) => !r.ok);
console.log(`整包导出探针: ${rows.length - fail.length} 通过 / ${fail.length} 失败`);
process.exit(fail.length ? 1 : 0);
