// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// SheetViewer.tsx — 表格预览(多 sheet + 分页 + 列类型)(2026-10-02)
//
// 由来(对照 Respal 的表格预览): 本仓此前 xlsx **只有首 sheet 的纯文本**,
//   长表格一律被 `file.content.slice(0, 20000)` 砍掉(实测 VaultPanel:253 与 PolicyPanel:322
//   各一处), 用户看到的是"表格被截断了"却没有任何继续往下看的手段。
//
// ═══ 分页而不是虚拟滚动 ═══
//   虚拟滚动要引库或自己写测量逻辑, 而表格预览的诉求是"扫一眼有没有我要的列/行"。
//   分页还能顺带告诉用户"总共多少行", 这恰恰是虚拟滚动不显示的。
import { useEffect, useMemo, useState } from "react";
import { Loader2, Table2, AlertTriangle } from "lucide-react";
import { cn } from "../lib/utils";
import { parseCsv, looksNumeric, type CsvTable } from "../lib/parse-csv";

export interface SheetPreview {
  name: string;
  empty: boolean;
  header: string[];
  rows: Array<Array<string | number | boolean>>;
  columns?: Array<{ name: string; type: string }>;
  truncated?: boolean;
  declaredRows?: number;
}

const PAGE_SIZES = [50, 100, 200];

/** 单元格 → 显示串。null/undefined 显示成灰色占位而不是空白(空值 vs 解析失败要能分清) */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "是" : "否";
  return String(v);
}

