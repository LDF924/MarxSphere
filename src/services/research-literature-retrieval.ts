// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// research-literature-retrieval.ts — V417: 写作舱文献检索接真源
//
// 由来（2026-09-14 实测"研途写作舱"）：
//   原 runLiteratureSearch 只让 LLM 编检索词就写素材，内容是"检索词列表 + (实际检索需接知识库/CNKI)"
//   —— 从没碰过任何库。而下游的 buildCitationPool / buildMergedReferences 靠正则
//   `^\s*\[(\d+)\]\s*(.+)$` 从素材里抠条目 —— 于是参考文献恒为空，
//   正文里 25 处 `[N]（待补引文）` 谁也不认。
//
// 本模块把"检索词"变成"真实条目"，来源按优先级：
//   1. pg     — PG 向量库 (source_chunks/documents)，按项目绑定的 source_ids 检索
//   2. mdlibrary — 本地 md 文献库 (literature-service)，唯一带 authors/year 著录的源
//   3. graphiti / cognee — Neo4j 图谱臂，按需经 MCP 池
//
// 诚实原则：搜不到就是搜不到 —— 条目为空时返回空数组，由调用方在导出里标注"需人工补录"，
// 绝不用 LLM 编造文献（那是学术不端）。

import { pool } from "../db/pool.js";

export type RetrievalSourceName = "pg" | "graphiti" | "cognee" | "mdlibrary" | "openalex";

/** 检索命中（各源归一化）。著录字段缺失就是缺失，不做假。 */
export interface LiteratureHit {
  title: string;
  /** 有则填，无则空串 —— 导出时按"著录不全"标注 */
  authors: string;
  year: string;
  /** 正文片段/摘要，用于让模型判断该引什么 */
  excerpt: string;
  source: RetrievalSourceName;
  /** 原始定位（sourceId/documentId 等），便于回溯 */
  ref?: string;
  /** DOI(不带 https://doi.org/ 前缀) —— 外部源才有, 用于回链与著录 */
  doi?: string;
  /** 期刊/出版物名 —— 外部源才有, GB/T 7714 著录需要 */
  venue?: string;
  /** 卷(期): 页码 —— 外部源才有 */
  volumeIssue?: string;
}

/** 默认公共库（与 server.ts DEFAULT_SOURCE 一致：本机"资本下乡"库） */
const DEFAULT_SOURCE = "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";

/**
 * 内部臂至少要占到 topK 的这个比例, 否则补外部源。
 * 0.7 的含义: topK=6 时内部少于 5 条才去找 OpenAlex, 外部最多补 2 条。
 * 定这个值是因为内部库是**本项目自有语料**(用户绑定的源), 相关性高于开放聚合;
 * 但库里覆盖不足时不能让参考文献跟着缩水。
 */
const INTERNAL_SHARE = 0.7;

/**
 * PG 标题里常带作者，形如 `“合伙人”制度：资本下乡的路径创新及其实践绩效_李玉霞`。
 * 这是本平台入库时的命名约定（实测 504 篇均为此格式），不是我们造的 —— 拆出来当著录用。
 */
export function splitTitleAuthor(rawTitle: string): { title: string; authors: string } {
  const t = String(rawTitle ?? "").trim();
  const m = /^(.+?)[_—\-]{1,2}([一-龥·、A-Za-z.\s]{2,40})$/.exec(t);
  if (!m) return { title: t, authors: "" };
  const [, title, authors] = m;
  // 右侧必须像个姓名列表（中文名/顿号分隔/西文），否则不拆 —— 避免把"资本下乡_2023"当作者
  if (!/[一-龥A-Za-z]/.test(authors) || /\d{3,}/.test(authors)) return { title: t, authors: "" };
  return { title: title.trim(), authors: authors.trim() };
}

