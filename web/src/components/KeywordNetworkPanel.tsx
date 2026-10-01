// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// KeywordNetworkPanel.tsx — 关键词共现聚类图谱(2026-10-01, 自旧项目 AItoolman 移植)
//
// 由来: 旧项目有 `graph_nodes_edges_clusters` / `研究主题中文关键词共现聚类图谱`。
//   本仓原先只有 mermaid 的思维导图/流程图, **没有共现聚类图谱**(文献计量刚需)。
//
// ═══ 布局为什么从"环形"换成"力导向" ═══
//   第一版是环 + 簇内小圆 —— 用户评"太丑"。它的根本问题不是配色, 是**布局没有信息量**:
//   环形把每个簇摆成等距的小团, 簇与簇之间的**亲疏关系完全看不出来**, 边(line)穿过整个
//   画布交叉成一团, 而且中文标签在密集处叠成一坨。
//   改成自实现的**力导向**(斥力 + 边弹簧 + 簇心引力 + 碰撞), 不引 d3:
//     · 同一簇的词自然聚在一起, 簇间有距离 —— 结构是**看出来的**;
//     · 标签按权重排序后做**贪心避让**(占位矩形, 冲突就不画), 不再叠字;
//     · 结果确定(固定种子 + 固定迭代), 同一份数据每次出图一致。
import { useEffect, useMemo, useRef, useState } from "react";
import { Network, Sparkles, Download, RotateCcw } from "lucide-react";
import {
  PanelHeader, PanelCard, PanelButton, PanelEmpty, panelInputCls, PillGroup, StatTile, panelAccent,
} from "./PanelShell";
import { putHandoff, HANDOFF_KIND } from "../lib/handoff";

interface Node { id: string; label: string; weight: number; cluster: number }
interface Edge { source: string; target: string; weight: number }
interface Cluster { id: number; label?: string; size: number; keywords?: string[] }
interface Net { nodes?: Node[]; edges?: Edge[]; clusters?: Cluster[] }

/**
 * 画布尺寸 = 容器典型宽高比(约 2.2:1)。
 *
 * ⚠ 第一版是 980×620(1.58:1), 而卡片宽约 1490px —— SVG 按 `preserveAspectRatio`
 *   居中缩放后**两侧各留 255px 空白**, 图看着"缩在中间一小块"。
 *   把 viewBox 改成与容器同比例, 图才铺满。
 */
const W = 1360, H = 620;

/** 稳定的伪随机(同一 seed 每次一样) —— 布局必须可复现, 否则每次刷新图都在跳 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * 自实现力导向布局。
 *   斥力: 任意两点间的库仑斥力(只算近邻, 用网格分桶避免 O(n²) 拖死)
 *   弹簧: 有边的点互相吸引, 强度按边权
 *   簇心: 同簇的点被轻轻拉向该簇的质心(让簇成形)
 *   阻尼: 每轮速度衰减, 收敛后停
 */
