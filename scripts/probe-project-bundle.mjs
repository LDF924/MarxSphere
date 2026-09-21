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
    }
  }
} catch (e) {
  console.error("探针异常:", e.message);
} finally {
  try { await api(tk, `/research/projects/${pid}`, "DELETE"); } catch { /* 忽略 */ }
  close();
  try { rmSync(dlDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
void statSync;

console.log("\n" + "=".repeat(50));
const fail = rows.filter((r) => !r.ok);
console.log(`整包导出探针: ${rows.length - fail.length} 通过 / ${fail.length} 失败`);
process.exit(fail.length ? 1 : 0);