/** 从标题/正文里抠 4 位年份（2015-2030 区间），抠不到就空 */
export function extractYear(text: string): string {
  const m = /(19[89]\d|20[0-4]\d)/.exec(String(text ?? ""));
  if (!m) return "";
  const y = Number(m[1]);
  return y >= 1980 && y <= 2049 ? String(y) : "";
}

/** 读取项目绑定的检索源；空数组 → 默认公共库 */
export async function resolveProjectSourceIds(projectId: string): Promise<string[]> {
  try {
    const r = await pool.query(`select source_ids from research_projects where id=$1`, [projectId]);
    const ids = (r.rows[0]?.source_ids ?? []) as string[];
    return ids.length ? ids : [DEFAULT_SOURCE];
  } catch {
    return [DEFAULT_SOURCE];
  }
}

/**
 * PG/向量臂的最低余弦相似度。
 *
 * 2026-09-16 实测(本机 500 篇"资本下乡"库, 1536→1024 维 embedding):
 *   问"资本下乡 乡村振兴"(库里大量覆盖) → 命中 0.75~0.90
 *   问"职业教育 产教融合"(库里基本没有) → 最高只有 0.58, 且第一名是「列宁关于规范引导
 *     资本主义发展的思想」—— 完全不相关, 却照样被当成"文献命中"写进参考文献。
 * 0.65 落在两个分布的间隔里。加这道闸之前, 向量臂**没有任何相关性判断**:
 *   库里不覆盖的主题也会硬凑满 topK 条最不差的, 用户拿到一摞看似有出处的假相关文献。
 * (searchMdLibrary / 图谱臂各自有脚本内判断, 不受这个常量影响)
 */
const MIN_VECTOR_SCORE = 0.65;

/**
 * PG 向量库检索。
 *
 * 直接连 source_chunks → documents 取 **document 级标题**，不走 searchService.vectorSearch ——
 * 实测后者返回的是 chunk 的 `heading`（"一、引言"/"（二）资本下乡的基本内涵" 这类章节小标题），
 * 拿它当参考文献标题是错的；而且 chunk 上没有任何著录字段。
 * documents.title 才是入库时的论文名（本机实测形如 `资本下乡的路径创新及其实践绩效_李玉霞`）。
 *
 * 每个文档只保留得分最高的一片当摘要片段，避免一本论文集里同一篇刷满结果。
 */
async function searchPg(query: string, sourceIds: string[], topK: number): Promise<LiteratureHit[]> {
  try {
    const { embeddingClient } = await import("../ai/embedding-client.js");
    const { pool: db } = await import("../db/pool.js");
    const vec = await embeddingClient.generate(query);
    // 召回放大到 topK*4：多篇文档被同一篇挤占时有货可换
    const r = await db.query(
      `with hits as (
         select c.document_id,
                c.content,
                1 - (c.embedding <=> $2::vector) as score,
                row_number() over (partition by c.document_id order by c.embedding <=> $2::vector) as rn
           from source_chunks c
          where c.source_id = any($1::uuid[]) and c.embedding is not null
          order by c.embedding <=> $2::vector
          limit $3
       )
       select d.title, h.content, h.score
         from hits h join documents d on d.id = h.document_id
        where h.rn = 1 and h.score >= $5
        order by h.score desc
        limit $4`,
      [sourceIds, JSON.stringify(vec), Math.max(topK * 4, 20), topK, MIN_VECTOR_SCORE]
    );
    return (r.rows as Array<{ title: string; content: string; score: number }>)
      .map((row) => {
        const { title, authors } = splitTitleAuthor(String(row.title ?? ""));
        return {
          title: title || "(无标题)",
          authors,
          year: extractYear(String(row.title ?? "")) || extractYear(String(row.content ?? "").slice(0, 500)),
          excerpt: String(row.content ?? "").replace(/\s+/g, " ").slice(0, 400),
          source: "pg" as const,
        };
      })
      .filter((h) => h.title && h.title !== "(无标题)");
  } catch (e) {
    console.warn(`[literature-retrieval] pg 臂失败: ${String(e).slice(0, 160)}`);
    return [];
  }
}

