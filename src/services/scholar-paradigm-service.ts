// scholar-paradigm-service.ts — V395-25: 学者文献范式提取
// 管道: 知网下载(CNKI skill) → PDF转md(pdf2obsidian) → 入库(md-clean/marx-ingest-all)
//       → 范式提取(本服务: 从学者文献提炼写作范式) → 回填学者库 + 前端展示
// 范式维度: 选题方法/标题结构/章节框架/论证风格/概念命名/理论接口/期刊偏好
import { pool } from "../db/pool.js";
import fs from "node:fs/promises";
import path from "node:path";
import { getRoleModel, resolveModelAlias } from "./llm-model-registry.js";
import { callLlm } from "../ai/llm-common.js";

/** V395-27: 范式证据（每维度附文献原文证据） */
export interface ParadigmEvidence {
  title: string;    // 文献标题
  quote: string;    // 原文引用片段（具体依据）
}

export interface ScholarParadigm {
  topicPattern: string;         // 选题方法总结
  topicEvidence: ParadigmEvidence[];
  titleStructure: string;       // 标题结构总结
  titleEvidence: ParadigmEvidence[];
  chapterFramework: string;     // 章节框架总结
  chapterEvidence: ParadigmEvidence[];
  argumentStyle: string;        // 论证风格总结
  argumentEvidence: ParadigmEvidence[];
  conceptNaming: string;        // 概念命名总结
  conceptEvidence: ParadigmEvidence[];
  theoryInterfaces: string[];   // 常用理论接口
  theoryEvidence: ParadigmEvidence[];
  journalPreference: string;    // 期刊偏好总结
  journalEvidence: ParadigmEvidence[];
  sampleTitles: string[];       // 代表文献题目
}

/** 图谱服务可用性探测（不依赖 MCP 池, 直连 bolt） */
async function graphBackendAlive(port: number): Promise<boolean> {
  try {
    const { neo4jQuery } = await import("../db/neo4j-query.js");
    const rows = await neo4jQuery(port, "MATCH (n) RETURN count(n) AS n", {}, 4000);
    return Array.isArray(rows) && rows.length > 0 && Number(rows[0]?.n) > 0;
  } catch { return false; }
}

/**
 * V395-30: 从知识图谱采集学者结构化数据（Graphiti 超边/社区 + Cognee 实体关系）
 * 直连 Neo4j bolt（11001 Graphiti / 11003 Cognee），不依赖 MCP 池（preview 模式可用）
 * 数据源不可用时返回 null（上层降级为纯 PG）
 * 图谱语义 → 范式维度:
 *   Cognee 语义关系(authored/draws_on/theorizes_about/publishes_in/analyzes) → 选题/理论接口/期刊偏好
 *   Graphiti HyperEdge(type/summary/text) → 论证机制/概念命名/章节框架
 *   Graphiti Community → 领域归属/选题定位
 */
