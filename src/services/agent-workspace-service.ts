// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// agent-workspace-service.ts — 把素材**推进** agent_workspace(2026-10-02)
//
// ═══ 为什么要有这个服务 ═══
//
// 2026-10-01 给沙箱补了工作区围栏(见 code-sandbox-service 的 codeEscapesWorkspace):
// `workspace-write` 下不再允许引用工作区之外的路径 —— 此前实测**能写进平台自己的
// src/ 源码目录**, 而那让 `execute` 步骤名义上的"生成一份文件"实际变成"整个文件系统可写"。
//
// 围栏带来一个必须回答的问题: **模型要怎么拿到它该用的素材?**
//   · 论文配图、实证图表在各自模块的目录里(绝对路径);
//   · 模型现在不能直接引用它们了。
//
// 当时在注释里写下的取舍是"**不要靠放宽规则, 把素材推进工作区**"。
// 这个服务就是那句话的实现 —— 把该用的文件**复制**进工作区, 模型只用相对路径取。
//
// ═══ 三条刻意的选择 ═══
//
// ① **只复制, 不移动**。源文件属于别的模块(实证工作台的产出、用户的附件),
//    移动过去会把那些模块的产物掏空。复制一份, 用完随工作区一起清。
//
// ② **只认白名单扩展名**。这是"素材", 不是"任意文件搬运" ——
//    不设白名单的话, 这个接口就成了"把任意路径下的任意文件搬进沙箱"的搬运工,
//    围栏等于白加。
//
// ③ **单文件与总量都设上限**。工作区是临时目录, 塞几百 MB 的附件进来会拖垮沙箱。
//    超限如实拒绝并说明, 不静默截断(截断的图放进幻灯片, 用户只会觉得"图坏了")。
import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./storage-paths.js";

/** 允许作为素材搬进工作区的类型 —— 图片优先(幻灯片配图), 外加常见的论文配图格式 */
const ALLOWED_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "csv", "tsv", "xlsx"]);
/** 单文件上限 25MB; 一次调用总量上限 100MB */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export function workspaceAssetsDir(): string {
  return path.join(dataPath("agent_workspace"), "assets");
}

export interface StageResult {
  ok: boolean;
  /** 成功搬进来的: 工作区内的**相对路径**(模型就用这个引用) + 原始大小 */
  staged: Array<{ rel: string; bytes: number; from: string }>;
  /** 被拒的, 带原因 */
  rejected: Array<{ from: string; reason: string }>;
}

/**
 * 把一批绝对路径的文件复制进工作区的 `assets/`。
 *
 * @param files 源文件的绝对路径(调用方负责确认它们确实该给这个任务用)
 */
export function stageAssetsIntoWorkspace(files: string[]): StageResult {
  const out: StageResult = { ok: true, staged: [], rejected: [] };
  if (!files.length) return out;
  const dir = workspaceAssetsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, staged: [], rejected: [{ from: "(assets 目录)", reason: `创建失败: ${String((e as Error).message)}` }] };
  }

  let total = 0;
  const used = new Set<string>(fs.readdirSync(dir));
  for (const src of files) {
    const from = String(src || "");
    if (!from) continue;
    const ext = path.extname(from).slice(1).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      out.rejected.push({ from, reason: `不支持的素材类型 .${ext}（允许: ${[...ALLOWED_EXT].join("/")}）` });
      continue;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(from);
      if (!st.isFile()) { out.rejected.push({ from, reason: "不是文件" }); continue; }
    } catch {
      out.rejected.push({ from, reason: "文件不存在或不可读" });
      continue;
    }
    if (st.size > MAX_FILE_BYTES) {
      out.rejected.push({ from, reason: `单文件 ${(st.size / 1048576).toFixed(1)}MB 超过 ${MAX_FILE_BYTES / 1048576}MB 上限` });
      continue;
    }
    if (total + st.size > MAX_TOTAL_BYTES) {
      out.rejected.push({ from, reason: `总量将超过 ${MAX_TOTAL_BYTES / 1048576}MB 上限` });
      continue;
    }
    /**
     * 目标名去重 —— 但要**幂等**。
     *
     * 同名文件在真实场景里很常见(实证工作台每次跑的图都叫 `run_ols_<ts>.png`),
     * 直接覆盖会让模型引用到**另一张图**且毫无迹象, 所以撞名要加序号。
     *
     * ⚠ 但"撞名就加序号"不能是无条件的: 同一个任务里**重复推进同一批素材**是常态
     *   (每个 execute 步骤都可能触发一次), 无条件加序号会造出 `fig.png`、`fig-2.png`、
     *   `fig-3.png` 一串副本 —— 模型随便挑一个, 而它们内容完全一样, 白占空间还让人困惑。
     *   判据是**同名且同大小**视为"已经推过了", 直接跳过。
     */
    const base = path.basename(from);
    const existing = path.join(dir, base);
    if (used.has(base)) {
      try {
        if (fs.statSync(existing).size === st.size) continue;   // 已推过, 幂等跳过
      } catch { /* 读不到就往下走去重 */ }
    }
    const stem = path.basename(base, path.extname(base)).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
    let name = base;
    let i = 2;
    while (used.has(name)) name = `${stem}-${i++}${path.extname(base)}`;
    const dest = path.join(dir, name);
    try {
      fs.copyFileSync(from, dest);
      used.add(name);
      total += st.size;
      out.staged.push({ rel: `assets/${name}`, bytes: st.size, from });
    } catch (e) {
      out.rejected.push({ from, reason: `复制失败: ${String((e as Error).message).slice(0, 100)}` });
    }
  }
  if (!out.staged.length && out.rejected.length) out.ok = false;
  return out;
}

/** 工作区里现成的素材(相对路径) —— 供提示注入时告诉模型"有什么可用" */
export function listWorkspaceAssets(): Array<{ rel: string; bytes: number }> {
  const dir = workspaceAssetsDir();
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ rel: string; bytes: number }> = [];
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(".")) continue;
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.isFile()) out.push({ rel: `assets/${f}`, bytes: st.size });
    } catch { /* 单个文件读不到不影响整体 */ }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 一键把工作区里的素材描述成给模型看的一段话(没有素材时返回空串) */
export function describeWorkspaceAssets(): string {
  const list = listWorkspaceAssets();
  if (!list.length) return "";
  return list.map((a) => `  · ${a.rel}（${(a.bytes / 1024).toFixed(0)}KB）`).join("\n");
}