/** 本地 md 文献库检索：唯一带 authors/year 著录的源 */
async function searchMdLibrary(query: string, topK: number): Promise<LiteratureHit[]> {
  try {
    const { literatureService } = await import("./literature-service.js");
    const keyword = String(query ?? "").trim().slice(0, 40);
    if (!keyword) return [];
    const r = literatureService.list({ keyword, page: 1, pageSize: topK });
    const hits: LiteratureHit[] = [];
    for (const it of r.items ?? []) {
      const title = String(it.paperTitle || it.title || "").trim();
      if (!title) continue;
      hits.push({
        title,
        authors: Array.isArray(it.authors) ? it.authors.join("、") : String(it.authors ?? ""),
        year: String(it.year ?? ""),
        excerpt: String(it.topic ?? ""),
        source: "mdlibrary",
        ref: it.id,
      });
      if (hits.length >= topK) break;
    }
    return hits;
  } catch {
    return [];
  }
}

/** Neo4j 图谱臂（Graphiti 实体 / Cognee 切片）。池没就绪就跳过 —— 预览模式无池是常态。 */
async function searchGraph(query: string, topK: number): Promise<LiteratureHit[]> {
  const out: LiteratureHit[] = [];
  try {
    const { getGraphitiPool, getCogneePool } = await import("../api/reason-handler.js");
    const gPool = getGraphitiPool();
    if (gPool?.isReady?.()) {
      const raw = await gPool.callTool("hybrid_search_entities", {
        query, top_k: topK, enable_rewrite: true, enable_rerank: true,
      }).catch(() => null);
      for (const e of parseGraphitiEntities(raw).slice(0, topK)) {
        out.push({ title: e.name, authors: "", year: extractYear(e.description), excerpt: e.description, source: "graphiti" });
      }
    }
    const cPool = getCogneePool();
    if (cPool?.isReady?.() && out.length < topK) {
      const raw = await cPool.callTool("cognee_search", {
        query, search_type: "HYBRID_COMPLETION", top_k: topK, datasets: "capital_v28",
      }).catch(() => null);
      for (const c of parseCogneeSlices(raw).slice(0, topK - out.length)) {
        out.push({
          title: c.slice(0, 60), authors: "", year: extractYear(c),
          excerpt: c.replace(/\s+/g, " ").slice(0, 400), source: "cognee",
        });
      }
    }
  } catch { /* 池不可用/超时都不阻断主链 */ }
  return out;
}

/** Graphiti hybrid_search_entities 结果解析（与 search-service 的同名私有实现语义一致） */
export function parseGraphitiEntities(raw: unknown): Array<{ name: string; description: string }> {
  try {
    const r = raw as { result?: Array<{ text?: string }> };
    const text = r?.result?.[0]?.text;
    if (!text) return [];
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed?.entities) ? parsed.entities : Array.isArray(parsed) ? parsed : [];
    return arr.map((e: Record<string, unknown>) => ({
      name: String(e.name ?? e.title ?? "").trim(),
      description: e.description == null ? "" : String(e.description),
    })).filter((e: { name: string }) => e.name);
  } catch {
    return [];
  }
}

/** Cognee cognee_search 结果解析 */
export function parseCogneeSlices(raw: unknown): string[] {
  try {
    const r = raw as { result?: unknown };
    const arr = Array.isArray(r?.result) ? r.result : [];
    return arr.map((item: unknown) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        return String(o.text ?? o.content ?? "");
      }
      return "";
    }).filter((t) => t.length > 20);
  } catch {
    return [];
  }
}

export interface RetrieveInput {
  projectId: string;
  /** 检索词（章节关键词 / 主题） */
  queries: string[];
  topK?: number;
  /** 关掉某源（默认全开；md 文库/图谱失败自动跳过） */
  disable?: RetrievalSourceName[];
}

