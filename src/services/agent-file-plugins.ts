// agent-file-plugins.ts — 架构A1: 文件目录插件 + 热加载
// plugins/ 目录下的 .ts 文件 = 插件模块（导出 tools 数组）
// fs.watch 监听 → 新增/修改/删除插件文件自动重载（无需重启服务）
// 对齐 DSH Cordis: 插件即文件, 可热插拔
import { promises as fsP } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolDef } from "./agent-tool-router.js";

/** 插件目录（SAG_ROOT/plugins; AGENT_PLUGINS_DIR 覆盖） */
export function pluginsDir(): string {
  return process.env.AGENT_PLUGINS_DIR
    || path.join(process.env.SAG_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "plugins");
}

/** 已加载插件缓存: fileName → tools */
const loadedPlugins = new Map<string, AgentToolDef[]>();
let watcherStarted = false;

// ═══ #10: 插件签名校验 — 哈希白名单（防恶意插件替换）═══
// AGENT_PLUGIN_SIGNATURES="demo-calculator.ts:sha256hex,..." 配置可信哈希;
// 未配置 → 首次加载提示, 但允许（开发模式）; 配置后不匹配 → 拒绝加载
import { createHash } from "node:crypto";

/** 计算插件文件哈希（sha256） */
export async function hashPluginFile(fileName: string): Promise<string> {
  const file = path.join(pluginsDir(), fileName);
  const content = await fsP.readFile(file, "utf8");
  return createHash("sha256").update(content).digest("hex");
}

/** 校验插件签名: 配置了白名单则必须匹配; 未配置放行（开发模式） */
export async function verifyPluginSignature(fileName: string): Promise<{ ok: boolean; reason?: string }> {
  const raw = process.env.AGENT_PLUGIN_SIGNATURES;
  if (!raw?.trim()) return { ok: true };  // 未配置 → 放行
  const whitelist = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const [name, hash] = entry.trim().split(":");
    if (name && hash) whitelist.set(name, hash);
  }
  const expected = whitelist.get(fileName);
  if (!expected) return { ok: false, reason: `插件 ${fileName} 不在签名白名单（AGENT_PLUGIN_SIGNATURES 配置）` };
  const actual = await hashPluginFile(fileName);
  if (actual !== expected) return { ok: false, reason: `插件 ${fileName} 签名不匹配（文件可能被篡改）` };
  return { ok: true };
}

/** 从插件文件加载工具（缓存; 模块解析失败返回空; #10: 签名校验） */
export async function loadPluginFile(fileName: string): Promise<AgentToolDef[]> {
  const file = path.join(pluginsDir(), fileName);
  try {
    // #10: 签名校验（失败拒绝加载）
    const sig = await verifyPluginSignature(fileName);
    if (!sig.ok) {
      console.error(`[agent] #10 插件签名拦截: ${sig.reason}`);
      return [];
    }
    const url = pathToFileURL(file).href;
    // 缓存破坏: 时间戳后缀防 ESM 缓存（热加载关键）
    const mod = await import(`${url}?t=${Date.now()}`);
    const tools: AgentToolDef[] = Array.isArray(mod?.tools) ? mod.tools : [];
    if (tools.length > 0) {
      loadedPlugins.set(fileName, tools);
      console.log(`[agent] 架构A1 插件加载: ${fileName} (${tools.length} 工具)${process.env.AGENT_PLUGIN_SIGNATURES ? " [签名✓]" : " [未配置签名]"}`);
    }
    return tools;
  } catch (e: any) {
    console.error(`[agent] 架构A1 插件加载失败 ${fileName}:`, String(e?.message || e).slice(0, 100));
    return [];
  }
}

/** 扫描 plugins/ 目录全部插件工具（buildAgentTools 调用） */
export async function collectFilePluginTools(): Promise<AgentToolDef[]> {
  const all: AgentToolDef[] = [];
  try {
    const dir = pluginsDir();
    await fsP.mkdir(dir, { recursive: true });
    const files = (await fsP.readdir(dir)).filter((f) => f.endsWith(".ts") && !f.startsWith("."));
    for (const f of files.sort()) {
      const tools = await loadPluginFile(f);
      all.push(...tools);
    }
  } catch { /* 目录不可用 → 空 */ }
  return all;
}

/** 启动热加载监听（fs.watch 回调式; 新增/修改/删除插件文件自动重载） */
export function startPluginWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;
  const dir = pluginsDir();
  fsP.mkdir(dir, { recursive: true }).catch(() => {});
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.watch(dir, (eventType, fileName) => {
      if (!fileName || !String(fileName).endsWith(".ts") || String(fileName).startsWith(".")) return;
      console.log(`[agent] 架构A1 插件文件变更: ${String(fileName)} (${eventType}) — 自动重载`);
      loadedPlugins.delete(String(fileName));
      void loadPluginFile(String(fileName));
    });
    console.log(`[agent] 架构A1 插件热加载已启动 (监听 ${dir})`);
  } catch (e: any) {
    console.error("[agent] 架构A1 插件监听失败:", String(e?.message || e).slice(0, 100));
  }
}

function pathToFileURL(p: string): URL {
  return new URL("file://" + p.replace(/\\/g, "/").replace(/^\/?/, "/"));
}
