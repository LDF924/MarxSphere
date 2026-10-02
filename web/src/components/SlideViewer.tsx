// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// SlideViewer.tsx — pptx 预览(逐页标题/正文/表格)(2026-10-02)
//
// 由来: 改前 pptx 只有后端抽的一坨纯文本("[Slide N] + 段落"), 前端零消费 ——
//   也就是说上传的 PPT 在应用里**根本看不到**。而且那条路还有两个静默错误:
//     · zip 条目顺序是 slide1, slide10, slide2…, 直接遍历会把页序打乱;
//     · 表格、标题层级全都压平成一串行, 分不出结构。
//   现在页序按文件名的数字排, 标题/正文/表格分开给。
//
// ⚠ 这是**大纲式**预览, 不是所见即所得的版式还原: 不做定位、不渲染主题/字体/图片。
//   真还原需要把 OOXML 的坐标系统搬进来(每个形状的 a:off/a:ext 都是 EMU),
//   那是另一个量级的工程 —— 而"我想找第几页说了什么"这个诉求, 大纲式已经够。
import { useEffect, useState } from "react";
import { Loader2, AlertTriangle, FileText } from "lucide-react";
import { cn } from "../lib/utils";

export interface SlidePreview {
  index: number;
  title: string;
  lines: string[];
  tables: string[][][];
  hasNotes?: boolean;
}

export function SlideViewer({ fileId, path: vaultPath, fileName }: {
  fileId?: string;
  path?: string;
  fileName?: string;
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [slides, setSlides] = useState<SlidePreview[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(""); setActive(0);
    const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
    fetch("/api/preview/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(fileId ? { fileId } : { path: vaultPath }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.ok && Array.isArray(d.slides)) { setSlides(d.slides); return; }
        setErr(d?.error || "PPT 读取失败");
      })
      .catch((e) => { if (!cancelled) setErr(String(e?.message || e).slice(0, 120)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fileId, vaultPath]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />读取幻灯片…</div>;
  }
  if (err || !slides.length) {
    return (
      <div className="flex flex-col items-center gap-2 p-6 text-center">
        <AlertTriangle className="h-6 w-6 text-amber-400" />
        <div className="text-sm font-medium">{fileName || "演示文稿"}</div>
        <div className="max-w-md text-xs text-muted-foreground">{err || "这份文件里没有幻灯片"}</div>
      </div>
    );
  }

  const slide = slides[Math.min(active, slides.length - 1)];
  return (
    <div className="flex min-h-0 flex-1 gap-3">
      {/* 左侧页缩略列表 —— 页数多时滚动; 高亮当前页 */}
      <div className="flex w-32 shrink-0 flex-col gap-1 overflow-y-auto pr-1">
        {slides.map((s, i) => (
          <button
            key={s.index}
            type="button"
            onClick={() => setActive(i)}
            className={cn(
              "rounded border px-2 py-1.5 text-left text-[11px] leading-tight",
              i === active ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"
            )}
            title={s.title || `第 ${s.index} 页`}
          >
            <div className="font-medium opacity-70">第 {s.index} 页</div>
            <div className="mt-0.5 line-clamp-2">{s.title || s.lines[0] || "(无文字)"}</div>
          </button>
        ))}
      </div>

      {/* 右侧当前页 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <div className="shrink-0 text-[11px] text-muted-foreground">
          共 {slides.length} 页 · 大纲式预览（不还原版式与图片）{slide.hasNotes ? " · 该页有备注" : ""}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded border border-border p-3">
          {slide.title ? (
            <h3 className="mb-2 border-b border-border/60 pb-1.5 text-base font-semibold">{slide.title}</h3>
          ) : null}
          {slide.lines.length ? (
            <ul className="space-y-1 text-sm">
              {slide.lines.map((l, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
                  <span className="min-w-0 break-words">{l}</span>
                </li>
              ))}
            </ul>
          ) : !slide.title && !slide.tables.length ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><FileText className="h-3.5 w-3.5" />这一页只有图片或图形，没有可提取的文字</div>
          ) : null}

          {slide.tables.map((tbl, ti) => (
            <div key={ti} className="mt-3 overflow-auto rounded border border-border">
              <table className="w-full border-collapse text-xs">
                <tbody>
                  {tbl.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((c, ci) => (
                        <td key={ci} className={cn("border border-border/60 px-2 py-1", ri === 0 && "bg-muted/50 font-medium")}>{c}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default SlideViewer;
