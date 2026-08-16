// fetch-web-sources.ts — 网页类源批量抓取脚本
// 用 Edge headless 打印网页转 PDF（不依赖 web_to_pdf.py，规避其 virtual-time-budget 问题）
// 抓取网页类数据源 → 转 PDF → 输出到指定目录（默认政策库）
//
// 用法:
//   npx tsx scripts/fetch-web-sources.ts --source jhsjk --query "资本下乡" --out "E:/.../政策库"
//   npx tsx scripts/fetch-web-sources.ts --source qstheory --query "资本下乡"
//   npx tsx scripts/fetch-web-sources.ts --list   # 列出可用源
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Edge headless 打印（绕过 web_to_pdf.py 的 virtual-time-budget 问题）
const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
];

function findBrowser(): string {
  if (process.env.PDF_ENGINE_PATH) return process.env.PDF_ENGINE_PATH;
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("未找到 Edge/Chrome，请设置 PDF_ENGINE_PATH");
}

function printToPdf(browser: string, url: string, outpath: string, extraArgs: string[] = []): { ok: boolean; size: number; error?: string } {
  const tmpDir = path.join(os.tmpdir(), `.edge_tmp_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tryPrint = (args: string[]): boolean => {
    const child = spawn(browser, [
      "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
      ...args,
      `--user-data-dir=${tmpDir}`,
      `--print-to-pdf=${outpath}`,
      url
    ], { stdio: "ignore" });
    child.unref();
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      if (fs.existsSync(outpath) && fs.statSync(outpath).size > 10 * 1024) {
        return true;
      }
      const waitUntil = Date.now() + 1000;
      while (Date.now() < waitUntil) { /* 忙等 */ }
    }
    return false;
  };
  try {
    // 自适应：先无参试，失败则加 virtual-time-budget（JS 渲染站点需要）
    if (tryPrint(extraArgs)) {
      return { ok: true, size: fs.statSync(outpath).size };
    }
    if (extraArgs.length === 0 && tryPrint(["--virtual-time-budget=20000"])) {
      return { ok: true, size: fs.statSync(outpath).size };
    }
    return { ok: false, size: 0, error: "PDF 未在 30s 内生成（可能 JS 渲染或加载慢）" };
  } catch (error) {
    return { ok: false, size: 0, error: error instanceof Error ? error.message.slice(0, 100) : String(error) };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

// 网页类源配置
// - directUrls: 直接可抓的静态单篇 URL（Edge headless 可打印）
// - needsCDP: true = 需 web-access CDP（JS 动态/需登录），脚本会提示
// - outDir: 相对政策库的子目录
const WEB_SOURCES: Record<string, {
  name: string;
  directUrls?: string[];
  needsCDP?: boolean;
  outDir: string;
}> = {
  jhsjk: {
    name: "习近平系列重要讲话数据库",
    needsCDP: true,   // JS 动态检索，需 CDP
    outDir: "02-习近平论述摘编"
  },
  qstheory: {
    name: "求是网",
    directUrls: [
      "https://www.qstheory.cn/20260801/fc9a337ca3a84cc1bcb5811a3e82c7d6/c.html"  // 存量加增量释放政策集成效应
    ],
    outDir: "03-党的思想理论读物"
  },
  people_theory: {
    name: "人民日报理论版",
    directUrls: [
      "http://theory.people.com.cn/n1/2026/0730/c40531-40770838.html"  // 人民日报理论文章示例
    ],
    outDir: "03-党的思想理论读物"
  },
  mia: {
    name: "MIA 中文马克思主义文库",
    directUrls: [
      "https://www.marxists.org/chinese/marx-engels2/index.htm"
    ],
    outDir: "04-政治经济学理论著作"
  },
  gov_policy: {
    name: "gov.cn 政策正文（静态可抓）",
    directUrls: [
      "https://www.gov.cn/zhengce/zhengceku/202606/content_7070902.htm"  // 农业农村现代化"十五五"规划
    ],
    outDir: "课题配套政策文件"
  }
};

const POLICY_DIR = process.env.POLICY_DIR || "E:\\1.Obsidian Vault\\课题研究\\1.农业农村现代化进程中规范与引导工商资本路径研究\\著作、政策、会议";

function parseArgs(argv: string[]): { source?: string; query?: string; out?: string; list?: boolean } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1] ?? "true";
      i += 1;
    }
  }
  return {
    source: args.source,
    query: args.query,
    out: args.out,
    list: args.list === "true"
  };
}

function main(): void {
  const { source, query, out, list } = parseArgs(process.argv.slice(2));

  if (list) {
    console.log("可用网页类源：");
    for (const [key, val] of Object.entries(WEB_SOURCES)) {
      const mode = val.needsCDP ? "[需CDP]" : `[静态可抓 ${val.directUrls?.length ?? 0}篇]`;
      console.log(`  ${key}: ${val.name} ${mode} → ${val.outDir}`);
    }
    return;
  }

  if (!source || !WEB_SOURCES[source]) {
    console.error(`用法错误：未知源 '${source}'。可用源见 --list`);
    process.exit(1);
  }

  const src = WEB_SOURCES[source];
  const targetDir = out || path.join(POLICY_DIR, src.outDir);
  fs.mkdirSync(targetDir, { recursive: true });

  // 需 CDP 的源：提示用 web-access
  if (src.needsCDP) {
    console.log(`⚠️  ${src.name} 是 JS 动态/需登录站点，Edge headless 无法直接抓取。`);
    console.log("   请用 web-access skill 的 CDP 方案（有登录态、能等 JS 渲染）抓取。");
    console.log("   抓到的网页可用 pdf-web-download 转 PDF 后入库。");
    process.exit(0);
  }

  // 静态可抓：抓取 directUrls
  const urls = src.directUrls ?? [];
  if (urls.length === 0) {
    console.error(`❌ ${src.name} 未配置可抓取 URL`);
    process.exit(1);
  }

  console.log(`=== 抓取 ${src.name}（${urls.length} 篇）===`);
  let ok = 0;
  let fail = 0;
  const browser = findBrowser();

  for (const [index, url] of urls.entries()) {
    const safeName = url.split("/").pop()?.replace(/\.[^.]+$/, "") || `item_${index}`;
    const outpath = path.join(targetDir, `${source}-${safeName.slice(-40)}.pdf`);
    if (fs.existsSync(outpath) && fs.statSync(outpath).size > 10 * 1024) {
      console.log(`  [跳过] ${safeName.slice(-30)}`);
      ok += 1;
      continue;
    }
    const result = printToPdf(browser, url, outpath);
    if (result.ok) {
      console.log(`  [${index + 1}/${urls.length}] ✅ ${safeName.slice(-30)} (${(result.size / 1024).toFixed(1)}KB)`);
      ok += 1;
    } else {
      console.log(`  [${index + 1}/${urls.length}] ❌ ${safeName.slice(-30)}: ${result.error}`);
      fail += 1;
    }
  }

  console.log(`\n完成 ${ok}/${urls.length}，失败 ${fail}`);
  if (fail > 0) process.exit(1);
}

main();
