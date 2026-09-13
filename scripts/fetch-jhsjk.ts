// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// fetch-jhsjk.ts — 习近平系列重要讲话数据库抓取（CDP 检索 + Edge headless 抓全文）
// 检索是 JS 动态（需 CDP），文章页是静态（Edge headless 可打印）
//
// 用法:
//   npx tsx scripts/fetch-jhsjk.ts --query "资本下乡" --out "E:/.../02-习近平论述摘编" --limit 5
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CDP_PROXY = process.env.CDP_PROXY_URL || "http://localhost:3456";
// V415: 这里原来兜底到某个人的私人 Obsidian 库绝对路径(还带具体课题名)——
// 别人跑这脚本会一脸懵地写到我不认识的目录。改为: 必须由 --out 或 POLICY_DIR 给出。
const POLICY_DIR = process.env.POLICY_DIR || "";

// 浏览器候选: 复用服务侧的跨平台探测(AGENT_EDGE_PATH → 按平台探测), 再回退本地候选表。
// 注意用静态 import —— ESM 里没有 require, 写成 require(...) 会被 catch 吞掉、
// 探测静默失效(这正是 browser-path.ts 文件头记录过的那个坑, 别再踩第三次)。
import { edgePath, edgePathHint } from "../src/services/browser-path.js";

function findBrowser(): string {
  if (process.env.PDF_ENGINE_PATH) return process.env.PDF_ENGINE_PATH;
  const p = edgePath();
  if (p) return p;
  const EDGE_CANDIDATES = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ];
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${edgePathHint()}（也可用 PDF_ENGINE_PATH 显式指定）`);
}

async function cdpNew(url: string): Promise<string> {
  const res = await fetch(`${CDP_PROXY}/new`, { method: "POST", body: url });
  const data = await res.json();
  return data.targetId;
}

async function cdpEval(target: string, expr: string): Promise<any> {
  const res = await fetch(`${CDP_PROXY}/eval?target=${target}`, { method: "POST", body: expr });
  const data = await res.json();
  return data.value;
}

async function cdpClose(target: string): Promise<void> {
  await fetch(`${CDP_PROXY}/close?target=${target}`).catch(() => {});
}

function printToPdf(browser: string, url: string, outpath: string): { ok: boolean; size: number; error?: string } {
  const tmpDir = path.join(os.tmpdir(), `.edge_jhsjk_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const child = spawn(browser, [
      "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
      `--user-data-dir=${tmpDir}`,
      `--print-to-pdf=${outpath}`,
      url
    ], { stdio: "ignore" });
    child.unref();
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      if (fs.existsSync(outpath) && fs.statSync(outpath).size > 10 * 1024) {
        return { ok: true, size: fs.statSync(outpath).size };
      }
      const waitUntil = Date.now() + 1000;
      while (Date.now() < waitUntil) { /* 忙等 */ }
    }
    return { ok: false, size: 0, error: "PDF 未在 30s 内生成" };
  } catch (error) {
    return { ok: false, size: 0, error: error instanceof Error ? error.message.slice(0, 100) : String(error) };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

function parseArgs(argv: string[]): { query?: string; out?: string; limit?: number } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1] ?? "true";
      i += 1;
    }
  }
  return {
    query: args.query,
    out: args.out,
    limit: args.limit ? Number(args.limit) : 5
  };
}

async function main(): Promise<void> {
  const { query, out, limit } = parseArgs(process.argv.slice(2));
  if (!query) {
    console.error("用法：--query 关键词 [--out 输出目录] [--limit 数量]");
    process.exit(1);
  }

  // V415: 未给 --out 且未配 POLICY_DIR 时明确报错退出。
  // 原来会兜底写进某个人的私人 Obsidian 库路径 —— 静默写到别人不认识的目录比报错更糟。
  if (!out && !POLICY_DIR) {
    console.error("需要输出目录: 用 --out <目录> 指定, 或设置环境变量 POLICY_DIR(脚本会在其下建「02-习近平论述摘编」)。");
    process.exit(1);
  }
  const targetDir = out || path.join(POLICY_DIR, "02-习近平论述摘编");
  fs.mkdirSync(targetDir, { recursive: true });

  console.log(`=== 习近平数据库检索：${query} ===`);

  // 1. CDP 检索，提取文章 ID 列表
  let target = "";
  try {
    target = await cdpNew(`http://jhsjk.people.cn/result?keyword=${encodeURIComponent(query)}`);
    await new Promise((r) => setTimeout(r, 5000));

    const articleIds = await cdpEval(target, `(() => {
      const links = Array.from(document.querySelectorAll("a[href]"));
      const ids = links.map(a => a.href.match(/article\\/(\\d+)/)?.[1]).filter(Boolean);
      return [...new Set(ids)].slice(0, ${limit});
    })()`);

    const ids: string[] = Array.isArray(articleIds) ? articleIds : [];
    console.log(`检索到 ${ids.length} 篇文章`);

    // 2. Edge headless 逐篇抓全文
    const browser = findBrowser();
    let ok = 0, fail = 0;
    for (const [index, id] of ids.entries()) {
      const url = `http://jhsjk.people.cn/article/${id}`;
      const outpath = path.join(targetDir, `jhsjk-${id}.pdf`);
      if (fs.existsSync(outpath) && fs.statSync(outpath).size > 10 * 1024) {
        console.log(`  [${index + 1}/${ids.length}] [跳过] ${id}`);
        ok += 1;
        continue;
      }
      const result = printToPdf(browser, url, outpath);
      if (result.ok) {
        console.log(`  [${index + 1}/${ids.length}] ✅ ${id} (${(result.size / 1024).toFixed(1)}KB)`);
        ok += 1;
      } else {
        console.log(`  [${index + 1}/${ids.length}] ❌ ${id}: ${result.error}`);
        fail += 1;
      }
    }
    console.log(`\n完成 ${ok}/${ids.length}，失败 ${fail}`);
  } catch (error) {
    console.error(`失败: ${error instanceof Error ? error.message : String(error)}`);
    console.error("提示：需先启动 web-access 的 CDP proxy（浏览器调试端口 3456）");
    process.exit(1);
  } finally {
    if (target) await cdpClose(target);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
