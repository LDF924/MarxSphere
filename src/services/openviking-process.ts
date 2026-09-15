// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// openviking-process.ts — V417: OpenViking 进程拉起(前端"一键激活"用)
//
// 由来(2026-09-15): 原先靠 schtasks 每 5 分钟探活拉起 —— 太频繁, 而且探活脚本跑在
//   计划任务里, 用户无从感知。改为**前端一键拉起**: 记忆面板检测到 1933 离线就显示按钮,
//   点击调 POST /api/memory/openviking/start, 由 SAG 进程把 OpenViking 拉起来。
//
// 必须处理的坑(当天实测): OpenViking 初始化失败时**进程不退出** —— 它抢到 vectordb 的
//   LOCK 后卡住, 端口不监听。此时直接再拉一个新实例必然 LOCK 冲突失败。所以拉起流程是:
//   ① 杀掉残留的 openviking-server(只杀它, 不碰 python/cognee 相关进程)
//   ② 等句柄释放 → 启动 → 轮询等 1933 监听(最长 40s)
//
// 权限: 端点本身限本机或 admin(见 server.ts)。拉起动作在服务进程所在机器上执行,
//   配置从 SAG 自己的环境变量推导, 与 scripts/sag-process-watchdog.sh 的规则一致。
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);
const OV_PORT = 1933;
const HOME = os.homedir();

/** 1933 是否已在监听 */
export async function isOpenvikingListening(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano"], { windowsHide: true, timeout: 10_000 });
    return stdout.split("\n").some((l) => l.includes(`:${OV_PORT}`) && /LISTENING/i.test(l));
  } catch {
    return false;
  }
}

/** 可执行文件路径(SAG 环境变量 > 默认 cognee venv) */
function openvikingBin(): string {
  return process.env.COGNEE_PY
    || join(process.env.COGNEE_HOME || join(HOME, "cognee"), ".venv312", "Scripts", "openviking-server.exe");
}

/** 配置文件路径 */
function openvikingConf(): string {
  return process.env.OPENVIKING_HOME
    ? join(process.env.OPENVIKING_HOME, ".openviking", "ov.conf")
    : join(HOME, ".openviking", "ov.conf");
}

/** 杀掉残留的 openviking-server 进程(只按镜像名匹配, 不误伤其他 python) */
async function killStaleOpenviking(): Promise<void> {
  try {
    await execFileAsync("taskkill", ["/IM", "openviking-server.exe", "/F"], { windowsHide: true, timeout: 15_000 });
  } catch { /* 没有残留进程时 taskkill 非零退出, 属正常 */ }
  await new Promise((r) => setTimeout(r, 2500));  // 等 LOCK 句柄释放
}

export interface StartOpenvikingResult {
  ok: boolean;
  /** 已监听 / 刚拉起 / 起不来 */
  outcome: "already_running" | "started" | "failed";
  error?: string;
  waitedMs?: number;
}

/**
 * 拉起 OpenViking 并确认 1933 真的监听。
 * 幂等: 已经在跑就直接返回, 不重启。
 */
export async function startOpenviking(): Promise<StartOpenvikingResult> {
  if (await isOpenvikingListening()) return { ok: true, outcome: "already_running" };

  const bin = openvikingBin();
  const conf = openvikingConf();
  if (!existsSync(bin)) return { ok: false, outcome: "failed", error: `OpenViking 可执行文件不存在: ${bin}` };
  if (!existsSync(conf)) return { ok: false, outcome: "failed", error: `OpenViking 配置不存在: ${conf}` };

  // ① 清残留(防 LOCK 占用导致拉起必失败)
  await killStaleOpenviking();

  // ② 启动(脱离 SAG 进程, 与看门狗脚本同款)
  const child = spawn(bin, ["--config", conf], {
    cwd: HOME,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  // ③ 等端口监听(最多 40s; 初始化要读向量库)
  const startedAt = Date.now();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isOpenvikingListening()) {
      return { ok: true, outcome: "started", waitedMs: Date.now() - startedAt };
    }
  }
  return { ok: false, outcome: "failed", error: `40s 内 ${OV_PORT} 仍未监听, 见 ~/openviking_data/ov-serve.log`, waitedMs: Date.now() - startedAt };
}
