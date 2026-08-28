// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// PdfReader.tsx — embedPDF PDF 阅读器（官方插件体系, v6）
// 基于 @embedpdf/core@2.14.4 官方插件组合:
//   Viewport(滚动容器, 消费 scrollRequests) + Scroller(虚拟化) + RenderLayer(渲染)
//   + SelectionLayer(原生文本层划选) + ZoomPlugin(核心 scale 联动缩放)
// 修复记录(v5 → v6):
//   [翻页不生效] v5 缺 Viewport 组件 — scrollToPage 发出的滚动请求无人消费(页码变化但 scrollTop 恒 0)
//   [光标透明] selection handler setCursor("text") 只在 global scope 应用, page scope 冻结 cursor:auto
//              改用 CSS 强制 .pdf-page { cursor: text } + SVG 红色十字
//   [缩放错位] v5 手动 scale 不同步 documentState.scale, RenderLayer/坐标/滚动全错位
//              改用官方 zoom 插件 requestZoom(核心 scale 联动, 自动居中+滚动补偿)
//   [高亮错位] SelectionLayer 传 scale, 缩放后高亮 rect 正确
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, FileText, Loader2, Download } from "lucide-react";
import { createPluginRegistration } from "@embedpdf/core";
import { EmbedPDF } from "@embedpdf/core/react";
import { DocumentManagerPluginPackage, DocumentContent } from "@embedpdf/plugin-document-manager/react";
import { ScrollPluginPackage, Scroller, useScroll } from "@embedpdf/plugin-scroll/react";
import { RenderPluginPackage, RenderLayer } from "@embedpdf/plugin-render/react";
import { SelectionPluginPackage, useSelectionCapability, SelectionLayer } from "@embedpdf/plugin-selection/react";
import { ViewportPluginPackage, Viewport, useViewportCapability } from "@embedpdf/plugin-viewport/react";
import { ZoomPluginPackage, useZoom } from "@embedpdf/plugin-zoom/react";
import { TilingPluginPackage } from "@embedpdf/plugin-tiling/react";
import { InteractionManagerPluginPackage, PagePointerProvider } from "@embedpdf/plugin-interaction-manager/react";
import { api } from "../lib/api";
import { ReaderAiCard } from "./ReaderAiCard";