export async function collectScholarGraphData(scholarName: string): Promise<string | null> {
  const { neo4jQuery } = await import("../db/neo4j-query.js");
  const [cogneeOk, graphitiOk] = await Promise.all([graphBackendAlive(11003), graphBackendAlive(11001)]);
  if (!cogneeOk && !graphitiOk) return null;
  const name = String(scholarName || "").replace(/（.*?）/, "").trim();
  const parts: string[] = [];

  // ── Cognee (11003): 实体语义关系（作者实体 → 论文/理论/概念/期刊）──
  if (cogneeOk) {
    try {
      const relR = await neo4jQuery<{ rt: string; n: string; names: string[] }>(
        11003,
        `MATCH (e:Entity {name: $n})-[r]-(o:Entity)
         WHERE o.name IS NOT NULL AND o.name <> $n AND o.name <> ''
         RETURN type(r) AS rt, count(*) AS n, collect(DISTINCT o.name)[0..10] AS names
         ORDER BY n DESC LIMIT 20`,
        { n: name }, 20000
      );
      if (relR.length > 0) {
        parts.push(`\n■ 图谱·Cognee 实体关系（${scholarName} 为中心, 反映选题/理论接口/期刊偏好）:`);
        parts.push(relR.map((r) => `${r.rt}→${(r.names || []).join("/")}`).join("；"));
      }
      // 同名学者论文实体（按关系聚合, 补充单实体直查不到的）
      const artR = await neo4jQuery<{ rt: string; names: string[] }>(
        11003,
        `MATCH (a:Entity {name: $n})-[:authored]->(o:Entity)
         OPTIONAL MATCH (o)<-[r]-(x:Entity)
         RETURN coalesce(type(r), 'none') AS rt, collect(DISTINCT x.name)[0..6] AS names LIMIT 12`,
        { n: name }, 20000
      );
      if (artR.length > 0) {
        const rows = artR.filter((r) => r.rt !== "none");
        if (rows.length > 0) {
          parts.push(`\n■ 图谱·Cognee 论文关联（${scholarName} 论文的关联实体）:`);
          parts.push(rows.map((r) => `${r.rt}→${(r.names || []).join("/")}`).join("；"));
        }
      }
    } catch (e: any) {
      parts.push(`\n（Cognee 图谱查询失败: ${String(e?.message || e).slice(0, 80)}）`);
    }
  }

  // ── Graphiti (11001): 超边/社区 ──
  if (graphitiOk) {
    try {
      // 1. 作者实体社区归属（选题领域定位）
      const commR = await neo4jQuery<{ community_id: string; parent: string; level: string }>(
        11001,
        `MATCH (e:Entity {name: $n})-[:BELONGS_TO_COMMUNITY]->(c:Community)
         RETURN c.community_id AS community_id, c.parent_community AS parent, c.level AS level LIMIT 5`,
        { n: name }, 15000
      );
      if (commR.length > 0) {
        parts.push(`\n■ 图谱·Graphiti 社区归属（${scholarName} 论文的领域定位）:`);
        parts.push(commR.map((c) => `${c.community_id}${c.parent ? `（父社区:${c.parent}${c.level ? `/${c.level}` : ""}）` : ""}`).join("；"));
      }
      // 2. 作者参与超边（INVOLVED_IN）→ 论证机制
      const heR = await neo4jQuery<{ type: string; summary: string }>(
        11001,
        `MATCH (e:Entity {name: $n})-[:INVOLVED_IN]->(h:HyperEdge)
         WHERE h.summary IS NOT NULL AND h.summary <> ''
         RETURN h.type AS type, h.summary AS summary LIMIT 8`,
        { n: name }, 15000
      );
      if (heR.length > 0) {
        parts.push(`\n■ 图谱·Graphiti 超边（${scholarName} 参与的论证断言, 反映论证机制/核心观点）:`);
        parts.push(heR.map((h) => `[${h.type || "?"}] ${h.summary}`).join("；"));
      }
      // 3. 作者论文(Episode) → 概念实体 → 超边（覆盖 author 字段分离的文献, 精选高相关超边）
      //    链路: Episode ←EXTRACTED_FROM- Entity -INVOLVED_IN-> HyperEdge
      const heR2 = await neo4jQuery<{ ents: string[]; type: string; summary: string }>(
        11001,
        `MATCH (ep:Episode)<-[:EXTRACTED_FROM]-(e:Entity)-[:INVOLVED_IN]->(h:HyperEdge)
         WHERE ep.title CONTAINS $n AND h.summary IS NOT NULL AND h.summary <> ''
         WITH h, count(DISTINCT e) AS shared, collect(DISTINCT e.name)[0..3] AS ents
         // 共享实体越多 → 与该学者文献关联越紧
         ORDER BY shared DESC, h.confidence DESC
         RETURN h.type AS type, ents AS ents, h.summary AS summary
         LIMIT 8`,
        { n: name }, 20000
      );
      if (heR2.length > 0) {
        parts.push(`\n■ 图谱·Graphiti 论文超边（周绍东论文的核心断言, 反映论证机制/概念命名/章节框架）:`);
        parts.push(heR2.map((h) => `[${h.type || "?"}]${(h.ents || []).length ? ` ${h.ents!.join("/")}·` : ""}${h.summary}`).join("；"));
      }
    } catch (e: any) {
      parts.push(`\n（Graphiti 图谱查询失败: ${String(e?.message || e).slice(0, 80)}）`);
    }
  }

  if (parts.length === 0) return null;
  return `\n【知识图谱结构化数据（Graphiti 超边/社区 + Cognee 实体关系）· ${scholarName}】` + parts.join("\n");
}

