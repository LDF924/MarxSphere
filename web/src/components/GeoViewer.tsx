// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// GeoViewer.tsx — GIS 文件预览: GeoJSON / KML / GPX(2026-10-02)
//
// 由来: leflet / maplibre / openlayers 这些地图库**全仓零依赖**, geojson/kml/gpx/shp
//   也零实现 —— 上传的空间数据落进"Office 文档（Word/Excel/PPT）浏览器不支持内联预览"
//   这个错误分支, 连文件名之外什么信息都拿不到。
//
// ═══ 为什么不上地图库 ═══
//   上 leaflet/maplibre 要引包 + 外部瓦片源(离线环境直接白屏) + 坐标系转换。
//   而"看一眼自己那份数据长什么样"并不需要底图 —— 只需要把几何画出来。
//   所以这里是一个 **SVG 平面渲染**: 经纬度直接投影, 自动缩放贴合视口。
//
// ⚠ 明确不做的事: 不做球面/投影校正(数据范围通常远小于一省, 平面近似看不出来),
//   不画底图, 不做属性表交互(属性用弹层显示文字)。这些要真需要时再引库, 而不是现在假装有。
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, AlertTriangle, Info } from "lucide-react";

/** 归一化后的几何: 统一是环的数组(点是一对坐标, 环是点数组) */
type Ring = Array<[number, number]>;
interface Feature {
  kind: "point" | "line" | "polygon";
  rings: Ring[];
  name: string;
}

// ═══════════════ 三个解析器 ═══════════════

/** GeoJSON: 递归展开所有几何(FeatureCollection / Feature / Geometry 都能吃) */
function parseGeoJson(text: string): { features: Feature[]; error?: string } {
  let root: any;
  try { root = JSON.parse(text); } catch (e) {
    return { features: [], error: `不是合法的 JSON: ${String((e as Error).message).slice(0, 100)}` };
  }
  // TopoJSON 的几何在 arcs 里, 要解码才能用 —— 这里明确说不支持, 而不是画出空图
  if (root?.type === "Topology") {
    return { features: [], error: "这是 TopoJSON（几何压缩在 arcs 里）。请用 mapshaper / ogr2ogr 转成 GeoJSON 后再预览。" };
  }
  const out: Feature[] = [];

  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "FeatureCollection" && Array.isArray(node.features)) { node.features.forEach(walk); return; }
    if (node.type === "Feature") {
      const name = String(node.properties?.name ?? node.properties?.NAME ?? node.properties?.title ?? node.id ?? "");
      const geom = node.geometry;
      if (!geom) return;
      // 同一 Feature 的 MultiXxx 与单几何走同一段展开
      const parts = geom.type.startsWith("Multi") ? geom.coordinates ?? [] : [geom.coordinates];
      if (geom.type.includes("Point")) {
        for (const c of parts) out.push({ kind: "point", rings: [[toXY(c)]].filter(Boolean) as Ring[], name });
      } else if (geom.type.includes("LineString")) {
        for (const c of parts) out.push({ kind: "line", rings: [asRing(c)], name });
      } else if (geom.type.includes("Polygon")) {
        // Polygon 的 coordinates 是 [外环, 洞1, 洞2…] —— 每个环都画, 洞不做挖空(预览够用)
        for (const poly of parts) out.push({ kind: "polygon", rings: (poly ?? []).map(asRing), name });
      }
      return;
    }
    // 直接是 Geometry 的也认
    if (typeof node.type === "string" && node.coordinates) walk({ type: "Feature", geometry: node });
  };

  walk(root);
  if (!out.length) return { features: [], error: "这个 GeoJSON 里没有可绘制的几何(point/line/polygon)" };
  return { features: out };
}

function toXY(c: any): [number, number] {
  return [Number(c?.[0]) || 0, Number(c?.[1]) || 0];
}
function asRing(c: any): Ring {
  return Array.isArray(c) ? c.map(toXY) : [];
}

