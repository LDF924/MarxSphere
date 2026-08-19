// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// memory-eval-gold.ts — 记忆量化评测集（V377, ⑦）
// 20 条真实场景记忆：写入 OpenViking → 用检索词测 recall@k → 算命中率
// 每项: 写入内容(含唯一语义短语) + 检索词(应能召回) + 判定短语(召回结果应包含)
export interface MemoryEvalItem {
  id: string;
  category: "user" | "session" | "entity";
  content: string;      // 写入的记忆内容
  query: string;        // 应能召回该条的检索词
  phrase: string;       // 判定短语（召回结果包含=命中；OpenViking 抽取会提炼，用语义短语不用标记）
}

export const MEMORY_EVAL_GOLD: MemoryEvalItem[] = [
  // ── 用户侧（偏好/约束/项目）──
  { id: "M01", category: "user", content: "用户偏好使用案例分析而非纯理论推演，重视实证证据与田野调查", query: "案例分析 实证证据 研究方法偏好", phrase: "实证" },
  { id: "M02", category: "user", content: "用户要求回答简明扼要，控制篇幅", query: "回答 简明 篇幅", phrase: "简明" },
  { id: "M03", category: "user", content: "用户正在研究'资本下乡与乡村治理'课题，关注权力结构", query: "资本下乡 乡村治理 课题", phrase: "资本下乡" },
  { id: "M04", category: "user", content: "用户偏好输出格式：先结论后论据，引用标注来源", query: "输出格式 引用标注", phrase: "引用" },
  { id: "M05", category: "user", content: "用户自称'老马'，希望被这样称呼", query: "老马 称呼", phrase: "老马" },
  // ── 会话侧（结论/决策/约定）──
  { id: "M06", category: "session", content: "会话确认资本下乡存在'产业带动与治理重构'双重效应", query: "资本下乡 双重效应", phrase: "双重效应" },
  { id: "M07", category: "session", content: "会话决定采用案例研究法研究土地流转，放弃计量方法", query: "案例研究法 土地流转", phrase: "案例" },
  { id: "M08", category: "session", content: "与用户约定术语'平台型资本'指代电商平台下乡", query: "平台型资本 约定", phrase: "平台" },
  { id: "M09", category: "session", content: "集体资产股权量化规则：按股分红保留集体积累", query: "集体资产 股权量化", phrase: "股权" },
  { id: "M10", category: "session", content: "RAG评测使用top_k=15和相似度0.4的配置参数", query: "RAG评测 配置参数", phrase: "RAG" },
  // ── 实体侧（组件/路径/解读）──
  { id: "M11", category: "entity", content: "sag-mcp-server是MarxSphere的MCP接入组件，端口4173", query: "sag-mcp-server MCP接入", phrase: "MCP" },
  { id: "M12", category: "entity", content: "ov_import目录存放500篇论文原始文件", query: "ov_import 论文目录", phrase: "ov_import" },
  { id: "M13", category: "entity", content: "用户个人解读：'异化'在本文中指资本对人的控制", query: "异化 个人解读", phrase: "异化" },
  { id: "M14", category: "entity", content: "openviking_data是OpenViking的数据存储目录", query: "openviking_data 数据目录", phrase: "openviking" },
  { id: "M15", category: "entity", content: "用户自定义变量'cap_rate'指资本下乡覆盖率", query: "cap_rate 变量", phrase: "cap_rate" },
  // ── 更多 ──
  { id: "M16", category: "user", content: "用户喜欢分点回答，每点加粗标题", query: "分点回答 格式", phrase: "分点" },
  { id: "M17", category: "user", content: "用户要求禁用'显而易见''众所周知'等绝对化表述", query: "禁用 绝对化表述", phrase: "绝对" },
  { id: "M18", category: "session", content: "平台经济扩张导致资本向少数平台集中", query: "平台经济 资本集中", phrase: "平台" },
  { id: "M19", category: "session", content: "查询'土地流转价格'返回37条结果", query: "土地流转价格 查询", phrase: "土地流转" },
  { id: "M20", category: "entity", content: "用户对'市民社会'的理解是物质生活关系总和", query: "市民社会 理解", phrase: "市民社会" },
];
