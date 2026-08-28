// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// PdfReader.tsx — embedPDF PDF 阅读器（Agentero 同款架构: 官方插件体系, v5）
// 基于 @embedpdf/core@2.14.4(与 Agentero 版本对齐) + 官方插件
// 文字选择用 SelectionLayer(原生文本层划选, 精确到字符) — 非手写矩形框选
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, FileText, Loader2, Download, Languages, X } from "lucide-react";
import { createPluginRegistration } from "@embedpdf/core";
import { EmbedPDF } from "@embedpdf/core/react";
import { DocumentManagerPluginPackage, DocumentContent } from "@embedpdf/plugin-document-manager/react";
import { ScrollPluginPackage, Scroller, useScroll } from "@embedpdf/plugin-scroll/react";
import { RenderPluginPackage, RenderLayer } from "@embedpdf/plugin-render/react";
import { SelectionPluginPackage, useSelectionCapability, SelectionLayer } from "@embedpdf/plugin-selection/react";
import { ViewportPluginPackage } from "@embedpdf/plugin-viewport/react";
import { ZoomPluginPackage } from "@embedpdf/plugin-zoom/react";
import { TilingPluginPackage } from "@embedpdf/plugin-tiling/react";
import { InteractionManagerPluginPackage, PagePointerProvider } from "@embedpdf/plugin-interaction-manager/react";
import { api } from "../lib/api";

interface PdfReaderProps {
  /** PDF URL 或 base64 data URL */
  source: string;
  fileName?: string;
}

