# viz_runner.py — SocialSci P0-4: 科研绘图执行器(对话式 Agent 的 Python 数据/绘图引擎)
# 用法: python viz_runner.py <task_dir>
#   task_dir/input.json : { code: python 绘图代码(data.csv 在同目录), kind: "analyze"|"chart" }
#     kind=analyze: 数据概要分析 → result.json { summary, columns }
#     kind=chart:   执行绘图代码(数据以 DATA_CSV 文本注入) → result.json { ok, error?, width, height }
#   task_dir/result.json: 结果契约
#   task_dir/output.png / output.svg: kind=chart 时产物(matplotlib 同图双写)
# 设计: matplotlib Agg 后端, SVG 用默认文本输出(可再编辑, 不转 path)
#
# 安全模型(2026-09-11 重做):
#   原实现靠"危险调用黑名单 + 裸 exec", 实测可绕过 ——
#     `import os as _o; getattr(_o,'sys'+'tem')('echo PWNED > pwn.txt')` 返回 ok:true 且命令真的执行了。
#   黑名单拦的是写法不是能力, 等价写法无穷多。现改为能力剥离:
#     ① 代码看到的 os/sys 是**残桩**(任何属性访问都抛错), 不能起进程/读文件/删文件
#     ② __import__ 只放行绘图白名单模块(进程/网络/原生调用一律 ImportError)
#     ③ 数据以 **DATA_CSV 文本**注入, 连 data.csv 路径都不给 —— 绘图不需要文件系统
#   ⚠ 这仍不是内核级沙箱(同进程、同用户): 目标是挡住"提示词注入 → 任意命令执行"这条链。
#     要更强隔离需把执行器搬进容器/受限用户。
import sys
import os
import json
import re
import io
import builtins

# 绝对化: 下面 exec 前会 os.chdir(task_dir), 若 task_dir 是相对路径,
#   注入的 DATA_CSV 会因 cwd 变化被二次解析而找不到(实测 FileNotFoundError)
task_dir = os.path.abspath(sys.argv[1])
inp = json.load(open(os.path.join(task_dir, "input.json"), encoding="utf-8"))
kind = inp.get("kind", "analyze")
out = {"ok": False}

# 绘图真正需要的能力: 数值/绘图库 + 标准计算库。进程/网络/原生调用一律不放行。
_ALLOWED_MODULES = {
    # 注意: seaborn 未随本环境安装(实测 cognee/.venv312 里没有)。放进白名单会让
    #   "允许的模块"与"装了没有"对不上 —— LLM 写 seaborn 时给出的是 ModuleNotFoundError。
    #   保留在放行集合里(装了就能用), 但错误信息见下面 _import_guard 的提示, 明确指出没装。
    "matplotlib", "pandas", "numpy", "seaborn", "scipy", "sympy", "statsmodels",
    "statistics", "math", "cmath", "decimal", "fractions", "random",
    "datetime", "time", "calendar", "re", "json", "csv", "io", "textwrap",
    "collections", "itertools", "functools", "operator", "copy", "string",
    "dataclasses", "enum", "abc", "typing", "warnings", "numbers",
    "heapq", "bisect", "array", "uuid", "hashlib", "base64", "unicodedata",
}
_IMPORT_ERR = ("本环境为绘图沙箱: 只允许数值/绘图相关模块(%s)。"
               "如需读数据请使用 DATA_CSV(已提供 CSV 文本)。" % ", ".join(sorted(_ALLOWED_MODULES)))
_real_import = builtins.__import__


_MISSING_HINT = ("本绘图环境未安装模块 %s —— 请改用 pandas/numpy/matplotlib 等价写法"
                  "(例如 seaborn 的图用 matplotlib 直接画)。")

def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = str(name).split(".")[0]
    if root not in _ALLOWED_MODULES:
        raise ImportError(_IMPORT_ERR)
    try:
        return _real_import(name, globals, locals, fromlist, level)
    except ImportError:
        # 白名单里有、但环境没装: 给出可执行的替代建议, 而不是让模型在报错里空转
        if root in _ALLOWED_MODULES:
            raise ImportError(_MISSING_HINT % root) from None
        raise


class _BlockedStub:
    """能力残桩: os/sys 被换成它, 任何属性访问抛错(而不是静默返回危险对象)"""
    def __init__(self, label):
        self._label = label

    def __getattr__(self, item):
        raise RuntimeError("本环境为绘图沙箱: 绘图代码不能使用 %s.%s —— 如需读数据请用 DATA_CSV" % (self._label, item))

    def __repr__(self):
        return "<%s: 已在绘图沙箱中禁用>" % self._label


# TS 层黑名单(纵深防御之一)。**不是**安全边界, 只用于快速给出人类可读错误。
DANGER_CODE = re.compile(r"__import__|subprocess|os\.system|os\.popen|shutil\.rmtree|eval\s*\(|exec\s*\(|open\s*\(\s*['\"]/|pathlib.*rm")