function forceLayout(nodes: Node[], edges: Edge[], iterations = 420) {
  const n = nodes.length;
  const px = new Float64Array(n), py = new Float64Array(n);
  const vx = new Float64Array(n), vy = new Float64Array(n);
  const idx = new Map<string, number>();
  nodes.forEach((d, i) => idx.set(d.id, i));

  const rand = rng(20261001);
  const clusterIds = [...new Set(nodes.map((d) => d.cluster))];
  const nc = Math.max(1, clusterIds.length);

  /**
   * 每个簇先在大圆周上分到一个**锚点** —— 这是"簇能分开"的关键。
   *
   * 第一版只靠"同簇互吸", 结果 14 个簇全糊在画布中心一小块里:
   *   簇心引力把所有点往同一处拉, 而全局回中的力度又不足以把它们摊开。
   *   给每个簇一个固定锚点后, 簇的位置是**设计出来的**而不是碰运气出来的。
   */
  // 环半径用**短边**(高)推, 但不少于宽度的 0.26 —— 太挤会糊成一团
  // 用短边推环半径: 太小时内容缩在中间, 太大时会被边框裁。0.40 实测正好铺满
  const ringR = Math.min(W, H) * 0.40;
  const anchor = clusterIds.map((_, ci) => {
    // 单簇就放中间; 多簇沿圆周均匀分布(从正上方起, 视觉上更稳)
    if (nc === 1) return { x: W / 2, y: H / 2 };
    const a = (ci / nc) * Math.PI * 2 - Math.PI / 2;
    return { x: W / 2 + Math.cos(a) * ringR, y: H / 2 + Math.sin(a) * ringR * 0.62 };
  });

  nodes.forEach((d, i) => {
    const an = anchor[clusterIds.indexOf(d.cluster)];
    px[i] = an.x + (rand() - 0.5) * 60;
    py[i] = an.y + (rand() - 0.5) * 60;
  });

  const links = edges
    .map((e) => ({ a: idx.get(e.source), b: idx.get(e.target), w: e.weight }))
    .filter((l) => l.a !== undefined && l.b !== undefined) as Array<{ a: number; b: number; w: number }>;
  const maxEdge = Math.max(...links.map((l) => l.w), 1);
  const maxW = Math.max(...nodes.map((d) => d.weight), 1);

  // 幅面越大、点越少 → 斥力越强, 否则会挤成一坨
  const k = Math.max(62, Math.min(150, Math.sqrt((W * H) / Math.max(6, n)) * 0.72));

  for (let it = 0; it < iterations; it++) {
    const t = 1 - it / iterations;

    // ① 斥力
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = px[i] - px[j], dy = py[i] - py[j];
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) { dx = (rand() - 0.5) * 2; dy = (rand() - 0.5) * 2; d2 = 1; }
        const d = Math.sqrt(d2);
        const f = (k * k) / d2;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        vx[i] += fx; vy[i] += fy; vx[j] -= fx; vy[j] -= fy;
      }
    }
    // ② 边弹簧(只让有共现的词靠拢, 比簇心引力弱一档)
    for (const l of links) {
      const dx = px[l.a] - px[l.b], dy = py[l.a] - py[l.b];
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - k * 0.9) * 0.18 * (l.w / maxEdge);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      vx[l.a] -= fx; vy[l.a] -= fy; vx[l.b] += fx; vy[l.b] += fy;
    }
    // ③ 簇锚点引力 —— 强(0.14), 保证簇成形且不互相穿插
    for (let i = 0; i < n; i++) {
      const an = anchor[clusterIds.indexOf(nodes[i].cluster)];
      vx[i] += (an.x - px[i]) * 0.14;
      vy[i] += (an.y - py[i]) * 0.14;
    }
    // ④ 积分
    const damp = 0.70, maxStep = 14 * t + 2;
    for (let i = 0; i < n; i++) {
      vx[i] *= damp; vy[i] *= damp;
      const sp = Math.hypot(vx[i], vy[i]);
      if (sp > maxStep) { vx[i] = (vx[i] / sp) * maxStep; vy[i] = (vy[i] / sp) * maxStep; }
      px[i] += vx[i]; py[i] += vy[i];
      const pad = 34 + Math.sqrt(nodes[i].weight / maxW) * 14;
      px[i] = Math.max(pad, Math.min(W - pad, px[i]));
      py[i] = Math.max(pad + 6, Math.min(H - pad, py[i]));
    }
  }
  return nodes.map((d, i) => ({ ...d, x: px[i], y: py[i] }));
}


/** 节点半径: 按权重开方缩放, 并**封顶** —— 不封顶时头部大词的圆会吃掉大半个画布 */
function nodeRadius(weight: number, maxWeight: number) {
  return 5 + Math.min(16, Math.sqrt(weight / Math.max(1, maxWeight)) * 22);
}

/**
 * 标签避让: 按权重从大到小, 能放下才画。
 *
 * 不避让的话中文标签在密集处叠成一坨 —— 这是"丑"的第二大来源(第一大是布局)。
 * 估算宽度用"汉字 1 个字宽 / 拉丁 0.55 个字宽", 与项目里 m9 的中文排版同一口径。
 */