export interface RetrieveResult {
  hits: LiteratureHit[];
  /** 实际命中的源（用于素材徽章与"需人工补录"判定） */
  sources: RetrievalSourceName[];
}

/**
 * OpenAlex 外部检索（第五臂）。
 *
 * 2026-09-16 接入理由：写作舱此前只查内部四臂（PG/图谱/本地 md 库），内部库不覆盖的主题
 * 就恒为"未命中 → 需人工补录"。而本机实测 OpenAlex **免 key、直连可用**（1.4s 返回），
 * 中文检索词能命中 891 条真实中文文献，且返回 标题/作者/年份/期刊/DOI/卷期页 ——
 * 足以拼出 GB/T 7714 著录（这恰恰是内部库最缺的：pg 臂的著录要从不规范的文件名里猜）。
 *
 * 诚实的边界（写在这里免得以后有人误以为它是万方/知网的替代）：
 *   · OpenAlex 对**中文期刊的覆盖远不如 CNKI/万方**，很多中文核心期刊查不到或只有题录
 *   · 它是开放元数据聚合，不提供全文，也不保证字段准确（实测约有 1/3 条目缺作者）
 *   · 所以它是**补充臂**，排在内部库之后、且命中不覆盖内部结果
 * 关掉它：任务 inputSnapshot.useExternalSources === false，或 disable 里带 "openalex"。
 */