/** KML: 取 <coordinates> 块。LineString / Point / Polygon 都由它承载 */
function parseKml(text: string): { features: Feature[]; error?: string } {
  const out: Feature[] = [];
  // Placemark 逐个处理, 这样名字能跟几何对上
  for (const pm of text.matchAll(/<Placemark\b[\s\S]*?<\/Placemark>/gi)) {
    const block = pm[0];
    const name = unescapeXml(/<name>([\s\S]*?)<\/name>/i.exec(block)?.[1]?.trim() ?? "");
    const isPoint = /<Point\b/i.test(block);
    const isPolygon = /<Polygon\b/i.test(block);
    const isLine = /<LineString\b/i.test(block);
    // 一个 Placemark 可以有多个几何(MultiGeometry), 所以是 matchAll 不是 exec
    for (const cm of block.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/gi)) {
      const ring = cm[1].trim().split(/\s+/).map((triple) => {
        const p = triple.split(",");
        return [Number(p[0]) || 0, Number(p[1]) || 0] as [number, number];
      });
      if (!ring.length) continue;
      out.push({ kind: isPoint ? "point" : isPolygon ? "polygon" : isLine ? "line" : "line", rings: [ring], name });
    }
  }
  if (!out.length) return { features: [], error: "这个 KML 里没有 <coordinates>（可能是纯样式的图层或网络链接文件）" };
  return { features: out };
}

