// py-path.test.ts — Python 解释器定位的回归测试
//
// 由来: 六个服务各自写死 `<cwd>/.venv-fmtcheck/Scripts/python.exe`(Windows 布局),
//       Linux/macOS 的 venv 是 bin/python —— venv 明明装了也会静默退回系统 python,
//       再因为缺 python-docx 而在很靠后的地方失败。这里锁住两种布局都能认出来。
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePython } from "../src/services/py-path.js";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pypath-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Windows 占用 */ } }
});

/** 造一个 venv 目录: `bin/python3`(POSIX) 或 `Scripts/python.exe`(Windows); exe=false 时只建目录不建可执行文件 */
function makeVenv(root: string, layout: "posix" | "win", exe = true): void {
  const venv = path.join(root, ".venv-fmtcheck");
  const rel = layout === "posix" ? ["bin", "python3"] : ["Scripts", "python.exe"];
  fs.mkdirSync(path.join(venv, rel[0]), { recursive: true });
  if (exe) fs.writeFileSync(path.join(venv, ...rel), "");
}

/** 在指定目录下求值(venv 解析按 cwd 找, 所以必须切目录) */
function inDir<T>(dir: string, fn: () => T): T {
  const cwd = process.cwd();
  try { process.chdir(dir); return fn(); } finally { process.chdir(cwd); }
}

describe("py-path: venv 布局", () => {
  it("当前平台的 venv 布局能找到(装了才返回, 没装返回 null)", () => {
    const root = tmp();
    makeVenv(root, process.platform === "win32" ? "win" : "posix");
    const expected = process.platform === "win32"
      ? path.join(root, ".venv-fmtcheck", "Scripts", "python.exe")
      : path.join(root, ".venv-fmtcheck", "bin", "python3");
    expect(inDir(root, () => resolvePython())).toBe(expected);
  });

  it("只有空目录不算找到(不能凭目录存在就判为可用)", () => {
    const root = tmp();
    makeVenv(root, process.platform === "win32" ? "win" : "posix", false);
    expect(inDir(root, () => resolvePython())).toBe(process.platform === "win32" ? "python" : "python3");
  });

  it("没有 venv 时退回平台默认名", () => {
    const root = tmp();
    expect(inDir(root, () => resolvePython())).toBe(process.platform === "win32" ? "python" : "python3");
  });
});

describe("py-path: 解释器优先级", () => {
  it("环境变量显式指定优先于 venv", () => {
    const root = tmp();
    makeVenv(root, process.platform === "win32" ? "win" : "posix");
    const saved = process.env.PY_PATH_TEST;
    process.env.PY_PATH_TEST = "X:/explicit/python";
    try {
      expect(inDir(root, () => resolvePython({ envKeys: ["PY_PATH_TEST"] }))).toBe("X:/explicit/python");
    } finally {
      if (saved === undefined) delete process.env.PY_PATH_TEST; else process.env.PY_PATH_TEST = saved;
    }
  });
});

