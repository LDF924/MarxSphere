// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// DiagramViewer.tsx — drawio 图预览(2026-10-02)
//
// 由来: drawio 此前**全仓零实现**(前端零组件、后端零解析、无依赖)。
//   用户上传的流程图在应用里落进"Office 文档不支持内联预览"这个**错误的**分支 ——
//   .drawio 根本不是 Office 文档, 按提示去用 Word 打开也没用。
//
// ═══ 为什么自己画 SVG 而不是引 mxGraph/drawio viewer ═══
//   官方 viewer 是几千行的渲染引擎(要跑 JS, 还要处理它自己的样式/字体约定)。
//   本仓的 drawio 产出都是**平铺的矩形 + 带箭头的连线**(技能模板出来的), 用
//   <rect> + <line> + 一个箭头 marker 就能表达。引整台引擎换不来这里的任何能力。
//
// ⚠ 只支持绝对坐标的平铺图(嵌套容器的相对坐标不会累加, 见 office-preview-service 的说明)。
//   遇到画不出来的形状会**如实显示成矩形**, 不做语义猜测。
import { useEffect, useMemo, useState } from "react";
import { Loader2, AlertTriangle, Info } from "lucide-react";
import { cn } from "../lib/utils";

export interface DrawioShape {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  isEdge: boolean;
  source?: string;
  target?: string;
  style: string;
}

/** 从 style 串里取一个键 —— drawio 的 style 是 `key=value;key=value` 的分号串 */
function styleVal(style: string, key: string): string {
  const m = new RegExp(`(?:^|;)${key}=([^;]*)`).exec(style);
  return m ? m[1] : "";
}

/** 形状类型 → 视觉。不追求还原 drawio 的完整样式库, 只区分"看得出是几类东西" */
function shapeLooks(style: string): { fill: string; stroke: string; dashed: boolean; rounded: boolean; rhombus: boolean; ellipse: boolean } {
  const fillRaw = styleVal(style, "fillColor");
  const strokeRaw = styleVal(style, "strokeColor");
  // drawio 用 none 表示"不填充" —— 直接当颜色用会变成黑色, 要回退
  const fill = fillRaw && fillRaw !== "none" ? fillRaw : "transparent";
  const stroke = strokeRaw && strokeRaw !== "none" ? strokeRaw : "currentColor";
  return {
    fill, stroke,
    dashed: styleVal(style, "dashed") === "1",
    rounded: /rounded=(1|true)/.test(style),
    // 菱形/椭圆是流程图里最常见的两种"非矩形"
    rhombus: /rhombus/.test(style),
    ellipse: /(^|;)(ellipse|shape=ellipse)/.test(style),
  };
}

