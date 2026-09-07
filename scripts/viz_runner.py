# viz_runner.py — SocialSci P0-4: 科研绘图执行器(对话式 Agent 的 Python 数据/绘图引擎)
# 用法: python viz_runner.py <task_dir>
#   task_dir/input.json : { code: python 绘图代码(data.csv 在同目录), kind: "analyze"|"chart", mode }
#     kind=analyze: 数据概要分析 → result.json { summary, columns }
#     kind=chart:   执行绘图代码(已注入数据读取上下文) → result.json { ok, error?, width, height }
#   task_dir/result.json: 结果契约
#   task_dir/output.png / output.svg: kind=chart 时产物(matplotlib 同图双写)
# 设计: matplotlib Agg 后端, SVG 用默认文本输出(可再编辑, 不转 path);
#       代码在执行前经过 TS 层黑名单 + 本文件二次危险调用拦截
import sys
import os
import json
import re
import io

task_dir = sys.argv[1]
inp = json.load(open(os.path.join(task_dir, "input.json"), encoding="utf-8"))
kind = inp.get("kind", "analyze")
out = {"ok": False}

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
        # 二次拦截: 危险调用黑名单(TS 层已查, 此处纵深防御)
        danger = re.compile(r"__import__|subprocess|os\.system|os\.popen|shutil\.rmtree|eval\s*\(|exec\s*\(|open\s*\(\s*['\"]/|pathlib.*rm")
        if danger.search(code):
            out = {"ok": False, "error": "代码含被禁用的危险调用, 已拦截"}
        else:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
            # 数据就位 + 中文字体兜底
            data_path = os.path.join(task_dir, "data.csv")
            if os.path.exists(data_path):
                import pandas as pd
                exec_globals = {"pd": pd, "plt": plt, "os": os}
            else:
                exec_globals = {"pd": None, "plt": plt, "os": os}
            # 注入数据读取约定 + 图形尺寸(期刊规范 spec 可覆盖; 对齐闭源 VizView 期刊规格控制)
            spec = inp.get("spec") or {}
            ns = dict(exec_globals)
            ns["DATA_CSV"] = data_path
            mm = 1.0 / 25.4
            fw = float(spec.get("widthMm") or 183) * mm   # 默认双栏 183mm
            fh = float(spec.get("heightMm") or 120) * mm  # 默认高 120mm
            fdpi = int(spec.get("dpi") or 300)
            fsize = float(spec.get("fontSize") or 9)
            lw = float(spec.get("lineWidth") or 1.0)
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
            if os.path.exists(data_path):
                # 自动把数据载入 df(代码可直接用 df/ax), 再包装 ax.set_* 便捷名
                fig_code += (
                    "import pandas as _pd\n"
                    "df = _pd.read_csv(DATA_CSV)\n"
                )
            fig_code += code + "\nplt.tight_layout()\n"
            # 捕获 stdout(排除 matplotlib 噪音)
            buf = io.StringIO()
            old = sys.stdout
            sys.stdout = buf
            try:
                exec(compile(fig_code, "<viz_code>", "exec"), ns)
            finally:
                sys.stdout = old
            fig = plt.gcf()
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
