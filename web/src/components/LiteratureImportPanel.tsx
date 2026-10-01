// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// LiteratureImportPanel.tsx — 文献题录文件导入(2026-10-01, 自旧项目 AItoolman 移植)
//
// 由来: 本仓原先只能通过 API 拉文献(OpenAlex/Crossref/arXiv), **没有任何"文件导入"**。
//   而中文用户的主战场在知网 —— 导出的是一个 .txt/.ris 文件, 之前只能手工一条条录。
//
// 交互特意做成两步: **先预览再入库**。题录格式五花八门, 直接入库要是有问题,
//   用户面对的是"导了 800 条, 但不知道对不对"。预览让他先看清识别成什么格式、前几条长什么样。
//
// 第一版丑在: 文件选择是个裸按钮、预览表是原生 `<table>`。改成**拖放区 + 格式徽章 +
//   卡片式条目预览**, 并把"编码"与"跳过了几条"这两个容易被忽略但很关键的信息显式给出。
import { useEffect, useRef, useState } from "react";
import {
  FileUp, Upload, CheckCircle2, AlertTriangle, FileText, Database, X, Loader2, ArrowRight,
} from "lucide-react";
import {
  PanelHeader, PanelCard, PanelButton, PanelEmpty, panelInputCls, StatTile, panelAccent,
} from "./PanelShell";
import { cn } from "../lib/utils";
import { putHandoff, HANDOFF_KIND } from "../lib/handoff";

interface FormatInfo { id: string; label: string; extensions?: string[] }
interface Record {
  title?: string; authors?: string[]; year?: number; journal?: string; doi?: string;
}
interface PreviewResult {
  format: string; formatLabel: string; encoding: string; total: number;
  sample?: Record[]; errors?: Array<{ row: number; reason: string }>;
}
interface ImportResult { imported: number; skipped: number; failed: number; errors?: Array<{ reason: string }> }

