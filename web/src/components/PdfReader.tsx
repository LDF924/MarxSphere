// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// PdfReader.tsx — embedPDF PDF 阅读器（2026-08-28, Agentero 对照: PDF 深度阅读）
// 基于 @embedpdf/engines（Agentero 同款底层）: WebWorkerEngine + pdfium.wasm
// 能力: 打开 PDF → 渲染页面 → 页码导航 → 缩放 → 文本选择(划词) → 划词翻译 → 整页翻译
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, FileText, Loader2, Download, Languages, X } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";

interface PdfReaderProps {
  /** PDF URL 或 base64 data URL */
  source: string;
  fileName?: string;
}

interface TextBlock {
  content: string;
  rect: { x: number; y: number; width: number; height: number };
}

interface Selection {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 清洗 PDFium 提取的乱码: 保留 CJK/字母/数字/常用标点, 剔除控制码与符号杂码（⭠␛␐等） */
function cleanText(t: string): string {
  const kept = Array.from(t).filter((ch) => {
    const c = ch.charCodeAt(0);
    // 保留: CJK(0x4E00-0x9FFF) / 全角标点(0x3000-0x303F, 0xFF00-0xFFEF) / ASCII 字母数字 / 常用 ASCII 标点
    return (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3000 && c <= 0x303f) ||
      (c >= 0xff00 && c <= 0xffef) ||
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      "，。、；：？！（）《》〈〉“”‘’—…·".includes(ch)
    );
  });
  return kept.join("").replace(/\s+/g, " ").trim();
}

/** 取块内准确文本（PDFium CID 字体中文逐字块带乱码尾码: "坛6⭠␛␐"）
 *  中文块: 取第一个 CJK/中文标点（尾码数字/控制符剔除）
 *  西文块: 块内无 CJK → 取整个清洗后内容（英文单词是完整块, 逐字取会缺漏!） */
function firstReadableChar(t: string): string {
  const chars = Array.from(t);
  const isCJK = (ch: string) => {
    const c = ch.charCodeAt(0);
    return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef);
  };
  // 第一优先: CJK/中文标点 → 取第一个（中文逐字块）
  for (const ch of chars) if (isCJK(ch) || "，。、；：？！（）《》〈〉“”‘’—…·".includes(ch)) return ch;
  // 块内无 CJK = 西文块 → 取整块清洗后内容（保留完整单词）
  const kept = chars.filter((ch) => {
    const c = ch.charCodeAt(0);
    return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ||
           ".,;:!?()[]'\"-–—… ".includes(ch);
  });
  return kept.join("").trim();
}