// ── 划词光标: selection 插件 setCursor("text") 只在 global scope 应用, page scope 冻结 cursor:auto
//   PagePointerProvider 还会在页面层上内联 cursor: auto 覆盖外层样式。
//   这里用 !important 强制红色十字光标(覆盖内联 auto) — 用户可见性修复
const SELECTION_CURSOR_CSS = `
.pdf-page-cursor,
.pdf-page-cursor:hover,
.pdf-page-cursor > div,
.pdf-page-cursor > div:hover,
.pdf-page-cursor canvas,
.pdf-page-cursor img {
  cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M12 1v22M1 12h22' stroke='%23e11d48' stroke-width='2.5' stroke-linecap='round'/%3E%3Ccircle cx='12' cy='12' r='3' fill='%23e11d48'/%3E%3C/svg%3E") 12 12, crosshair !important;
}
`;

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

  // 翻页(useScroll 必须在 EmbedPDF 内, 用独立子组件提供)
  const [currentPage, setCurrentPage] = useState(1);
  const currentPageRef = useRef(1);
  const [scrollToPageFn, setScrollToPageFn] = useState<((p: number) => void) | null>(null);
  // 缩放(官方 zoom 插件, 核心 scale 联动)
  const [zoomProvides, setZoomProvides] = useState<any>(null);
  const [zoomLevel, setZoomLevel] = useState(1);

  const goToPage = (p: number) => {
    const target = Math.max(1, Math.min(p, total || p));
    if (scrollToPageFn) {
      scrollToPageFn(target);
      currentPageRef.current = target;
      setCurrentPage(target);
    }
  };

  const doZoom = (dir: 1 | -1) => {
    const scope = zoomProvides?.forDocument?.(docId) ?? zoomProvides;
    if (!scope?.requestZoomBy) return;
    scope.requestZoomBy(dir * 0.2, { focus: 0 }); // VerticalZoomFocus.Center=0
  };

  const [translate, setTranslate] = useState<{ snippet: string; x: number; y: number } | null>(null);

  // 引擎(动态 import)
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

  // 插件注册(官方完整列表)
  const plugins = useMemo(() => {
    if (!engine) return null;
    return [
      createPluginRegistration(DocumentManagerPluginPackage, {
        initialDocuments: [{ url: source, documentId: docId, name: fileName ?? docId }]
      }),
      createPluginRegistration(ViewportPluginPackage),
      createPluginRegistration(ScrollPluginPackage, { defaultBufferSize: 3 }),
      createPluginRegistration(RenderPluginPackage),
      createPluginRegistration(TilingPluginPackage, { tileSize: 1024 }),
      createPluginRegistration(ZoomPluginPackage, { defaultZoomLevel: 1, minZoom: 0.2, maxZoom: 4 }),
      createPluginRegistration(InteractionManagerPluginPackage),
      createPluginRegistration(SelectionPluginPackage, { marquee: { enabled: false } }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, source]);

  const hostRef = useRef<HTMLDivElement | null>(null);

  // 扫描件 OCR 兜底(单页 OCR: 前端无文本层时触发)
  const ocrCacheRef = useRef<Record<string, string>>({});
  const ocrInFlightRef = useRef<string | null>(null);
  const triggerOcr = async () => {
    try {
      const pathMatch = source.match(/path=([^&]+)/);
      if (!pathMatch) return;
      // ⚠ decodeURIComponent 不转义 "+"(URL 编码的空格), 必须手动替换, 否则路径含 + 文件不存在
      const pdfPath = decodeURIComponent(pathMatch[1].replace(/\+/g, " "));
      const cacheKey = `${pdfPath}#p${currentPageRef.current}`;
      if (ocrCacheRef.current[cacheKey]) {
        setTranslate({ snippet: ocrCacheRef.current[cacheKey].slice(0, 3000), x: window.innerWidth / 2, y: window.innerHeight / 2 });
        return;
      }
      if (ocrInFlightRef.current === cacheKey) return;
      ocrInFlightRef.current = cacheKey;
      try {
        const r = await fetch("/api/p2o/ocr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: pdfPath })
        }).then((x) => x.json());
        if (r?.ok && r.content && r.content.length > 20) {
          ocrCacheRef.current[cacheKey] = r.content;
          setTranslate({ snippet: r.content.slice(0, 3000), x: window.innerWidth / 2, y: window.innerHeight / 2 });
        } else {
          const errMsg = r?.error
            ? (typeof r.error === "string" ? r.error : JSON.stringify(r.error).slice(0, 120))
            : "无内容";
          setTranslate({ snippet: `OCR 失败: ${errMsg}`, x: window.innerWidth / 2, y: window.innerHeight / 2 });
        }
      } finally {
        ocrInFlightRef.current = null;
      }
    } catch (err: any) {
      setTranslate({ snippet: `OCR 异常: ${String(err?.message || err).slice(0, 60)}`, x: window.innerWidth / 2, y: window.innerHeight / 2 });
    }
  };

  /** 页面渲染(每页: RenderLayer 底图 + PagePointerProvider + SelectionLayer 文字选择)
   *   Scroller 布局尺寸已含官方 zoom scale, 这里 RenderLayer/SelectionLayer 同步传 scale
   *   保证渲染清晰度与高亮坐标一致 */
  const renderPage = useCallback(({ pageIndex, width, height }: { pageIndex: number; width: number; height: number }) => {
    return (
      <div data-page-index={pageIndex} className="pdf-page-cursor" style={{ position: "relative", width, height, left: "50%", transform: "translateX(-50%)" }}>
        <RenderLayer documentId={docId} pageIndex={pageIndex} scale={zoomLevel} style={{ position: "absolute", inset: 0 }} />
        <PagePointerProvider documentId={docId} pageIndex={pageIndex} style={{ position: "absolute", inset: 0 }}>
          <SelectionLayer
            documentId={docId}
            pageIndex={pageIndex}
            scale={zoomLevel}
            textStyle={{ background: "rgba(59, 130, 246, 0.25)" }}
          />
        </PagePointerProvider>
      </div>
    );
  }, [docId, zoomLevel]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-muted/20">
      <style>{SELECTION_CURSOR_CSS}</style>
      {/* 工具栏 */}
      <div className="relative z-10 flex items-center gap-2 border-b bg-card/80 px-3 py-1.5">
        <FileText className="h-3.5 w-3.5 text-emerald-600" />
        <span className="truncate text-[11px] font-medium">{fileName || "PDF 阅读"}</span>
        <span className="shrink-0 rounded bg-emerald-100 px-1 py-0.5 text-[9px] font-semibold text-emerald-700">v6.0</span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" disabled={status !== "ready" || total === 0 || currentPage <= 1}
            onClick={() => goToPage(currentPageRef.current - 1)}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"><ChevronLeft className="h-3.5 w-3.5" /></button>
          <span className="min-w-[60px] text-center text-[10px]">
            {status === "ready" ? `${currentPage} / ${total || "?"}` : status === "loading" ? <Loader2 className="mx-auto h-3 w-3 animate-spin" /> : "错误"}
          </span>
          <button type="button" disabled={status !== "ready" || total === 0 || currentPage >= total}
            onClick={() => goToPage(currentPageRef.current + 1)}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"><ChevronRight className="h-3.5 w-3.5" /></button>
          <div className="mx-1 h-4 w-px bg-border" />
          <button type="button" disabled={status !== "ready"}
            onClick={() => doZoom(-1)}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"><ZoomOut className="h-3.5 w-3.5" /></button>
          <span className="min-w-[34px] text-center text-[10px]">
            {zoomLevel ? `${Math.round(zoomLevel * 100)}%` : "100%"}
          </span>
          <button type="button" disabled={status !== "ready"}
            onClick={() => doZoom(1)}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"><ZoomIn className="h-3.5 w-3.5" /></button>
          <a href={source} download={fileName} className="rounded p-1 hover:bg-accent" title="下载 PDF"><Download className="h-3.5 w-3.5" /></a>
        </div>
      </div>

      {/* 渲染区: Viewport 是官方滚动容器(消费 scrollRequests, 翻页滚动请求在这里生效) */}
      <div ref={hostRef} className="relative min-h-0 flex-1 bg-muted/40">
        {status === "loading" && <div className="flex h-40 items-center justify-center text-[11px] text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> PDF 加载中…</div>}
        {status === "error" && <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-[11px] text-red-600">PDF 加载失败: {error}</div>}
        {engine && plugins && (
          <EmbedPDF key={docId} engine={engine} plugins={plugins}>
            <ScrollController
              docId={docId}
              onReady={(scrollToPage, currentPage, totalPages) => {
                setScrollToPageFn(() => scrollToPage);
                setTotal((prev) => (prev === totalPages ? prev : totalPages));
              }}
              onPageChange={(page, totalPages) => {
                // 值比较防无限循环
                currentPageRef.current = page;
                setCurrentPage((prev) => (prev === page ? prev : page));
                setTotal((prev) => (prev === totalPages ? prev : totalPages));
              }}
            />
            <ZoomController
              docId={docId}
              onReady={(provides) => setZoomProvides(() => provides)}
              onLevelChange={(level) => setZoomLevel((prev) => (prev === level ? prev : level))}
            />
            <SelectionWatcher
              docId={docId}
              hostRef={hostRef}
              onSelect={(quote, anchor) => {
                if (quote && quote.length >= 2) {
                  setTranslate({ snippet: quote.slice(0, 3000), x: anchor.x, y: anchor.y });
                } else {
                  setTranslate({ snippet: "⏳ 正在 OCR 识别当前页…", x: anchor.x, y: anchor.y });
                  void triggerOcr();
                }
              }}
              onClear={() => setTranslate(null)}
            />
            <DocumentContent documentId={docId}>
              {({ isLoaded, documentState }) => {
                if (!isLoaded) {
                  return <div className="flex h-40 items-center justify-center text-[11px] text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> 文档加载中…</div>;
                }
                setStatus("ready");
                const pageCount = documentState?.document?.pages?.length;
                if (pageCount && pageCount !== total) setTotal(pageCount);
                return (
                  <Viewport documentId={docId} className="h-full">
                    <Scroller documentId={docId} renderPage={renderPage} data-scroller />
                  </Viewport>
                );
              }}
            </DocumentContent>
          </EmbedPDF>
        )}
      </div>

      {/* AI 卡片(共享组件) */}
      {translate && (
        <ReaderAiCard
          key={`${currentPage}-${translate.snippet.slice(0, 40)}`}
          snippet={translate.snippet}
          anchor={{ x: translate.x, y: translate.y }}
          onClose={() => setTranslate(null)}
        />
      )}
    </div>
  );
}

/** 缩放控制器(必须在 EmbedPDF provider 内调用 useZoom)
 *   ⚠ 补偿 zoom 插件 gate 时序 bug:
 *     zoom 插件 onDocumentLoadingStarted 时 viewport.gate("zoom"),
 *     releaseGate 只在 handleRequest 成功时执行(要求 viewport metrics>0)。
 *     文档加载完成时 Viewport 组件尚未挂载(它渲染在 DocumentContent isLoaded 之后),
 *     handleRequest 因 clientHeight=0 提前 return → gate 永不释放 → Viewport 永远 gated → Scroller 永不渲染。
 *     这里轮询等 viewport metrics 就绪后手动 releaseGate("zoom")。 */
function ZoomController({
  docId,
  onReady,
  onLevelChange
}: {
  docId: string;
  onReady: (provides: any) => void;
  onLevelChange: (level: number) => void;
}) {
  const { provides } = useZoom(docId);
  const { provides: viewportProvides } = useViewportCapability();
  const readyRef = useRef(false);

  useEffect(() => {
    if (!provides) return;
    if (!readyRef.current) {
      readyRef.current = true;
      onReady(provides);
    }
    const unsubs: Array<(() => void) | undefined> = [
      provides.onZoomChange?.((evt: any) => {
        if (typeof evt?.newZoom === "number") onLevelChange(evt.newZoom);
      }),
      provides.onStateChange?.((st: any) => {
        const z = st?.currentZoomLevel ?? st?.zoomLevel;
        if (typeof z === "number") onLevelChange(z);
      })
    ];
    onLevelChange(provides.getState?.()?.currentZoomLevel ?? 1);
    return () => unsubs.forEach((u) => u?.());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provides, docId]);

  // gate 补偿: 等 viewport 有真实尺寸后释放 zoom gate
  // ⚠ 关键: forDocument/getMetrics 在文档未注册时 throw。
  //   setTimeout 链 + catch return 依赖组件重渲染重启 effect — ZoomController 无重渲染源时死锁。
  //   setInterval 每次重新 forDocument, 与渲染完全解耦, 文档注册后自然成功。
  useEffect(() => {
    if (!viewportProvides || !docId) return;
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      try {
        const scope = viewportProvides.forDocument(docId);
        const m = scope.getMetrics();
        if (m && m.clientHeight > 0 && m.clientWidth > 0) {
          if (scope.isGated() && scope.hasGate("zoom")) {
            scope.releaseGate("zoom");
          }
          clearInterval(iv);
          return;
        }
      } catch { /* 文档未注册, 继续轮询 */ }
      if (tries > 160) clearInterval(iv); // 最多 48 秒
    }, 300);
    return () => clearInterval(iv);
  }, [viewportProvides, docId]);

  return null;
}

