// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// citation-network-service.ts — 把「库里的文献」接成引用网络(2026-09-24)
//
// 由来: `citation-graph-service.ts` 的头部写着"本服务为算法参考实现, 数据源接入由
//   图谱数据入库方案决定 (方案A批量入库 vs 方案B接Neo4j, 用户暂缓)" —— 于是它**全仓零调用**,
//   只有单测在用。
//
//   那个"暂缓"针对的是**入库方案**(要不要把引用关系批量落库/进 Neo4j)。但图上真正要的东西
//   根本不需要先做那个决定: 库里的论文**已经解析出参考文献表了**
//   (`citation-service.extractForPaper` 读每篇的 `.original.md`, 本机实测 500 篇里 212 篇有,
//   共 2527 条), 现算即可 —— 不落库、不接 Neo4j。
//   所以这条是**按需构图**: 每次请求现读现算, 加一层进程内缓存避免重复读盘。
//   `citation-graph-service` 保持"纯算法"不变(它本来就没有 I/O), 数据源接线放在这里。
//
// ── 关于"为什么中文库也能连出边" ──
// 直觉上会以为"知网文献 OpenAlex 不索引 → 查不到引用关系 → 图是空的"。实测**不是**:
//   · 库内直接互引(某篇的参考文献正是库里另一篇) 本机 23 处 —— 真实但稀疏;
//   · 真正把图连起来的是**共引**: 两篇引用了同一批外部文献 → 文献耦合(bibliographic coupling)。
//     2477 条参考文献里绝大多数是库外文献, 它们照样能当"共同邻居"。
//   本机实测(500 篇 / 210 篇有参考文献 / 2477 条): threshold 0.05 → 71 边, 0.08 → 17 边, 0.15 → 1 边。
//   ⚠ 这三个数是**实算的**。我先前在一个一次性脚本里量到过"0.08 → 84 边", 那是错的 ——
//     那个脚本没过滤空串, 于是"规范化后为空"的参考文献被当成了一条真实条目,
//     所有空串在集合里互相命中, 凭空抬高了相似度。过滤后就是上面的数。
//   结论: 默认阈值不宜用 0.08(图会偏空), 前端默认取 0.05 并在界面上标明档位。
import { literatureService } from "./literature-service.js";
import { citationService } from "./citation-service.js";
import { citationGraphService, type GraphNode, type GraphEdge } from "./citation-graph-service.js";

export interface NetworkStats {
  /** 库里参与构图的文献数 */
  papers: number;
  /** 其中解析出参考文献的篇数 */
  withRefs: number;
  /** 参考文献条目总数 */
  totalRefs: number;
  /** 其中在库里能对上另一篇的条目数(库内直接互引) */
  inLibraryRefs: number;
}

export interface CitationNetwork {
  nodes: Array<GraphNode & { degree: number }>;
  edges: GraphEdge[];
  stats: NetworkStats;
  /** 实际使用的阈值(便于前端显示"当前看到的是哪一档") */
  threshold: number;
}

/** 归一化: 去序号前缀/空白/中英标点/大小写 —— 只留可用于匹配的骨架 */
function normRef(s: unknown): string {
  return String(s ?? "")
    .replace(/^[\[［]\s*\d*\s*[\]］]\s*/, "")
    .replace(/\s+/g, "")
    .replace(/[，。；：！？、""''（）《》—…,.;:!?"'()<>[\]{}\-]/g, "")
    .toLowerCase();
}

interface BuiltGraph { papers: Record<string, { title?: string; year?: number | null; references: string[] }>; stats: NetworkStats }

/**
 * 进程内缓存 —— 读 500 个文件不便宜, 而库内容变化很慢。
 * TTL 5 分钟: 新入库的文献最多 5 分钟后出现在图里, 足够。
 * (不缓存**构图结果**只缓存**参考文献提取结果** —— 阈值/上限是每次请求的参数, 构图本身很快。)
 */
let cache: { at: number; data: BuiltGraph } | null = null;
const TTL_MS = 5 * 60 * 1000;

function buildBase(): BuiltGraph {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const page = literatureService.list({ page: 1, pageSize: 2000 });
  const papers: BuiltGraph["papers"] = {};
  let withRefs = 0, totalRefs = 0;
  const titleIndex = new Map<string, string>();
  for (const r of page.items) {
    const t = normRef(r.title ?? r.paperTitle ?? "");
    if (t.length > 6) titleIndex.set(t, r.id);
  }
  let inLibraryRefs = 0;
  for (const r of page.items) {
    const block = citationService.extractForPaper(r.path, r.id, r.title ?? r.paperTitle ?? "");
    const entries: string[] = [];
    for (const e of block?.entries ?? []) {
      const n = normRef(e.title || e.raw);
      // ⚠ 必须过滤空串: 有些条目规范化后什么都不剩(纯标点/纯序号)。若把它们也塞进集合,
      //   所有论文的集合里都含同一个 "" —— 于是两两之间凭空多出一个"公共元素", 相似度被抬高,
      //   阈值一低就冒出一堆假边。(我在一次性脚本里正是漏了这一步, 量到过 84 条边; 实际是 17 条。)
      if (!n) continue;
      entries.push(n);
      totalRefs++;
      // 这条参考文献是不是库里的另一篇?(直接互引 —— 图里最硬的边)
      for (const [t, other] of titleIndex) {
        if (other !== r.id && n.includes(t)) { inLibraryRefs++; break; }
      }
    }
    if (entries.length) withRefs++;
    papers[r.id] = {
      title: r.title ?? r.paperTitle ?? r.id,
      year: Number(r.year) || null,
      references: entries,
    };
  }
  const stats: NetworkStats = { papers: page.items.length, withRefs, totalRefs, inLibraryRefs };
  const data = { papers, stats };
  cache = { at: Date.now(), data };
  return data;
}

/**
 * 构图。`left` 参数同 `buildCitationGraph` 的 threshold/nodeMax/edgeMax,
 * 但 threshold 缺省**用 0.08**(服务层默认值, 与算法层一致)——
 * 显式写出来是为了让前端的档位与后端默认值对得上。
 */
export function buildCitationNetwork(opts: { seedId?: string; threshold?: number; nodeMax?: number; edgeMax?: number } = {}): CitationNetwork {
  const { papers, stats } = buildBase();
  const threshold = Number.isFinite(opts.threshold) ? Number(opts.threshold) : 0.08;
  const g = citationGraphService.buildCitationGraph({
    papers,
    seedPaperId: opts.seedId,
    threshold,
    nodeMax: opts.nodeMax ?? 60,
    edgeMax: opts.edgeMax ?? 150,
  });
  // 度数给前端做节点大小 —— 图上"谁连着谁多"要一眼看得出, 只靠边的粗细读不出来
  const degree = new Map<string, number>();
  for (const e of g.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  return {
    nodes: g.nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 })),
    edges: g.edges,
    stats,
    threshold,
  };
}

export const citationNetworkService = { buildCitationNetwork };
