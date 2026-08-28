// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ReaderAiCard.tsx — 划词 AI 阅读卡片(共享组件)
// 从 PdfReader 提取: 拖动定位 + 解释/总结/翻译/追问 + 结果/错误展示
// 供 PdfReader(embedPDF 划词)与 MarkdownReader(原生 Selection 划词)复用
// ⚠ 必须用 createPortal 渲染到 body: 卡片 fixed 定位, 若留在面板内会被祖先
//   .glass{overflow:hidden} + :hover{transform} 裁剪/重定位(鼠标移出页面才可见的经典 bug)
import { useState } from "react";
import { createPortal } from "react-dom";
import { Languages, Loader2, X } from "lucide-react";
import { api } from "../lib/api";

interface ReaderAiCardProps {
  snippet: string;
  /** 初始锚点(视口坐标) */
  anchor: { x: number; y: number };
  onClose: () => void;
}

/** 卡片位置钳制在视口内 */
function clampCardPos(p: { x: number; y: number }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const CARD_H = 340;
  let x = Math.max(8, Math.min(p.x, vw - 360));
  let y = p.y + 12;
  if (y + CARD_H > vh - 8) y = Math.max(8, p.y - CARD_H - 12);
  y = Math.max(8, Math.min(y, vh - CARD_H));
  return { x, y };
}

export function ReaderAiCard({ snippet, anchor, onClose }: ReaderAiCardProps) {
  const [cardPos, setCardPos] = useState<{ x: number; y: number } | null>(clampCardPos(anchor));
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<{ action: string; text: string } | null>(null);
  const [aiError, setAiError] = useState("");
  const [aiQuestion, setAiQuestion] = useState("");

  const doAiAction = async (action: "explain" | "summarize" | "translate" | "ask") => {
    if (aiBusy) return;
    if (action === "ask" && !aiQuestion.trim()) return;
    setAiBusy(action);
    setAiError("");
    try {
      const r = await api.readerAi({
        action,
        snippet,
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

  const close = () => { onClose(); };

  // ⚠ createPortal 到 body: 脱离面板祖先的 overflow/transform 裁剪
  return createPortal(
    <div className="fixed z-50 flex w-[340px] max-w-[90vw] resize flex-col overflow-hidden rounded-lg border bg-card shadow-2xl"
      style={cardPos ? { left: cardPos.x, top: cardPos.y } : { left: Math.min(anchor.x, window.innerWidth - 360), top: Math.min(anchor.y + 12, window.innerHeight - 360) }}>
      <div
        onMouseDown={(e) => {
          if (e.button !== 0 || !cardPos) return;
          e.preventDefault();
          const drag = { dx: e.clientX - cardPos.x, dy: e.clientY - cardPos.y };
          const onMove = (ev: MouseEvent) => {
            setCardPos(clampCardPos({ x: ev.clientX - drag.dx, y: ev.clientY - drag.dy }));
          };
          const onUp = () => {
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
          <Languages className="h-3.5 w-3.5" /> AI 阅读助手（{snippet.length} 字）
        </span>
        <button type="button" onClick={close} className="rounded p-0.5 text-muted-foreground hover:bg-accent">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="px-3">
        <div className="max-h-64 overflow-y-auto rounded bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
          {snippet.slice(0, 3000)}{snippet.length > 3000 ? "…" : ""}
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
          <button type="button" onClick={close}
            className="mt-1.5 w-full text-center text-[10px] text-muted-foreground hover:underline">
            关闭
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}