export function LiteratureImportPanel({ onNavigate }: { onNavigate?: (v: string) => void } = {}) {
  const [formats, setFormats] = useState<FormatInfo[]>([]);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try { setFormats(((await (await fetch("/api/literature-import/formats")).json()).formats) ?? []); }
      catch { /* 列不出来不影响导入 */ }
    })();
  }, []);

  const readFile = async (f: File) => {
    setErr(""); setDone(null); setPreview(null);
    try {
      /**
       * 题录文件常有 GBK, `readAsText` 会按 UTF-8 解成乱码 ——
       * 交给后端嗅编码: 这里逐字节还原成 latin1 字符串传过去, 后端 decodeBuffer 认 GB18030。
       */
      const bytes = new Uint8Array(await f.arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      setText(s); setFileName(f.name);
    } catch (e) { setErr(`读取文件失败: ${(e as Error).message}`); }
  };

  const doPreview = async () => {
    if (!text.trim()) { setErr("请先选择文件或粘贴题录内容"); return; }
    setBusy("preview"); setErr(""); setDone(null);
    try {
      const r = await fetch("/api/literature-import/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, fileName, maxSample: 8 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || d?.error || "识别失败");
      setPreview(d as PreviewResult);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };

  const doImport = async () => {
    if (!preview) return;
    setBusy("import"); setErr("");
    try {
      const r = await fetch("/api/literature-import/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("sag_token") || ""}` },
        body: JSON.stringify({ content: text, fileName, format: preview.format }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || d?.error || "导入失败");
      setDone(d as ImportResult); setPreview(null); setText(""); setFileName("");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };

  const reset = () => { setText(""); setFileName(""); setPreview(null); setErr(""); };

  const a = panelAccent("emerald");
  const fmtLabel = formats.find((f) => f.id === preview?.format)?.label ?? preview?.formatLabel ?? preview?.format;

  return (
    <div className="space-y-3">
      <PanelHeader
        icon={<FileUp />} accent="emerald" title="题录文件导入"
        subtitle="导入各数据库导出的题录文件（不是 PDF）。格式按内容自动识别，不看扩展名"
        actions={<StatTile accent="emerald" value={formats.length || "—"} label="支持格式" />}
      />

      {/* 拖放区 */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) void readFile(f); }}
        onClick={() => fileRef.current?.click()}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-6 transition-colors",
          drag ? "border-emerald-500/60 bg-emerald-500/10" : "border-border/60 hover:border-emerald-500/40 hover:bg-accent/20",
        )}>
        <input ref={fileRef} type="file" className="hidden"
          accept=".txt,.ris,.bib,.csv,.tsv,.json,.nbib,.enw,.ciw,text/*"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); }} />
        <Upload className={cn("h-5 w-5", drag ? "text-emerald-400" : "text-muted-foreground")} />
        <p className="text-[11px] font-medium">{fileName || "拖入题录文件，或点击选择"}</p>
        <p className="text-[10px] text-muted-foreground">
          支持 WOS / 知网 / RIS / BibTeX / PubMed / Springer / arXiv / OpenAlex / Semantic Scholar / EndNote / CSV
        </p>
        {fileName && (
          <button type="button" onClick={(e) => { e.stopPropagation(); reset(); }}
            className="mt-1 inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent">
            <X className="h-2.5 w-2.5" />清除
          </button>
        )}
      </div>

      <details className="rounded-xl border border-border/50 bg-card/40">
        <summary className="cursor-pointer px-3 py-2 text-[11px] text-muted-foreground">
          或直接粘贴题录内容
        </summary>
        <div className="px-3 pb-3">
          <textarea value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} rows={6}
            placeholder="粘贴题录原文…" className={panelInputCls + " font-mono"} />
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <PanelButton accent="emerald" variant="outline" busy={busy === "preview"} onClick={() => void doPreview()}>
          <FileText className="h-3.5 w-3.5" />识别预览
        </PanelButton>
        {preview && preview.total > 0 && (
          <PanelButton accent="emerald" busy={busy === "import"} onClick={() => void doImport()}>
            <Database className="h-3.5 w-3.5" />确认导入 {preview.total} 条
          </PanelButton>
        )}
      </div>

      {err && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{err}</div>}

      {preview && (
        <PanelCard
          icon={<FileText />} title="识别结果"
          actions={
            <>
              <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium", a.ring, a.text)}>{fmtLabel}</span>
              <StatTile accent="emerald" value={preview.total} label="条" />
              <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground"
                title="中文题录常见 GBK/GB18030，服务端会按内容嗅编码">
                编码 {preview.encoding}
              </span>
            </>
          }>
          {preview.sample?.length ? (
            <div className="space-y-1.5">
              {preview.sample.map((r, i) => (
                <div key={i} className="rounded-lg border border-border/50 px-2.5 py-2">
                  <div className="text-[11px] font-medium leading-5">{r.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                    {(r.authors?.length ?? 0) > 0 && (
                      <span className="truncate">{(r.authors ?? []).slice(0, 3).join("; ")}{(r.authors?.length ?? 0) > 3 ? " 等" : ""}</span>
                    )}
                    {r.year && <span className="tabular-nums">{r.year}</span>}
                    {r.journal && <span className="truncate rounded bg-accent/60 px-1.5 py-px">{r.journal}</span>}
                    {r.doi && <span className="truncate font-mono text-[9px]">{r.doi}</span>}
                  </div>
                </div>
              ))}
              {preview.total > (preview.sample?.length ?? 0) && (
                <p className="pt-1 text-center text-[10px] text-muted-foreground">
                  仅预览前 {preview.sample.length} 条，共 {preview.total} 条
                </p>
              )}
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              没解析出条目 —— 确认这是**题录文件**（数据库导出），而不是 PDF 正文
            </div>
          )}
          {preview.errors?.length ? (
            <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[10px] text-amber-300/90">
              {preview.errors.length} 条被跳过（首条原因：{preview.errors[0].reason}）
            </div>
          ) : null}
        </PanelCard>
      )}

      {done && (
        <PanelCard icon={<CheckCircle2 />} title="导入完成">
          <div className="flex flex-wrap gap-2">
            <StatTile accent="emerald" value={done.imported} label="入库" />
            <StatTile accent="amber" value={done.skipped} label="跳过(重复)" />
            <StatTile accent="rose" value={done.failed} label="失败" />
          </div>
          {done.errors?.length ? (
            <p className="mt-2 text-[10px] text-muted-foreground">首条失败原因：{done.errors[0].reason}</p>
          ) : null}
          {/*
            导入完**给一条去文献库的路** —— 这是本面板唯一有意义的下一步。
            第一版只写了一句"可在「文献库」里看到刚导入的条目", 但要用户自己切过去、
            自己再找 —— 一次导入 800 条之后这么干很难受。
          */}
          {done.imported > 0 && onNavigate && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <PanelButton accent="emerald" size="sm"
                onClick={() => { putHandoff("题录导入", HANDOFF_KIND.NAV_ONLY, {}); onNavigate("literature"); }}>
                <ArrowRight className="h-3 w-3" />去文献库查看这 {done.imported} 条
              </PanelButton>
              <span className="text-[10px] text-muted-foreground">刚导入的条目会排在最前</span>
            </div>
          )}
        </PanelCard>
      )}

      {!preview && !done && !busy && !err && (
        <PanelEmpty>选择或拖入题录文件后点「识别预览」—— 先看清识别成什么格式、前几条长什么样，再决定是否入库</PanelEmpty>
      )}
    </div>
  );
}