function DataTable({ header, rows, types }: { header: string[]; rows: string[][]; types?: string[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded border border-border">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur">
          <tr>
            <th className="w-10 border-b border-border px-2 py-1.5 text-right font-normal text-muted-foreground">#</th>
            {header.map((h, i) => (
              <th key={i} className="whitespace-nowrap border-b border-l border-border px-2 py-1.5 text-left font-medium">
                {h || <span className="text-muted-foreground/50">(未命名列)</span>}
                {types?.[i] ? <span className="ml-1.5 text-[10px] font-normal text-muted-foreground/70">{types[i]}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="hover:bg-accent/30">
              <td className="border-b border-border/60 px-2 py-1 text-right text-muted-foreground/60">{ri + 1}</td>
              {r.map((c, ci) => (
                <td
                  key={ci}
                  title={c}
                  className={cn(
                    "max-w-[28rem] truncate border-b border-l border-border/60 px-2 py-1",
                    looksNumeric(c) && "text-right tabular-nums"
                  )}
                >
                  {c === "" ? <span className="text-muted-foreground/40">—</span> : c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * xlsx/xls 预览。
 *
 * @param source 二选一: fileId(上传文件) 或 path(资料库路径)
 */
export function SheetViewer({ fileId, path: vaultPath, fileName }: {
  fileId?: string;
  path?: string;
  fileName?: string;
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [sheets, setSheets] = useState<SheetPreview[]>([]);
  const [active, setActive] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(""); setActive(0); setPage(0);
    const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
    // 统一走 /api/preview/parse —— 三条入口(fileId / vault path)在后端收敛成一处,
    // 前端不必知道 pptx 要 unzip、xlsx 要跑 python
    fetch("/api/preview/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(fileId ? { fileId } : { path: vaultPath }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.ok && Array.isArray(d.sheets)) { setSheets(d.sheets); return; }
        setErr(d?.error || "表格读取失败");
      })
      .catch((e) => { if (!cancelled) setErr(String(e?.message || e).slice(0, 120)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // fileName 只用于文案, 不参与请求 —— 不放进依赖免得改名重拉
  }, [fileId, vaultPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const sheet = sheets[active];
  const previewRows = useMemo(() => (sheet?.rows ?? []).map((r) => r.map(cellText)), [sheet]);
  const pageCount = Math.max(1, Math.ceil(previewRows.length / pageSize));
  const pageRows = previewRows.slice(page * pageSize, (page + 1) * pageSize);

  if (loading) {
    return <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />读取表格…</div>;
  }
  if (err || !sheets.length) {
    return (
      <div className="flex flex-col items-center gap-2 p-6 text-center">
        <AlertTriangle className="h-6 w-6 text-amber-400" />
        <div className="text-sm font-medium">{fileName || "表格"}</div>
        <div className="max-w-md text-xs text-muted-foreground">{err || "这个文件里没有可读的工作表"}</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* sheet 选择 —— 多 sheet 是这次修的主要问题(改前只显示首 sheet, 其余静默丢弃) */}
      {sheets.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[11px] text-muted-foreground">工作表</span>
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              type="button"
              onClick={() => { setActive(i); setPage(0); }}
              className={cn(
                "rounded-md border px-2 py-0.5 text-[11px]",
                i === active ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent",
                s.empty && "opacity-50"
              )}
              title={s.empty ? "空工作表" : `${(s.declaredRows ?? s.rows.length + 1) - 1} 行`}
            >
              {s.name}{s.empty ? "(空)" : ""}
            </button>
          ))}
        </div>
      ) : null}

      {sheet.empty ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          工作表「{sheet.name}」是空的
        </div>
      ) : (
        <>
          <DataTable
            header={sheet.header}
            rows={pageRows}
            types={sheet.columns?.map((c) => c.type)}
          />
          <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>
              预览 {(sheet.declaredRows ?? sheet.rows.length + 1) - 1 > sheet.rows.length
                ? `前 ${sheet.rows.length} 行（共约 ${(sheet.declaredRows ?? 0) - 1} 行）`
                : `${sheet.rows.length} 行`}
              、{sheet.header.length} 列
            </span>
            {pageCount > 1 ? (
              <>
                <span className="text-muted-foreground/40">·</span>
                <button type="button" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}
                  className="rounded border border-border px-1.5 py-0.5 disabled:opacity-40">上一页</button>
                <span>{page + 1} / {pageCount}</span>
                <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  className="rounded border border-border px-1.5 py-0.5 disabled:opacity-40">下一页</button>
              </>
            ) : null}
            <span className="text-muted-foreground/40">·</span>
            <span>每页</span>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
              className="rounded border border-border bg-transparent px-1 py-0.5"
            >
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            {sheet.truncated ? (
              <span className="text-amber-400/90">· 服务端只回前 200 行用于预览，完整数据请下载后用统计台打开</span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/** CSV/TSV 预览 —— 客户端解析, 不进后端(文本本来就是文本) */
export function CsvViewer({ text, fileName }: { text: string; fileName?: string }) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  // 全量解析: 与 xlsx 不同, CSV 没有"服务端只给前 200 行"的限制, 数据就在手上
  const table: CsvTable | null = useMemo(() => parseCsv(text), [text]);

  if (!table) {
    return (
      <div className="flex flex-col items-center gap-2 p-6 text-center">
        <Table2 className="h-6 w-6 text-muted-foreground/50" />
        <div className="text-sm font-medium">{fileName || "数据文件"}</div>
        <div className="text-xs text-muted-foreground">文件是空的，或没有可解析的行</div>
      </div>
    );
  }
  const pageCount = Math.max(1, Math.ceil(table.rows.length / pageSize));
  const rows = table.rows.slice(page * pageSize, (page + 1) * pageSize);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <DataTable header={table.header} rows={rows} />
      <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span>{table.rows.length} 行、{table.header.length} 列（分隔符 {table.delimiter === "\t" ? "Tab" : table.delimiter}）</span>
        {pageCount > 1 ? (
          <>
            <span className="text-muted-foreground/40">·</span>
            <button type="button" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded border border-border px-1.5 py-0.5 disabled:opacity-40">上一页</button>
            <span>{page + 1} / {pageCount}</span>
            <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              className="rounded border border-border px-1.5 py-0.5 disabled:opacity-40">下一页</button>
            <span className="text-muted-foreground/40">·</span>
            <span>每页</span>
            <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
              className="rounded border border-border bg-transparent px-1 py-0.5">
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default SheetViewer;