/**
 * V395-29: 从 PG 三库结构化数据采集学者文献特征（不依赖 md 目录）
 * 数据源: documents(全文) + entities(实体) + events(事件) + event_entities(事件-实体关联) + source_chunks(切片含heading) + document_sections(章节结构)
 * 输出: 结构化文本块（实体命名/事件网络/章节结构/切片主题）— 反映范式: 概念命名(实体)/论证连接(事件)/框架(章节)
 */
export async function collectScholarStructuredData(input: {
  scholarName: string;       // 学者名关键词（如 周绍东）
  maxDocs?: number;          // 最多文档数
}): Promise<{
  docIds: string[];
  title: string;             // 汇总标题
  structuredText: string;    // 结构化文本（送 LLM）
  graphText: string;         // V395-30: 图谱结构化数据（Graphiti 超边/社区 + Cognee 实体关系, 可能为空）
  textDocs: Array<{ title: string; content: string }>;  // 全文文档（与md扫描兼容）
}> {
  const { pool } = await import("../db/pool.js");
  const maxDocs = input.maxDocs ?? 10;
  const like = `%${input.scholarName}%`;
  // 1. 找学者文档
  const docsR = await pool.query(
    "select id, title, content from documents where title ilike $1 order by length(coalesce(content,'')) desc limit $2",
    [like, maxDocs]
  );
  const docIds = docsR.rows.map((r: any) => r.id);
  if (docIds.length === 0) return { docIds: [], title: "", structuredText: "", graphText: "", textDocs: [] };

  // 2. 实体（概念命名范式）
  const entR = await pool.query(
    `select e.name, e.type, count(*) as n from entities e
     where e.source_id = any($1::uuid[]) group by e.name, e.type order by n desc limit 40`,
    [docIds]
  );
  // 3. 事件（论证连接/主题范式）
  const evR = await pool.query(
    `select e.title, e.category, count(*) as n from events e
     where e.document_id = any($1::uuid[]) group by e.title, e.category order by n desc limit 20`,
    [docIds]
  );
  // 4. 切片 heading（章节/论证结构）
  const chR = await pool.query(
    `select c.heading, count(*) as n from source_chunks c
     where c.document_id = any($1::uuid[]) and c.heading is not null and c.heading != ''
     group by c.heading order by n desc limit 30`,
    [docIds]
  );
  // 5. 章节结构（document_sections）
  const secR = await pool.query(
    `select s.heading, s.type, count(*) as n from document_sections s
     where s.document_id = any($1::uuid[]) and s.heading is not null and s.heading != ''
     group by s.heading, s.type order by n desc limit 30`,
    [docIds]
  );

  // 组装结构化文本
  const parts: string[] = [];
  parts.push(`【学者文献结构化数据 · ${input.scholarName} · ${docIds.length} 篇】`);
  if (entR.rows.length > 0) {
    parts.push(`\n■ 高频实体（${entR.rows.length}个, 反映概念命名与核心术语）:`);
    parts.push(entR.rows.map((r: any) => `${r.name}（${r.type || "?"}, 出现${r.n}次）`).join("；"));
  }
  if (evR.rows.length > 0) {
    parts.push(`\n■ 事件主题（${evR.rows.length}个, 反映论证议题）:`);
    parts.push(evR.rows.map((r: any) => `${r.title}（${r.category || "?"}）`).join("；"));
  }
  if (chR.rows.length > 0) {
    parts.push(`\n■ 切片标题结构（${chR.rows.length}个, 反映章节框架）:`);
    parts.push(chR.rows.map((r: any) => r.heading).join("；"));
  }
  if (secR.rows.length > 0) {
    parts.push(`\n■ 章节块（${secR.rows.length}个）:`);
    parts.push(secR.rows.map((r: any) => `${r.heading}[${r.type || "?"}]`).join("；"));
  }
  const structuredText = parts.join("\n");

  // 全文（兼容现有提取: 取每篇前 6000 字）
  const textDocs = docsR.rows.map((r: any) => ({
    title: String(r.title || "").slice(0, 80),
    content: String(r.content || "").slice(0, 6000),
  }));

  // V395-30: 知识图谱数据（Graphiti 超边/社区 + Cognee 实体关系, 直连 bolt 不依赖 MCP 池）
  let graphText = "";
  try {
    graphText = (await collectScholarGraphData(input.scholarName)) || "";
  } catch { graphText = ""; }

  return {
    docIds,
    title: `${input.scholarName} 文献（PG 结构化 + 图谱 + 全文）`,
    structuredText,
    graphText,
    textDocs,
  };
}

