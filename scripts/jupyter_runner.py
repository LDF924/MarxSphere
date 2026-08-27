#!/usr/bin/env python3
# jupyter_runner.py — 轻量 notebook 单元执行器（2026-08-27, ScienceX 通用计算环境）
# 用法: python jupyter_runner.py <task_dir>
#   task_dir/input.json  : { code, variables(持久变量 dict), data? }
#   task_dir/result.json : { ok, output(文本), variables(更新后), error?, tables?, figures? }
# 设计: 复用实证沙箱的 venv 隔离; variables 跨单元持久(模拟 notebook 内核状态)
# 安全: 与 empirical_runner 同防护(独立 venv, 无网络白名单差异, 大小守卫)
import sys
import os
import json
import io
import contextlib
import traceback
import base64

# 2026-08-27 fix: 强制 Agg backend（必须在 import pyplot 之前设置 — 单元格代码可能先 import,
# 之后再 use("Agg") 无效 → plt.show() 走 GUI backend 挂起 → 执行超时无结果）
import matplotlib
matplotlib.use("Agg")

task_dir = sys.argv[1]
inp = json.load(open(os.path.join(task_dir, "input.json"), encoding="utf-8"))
code = inp.get("code", "")
variables = inp.get("variables", {}) or {}

# 恢复持久变量（模拟 notebook 内核变量）
# 2026-08-27: __df__ 标记的转回 DataFrame（df 跨单元格持久的关键）
def _deserialize(v):
    if isinstance(v, dict) and v.get("__df__") is True:
        try:
            import pandas as pd
            return pd.DataFrame(v["records"], columns=v["columns"])
        except Exception:
            return v
    if isinstance(v, list):
        return [_deserialize(x) for x in v]
    if isinstance(v, dict):
        return {k: _deserialize(x) for k, x in v.items()}
    return v

try:
    _vars = dict(variables)
    for k, v in _vars.items():
        # 只恢复 JSON 可序列化值（安全: 不恢复函数/对象）
        if isinstance(v, (str, int, float, bool, list, dict, type(None))):
            globals()[k] = _deserialize(v)
except Exception:
    pass

# 输出捕获
out_buf = io.StringIO()
figures = []
result = {"ok": False, "output": "", "variables": {}, "error": None, "tables": [], "figures": []}

try:
    with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(out_buf):
        exec(code, globals())
    result["ok"] = True
except SystemExit:
    result["ok"] = True
except Exception:
    result["ok"] = False
    result["error"] = traceback.format_exc()[-1500:]

result["output"] = out_buf.getvalue()[-8000:]

# 收集变量（JSON 可序列化的, 供下一单元继续用）
# 2026-08-27 fix: DataFrame/numpy 类型转 JSON 可序列化(DataFrame→records, 标量→原生) — 否则 df 不持久导致下单元 NameError
def _serialize(v):
    if hasattr(v, "to_dict") and hasattr(v, "columns"):  # pandas DataFrame
        return {"__df__": True, "columns": list(v.columns), "records": v.to_dict("records")}
    if hasattr(v, "item") and hasattr(v, "shape") and len(getattr(v, "shape", ())) == 0:  # numpy 标量
        return v.item()
    if isinstance(v, (list, tuple)):
        return [_serialize(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _serialize(x) for k, x in v.items()}
    try:
        json.dumps(v)
        return v
    except Exception:
        return None

try:
    saved = {}
    _skip = set(("sys", "os", "json", "io", "contextlib", "traceback", "base64", "inp", "code", "variables", "task_dir", "out_buf", "figures", "result", "saved", "_vars", "_skip", "np", "pd", "plt"))
    for k, v in list(globals().items()):
        if k.startswith("__") or k in _skip:
            continue
        sv = _serialize(v)
        if sv is not None:
            saved[k] = sv
    result["variables"] = saved
except Exception:
    pass

# 收集 matplotlib 图（如有）— backend 已在文件头设 Agg
try:
    import matplotlib.pyplot as plt
    if len(plt.get_fignums()) > 0:
        for i, num in enumerate(plt.get_fignums()[:5]):
            fig = plt.figure(num)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", dpi=80)
            figures.append(base64.b64encode(buf.getvalue()).decode())
        plt.close("all")
    result["figures"] = figures
except Exception:
    pass

json.dump(result, open(os.path.join(task_dir, "result.json"), "w", encoding="utf-8"), ensure_ascii=False)