/** GPX: 轨迹(trk) / 路线(rte) / 航点(wpt) */
function parseGpx(text: string): { features: Feature[]; error?: string } {
  const out: Feature[] = [];
  const pick = (block: string): Ring =>
    [...block.matchAll(/<trkpt\b[^>]*\blat="(-?[\d.]+)"[^>]*\blon="(-?[\d.]+)"/gi)].map((m) => [Number(m[2]), Number(m[1])] as [number, number]);
  const pickRte = (block: string): Ring =>
    [...block.matchAll(/<rtept\b[^>]*\blat="(-?[\d.]+)"[^>]*\blon="(-?[\d.]+)"/gi)].map((m) => [Number(m[2]), Number(m[1])] as [number, number]);

  for (const m of text.matchAll(/<trk\b[\s\S]*?<\/trk>/gi)) {
    const name = unescapeXml(/<name>([\s\S]*?)<\/name>/i.exec(m[0])?.[1]?.trim() ?? "");
    // 一条轨迹可以有多个 trkseg, 每段单独画(段之间不连线 —— 连线会画出不存在的路径)
    for (const seg of m[0].matchAll(/<trkseg>([\s\S]*?)<\/trkseg>/gi)) {
      const ring = pick(seg[1]);
      if (ring.length) out.push({ kind: "line", rings: [ring], name });
    }
  }
  for (const m of text.matchAll(/<rte\b[\s\S]*?<\/rte>/gi)) {
    const name = unescapeXml(/<name>([\s\S]*?)<\/name>/i.exec(m[0])?.[1]?.trim() ?? "");
    const ring = pickRte(m[0]);
    if (ring.length) out.push({ kind: "line", rings: [ring], name });
  }
  for (const m of text.matchAll(/<wpt\b[^>]*\blat="(-?[\d.]+)"[^>]*\blon="(-?[\d.]+)"[^>]*\/?>/gi)) {
    const name = unescapeXml(/<name>([\s\S]*?)<\/name>/i.exec(text.slice(m.index ?? 0, (m.index ?? 0) + 600))?.[1]?.trim() ?? "");
    out.push({ kind: "point", rings: [[[Number(m[2]), Number(m[1])]]], name });
  }
  if (!out.length) return { features: [], error: "这个 GPX 里没有轨迹/路线/航点" };
  return { features: out };
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// ═══════════════ 度量 ═══════════════

/**
 * 距离(米) —— 用 Haversine, 不是平面勾股。
 * 为什么在意: 下面画比例尺要说"这段有多长", 平面勾股在高纬度会差出几十个百分点
 * (在哈尔滨, 1 经度 ≈ 74km 而 1 纬度 ≈ 111km, 差 50%)。
 */
function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function GeoViewer({ text, fileName }: { text: string; fileName?: string }) {
  const [hover, setHover] = useState<string>("");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const parsed = useMemo(() => {
    const head = text.slice(0, 2000).toLowerCase();
    if (head.includes("<kml") || head.includes("<placemark")) return parseKml(text);
    if (head.includes("<gpx")) return parseGpx(text);
    return parseGeoJson(text);
  }, [text]);

  const geo = useMemo(() => {
    const pts: Array<[number, number]> = [];
    for (const f of parsed.features) for (const r of f.rings) for (const p of r) if (Number.isFinite(p[0]) && Number.isFinite(p[1])) pts.push(p);
    if (!pts.length) return null;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    // 单点数据: 给一个固定跨度, 否则 viewBox 宽高为 0 → SVG 什么都画不出
    const dx = x1 - x0 || 0.01;
    const dy = y1 - y0 || 0.01;
    const pad = Math.max(dx, dy) * 0.08;
    return { x0: x0 - pad, y0: y0 - pad, w: dx + pad * 2, h: dy + pad * 2, pts };
  }, [parsed]);

  const scale = useMemo(() => {
    if (!geo) return null;
    // 比例尺长度取整成好看的数(1/2/5 × 10^n 米)
    const targetM = haversine([geo.x0, geo.y0], [geo.x0 + geo.w * 0.25, geo.y0]);
    const pow = 10 ** Math.floor(Math.log10(Math.max(targetM, 1)));
    const nice = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= targetM) ?? pow * 10;
    const deg = nice / Math.max(haversine([geo.x0, geo.y0], [geo.x0 + geo.w, geo.y0]), 1e-9) * geo.w;
    return { meters: nice, deg };
  }, [geo]);

  if (parsed.error) {
    return (
      <div className="flex flex-col items-center gap-2 p-6 text-center">
        <AlertTriangle className="h-6 w-6 text-amber-400" />
        <div className="text-sm font-medium">{fileName || "空间数据"}</div>
        <div className="max-w-md text-xs text-muted-foreground">{parsed.error}</div>
      </div>
    );
  }
  if (!geo) return <div className="p-4 text-sm text-muted-foreground">没有可绘制的坐标</div>;

  const pointCount = parsed.features.reduce((n, f) => n + f.rings.reduce((m, r) => m + r.length, 0), 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span>{parsed.features.length} 个要素 · {pointCount} 个坐标点</span>
        <span className="text-muted-foreground/40">·</span>
        <span>范围 经度 {geo.x0.toFixed(3)} ~ {(geo.x0 + geo.w).toFixed(3)}，纬度 {geo.y0.toFixed(3)} ~ {(geo.y0 + geo.h).toFixed(3)}</span>
        <span className="flex items-center gap-1 text-muted-foreground/70">
          <Info className="h-3 w-3" />无底图的平面示意图（不引地图库，离线可用）
        </span>
      </div>
      <div ref={wrapRef} className="min-h-0 flex-1 overflow-hidden rounded border border-border bg-background/50">
        <svg viewBox={`${geo.x0} ${geo.y0} ${geo.w} ${geo.h}`} className="h-full w-full" style={{ minHeight: 260 }} role="img" aria-label={fileName || "空间数据预览"}>
          {/* 纬度越大 y 越小 —— SVG 的 y 轴向下, 不翻转的话地图是上下颠倒的 */}
          <g transform={`translate(0, ${2 * geo.y0 + geo.h}) scale(1, -1)`}>
            {parsed.features.map((f, fi) => {
              const d = f.rings.map((r) => r.map((p) => `${p[0]},${p[1]}`).join(" ")).join(" ");
              if (f.kind === "polygon") {
                return <polygon key={fi} points={d} fill="hsl(var(--primary) / 0.25)" stroke="hsl(var(--primary))"
                  strokeWidth={geo.w / 400} onMouseEnter={() => setHover(f.name)} />;
              }
              if (f.kind === "line") {
                return <polyline key={fi} points={d} fill="none" stroke="hsl(var(--primary))" strokeWidth={geo.w / 500}
                  onMouseEnter={() => setHover(f.name)} />;
              }
              return (
                <g key={fi} onMouseEnter={() => setHover(f.name)}>
                  {f.rings[0]?.map((p, pi) => (
                    <circle key={pi} cx={p[0]} cy={p[1]} r={geo.w / 220} fill="hsl(var(--primary))" />
                  ))}
                </g>
              );
            })}
          </g>
          {/* 比例尺与指北针画在**未翻转**的坐标系里, 否则文字会镜像 */}
          {scale ? (
            <g>
              <line x1={geo.x0 + geo.w * 0.05} y1={geo.y0 + geo.h * 0.95} x2={geo.x0 + geo.w * 0.05 + scale.deg} y2={geo.y0 + geo.h * 0.95}
                stroke="currentColor" strokeWidth={geo.w / 400} className="text-muted-foreground" />
              <text x={geo.x0 + geo.w * 0.05} y={geo.y0 + geo.h * 0.95 - geo.h / 60} fontSize={geo.h / 40} fill="currentColor" className="text-muted-foreground">
                {scale.meters >= 1000 ? `${(scale.meters / 1000).toFixed(scale.meters % 1000 ? 1 : 0)} km` : `${scale.meters} m`}
              </text>
            </g>
          ) : null}
        </svg>
      </div>
      {hover ? <div className="shrink-0 text-[11px] text-muted-foreground">要素：{hover}</div> : null}
    </div>
  );
}

/** 该扩展名是否归本组件处理(供调用方分派) */
export function isGeoExt(name: string): boolean {
  return /\.(geojson|topojson|kml|gpx)$/i.test(name);
}

export default GeoViewer;