export function PdfReader({ source, fileName }: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null); // 滚动容器（fit-width 计算）
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [zoom, setZoom] = useState(1.0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const engineRef = useRef<any>(null);
  const docRef = useRef<any>(null);
  const textBlocksRef = useRef<TextBlock[][]>([]); // 每页文本块（页索引 → 块列表）
  const textReadyRef = useRef(false);
  const pageSizeRef = useRef<{ width: number; height: number } | null>(null); // 首页尺寸（磅）, fit-width 基准
  const fitWidthRef = useRef(false); // 当前是否为"适应宽度"模式

  // 划词选择（canvas 上鼠标拖选矩形）
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false); // 同步跟踪（window mouseup 兜底读取）
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const selectionRef = useRef<Selection | null>(null); // 同步跟踪（mouseup 读取, 避免 setState 批处理竞态）
  const [selection, setSelection] = useState<Selection | null>(null);
  const textHitCountRef = useRef(0); // 当前页文本块数（拖选即时反馈用）
  const lastMoveRef = useRef(0); // 最近一次鼠标移动时间（停顿检测用）
  const settleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null); // 停顿结束定时器
  // 划词提示（无文本层/无命中时的引导）
  const [selHint, setSelHint] = useState("");
  // 诊断日志（事件流可视化, 用于定位划词断点）
  const [diagLogs, setDiagLogs] = useState<string[]>([]);
  const diagLog = (msg: string) => {
    setDiagLogs((prev) => [...prev.slice(-5), `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${msg}`]);
  };

  // 划词 AI 卡片（解释/总结/翻译/追问）
  const [translate, setTranslate] = useState<{ snippet: string; x: number; y: number } | null>(null);
  const [aiBusy, setAiBusy] = useState<string | null>(null); // 当前执行的动作
  const [aiResult, setAiResult] = useState<{ action: string; text: string } | null>(null);
  const [aiError, setAiError] = useState("");
  const [aiQuestion, setAiQuestion] = useState("");
  // 卡片可拖动: 位置 state + 拖拽 ref（固定到页面, 不随鼠标消失）
  const [cardPos, setCardPos] = useState<{ x: number; y: number } | null>(null);
  const cardDragRef = useRef<{ dx: number; dy: number } | null>(null); // 按下时鼠标与卡片左上角偏移
  // 整页翻译（划词无命中的扫描件/特殊字体 PDF 兜底）
  const [pageTranslate, setPageTranslate] = useState<{ busy: boolean; original?: string; translated?: string; error?: string }>({ busy: false });
  const pageTextsRef = useRef<string[]>([]); // 每页干净全文（extractText, 页索引 → 文本）
  const pageTextsReadyRef = useRef(false);

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
        // 记录首页尺寸（磅）→ fit-width 初始缩放
        const p0 = doc.pages?.[0];
        if (p0?.size?.width) {
          pageSizeRef.current = { width: p0.size.width, height: p0.size.height };
          const cw = containerRef.current?.clientWidth;
          if (cw && cw > 0) {
            // 留 16px 边距, 最小 50% 最大 200%
            fitWidthRef.current = true;
            const fit = Math.min(2, Math.max(0.5, cw / p0.size.width));
            setZoom(fit);
          }
        }
        setStatus("ready");
        setPage(1);
        // 预取全部文本块（划词翻译用）+ 每页干净全文（整页翻译兜底）— 失败不阻塞阅读
        try {
          const blocks: TextBlock[][] = [];
          const pageTexts: string[] = [];
          for (let i = 0; i < (doc.pages ?? []).length; i++) {
            const p = doc.pages[i];
            const rects = await engine.getPageTextRects(doc, p).toPromise();
            blocks.push(
              (rects ?? []).map((r: any) => {
                // embedPDF rect 结构: { origin: {x,y}, size: {width,height} }
                const rc = r.rect ?? {};
                return {
                  content: r.content ?? "",
                  rect: {
                    x: rc.origin?.x ?? 0,
                    y: rc.origin?.y ?? 0,
                    width: rc.size?.width ?? 0,
                    height: rc.size?.height ?? 0
                  }
                };
              })
            );
            // extractText 对 CID 字体/部分扫描 PDF 提取质量更高（无坐标但全文干净）
            try {
              const txt = await engine.extractText(doc, [i]).toPromise();
              pageTexts.push(cleanText(txt || ""));
            } catch { pageTexts.push(""); }
          }
          textBlocksRef.current = blocks;
          textReadyRef.current = true;
          pageTextsRef.current = pageTexts;
          pageTextsReadyRef.current = true;
        } catch { /* 划词不可用时仅保留阅读能力 */ }
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
        const blob = await engineRef.current.renderPage(docRef.current, pageObj, { scaleFactor: zoom }).toPromise();
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

  // 画布相对坐标 → PDF 文本块坐标系（页面像素 / 渲染缩放）
  const toPdfCoord = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    // clamp 到画布内: 鼠标拖出边界时仍按边界值计算（不触发 leave 取消）
    const rx = Math.min(rect.right, Math.max(rect.left, clientX));
    const ry = Math.min(rect.bottom, Math.max(rect.top, clientY));
    const x = ((rx - rect.left) / rect.width) * canvas.width;
    const y = ((ry - rect.top) / rect.height) * canvas.height;
    return { x, y };
  }, []);

  // === 划词: mousedown 在 canvas 开始, 拖选期间挂 window 全局监听 ===
  // 事件挂 document/window(而非 canvas): 三入口(文献库/资料库/政策库)容器结构
  // 不同, canvas 级绑定在部分容器不可靠; window 事件浏览器规范保证触发
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || status !== "ready") return;

    // 命中检测: 鼠标按下时是否在 canvas 内
    const isOnCanvas = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return e.clientX >= rect.left && e.clientX <= rect.right &&
             e.clientY >= rect.top && e.clientY <= rect.bottom;
    };

    const onWinMove = (e: MouseEvent) => {
      if (!draggingRef.current || !dragStartRef.current) return;
      const p = toPdfCoord(e.clientX, e.clientY);
      if (!p) return;
      lastMoveRef.current = Date.now(); // 拖动继续, 重置停顿计时
      if (!selectionRef.current) diagLog(`②mousemove 选区开始 (${Math.round(e.clientX)},${Math.round(e.clientY)})`);
      const sel = {
        x: Math.min(dragStartRef.current.x, p.x),
        y: Math.min(dragStartRef.current.y, p.y),
        width: Math.abs(p.x - dragStartRef.current.x),
        height: Math.abs(p.y - dragStartRef.current.y)
      };
      selectionRef.current = sel;
      setSelection(sel);
    };

    // 任意结束信号(松开/移出窗口/失焦/取消) → 结束选择
    const onWinUp = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      diagLog("③mouseup 触发");
      // 选区未更新(mousemove 没到) 或 仍是 1px 占位 → 用鼠标当前位置重建
      const cur = selectionRef.current;
      if ((!cur || cur.width < 3 || cur.height < 3) && dragStartRef.current) {
        const p = toPdfCoord(e.clientX, e.clientY);
        if (p) {
          const s = dragStartRef.current;
          selectionRef.current = {
            x: Math.min(s.x, p.x),
            y: Math.min(s.y, p.y),
            width: Math.abs(p.x - s.x),
            height: Math.abs(p.y - s.y)
          };
        }
      }
      finishSelection(e.clientX, e.clientY);
    };

    // 鼠标移出窗口/文档 → 立即结束选择（blur/pointercancel 事件类型不同, 用宽松签名）
    const onLeave = (_e?: Event) => {
      if (!draggingRef.current) return;
      diagLog("④mouseleave/blur 触发");
      const cur = selectionRef.current;
      if (!cur || cur.width < 3 || cur.height < 3) {
        // 1px 占位或未更新 → 用起点扩展一个合理选区(覆盖起点附近文本)
        const s = dragStartRef.current;
        if (s) selectionRef.current = { x: s.x - 2, y: s.y - 2, width: 4, height: 4 };
      }
      const last = selectionRef.current;
      if (last) finishSelection(last.x, last.y);
      else { draggingRef.current = false; setDragging(false); dragStartRef.current = null; }
    };

    // click 兜底: 浏览器保证任何真实点击都会触发 click(mouseup 之后)
    // 资料库/政策库容器 mouseup 可能丢失, click 是最后保险
    const onWinClick = () => {
      if (!draggingRef.current) return;
      const last = selectionRef.current;
      if (last) finishSelection(last.x, last.y);
      else { draggingRef.current = false; setDragging(false); dragStartRef.current = null; }
    };

    // document 级 mousedown: 命中 canvas 才启动划词（三入口统一）
    const onDocDown = (e: MouseEvent) => {
      if (e.button !== 0 || !isOnCanvas(e)) return;
      const p = toPdfCoord(e.clientX, e.clientY);
      if (!p) return;
      diagLog(`①mousedown 命中 canvas (${Math.round(e.clientX)},${Math.round(e.clientY)})`);
      dragStartRef.current = p;
      draggingRef.current = true;
      setDragging(true);
      setSelection(null);
      setSelHint("");
      // 关键: mousedown 立即建立最小选区(起点矩形), 即使后续 mousemove
      // 一个都不触发(环境限制), mouseup/停顿也有有效选区可用
      selectionRef.current = { x: p.x, y: p.y, width: 1, height: 1 };
      const blocks = textBlocksRef.current[page - 1] ?? [];
      textHitCountRef.current = blocks.length;
      // 拖选期间挂 window/document 全部结束事件(结束后移除)
      window.addEventListener("mousemove", onWinMove);
      window.addEventListener("mouseup", onWinUp);
      window.addEventListener("pointerup", onWinUp);
      window.addEventListener("click", onWinClick);
      document.addEventListener("mouseleave", onLeave);
      window.addEventListener("blur", onLeave);
      window.addEventListener("pointercancel", onLeave);
      // 终极保险: 拖选停顿 600ms(选区存在且鼠标未移动) = 已完成选择意图
      // 不依赖任何 mouseup/click 事件送达, 纯定时器触发
      lastMoveRef.current = Date.now();
      if (settleTimerRef.current) clearInterval(settleTimerRef.current);
      settleTimerRef.current = setInterval(() => {
        if (!draggingRef.current) { clearInterval(settleTimerRef.current!); settleTimerRef.current = null; return; }
        if (Date.now() - lastMoveRef.current > 600 && selectionRef.current) {
          clearInterval(settleTimerRef.current!);
          settleTimerRef.current = null;
          diagLog("⑤停顿600ms 定时器触发");
          const last = selectionRef.current;
          // 选区仍是 1px 占位(mousemove 全丢失) → 扩展成覆盖起点整行区域
          if (last && last.width < 3 && last.height < 3 && dragStartRef.current) {
            const s = dragStartRef.current;
            selectionRef.current = { x: 0, y: s.y - 20, width: 10000, height: 40 };
            finishSelection(s.x, s.y);
          } else if (last) {
            finishSelection(last.x + last.width, last.y + last.height);
          } else {
            draggingRef.current = false; setDragging(false); dragStartRef.current = null;
          }
        }
      }, 150);
    };

    const onDbl = (e: MouseEvent) => {
      if (!isOnCanvas(e)) return;
      const p = toPdfCoord(e.clientX, e.clientY);
      if (!p) return;
      const blocks = textBlocksRef.current[page - 1] ?? [];
      const lineY = blocks.find((b) => p.y >= b.rect.y && p.y <= b.rect.y + b.rect.height)?.rect.y;
      if (lineY === undefined) { setSelHint("该处无文本层，无法双击选段。"); setTimeout(() => setSelHint(""), 3000); return; }
      const hit = blocks
        .filter((b) => Math.abs(b.rect.y - lineY) < b.rect.height * 0.6)
        .sort((a, b) => a.rect.x - b.rect.x)
        .map((b) => cleanText(b.content))
        .filter((t) => t.length > 0);
      if (hit.length === 0) return;
      setTranslate({ snippet: hit.join(" ").slice(0, 3000), x: e.clientX, y: e.clientY });
      setCardPos(clampCardPos({ x: e.clientX + 12, y: e.clientY + 12 }));
      setAiResult(null);
      setAiError("");
      setAiQuestion("");
    };

    const detach = () => {
      window.removeEventListener("mousemove", onWinMove);
      window.removeEventListener("mouseup", onWinUp);
      window.removeEventListener("pointerup", onWinUp);
      window.removeEventListener("click", onWinClick);
      document.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("pointercancel", onLeave);
      if (settleTimerRef.current) { clearInterval(settleTimerRef.current); settleTimerRef.current = null; }
    };

    // document 级委托: 所有入口统一命中
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("dblclick", onDbl);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("dblclick", onDbl);
      detach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, page, zoom, toPdfCoord]);

  /** 结束选择: 取选区内文本块 → 拼 snippet → 弹 AI 卡片 */
  const finishSelection = async (clientX: number, clientY: number) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    dragStartRef.current = null;
    // 取选区内文本块 → 拼出 snippet（用 ref 同步值, 不受 setState 批处理影响）
    const sel = selectionRef.current;
    selectionRef.current = null;
    if (!sel) { setSelection(null); return; } // 1px 占位也会被扩展, 不拦截
    // 选区是 canvas 渲染像素（已含 scaleFactor 缩放）; 文本块 rect 是 PDF 空间（磅, 未缩放）
    // → 把选区换算回 PDF 空间: / zoom
    let selPdf = { x: sel.x / zoom, y: sel.y / zoom, width: sel.width / zoom, height: sel.height / zoom };
    // 关键: 选区过细(用户只点/轻划, 或 mousemove 丢失) → 按 y 范围扩展选区
    // 最小扩展 40 磅高(覆盖至少一行): 细选区也能命中文本行
    if (selPdf.height < 40) {
      selPdf = { ...selPdf, y: selPdf.y - 10, height: 40 };
    }
    if (selPdf.width < 20) {
      selPdf = { ...selPdf, x: 0, width: 100000 };
    }
    // 关键: 若当前页数据未预取(大 PDF 预取慢, 用户划词时可能还没好)
    // → 同步按需提取当前页文本块, 不依赖预取状态
    let blocks = textBlocksRef.current[page - 1] ?? [];
    if (blocks.length === 0) {
      diagLog("预取未完成 → 按需提取当前页文本块");
      try {
        const pageObj = docRef.current?.pages?.[page - 1];
        if (pageObj && engineRef.current) {
          const rects = await engineRef.current.getPageTextRects(docRef.current, pageObj).toPromise();
          blocks = (rects ?? []).map((r: any) => {
            const rc = r.rect ?? {};
            return {
              content: r.content ?? "",
              rect: {
                x: rc.origin?.x ?? 0,
                y: rc.origin?.y ?? 0,
                width: rc.size?.width ?? 0,
                height: rc.size?.height ?? 0
              }
            };
          });
          textBlocksRef.current[page - 1] = blocks;
          diagLog(`按需提取完成: ${blocks.length}块`);
        }
      } catch { /* 提取失败走空兜底 */ }
    }
    // 选区内的块
    const inSel = blocks
      .filter((b) => {
        const r = b.rect;
        return r.x < selPdf.x + selPdf.width && r.x + r.width > selPdf.x &&
               r.y < selPdf.y + selPdf.height && r.y + r.height > selPdf.y;
      })
      .map((b) => ({ ...b, char: firstReadableChar(b.content) }))
      .filter((b) => b.char.length > 0);
    // OCR 行聚合: 按 y 容差(10磅)聚合成行, 行内按 x 排序, 行间按 y 排序
    // 解决: 标题区字基线抖动导致按 y 严格排序乱序("法"跑到"年"前)
    const LINES_TOL = 10;
    const lines: Array<Array<{ x: number; char: string; yAnchor: number }>> = [];
    for (const b of [...inSel].sort((a, b) => a.rect.y - b.rect.y)) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(b.rect.y - last[0].yAnchor) <= LINES_TOL) {
        last.push({ x: b.rect.x, char: b.char, yAnchor: last[0].yAnchor });
      } else {
        lines.push([{ x: b.rect.x, char: b.char, yAnchor: b.rect.y }]);
      }
    }
    const snippet = lines
      .sort((a, b) => a[0].yAnchor - b[0].yAnchor)
      .map((l) => l.sort((a, b) => a.x - b.x).map((c) => c.char).join(""))
      .join("\n")
      .slice(0, 3000);
    if (snippet.length < 5) {
      setSelection(null);
      // 无文本层 → 引导提示（纯扫描图片 PDF）+ 触发 MinerU OCR 兜底
      setSelHint(textHitCountRef.current === 0
        ? "本页无文本层（扫描件/图片），正在尝试 OCR 识别…"
        : "划选区域未命中文字，请对准文字行拖选；或点「翻译本页」翻译整页。");
      setTimeout(() => setSelHint(""), 4000);
      // 触发 OCR: 仅当 blocks 确实为空(扫描件), 且 source 是文件 URL
      if (textHitCountRef.current === 0 && source.startsWith("/api/")) {
        void (async () => {
          try {
            const pathMatch = source.match(/path=([^&]+)/);
            if (!pathMatch) return;
            const pdfPath = decodeURIComponent(pathMatch[1]);
            const r = await fetch("/api/p2o/ocr", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: pdfPath })
            }).then((x) => x.json());
            if (r?.ok && r.content && r.content.length > 20) {
              diagLog(`⑦OCR成功 (${r.content.length}字)`);
              setTranslate({ snippet: r.content.slice(0, 3000), x: clientX, y: clientY });
              setCardPos(clampCardPos({ x: clientX + 12, y: clientY + 12 }));
              setAiResult(null);
              setAiError("");
              setAiQuestion("");
            } else {
              diagLog(`⑦OCR失败: ${r?.error || "无内容"}`);
            }
          } catch (err: any) {
            diagLog(`⑦OCR异常: ${String(err?.message || err).slice(0, 60)}`);
          }
        })();
      }
      return;
    }
    setTranslate({ snippet, x: clientX, y: clientY });
    diagLog(`⑥卡片弹出 (${snippet.length}字, ${lines.length}行)`);
    // 卡片初始位置: 锚点在鼠标附近, 但固定(不再随鼠标移动消失)
    setCardPos(clampCardPos({ x: clientX + 12, y: clientY + 12 }));
    setAiResult(null);
    setAiError("");
    setAiQuestion("");
  };

  /** 卡片位置钳制在视口内（上方优先: 鼠标下方放不下则翻到上方, Agentero 同款） */
  const clampCardPos = (p: { x: number; y: number }) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const CARD_H = 340; // 卡片预估高度
    let x = Math.max(8, Math.min(p.x, vw - 360));
    let y = p.y + 12;
    // 下方空间不足 → 翻到鼠标上方
    if (y + CARD_H > vh - 8) y = Math.max(8, p.y - CARD_H - 12);
    // 最终保险: 任何输入都不超出视口
    y = Math.max(8, Math.min(y, vh - CARD_H));
    return { x, y };
  };

  /** 卡片拖拽: 标题栏按下记录偏移, 移动时更新位置 */
  const onCardDragStart = (e: React.MouseEvent) => {
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
  };

  /** 整页翻译（扫描件/特殊字体 PDF 划词无命中的兜底: extractText 全文翻译） */
  const doPageTranslate = async () => {
    if (pageTranslate.busy) return;
    setPageTranslate({ busy: true });
    try {
      const full = pageTextsRef.current[page - 1] ?? "";
      if (!full || full.length < 10) { setPageTranslate({ busy: false, error: "本页无可用文本层（可能为纯扫描图片）" }); return; }
      const r = await api.translateSnippet({ snippet: full.slice(0, 3000) });
      if (r?.ok) setPageTranslate({ busy: false, original: full.slice(0, 3000), translated: r.translated });
      else setPageTranslate({ busy: false, error: r?.error || "翻译失败" });
    } catch (err: any) {
      setPageTranslate({ busy: false, error: String(err?.message || err).slice(0, 120) });
    }
  };

  /** 划词 AI 动作（解释/总结/翻译/追问） */
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

  /** 适应宽度: 按滚动容器宽度计算缩放（宽留 16px 边距, 50%–200% 限制） */
  const fitToWidth = useCallback(() => {
    const ps = pageSizeRef.current;
    const cw = containerRef.current?.clientWidth;
    if (!ps || !cw || cw <= 0) return;
    fitWidthRef.current = true;
    const fit = Math.min(2, Math.max(0.5, (cw - 16) / ps.width));
    setZoom(fit);
  }, []);

  // 容器尺寸变化（侧栏拖宽/窗口缩放）→ 适宽模式下重新适配
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      if (fitWidthRef.current && status === "ready") fitToWidth();
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [status, fitToWidth]);

  // 手动缩放（+/-/适宽按钮）退出适宽模式
  const manualZoom = (next: number) => { fitWidthRef.current = false; setZoom(next); };

  return (
    // 根 h-full + 渲染区 absolute: 高度由父链约束(h-full), 内部滚动
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-muted/20">
      {/* 工具栏: 页码/缩放/下载 */}
      <div className="relative z-10 flex items-center gap-2 border-b bg-card/80 px-3 py-1.5">
        <FileText className="h-3.5 w-3.5 text-emerald-600" />
        <span className="truncate text-[11px] font-medium">{fileName || "PDF 阅读"}</span>
        <span className="shrink-0 rounded bg-emerald-100 px-1 py-0.5 text-[9px] font-semibold text-emerald-700" title="PdfReader 版本(用于确认加载的是最新代码)">v4.2</span>
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
          <button type="button" disabled={status !== "ready"} onClick={() => manualZoom(Math.max(0.5, +(zoom - 0.25).toFixed(2)))}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"><ZoomOut className="h-3.5 w-3.5" /></button>
          <span className="min-w-[34px] text-center text-[10px]">{Math.round(zoom * 100)}%</span>
          <button type="button" disabled={status !== "ready"} onClick={() => manualZoom(Math.min(3, +(zoom + 0.25).toFixed(2)))}
            className="rounded p-1 hover:bg-accent disabled:opacity-30"><ZoomIn className="h-3.5 w-3.5" /></button>
          <button type="button"
            disabled={status !== "ready" || !pageSizeRef.current}
            onClick={fitToWidth}
            className={cn("rounded border px-2 py-0.5 text-[10px] transition-colors",
              fitWidthRef.current ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-border text-muted-foreground hover:bg-accent")}
            title="适应宽度（按容器宽度自动缩放）"
          >
            适宽
          </button>
          <div className="mx-1 h-4 w-px bg-border" />
          <button type="button"
            disabled={status !== "ready" || pageTranslate.busy}
            onClick={() => void doPageTranslate()}
            className="flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700 transition-colors hover:bg-blue-100 disabled:opacity-50"
            title="翻译当前整页（扫描件/特殊字体 PDF 划词无命中时的兜底）"
          >
            {pageTranslate.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Languages className="h-3 w-3" />}
            翻译本页
          </button>
          <a href={source} download={fileName} className="rounded p-1 hover:bg-accent" title="下载 PDF"><Download className="h-3.5 w-3.5" /></a>
        </div>
      </div>
      {/* 渲染区: 划词选择（absolute: 填满根容器剩余空间, 内部滚动） */}
      <div ref={containerRef} className="absolute inset-x-0 bottom-0 top-[41px] overflow-auto bg-muted/40 p-3">
        {status === "loading" && <div className="flex h-40 items-center justify-center text-[11px] text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> PDF 加载中…</div>}
        {status === "error" && <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-[11px] text-red-600">PDF 加载失败: {error}</div>}
        {status === "ready" && (
          <div className="relative inline-block">
            {/* 划词引导提示 */}
            {selHint && (
              <div className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">
                {selHint}
              </div>
            )}
            {/* 诊断日志条（划词事件流） */}
            {diagLogs.length > 0 && (
              <div className="mb-2 max-w-md rounded-md border border-dashed border-slate-300 bg-slate-50 px-2 py-1 text-[10px] leading-relaxed text-slate-600">
                {diagLogs.map((l, i) => <div key={i}>{l}</div>)}
                <button type="button" onClick={() => setDiagLogs([])} className="mt-0.5 text-[9px] text-slate-400 hover:underline">清空诊断</button>
              </div>
            )}
            {/* 不设 maxWidth: canvas 按渲染像素显示, 放大后由容器滚动 */}
            {/* 划词事件用原生监听(useEffect 绑定): 不经过 React 合成事件, pointer capture 可靠 */}
            <canvas
              ref={canvasRef}
              className="block cursor-crosshair touch-none rounded-sm bg-white shadow-md"
            />
            {/* 选区高亮 */}
            {selection && (
              <div className="pointer-events-none absolute border border-blue-500/70 bg-blue-400/25"
                style={{
                  left: `${(selection.x / (canvasRef.current?.width ?? 1)) * 100}%`,
                  top: `${(selection.y / (canvasRef.current?.height ?? 1)) * 100}%`,
                  width: `${(selection.width / (canvasRef.current?.width ?? 1)) * 100}%`,
                  height: `${(selection.height / (canvasRef.current?.height ?? 1)) * 100}%`
                }} />
            )}
          </div>
        )}
        {/* 划词 AI 卡片（fixed: 固定位置不随鼠标消失; 标题栏可拖动; 右下角可拉伸） */}
        {translate && status === "ready" && (
          <div className="fixed z-50 flex w-[340px] max-w-[90vw] resize flex-col overflow-hidden rounded-lg border bg-card shadow-2xl"
            style={cardPos ? { left: cardPos.x, top: cardPos.y } : { left: Math.min(translate.x, window.innerWidth - 360), top: Math.min(translate.y + 12, window.innerHeight - 360) }}>
            {/* 可拖动标题栏 */}
            <div
              onMouseDown={onCardDragStart}
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
              {translate.snippet.slice(0, 400)}{translate.snippet.length > 400 ? "…" : ""}
            </div>
            {/* 动作按钮: 解释 / 总结 / 翻译 */}
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
            {/* 追问输入 */}
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
            {/* AI 结果 */}
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
        {/* 整页翻译结果（扫描件兜底, canvas 下方并排对照） */}
        {(pageTranslate.busy || pageTranslate.translated || pageTranslate.error) && status === "ready" && (
          <div className="mt-3 space-y-2 rounded-lg border border-blue-200 bg-card/90 p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-[11px] font-semibold text-blue-600">
                <Languages className="h-3.5 w-3.5" /> 整页翻译（第 {page} 页）
              </span>
              <button type="button" onClick={() => setPageTranslate({ busy: false })} className="rounded p-0.5 text-muted-foreground hover:bg-accent">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {pageTranslate.busy && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 翻译中…（长文可能需数十秒）
              </div>
            )}
            {pageTranslate.original && (
              <div className="max-h-32 overflow-y-auto rounded bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
                {pageTranslate.original}
              </div>
            )}
            {pageTranslate.translated && (
              <div className="max-h-48 overflow-y-auto rounded border border-blue-500/20 bg-blue-500/10 p-2 text-[11px] leading-relaxed text-blue-900">
                {pageTranslate.translated}
              </div>
            )}
            {pageTranslate.error && (
              <div className="rounded border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-600">{pageTranslate.error}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
