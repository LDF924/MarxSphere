// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// kb-paths.ts — 知识库(Obsidian 资料库/文献库/政策库)根目录的统一入口
//
// 由来(2026-09-11 上云审计): 三套知识库服务各自硬编码 `os.homedir()/1.Obsidian Vault`,
// 且**三处默认值互不一致**(literature 用带括注的目录名, vault 白名单里另一套)。
// 单机是用户自己的盘, 没问题; 一上云主机, `~/1.Obsidian Vault` 根本不存在 ——
// 表现为"知识库整体为空", 且没有任何提示, 用户以为是自己没传数据。
//
// 现在统一解析 + 缺省回退:
//   ① 环境变量显式配置(VAULT_ROOT / LITERATURE_DIR / POLICY_DIR)
//   ② 否则落到**数据根**下的 kb/ 目录(随 DATA_DIR 走共享卷, 容器可挂载)
//   ③ 都不存在时, 服务照常启动, 由 startup-check 给出"未挂载知识库"的明确提示
//
// 云端做法: 把 NFS/PVC 挂到 DATA_DIR/kb/{vault,journal,papers,policy} 即可, 代码不用改。
import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./storage-paths.js";

/** 是否配了外部知识库(环境变量形式)。用于启动自检区分"用户没挂"与"路径写错"。 */
export function hasExternalKbRoots(): boolean {
  return Boolean(process.env.VAULT_ROOT || process.env.LITERATURE_DIR || process.env.POLICY_DIR);
}

/**
 * Obsidian 资料库根。未配置时回退到 <数据根>/kb/vault。
 * 注意: 回退目录**不保证存在** —— 调用方必须容忍空目录(既有的 getTree 都返回空树)。
 */
export function vaultRoot(): string {
  return process.env.VAULT_ROOT || dataPath("kb", "vault");
}

/** 学术期刊文献库根(题录 + Markdown 正文)。未配置时回退 <数据根>/kb/journal。 */
export function literatureDir(): string {
  return process.env.LITERATURE_DIR || dataPath("kb", "journal");
}

/** 政策资料库根。未配置时回退 <数据根>/kb/policy。 */
export function policyDir(): string {
  return process.env.POLICY_DIR || dataPath("kb", "policy");
}

/** PDF2Obsidian 的导入落点根(ov_import 那种论文目录)。未配置时回退 <数据根>/kb/ov_import。 */
export function ovImportDir(): string {
  return process.env.P2O_VAULT_PATH || dataPath("kb", "ov_import");
}

/** P2O 导出时的主题子目录名(可配; 默认沿用既有的"资本规范与引导、资本治理") */
export function p2oDocumentDir(): string {
  return process.env.P2O_DOCUMENT_DIR || "资本规范与引导、资本治理";
}

/** 目录是否存在且是目录(知识库各处共用的容错判断) */
export function kbDirExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 知识库是否已挂载(任一子库存在即算) */
export function anyKbMounted(): boolean {
  return kbDirExists(vaultRoot()) || kbDirExists(literatureDir()) || kbDirExists(policyDir());
}

/**
 * 启动自检用的可读描述: 未配置且回退目录不存在时, 明确说是"没挂载"而不是"路径写错"。
 * 返回 null 表示知识库可用。
 */
export function describeKbAvailability(): { ok: boolean; detail: string } {
  const roots: Array<[string, string]> = [
    ["VAULT_ROOT", vaultRoot()],
    ["LITERATURE_DIR", literatureDir()],
    ["POLICY_DIR", policyDir()],
  ];
  const missing = roots.filter(([, p]) => !kbDirExists(p));
  if (missing.length === 0) return { ok: true, detail: "三套知识库均已挂载" };
  if (hasExternalKbRoots()) {
    return {
      ok: false,
      detail: `${missing.map(([n, p]) => `${n}=${p}`).join("; ")} 不存在 — 请在 .env 修正路径`,
    };
  }
  return {
    ok: false,
    detail: `未挂载知识库(默认位置 ${dataPath("kb")})— 资料库/文献库/政策库页面将为空。`
      + `云端请把 NFS/PVC 挂到该目录, 或分别设 VAULT_ROOT/LITERATURE_DIR/POLICY_DIR`,
  };
}

export function ensureKbRoot(p: string): void {
  try {
    fs.mkdirSync(path.join(p), { recursive: true });
  } catch {
    /* 只读挂载/无权限 → 调用方自行处理空目录 */
  }
}

/**
 * Neo4j 图库主机。默认 127.0.0.1(与本机 docker compose 一致), 跨机部署
 * (图库独立成服务 / K8s Service)设 NEO4J_HOST 即可。
 * 端口仍由各调用点传入 —— Graphiti 11001 / Cognee 11003 是固定约定。
 */
export function neo4jHost(): string {
  return process.env.NEO4J_HOST || "127.0.0.1";
}

/** Neo4j bolt 地址: `bolt://<host>:<port>` */
export function neo4jBoltUrl(port: number | string): string {
  return `bolt://${neo4jHost()}:${port}`;
}