/** 翻页控制器(必须在 EmbedPDF provider 内调用 useScroll) */
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
    if (!readyRef.current) {
      readyRef.current = true;
      onReady(
        (p: number) => provides.scrollToPage({ pageNumber: p, behavior: "auto" }),
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

/** 文字选择监听(必须在 EmbedPDF provider 内调用 useSelectionCapability)
 *   ⚠ 扫描件 OCR 双保险:
 *   1. onEndSelection 回调: 有选区但文本空(纯图片页) → onSelect("", anchor) 触发顶层 OCR 分支
 *   2. 拖选兜底: 扫描件无文本层时 glyphAt 恒 -1, onEndSelection 根本不触发 →
 *      监听 host 级 pointer 拖拽, 若拖拽结束且 selection 无任何事件 → 按扫描件触发 OCR */
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
        if (!quote || quote.length < 2) {
          // 空文本(扫描件/无文字层): 交顶层走 OCR 兜底
          onSelect("", anchor);
          return;
        }
        onSelect(quote, anchor);
      })();
    });
    const offChange = scope.onSelectionChange((sel) => {
      if (!sel) onClear();
    });
    return () => { offEnd(); offChange(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // 拖选兜底: 扫描件无文本层 → selection 事件永不触发 → 检测 host 级拖拽
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let downPos: { x: number; y: number } | null = null;
    let lastSelectAt = 0;
    const cap = capRef.current;
    const scope = cap ? (cap.forDocument(docId) as any) : null;
    const markSelect = () => { lastSelectAt = Date.now(); };
    const off1 = scope?.onEndSelection?.(markSelect);
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement)?.closest?.(".pdf-page-cursor")) {
        downPos = { x: e.clientX, y: e.clientY };
      }
    };
    const onUp = (e: PointerEvent) => {
      const down = downPos;
      downPos = null;
      if (!down) return;
      const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (dist < 5) return; // 点击不算拖选
      // 等 onEndSelection 异步回调跑完
      setTimeout(() => {
        if (Date.now() - lastSelectAt < 1500) return; // 已有选择事件 → 不是扫描件
        onSelect("", { x: e.clientX, y: e.clientY }); // 无任何选择 → 扫描件 OCR
      }, 600);
    };
    host.addEventListener("pointerdown", onDown, true);
    host.addEventListener("pointerup", onUp, true);
    return () => {
      off1?.();
      host.removeEventListener("pointerdown", onDown, true);
      host.removeEventListener("pointerup", onUp, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, hostRef]);

  return null;
}
