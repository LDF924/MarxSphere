// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// BatchUploadPanel.tsx — 批量文件上传·暂存·提交(双模式)
// 流程(借鉴 OpenSquilla attachment-drag-upload-spec 状态机):
//   拖入/选择 → staged(暂存, 不解析) → 逐文件或批量解析(ready/failed, 失败可单独重试)
//   → 勾选核对(提交前确认) → 提交(P2O 深度加工 | 直接入库建索引)
// 文件状态机: staged → parsing → parsed_ok | parsed_err(→ retry) → submitted
import { useRef, useState } from "react";
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Database, FileUp,
  Loader2, RefreshCw, ScanText, Trash2, X,
} from "lucide-react";

interface ParsedItem {
  fileName: string;
  ok: boolean;
  text: string;
  charCount: number;
  error?: string;
}

type ItemState = "staged" | "parsing" | "parsed_ok" | "parsed_err" | "submitted";

interface UploadItem {
  file: File;
  base64: string;
  state: ItemState;
  errMsg?: string;
  result?: ParsedItem; // parsed_ok 后有效
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
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [storeMsg, setStoreMsg] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [mode, setMode] = useState<"p2o" | "direct">("p2o"); // p2o=深度加工(PDF2Obsidian) direct=直接入库原文
  const [confirmOpen, setConfirmOpen] = useState(false); // 提交前核对弹层(暂存→提交的"确认"步骤)
  const fileRef = useRef<HTMLInputElement>(null);

