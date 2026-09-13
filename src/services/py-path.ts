// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// py-path.ts — 解析要用的 Python 解释器
//
// 由来: 多个服务各自写死 `<cwd>/.venv-fmtcheck/Scripts/python.exe` —— 那是 Windows 的
//   venv 布局; Linux/macOS 的 venv 是 `bin/python`, 于是在非 Windows 上"venv 明明装了"
//   也会静默退回系统 python, 再因为缺 python-docx 之类的依赖而失败(报错还很靠后)。
//   Windows 上 venv 的 Scripts/ 里也有 python(无 .exe 后缀)的软链, 所以两个名字都要试。
import fs from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";

/** 判断一个候选是不是可用的 Python(文件或软链; Windows 上 .exe 之外还认无后缀的软链) */
function usable(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** 一个 venv 里 python 可能出现的位置(Windows 的 Scripts/ 里也有无后缀的软链, 两个都试) */
function pythonCandidates(venvRoot: string, win = IS_WIN): string[] {
  return win
    ? [path.join(venvRoot, "Scripts", "python.exe"), path.join(venvRoot, "Scripts", "python")]
    : [path.join(venvRoot, "bin", "python3"), path.join(venvRoot, "bin", "python")];
}

/**
 * 项目内 venv 的 Python: 按目录名逐个找, 命中即返回(找不到返回 null)。
 * 同时兼容 Windows(Scripts/python.exe)与 POSIX(bin/python)两种布局。
 */
function venvPython(venvNames: string[] = [".venv-fmtcheck"]): string | null {
  for (const name of venvNames) {
    for (const c of pythonCandidates(path.resolve(process.cwd(), name))) if (usable(c)) return c;
  }
  return null;
}

/**
 * 实际要执行的解释器: 环境变量显式指定 > 项目 venv > PATH 上的 python。
 * envKeys 用来认"这个场景已经被别的模块用哪个变量配过了"(如 EMPIRICAL_PYTHON /
 * SAG_SANDBOX_PYTHON); 最后一个兜底名按平台给。
 */
export function resolvePython({ envKeys = [], venvNames = [".venv-fmtcheck"] }: { envKeys?: string[]; venvNames?: string[] } = {}): string {
  for (const k of envKeys) {
    const v = process.env[k];
    if (v) return v;
  }
  return venvPython(venvNames) ?? (IS_WIN ? "python" : "python3");
}
