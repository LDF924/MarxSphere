// mcp-tools-service.ts — MCP 工具大全（静态清单 + 中文说明 + 参数示例）
// 包含：SAG 自带 4 个 + Cognee 13 + Graphiti 12 + 2 ingest + Sciverse 6 + gov.cn 2
// 预览模式也能显示（不依赖运行时连接）

export interface McpToolInfo {
  name: string;
  desc: string;
  group: string;
  /** 完整 JSON Schema：字段 → {type, description, required?} */
  schema?: Record<string, { type: string; description: string; required?: boolean }>;
  example?: Record<string, unknown>;
}

export interface McpServerInfo {
  id: string;
  name: string;
  description: string;
  tools: McpToolInfo[];
}

export const MCP_TOOL_CATALOG: McpServerInfo[] = [
  {
    id: "sag",
    name: "SAG 检索工作台",
    description: "MarxSphere 自带检索服务：多路检索 + 文档入库 + 事件查询。",
    tools: [
      { name: "sag_search", desc: "对绑定项目执行多路检索，返回检索 trace", group: "检索",
        schema: { query: { type: "string", description: "检索关键词/问题", required: true }, searchMode: { type: "fast|standard", description: "检索模式(fast/standard)", required: false }, topK: { type: "number", description: "参数", required: false } },
        example: { query: "资本下乡对农村集体经济的影响", searchMode: "fast", topK: 10 } },
      { name: "sag_explain_search", desc: "返回检索链路说明和 trace，调试检索过程", group: "检索",
        schema: { query: { type: "string", description: "检索关键词/问题", required: true } },
        example: { query: "土地流转的产权问题" } },
      { name: "sag_get_event", desc: "按事件 ID 查询事件详情", group: "检索",
        schema: { eventId: { type: "string", description: "事件 ID", required: true } },
        example: { eventId: "00000000-0000-0000-0000-000000000001" } },
      { name: "sag_execute_code", desc: "执行 Python/JavaScript 代码（沙箱子进程，超时熔断）", group: "执行",
        schema: { language: { type: "python|javascript", description: "语言", required: true }, code: { type: "string", description: "代码", required: true }, timeoutMs: { type: "number", description: "超时毫秒", required: false } },
        example: { language: "python", code: "print('hello')" } },
      { name: "sag_browse", desc: "Edge headless 抓取网页内容（SSR/静态页）", group: "执行",
        schema: { url: { type: "string", description: "URL", required: true }, waitMs: { type: "number", description: "等待毫秒", required: false } },
        example: { url: "https://example.com", waitMs: 3000 } },
      { name: "sag_ingest_document", desc: "导入文档并执行切片、事件抽取、实体抽取和向量化", group: "入库",
        schema: { title: { type: "string", description: "文档标题", required: true }, content: { type: "string", description: "文档内容", required: true }, sourceId: { type: "string", description: "项目 ID", required: false } },
        example: { title: "资本下乡研究", content: "全文内容…" } }
    ]
  },
  {
    id: "marx-cognee",
    name: "Cognee 知识图谱",
    description: "概念级知识图谱（Neo4j 11003，38672 节点）。检索 + 入库 + 批量管理。",
    tools: [
      { name: "cognee_search", desc: "语义检索知识图谱（多种搜索类型）", group: "检索",
        schema: { query: { type: "string", description: "检索关键词/问题", required: true }, dataset: { type: "string", description: "数据集名称", required: false }, top_k: { type: "number", description: "返回数量", required: false } },
        example: { query: "资本下乡对农村集体经济的影响", top_k: 5 } },
      { name: "cognee_compare", desc: "对比多个实体/概念的关系", group: "检索",
        schema: { entities: { type: "array of string", description: "实体名数组", required: true } },
        example: { entities: ["资本下乡", "农村集体经济"] } },
      { name: "cognee_add", desc: "添加新知识（文本/文档）", group: "入库",
        schema: { title: { type: "string", description: "文档标题", required: true }, content: { type: "string", description: "文档内容", required: true }, document_type: { type: "string", description: "文档类型", required: false } },
        example: { title: "资本下乡研究笔记", content: "工商资本进入农村的实践与问题…" } },
      { name: "cognee_cognify", desc: "对文档做认知处理（实体抽取）", group: "入库",
        schema: { dataset: { type: "string", description: "数据集名称", required: true } },
        example: { dataset: "capital_v28" } },
      { name: "cognee_batch_ingest", desc: "批量入库多篇文档", group: "入库",
        schema: { folder: { type: "string", description: "文件夹路径", required: true }, batch_size: { type: "number", description: "批次大小", required: false } },
        example: { folder: "E:/文献库/资本下乡", batch_size: 30 } },
      { name: "cognee_detect_new_papers", desc: "检测待入库的新论文", group: "入库",
        schema: { folder: { type: "string", description: "文件夹路径", required: true } },
        example: { folder: "E:/文献库" } },
      { name: "cognee_estimate_batch_cost", desc: "估算批量入库成本", group: "入库",
        schema: { papers: { type: "number", description: "论文数量", required: true } },
        example: { papers: 100 } },
      { name: "cognee_check_ingestion_progress", desc: "查询入库进度", group: "入库",
        schema: { batch_id: { type: "string", description: "批次 ID", required: false } },
        example: {} },
      { name: "cognee_list_failed_papers", desc: "列出入库失败的论文", group: "入库",
        schema: { batch_id: { type: "string", description: "批次 ID", required: false } },
        example: {} },
      { name: "cognee_verify_ingestion", desc: "校验入库完整性", group: "入库",
        schema: { dataset: { type: "string", description: "数据集名称", required: false } },
        example: {} },
      { name: "cognee_datasets", desc: "列出数据集", group: "管理",
        schema: {}, example: {} },
      { name: "cognee_forget", desc: "删除知识", group: "管理",
        schema: { dataset: { type: "string", description: "数据集名称", required: true }, name: { type: "string", description: "名称", required: false } },
        example: { dataset: "capital_v28" } },
      { name: "cognee_status", desc: "查看系统状态", group: "管理",
        schema: {}, example: {} }
    ]
  },
  {
    id: "marx-graphiti",
    name: "Graphiti 知识图谱",
    description: "实体级知识图谱（Neo4j 11001，12326 实体）。实体蒸馏 + 消歧 + 关系查询。",
    tools: [
      { name: "get_entity_info", desc: "查询实体详细信息", group: "检索",
        schema: { entity_name: { type: "string", description: "实体名", required: true } },
        example: { entity_name: "资本下乡" } },
      { name: "search_by_concept", desc: "按概念搜索实体", group: "检索",
        schema: { concept: { type: "string", description: "概念/主题词", required: true }, limit: { type: "number", description: "返回数量上限", required: false } },
        example: { concept: "农村集体经济", limit: 10 } },
      { name: "hybrid_search_entities", desc: "混合检索实体（向量+关键词）", group: "检索",
        schema: { query: { type: "string", description: "检索关键词/问题", required: true }, top_k: { type: "number", description: "返回数量", required: false } },
        example: { query: "土地流转制度", top_k: 5 } },
      { name: "run_cypher_read", desc: "执行 Cypher 查询（只读）", group: "检索",
        schema: { cypher: { type: "string", description: "Cypher 查询语句", required: true }, params: { type: "object", description: "查询参数", required: false } },
        example: { cypher: "MATCH (e:Entity) WHERE e.name CONTAINS $q RETURN e LIMIT 5", params: { q: "资本" } } },
      { name: "get_paper_info", desc: "查询论文信息", group: "检索",
        schema: { paper_title: { type: "string", description: "论文标题", required: false } },
        example: { paper_title: "资本下乡的村庄再造" } },
      { name: "get_relationships", desc: "查询实体关系", group: "检索",
        schema: { entity_name: { type: "string", description: "实体名", required: true } },
        example: { entity_name: "资本下乡" } },
      { name: "list_entities", desc: "列出实体", group: "检索",
        schema: { limit: { type: "number", description: "返回数量上限", required: false }, offset: { type: "number", description: "偏移量", required: false } },
        example: { limit: 20 } },
      { name: "add_episode", desc: "添加知识片段（事件）", group: "入库",
        schema: { content: { type: "string", description: "文档内容", required: true }, source: { type: "string", description: "来源", required: false } },
        example: { content: "某地资本下乡后集体经济增收", source: "论文X" } },
      { name: "resolve_entity", desc: "实体消歧（同名实体归一）", group: "入库",
        schema: { entity_name: { type: "string", description: "实体名", required: true } },
        example: { entity_name: "资本下乡" } },
      { name: "extract_entities", desc: "抽取实体", group: "入库",
        schema: { content: { type: "string", description: "文档内容", required: true } },
        example: { content: "工商资本进入农村后，村集体与企业的合作模式…" } },
      { name: "get_pipeline_status", desc: "查看入库管道状态", group: "管理",
        schema: {}, example: {} },
      { name: "get_distillation_status", desc: "查看蒸馏状态", group: "管理",
        schema: {}, example: {} },
      { name: "search_hyperedges", desc: "检索结构化超边(知识片段): 语义+实体+BM25三路RRF融合+时间衰减", group: "检索",
        schema: { query: { type: "string", description: "检索问题/关键词", required: true }, top_k: { type: "number", description: "返回数量上限", required: false }, entity_names: { type: "array", description: "限定参与实体", required: false }, htype: { type: "string", description: "类型过滤", required: false } },
        example: { query: "资本下乡对农村集体经济的影响机制", top_k: 8 } },
      { name: "get_hyperedge_info", desc: "查询超边详情(实体成员+来源论文)", group: "检索",
        schema: { hyperedge_id: { type: "string", description: "超边ID", required: false }, text_contains: { type: "string", description: "文本子串", required: false } },
        example: { text_contains: "资本下乡" } }
    ]
  },
  {
    id: "marx-graphiti-ingest",
    name: "Graphiti 入库监控",
    description: "Graphiti 批量入库 + 断点续传 + API 自愈。",
    tools: [
      { name: "ingest_papers", desc: "批量入库论文", group: "入库",
        schema: { folder: { type: "string", description: "文件夹路径", required: true }, batch_size: { type: "number", description: "批次大小", required: false } },
        example: { folder: "E:/文献库/资本治理", batch_size: 20 } },
      { name: "ingest_progress", desc: "查看入库进度", group: "入库",
        schema: {}, example: {} },
      { name: "ingest_retry", desc: "重试失败批次", group: "入库",
        schema: { batch_id: { type: "string", description: "批次 ID", required: false } },
        example: {} },
      { name: "ingest_checkpoint", desc: "断点续传检查", group: "入库",
        schema: {}, example: {} }
    ]
  },
  {
    id: "marx-cognee-ingest",
    name: "Cognee 批量入库",
    description: "Cognee 批量入库（30 篇/批 + 成本估算 + 完整性校验）。",
    tools: [
      { name: "batch_add", desc: "批量添加文档", group: "入库",
        schema: { folder: { type: "string", description: "文件夹路径", required: true }, batch_size: { type: "number", description: "批次大小", required: false } },
        example: { folder: "E:/文献库", batch_size: 30 } },
      { name: "batch_cognify", desc: "批量认知处理", group: "入库",
        schema: { dataset: { type: "string", description: "数据集名称", required: true } },
        example: { dataset: "capital_v28" } },
      { name: "batch_progress", desc: "批量入库进度", group: "入库",
        schema: {}, example: {} },
      { name: "batch_cost", desc: "批次成本估算", group: "入库",
        schema: { papers: { type: "number", description: "论文数量", required: true } },
        example: { papers: 100 } }
    ]
  },
  {
    id: "sciverse",
    name: "Sciverse 外部学术检索",
    description: "OpenDataLab 外部学术检索（5.16 亿知识记录）。",
    tools: [
      { name: "search_papers", desc: "结构化元数据检索（按作者/年份/期刊/学科过滤）", group: "检索",
        schema: { query: { type: "string", description: "检索关键词/问题", required: false }, year_from: { type: "number", description: "起始年份", required: false }, language: { type: "string", description: "语言(en/zh)", required: false }, page_size: { type: "number", description: "每页数量", required: false } },
        example: { query: "资本下乡", year_from: 2020, page_size: 10 } },
      { name: "semantic_search", desc: "自然语言语义检索（返回可引用段落）", group: "检索",
        schema: { query: { type: "string", description: "检索关键词/问题", required: true }, top_k: { type: "number", description: "返回数量", required: false } },
        example: { query: "rural land transfer China", top_k: 5 } },
      { name: "list_catalog", desc: "查看字段目录（防幻觉）", group: "检索",
        schema: { collection: { type: "string", description: "参数", required: false } },
        example: { collection: "papers" } },
      { name: "list_paper_relations", desc: "引文/参考文献/相关工作分页", group: "检索",
        schema: { unique_id: { type: "string", description: "论文唯一 ID", required: true }, relation: { type: "string", description: "关系类型(REFERENCES/CITATIONS/RELATED_WORKS)", required: true }, page_size: { type: "number", description: "每页数量", required: false } },
        example: { unique_id: "abc123", relation: "REFERENCES", page_size: 20 } },
      { name: "read_content", desc: "字节区间读取原文", group: "检索",
        schema: { doc_id: { type: "string", description: "文档 ID", required: true }, offset: { type: "number", description: "偏移量", required: false }, limit: { type: "number", description: "返回数量上限", required: false } },
        example: { doc_id: "doc123", limit: 8192 } },
      { name: "get_resource", desc: "获取图表图片", group: "检索",
        schema: { file_name: { type: "string", description: "文件路径", required: true } },
        example: { file_name: "figure1.png" } }
    ]
  },
  {
    id: "gov-cn-policy",
    name: "中国政府网政策检索",
    description: "国务院政策全文检索（gov.cn 官方接口）。",
    tools: [
      { name: "get_latest_policies", desc: "按关键词/日期检索政策列表", group: "检索",
        schema: { keyword: { type: "string", description: "检索关键词", required: true }, startdate: { type: "string", description: "起始日期 YYYY-MM-DD", required: false }, enddate: { type: "string", description: "结束日期 YYYY-MM-DD", required: false }, limit: { type: "number", description: "返回数量上限", required: false } },
        example: { keyword: "土地流转", limit: 5 } },
      { name: "get_policy_fulltext", desc: "抓取政策正文全文", group: "检索",
        schema: { url: { type: "string", description: "原文 URL", required: true } },
        example: { url: "https://www.gov.cn/zhengce/zhengceku/202606/content_7070902.htm" } }
    ]
  }
];

