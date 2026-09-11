// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// storage-paths.ts — 运行期数据目录的统一入口
//
// 由来(2026-09-11 多实例审计): 全仓有 40+ 处直接拼 `SAG_ROOT/data/xxx`。单机没问题,
// 但一上多副本 + 负载均衡, A 副本写进去的图/文件/工作区在 B 副本上读不到 —— 表现为
// 图表 404、附件"文件不存在"、绘图任务悄悄退回"示意图"(最坏的一条: 坏链会被写进用户正文)。
//
// 用法: 把所有 `path.join(SAG_ROOT, "data", ...)` 换成 `dataPath(...)`。
// 云端只要把 DATA_DIR 指向**共享卷**(NFS / K8s PVC / 对象存储挂载点)即可, 代码不用再改。
//
// 环境变量:
//   DATA_DIR     数据根(默认 <SAG_ROOT>/data)。多副本部署时指向共享存储。
//   SAG_ROOT     项目根(既有语义, 保持不变)
//
// 注意: SAG_ROOT 保持"每次调用时解析"——测试会临时改这个环境变量来隔离目录。
import path from "node:path";

/** 项目根(每次读取, 便于测试覆盖) */
export function projectRoot(): string {
  return process.env.SAG_ROOT || process.cwd();
}

/**
 * 数据根目录。多副本部署把它指向共享卷(如 /mnt/shared/sag-data 或 PVC 挂载点)。
 * 未设置 DATA_DIR 时退回 <SAG_ROOT>/data —— 与既有行为完全一致, 单机零改动。
 */
export function dataRoot(): string {
  return process.env.DATA_DIR || path.join(projectRoot(), "data");
}

/** 数据根下的路径:`dataPath("viz-files", userId, name)` */
export function dataPath(...parts: string[]): string {
  return path.join(dataRoot(), ...parts);
}

/** 是否配了共享数据根(用于启动自检提示多副本风险) */
export function hasSharedDataRoot(): boolean {
  return Boolean(process.env.DATA_DIR);
}

/**
 * 把库里存的 storage_rel 解析成绝对路径。
 * 历史数据存成 `data/user-files/<uid>/x.bin`(相对 SAG_ROOT), 新写入存成
 * `user-files/<uid>/x.bin`(相对数据根)。两种都要能读 —— 否则改完 DATA_DIR 老数据全失效。
 */
export function resolveStoredRel(rel: string): string {
  const clean = String(rel ?? "")
    .replace(/^[\\/]+/, "")
    .replace(/^data[\\/]/, "");
  return path.join(dataRoot(), clean);
}