async function searchOpenAlex(query: string, topK: number): Promise<LiteratureHit[]> {
  try {
    // mailto 是 OpenAlex 的礼貌池(polite pool)约定, 带上能拿到更稳的配额; 不填也能用。
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${Math.min(20, Math.max(1, topK))}&mailto=sag@marxsphere.local`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const out: LiteratureHit[] = [];
    for (const w of body.results ?? []) {
      const title = String(w.title ?? "").trim();
      if (!title) continue;
      const authorships = (w.authorships ?? []) as Array<{ author?: { display_name?: string }; raw_author_name?: string }>;
      const authors = authorships
        .map((a) => normalizeCnAuthor(String(a.author?.display_name ?? a.raw_author_name ?? "")))
        .filter(Boolean)
        .join("、");
      const year = w.publication_year ? String(w.publication_year) : "";
      const doi = String(w.doi ?? "").replace(/^https?:\/\/doi\.org\//, "");
      const venue = String((w.primary_location as { source?: { display_name?: string } } | undefined)?.source?.display_name ?? "");
      // OpenAlex 偶发把**期刊名**塞进作者位(实测: "Journal of Educational Studies (JES)、Shuo Feng")。
      // 作者里出现刊名/出版方字样时整条丢掉 —— 留着会让著录行看起来像"期刊引用自己"。
      const AUTHOR_JUNK = /journal|press|publisher|出版社|学报编辑部|编辑委员会/i;
      if (AUTHOR_JUNK.test(authors)) continue;
      const biblio = (w.biblio ?? {}) as { volume?: string; issue?: string; first_page?: string; last_page?: string };
      const volumeIssue = [biblio.volume, biblio.issue].filter(Boolean).join("(") + (biblio.issue ? ")" : "");
      const pages = [biblio.first_page, biblio.last_page].filter(Boolean).join("-");
      // 摘要以倒排索引形式给出, 还原成纯文本(OpenAlex 的既定格式, 不是我们造的)
      const excerpt = restoreAbstract(w.abstract_inverted_index as Record<string, number[]> | null | undefined);
      out.push({
        title, authors, year, excerpt: excerpt || venue,
        source: "openalex", ref: doi || String(w.id ?? ""),
        ...(doi ? { doi } : {}),
        ...(venue ? { venue } : {}),
        ...(volumeIssue || pages ? { volumeIssue: [volumeIssue, pages].filter(Boolean).join(": ") } : {}),
      });
    }
    return out;
  } catch {
    // 网络不可达/超时/限流 → 静默空手(外部源失败不该让整条检索链挂掉)
    return [];
  }
}

/** OpenAlex 的 abstract_inverted_index → 纯文本(按位置还原词序) */
function restoreAbstract(idx: Record<string, number[]> | null | undefined): string {
  if (!idx) return "";
  const words: Array<[number, string]> = [];
  for (const [w, positions] of Object.entries(idx)) {
    for (const p of positions ?? []) words.push([p, w]);
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(([, w]) => w).join(" ").slice(0, 300);
}

/** 常见中文姓氏(覆盖绝大多数)。用于判断 OpenAlex 拆开的姓名该按什么顺序还原。 */
const CN_SURNAMES = new Set(
  ("王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤温康施文牛樊葛邢安常易乔伍庞颜倪庄聂章鲁岳翟殷詹申欧耿关兰焦俞左柳甘祝包宁尚符舒阮柯纪梅童凌毕单季裴霍涂成苗谷盛曲翁冉骆蓝路游辛靳管柴蒙鲍华喻祁蒲房滕屈饶解牟艾尤阳时穆农司卓古吉缪简车项连芦麦褚娄窦戚岑景党宫费卜冷晏席卫米柏宗瞿桂全佟应臧闵苟邬边卞姬邰仇栾隋商刁沙荣巫寇桑郎甄丛仲虞敖巩明佘池查麻苑迟范" +
   "欧阳司马诸葛上官东方独孤南宫慕容司徒令狐尉迟皇甫长孙宇文轩辕闻人澹台公冶宗政濮阳淳于单于太叔申屠公孙仲孙钟离").split("")
);

/**
 * 修 OpenAlex 的中文名。
 *
 * 实测(2026-09-16)它把中文姓名按西文习惯拆开: "程琴" 存成 "琴 程"、"陈兵" 存成 "兵 陈",
 * 直接著录就变成「琴 程. 数智化赋能…」—— 作者名是错的。
 *
 * 还原规则用**姓氏表**判断, 而不是一律交换: 两种顺序里只有一种的第一个字是常见姓氏。
 *   "琴 程" → 程不是"琴"的姓、"程"是姓 → 「程琴」 ✅
 *   "陈 兵" → 第一个字"陈"就是姓 → 原样保留「陈 兵」→ 去空格「陈兵」✅
 * 两个都不是姓(或都是)时保持原样 —— 宁可不动, 也不能把名字改错。
 * 西文名(含非汉字、多段)一律不动。
 */
export function normalizeCnAuthor(raw: string): string {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  const m = /^([一-龥]{1,3})\s+([一-龥]{1,3})$/.exec(s);
  if (!m) return s;
  const [, a, b] = m;
  const aIsSurname = CN_SURNAMES.has(a[0]);
  const bIsSurname = CN_SURNAMES.has(b[0]);
  if (aIsSurname && !bIsSurname) return `${a}${b}`;      // 原序正确: 陈 兵 → 陈兵
  if (bIsSurname && !aIsSurname) return `${b}${a}`;      // 被拆反了: 琴 程 → 程琴
  return aIsSurname && bIsSurname ? `${a}${b}` : s;      // 无法判定 → 不动
}

/**
 * 多词检索去重合并。多个检索词各跑一轮，按标题去重，保留首次命中的顺序。
 * 全程不调 LLM —— 只做 embedding + 向量召回 + 文件扫描，便于在 job 里同步跑。
 */
export async function retrieveLiterature(input: RetrieveInput): Promise<RetrieveResult> {
  const topK = input.topK ?? 8;
  const disabled = new Set(input.disable ?? []);
  const queries = Array.from(new Set((input.queries ?? []).map((q) => String(q ?? "").trim()).filter(Boolean))).slice(0, 4);
  if (!queries.length) return { hits: [], sources: [] };

  const sourceIds = disabled.has("pg") ? [] : await resolveProjectSourceIds(input.projectId);
  const merged: LiteratureHit[] = [];
  const seen = new Set<string>();
  const push = (hits: LiteratureHit[]) => {
    for (const h of hits) {
      const key = h.title.replace(/\s+/g, "").slice(0, 40);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(h);
      if (merged.length >= topK) return;
    }
  };

  for (const q of queries) {
    if (merged.length >= topK) break;
    if (sourceIds.length) push(await searchPg(q, sourceIds, topK));
    if (merged.length < topK && !disabled.has("mdlibrary")) push(await searchMdLibrary(q, topK));
    if (merged.length < topK && (!disabled.has("graphiti") || !disabled.has("cognee"))) {
      push(await searchGraph(q, topK - merged.length));
    }
  }

  // 外部臂(OpenAlex): 内部四臂按 topK 收敛后, 若内部结果**没占到七成**说明这个主题库里覆盖不足,
  //   此时去外面补到 topK —— 补的量受 externalQuota 限制, 不会把内部结果挤掉,
  //   但能避免"库里只有两条相关 → 整个参考文献只有两条"。
  // 顺序上放最后, 是因为内部库是本项目自有语料, 相关性天然高于外部聚合。
  if (!disabled.has("openalex") && topK > 0) {
    const minInternal = Math.ceil(topK * INTERNAL_SHARE);
    if (merged.length < minInternal) {
      const quota = Math.max(1, Math.ceil(topK * (1 - INTERNAL_SHARE)));
      for (const q of queries) {
        if (merged.length >= minInternal + quota) break;
        push(await searchOpenAlex(q, minInternal + quota - merged.length));
      }
    }
  }

  const sources = Array.from(new Set(merged.map((h) => h.source))) as RetrievalSourceName[];
  return { hits: merged.slice(0, topK), sources };
}

/**
 * 单条著录行：[N] 作者. 标题. 年份. —— 缺字段就省略，不编造。
 * 有期刊/卷期/DOI 时按 GB/T 7714 期刊论文格式著录：
 *   `作者. 标题[J]. 刊名, 年, 卷(期): 页码. DOI:xxx.`
 * 没有的字段一律不补 —— 内部库绝大多数条目只有标题+作者，硬套格式会造出不存在的刊名。
 */
export function formatReferenceLine(no: number, hit: LiteratureHit): string {
  const parts: string[] = [];
  if (hit.authors) parts.push(`${hit.authors}.`);
  // 有刊名才标 [J]；否则按题录处理，不加载体类型(加了就是编造)
  parts.push(hit.venue ? `${hit.title}[J].` : `${hit.title}.`);
  if (hit.venue) {
    const tail = [hit.venue, hit.year, hit.volumeIssue].filter(Boolean).join(", ");
    parts.push(`${tail}.`);
  } else if (hit.year) {
    parts.push(`${hit.year}.`);
  }
  if (hit.doi) parts.push(`DOI:${hit.doi}.`);
  return `[${no}] ${parts.join(" ")}`;
}

/** 命中条目 → 素材 content_md（编号清单，供 buildCitationPool/buildMergedReferences 抠取） */
export function buildCitationMaterialBody(hits: LiteratureHit[]): string {
  if (!hits.length) return "";
  // V417: excerpt 此前**只被赋值、零消费**(注释写"用于让模型判断该引什么", 但没人读)。
  // 附在编号行之后(缩进行), 正文生成时模型能据此判断该条与哪一章/哪个论点相关, 而不是
  // 只看标题就盲引。引用池仍以行首 `[N] 著录` 为准 —— 下游正则只认行首, 缩进行不干扰。
  return hits.map((h, i) => {
    const line = formatReferenceLine(i + 1, h);
    const ex = String(h.excerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    return ex && ex !== h.title ? `${line}\n    摘要: ${ex}` : line;
  }).join("\n");
}