export function getAllMcpTools() {
  // SAG 4 个工具用真实 schema（从 mcp-settings-service 拿完整 JSON Schema）
  const sagReal = getPublicMcpSettings();
  const sagTools = sagReal.tools.map((t) => ({
    name: t.name,
    desc: t.description,
    group: t.name.includes("ingest") ? "入库" : "检索",
    schema: t.inputSchema as Record<string, { type: string; description: string; required?: boolean }>,
    example: t.example as Record<string, unknown>
  }));

  const servers = MCP_TOOL_CATALOG.map((s) => ({
    serverId: s.id,
    serverName: s.name,
    description: s.description,
    tools: s.tools.map((t) => t.name),
    toolDescriptions: s.id === "sag" ? sagTools : s.tools,
    connected: true
  }));
  const total = servers.reduce((sum, s) => sum + s.tools.length, 0);
  return { servers, total };
}

// ─── 动态连接状态：检测真实在工作的 MCP server ───
import net from "node:net";
import { getPublicMcpSettings } from "./mcp-settings-service.js";

function probePort(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port, timeout: timeoutMs });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

export async function getMcpConnectionStatus(): Promise<Record<string, boolean>> {
  const [cognee, graphiti] = await Promise.all([
    probePort(11003),
    probePort(11001)
  ]);
  return {
    "sag": true,  // SAG 服务本身在跑（后端在线即可用）
    "marx-cognee": cognee,
    "marx-graphiti": graphiti,
    "marx-cognee-ingest": cognee,
    "marx-graphiti-ingest": graphiti,
    "sciverse": true,
    "gov-cn-policy": true
  };
}