try:
    if kind == "analyze":
        # 数据概要分析(真实计算, 供 Agent 决定图表类型/统计)
        data_path = os.path.join(task_dir, "data.csv")
        import pandas as pd
        if not os.path.exists(data_path):
            out = {"ok": True, "summary": "无数据文件(仅用于画示意图的请求可跳过)", "columns": []}
        else:
            df = pd.read_csv(data_path)
            cols = []
            for c in df.columns:
                col = df[c]
                if pd.api.types.is_numeric_dtype(col):
                    cols.append({"name": str(c), "type": "numeric",
                                 "valid": int(col.count()), "missing": int(col.isna().sum()),
                                 "mean": round(float(col.mean()), 4) if col.count() else None,
                                 "min": float(col.min()) if col.count() else None,
                                 "max": float(col.max()) if col.count() else None})
                else:
                    cols.append({"name": str(c), "type": "categorical",
                                 "valid": int(col.count()), "missing": int(col.isna().sum()),
                                 "unique": int(col.nunique())})
            out = {"ok": True, "summary": "Number of variables: %d  Observations: %d" % (len(cols), len(df)),
                   "columns": cols}
    elif kind == "chart":
        code = inp.get("code", "")
        if DANGER_CODE.search(code):
            out = {"ok": False, "error": "代码含被禁用的危险调用, 已拦截"}
        else:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
            import pandas as pd
            import numpy as np

            spec = inp.get("spec") or {}
            mm = 1.0 / 25.4
            # 数值类参数做范围夹取: 请求体直通, 异常值会让 matplotlib 申请巨量内存/磁盘
            def _num(key, default, lo, hi):
                try:
                    v = float(spec.get(key) if spec.get(key) is not None else default)
                except (TypeError, ValueError):
                    v = default
                return max(lo, min(hi, v))
            fw = _num("widthMm", 183, 20, 600) * mm
            fh = _num("heightMm", 120, 20, 600) * mm
            fdpi = int(_num("dpi", 300, 36, 1200))
            fsize = _num("fontSize", 9, 3, 48)
            lw = _num("lineWidth", 1.0, 0.1, 12)

            # 数据以绝对路径注入(契约: 代码里 pd.read_csv(DATA_CSV))
            data_path = os.path.join(task_dir, "data.csv")
            has_data = os.path.exists(data_path)

            fig_code = (
                "import matplotlib.pyplot as plt\n"
                "plt.rcParams['font.sans-serif'] = ['SimHei','Microsoft YaHei','Noto Sans CJK SC','Arial Unicode MS']\n"
                "plt.rcParams['axes.unicode_minus'] = False\n"
                "plt.rcParams['font.size'] = %(fsize)r\n"
                "plt.rcParams['axes.linewidth'] = %(lw)r\n"
                "plt.rcParams['xtick.major.width'] = %(lw)r\n"
                "plt.rcParams['ytick.major.width'] = %(lw)r\n"
                "fig, ax = plt.subplots(figsize=(%(fw)r, %(fh)r), dpi=%(fdpi)r)\n"
            ) % {"fsize": fsize, "lw": lw, "fw": fw, "fh": fh, "fdpi": fdpi}
            if has_data:
                # 自动载入 df(代码可直接用 df/ax), 与 DATA_CSV 同一份数据
                fig_code += (
                    "import pandas as _pd\n"
                    "df = _pd.read_csv(DATA_CSV)\n"
                )
            fig_code += code + "\nplt.tight_layout()\n"

            ns = {
                "plt": plt, "pd": pd, "np": np,
                "DATA_CSV": data_path,
                # 能力残桩: 代码里的 os/sys 被换成"任何属性访问都抛错"的对象
                "os": _BlockedStub("os"), "sys": _BlockedStub("sys"),
                # 关键: 守卫只挂在这份 __builtins__ 上 —— 只约束用 ns 执行的代码。
                #   绝不能替换全局 builtins.__import__: matplotlib 绘制时会惰性 import
                #   PIL/dateutil/kiwisolver 等, 被一起拦掉会让正常出图也失败(实测踩过)。
                "__builtins__": dict(vars(builtins), __import__=_guarded_import),
            }
            buf, old_stdout, cwd = io.StringIO(), sys.stdout, os.getcwd()
            sys.stdout = buf
            try:
                # 切到任务目录再执行: LLM 生成的代码常写 pd.read_csv('data.csv')(相对路径),
                #   在 SAG_ROOT 下执行会 FileNotFoundError —— 实测三次渲染全挂、前端出不来图
                os.chdir(task_dir)
                exec(compile(fig_code, "<viz_code>", "exec"), ns)
            finally:
                sys.stdout = old_stdout
                os.chdir(cwd)

            fig = plt.gcf()
            # 示意图水印(2026-09-11): 无绑定数据时图是 LLM 编的, 前端徽标随页面消失,
            #   水印随图走 —— 下载/插入论文/截图后仍能看出这不是真实数据。
            # 判据用 data.csv 是否存在 = 本进程自己加载了什么, 不会与 TS 层状态漂移。
            if not has_data:
                fig.text(0.5, 0.5, "示意", fontsize=max(28.0, fsize * 4),
                         color="#8a8a8a", alpha=0.16, ha="center", va="center",
                         rotation=30, transform=fig.transFigure, zorder=10)
                fig.text(0.99, 0.01, "未绑定真实数据 · 示意(非真实结果)", fontsize=max(7.0, fsize * 0.85),
                         color="#b03030", alpha=0.85, ha="right", va="bottom",
                         transform=fig.transFigure, zorder=10)
            out_png = os.path.join(task_dir, "output.png")
            out_svg = os.path.join(task_dir, "output.svg")
            fig.savefig(out_png, format="png")
            fig.savefig(out_svg, format="svg")  # 默认文本 SVG → 可再编辑
            plt.close(fig)
            out = {"ok": True, "width": fig.get_figwidth(), "height": fig.get_figheight(),
                   "note": "svg 为可编辑矢量(svg_editable)"}
    else:
        out = {"ok": False, "error": "未知 kind: %s" % kind}
except Exception as e:
    out = {"ok": False, "error": "%s: %s" % (type(e).__name__, str(e))}

result_path = os.path.join(task_dir, "result.json")
tmp_path = result_path + ".tmp"
with open(tmp_path, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)
os.replace(tmp_path, result_path)  # 原子写