  const patch = (idx: number, p: Partial<UploadItem>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...p } : it)));

  // ── 1. 暂存: 拖入/选择 → 读取为 base64, 状态 staged(不自动解析) ──
  const stageFiles = async (list: FileList | null) => {
    if (!list) return;
    const arr: UploadItem[] = [];
    for (const f of Array.from(list)) {
      if (f.size > 40 * 1024 * 1024) { setStoreMsg(`跳过 ${f.name}(>40MB)`); continue; }
      if (f.size === 0) { setStoreMsg(`跳过 ${f.name}(空文件)`); continue; }
      try { arr.push({ file: f, base64: await fileToBase64(f), state: "staged" }); } catch { /* 忽略读取失败 */ }
    }
    if (arr.length === 0) return;
    setItems((prev) => [...prev, ...arr]);
    setStoreMsg(`📥 已暂存 ${arr.length} 个文件 — 解析确认后才入库`);
  };

  // ── 2. 解析(单文件或全部); 失败文件状态 parsed_err, 可单独重试 ──
  const parseOne = async (idx: number) => {
    const it = items[idx];
    if (!it || it.state === "parsing" || it.state === "submitted") return;
    patch(idx, { state: "parsing", errMsg: undefined });
    try {
      const res = await fetch("/api/files/batch-parse", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: [{ name: it.file.name, base64: it.base64 }], maxChars: 12000 }),
      });
      const d = await res.json();
      const r: ParsedItem | undefined = d?.results?.[0];
      if (!res.ok || !r) throw new Error(d?.error?.message ?? "解析失败");
      patch(idx, { state: r.ok ? "parsed_ok" : "parsed_err", result: r, errMsg: r.ok ? undefined : r.error });
    } catch (e) {
      patch(idx, { state: "parsed_err", errMsg: e instanceof Error ? e.message : String(e) });
    }
  };

  const parseAll = async () => {
    const targets = items.map((it, i) => (it.state === "staged" || it.state === "parsed_err" ? i : -1)).filter((i) => i >= 0);
    if (targets.length === 0) { setStoreMsg("没有待解析的文件"); return; }
    setBusy(true); setStoreMsg("");
    for (const i of targets) await parseOne(i);
    setBusy(false);
    const okN = items.filter((it) => it.state === "parsed_ok").length;
    const errN = items.filter((it) => it.state === "parsed_err").length;
    setStoreMsg(`✅ 解析完成: ${okN} 成功 / ${errN} 失败(失败项可点↻重试) — 勾选后入库`);
  };

  const retryFailed = async () => {
    const failed = items.map((it, i) => (it.state === "parsed_err" ? i : -1)).filter((i) => i >= 0);
    if (failed.length === 0) return;
    setBusy(true);
    for (const i of failed) await parseOne(i);
    setBusy(false);
  };

  const removeAt = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
    if (expanded === idx) setExpanded(null);
  };

  // ── 3. 提交(确认后): 勾选的 parsed_ok → P2O 或直接入库; 单个失败不影响其它, 可重试 ──
  const commitItems = async (idxs: number[]) => {
    if (idxs.length === 0) return;
    setBusy(true); setStoreMsg(`提交中(0/${idxs.length})…`);
    let ok = 0;
    let failedList: string[] = [];
    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k];
      const it = items[i];
      try {
        if (mode === "p2o") {
          if (!it.file.name.toLowerCase().endsWith(".pdf")) {
            failedList.push(`${it.file.name}(P2O 仅支持 PDF)`);
            setStoreMsg(`跳过 ${it.file.name}(P2O 仅支持 PDF)`);
            continue;
          }
          const res = await fetch("/api/p2o/tasks", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileName: it.file.name, fileBase64: it.base64 }),
          });
          if (res.ok || res.status === 201) { ok++; patch(i, { state: "submitted" }); }
          else failedList.push(it.file.name);
        } else {
          const res = await fetch("/api/documents/upload", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sourceId: sourceId || undefined,
              fileName: `${it.file.name.replace(/\.[^.]+$/, "")}.md`,  // upload 限 .md/.txt, 标题保留原名
              title: it.file.name.replace(/\.[^.]+$/, ""),
              content: it.result!.text.slice(0, 200_000),
              extract: true,
            }),
          });
          if (res.ok || res.status === 201) { ok++; patch(i, { state: "submitted" }); }
          else failedList.push(it.file.name);
        }
        setStoreMsg(`提交中(${k + 1}/${idxs.length})…`);
      } catch { failedList.push(it.file.name); }
    }
    setStoreMsg(mode === "p2o"
      ? `✅ 已提交 ${ok}/${idxs.length} 篇到 P2O 管线(可在「文献管理→PDF2Obsidian」看进度)${failedList.length ? `; 失败: ${failedList.join("、")} 可重试` : ""}`
      : `✅ 入库完成: ${ok}/${idxs.length} 篇(可在文献库检索)${failedList.length ? `; 失败: ${failedList.join("、")} 可重试` : ""}`);
    setConfirmOpen(false);
    setBusy(false);
  };

  const confirmCommit = () => {
    const ready = items.map((it, i) => (it.state === "parsed_ok" ? i : -1)).filter((i) => i >= 0);
    if (ready.length === 0) { setStoreMsg("先解析文件(成功后可提交)"); return; }
    setConfirmOpen(true);
  };

  const nStaged = items.filter((it) => it.state === "staged").length;
  const nReady = items.filter((it) => it.state === "parsed_ok").length;
  const nErr = items.filter((it) => it.state === "parsed_err").length;
  const nDone = items.filter((it) => it.state === "submitted").length;

  return (
    <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.03] p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-amber-200/90">
        <FileUp className="h-4 w-4" /> 批量上传·暂存·提交
        <span className="text-[9px] font-normal text-muted-foreground/60">拖入=暂存 → 解析预览 → 确认 → 入库/深度加工</span>
        <span className="ml-auto flex gap-1 text-[10px] text-muted-foreground/60">
          {nStaged > 0 && <span className="rounded bg-slate-400/10 px-1 py-0.5 text-slate-300">暂存 {nStaged}</span>}
          {nReady > 0 && <span className="rounded bg-emerald-400/10 px-1 py-0.5 text-emerald-300">待提交 {nReady}</span>}
          {nErr > 0 && <span className="rounded bg-red-400/10 px-1 py-0.5 text-red-300">失败 {nErr}</span>}
          {nDone > 0 && <span className="rounded bg-sky-400/10 px-1 py-0.5 text-sky-300">已提交 {nDone}</span>}
        </span>
      </div>

      {/* 处理模式选择 */}
      <div className="mt-1 flex gap-1">
        <button type="button" onClick={() => setMode("p2o")}
          className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] ${mode === "p2o" ? "bg-amber-400/20 text-amber-200" : "text-muted-foreground hover:bg-accent/30"}`}>
          <ScanText className="h-3 w-3" /> PDF2Obsidian 深度加工(OCR/公式/表格/双语, 慢)
        </button>
        <button type="button" onClick={() => setMode("direct")}
          className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] ${mode === "direct" ? "bg-amber-400/20 text-amber-200" : "text-muted-foreground hover:bg-accent/30"}`}>
          <Database className="h-3 w-3" /> 直接入库(解析文本建索引, 快)
        </button>
      </div>

      {/* 拖放区(暂存) */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); void stageFiles(e.dataTransfer.files); }}
        onClick={() => fileRef.current?.click()}
        className={`mt-2 cursor-pointer rounded-lg border-2 border-dashed p-4 text-center transition-colors ${dragOver ? "border-amber-400/60 bg-amber-400/5" : "border-border/60 hover:border-amber-400/40"}`}>
        <FileUp className="mx-auto h-5 w-5 text-muted-foreground/50" />
        <p className="mt-1 text-[11px] text-muted-foreground">拖拽文件到此处暂存, 或点击选择(可多选)</p>
        <p className="text-[9px] text-muted-foreground/50">支持 {ACCEPT} · 暂存不解析, 确认后才处理</p>
        <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { void stageFiles(e.target.files); e.target.value = ""; }} />
      </div>

      {/* 文件清单(状态机逐项显示) */}
      {items.length > 0 && (
        <div className="mt-2 space-y-1">
          {items.map((item, i) => {
            const isOpen = expanded === i;
            const r = item.result;
            return (
              <div key={`${item.file.name}-${i}`} className="rounded border border-border/40 bg-background/25">
                <div className="flex items-center gap-2 px-2 py-1.5 text-[11px]">
                  <span className="min-w-0 flex-1 truncate">{item.file.name} <span className="text-[9px] text-muted-foreground/50">({(item.file.size / 1024).toFixed(0)}KB)</span></span>
                  {item.state === "parsed_ok" && <span className="rounded bg-emerald-400/10 px-1.5 py-0.5 text-[9px] text-emerald-300">✓ {r!.charCount}字</span>}
                  {item.state === "parsed_err" && <span className="rounded bg-red-400/10 px-1.5 py-0.5 text-[9px] text-red-300">✗ {item.errMsg ? item.errMsg.slice(0, 24) : "失败"}</span>}
                  {item.state === "staged" && <span className="rounded bg-slate-400/10 px-1.5 py-0.5 text-[9px] text-slate-300">暂存</span>}
                  {item.state === "submitted" && <span className="rounded bg-sky-400/10 px-1.5 py-0.5 text-[9px] text-sky-300">已提交</span>}
                  {/* 单项操作: 解析 / 重试 */}
                  {item.state === "staged" && (
                    <button type="button" onClick={() => void parseOne(i)} disabled={busy}
                      className="rounded px-1.5 py-0.5 text-[9px] text-amber-300/80 hover:text-amber-200 disabled:opacity-40">解析</button>
                  )}
                  {item.state === "parsed_err" && (
                    <button type="button" onClick={() => void parseOne(i)} disabled={busy}
                      className="inline-flex items-center gap-0.5 rounded bg-red-400/10 px-1.5 py-0.5 text-[9px] text-red-300 hover:bg-red-400/20 disabled:opacity-40">
                      <RefreshCw className="h-2.5 w-2.5" /> 重试
                    </button>
                  )}
                  <button type="button" onClick={() => r && setExpanded(isOpen ? null : i)} className="text-muted-foreground/50 hover:text-foreground" disabled={!r}>
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

      {/* 操作: 解析 → 确认提交(两段式) */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={parseAll} disabled={busy || items.length === 0 || (nStaged === 0 && nErr === 0)}
          className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-amber-400 disabled:opacity-40">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileUp className="h-3 w-3" />}
          批量解析暂存
        </button>
        {nErr > 0 && (
          <button type="button" onClick={retryFailed} disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-red-400/30 px-3 py-1.5 text-[11px] text-red-300 hover:bg-red-400/10 disabled:opacity-40">
            <RefreshCw className="h-3 w-3" /> 重试失败({nErr})
          </button>
        )}
        <button type="button" onClick={confirmCommit} disabled={busy || nReady === 0}
          className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-400 disabled:opacity-40">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
          确认提交({nReady})…
        </button>
        {nDone > 0 && (
          <button type="button" onClick={() => setItems([])} className="rounded-md px-2 py-1 text-[10px] text-muted-foreground/60 hover:text-foreground">
            清空已完成
          </button>
        )}
        {storeMsg && <span className="text-[11px] text-muted-foreground">{storeMsg}</span>}
      </div>

      {/* 提交前确认弹层(暂存→提交的最终确认) */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setConfirmOpen(false)}>
          <div className="max-h-[70vh] w-[420px] overflow-y-auto rounded-xl border border-border bg-card p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[13px] font-semibold text-foreground">
                {mode === "p2o" ? "提交到 PDF2Obsidian 深度加工?" : "入库到文献库?"}
              </div>
              <button type="button" onClick={() => setConfirmOpen(false)} className="text-muted-foreground/50 hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <p className="mb-2 text-[11px] text-muted-foreground">
              {mode === "p2o"
                ? "逐文件创建 P2O 任务(OCR/公式/表格/双语→Obsidian 笔记), 进度在「PDF2Obsidian」面板查看。"
                : "以解析文本建索引(可检索), 原文件由上传产物留存。"}
            </p>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border/50 p-2">
              {items.map((it, i) => it.state === "parsed_ok" && (
                <div key={i} className="flex items-center gap-1.5 text-[11px] text-foreground">
                  <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" />
                  <span className="min-w-0 flex-1 truncate">{it.file.name}</span>
                  <span className="shrink-0 text-[9px] text-muted-foreground/60">{it.result!.charCount}字</span>
                </div>
              ))}
            </div>
            {mode === "p2o" && items.some((it) => it.state === "parsed_ok" && !it.file.name.toLowerCase().endsWith(".pdf")) && (
              <div className="mt-2 flex items-start gap-1 rounded-md bg-amber-400/10 p-2 text-[10px] text-amber-200">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> 部分文件非 PDF, P2O 仅支持 PDF — 将跳过并保留在列表(可切「直接入库」处理)
              </div>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmOpen(false)} className="rounded-md px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent/30">返回修改</button>
              <button type="button"
                onClick={() => void commitItems(items.map((it, i) => (it.state === "parsed_ok" ? i : -1)).filter((i) => i >= 0))}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-4 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-400">
                <Database className="h-3 w-3" /> 确认提交
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
