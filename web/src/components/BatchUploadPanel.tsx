// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// BatchUploadPanel.tsx — 批量文件上传+解析+入库(PDF/Word/Excel/PPT)
// 流程: ①拖拽/多选文件 ②批量解析预览(每份文本可看可弃) ③勾选→入库(逐文件 upload, 建索引可检索)
import { useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Database, FileUp, Loader2, ScanText, Trash2, X } from "lucide-react";

interface ParsedItem {
  fileName: string;
  ok: boolean;
  text: string;
  charCount: number;
  error?: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? "").split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("读取失败"));
    reader.readAsDataURL(file);
  });
}

const ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx";

export function BatchUploadPanel({ sourceId }: { sourceId?: string }) {
  const [items, setItems] = useState<Array<{ file: File; base64: string }>>([]);
  const [results, setResults] = useState<Array<ParsedItem | null>>([]);
  const [parsing, setParsing] = useState(false);
  const [storing, setStoring] = useState(false);
  const [stored, setStored] = useState<Set<number>>(new Set());
  const [storeMsg, setStoreMsg] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [mode, setMode] = useState<"p2o" | "direct">("p2o"); // p2o=深度加工(PDF2Obsidian) direct=直接入库原文PDF
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    const arr: Array<{ file: File; base64: string }> = [];
    for (const f of Array.from(list)) {
      if (f.size > 40 * 1024 * 1024) { setStoreMsg(`跳过 ${f.name}(>40MB)`); continue; }
      try { arr.push({ file: f, base64: await fileToBase64(f) }); } catch { /* 忽略 */ }
    }
    if (arr.length === 0) return;
    setItems((prev) => [...prev, ...arr]);
    setResults((prev) => [...prev, ...arr.map(() => null)]);
  };

  const runParse = async () => {
    if (items.length === 0) return;
    setParsing(true); setStoreMsg("");
    try {
      const res = await fetch("/api/files/batch-parse", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: items.map((i) => ({ name: i.file.name, base64: i.base64 })), maxChars: 12000 }),
      });
      const d = await res.json();
      if (!res.ok) { setStoreMsg(d?.error?.message ?? "解析失败"); return; }
      setResults(d.results ?? []);
      setStoreMsg(`✅ 解析完成: ${d.okCount ?? 0} 成功 / ${d.failCount ?? 0} 失败 — 勾选后入库`);
    } catch (e) { setStoreMsg(e instanceof Error ? e.message : String(e)); }
    finally { setParsing(false); }
  };

  const removeAt = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
    setResults((prev) => prev.filter((_, i) => i !== idx));
  };

  const storeSelected = async () => {
    const idxs = results.map((r, i) => (r && r.ok ? i : -1)).filter((i) => i >= 0 && !stored.has(i));
    if (idxs.length === 0) { setStoreMsg("先解析且勾选要处理的文件"); return; }
    setStoring(true); setStoreMsg(`处理中(0/${idxs.length})…`);
    let ok = 0;
    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k];
      const item = items[i];
      const r = results[i];
      try {
        if (mode === "p2o") {
          // ① 走 PDF2Obsidian 深度加工管线(仅 PDF; 非 PDF 提示跳过)
          if (!item.file.name.toLowerCase().endsWith(".pdf")) {
            setStoreMsg(`跳过 ${item.file.name}(P2O 仅支持 PDF)`);
            continue;
          }
          const res = await fetch("/api/p2o/tasks", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileName: item.file.name, fileBase64: item.base64 }),
          });
          if (res.ok || res.status === 201) { ok++; setStored((prev) => new Set(prev).add(i)); }
        } else {
          // ② 直接入库原文(PDF 解析文本 → uploadDocument 建索引; 原 PDF 落盘由 upload 产物留)
          const res = await fetch("/api/documents/upload", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sourceId: sourceId || undefined,
              fileName: `${item.file.name.replace(/\.[^.]+$/, "")}.md`,  // upload 限 .md/.txt, 标题保留原名
              title: item.file.name.replace(/\.[^.]+$/, ""),
              content: r!.text.slice(0, 200_000),
              extract: true,
            }),
          });
          if (res.ok || res.status === 201) { ok++; setStored((prev) => new Set(prev).add(i)); }
        }
        setStoreMsg(`处理中(${k + 1}/${idxs.length})…`);
      } catch { /* 单个失败继续 */ }
    }
    setStoreMsg(mode === "p2o"
      ? `✅ 已提交 ${ok}/${idxs.length} 篇到 P2O 管线(可在「文献管理→PDF2Obsidian」看进度)`
      : `✅ 入库完成: ${ok}/${idxs.length} 篇(可在文献库检索)`);
    setStoring(false);
  };

  return (
    <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.03] p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-amber-200/90">
        <FileUp className="h-4 w-4" /> 批量上传·解析·入库
        <span className="text-[9px] font-normal text-muted-foreground/60">拖拽/多选 PDF·Word·Excel·PPT → 解析预览 → 勾选入库(建索引可检索)</span>
        <span className="ml-auto text-[10px] text-muted-foreground/60">{items.length} 个文件</span>
      {/* 处理模式选择 */}
      <div className="flex gap-1">
        <button type="button" onClick={() => setMode("p2o")}
          className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] ${mode === "p2o" ? "bg-amber-400/20 text-amber-200" : "text-muted-foreground hover:bg-accent/30"}`}>
          <ScanText className="h-3 w-3" /> PDF2Obsidian 深度加工(OCR/公式/表格/双语, 慢)
        </button>
        <button type="button" onClick={() => setMode("direct")}
          className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] ${mode === "direct" ? "bg-amber-400/20 text-amber-200" : "text-muted-foreground hover:bg-accent/30"}`}>
          <Database className="h-3 w-3" /> 直接入库(解析文本建索引, 快)
        </button>
      </div>
      </div>

      {/* 拖放区 */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); void addFiles(e.dataTransfer.files); }}
        onClick={() => fileRef.current?.click()}
        className={`mt-2 cursor-pointer rounded-lg border-2 border-dashed p-4 text-center transition-colors ${dragOver ? "border-amber-400/60 bg-amber-400/5" : "border-border/60 hover:border-amber-400/40"}`}>
        <FileUp className="mx-auto h-5 w-5 text-muted-foreground/50" />
        <p className="mt-1 text-[11px] text-muted-foreground">拖拽文件到此处, 或点击选择(可多选)</p>
        <p className="text-[9px] text-muted-foreground/50">支持 {ACCEPT}</p>
        <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
      </div>

      {/* 文件列表 */}
      {items.length > 0 && (
        <div className="mt-2 space-y-1">
          {items.map((item, i) => {
            const r = results[i];
            const isOpen = expanded === i;
            return (
              <div key={i} className="rounded border border-border/40 bg-background/25">
                <div className="flex items-center gap-2 px-2 py-1.5 text-[11px]">
                  <span className="min-w-0 flex-1 truncate">{item.file.name} <span className="text-[9px] text-muted-foreground/50">({(item.file.size / 1024).toFixed(0)}KB)</span></span>
                  {r && (r.ok
                    ? <span className="rounded bg-emerald-400/10 px-1.5 py-0.5 text-[9px] text-emerald-300">✓ {r.charCount}字</span>
                    : <span className="rounded bg-red-400/10 px-1.5 py-0.5 text-[9px] text-red-300">✗ 失败</span>)}
                  {stored.has(i) && <span className="rounded bg-sky-400/10 px-1.5 py-0.5 text-[9px] text-sky-300">已入库</span>}
                  {r?.ok && !stored.has(i) && (
                    <button type="button" onClick={() => setStored((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                      className={`rounded px-1.5 py-0.5 text-[9px] ${stored.has(i) ? "bg-sky-400/20 text-sky-300" : "text-muted-foreground/60 hover:text-sky-300"}`}>
                      {stored.has(i) ? "✓ 入库" : "勾选入库"}
                    </button>
                  )}
                  <button type="button" onClick={() => r && setExpanded(isOpen ? null : i)} className="text-muted-foreground/50 hover:text-foreground">
                    {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  </button>
                  <button type="button" onClick={() => removeAt(i)} className="text-muted-foreground/40 hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
                </div>
                {isOpen && r && (
                  <div className="max-h-40 overflow-y-auto border-t border-border/30 p-2">
                    {r.ok
                      ? <pre className="whitespace-pre-wrap text-[10px] leading-4 text-muted-foreground">{r.text.slice(0, 6000)}</pre>
                      : <p className="text-[10px] text-red-300">{r.error}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 操作 */}
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={runParse} disabled={parsing || items.length === 0}
          className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-amber-400 disabled:opacity-40">
          {parsing ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileUp className="h-3 w-3" />}
          {parsing ? "解析中…" : "批量解析"}
        </button>
        <button type="button" onClick={storeSelected} disabled={storing || results.filter((r) => r?.ok).length === 0}
          className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-400 disabled:opacity-40">
          {storing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Database className="h-3 w-3" />}
          {storing ? "入库中…" : "勾选入库(检索用)"}
        </button>
        {storeMsg && <span className="text-[11px] text-muted-foreground">{storeMsg}</span>}
      </div>
    </div>
  );
}
