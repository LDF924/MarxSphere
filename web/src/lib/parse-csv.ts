// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// parse-csv.ts — 带引号/转义的 CSV/TSV 解析(2026-10-02)
//
// 由来: 改前全仓只有 `UnifiedWorkspace.tsx` 里的 `parseCsvText`, 它是
// `l.split(",")` —— 字段里带逗号或换行的引号字段会被**切碎**, 而且它自己也知道
// ("无引号转义处理" 是它的注释原话)。数据文件进统计台后被切错的列, 后面每一步都是错的,
// 但界面上看不出来(只是列数对不上)。
//
// 这里实现完整的 RFC4180 语义: 双引号包裹、`""` 转义、字段内换行、分隔符自动判定。
// 不引 papaparse: 我们只要"切成二维数组"这一件事, 引一个 50KB 的库不划算。

export interface CsvTable {
  /** 第一行(表头) */
  header: string[];
  /** 数据行(不含表头) */
  rows: string[][];
  /** 实际用到的分隔符 */
  delimiter: string;
  /** 原始字符数 —— 界面用来说明"这是全部还是前 N 行" */
  truncated: boolean;
}

/** 猜分隔符: 只看第一行, 取**在该行出现次数最多**的那个(引号内的不计) */
function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf("\n") >= 0 ? text.indexOf("\n") : text.length);
  const counts: Array<[string, number]> = [[",", 0], ["\t", 0], [";", 0], ["|", 0]];
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === "\"") inQuotes = !inQuotes;
    else if (!inQuotes) {
      const hit = counts.find(([d]) => d === ch);
      if (hit) hit[1]++;
    }
  }
  counts.sort((a, b) => b[1] - a[1]);
  // 一个都没出现 → 按逗号(单列文件也该被当成"1 列的 CSV", 而不是解析失败)
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

/**
 * 切分文本。手写状态机而不是正则 —— 正则处理"字段内换行"需要多行模式且极易写错,
 * 而状态机只有三个状态, 逐字符走一遍天然正确。
 */
function splitRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") { field += "\""; i += 2; continue; } // "" → 一个字面引号
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === "\"") { inQuotes = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }                       // CRLF 的 CR 丢掉
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  // 末行没有换行符时也要收尾(否则最后一行数据会静默丢掉 —— 最常见的 CSV 解析 bug)
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * @param maxRows 只切前 N 行(预览用)。默认不限 —— 调用方自己决定要不要分页。
 *   注意 maxRows 是**切行不是切字符**: 按字符切会把一个引号字段切成两半。
 */
export function parseCsv(text: string, opts: { maxRows?: number } = {}): CsvTable | null {
  const src = String(text ?? "");
  if (!src.trim()) return null;
  const delimiter = sniffDelimiter(src);
  let all = splitRows(src, delimiter);
  // 完全空的行(所有字段都是空串)丢掉 —— 表格尾部常有
  all = all.filter((r) => r.some((c) => c.trim() !== ""));
  if (!all.length) return null;

  const truncated = opts.maxRows != null && all.length > opts.maxRows;
  if (truncated) all = all.slice(0, opts.maxRows);
  const [header, ...rows] = all;
  // 列数对齐: 引号里带换行的行可能短一截, 补齐到表头长度 —— 不补的话
  // 下面的 rows[ci] 会读到 undefined, 渲染成空白列看不出是数据缺还是解析坏
  const width = header.length;
  const norm = rows.map((r) => (r.length === width ? r : [...r.slice(0, width), ...Array(Math.max(0, width - r.length)).fill("")]));
  return { header, rows: norm, delimiter, truncated };
}

/** 该值看起来是不是数字(用于右对齐) —— 空串不算, 前导零不算(学号/邮编该左对齐) */
export function looksNumeric(v: string): boolean {
  const s = v.trim();
  if (!s || /^0\d/.test(s)) return false;
  return !Number.isNaN(Number(s));
}
