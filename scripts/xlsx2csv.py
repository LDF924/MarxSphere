# xlsx2csv.py — xlsx 读取(2026-09-09; 2026-10-02 改多 sheet)
#
# 用法:
#   python xlsx2csv.py <input.xlsx>            → stdout CSV(单 sheet 兼容模式, 见下)
#   python xlsx2csv.py <input.xlsx> --meta     → stdout 一行 JSON(含全部 sheet 与列类型)
#
# ═══ 为什么加了 --meta ═══
#   改前只会输出**首个含数据的 sheet**, 其余 sheet 直接丢弃 —— 一份"说明/变量表/数据"
#   三 sheet 的问卷文件传进来, 用户只会看到说明页, 然后以为数据没传上去。
#   但直接改输出格式会打断既有的两个调用方(src/services/file-text-service.ts:135 与
#   src/api/server.ts:14351, 它们都拿 stdout 当 CSV 文本)。所以: 默认行为**一字不改**,
#   多 sheet 与列类型走 `--meta` 这条新出口, 由调用方按需取。
#
# ═══ 列类型由 openpyxl 自己给, 不用猜 ═══
#   改前调用方拿 CSV 后在前端按"前 50 行里数字占比"猜类型: 某列恰好前 50 行全空
#   就会被当成分类变量。openpyxl 读单元格时本来就带 Python 类型(含日期), 直接统计
#   每列的非空类型即可 —— 比抽样猜准, 而且**日期能认出来**(猜法会把日期当字符串)。
import sys
import io
import json


def col_types(ws, header, sample_limit=None):
    """按列统计非空单元格的 Python 类型 → nominal / scale / date / unknown"""
    ncol = len(header)
    kinds = [set() for _ in range(ncol)]
    for ri, row in enumerate(ws.iter_rows(values_only=True)):
        if ri == 0:
            continue
        if sample_limit and ri > sample_limit:
            break
        for ci in range(ncol):
            v = row[ci] if ci < len(row) else None
            if v is None or (isinstance(v, str) and not v.strip()):
                continue
            if isinstance(v, bool):
                kinds[ci].add("nominal")          # 布尔归分类, 不归数值
            elif isinstance(v, (int, float)):
                kinds[ci].add("scale")
            elif hasattr(v, "year") and hasattr(v, "month"):
                kinds[ci].add("date")
            else:
                kinds[ci].add("nominal")
    out = []
    for ci in range(ncol):
        k = kinds[ci]
        # 混了数值与文本 → 按分类处理(分析工具对"含非数值的分类列"更安全)
        if k == {"scale"}:
            t = "scale"
        elif k == {"date"}:
            t = "date"
        elif not k:
            t = "unknown"                          # 全空列
        else:
            t = "nominal"
        out.append({"name": header[ci], "type": t})
    return out


def sheet_rows(ws, max_rows=200):
    rows = []
    for ri, row in enumerate(ws.iter_rows(values_only=True)):
        if ri > max_rows:
            break
        if all(v is None or str(v).strip() == "" for v in row):
            continue
        rows.append(["" if v is None else (v.isoformat() if hasattr(v, "isoformat") else v) for v in row])
    return rows


def sheet_to_csv(ws):
    out = io.StringIO()
    import csv
    w = csv.writer(out, lineterminator="\n")
    for row in ws.iter_rows(values_only=True):
        if all(v is None or str(v).strip() == "" for v in row):
            continue
        w.writerow(["" if v is None else (v.isoformat() if hasattr(v, "isoformat") else v) for v in row])
    return out.getvalue()


def load(path):
    from openpyxl import load_workbook
    # read_only: 大表不必整本进内存(read_only 模式下 cell.value 即 Python 原生类型, 够用)
    return load_workbook(path, read_only=True, data_only=True)


def main():
    path = sys.argv[1]
    want_meta = "--meta" in sys.argv[2:]
    try:
        wb = load(path)
    except ImportError:
        print("ERR:openpyxl 未安装", file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print("ERR:无法打开 xlsx: %s" % e, file=sys.stderr)
        sys.exit(3)

    if want_meta:
        sheets = []
        for name in wb.sheetnames:
            ws = wb[name]
            # ⚠ 不能用 `ws.max_row and ws.max_column` 判空: 一个从没写过内容的 sheet,
            #   openpyxl 也会报 max_row=1 / max_column=1(隐含的 A1) —— 实测把空表
            #   判成了"有数据且被截断"。空不空只看**真的读出了什么**。
            preview = sheet_rows(ws) if (ws.max_row and ws.max_column) else []
            header = [str(c) for c in (preview[0] if preview else [])]
            data_rows = preview[1:] if preview else []
            empty = not any(h.strip() for h in header) and not data_rows
            sheets.append({
                "name": name,
                "empty": empty,
                # max_row/max_column 是 openpyxl 记的**声明尺寸**, 可能大于实际(格式化过的空行也算)
                "declaredRows": ws.max_row or 0,
                "declaredCols": ws.max_column or 0,
                "columns": [] if empty else col_types(ws, header),
                "rows": [] if empty else data_rows,
                "header": header,
                "truncated": (not empty) and ws.max_row > len(preview),
            })
        # ensure_ascii=False: 中文 sheet 名/表头不能变成 \uXXXX(前端直接显示)
        print(json.dumps({"sheetNames": wb.sheetnames, "sheets": sheets}, ensure_ascii=False))
        return

    # ── 单 sheet 兼容模式(原行为: 首个含数据的 sheet) ──
    ws = None
    for name in wb.sheetnames:
        cand = wb[name]
        if cand.max_row and cand.max_column:
            ws = cand
            break
    if ws is None:
        print("ERR:无数据 sheet", file=sys.stderr)
        sys.exit(4)
    print(sheet_to_csv(ws), end="")


if __name__ == "__main__":
    main()
