// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// python-health-service.ts — Python 运行时的统一自检(2026-10-02)
//
// 由来: 本仓有 **5 条互不相干**的 Python 探测路径, 各自回答同一个问题:
//   · `py-path.ts:41` resolvePython() —— 只解析路径, 不验证能不能跑;
//   · `code-sandbox-service.ts:140` detectPythonExe() —— 模块加载时定一次的常量;
//   · `empirical-service.ts:320` getEmpiricalMeta() —— 只探 pandas/statsmodels, 且版本号是
//     `fs.existsSync(PYTHON) ? "3.12" : "未安装"` —— **硬编码**的, 装的是 3.13 也报 3.12;
//   · `/health`、`/api/statistics/health` —— 只回一个 boolean。
//   后果: 某个 venv 里少一个包时, 用户要等到**真正跑分析**那一刻才看到失败,
//   而且错误信息是 Python 的 traceback, 不告诉他"是哪个解释器、缺哪个包"。
//
// 本模块回答的是运维/用户真正要的四个问题:
//   ① 到底用哪个解释器(绝对路径, 而不是"python")?
//   ② 它是什么版本?
//   ③ 这套链路需要的包, 装了哪几个?
//   ④ 缺的那个包, 该装到哪个解释器上?(命令直接给出来)
//
// ⚠ 探测必须在**子进程**里做 —— 版本与 import 都会因解释器不同而不同, 本进程的
//   process.version 与它无关。三次 execFile, 每次 3 秒超时(探不通就该快速失败)。
import { execFile } from "node:child_process";
import fs from "node:fs";
import { resolvePython } from "./py-path.js";

/** 本仓各链路实际用到的包 —— 按用途分组, 未装时告诉用户"少了它会怎样" */
const REQUIRED_PACKAGES: Array<{ name: string; importName: string; usedBy: string }> = [
  { name: "openpyxl", importName: "openpyxl", usedBy: "表格预览 / 问卷解析(xlsx)" },
  { name: "python-docx", importName: "docx", usedBy: "Word 解析与生成(docx)" },
  { name: "python-pptx", importName: "pptx", usedBy: "PPT 解析与生成(pptx)" },
  { name: "pandas", importName: "pandas", usedBy: "实证统计 / 数据清洗" },
  { name: "numpy", importName: "numpy", usedBy: "数值计算(多数统计法的前置)" },
  { name: "statsmodels", importName: "statsmodels", usedBy: "回归 / 计量模型" },
  { name: "matplotlib", importName: "matplotlib", usedBy: "图表渲染" },
];

export interface PythonPackageStatus { name: string; importName: string; usedBy: string; installed: boolean }

export interface PythonHealth {
  /** 实际会执行的解释器(SAG_SANDBOX_PYTHON / EMPIRICAL_PYTHON / COGNEE_PYTHON 等环境变量优先) */
  path: string;
  /** 该路径是否真实存在。为 false 时 version 一律不可信(可能是 PATH 上的裸名) */
  exists: boolean;
  /** 解释器自报的版本(如 "3.12.4")。探测失败为 null —— **绝不编造** */
  version: string | null;
  versionError: string;
  /** 是否项目自带 venv(.venv-fmtcheck)—— 用户据此判断"该装哪" */
  isProjectVenv: boolean;
  packages: PythonPackageStatus[];
  /** 缺了包时可直接复制执行的安装命令 */
  installHint: string;
  ok: boolean;
}

function execFileText(cmd: string, args: string[], timeoutMs = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).slice(0, 200))) : resolve(stdout)));
  });
}

/**
 * 跑一次自检。
 *
 * ⚠ 版本探测**不写死** —— 上一版实现是 `fs.existsSync(PYTHON) ? "3.12" : "未安装"`,
 *   在装了 3.13 的机器上它照样报 3.12, 而用户会拿这个数字去判断兼容性。
 *   这里真的去问解释器: `python -c "import sys; print(...)"`。
 */
export async function probePython(envKeys?: string[]): Promise<PythonHealth> {
  const py = resolvePython({ envKeys: envKeys ?? ["EMPIRICAL_PYTHON", "SAG_SANDBOX_PYTHON", "COGNEE_PYTHON"] });
  const exists = (() => { try { return fs.statSync(py).isFile(); } catch { return false; } })();
  const isProjectVenv = /\.venv-[^\\/]+[\\/](Scripts|bin)[\\/]/.test(py);

  let version: string | null = null;
  let versionError = "";
  try {
    const out = await execFileText(py, ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"]);
    version = out.trim() || null;
  } catch (e) {
    versionError = String((e as Error).message).slice(0, 160);
  }

  // 一次子进程问完所有包 —— 逐包启动 7 个解释器要好几秒, 而这个接口会被设置面板反复调
  const probe = REQUIRED_PACKAGES.map((p) => `"${p.importName}"`).join(",");
  let installedSet = new Set<string>();
  if (version) {
    try {
      const out = await execFileText(py, ["-c",
        `import importlib.util as u\nfor n in [${probe}]:\n    print(n if u.find_spec(n) else '-')\n`]);
      installedSet = new Set(out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== "-"));
    } catch { /* 探测失败 → 全部按未装报, 让用户看到"探不通"而不是"都装了" */ }
  }

  const packages = REQUIRED_PACKAGES.map((p) => ({
    name: p.name, importName: p.importName, usedBy: p.usedBy,
    installed: installedSet.has(p.importName),
  }));
  const missing = packages.filter((p) => !p.installed).map((p) => p.name);

  return {
    path: py,
    exists,
    version,
    versionError,
    isProjectVenv,
    packages,
    // 一律指向**即将执行的那个解释器** —— 缺包时报"给系统 python 装"是没用的,
    // 跑分析用的是这个 venv(两者常常不是同一个)。裸名(未解析出绝对路径)时也照给,
    // 用户复制到自己的终端里执行时 PATH 解析结果与这里一致。
    installHint: missing.length ? `"${py}" -m pip install ${missing.join(" ")}` : "",
    ok: Boolean(version) && missing.length === 0,
  };
}