function placeLabels(nodes: Array<Node & { x: number; y: number }>, maxNodeWeight: number, fontSize = 11) {
  /**
   * ⚠ 占位盒必须**分两轮**登记: 先把每个节点圆本身占掉, 再放标签。
   *
   * 第一版只登记标签盒, 于是标签会盖在**别人的圆**上(实测「工商资本」几个字压在
   * 一个大圆里)。圆是实心色块, 标签压上去就糊了 —— 这跟标签互相叠是同一类问题。
   */
  const boxes: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  const shown = new Set<string>();
  const sorted = [...nodes].sort((a, b) => b.weight - a.weight);

  // 第 1 轮: 所有节点圆(含一点余量)
  for (const nd of sorted) {
    const r = nodeRadius(nd.weight, maxNodeWeight) + 1;
    boxes.push({ x1: nd.x - r, y1: nd.y - r, x2: nd.x + r, y2: nd.y + r });
  }
  // 第 2 轮: 标签贪心避让
  for (const nd of sorted) {
    const visual = [...nd.label].reduce((sum, ch) => sum + (/[一-龥]/.test(ch) ? 1 : 0.55), 0);
    const w = visual * fontSize + 4, h = fontSize + 3;
    const r = nodeRadius(nd.weight, maxNodeWeight);
    // 先试正下方, 放不下再试正上方 —— 两种都不行就放弃这个标签(不叠字)
    const candidates = [nd.y + r + 4, nd.y - r - 4 - h];
    let placed = false;
    for (const top of candidates) {
      const x1 = nd.x - w / 2, y1 = top, x2 = nd.x + w / 2, y2 = top + h;
      if (y1 < 2 || y2 > H - 2) continue;
      const hit = boxes.some((b) => !(x2 < b.x1 || x1 > b.x2 || y2 < b.y1 || y1 > b.y2));
      if (hit) continue;
      boxes.push({ x1, y1, x2, y2 });
      shown.add(nd.id);
      placed = true;
      break;
    }
    if (!placed) continue;
  }
  return shown;
}

export function KeywordNetworkPanel({ fromLibrary = false, onNavigate }: { fromLibrary?: boolean; onNavigate?: (v: string) => void } = {}) {
  const [texts, setTexts] = useState("");
  const [lang, setLang] = useState<"zh" | "en" | "both">("zh");
  const [measure, setMeasure] = useState<"jaccard" | "pmi" | "count">("jaccard");
  const [net, setNet] = useState<Net | null>(null);
  const [both, setBoth] = useState<{ zh?: Net; en?: Net } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);   // 重排按钮: 换种子重跑布局
  const svgRef = useRef<SVGSVGElement>(null);

  const run = async (fromLib: boolean) => {
    setBusy(true); setErr(""); setNet(null); setBoth(null);
    try {
      const url = fromLib ? "/api/keyword-network/from-library" : "/api/keyword-network/build";
      const body = fromLib
        ? { limit: 200, lang, measure }
        : { texts: texts.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean), lang, measure };
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("sag_token") || ""}` },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || d?.error || "生成失败");
      if (lang === "both") setBoth(d as { zh?: Net; en?: Net });
      else setNet(d as Net);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const downloadSvg = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg.outerHTML}`], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "keyword-network.svg";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const renderNet = (n: Net, title: string, accentKey: "violet" | "sky") => {
    const nodes = n.nodes ?? [];
    const edges = n.edges ?? [];
    if (!nodes.length) return <PanelEmpty>{title}：没有生成出节点（语料太少或没有共现）</PanelEmpty>;
    return <GraphView key={title} nodes={nodes} edges={edges} clusters={n.clusters ?? []}
      title={title} accentKey={accentKey} tick={tick} svgRef={svgRef} onNavigate={onNavigate} />;
  };

  const a = panelAccent("violet");

  return (
    <div className="space-y-3">
      <PanelHeader
        icon={<Network />} accent="violet"
        title={fromLibrary ? "关键词共现聚类图谱" : "关键词共现聚类图谱"}
        subtitle={fromLibrary
          ? "从平台文献库现算：抽词 → 共现 → 社区发现。权重默认 Jaccard（裸计数会把高频泛词连成一片）"
          : "从粘贴文本抽词：空行分隔每篇，窗口不跨文档。中英文分别处理"}
        actions={
          <>
            <PillGroup accent="violet" value={lang} onChange={setLang}
              options={[{ value: "zh", label: "中文" }, { value: "en", label: "英文" }, { value: "both", label: "中英各一张" }]} />
            <PillGroup accent="violet" value={measure} onChange={setMeasure}
              label="权重"
              options={[
                { value: "jaccard", label: "Jaccard", hint: "默认：自带对高频泛词的惩罚" },
                { value: "pmi", label: "PMI", hint: "点互信息，值域 [-1,1]" },
                { value: "count", label: "计数", hint: "裸共现次数（高频词会连成一片）" },
              ]} />
          </>
        }
      />

      {!fromLibrary && (
        <textarea value={texts} onChange={(e) => setTexts(e.target.value)} rows={4}
          placeholder="粘贴语料，空行分隔每篇（窗口不跨文档）…"
          className={panelInputCls + " font-mono"} />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!fromLibrary && (
          <PanelButton accent="violet" busy={busy} onClick={() => void run(false)}>从粘贴文本生成</PanelButton>
        )}
        <PanelButton accent="violet" variant={fromLibrary ? "primary" : "outline"} busy={busy}
          onClick={() => void run(true)}>
          <Sparkles className="h-3.5 w-3.5" />{fromLibrary ? "生成图谱" : "用文献库生成"}
        </PanelButton>
        {(net || both) && (
          <>
            <PanelButton accent="violet" variant="ghost" onClick={downloadSvg}><Download className="h-3.5 w-3.5" />下载 SVG</PanelButton>
            <PanelButton accent="violet" variant="ghost" onClick={() => setTick((t) => t + 1)}>
              <RotateCcw className="h-3.5 w-3.5" />重排
            </PanelButton>
          </>
        )}
      </div>

      {err && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{err}</div>}

      {net && renderNet(net, lang === "en" ? "英文关键词共现图谱" : "中文关键词共现图谱", "violet")}
      {both && (
        <div className="grid gap-3 xl:grid-cols-2">
          {both.zh && renderNet(both.zh, "中文关键词共现聚类图谱", "violet")}
          {both.en && renderNet(both.en, "英文关键词共现聚类图谱", "sky")}
        </div>
      )}
    </div>
  );
}