export function PdfReader({ source, fileName }: PdfReaderProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [total, setTotal] = useState(0);
  const docId = useRef(`reader-${Math.random().toString(36).slice(2)}`).current;

  // 翻页（useScroll 必须在 EmbedPDF 内, 用独立子组件提供）
  const [currentPage, setCurrentPage] = useState(1);
  const [scrollToPageFn, setScrollToPageFn] = useState<((p: number) => void) | null>(null);
  // 缩放（手动 scale, 直接驱动 RenderLayer, 不依赖 zoom 插件）
  const [manualZoomLevel, setManualZoomLevel] = useState<number | null>(null);

  const manualZoomIn = () => {
    setManualZoomLevel((z) => Math.min(3, (z ?? 1) * 1.2));
  };
  const manualZoomOut = () => {
    setManualZoomLevel((z) => Math.max(0.5, (z ?? 1) / 1.2));
  };

  const goToPage = (p: number) => {
    const target = Math.max(1, Math.min(p, total || p));
    if (scrollToPageFn) {
      scrollToPageFn(target);
      return;
    }
    // 兜底: 手动滚动 Scroller 容器到目标页
    const scroller = hostRef.current?.querySelector("[data-scroller]") as HTMLElement | null;
    const pageEl = hostRef.current?.querySelector(`[data-page-index="${target - 1}"]`) as HTMLElement | null;
    if (scroller && pageEl) {
      scroller.scrollTo({ top: pageEl.offsetTop, behavior: "smooth" });
      setCurrentPage(target);
    }
  };
  const [translate, setTranslate] = useState<{ snippet: string; x: number; y: number } | null>(null);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<{ action: string; text: string } | null>(null);
  const [aiError, setAiError] = useState("");
  const [aiQuestion, setAiQuestion] = useState("");
  const [cardPos, setCardPos] = useState<{ x: number; y: number } | null>(null);
  const cardDragRef = useRef<{ dx: number; dy: number } | null>(null);

  // 引擎（动态 import）
  const [engine, setEngine] = useState<any>(null);
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const { createPdfiumEngine } = await import("@embedpdf/engines/pdfium-direct-engine");
        const eng = await createPdfiumEngine("/pdfium/pdfium.wasm");
        if (disposed) return;
        setEngine(eng);
      } catch (e: any) {
        if (!disposed) { setStatus("error"); setError(String(e?.message || e).slice(0, 200)); }
      }
    })();
    return () => { disposed = true; };
  }, []);

  // 插件注册（Agentero 同款完整列表）
  const plugins = useMemo2(() => {
    if (!engine) return null;
    return [
      createPluginRegistration(DocumentManagerPluginPackage, {
        initialDocuments: [{ url: source, documentId: docId, name: fileName ?? docId }]
      }),
      createPluginRegistration(ViewportPluginPackage),
      createPluginRegistration(ScrollPluginPackage, { defaultBufferSize: 2 }),
      createPluginRegistration(RenderPluginPackage),
      createPluginRegistration(TilingPluginPackage, { tileSize: 1024 }),
      createPluginRegistration(ZoomPluginPackage, { defaultZoomLevel: 1 }),
      createPluginRegistration(InteractionManagerPluginPackage),
      createPluginRegistration(SelectionPluginPackage, { marquee: { enabled: false } }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, source]);

  // 文字选择完成 → 弹 AI 卡片（SelectionWatcher 在 EmbedPDF 内, 见文件底部）
  const hostRef = useRef<HTMLDivElement | null>(null);

  /** 卡片位置钳制在视口内 */
  const clampCardPos = (p: { x: number; y: number }) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const CARD_H = 340;
    let x = Math.max(8, Math.min(p.x, vw - 360));
    let y = p.y + 12;
    if (y + CARD_H > vh - 8) y = Math.max(8, p.y - CARD_H - 12);
    y = Math.max(8, Math.min(y, vh - CARD_H));
    return { x, y };
  };

  const doAiAction = async (action: "explain" | "summarize" | "translate" | "ask") => {
    if (!translate || aiBusy) return;
    if (action === "ask" && !aiQuestion.trim()) return;
    setAiBusy(action);
    setAiError("");
    try {
      const r = await api.readerAi({
        action,
        snippet: translate.snippet,
        question: action === "ask" ? aiQuestion.trim() : undefined
      });
      if (r?.ok) {
        setAiResult({ action, text: r.result ?? "" });
        if (action === "ask") setAiQuestion("");
      } else {
        setAiError(r?.error || "AI 处理失败");
      }
    } catch (err: any) {
      setAiError(String(err?.message || err).slice(0, 120));
    } finally {
      setAiBusy(null);
    }
  };

  /** 页面渲染（每页: RenderLayer 底图 + PagePointerProvider + SelectionLayer 文字选择）
   *  容器尺寸 = 布局尺寸 × 手动缩放(manualZoomLevel), img 才能随缩放变大 */
  const renderPage = useCallback(({ pageIndex, width, height }: { pageIndex: number; width: number; height: number }) => {
    const z = manualZoomLevel ?? 1;
    return (
      <div data-page-index={pageIndex} style={{ position: "relative", width: width * z, height: height * z }}>
        <RenderLayer documentId={docId} pageIndex={pageIndex} scale={z} style={{ position: "absolute", inset: 0 }} />
        <PagePointerProvider documentId={docId} pageIndex={pageIndex} style={{ position: "absolute", inset: 0 }}>
          <SelectionLayer
            documentId={docId}
            pageIndex={pageIndex}
            textStyle={{ background: "rgba(59, 130, 246, 0.25)" }}
          />
        </PagePointerProvider>
      </div>
    );
  }, [docId, manualZoomLevel]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-muted/20">
      {/* 工具栏 */}
      <div className="relative z-10 flex items-center gap-2 border-b bg-card/80 px-3 py-1.5">
        <FileText className="h-3.5 w-3.5 text-emerald-600" />
        <span className="truncate text-[11px] font-medium">{fileName || "PDF 阅读"}</span>
        <span className="shrink-0 rounded bg-emerald-100 px-1 py-0.5 text-[9px] font-semibold text-emerald-700">v5.1</span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" disabled={status !== "ready" || total === 0}
            onClick={() => goToPage(currentPage - 1)}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"><ChevronLeft className="h-3.5 w-3.5" /></button>
          <span className="min-w-[60px] text-center text-[10px]">
            {status === "ready" ? `${currentPage} / ${total || "?"}` : status === "loading" ? <Loader2 className="mx-auto h-3 w-3 animate-spin" /> : "错误"}
          </span>
          <button type="button" disabled={status !== "ready" || total === 0}
            onClick={() => goToPage(currentPage + 1)}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"><ChevronRight className="h-3.5 w-3.5" /></button>
          <div className="mx-1 h-4 w-px bg-border" />
          <button type="button" disabled={!manualZoomLevel || manualZoomLevel <= 0.5}
            onClick={manualZoomOut}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"><ZoomOut className="h-3.5 w-3.5" /></button>
          <span className="min-w-[34px] text-center text-[10px]">{manualZoomLevel ? `${Math.round(manualZoomLevel * 100)}%` : "100%"}</span>
          <button type="button" disabled={!!manualZoomLevel && manualZoomLevel >= 3}
            onClick={manualZoomIn}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"><ZoomIn className="h-3.5 w-3.5" /></button>
          <a href={source} download={fileName} className="rounded p-1 hover:bg-accent" title="下载 PDF"><Download className="h-3.5 w-3.5" /></a>
        </div>
      </div>

      {/* 渲染区 */}
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-auto bg-muted/40">
        {status === "loading" && <div className="flex h-40 items-center justify-center text-[11px] text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> PDF 加载中…</div>}
        {status === "error" && <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-[11px] text-red-600">PDF 加载失败: {error}</div>}
        {engine && plugins && (
          <EmbedPDF key={docId} engine={engine} plugins={plugins}>
            <ScrollController
              docId={docId}
              onReady={(scrollToPage, currentPage, totalPages) => {
                setScrollToPageFn(() => scrollToPage);
                setCurrentPage((prev) => (prev === currentPage ? prev : currentPage));
                setTotal((prev) => (prev === totalPages ? prev : totalPages));
              }}
              onPageChange={(page, totalPages) => {
                // 值比较防无限循环(React 185)
                setCurrentPage((prev) => (prev === page ? prev : page));
                setTotal((prev) => (prev === totalPages ? prev : totalPages));
              }}
            />
            <SelectionWatcher
              docId={docId}
              hostRef={hostRef}
              onSelect={(quote, anchor) => {
                setTranslate({ snippet: quote.slice(0, 3000), x: anchor.x, y: anchor.y });
                setCardPos(clampCardPos(anchor));
                setAiResult(null);
                setAiError("");
                setAiQuestion("");
              }}
              onClear={() => setTranslate(null)}
            />
            <DocumentContent documentId={docId}>
              {({ isLoaded, documentState }) => {
                if (!isLoaded) {
                  return <div className="flex h-40 items-center justify-center text-[11px] text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> 文档加载中…</div>;
                }
                setStatus("ready");
                // 从 documentState 拿页数
                const pageCount = documentState?.document?.pages?.length;
                if (pageCount && pageCount !== total) setTotal(pageCount);
                return (
                  <Scroller documentId={docId} renderPage={renderPage} data-scroller style={{ height: "100%" }} />
                );
              }}
            </DocumentContent>
          </EmbedPDF>
        )}
      </div>

      {/* AI 卡片 */}
      {translate && (
        <div className="fixed z-50 flex w-[340px] max-w-[90vw] resize flex-col overflow-hidden rounded-lg border bg-card shadow-2xl"
          style={cardPos ? { left: cardPos.x, top: cardPos.y } : { left: Math.min(translate.x, window.innerWidth - 360), top: Math.min(translate.y + 12, window.innerHeight - 360) }}>
          <div
            onMouseDown={(e) => {
              if (e.button !== 0 || !cardPos) return;
              e.preventDefault();
              cardDragRef.current = { dx: e.clientX - cardPos.x, dy: e.clientY - cardPos.y };
              const onMove = (ev: MouseEvent) => {
                if (!cardDragRef.current) return;
                setCardPos(clampCardPos({ x: ev.clientX - cardDragRef.current.dx, y: ev.clientY - cardDragRef.current.dy }));
              };
              const onUp = () => {
                cardDragRef.current = null;
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
            className="mb-1.5 flex cursor-move select-none items-center justify-between border-b border-border/60 px-3 pb-1.5 pt-2"
            title="按住拖动"
          >
            <span className="flex items-center gap-1 text-[11px] font-semibold text-blue-600">
              <Languages className="h-3.5 w-3.5" /> AI 阅读助手（{translate.snippet.length} 字）
            </span>
            <button type="button" onClick={() => setTranslate(null)} className="rounded p-0.5 text-muted-foreground hover:bg-accent">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="px-3">
            <div className="max-h-64 overflow-y-auto rounded bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
              {translate.snippet.slice(0, 3000)}{translate.snippet.length > 3000 ? "…" : ""}
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              <button type="button" onClick={() => void doAiAction("explain")} disabled={!!aiBusy}
                className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700 transition-colors hover:bg-blue-100 disabled:opacity-50">
                {aiBusy === "explain" ? <Loader2 className="mx-auto h-3 w-3 animate-spin" /> : "解释"}
              </button>
              <button type="button" onClick={() => void doAiAction("summarize")} disabled={!!aiBusy}
                className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50">
                {aiBusy === "summarize" ? <Loader2 className="mx-auto h-3 w-3 animate-spin" /> : "总结"}
              </button>
              <button type="button" onClick={() => void doAiAction("translate")} disabled={!!aiBusy}
                className="rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-[11px] font-medium text-violet-700 transition-colors hover:bg-violet-100 disabled:opacity-50">
                {aiBusy === "translate" ? <Loader2 className="mx-auto h-3 w-3 animate-spin" /> : "翻译"}
              </button>
            </div>
            <div className="mt-2 flex gap-1.5">
              <input
                value={aiQuestion}
                onChange={(e) => setAiQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && aiQuestion.trim()) void doAiAction("ask"); }}
                placeholder="追问这段文本…（Enter 发送）"
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-[11px]"
              />
              <button type="button" onClick={() => void doAiAction("ask")} disabled={!!aiBusy || !aiQuestion.trim()}
                className="rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50">
                {aiBusy === "ask" ? <Loader2 className="h-3 w-3 animate-spin" /> : "问"}
              </button>
            </div>
            {aiResult && (
              <div className="mt-2 max-h-64 overflow-y-auto rounded border border-blue-500/20 bg-blue-500/10 p-2 text-[11px] leading-relaxed text-blue-900">
                <div className="mb-1 text-[10px] font-semibold text-blue-600">
                  {aiResult.action === "explain" ? "解释" : aiResult.action === "summarize" ? "总结" : aiResult.action === "translate" ? "译文" : "回答"}
                </div>
                {aiResult.text}
              </div>
            )}
            {aiError && <div className="mt-2 rounded border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-600">{aiError}</div>}
            {aiResult && (
              <button type="button" onClick={() => { setTranslate(null); setAiResult(null); setAiError(""); setAiQuestion(""); }}
                className="mt-1.5 w-full text-center text-[10px] text-muted-foreground hover:underline">
                关闭
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** useMemo 兼容 */
function useMemo2<T>(factory: () => T, deps: any[]): T | null {
  const ref = useRef<{ v: T; d: any[] } | null>(null);
  if (!ref.current || deps.some((d, i) => d !== ref.current!.d[i])) {
    ref.current = { v: factory(), d: deps };
  }
  return ref.current!.v;
}

/** 翻页控制器（必须在 EmbedPDF provider 内调用 useScroll） */
function ScrollController({
  docId,
  onReady,
  onPageChange
}: {
  docId: string;
  onReady: (scrollToPage: (p: number) => void, currentPage: number, totalPages: number) => void;
  onPageChange: (page: number, totalPages: number) => void;
}) {
  const { provides } = useScroll(docId);
  const readyRef = useRef(false);

  useEffect(() => {
    if (!provides) return;
    // onReady 只调用一次(provides 每次渲染都是新引用, 直接依赖会死循环)
    if (!readyRef.current) {
      readyRef.current = true;
      onReady(
        (p: number) => provides.scrollToPage({ pageNumber: p }),
        provides.getCurrentPage(),
        provides.getTotalPages()
      );
    }
    return provides.onPageChange((event) => {
      onPageChange(event.pageNumber, event.totalPages);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provides, docId]);

  return null;
}

/** 文字选择监听（必须在 EmbedPDF provider 内调用 useSelectionCapability） */
function SelectionWatcher({
  docId,
  hostRef,
  onSelect,
  onClear
}: {
  docId: string;
  hostRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (quote: string, anchor: { x: number; y: number }) => void;
  onClear: () => void;
}) {
  const { provides: selectionCap } = useSelectionCapability();
  const capRef = useRef(selectionCap);

  useEffect(() => {
    // selectionCap 每次渲染可能是新引用 → 用 ref 稳定化, 只订阅一次
    if (selectionCap && !capRef.current) capRef.current = selectionCap;
    const cap = capRef.current;
    if (!cap) return;
    const scope = cap.forDocument(docId);
    if (!scope) return;
    const offEnd = scope.onEndSelection(() => {
      const pages = scope.getFormattedSelection();
      if (!pages.length) return;
      void (async () => {
        let quote = "";
        try {
          const lines = await scope.getSelectedText().toPromise();
          quote = (lines ?? []).join(" ").replace(/\s+/g, " ").trim();
        } catch { /* best effort */ }
        if (!quote || quote.length < 2) return;
        // 卡片定位: 选区中心
        const first = pages[0];
        const pageEl = hostRef.current?.querySelector(`[data-page-index="${first.pageIndex}"]`) as HTMLElement | null;
        let anchor = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        if (pageEl && first.rect) {
          const pr = pageEl.getBoundingClientRect();
          const rx = first.rect.origin.x;
          const ry = first.rect.origin.y;
          const rw = first.rect.size.width;
          const rh = first.rect.size.height;
          const selRect = {
            left: pr.left + rx * (pr.width / 100),
            top: pr.top + ry * (pr.height / 100),
            width: rw * (pr.width / 100),
            height: rh * (pr.height / 100)
          };
          anchor = { x: selRect.left + selRect.width / 2, y: selRect.top + selRect.height / 2 };
        }
        onSelect(quote, anchor);
      })();
    });
    const offChange = scope.onSelectionChange((sel) => {
      if (!sel) onClear();
    });
    return () => { offEnd(); offChange(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]); // 只订阅一次, 不依赖 selectionCap(新引用)

  return null;
}
