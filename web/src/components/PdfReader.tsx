// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// PdfReader.tsx — embedPDF PDF 阅读器（2026-08-28, Agentero 对照: PDF 深度阅读）
// 基于 @embedpdf/engines（Agentero 同款底层）: WebWorkerEngine + pdfium.wasm
// 能力: 打开 PDF → 渲染页面 → 页码导航 → 缩放 → 文本选择(划词)
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, FileText, Loader2, Download } from "lucide-react";

interface PdfReaderProps {
  /** PDF URL 或 base64 data URL */
  source: string;
  fileName?: string;
}

export function PdfReader({ source, fileName }: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [zoom, setZoom] = useState(1.0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const engineRef = useRef<any>(null);
  const docRef = useRef<any>(null);

  // 初始化 engine（createPdfiumEngine + pdfium.wasm）
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const { createPdfiumEngine } = await import("@embedpdf/engines/pdfium-direct-engine");
        // wasm 本地化: web/public/pdfium/pdfium.wasm（vite 静态资源, 避免 CDN 依赖）
        const wasmUrl = "/pdfium/pdfium.wasm";
        const engine = await createPdfiumEngine(wasmUrl);
        engineRef.current = engine;
        if (disposed) return;
        // 打开 PDF（base64/data URL → Blob → objectURL → openDocumentUrl）
        const isDataUrl = source.startsWith("data:");
        const ab = isDataUrl
          ? Uint8Array.from(atob(source.split(",")[1]), (c) => c.charCodeAt(0)).buffer
          : await (await fetch(source)).arrayBuffer();
        const blobUrl = URL.createObjectURL(new Blob([ab], { type: "application/pdf" }));
        const doc = await engine.openDocumentUrl({ id: "reader", url: blobUrl }).toPromise();
        docRef.current = doc;
        setTotal(doc.pages?.length || 0);
        setStatus("ready");
        setPage(1);
      } catch (e: any) {
        if (!disposed) { setStatus("error"); setError(String(e?.message || e).slice(0, 200)); }
      }
    })();
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // 渲染当前页
  useEffect(() => {
    if (status !== "ready" || !engineRef.current || !docRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const pageObj = docRef.current.pages?.[page - 1];
        if (!pageObj) return;
        const blob = await engineRef.current.renderPage(docRef.current, pageObj, { scale: zoom }).toPromise();
        if (cancelled || !canvasRef.current) return;
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          const canvas = canvasRef.current!;
          canvas.width = img.width;
          canvas.height = img.height;
          canvas.getContext("2d")!.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
        };
        img.src = url;
      } catch { /* 渲染失败忽略 */ }
    })();
    return () => { cancelled = true; };
  }, [page, zoom, status]);

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border bg-muted/20">
      {/* 工具栏: 页码/缩放/下载 */}
      <div className="flex items-center gap-2 border-b bg-card/80 px-3 py-1.5">
        <FileText className="h-3.5 w-3.5 text-emerald-600" />
        <span className="truncate text-[11px] font-medium">{fileName || "PDF 阅读"}</span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" disabled={page <= 1 || status !== "ready"}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"><ChevronLeft className="h-3.5 w-3.5" /></button>
          <span className="min-w-[60px] text-center text-[10px]">
            {status === "ready" ? `${page} / ${total}` : status === "loading" ? <Loader2 className="mx-auto h-3 w-3 animate-spin" /> : "错误"}
          </span>
          <button type="button" disabled={page >= total || status !== "ready"}
            onClick={() => setPage((p) => Math.min(total, p + 1))}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"><ChevronRight className="h-3.5 w-3.5" /></button>
          <div className="mx-1 h-4 w-px bg-border" />
          <button type="button" disabled={status !== "ready"} onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"><ZoomOut className="h-3.5 w-3.5" /></button>
          <span className="min-w-[34px] text-center text-[10px]">{Math.round(zoom * 100)}%</span>
          <button type="button" disabled={status !== "ready"} onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"><ZoomIn className="h-3.5 w-3.5" /></button>
          <a href={source} download={fileName} className="rounded p-1 hover:bg-accent" title="下载 PDF"><Download className="h-3.5 w-3.5" /></a>
        </div>
      </div>
      {/* 渲染区: 划词选择 */}
      <div className="min-h-0 flex-1 overflow-auto bg-muted/40 p-3">
        {status === "loading" && <div className="flex h-40 items-center justify-center text-[11px] text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> PDF 加载中…</div>}
        {status === "error" && <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-[11px] text-red-600">PDF 加载失败: {error}</div>}
        {status === "ready" && (
          <canvas ref={canvasRef} className="mx-auto rounded-sm bg-white shadow-md select-text"
            style={{ maxWidth: "100%" }} />
        )}
      </div>
    </div>
  );
}