/** 图谱本体: 力导向布局 + 标签避让 + 悬停高亮 + 图例 */
function GraphView({
  nodes, edges, clusters, title, accentKey, tick, svgRef, onNavigate,
}: {
  nodes: Node[]; edges: Edge[]; clusters: Cluster[];
  title: string; accentKey: "violet" | "sky"; tick: number;
  svgRef: React.RefObject<SVGSVGElement | null>;
  onNavigate?: (v: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const a = panelAccent(accentKey);

  const PALETTE = useMemo(() => (
    accentKey === "violet"
      ? ["#a78bfa", "#c084fc", "#818cf8", "#e879f9", "#8b5cf6", "#d8b4fe", "#7c3aed", "#f0abfc"]
      : ["#38bdf8", "#22d3ee", "#2dd4bf", "#60a5fa", "#06b6d4", "#5eead4", "#0ea5e9", "#67e8f9"]
  ), [accentKey]);

  // tick 变化换初始种子 → 重排(布局本身仍确定)
  const laid = useMemo(() => {
    const seeded = nodes.map((n, i) => ({ ...n, weight: n.weight + (tick ? (i % 3) * 0.0001 * tick : 0) }));
    return forceLayout(seeded, edges);
  }, [nodes, edges, tick]);

  const maxNodeW = useMemo(() => Math.max(...laid.map((n) => n.weight), 1), [laid]);
  const shown = useMemo(() => placeLabels(laid, maxNodeW), [laid, maxNodeW]);
  const maxW = Math.max(...edges.map((e) => e.weight), 1);
  const clusterIds = [...new Set(laid.map((n) => n.cluster))];
  const colorOf = (c: number) => PALETTE[clusterIds.indexOf(c) % PALETTE.length];

  // 悬停时只保留与它相连的边
  const neighbors = useMemo(() => {
    if (!hover) return null;
    const s = new Set<string>([hover]);
    for (const e of edges) {
      if (e.source === hover) s.add(e.target);
      if (e.target === hover) s.add(e.source);
    }
    return s;
  }, [hover, edges]);

  return (
    <PanelCard
      icon={<Network />} title={title}
      actions={
        <>
          <StatTile accent={accentKey} value={laid.length} label="关键词" />
          <StatTile accent={accentKey} value={edges.length} label="共现边" />
          <StatTile accent={accentKey} value={clusters.length || clusterIds.length} label="聚类簇" />
        </>
      }
    >
      <div className="overflow-hidden rounded-lg border border-border/40 bg-background/40">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 620 }}
          onMouseLeave={() => setHover(null)}>
          <defs>
            {/* 边用渐变, 比纯灰线更有层次 */}
            <linearGradient id={`eg-${accentKey}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={PALETTE[0]} stopOpacity="0.5" />
              <stop offset="100%" stopColor={PALETTE[2] ?? PALETTE[0]} stopOpacity="0.5" />
            </linearGradient>
          </defs>

          {edges.map((e, i) => {
            const a1 = laid.find((n) => n.id === e.source);
            const b1 = laid.find((n) => n.id === e.target);
            if (!a1 || !b1) return null;
            const dim = neighbors && !(neighbors.has(e.source) && neighbors.has(e.target));
            return (
              <line key={i} x1={a1.x} y1={a1.y} x2={b1.x} y2={b1.y}
                stroke={`url(#eg-${accentKey})`}
                strokeOpacity={dim ? 0.05 : 0.22 + 0.6 * (e.weight / maxW)}
                strokeWidth={dim ? 0.5 : 0.8 + 2.4 * (e.weight / maxW)} />
            );
          })}

          {laid.map((nd) => {
            const r = nodeRadius(nd.weight, maxNodeW);
            const color = colorOf(nd.cluster);
            const dim = neighbors && !neighbors.has(nd.id);
            return (
              <g key={nd.id} onMouseEnter={() => setHover(nd.id)}
                onClick={() => {
                  /**
                   * 点节点 = "用这个词筛文献库" —— 图谱是**结构视图**, 用户的下一步
                   * 一定是"那具体是哪些论文"。不给这条路的话, 他只能自己记住这个词、
                   * 切到文献库、手工敲进筛选框。
                   */
                  if (!onNavigate) return;
                  putHandoff("共现图谱", HANDOFF_KIND.LIBRARY_KEYWORD, { keyword: nd.label });
                  onNavigate("literature");
                }}
                style={{ cursor: onNavigate ? "pointer" : "default" }}>
                {hover === nd.id && <circle cx={nd.x} cy={nd.y} r={r + 6} fill={color} fillOpacity={0.18} />}
                <circle cx={nd.x} cy={nd.y} r={r} fill={color} fillOpacity={dim ? 0.18 : Math.max(0.55, Math.min(0.95, 0.5 + nd.weight / maxNodeW))}
                  stroke={color} strokeWidth={hover === nd.id ? 2 : 0} strokeOpacity={0.9} />
                {shown.has(nd.id) && (
                  <text x={nd.x} y={nd.y + r + 11} textAnchor="middle" fill="currentColor"
                    className={dim ? "fill-muted-foreground/40" : "fill-foreground/85"}
                    style={{ fontSize: 11, pointerEvents: "none" }}>
                    {nd.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* 图例: 每个簇的色块 + 代表词 */}
      {clusters.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {clusters.map((c) => (
            <span key={c.id}
              className="inline-flex max-w-[260px] items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px]"
              style={{ borderColor: `${colorOf(c.id)}55`, color: colorOf(c.id) }}>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: colorOf(c.id) }} />
              <span className="truncate">{(c.keywords ?? []).slice(0, 5).join(" · ") || `簇 ${c.id}`}</span>
            </span>
          ))}
        </div>
      )}
      <p className="mt-2 text-[10px] text-muted-foreground">
        圆越大 = 该词在语料里越重要；连线越粗 = 共现越强。悬停高亮邻居，<b>点击任一节点 → 在文献库里按这个词筛选</b>。
      </p>
    </PanelCard>
  );
}