export function DiagramViewer({ fileId, path: vaultPath, fileName }: {
  fileId?: string;
  path?: string;
  fileName?: string;
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [shapes, setShapes] = useState<DrawioShape[]>([]);
  const [bounds, setBounds] = useState({ w: 850, h: 1100 });
  const [compressed, setCompressed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr("");
    const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
    fetch("/api/preview/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(fileId ? { fileId } : { path: vaultPath }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.ok && Array.isArray(d.shapes)) {
          setShapes(d.shapes);
          setBounds({ w: d.pageWidth || 850, h: d.pageHeight || 1100 });
          setCompressed(Boolean(d.compressed));
          return;
        }
        setErr(d?.error || "图形读取失败");
      })
      .catch((e) => { if (!cancelled) setErr(String(e?.message || e).slice(0, 120)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fileId, vaultPath]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 真实包围盒 = 所有节点的 min/max(而不是声明的 pageWidth/Height —— 那常常是空白页尺寸) */
  const box = useMemo(() => {
    const nodes = shapes.filter((s) => !s.isEdge);
    if (!nodes.length) return { x: 0, y: 0, w: bounds.w, h: bounds.h };
    const x0 = Math.min(...nodes.map((s) => s.x));
    const y0 = Math.min(...nodes.map((s) => s.y));
    const x1 = Math.max(...nodes.map((s) => s.x + (s.w || 80)));
    const y1 = Math.max(...nodes.map((s) => s.y + (s.h || 40)));
    const pad = 20;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }, [shapes, bounds]);

  if (loading) {
    return <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />读取图形…</div>;
  }
  if (err || !shapes.length) {
    return (
      <div className="flex flex-col items-center gap-2 p-6 text-center">
        <AlertTriangle className="h-6 w-6 text-amber-400" />
        <div className="text-sm font-medium">{fileName || "图形文件"}</div>
        <div className="max-w-md text-xs text-muted-foreground">{err || "没有解析出任何图形"}</div>
      </div>
    );
  }

  const byId = new Map(shapes.map((s) => [s.id, s]));
  const nodes = shapes.filter((s) => !s.isEdge);
  const edges = shapes.filter((s) => s.isEdge);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span>{nodes.length} 个节点 · {edges.length} 条连线</span>
        {compressed ? <span>· 源文件是压缩格式，已解开</span> : null}
        <span className="flex items-center gap-1 text-muted-foreground/70">
          <Info className="h-3 w-3" />按原始布局绘制，不还原 drawio 的完整样式库
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded border border-border bg-background/50 p-2">
        <svg
          viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
          className="h-auto w-full"
          style={{ minHeight: 240 }}
          role="img"
          aria-label={fileName || "drawio 图形"}
        >
          <defs>
            <marker id="sag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {edges.map((e) => {
            // 端点用**节点中心**(drawio 里边连的是形状, 具体接点在哪个边由它自己算) ——
            // 直接连左上角会让箭头穿进矩形里, 看起来像画错了
            const a = e.source ? byId.get(e.source) : undefined;
            const b = e.target ? byId.get(e.target) : undefined;
            if (!a || !b) return null;
            const ax = a.x + (a.w || 80) / 2, ay = a.y + (a.h || 40) / 2;
            const bx = b.x + (b.w || 80) / 2, by = b.y + (b.h || 40) / 2;
            const dashed = styleVal(e.style, "dashed") === "1";
            const color = styleVal(e.style, "strokeColor") || "currentColor";
            return (
              <g key={e.id} className="text-muted-foreground">
                <line x1={ax} y1={ay} x2={bx} y2={by} stroke={color} strokeWidth={1.5}
                  strokeDasharray={dashed ? "5 3" : undefined} markerEnd="url(#sag-arrow)" />
                {e.text ? (
                  <text x={(ax + bx) / 2} y={(ay + by) / 2 - 4} textAnchor="middle" fontSize={11} fill="currentColor">{e.text}</text>
                ) : null}
              </g>
            );
          })}
          {nodes.map((s) => {
            const looks = shapeLooks(s.style);
            const w = s.w || 80;
            const h = s.h || 40;
            const cx = s.x + w / 2;
            const cy = s.y + h / 2;
            // 文字换行: 按形状宽度粗算每行能放几个字(中文按 1 个字宽 ≈ 字号), 超出的截断加省略号
            const perLine = Math.max(4, Math.floor((w - 12) / 12));
            const text = s.text.length > perLine * 3 ? s.text.slice(0, perLine * 3 - 1) + "…" : s.text;
            const wrapped: string[] = [];
            for (let i = 0; i < text.length; i += perLine) wrapped.push(text.slice(i, i + perLine));
            const shapeEl = looks.ellipse ? (
              <ellipse cx={cx} cy={cy} rx={w / 2} ry={h / 2} fill={looks.fill} stroke={looks.stroke} strokeWidth={1.5}
                strokeDasharray={looks.dashed ? "5 3" : undefined} />
            ) : looks.rhombus ? (
              <polygon points={`${cx},${s.y} ${s.x + w},${cy} ${cx},${s.y + h} ${s.x},${cy}`}
                fill={looks.fill} stroke={looks.stroke} strokeWidth={1.5} strokeDasharray={looks.dashed ? "5 3" : undefined} />
            ) : (
              <rect x={s.x} y={s.y} width={w} height={h} rx={looks.rounded ? 8 : 2}
                fill={looks.fill} stroke={looks.stroke} strokeWidth={1.5} strokeDasharray={looks.dashed ? "5 3" : undefined} />
            );
            return (
              <g key={s.id} className="text-foreground">
                {shapeEl}
                {wrapped.map((line, li) => (
                  <text
                    key={li}
                    x={cx}
                    y={cy - ((wrapped.length - 1) * 13) / 2 + li * 13 + 4}
                    textAnchor="middle"
                    fontSize={11}
                    fill="currentColor"
                  >
                    {line}
                  </text>
                ))}
                <title>{s.text || s.id}</title>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

export default DiagramViewer;
