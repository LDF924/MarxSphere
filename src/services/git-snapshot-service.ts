// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// git-snapshot-service.ts — 会话 git 无痕快照(移植 ai4s-research/open-science git_snapshot.rs, MIT)
// 机制: 用专用 index(git/sag-snapshot-index) + 专用 ref(refs/openscience/snapshots/<branch>)
// 提交工作区 → 绝不碰用户分支/HEAD/真实暂存区。大文件(>10MB)排除。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

const SNAPSHOT_REF_PREFIX = "refs/openscience/snapshots";
const SNAPSHOT_INDEX = "sag-snapshot-index";
const MAX_FILE_BYTES = 10 * 1024 * 1024; // ≥10MB 不进快照

function baseArgs(root: string): string[] {
  const gitDir = path.join(root, ".git");
  return ["--git-dir", gitDir, "--work-tree", root];
}

/** 判断仓库是否有未提交变更 */
export async function hasChanges(root?: string): Promise<boolean> {
  try {
    const dir = root || process.env.SAG_ROOT || process.cwd();
    const { stdout } = await execFileAsync("git", [...baseArgs(dir), "status", "--porcelain"], { timeout: 60_000, windowsHide: true });
    return stdout.trim().length > 0;
  } catch { return false; }
}

/** 执行一次无痕快照: 工作区 → refs/openscience/snapshots/<branch> (专用 index, 不碰用户状态) */
export async function snapshotWorkspace(root?: string, label?: string): Promise<{
  ok: boolean; error?: string; ref?: string; commit?: string; files?: number;
}> {
  const dir = root || process.env.SAG_ROOT || process.cwd();
  const gitDir = path.join(dir, ".git");
  if (!existsSync(gitDir)) return { ok: false, error: "非 git 仓库, 跳过快照" };
  const indexFile = path.join(gitDir, SNAPSHOT_INDEX);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile } as Record<string, string>;
  const run = (args: string[], timeout = 120_000) =>
    execFileAsync("git", [...baseArgs(dir), ...args], { timeout, windowsHide: true, env });
  try {
    // 0) 当前分支名
    let branch = "detached";
    try { branch = (await run(["symbolic-ref", "--short", "HEAD"], 15_000)).stdout.trim() || "detached"; } catch { /* detached */ }
    const snapshotRef = `${SNAPSHOT_REF_PREFIX}/${branch}`;
    // 1) 专用 index 从 HEAD 重置后全量 add
    await run(["read-tree", "HEAD"]).catch(() => { /* 无 HEAD(空仓)忽略 */ });
    await run(["add", "-A"]);
    // 大文件排除(>10MB 出 index)
    try {
      const stagedFiles = (await run(["diff", "--cached", "--name-only"], 30_000)).stdout.split("\n").filter(Boolean);
      const big: string[] = [];
      for (const f of stagedFiles) {
        try {
          const { stdout: sz } = await execFileAsync("git", [...baseArgs(dir), "cat-file", "-s", `:${f}`], { timeout: 15_000, windowsHide: true, env });
          if (Number(sz) > MAX_FILE_BYTES) big.push(f);
        } catch { /* 单个失败忽略 */ }
      }
      if (big.length > 0) await run(["rm", "--cached", "--", ...big], 30_000);
    } catch { /* 排除失败不阻断 */ }
    // 2) staged 变更?
    const staged = (await run(["diff", "--cached", "--name-only"], 30_000)).stdout;
    if (!staged.trim()) return { ok: true, ref: snapshotRef, files: 0 };
    // 3) 写树对象 + commit-tree 挂到上一快照(无则孤儿提交)
    const tree = (await run(["write-tree"], 30_000)).stdout.trim();
    let parent: string | null = null;
    try { parent = (await run(["rev-parse", "--verify", snapshotRef], 15_000)).stdout.trim() || null; } catch { parent = null; }
    const msg = label ? `snapshot: ${label}` : `snapshot: ${new Date().toISOString()}`;
    const commitArgs = ["commit-tree", tree, "-m", msg];
    if (parent) commitArgs.push("-p", parent);
    const commit = (await run(commitArgs, 30_000)).stdout.trim();
    // 4) 更新专用 ref(不动 HEAD/分支)
    await run(["update-ref", snapshotRef, commit], 15_000);
    // 5) 清理专用 index 的暂存, 避免下次脏状态
    await run(["read-tree", "--empty"], 15_000).catch(() => {});
    return { ok: true, ref: snapshotRef, commit: commit.slice(0, 7), files: staged.split("\n").length };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

/** 快照历史: git log refs/openscience/snapshots/<branch> */
export async function snapshotHistory(root?: string): Promise<Array<{ commit: string; msg: string }>> {
  const dir = root || process.env.SAG_ROOT || process.cwd();
  try {
    let branch = "detached";
    try { branch = (await execFileAsync("git", [...baseArgs(dir), "symbolic-ref", "--short", "HEAD"], { timeout: 15_000, windowsHide: true })).stdout.trim() || "detached"; } catch { /* detached */ }
    const ref = `${SNAPSHOT_REF_PREFIX}/${branch}`;
    const { stdout } = await execFileAsync("git", [...baseArgs(dir), "log", "--format=%h|%s", "-10", ref], { timeout: 30_000, windowsHide: true });
    return stdout.split("\n").filter(Boolean).map((l) => {
      const i = l.indexOf("|");
      return { commit: l.slice(0, i), msg: l.slice(i + 1) };
    });
  } catch { return []; }
}