/** 扫描学者文献目录（md 文件, 递归子目录）
 * 兼容: pdf2obsidian 产物(original.md/摘要.md/信息.md) + MinerU full.md + 任意正文 md */
export async function scanScholarDocs(dir: string): Promise<Array<{ file: string; title: string; content: string }>> {
  const docs: Array<{ file: string; title: string; content: string }> = [];
  // 递归收集 md（限制深度 3, 防过深）
  const stack = [{ d: dir, depth: 0 }];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try { entries = await fs.readdir(cur.d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur.d, e.name);
      if (e.isDirectory()) {
        if (cur.depth < 3) stack.push({ d: full, depth: cur.depth + 1 });
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      // 排除非正文（index.md 等导航类）
      if (/(index|导航|返回)\.md$/.test(e.name)) continue;
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        const content = await fs.readFile(full, "utf8");
        if (content.trim().length < 200) continue;  // 跳过空文档
        // 取标题（frontmatter title 或首行 # 或文件名）
        const fm = content.match(/^---\s*\n[\s\S]*?\ntitle:\s*["']?([^"'\n]+)/);
        const h1 = content.match(/^#\s+(.+)$/m);
        const title = (fm?.[1] || h1?.[1] || e.name.replace(/\.md$/, "")).trim().slice(0, 80);
        docs.push({ file: path.relative(dir, full).replace(/\\/g, "/"), title, content: content.slice(0, 6000) });
      } catch { /* 单文件失败跳过 */ }
    }
  }
  return docs.slice(0, 50);  // 上限 50 篇
}

/** 从学者文献提取写作范式（LLM 多文档综合）
 * V395-26: 支持 model 参数（前端模型选择器指定） */
export async function extractScholarParadigm(input: {
  scholarId: string;
  scholarName: string;
  docs: Array<{ title: string; content: string }>;
  model?: string;
  extraContext?: string;  // V395-29: PG 结构化数据上下文（实体/事件/切片章节）
  graphContext?: string;  // V395-30: 知识图谱上下文（Graphiti 超边/社区 + Cognee 实体关系）
}): Promise<{ paradigm: ScholarParadigm | null; error?: string }> {
  if (input.docs.length === 0) return { paradigm: null, error: "目录下没有学者文献（md 文件）" };
  const model = input.model ? resolveModelAlias(input.model) : resolveModelAlias(getRoleModel("plan"));
  // V395-29: 结构化数据作为独立上下文块（实体/事件/章节 — 反映概念命名/论证/框架范式）
  const structuredBlock = input.extraContext
    ? `\n\n【学者文献结构化数据（PG 三库: 实体/事件/切片章节）】\n${input.extraContext}`
    : "";
  // V395-30: 图谱数据上下文块（超边断言/社区归属/语义关系 — 反映论证机制/理论接口/选题定位）
  const graphBlock = input.graphContext
    ? `\n\n【知识图谱结构化数据（Graphiti 超边/社区 + Cognee 实体关系）】\n${input.graphContext}`
    : "";
  // V395-28: 每篇文献完整送入 — 分块(每块4000字)覆盖全文, 单篇超长文献拆多块
  const docsText = input.docs.slice(0, 15).flatMap((d, i) => {
    const chunks: string[] = [];
    for (let off = 0; off < (d.content || "").length; off += 4000) {
      chunks.push(d.content.slice(off, off + 4000));
    }
    if (chunks.length === 0) chunks.push("");
    return chunks.map((c, ci) => `【文献${i + 1}${chunks.length > 1 ? `-${ci + 1}/${chunks.length}` : ""}】${d.title}\n${c}`);
  }).join("\n\n");
  const prompt = `你是马理论 C 刊写作范式分析师。从学者"${input.scholarName}"的 ${input.docs.length} 篇文献中提炼其文章写作范式（供 AI 生成该学者风格选题时参考）。

文献内容（长文献已分段, 标注【文献N-M/总段】）:
${docsText}
${structuredBlock}
${graphBlock}

对每个范式维度，先给出总结性描述，再列出**全部文献中该维度的所有具体证据**：
- **每篇文献每个不同小节/角度都要单独一条证据**（一篇文献通常 2-5 条, 不合并）
- 每条证据 = 文献标题 + 该处原文引用片段
- 证据必须来自文献原文, 不要编造

维度要求:
1. 选题方法: 每篇文献的选题角度/问题类型 → 每条证据=文献标题+该文选题如何体现
2. 标题结构: 每篇文献的标题句式 → 证据=文献标题原文+句式拆解
3. 章节框架: 每篇文献的每个章节小标题 → 证据=文献标题+实际章节小标题引用（各章各一条）
4. 论证风格: 每篇文献的论证方式（每处体现都要一条）→ 证据=文献标题+体现论证方式的原文片段
5. 概念命名: 每篇文献的自创/标识性概念（每个概念一条）→ 证据=文献标题+概念原文
6. 理论接口: 每篇文献引用的马克思经典理论（每个理论一条）→ 证据=文献标题+理论出处原文
7. 期刊偏好: 从文献可推断 → 证据=文献标题+推断依据
8. 代表文献题目: 全部文献标题

输出 JSON 结构（每维度 summary 总结 + evidence 数组, evidence 每项 {title:"文献标题", quote:"原文引用片段"}）:
{"topicPattern":"总结","topicEvidence":[{"title":"文献标题","quote":"原文片段"}],
 "titleStructure":"总结","titleEvidence":[...],
 "chapterFramework":"总结","chapterEvidence":[...],
 "argumentStyle":"总结","argumentEvidence":[...],
 "conceptNaming":"总结","conceptEvidence":[...],
 "theoryInterfaces":["..."],"theoryEvidence":[...],
 "journalPreference":"总结","journalEvidence":[...],
 "sampleTitles":["..."]}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2, maxTokens: 6000 });
  if (!r?.text) return { paradigm: null, error: "LLM 无响应" };
  try {
    const parsed = JSON.parse(extractJson(r.text));
    const ev = (list: any): ParadigmEvidence[] => Array.isArray(list)
      ? list.map((x: any) => ({ title: String(x?.title || "").slice(0, 100), quote: String(x?.quote || "").slice(0, 500) })).filter((x) => x.title || x.quote)
      : [];
    return {
      paradigm: {
        topicPattern: String(parsed.topicPattern || ""),
        topicEvidence: ev(parsed.topicEvidence),
        titleStructure: String(parsed.titleStructure || ""),
        titleEvidence: ev(parsed.titleEvidence),
        chapterFramework: String(parsed.chapterFramework || ""),
        chapterEvidence: ev(parsed.chapterEvidence),
        argumentStyle: String(parsed.argumentStyle || ""),
        argumentEvidence: ev(parsed.argumentEvidence),
        conceptNaming: String(parsed.conceptNaming || ""),
        conceptEvidence: ev(parsed.conceptEvidence),
        theoryInterfaces: Array.isArray(parsed.theoryInterfaces) ? parsed.theoryInterfaces.map(String) : [],
        theoryEvidence: ev(parsed.theoryEvidence),
        journalPreference: String(parsed.journalPreference || ""),
        journalEvidence: ev(parsed.journalEvidence),
        sampleTitles: Array.isArray(parsed.sampleTitles) ? parsed.sampleTitles.map(String) : [],
      },
    };
  } catch (e: any) {
    return { paradigm: null, error: `解析失败: ${String(e?.message || e).slice(0, 80)}` };
  }
}

/** 提取范式并回填学者库（paradigm 字段） */
/** 提取范式并回填学者库（paradigm 字段）
 * V395-29: 支持 source=pg（三库结构化数据）或 source=dir（md 目录） */
export async function extractAndSaveParadigm(input: {
  scholarId: string;
  docsDir?: string;
  model?: string;  // V395-26: 模型选择
  source?: "pg" | "dir";  // V395-29: 数据源
  graph?: boolean;  // V395-30: 是否含知识图谱数据（Graphiti/Cognee）
}): Promise<{ ok: boolean; paradigm?: ScholarParadigm; docCount?: number; sourceInfo?: string; graphInfo?: string; error?: string }> {
  const { pool: p } = await import("../db/pool.js");
  // 找学者
  const sr = await p.query("select scholar from cjournal_scholars where id = $1", [input.scholarId]);
  if (sr.rows.length === 0) return { ok: false, error: "学者不存在" };
  const scholarName = sr.rows[0].scholar;
  let docs: Array<{ title: string; content: string }> = [];
  let sourceInfo = "";
  let graphInfo = "";  // V395-30: 图谱数据（可为空 → 降级）
  const usePg = input.source === "pg" || (!input.docsDir && input.source !== "dir");
  if (usePg) {
    // V395-29: PG 三库结构化 + 全文（不需要 md 目录）
    const structured = await collectScholarStructuredData({ scholarName: scholarName.replace(/（.*?）/, ""), maxDocs: 10 });
    if (structured.docIds.length === 0) return { ok: false, error: `PG 中未找到学者「${scholarName}」的文献` };
    docs = structured.textDocs;
    sourceInfo = structured.structuredText;
    graphInfo = structured.graphText;  // V395-30: 图谱数据（服务不可用时空串 → 降级纯 PG）
  } else {
    docs = await scanScholarDocs(input.docsDir || "");
    if (docs.length === 0) return { ok: false, error: "目录下没有学者文献（md 文件）" };
    // V395-30: md 目录模式同样可附加图谱数据（需显式开启）
    if (input.graph) {
      try { graphInfo = (await collectScholarGraphData(scholarName)) || ""; } catch { graphInfo = ""; }
    }
  }
  const result = await extractScholarParadigm({ scholarId: input.scholarId, scholarName, docs, model: input.model, extraContext: sourceInfo, graphContext: graphInfo });
  if (!result.paradigm) return { ok: false, error: result.error };
  // 回填: paradigm jsonb 字段
  await p.query(
    `update cjournal_scholars set paradigm = $2::jsonb, paradigm_source_dir = $3, paradigm_updated_at = now() where id = $1`,
    [input.scholarId, JSON.stringify(result.paradigm), input.docsDir || (usePg ? (graphInfo ? "PG三库+图谱" : "PG三库结构化") : "")]
  );
  // 清学者缓存（cjournal-service 的）
  const { cjournalService } = await import("./cjournal-service.js");
  (cjournalService as any)._clearScholarCache?.();
  const graphOk = graphInfo.includes("知识图谱结构化数据");
  return { ok: true, paradigm: result.paradigm, docCount: docs.length, sourceInfo: usePg ? "PG三库" : "md目录", graphInfo: graphOk ? "Graphiti/Cognee" : "图谱不可用(已降级)" };
}

/** 读取学者范式 */
export async function getScholarParadigm(scholarId: string): Promise<ScholarParadigm | null> {
  const r = await pool.query("select paradigm from cjournal_scholars where id = $1", [scholarId]);
  return r.rows[0]?.paradigm || null;
}

/** 健壮 JSON 提取 */
function extractJson(text: string): string {
  const t = text.trim().replace(/```json|```/g, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  return start !== -1 && end > start ? t.slice(start, end + 1) : t;
}

export const scholarParadigmService = {
  scanScholarDocs,
  extractScholarParadigm,
  extractAndSaveParadigm,
  getScholarParadigm,
  collectScholarStructuredData,  // V395-29: PG 三库结构化数据
  collectScholarGraphData,       // V395-30: 知识图谱数据（Graphiti 超边/社区 + Cognee 实体关系）
};
