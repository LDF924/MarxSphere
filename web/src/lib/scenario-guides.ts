// scenario-guides.ts — 35 个科研场景的研究开展步骤指南（V256）
// 每个场景：目标 + 5-8 步研究流程（每步标注使用工具 + 操作指引）
// 引导用户如何利用 MarxSphere 真实工具完成该场景研究
import type { ScenarioGuide } from "../components/ScenariosWorkbench";

export const SCENARIO_GUIDES: ScenarioGuide[] = [
  // ═══ 一、选题构思 ═══
  {
    id: "S01",
    title: "研究方向生成",
    group: "选题构思",
    goal: "从兴趣/领域热点出发，生成候选研究方向并评估可行性，确定研究选题",
    steps: [
      { title: "梳理兴趣与领域背景", desc: "明确感兴趣的研究领域和大致方向", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台输入领域相关问题（如「资本下乡领域近年的研究热点有哪些」），让 52 步推理链先给你一个领域全景概览。" },
      { title: "生成候选研究方向", desc: "用研究创意生成技能发散候选方向", tool: "skills", toolLabel: "技能库 · research-ideation", how: "打开技能库，找到「research-ideation 研究创意生成」技能（或直接用技能触发词），让 AI 基于你的兴趣生成 5-10 个候选研究方向。" },
      { title: "评估方向价值", desc: "用五维框架评估每个方向的科研价值", tool: "skills", toolLabel: "技能库 · idea-evaluator", how: "在技能库调用「idea-evaluator 想法评估」技能，对每个候选方向做五维评估（新颖性/影响力/可行性/成本/广度），拿到评审式结论。" },
      { title: "查证领域现状", desc: "确认候选方向的文献基础和竞争情况", tool: "ask", toolLabel: "Ask 检索", how: "用 Ask 检索每个候选方向的核心问题（如「方向A 已有研究进展」），看检索到的文献数量和内容判断该方向是空白还是红海。" },
      { title: "交叉验证选题", desc: "用推理链验证选题的研究价值", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台提交「这个选题值得研究吗？已有研究有哪些缺口？」完整推理一次，综合评估结果确定最终选题。" },
      { title: "沉淀选题笔记", desc: "把选题依据沉淀到知识页", tool: "truth", toolLabel: "知识页", how: "在知识页新建页面记录选题依据（方向背景/候选评估/选定理由），把推理结论写入 Compiled Truth，形成选题档案。" }
    ]
  },
  {
    id: "S02",
    title: "科学头脑风暴",
    group: "选题构思",
    goal: "多角度发散讨论研究问题，挑战假设，形成创新思路",
    steps: [
      { title: "定义核心问题", desc: "明确要头脑风暴的研究问题", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台把研究问题拆解清楚，让 52 步链路先给出问题的多维框架（是什么/为什么/怎么办/谁/何时）。" },
      { title: "多视角发散", desc: "用科学头脑风暴技能多角度展开", tool: "skills", toolLabel: "技能库 · scientific-brainstorming", how: "打开技能库调用「scientific-brainstorming 科学头脑风暴」技能，按技能引导从不同理论视角/方法论/反方立场发散观点。" },
      { title: "批判性质疑", desc: "对每个观点做批判性检验", tool: "skills", toolLabel: "技能库 · scientific-critical-thinking", how: "用「scientific-critical-thinking 科学批判思维」技能，对头脑风暴产出的每个观点做逻辑检验（证据充分吗/假设成立吗/有无反例）。" },
      { title: "检索佐证", desc: "用检索验证观点是否有文献支撑", tool: "ask", toolLabel: "Ask 检索", how: "把头脑风暴产生的关键观点逐个用 Ask 检索，看文献里有没有支持或反驳的证据，标记有支撑的和纯假设的。" },
      { title: "收敛成研究假设", desc: "把有效的观点收敛为可检验的假设", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台提交「综合以上讨论，形成 3-5 个可检验的研究假设」，让推理链基于检索证据收敛出有依据的假设。" },
      { title: "沉淀讨论记录", desc: "把头脑风暴过程和结论存到知识页", tool: "truth", toolLabel: "知识页", how: "在知识页新建页面记录头脑风暴全过程（发散观点/质疑记录/收敛假设），作为后续研究的原始素材。" }
    ]
  },
  {
    id: "S03",
    title: "研究设计规划",
    group: "选题构思",
    goal: "为选定研究问题设计实验方案：分组、样本量、方法、因果识别策略",
    steps: [
      { title: "明确研究问题与假设", desc: "把研究问题操作化为可检验的假设", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台提交研究问题，让推理链帮你把问题拆解为可操作化的变量关系（自变量/因变量/控制变量）。" },
      { title: "选择研究设计", desc: "用实验设计技能确定设计类型", tool: "skills", toolLabel: "技能库 · experimental-design", how: "调用「experimental-design 实验设计」技能，根据研究问题选择设计类型（随机对照/准实验/断点/自然实验），并说明每类设计的适用条件。" },
      { title: "计算样本量", desc: "用功效分析确定所需样本量", tool: "skills", toolLabel: "技能库 · statistical-power", how: "用「statistical-power 统计功效」技能输入预期效应量、显著性水平、检验力，计算所需样本量，确认数据可得性。" },
      { title: "制定因果识别策略", desc: "确定如何识别因果关系而非相关", tool: "skills", toolLabel: "技能库 · 因果推断", how: "调用「10-Jill0099 因果推断 Mixtape」技能，根据数据条件选择因果识别策略（DID/IV/RDD/合成控制），理解每种策略的识别假设。" },
      { title: "预注册研究方案", desc: "把研究设计写成预注册文档", tool: "skills", toolLabel: "技能库 · research-proposal", how: "用「research-proposal 研究计划书」技能把研究设计整理成规范文档（背景/假设/方法/样本/分析计划），供预注册或开题使用。" },
      { title: "沉淀设计文档", desc: "把研究设计存入知识页", tool: "truth", toolLabel: "知识页", how: "在知识页新建页面存放研究设计文档，把设计决策和理由写入时间线，供后续实施对照。" }
    ]
  },
  {
    id: "S04",
    title: "开题报告规划",
    group: "选题构思",
    goal: "生成结构化开题报告：研究问题、文献基础、方法设计、进度安排",
    steps: [
      { title: "文献查全", desc: "把选题方向近 N 年文献查全", tool: "literature", toolLabel: "文献库 · lit-search", how: "用「lit-search 文献检索」技能对选题关键词做时间窗全量检索（建议近 5-10 年），拿到完整文献清单，记录查全率和金标召回。" },
      { title: "梳理文献脉络", desc: "按主题/方法/时间梳理文献综述", tool: "literature", toolLabel: "文献库", how: "在文献库用主题/年份筛选浏览查到的文献，阅读摘要和问答，梳理该领域的研究脉络、主要流派和争论焦点。" },
      { title: "定位研究缺口", desc: "从文献综述中找到研究空白", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台提交「基于以上文献，该领域还有哪些研究缺口？」，让推理链综合检索证据给出缺口分析。" },
      { title: "设计研究框架", desc: "确定研究问题/方法/创新点", tool: "skills", toolLabel: "技能库 · outline-agent", how: "用「outline-agent 大纲生成」技能基于文献缺口生成开题报告大纲（研究问题/文献综述/研究方法/创新点/进度）。" },
      { title: "撰写开题报告", desc: "把大纲扩展为完整开题报告", tool: "skills", toolLabel: "技能库 · research-proposal", how: "用「research-proposal 研究计划书」技能把大纲扩写为完整开题报告，含立项依据、研究内容、技术路线、进度安排、预期成果。" },
      { title: "开题预演评审", desc: "模拟专家评审检验开题质量", tool: "skills", toolLabel: "技能库 · academic-paper-reviewer", how: "用「academic-paper-reviewer 学术评审」技能模拟评审专家对开题报告提意见，针对性修改后再正式开题。" }
    ]
  },

  // ═══ 二、文献调研 ═══
  {
    id: "S05",
    title: "文献综述",
    group: "文献调研",
    goal: "从研究问题出发，系统检索文献并综合生成带引用的综述",
    steps: [
      { title: "拆解综述问题", desc: "把综述主题拆解为子问题", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台输入综述主题（如「资本下乡对农村集体经济的影响」），推理链会生成大纲拆解（正面效应/负面风险/制度约束等子问题）。" },
      { title: "多路检索文献", desc: "用 52 步链路全库检索", tool: "reason", toolLabel: "推理工作台", how: "让推理链执行完整 52 步检索：Cognee 17 路粗检（HYBRID/RAG/图遍历/三元组/摘要等）+ Graphiti 精炼 + PG 全文 + 超边知识层，覆盖全部相关文献。" },
      { title: "提取关键论点", desc: "从检索结果提炼各派观点", tool: "ask", toolLabel: "Ask 检索", how: "对每个子问题单独用 Ask 检索（如「资本下乡的正面效应有哪些」），拿到带引用的证据片段，记录各派观点和出处。" },
      { title: "交叉验证结论", desc: "用多源证据交叉验证关键论断", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台提交「关于X问题，不同文献的观点是否一致？」，让推理链做多源交叉验证，标注共识与分歧。" },
      { title: "组织综述框架", desc: "按主题/时间线组织综述结构", tool: "skills", toolLabel: "技能库 · literature-review", how: "用「literature-review 文献综述」技能把收集的观点组织成结构化综述框架（引言/主流观点/争论焦点/研究缺口/结论）。" },
      { title: "生成综述全文", desc: "扩写为带引用的完整综述", tool: "skills", toolLabel: "技能库 · academic-paper", how: "用「academic-paper 学术论文」技能把框架扩写为完整综述，所有论断带 [来源] 引用标记，再跑一遍引用核验。" }
    ]
  },
  {
    id: "S06",
    title: "系统性文献检索",
    group: "文献调研",
    goal: "对研究主题做 SLR 级全量文献检索，保证查全率和可复现性",
    steps: [
      { title: "确定检索策略", desc: "定义检索词/时间窗/数据库", tool: "skills", toolLabel: "技能库 · lit-search", how: "用「lit-search 文献检索」技能定义检索策略：主题词+变体词、时间窗（建议近 N 年）、目标库（本地文献库+外部 Sciverse+知网）。" },
      { title: "本地库全量检索", desc: "在本地文献库查全主题文献", tool: "literature", toolLabel: "文献库", how: "在文献库用主题/关键词检索本地已入库的 500 篇研究文献（每篇含 original.md/摘要.md/术语表.md/问答.md/index.md/信息.md），按年份浏览确认覆盖度，标记核心文献。" },
      { title: "外部库补充检索", desc: "用 Sciverse 查外部权威文献", tool: "sciverse", toolLabel: "外部检索", how: "在外部检索用语义检索/结构化检索查 OpenAlex、CORE 等源，按年份/语言过滤，补充本地库没有的文献。" },
      { title: "知网引文网络", desc: "用引文网络滚雪球补漏", tool: "sciverse", toolLabel: "外部检索 · 知网引文", how: "对核心文献用知网引文网络抓取参考文献/引证文献/共引文献，沿引文关系滚雪球，把遗漏的关键文献补进来。" },
      { title: "评估查全率", desc: "用金标召回率检验检索完整性", tool: "skills", toolLabel: "技能库 · lit-search", how: "用 lit-search 的金标集（人工确认的核心文献）计算召回率，低于阈值就调整检索词补检，直到查全。" },
      { title: "导出文献清单", desc: "生成结构化文献清单", tool: "skills", toolLabel: "技能库 · citation-management", how: "用「citation-management 引用管理」技能把文献清单导出为 BibTeX/引用格式，标注每篇的检索来源和相关性，供综述使用。" }
    ]
  },
  {
    id: "S07",
    title: "外部学术检索",
    group: "文献调研",
    goal: "用 Sciverse 四工具（语义/结构化/引文/全文）检索外部权威学术资源",
    steps: [
      { title: "语义检索", desc: "用 RAG 语义检索找相关原文片段", tool: "sciverse", toolLabel: "外部检索 · 语义检索", how: "在外部检索选择「语义检索（RAG）」，输入研究问题，返回原文片段+相关度，快速定位最相关的论文内容。" },
      { title: "结构化过滤", desc: "用结构化检索精确筛选", tool: "sciverse", toolLabel: "外部检索 · 结构化检索", how: "切换到「结构化检索」，用年份/语言/作者等过滤条件精确筛选，如「2020-2024年中文文献」，缩小到目标范围。" },
      { title: "引文关系扩展", desc: "用引文关系滚雪球", tool: "sciverse", toolLabel: "外部检索 · 引文关系", how: "输入核心论文 unique_id 查引文关系（引证/被引/共引），沿引用链扩展，发现该领域的经典文献和最新研究。" },
      { title: "阅读全文", desc: "用 OA 全文读取关键论文", tool: "sciverse", toolLabel: "外部检索 · 读全文", how: "对高相关论文用「读全文」功能读取 OA 全文关键段落（按 doc_id+字节区间），确认核心观点和数据。" },
      { title: "沉淀检索结果", desc: "把外部证据关联到知识页", tool: "truth", toolLabel: "知识页", how: "外部检索会自动把结果沉淀为知识页证据（associateSearch），在知识页检查沉淀结果，补充笔记完善证据链。" },
      { title: "外部检索技能", desc: "用检索技能深度检索", tool: "skills", toolLabel: "技能库 · sciverse-zhs", how: "用「sciverse-zhs 哲社科学术检索」技能执行外部检索工作流（Sciverse→本地图谱交叉验证→证据引用），支持 OA 全文读取，与面板的语义/结构化检索互补。" },
    ]
  },
  {
    id: "S08",
    title: "研究证据包",
    group: "文献调研",
    goal: "把研究问题的关键命题、证据、出处沉淀为可复用的知识页",
    steps: [
      { title: "梳理关键命题", desc: "列出研究问题的核心命题", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台提交研究问题，从推理结论中提取 3-5 个关键命题（如「资本下乡具有双重效应」），每个命题要有明确表述。" },
      { title: "收集支撑证据", desc: "检索每个命题的证据", tool: "ask", toolLabel: "Ask 检索", how: "对每个命题单独用 Ask 检索（如「资本下乡双重效应的证据」），收集支撑的文献片段、数据和出处。" },
      { title: "整理证据时间线", desc: "把证据按时间顺序存入知识页", tool: "truth", toolLabel: "知识页", how: "在知识页打开目标页面，在证据时间线中添加笔记/证据条目，每条标注来源、时间和置信度，形成证据链。" },
      { title: "编制权威版本", desc: "用 Compiled Truth 汇总共识", tool: "truth", toolLabel: "知识页 · Compiled Truth", how: "在知识页点击「重写」用 Compiled Truth 机制把时间线证据综合为权威版本，先看 TruthDiff 差异预览再确认写入。" },
      { title: "矛盾检测", desc: "识别证据间的矛盾", tool: "truth", toolLabel: "知识页 · 矛盾", how: "在时间线添加「矛盾」类型条目记录冲突证据，用 Jobs 的 synthesize 任务扫描时间线矛盾，理解为什么会有分歧。" },
      { title: "Claude Code 归纳", desc: "用归纳桥做深度综合", tool: "truth", toolLabel: "知识页 · Claude Code 归纳桥", how: "点击「归纳桥」把页面+时间线打包交 Claude Code 做深度综合，结论可写回时间线或更新为最新理解。" }
    ]
  },
  {
    id: "S09",
    title: "论文对比矩阵",
    group: "文献调研",
    goal: "对比多篇论文的研究范式、数据来源、核心结论，定位差异",
    steps: [
      { title: "筛选对比文献", desc: "选定要对比的 2-5 篇论文", tool: "literature", toolLabel: "文献库", how: "在文献库按主题检索，筛选出要对比的 2-5 篇论文（建议同主题不同结论或不同方法的论文）。" },
      { title: "逐篇读摘要", desc: "阅读每篇的摘要和核心结论", tool: "literature", toolLabel: "文献库 · 摘要", how: "逐篇打开文献详情，阅读摘要、问答和术语表，记录每篇的研究问题、方法、数据来源、核心结论。" },
      { title: "对比研究范式", desc: "对比各篇的研究方法差异", tool: "literature", toolLabel: "文献库 · 对比", how: "横向对比各篇的研究范式（理论框架/实证方法/数据来源），整理成对比表，标注关键差异。" },
      { title: "定位结论分歧", desc: "找出各篇结论的分歧点", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台提交「这几篇论文结论为何不同？」让推理链分析分歧原因（方法差异/数据差异/视角差异），给出综合判断。" },
      { title: "沉淀对比结果", desc: "把对比矩阵存入知识页", tool: "truth", toolLabel: "知识页", how: "在知识页新建「论文对比矩阵」页面，把对比表和分歧分析写入，作为文献综述的核心素材。" },
      { title: "系统文献筛选", desc: "用检索技能确保对比文献全面", tool: "skills", toolLabel: "技能库 · lit-search", how: "用「lit-search 文献检索」技能对对比主题做系统性检索，确保纳入对比的 2-5 篇是代表性文献（查全+金标召回），避免遗漏关键对照。" },
    ]
  },
  {
    id: "S10",
    title: "引文溯源（Citation）",
    group: "文献调研",
    goal: "每个论断绑定真实出处，防幻觉、可核验",
    steps: [
      { title: "检索获取论断", desc: "用 Ask 检索获取带引用的回答", tool: "ask", toolLabel: "Ask 检索", how: "在 Ask 检索输入问题，回答中的每个论断会标注来源步骤（↑来源检索步骤），展示是哪路检索捞到的。" },
      { title: "查看来源溯源", desc: "点击来源标记查看溯源", tool: "ask", toolLabel: "Ask 检索 · 溯源", how: "在引用证据区点击每个论断的来源标记，查看它来自哪个检索算子（向量/关键词/Graphiti/Cognee/Compiled Truth），确认出处可信。" },
      { title: "回链原文", desc: "从检索片段回链到原文", tool: "literature", toolLabel: "文献库 · 原文", how: "把检索到的片段标题在文献库中定位，打开原文（original/摘要/问答），找到论断在原文中的完整上下文。" },
      { title: "超边溯源", desc: "用超边知识层验证跨论文论断", tool: "reason", toolLabel: "推理工作台 · 超边", how: "对跨论文的综合论断用推理工作台验证，超边知识层会标注来源论文/置信度/类型（因果/风险/对策），交叉验证论断。" },
      { title: "记录溯源结果", desc: "把可核验的论断存入知识页", tool: "truth", toolLabel: "知识页", how: "在知识页把通过溯源验证的论断写入证据时间线，每条标注来源和置信度，形成可引用的证据库。" },
      { title: "引文网络溯源", desc: "用引文网络技能扩展溯源", tool: "skills", toolLabel: "技能库 · traversing-citations", how: "用「traversing-citations 引文遍历」技能沿论断的引文关系扩展（参考文献/引证/共引），验证论断在引文网络中的位置，发现经典与前沿来源。" },
    ]
  },
  {
    id: "S11",
    title: "文献关系图谱",
    group: "文献调研",
    goal: "用知识图谱探索文献间的实体-事件关系网络",
    steps: [
      { title: "径向展开探索", desc: "用径向图谱看核心实体关系", tool: "graph", toolLabel: "知识图谱 · 径向", how: "在知识图谱选择径向展开视图，从核心实体（如「资本下乡」）出发逐层展开，看它连接的事件和实体网络。" },
      { title: "力导向分析", desc: "用 d3 力导向看网络结构", tool: "graph", toolLabel: "知识图谱 · 力导向", how: "切换到力导向视图，用斥力/连边距离/向心力滑杆调节布局，观察实体聚类和关键枢纽节点，识别研究网络的结构。" },
      { title: "关系查询", desc: "查询特定实体间的关系", tool: "graph", toolLabel: "知识图谱 · 关系查询", how: "在关系查询输入两个实体（如「资本」和「集体经济」），查询它们之间的路径和关系类型，理解实体如何关联。" },
      { title: "事件下钻", desc: "双击事件查看详情", tool: "graph", toolLabel: "知识图谱 · 事件", how: "在图谱中双击事件节点，进入事件详情（标题/摘要/来源论文/置信度），从图谱跳转到文献原文。" },
      { title: "建联补充", desc: "用快速建联补充关系", tool: "graph", toolLabel: "知识图谱 · 快速建联", how: "发现图谱缺的关系用「快速建联」直接建立三元组（实体-关系-实体），让图谱随研究持续生长。" },
      { title: "图谱检索辅助", desc: "用图谱技能做实体关系检索", tool: "skills", toolLabel: "技能库 · marx-graphiti", how: "用「marx-graphiti 图谱检索」技能对核心实体做跨论文关系检索（社区聚合/超边推理），补充图谱可视化之外的深层关系，交叉验证图谱结论。" },
    ]
  },
  {
    id: "S12",
    title: "政策文本检索",
    group: "文献调研",
    goal: "检索政策文件、法规条文，定位政策与研究的关联",
    steps: [
      { title: "检索政策文件", desc: "用 gov.cn 检索相关政策", tool: "policy", toolLabel: "政策库 · gov.cn 检索", how: "在政策库输入关键词（如「工商资本下乡」），从 gov.cn 检索政策文件，查看标题/日期/发文级别/摘要。" },
      { title: "存入政策库", desc: "把相关政策存入本地库", tool: "policy", toolLabel: "政策库 · 存入", how: "对检索到的相关政策点击「存入政策库」，加入本地课题政策库，按五维分类归档（核心法规/指导意见/地方政策等）。" },
      { title: "浏览政策树", desc: "浏览本地政策库目录", tool: "policy", toolLabel: "政策库 · 目录树", how: "在政策库的目录树中浏览课题政策文件（土地承包法/集体经济组织法/粮食安全法等），按分类找到目标政策。" },
      { title: "定位法规原文", desc: "打开政策原文定位条文", tool: "policy", toolLabel: "政策库 · 预览", how: "点击政策文件预览原文（md/PDF/图片内联），定位具体条款条文（如「土地承包法第45条」），记录条文内容。" },
      { title: "政策-研究关联", desc: "把政策与文献研究关联", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台提交「该政策对资本下乡的影响」类问题，推理链会把政策条文与文献研究交叉引用，形成政策-研究对照分析。" },
      { title: "政策简报技能", desc: "用政策简报技能沉淀解读", tool: "skills", toolLabel: "技能库 · policy-brief-writing", how: "用「policy-brief-writing 政策简报写作」技能把检索到的政策条文整理为结构化政策解读/简报（背景/核心条款/影响分析），沉淀到知识页供研究引用。" },
    ]
  },

  // ═══ 三、证据检索 ═══
  {
    id: "S13",
    title: "科学问答（RAG）",
    group: "证据检索",
    goal: "基于文献证据回答问题，每个论断都有出处可回链",
    steps: [
      { title: "输入研究问题", desc: "把要回答的问题输入 Ask", tool: "ask", toolLabel: "Ask 检索", how: "在 Ask 检索输入研究问题（如「资本下乡对农村集体经济的影响机制」），点击开始检索。" },
      { title: "观察检索链路", desc: "看 18 步检索流水线逐步执行", tool: "ask", toolLabel: "Ask 检索 · 18 步", how: "观察检索过程：向量化→别名消解→实体抽取→多臂召回→加权 RRF→Boost 链→LLM 重排，看每步的入/出数据量和 token 消耗。" },
      { title: "查看引用证据", desc: "查看答案的引用证据", tool: "ask", toolLabel: "Ask 检索 · 引用", how: "在引用证据区查看每条证据（来源论文/检索步骤/相关度），确认答案每个论断的出处，点开可看证据原文。" },
      { title: "溯源验证", desc: "验证关键论断的可信度", tool: "ask", toolLabel: "Ask 检索 · 溯源", how: "对关键论断点来源步骤标记，看它来自哪路检索（原文/Graphiti/Cognee/Compiled Truth），优先采信高置信来源。" },
      { title: "深化追问", desc: "对答案中的概念继续追问", tool: "ask", toolLabel: "Ask 检索 · 追问", how: "把答案中不明确的术语或概念继续输入 Ask 追问（如「双重效应具体指什么」），逐层深入理解。" },
      { title: "沉淀问答结论", desc: "把有价值的问答存入知识页", tool: "truth", toolLabel: "知识页", how: "Ask 会自动把检索证据关联到知识页，在知识页检查沉淀结果，补充笔记形成研究问答档案。" },
      { title: "深度问答扩展", desc: "用研究问答技能深化追问", tool: "skills", toolLabel: "技能库 · answering-research-questions", how: "对 Ask 回答中的关键问题用「answering-research-questions 研究问答」技能做系统性多步研究（搜索-评估-遍历-综合），获得比单次 RAG 更深的答案。" },
    ]
  },
  {
    id: "S14",
    title: "多跳推理链",
    group: "证据检索",
    goal: "用 52 步推理链路完成多跳因果推理：拆解→检索→推理→自评",
    steps: [
      { title: "输入推理问题", desc: "提交需要多跳推理的研究问题", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台输入研究问题（如「资本下乡如何影响农村集体经济的长期发展」），选择检索源组合（PG/Graphiti/Cognee 任意组合）。" },
      { title: "观察问题分类", desc: "看推理链如何分类问题", tool: "reason", toolLabel: "推理工作台 · 分类", how: "观察前 4 步：问题分类（概念/事实/多跳/政策）→意图识别→术语变体→拆分子问题，看推理链如何理解你的问题。" },
      { title: "粗检+精炼+超边", desc: "看三阶段检索执行", tool: "reason", toolLabel: "推理工作台 · 检索", how: "观察 52 步链路执行：Cognee 17 路粗检索→Graphiti 精炼→超边知识层检索，每步标注引擎/耗时/结果数/真实 token。" },
      { title: "查看推理链", desc: "点开步骤看公式/SQL/代码", tool: "reason", toolLabel: "推理工作台 · 展开", how: "点开任意已执行步骤，查看该步的真实实现（公式/SQL/代码），理解每个算子的实际逻辑。" },
      { title: "评估结论", desc: "看假设生成与自评", tool: "reason", toolLabel: "推理工作台 · 评估", how: "查看答案与证据区：推理假设（综合结论）、推理依据、综合评分（LLM Judge 的事实一致性校验），确认结论可信度。" },
      { title: "消融验证", desc: "用消融实验验证关键组件贡献", tool: "reason", toolLabel: "推理工作台 · 消融", how: "在消融实验区勾选算子（如关掉超边层）重新推理，对比命中变化，验证每个组件对结论的贡献。" },
      { title: "检索技能对照", desc: "用系统性检索交叉验证推理结论", tool: "skills", toolLabel: "技能库 · lit-search", how: "对推理链的结论用「lit-search 文献检索」技能做独立系统性检索，交叉验证结论是否有完整文献支撑，弥补推理检索的遗漏。" },
    ]
  },
  {
    id: "S15",
    title: "教学与科研答疑",
    group: "证据检索",
    goal: "基于文献证据通俗讲解概念，适合教学与学习",
    steps: [
      { title: "提出教学问题", desc: "输入要讲解的概念或问题", tool: "ask", toolLabel: "Ask 检索", how: "在 Ask 检索输入教学问题（如「什么是资本下乡」），Ask 会用意图识别理解问题类型，术语变体扩展找到相关概念。" },
      { title: "获取通俗解答", desc: "看基于证据的讲解", tool: "ask", toolLabel: "Ask 检索 · 回答", how: "查看带引用的回答，Ask 会把检索证据组织成通俗讲解，每个论断标注来源，适合直接用于教学。" },
      { title: "概念溯源", desc: "对核心概念做溯源", tool: "reason", toolLabel: "推理工作台", how: "对教学中的核心概念用推理工作台做深度溯源（如「资本下乡的学术定义演变」），拿到概念演变的完整脉络。" },
      { title: "生成教学材料", desc: "把问答组织成讲义", tool: "skills", toolLabel: "技能库 · paper-slide-deck", how: "用「paper-slide-deck 幻灯片」技能把问答内容组织成教学讲义/幻灯片，配可视化图表。" },
      { title: "配套练习题", desc: "基于文献生成练习题", tool: "skills", toolLabel: "技能库 · academic-paper", how: "让技能库的写作技能基于检索到的文献生成配套练习题（概念辨析/论述题），检验学生理解。" }
    ]
  },
  {
    id: "S16",
    title: "全文证据查找",
    group: "证据检索",
    goal: "从检索片段定位到原文完整段落，作为可引用证据",
    steps: [
      { title: "检索定位片段", desc: "用检索找到相关片段", tool: "ask", toolLabel: "Ask 检索", how: "在 Ask 检索输入问题，从引用证据区找到相关片段，记下片段标题（来源论文）。" },
      { title: "定位论文", desc: "在文献库找到该论文", tool: "literature", toolLabel: "文献库", how: "在文献库搜索片段标题对应的论文，打开详情页。" },
      { title: "查看原文", desc: "在原文中找到完整段落", tool: "literature", toolLabel: "文献库 · 原文", how: "在文献详情切换到「原文」视图，用关键词定位到完整段落，确认片段上下文和完整表述。" },
      { title: "对照摘要问答", desc: "用摘要/问答交叉验证", tool: "literature", toolLabel: "文献库 · 摘要/问答", how: "对照该论文的摘要、问答、术语表，确认段落观点的准确性和重要性，标注核心术语。" },
      { title: "引用存档", desc: "把完整段落存入证据库", tool: "truth", toolLabel: "知识页", how: "在知识页把完整段落+出处存入证据时间线，标注来源论文/页码/置信度，作为论文引用的原始素材。" },
      { title: "开放获取补全", desc: "用 OA 技能补全无法本地定位的原文", tool: "skills", toolLabel: "技能库 · finding-open-access-papers", how: "若本地文献库找不到片段对应的论文，用「finding-open-access-papers 开放获取检索」技能在 OA 资源中定位全文，补全证据链。" },
    ]
  },
  {
    id: "S17",
    title: "研究方向趋势扫描",
    group: "证据检索",
    goal: "按年份/主题/学者扫描研究趋势，追踪前沿",
    steps: [
      { title: "浏览年份分布", desc: "看主题文献的年份分布", tool: "literature", toolLabel: "文献库 · 年份", how: "在文献库按年份筛选浏览主题文献，看哪些年份研究密集、哪些年份有断层，判断领域发展阶段。" },
      { title: "主题演进追踪", desc: "看主题关键词的演变", tool: "literature", toolLabel: "文献库 · 主题", how: "按主题分类浏览文献，观察主题关键词的演变（如从「资本下乡」到「工商资本规范引导」），追踪研究热点迁移。" },
      { title: "学者产出分析", desc: "看核心学者的研究脉络", tool: "literature", toolLabel: "文献库 · 作者", how: "按作者筛选，看核心学者的发表年份和主题变化，识别领域领军人物和研究脉络。" },
      { title: "引文网络扫描", desc: "用引文关系看前沿", tool: "sciverse", toolLabel: "外部检索 · 引文", how: "用知网引文网络对核心文献扫描引证关系，看最新文献引用了哪些经典，识别研究前沿走向。" },
      { title: "趋势报告", desc: "把趋势分析沉淀为报告", tool: "skills", toolLabel: "技能库 · market-research-reports", how: "用「market-research-reports 市场研究」技能把趋势数据整理为报告（领域阶段/热点演变/前沿方向），供选题参考。" }
    ]
  },

  // ═══ 四、数据分析 ═══
  {
    id: "S18",
    title: "计量实证分析",
    group: "数据分析",
    goal: "用计量经济学方法完成实证分析：清洗→建模→稳健性→出版级输出",
    steps: [
      { title: "准备数据", desc: "整理数据并做描述统计", tool: "skills", toolLabel: "技能库 · 00.1-Python 实证", how: "用「00.1-Full-empirical-analysis-skill_Python」技能准备数据：导入/清洗/变量构建，生成 Table 1 描述统计表。" },
      { title: "基线建模", desc: "跑 M1-M6 渐进回归", tool: "skills", toolLabel: "技能库 · 实证分析", how: "用技能的标准流程跑基线模型：M1 无控制→逐步加控制变量→加固定效应，生成多列回归表，看核心系数稳定性。" },
      { title: "机制检验", desc: "检验作用机制", tool: "skills", toolLabel: "技能库 · 实证分析 · 机制", how: "用技能的机制分析模块检验作用路径（中介/调节），生成机制检验表，解释核心变量如何起作用。" },
      { title: "稳健性检验", desc: "跑稳健性电池", tool: "skills", toolLabel: "技能库 · 实证分析 · 稳健", how: "用技能的稳健性模块：替换变量/替换样本/工具变量/安慰剂检验等，验证结果是否稳健。" },
      { title: "异质性分析", desc: "做分组异质性检验", tool: "skills", toolLabel: "技能库 · 实证分析 · 异质", how: "按地区/规模/时间等分组做异质性分析，看效应在不同群体间的差异，生成分样本回归表。" },
      { title: "出版级输出", desc: "生成论文级表格和图表", tool: "skills", toolLabel: "技能库 · 实证分析 · 输出", how: "用技能的出版级输出模块生成论文格式表格（esttab/outreg2 风格）和事件研究/系数图，直接可插入论文。" }
    ]
  },
  {
    id: "S19",
    title: "因果推断",
    group: "数据分析",
    goal: "用因果推断方法识别因果关系：DID/IV/RDD/合成控制",
    steps: [
      { title: "明确识别策略", desc: "确定因果识别方法", tool: "skills", toolLabel: "技能库 · 10-Jill0099 Mixtape", how: "用「10-Jill0099-causal-inference-mixtape」技能了解各种因果方法（DID/事件研究/IV/RDD/合成控制），根据数据条件选择策略。" },
      { title: "平行趋势检验", desc: "检验 DID 前提假设", tool: "skills", toolLabel: "技能库 · Mixtape · DID", how: "用技能模板跑平行趋势检验（事件研究图），确认处理组和对照组在政策前趋势平行，看各期系数是否在 0 附近。" },
      { title: "DID 估计", desc: "跑双重差分估计", tool: "skills", toolLabel: "技能库 · Mixtape · DID", how: "用 DID 模板估计处理效应（交互项系数），输出标准误（聚类稳健），解读核心结果。" },
      { title: "Bacon 分解", desc: "做交错 DID 诊断", tool: "skills", toolLabel: "技能库 · Mixtape · Bacon", how: "用 bacondecomp 检查交错 DID 的权重分解，确认估计是否被坏对照组污染，必要时改用异质稳健估计量。" },
      { title: "安慰剂检验", desc: "做随机化安慰剂检验", tool: "skills", toolLabel: "技能库 · Mixtape · 安慰剂", how: "用随机化推断（随机分配处理时间）做安慰剂检验，看随机安慰剂分布与真实估计的位置，确认结果非偶然。" },
      { title: "稳健性验证", desc: "交叉验证因果结论", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台提交「该因果结论是否成立？有哪些替代解释？」，用文献证据交叉验证因果推断结论的可靠性。" }
    ]
  },
  {
    id: "S20",
    title: "宏观经济建模",
    group: "数据分析",
    goal: "用 DSGE/HANK 模型做宏观经济学数值计算",
    steps: [
      { title: "搭建模型框架", desc: "定义模型结构和参数", tool: "skills", toolLabel: "技能库 · 20-wenddymacro", how: "用「20-wenddymacro-python-econ-skill」技能定义模型：效用函数/约束/均衡条件，搭建 DSGE 或 HANK 模型框架。" },
      { title: "数值求解", desc: "求解模型均衡", tool: "skills", toolLabel: "技能库 · 20-wenddymacro · 求解", how: "用技能提供的求解器（投影法/扰动法/全局法）求解模型稳态和动态均衡，检查收敛性。" },
      { title: "脉冲响应", desc: "做政策冲击模拟", tool: "skills", toolLabel: "技能库 · 20-wenddymacro · IRF", how: "对模型施加政策冲击（货币政策/财政政策），生成脉冲响应函数，分析变量动态调整路径。" },
      { title: "模型校准", desc: "校准参数匹配现实", tool: "skills", toolLabel: "技能库 · 20-wenddymacro · 校准", how: "用现实数据校准模型参数（稳态匹配/矩匹配），让模型数值与现实经济数据一致。" },
      { title: "结果可视化", desc: "生成模型结果图表", tool: "skills", toolLabel: "技能库 · 可视化", how: "用 scientific-visualization 技能把模型结果（IRF/稳态对比）做成论文级图表。" }
    ]
  },
  {
    id: "S21",
    title: "统计推断与检验",
    group: "数据分析",
    goal: "完成描述统计、诊断检验、生存分析等统计任务",
    steps: [
      { title: "描述统计", desc: "生成数据描述统计表", tool: "skills", toolLabel: "技能库 · nature-statistics", how: "用「nature-statistics 统计」技能对数据做描述统计：均值/中位数/标准差/分位数，生成统计表。" },
      { title: "分布诊断", desc: "做正态性和异方差检验", tool: "skills", toolLabel: "技能库 · 统计 · 诊断", how: "用技能做分布诊断：Shapiro-Wilk 正态检验、Breusch-Pagan 异方差检验、VIF 多重共线性，判断数据是否满足模型假设。" },
      { title: "相关与差异检验", desc: "做相关分析和组间差异检验", tool: "skills", toolLabel: "技能库 · 统计 · 检验", how: "用技能做 t 检验/卡方检验/方差分析，检验组间差异显著性；做相关分析（Pearson/Spearman）看变量关系。" },
      { title: "生存分析", desc: "做 KM 曲线和 Cox 回归", tool: "skills", toolLabel: "技能库 · 统计 · 生存", how: "对时间-事件数据做 Kaplan-Meier 生存曲线和 Cox 比例风险回归，估计风险比（HR）。" },
      { title: "结果报告", desc: "把统计结果整理成报告", tool: "skills", toolLabel: "技能库 · 统计 · 输出", how: "用技能的输出模块生成统计报告（含表格/图表/解读），直接用于论文方法部分。" }
    ]
  },

  // ═══ 五、论文写作 ═══
  {
    id: "S22",
    title: "学术论文写作",
    group: "论文写作",
    goal: "用 12 智能体流水线完成论文：研究→写作→评审→修订→定稿",
    steps: [
      { title: "启动写作流水线", desc: "用 academic-pipeline 启动全流程", tool: "skills", toolLabel: "技能库 · academic-pipeline", how: "在技能库调用「academic-pipeline」技能，输入研究主题和已有材料，它会编排研究→写作→评审→修订→定稿的 10 阶段流程。" },
      { title: "深度研究", desc: "先跑研究阶段", tool: "skills", toolLabel: "技能库 · deep-research", how: "流水线会先调用 deep-research 做深度研究（13 智能体团队），生成研究问题和文献基础，确认研究问题表述。" },
      { title: "论文写作", desc: "生成论文初稿", tool: "skills", toolLabel: "技能库 · academic-paper", how: "用「academic-paper」技能（11 模式）生成论文：大纲→摘要→引言→正文，选择论文类型和引用格式（GB/T 7714/APA 等）。" },
      { title: "完整性校验", desc: "检查论文完整性", tool: "skills", toolLabel: "技能库 · academic-paper · 完整性", how: "流水线强制做完整性校验：引用核验/结构完整/图表编号/致谢披露，确保无幻觉引用。" },
      { title: "模拟评审", desc: "用 5 视角评审论文", tool: "skills", toolLabel: "技能库 · academic-paper-reviewer", how: "用「academic-paper-reviewer」技能模拟 5 位评审（期刊适配+3 同行+魔鬼代言人）审稿，收集修改意见。" },
      { title: "修订定稿", desc: "按评审意见修订", tool: "skills", toolLabel: "技能库 · content-refinement-agent", how: "用「content-refinement-agent」技能按评审意见迭代修订（模拟评审→修订→复评），直到达到接受标准，输出 LaTeX/DOCX/PDF。" }
    ]
  },
  {
    id: "S23",
    title: "文献综述写作",
    group: "论文写作",
    goal: "写系统性文献综述：检索→阅读→综合→写作",
    steps: [
      { title: "检索文献", desc: "系统检索主题文献", tool: "literature", toolLabel: "文献库 · lit-search", how: "用「lit-search」技能做主题文献查全检索（时间窗/多源/金标召回），拿到完整文献池。" },
      { title: "阅读提炼", desc: "阅读文献提炼观点", tool: "literature", toolLabel: "文献库", how: "在文献库逐篇阅读摘要/问答/术语表，提炼每篇的核心观点、方法和结论，记录到笔记。" },
      { title: "组织综述结构", desc: "规划综述框架", tool: "skills", toolLabel: "技能库 · literature-review", how: "用「literature-review」技能组织综述结构：主题脉络/主流观点/争论焦点/研究缺口，规划各章节内容。" },
      { title: "写作综述", desc: "生成综述初稿", tool: "skills", toolLabel: "技能库 · section-writing-agent", how: "用「section-writing-agent」技能逐章节写作综述，所有论断带 [来源] 引用标注，确保可溯源。" },
      { title: "引用核验", desc: "核验所有引用的真实性", tool: "skills", toolLabel: "技能库 · citation-verification", how: "用「citation-verification」技能核验每个引用的真实性（DOI/标题/作者匹配），防幻觉引用。" },
      { title: "格式化输出", desc: "生成最终综述文档", tool: "skills", toolLabel: "技能库 · academic-paper", how: "用「academic-paper」技能把综述格式化为论文标准格式（标题/摘要/参考文献），输出 LaTeX/DOCX/PDF。" }
    ]
  },
  {
    id: "S24",
    title: "论文润色与改写",
    group: "论文写作",
    goal: "学术润色：语体校准、中英互译、逻辑优化",
    steps: [
      { title: "上传稿件", desc: "把论文初稿提供给润色技能", tool: "skills", toolLabel: "技能库 · paper-polish", how: "在技能库调用「paper-polish 论文润色」技能，粘贴或上传论文段落/全文，说明润色要求（学术语体/简洁/逻辑）。" },
      { title: "语体校准", desc: "校准学术写作语体", tool: "skills", toolLabel: "技能库 · paper-polish · 语体", how: "让技能校准学术语体：去除口语化表达、统一术语、优化句式结构，保持学术严谨性。" },
      { title: "中英润色", desc: "中英互译润色", tool: "skills", toolLabel: "技能库 · nature-polishing", how: "用「nature-polishing」技能做中英文学术润色（中文版/英文版），确保两种语言版本的学术质量。" },
      { title: "逻辑优化", desc: "优化论证逻辑", tool: "skills", toolLabel: "技能库 · 润色 · 逻辑", how: "让技能检查论证逻辑：段落衔接、论点-论据匹配、结论呼应，优化整体逻辑连贯性。" },
      { title: "对比确认", desc: "确认润色不改变原意", tool: "literature", toolLabel: "文献库 · 原文对照", how: "把润色后的关键论断与文献库原文对照，确认润色没有改变学术含义，保留原意。" }
    ]
  },
  {
    id: "S25",
    title: "引用管理",
    group: "论文写作",
    goal: "生成 BibTeX、核验引用、防幻觉引用",
    steps: [
      { title: "收集文献元数据", desc: "从文献库收集引用信息", tool: "literature", toolLabel: "文献库", how: "在文献库浏览要引用的文献，记录每篇的标题/作者/年份/期刊/DOI 等元数据。" },
      { title: "生成 BibTeX", desc: "生成 BibTeX 条目", tool: "skills", toolLabel: "技能库 · citation-management", how: "用「citation-management 引用管理」技能为每篇文献生成 BibTeX 条目（自动查 OpenAlex/PubMed 元数据），导出 .bib 文件。" },
      { title: "核验引用", desc: "核验引用的真实性", tool: "skills", toolLabel: "技能库 · citation-verification", how: "用「citation-verification 引用核验」技能逐条核验：DOI 有效/标题匹配/作者正确/年份一致，标记可疑引用。" },
      { title: "格式转换", desc: "转换引用格式", tool: "skills", toolLabel: "技能库 · 引用 · 格式", how: "用技能把 BibTeX 转换为目标格式（GB/T 7714/APA/Vancouver 等），确保符合投稿期刊要求。" },
      { title: "全库核对", desc: "全文引用一致性检查", tool: "skills", toolLabel: "技能库 · citation-check", how: "用 academic-paper 的 citation-check 模式核对全文引用：文中引用与参考文献列表一一对应，无遗漏无多余。" }
    ]
  },

  // ═══ 六、图表制作 ═══
  {
    id: "S26",
    title: "科研图表设计",
    group: "图表制作",
    goal: "设计论文三图：动机图、方法图、结果图",
    steps: [
      { title: "规划图表体系", desc: "确定论文需要的图表", tool: "skills", toolLabel: "技能库 · figure-designer", how: "用「figure-designer 图表设计」技能规划论文三图：Figure1 动机图/Figure2 方法图/Figure3 结果图，确定每图的呈现范式。" },
      { title: "设计动机图", desc: "画研究动机示意图", tool: "skills", toolLabel: "技能库 · figure-designer · F1", how: "用技能的图1范式（问题图示/对比图）设计动机图，突出研究问题和现有局限，配图和标注。" },
      { title: "设计方法图", desc: "画方法流程图", tool: "skills", toolLabel: "技能库 · figure-designer · F2", how: "用方法图范式设计系统架构/流程示意图（推荐 drawio/figma 输出），标注关键组件和数据流。" },
      { title: "设计结果图", desc: "画实验结果图", tool: "skills", toolLabel: "技能库 · figure-designer · F3", how: "用结果图范式设计对比图/消融图/曲线图，选择正确的图表类型呈现实验结论。" },
      { title: "QC 审计", desc: "图表质量审计", tool: "skills", toolLabel: "技能库 · figure-designer · QC", how: "用技能的 QC 审计模块检查图表：标签清晰/坐标规范/配色统一/尺寸符合期刊要求，输出最终图件。" }
    ]
  },
  {
    id: "S27",
    title: "可视化与幻灯片",
    group: "图表制作",
    goal: "数据可视化 + 学术汇报 PPT 制作",
    steps: [
      { title: "数据可视化", desc: "把数据做成图表", tool: "skills", toolLabel: "技能库 · scientific-visualization", how: "用「scientific-visualization 科学可视化」技能把数据/结果做成出版级图表（matplotlib/plotly 等），统一配色风格。" },
      { title: "规划幻灯片", desc: "规划汇报结构", tool: "skills", toolLabel: "技能库 · scholar-slides", how: "用「scholar-slides 学术幻灯片」技能规划汇报结构：标题页→研究背景→方法→结果→讨论→结论。" },
      { title: "生成幻灯片", desc: "生成幻灯片文件", tool: "skills", toolLabel: "技能库 · 幻灯片 · 输出", how: "用技能生成学术幻灯片（PPTX/HTML），每页含图表+要点，突出研究贡献。" },
      { title: "汇报练习", desc: "准备汇报讲稿", tool: "skills", toolLabel: "技能库 · 幻灯片 · 讲稿", how: "让技能为每页生成讲稿要点和过渡语，准备问答环节的常见问题应对。" },
      { title: "海报制作", desc: "制作学术海报", tool: "skills", toolLabel: "技能库 · scientific-schematics", how: "用「scientific-schematics 科学示意图」技能制作学术海报（标题/图表/结论布局），适合会议展示。" }
    ]
  },

  // ═══ 七、评审发表 ═══
  {
    id: "S28",
    title: "同行评审模拟",
    group: "评审发表",
    goal: "模拟 5 视角评审（期刊适配+3 同行+魔鬼代言人），提前发现论文问题",
    steps: [
      { title: "提交论文", desc: "把论文交给评审系统", tool: "skills", toolLabel: "技能库 · academic-paper-reviewer", how: "在技能库调用「academic-paper-reviewer 学术评审」技能，粘贴论文全文或关键章节，选择评审模式（full/快速/方法论聚焦）。" },
      { title: "期刊适配评审", desc: "看期刊适配度评估", tool: "skills", toolLabel: "技能库 · 评审 · 适配", how: "查看期刊适配评审：论文与目标期刊的匹配度、贡献度评估，判断投哪个期刊合适。" },
      { title: "同行评审意见", desc: "看 3 位同行意见", tool: "skills", toolLabel: "技能库 · 评审 · 同行", how: "查看 3 位模拟同行的评审意见（研究设计/方法/写作/贡献各维度打分），收集改进建议。" },
      { title: "魔鬼代言人", desc: "看最尖锐的质疑", tool: "skills", toolLabel: "技能库 · 评审 · 魔鬼", how: "查看魔鬼代言人的尖锐质疑（论文最脆弱的地方/最可能被拒的理由），提前准备应对。" },
      { title: "修改论文", desc: "按评审意见修订", tool: "skills", toolLabel: "技能库 · content-refinement", how: "把评审意见汇总，用「content-refinement-agent」按意见迭代修订论文，消除评审指出的问题。" },
      { title: "复评验证", desc: "修改后再评审验证", tool: "skills", toolLabel: "技能库 · 评审 · 复评", how: "修改后重新跑一遍评审（re-review 模式），验证问题是否解决，直到评审通过。" }
    ]
  },
  {
    id: "S29",
    title: "投稿前检查",
    group: "评审发表",
    goal: "投稿前完整检查：预提交清单、完整性审计、伦理披露",
    steps: [
      { title: "完整性审计", desc: "检查论文完整性", tool: "skills", toolLabel: "技能库 · pre-submission-reviewer", how: "用「pre-submission-reviewer 投稿前评审」技能检查论文完整性：结构/图表编号/引用/附录是否齐全。" },
      { title: "预提交清单", desc: "跑预提交检查清单", tool: "skills", toolLabel: "技能库 · 投稿 · 清单", how: "用技能的标准清单逐项检查：标题规范/摘要格式/关键词/作者信息/利益冲突声明等，确保符合期刊要求。" },
      { title: "伦理披露检查", desc: "检查学术伦理披露", tool: "skills", toolLabel: "技能库 · 投稿 · 伦理", how: "检查 AI 使用披露/数据可用性声明/伦理审批/作者贡献声明，确保符合期刊和学术规范。" },
      { title: "自查评审", desc: "做最终自我评审", tool: "skills", toolLabel: "技能库 · paper-self-review", how: "用「paper-self-review 论文自审」技能做最终自查：以审稿人视角通读全文，找最后的问题。" },
      { title: "格式定稿", desc: "按期刊格式定稿", tool: "skills", toolLabel: "技能库 · academic-paper · 格式", how: "用 academic-paper 的 format-convert 模式把论文转换为目标期刊格式（LaTeX 模板/字数限制/参考文献格式）。" }
    ]
  },
  {
    id: "S30",
    title: "审稿意见回应",
    group: "评审发表",
    goal: "撰写审稿回复信：逐条回应、修订说明、重投策略",
    steps: [
      { title: "整理审稿意见", desc: "把审稿意见分类整理", tool: "skills", toolLabel: "技能库 · review-response", how: "用「review-response 审稿回应」技能把审稿意见分类：修改类/质疑类/补充类/拒绝类，逐条编号。" },
      { title: "逐条回应", desc: "写逐条回应", tool: "skills", toolLabel: "技能库 · 回应 · 逐条", how: "用技能模板逐条回应：复述意见→说明修改→引用修改位置，标注「已修改/已回应/不同意理由」。" },
      { title: "反驳论证", desc: "对有争议的意见写反驳", tool: "skills", toolLabel: "技能库 · 回应 · 反驳", how: "对不同意的审稿意见，用文献证据写有理有据的反驳（引用支撑自己的观点），避免直接冲突。" },
      { title: "修订说明", desc: "写修订说明", tool: "skills", toolLabel: "技能库 · 回应 · 修订", how: "用技能生成修订说明（Response to Reviewers），说明每处修改的位置和理由，附修改后稿件。" },
      { title: "重投策略", desc: "制定重投策略", tool: "skills", toolLabel: "技能库 · 回应 · 策略", how: "评估修改后的录用概率，决定重投策略（同一期刊重投/转投其他期刊），准备 cover letter。" }
    ]
  },
  {
    id: "S31",
    title: "基金申报",
    group: "评审发表",
    goal: "撰写研究计划书：立项依据、研究内容、预算、评审要点覆盖",
    steps: [
      { title: "分析基金指南", desc: "解读基金申报指南", tool: "skills", toolLabel: "技能库 · research-grants", how: "用「research-grants 基金申报」技能解读基金指南：资助方向/申报条件/评审标准，确定申报策略。" },
      { title: "规划研究内容", desc: "规划研究内容和路线", tool: "skills", toolLabel: "技能库 · research-proposal", how: "用「research-proposal 研究计划书」技能规划：研究目标/研究内容/技术路线/创新点/预期成果。" },
      { title: "撰写立项依据", desc: "写立项依据（研究背景+文献基础）", tool: "skills", toolLabel: "技能库 · 计划书 · 立项依据", how: "用技能写立项依据：研究背景（为什么重要）→文献综述（现状和缺口）→研究意义（理论/实践）。" },
      { title: "编制预算", desc: "编制经费预算", tool: "skills", toolLabel: "技能库 · 计划书 · 预算", how: "用技能按基金指南编制预算（设备/材料/差旅/劳务/间接费），确保符合经费管理规定。" },
      { title: "评审要点覆盖", desc: "检查评审要点覆盖", tool: "skills", toolLabel: "技能库 · 计划书 · 评审", how: "用技能对照评审标准检查计划书：创新性/可行性/团队能力/经费合理性，逐项确认覆盖。" },
      { title: "模拟评审", desc: "模拟基金评审", tool: "skills", toolLabel: "技能库 · academic-paper-reviewer", how: "用学术评审技能模拟基金评审专家审阅计划书，按意见修改后提交申报。" }
    ]
  },

  // ═══ 八、系统自动化 ═══
  {
    id: "S32",
    title: "外部文献入库衔接",
    group: "系统自动化",
    goal: "网页/文献转 PDF，清洗后入库本地图谱（三库联动）",
    steps: [
      { title: "网页转 PDF", desc: "把网页/EPUB 转为 PDF", tool: "skills", toolLabel: "技能库 · pdf-web-download", how: "用「pdf-web-download 网页转PDF」技能（Edge headless）把网页/EPUB 批量转为 PDF，自动加书签/元数据/防重叠。" },
      { title: "PDF 解析", desc: "用 pdf2obsidian 解析入库", tool: "skills", toolLabel: "技能库 · pdf2obsidian", how: "用「pdf2obsidian」技能把 PDF 批量解析为 Markdown：提取元数据→AI 摘要/术语表/问答→写入 Obsidian 库。" },
      { title: "MD 清洗", desc: "清洗 Markdown 为入库格式", tool: "skills", toolLabel: "技能库 · md-clean", how: "用「md-clean」技能清洗论文 Markdown：裁剪 frontmatter 只留 title/paperTitle，保留 original+摘要+术语表+问答 4 文件。" },
      { title: "三库联动入库", desc: "用一键三库入库", tool: "skills", toolLabel: "技能库 · marx-ingest-all", how: "用「marx-ingest-all 一键三库入库」技能串联入库：Cognee（add+cognify 抽取）+ Graphiti（chunk+实体+蒸馏）+ paper_id_map，paper_id 确定性生成。" },
      { title: "监控入库", desc: "监控入库任务进度", tool: "jobs", toolLabel: "Jobs 自动化", how: "在 Jobs 面板查看 batch_ingest 任务进度（待处理/运行中/已完成），检查 token 消耗和错误重试，确认入库完成。" },
      { title: "验证入库", desc: "验证三库数据完整", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台提问新入库文献的内容，验证三库（Cognee/Graphiti/PG）都能检索到，确认入库链路闭环。" }
    ]
  },
  {
    id: "S33",
    title: "知识库自动化",
    group: "系统自动化",
    goal: "用 17 类后台任务自动化维护知识库：入库/向量化/清洗/自整理",
    steps: [
      { title: "了解任务类型", desc: "浏览 17 类任务", tool: "jobs", toolLabel: "Jobs 自动化", how: "在 Jobs 面板查看 17 类任务：lint/backlinks/sync/synthesize/embed/orphans/purge/dream_cycle/extract/patterns/batch_ingest/hyperedge/clean/classify/disambiguate/index_refresh。" },
      { title: "批量入库", desc: "批量导入文献", tool: "jobs", toolLabel: "Jobs · batch_ingest", how: "在 Jobs 面板入队 batch_ingest 任务批量入库文献，监控队列进度（3 栏：待处理/运行中/已完成）和每篇的 token 消耗。" },
      { title: "向量化与索引", desc: "跑 embed/index_refresh", tool: "jobs", toolLabel: "Jobs · embed", how: "入队 embed（向量化）和 index_refresh（索引刷新）任务，确保新入库文档的向量和索引可用。" },
      { title: "数据清洗", desc: "跑清洗和去重任务", tool: "jobs", toolLabel: "Jobs · clean/orphans", how: "入队 clean（清洗去重）、orphans（孤儿清理）、purge（彻底删除）任务，维护数据质量。" },
      { title: "Dream Cycle 自整理", desc: "一键自整理", tool: "jobs", toolLabel: "Jobs · dream_cycle", how: "点击「Dream Cycle 自整理」紫色按钮，一键跑 9 阶段自整理（三阶段卡：分析/整理/沉淀），让知识库自动组织。" },
      { title: "查看任务详情", desc: "检查任务执行详情", tool: "jobs", toolLabel: "Jobs · 详情", how: "在 Jobs 面板点击任务查看详情：参数/结果/错误/瀑布/token/重试，确认任务成功或诊断失败原因。" },
      { title: "批量入库技能", desc: "用入库技能执行批量入库", tool: "skills", toolLabel: "技能库 · marx-ingest-all", how: "用「marx-ingest-all 一键入库」技能把待入库 PDF 批量走完整管线（解析→清洗→三库联动：PG/Graphiti/Cognee），替代手动逐个入库。" },
    ]
  },
  {
    id: "S34",
    title: "Obsidian 资料管理",
    group: "系统自动化",
    goal: "浏览管理 Obsidian 课题资料库：目录树、多格式预览",
    steps: [
      { title: "浏览目录树", desc: "浏览课题资料目录结构", tool: "vault", toolLabel: "资料库", how: "在资料库左侧目录树浏览课题研究资料（著作/政策/会议等分类），了解资料全貌。" },
      { title: "预览 Markdown", desc: "查看 Markdown 资料内容", tool: "vault", toolLabel: "资料库 · md 预览", how: "点击 Markdown 文件查看渲染内容，轻量 Markdown 渲染支持标题/列表/表格/引用。" },
      { title: "预览 PDF/图片", desc: "查看 PDF 和图片资料", tool: "vault", toolLabel: "资料库 · PDF 预览", how: "点击 PDF/图片文件，iframe 内联预览，直接查看政策文件原文或扫描件。" },
      { title: "下载 Office 文档", desc: "下载 Office 格式资料", tool: "vault", toolLabel: "资料库 · Office", how: "对 docx/xlsx/pptx/epub 文件使用下载模式，下载到本地查看（浏览器内不内联预览）。" },
      { title: "定位课题资料", desc: "在资料库中找到课题相关文件", tool: "vault", toolLabel: "资料库 · 检索", how: "在目录树中定位课题相关文件（如「土地承包法」），配合政策库交叉引用，作为研究的一手资料。" },
      { title: "资料整理技能", desc: "用 Obsidian 技能整理课题库", tool: "skills", toolLabel: "技能库 · obsidian-kb-artifacts", how: "用「obsidian-kb-artifacts Obsidian 知识库」技能规范整理课题资料（文件命名/frontmatter/链接结构），让资料库可检索可追溯。" },
    ]
  },
  {
    id: "S35",
    title: "文档管理",
    group: "系统自动化",
    goal: "管理论文与原始资料文档：上传、重命名、归档、删除",
    steps: [
      { title: "批量上传", desc: "上传文档入库", tool: "documents", toolLabel: "文档管理", how: "在文档管理上传论文/资料文档（批量处理入队），选择目标项目，上传后自动解析切片。" },
      { title: "查看入库状态", desc: "检查入库处理状态", tool: "documents", toolLabel: "文档管理 · 状态", how: "查看上传文档的处理状态（待处理/处理中/完成/失败），确认入库成功或查看失败原因。" },
      { title: "重命名管理", desc: "重命名文档", tool: "documents", toolLabel: "文档管理 · 重命名", how: "对需要调整的文档重命名（论文标题规范化），保持文档库整洁。" },
      { title: "归档整理", desc: "归档不常用文档", tool: "documents", toolLabel: "文档管理 · 归档", how: "把不常用但仍需保留的文档归档，归档后从主列表隐藏，需要时恢复。" },
      { title: "级联删除", desc: "彻底删除文档", tool: "documents", toolLabel: "文档管理 · 删除", how: "对确认无用的文档彻底删除（级联删除文档-切片-事件-实体），或用 Jobs 的 purge 任务批量清理。" }
    ]
  },

  // ═══ 九、经典文本研究（马理论文本研究专用）═══
  {
    id: "S36",
    title: "核心概念溯源与语义演变",
    group: "经典文本研究",
    goal: "追踪单个概念（如资本、意识形态、市民社会）从起源到不同历史阶段、不同学派的语义变化，准确定位原始出处，区分语境差异",
    steps: [
      { title: "确保原著入库", desc: "确认经典著作文本已在知识库", tool: "documents", toolLabel: "文档管理", how: "检查知识库是否含目标著作（如《资本论》《德意志意识形态》）。缺失时用文档管理上传 md 文本，或直接粘贴入库。" },
      { title: "定义概念与范围", desc: "明确要溯源的概念和时间/学派范围", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台输入：「追踪概念『资本』在马克思著作中的语义演变，从《1844年经济学哲学手稿》到《资本论》第三卷」，让 52 步链路先给出思想史框架。" },
      { title: "概念溯源分析", desc: "调用概念溯源能力做语义演变阶段归纳", tool: "reason", toolLabel: "概念溯源", how: "在推理页用「核心概念溯源」功能输入概念名，系统跨文档检索该概念的所有出现位置，归纳语义演变阶段（阶段名/时期/内涵/出处/原文引用）。" },
      { title: "定位原始出处", desc: "核对每个阶段的原始文本出处", tool: "ask", toolLabel: "Ask 检索", how: "用 Ask 检索概念在具体著作中的原文位置（如「资本』在《资本论》第一卷第一篇的出现位置」），与溯源结果互相印证，确保出处准确。" },
      { title: "区分语境差异", desc: "区分同一概念在不同语境下的内涵", tool: "reason", toolLabel: "推理工作台", how: "对溯源结果中内涵差异明显的阶段，用推理链分析「同一概念在政治经济学语境 vs 哲学语境下的内涵差异」，标注语境标签。" },
      { title: "沉淀溯源档案", desc: "把溯源结果写成知识页", tool: "truth", toolLabel: "知识页", how: "在知识页新建「概念溯源档案」，记录：概念定义/各阶段语义演变表（时期-内涵-出处）/语境差异/原文引用清单，作为后续论文的概念基础。" }
    ]
  },
  {
    id: "S37",
    title: "文本论证结构拆解",
    group: "经典文本研究",
    goal: "对经典著作、核心论文自动划分逻辑层次，梳理从前提到结论的完整论证链条（如《资本论》：商品二重性→劳动二重性→货币起源→资本总公式→剩余价值生产）",
    steps: [
      { title: "确认文本与章节", desc: "明确要拆解的著作和范围", tool: "documents", toolLabel: "文档管理", how: "在文档管理确认目标文本（如《资本论》第一卷）已入库且章节结构完整（按##标题分节）。" },
      { title: "论证结构拆解", desc: "调用论证拆解能力划分逻辑层次", tool: "reason", toolLabel: "论证拆解", how: "在推理页用「文本论证结构拆解」输入 documentId，系统按章节读取全文，划分逻辑层次（一级论证模块/二级子论证），输出前提-结论链条。" },
      { title: "验证论证链条", desc: "核对每个论证环节的原文对应", tool: "ask", toolLabel: "Ask 检索", how: "对拆解出的关键论证环节（如商品二重性→劳动二重性），用 Ask 检索原文确认该环节确实出自对应章节，防止拆解脱离文本。" },
      { title: "标注论证类型", desc: "识别演绎/归纳/辩证等论证方式", tool: "reason", toolLabel: "推理工作台", how: "对拆解结果做论证类型标注：用推理链分析「《资本论》第一卷从商品到剩余价值的论证用了哪些论证方式（辩证/演绎/历史分析）」，补充拆解结果。" },
      { title: "关联章节脉络", desc: "把论证链与全书章节结构对应", tool: "graph", toolLabel: "知识图谱", how: "在知识图谱中查看该著作的章节实体关系，把论证链条映射到实际章节顺序，形成「章节→论证环节」对照表。" },
      { title: "沉淀拆解报告", desc: "把论证结构写成知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录论证拆解报告：逻辑层次图/前提结论链条表（每环节带原文出处）/论证类型标注/与章节的对应关系。" }
    ]
  },
  {
    id: "S38",
    title: "多文本互文对照",
    group: "经典文本研究",
    goal: "同一主题下不同经典作家的文本对比（如马克思与恩格斯对同一问题的表述差异），或同一著作不同译本的译文对比，标注关键概念译法分歧",
    steps: [
      { title: "确认对照文本", desc: "确保参与对照的多个文本已入库", tool: "documents", toolLabel: "文档管理", how: "确认参与对照的文本都在库（如同一著作不同译本《德意志意识形态》译本A/译本B，或多位作家的相关论述）。缺失的先用文档管理上传。" },
      { title: "定义对照主题", desc: "明确互文对照的主题", tool: "reason", toolLabel: "推理工作台", how: "在推理工作台明确对照主题（如「马克思与恩格斯对『市民社会』的表述差异」），让 52 步链路先梳理两方观点概览。" },
      { title: "互文对照分析", desc: "调用互文对照能力做多文本对比", tool: "reason", toolLabel: "互文对照", how: "在推理页用「多文本互文对照」输入主题 + 参与文档 ID 列表，系统逐文本检索主题相关段落，输出对照维度/各方表述/差异分析。" },
      { title: "核对译法分歧", desc: "重点核对关键概念的译法差异", tool: "ask", toolLabel: "Ask 检索", how: "对不同译本对照，用 Ask 检索关键概念（如「bürgerliche Gesellschaft」在各译本的译法），确认译法分歧是否准确，补充对照结果。" },
      { title: "分析差异原因", desc: "分析表述差异的思想背景", tool: "reason", toolLabel: "推理工作台", how: "对对照发现的差异，用推理链分析原因（写作时期不同/关注点不同/概念发展），区分「实质分歧」与「表述侧重差异」。" },
      { title: "沉淀对照档案", desc: "把互文对照写成知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录互文对照结果：对照维度表（各方观点+原文引用）/译法分歧清单/差异原因分析，供论文引用。" }
    ]
  },
  {
    id: "S39",
    title: "晦涩文本阐释辅助",
    group: "经典文本研究",
    goal: "对哲学、理论类晦涩段落进行逻辑拆解与通俗化重述，标注学界主流解读观点与争议点；所有阐释必须对应原文段落并标注出处",
    steps: [
      { title: "定位晦涩段落", desc: "选定要阐释的原文段落", tool: "ask", toolLabel: "Ask 检索", how: "用 Ask 检索目标著作中的晦涩段落原文（如《资本论》第一卷「商品拜物教」相关段落），确认原文准确。" },
      { title: "逻辑拆解", desc: "把段落拆成命题并说明逻辑关系", tool: "reason", toolLabel: "阐释辅助", how: "在推理页用「晦涩文本阐释辅助」粘贴原文段落，系统把段落拆成若干命题（每命题标注对应原文短语），说明命题间的逻辑关系。" },
      { title: "通俗化重述", desc: "获得不改变原意的通俗重述", tool: "reason", toolLabel: "阐释辅助", how: "同上功能获取段落的通俗化重述（保持原意、通俗表达），作为理解抓手——但论文引用必须回原文。" },
      { title: "核对学界解读", desc: "对照主流解读观点与争议点", tool: "sciverse", toolLabel: "外部检索", how: "用外部检索（Sciverse）查该段落的学界解读文献（如「商品拜物教 解读 争议」），与系统给出的解读观点互相印证，标注权威来源。" },
      { title: "验证不脱离文本", desc: "确保阐释都对应原文出处", tool: "ask", toolLabel: "Ask 检索", how: "对阐释结果逐条用 Ask 回查原文出处，确认每条阐释都有原文段落支撑，无脱离文本的主观发挥。" },
      { title: "沉淀阐释笔记", desc: "把阐释过程写成知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录：原文段落/命题拆解表（原文短语-含义）/通俗重述/学界解读与争议/出处核对结果。" }
    ]
  },
  {
    id: "S40",
    title: "版本校勘与文本差异识别",
    group: "经典文本研究",
    goal: "识别同一著作的手稿版、全集版、单行本、不同译本之间的文字差异，标注删改内容、增补内容，辅助文本考证类研究",
    steps: [
      { title: "准备多版本文本", desc: "确保同一著作的多个版本已入库", tool: "documents", toolLabel: "文档管理", how: "上传同一著作的多个版本（标题需含相同著作名，如《资本论》第一卷_手稿版 / _全集版 / _单行本），系统按标题前缀识别为同一著作的不同版本。" },
      { title: "确认版本清单", desc: "确认参与校勘的版本", tool: "documents", toolLabel: "文档管理", how: "在文档管理确认各版本均入库且章节结构完整（同一著作的各版本应保持相同章节划分，便于逐段比对）。" },
      { title: "版本校勘分析", desc: "调用版本校勘能力做差异比对", tool: "reason", toolLabel: "版本校勘", how: "在推理页用「版本校勘」输入著作名（如「资本论」），系统按章节逐段比对各版本文字，输出差异清单（位置/类型：删改/增补/改写/标点/各版本文字）。" },
      { title: "核对关键差异", desc: "重点核对实质内容差异", tool: "ask", toolLabel: "Ask 检索", how: "对校勘结果中的实质性差异（删改/增补），用 Ask 检索相关考证文献（如「《资本论》手稿与全集版差异 研究」），确认差异是否已有学界考证。" },
      { title: "分析差异意义", desc: "分析删改增补的思想意义", tool: "reason", toolLabel: "推理工作台", how: "对重要差异用推理链分析其意义（如某处增补体现了马克思思想的演变），区分「实质性改动」与「编辑性/标点差异」。" },
      { title: "沉淀校勘档案", desc: "把校勘结果写成知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录版本校勘档案：版本清单/差异表（位置-类型-各版本文字-差异描述）/差异意义分析/参考文献。" }
    ]
  },

// ═══ 十、学术研究（学派/观点/争鸣/谱系/前沿）═══
{
  id: "S41",
  title: "学派脉络全景梳理",
  group: "学术研究",
  goal: "自动梳理某一理论流派的起源、代表人物、核心命题、发展阶段、内部分歧与后世影响（如西方马克思主义：法兰克福→结构主义→分析马克思主义→空间政治经济学）",
  steps: [
    { title: "定义学派", desc: "明确要梳理的理论流派", tool: "reason", toolLabel: "学派脉络", how: "在学术研究场景用「学派脉络全景」输入流派名（如 西方马克思主义/法兰克福学派），系统检索相关文本并梳理起源/代表人物/命题/阶段。" },
    { title: "核对代表人物", desc: "验证代表人物与代表作", tool: "ask", toolLabel: "Ask 检索", how: "对梳理出的代表人物逐个用 Ask 检索其代表作与贡献，确认信息准确。" },
    { title: "查看师承关系", desc: "查看算法提取的代表人物共现关系", tool: "graph", toolLabel: "知识图谱", how: "在知识图谱查看学派代表人物的实体关系，结合面板的「代表人物关系」验证师承/合作线索。" },
    { title: "深挖发展阶段", desc: "补充各阶段的标志性事件", tool: "reason", toolLabel: "推理工作台", how: "对发展阶段模糊处用推理链补充（如「法兰克福学派第三代的标志性转向」），标注依据。" },
    { title: "沉淀学派档案", desc: "写成知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录学派档案：起源/人物表（含代表作）/命题/阶段时间线/分歧/影响。" }
  ]
},
{
  id: "S42",
  title: "核心观点对比分析",
  group: "学术研究",
  goal: "针对同一研究问题，横向对比不同学者、不同学派的观点差异、论证逻辑差异、立场分歧，输出结构化观点对照表",
  steps: [
    { title: "定义问题与学者", desc: "明确研究问题与参与对比的学者", tool: "reason", toolLabel: "观点对比", how: "在学术研究场景用「核心观点对比」输入研究问题 + 学者列表（逗号分隔），系统检索各学者观点并输出对照表。" },
    { title: "核对观点来源", desc: "确认每位学者的观点出处", tool: "ask", toolLabel: "Ask 检索", how: "对对照表中的每项观点用 Ask 检索原始文献，确认观点归属正确。" },
    { title: "查看共识/分歧聚类", desc: "查看算法聚类的共识与分歧", tool: "reason", toolLabel: "观点对比", how: "面板展示的「共识/分歧聚类」（embedding 相似度）帮你快速定位学者间的一致与对立。" },
    { title: "分析论证逻辑", desc: "比较学者论证逻辑的差异", tool: "reason", toolLabel: "推理工作台", how: "对核心分歧用推理链分析论证逻辑差异（如「A 用经验数据论证 vs B 用理论推演」）。" },
    { title: "沉淀对比表", desc: "把对照表写成知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录观点对照表：学者/观点/论证逻辑/立场 + 共识点/争议点/论据来源。" }
  ]
},
{
  id: "S43",
  title: "学术争鸣脉络还原",
  group: "学术研究",
  goal: "自动识别某一领域的核心学术论战，梳理正反双方的代表人物、核心论据、回合交锋与后续影响",
  steps: [
    { title: "定义争鸣主题", desc: "明确要还原的学术论战", tool: "reason", toolLabel: "争鸣还原", how: "在学术研究场景用「学术争鸣脉络」输入论战主题（如 非粮化之争），系统检索并还原缘起/正反方/回合。" },
    { title: "核对交锋回合", desc: "确认各回合的时间与内容", tool: "ask", toolLabel: "Ask 检索", how: "对还原出的交锋回合逐个用 Ask 检索对应文献，确认回合顺序与内容准确。" },
    { title: "查看交锋时间线", desc: "查看算法生成的相关文献时间线", tool: "reason", toolLabel: "争鸣还原", how: "面板的「相关文献时间线」按时间排序展示论战相关文献，帮助你把握交锋脉络。" },
    { title: "分析理论意义", desc: "分析争鸣的理论意义", tool: "reason", toolLabel: "推理工作台", how: "对争鸣的意义用推理链分析（如「这场争论推动了什么理论转向」）。" },
    { title: "沉淀争鸣档案", desc: "写成知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录争鸣档案：缘起/正反方表（人物+论据）/回合时间线/理论意义。" }
  ]
},
{
  id: "S44",
  title: "学者思想谱系构建",
  group: "学术研究",
  goal: "梳理单个学者的思想发展历程、不同阶段的代表作、核心观点演变，识别其学术师承、理论来源与对后世的学术影响",
  steps: [
    { title: "定义学者", desc: "明确要梳理的学者", tool: "reason", toolLabel: "学者谱系", how: "在学术研究场景用「学者思想谱系」输入学者名（如 马克思），系统检索并梳理思想阶段/代表作/师承。" },
    { title: "核对思想阶段", desc: "确认各阶段的代表作与观点", tool: "ask", toolLabel: "Ask 检索", how: "对梳理出的思想阶段逐个用 Ask 检索代表作原文，确认阶段划分与观点演变准确。" },
    { title: "查看学术网络", desc: "查看算法提取的著作与关联学者", tool: "graph", toolLabel: "知识图谱", how: "在知识图谱查看该学者的实体关系（著作/机构/关联人物），结合面板「学术网络」验证师承。" },
    { title: "分析理论来源", desc: "深挖思想的理论来源", tool: "reason", toolLabel: "推理工作台", how: "对理论来源用推理链分析（如「马克思的黑格尔渊源」），标注依据。" },
    { title: "沉淀谱系档案", desc: "写成知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录学者谱系：思想阶段表（阶段/时期/代表作/观点）/师承/理论来源/影响。" }
  ]
},
{
  id: "S45",
  title: "学科前沿动态追踪",
  group: "学术研究",
  goal: "定期汇总最新 CSSCI/核心期刊的研究热点、新兴议题、研究方法转向，识别年度高频关键词与高被引文献，输出领域前沿简报",
  steps: [
    { title: "定义学科", desc: "明确要追踪的学科/领域", tool: "reason", toolLabel: "学科前沿", how: "在学术研究场景用「学科前沿动态」输入领域名（如 资本下乡），系统检索并汇总热点/新议题/方法转向。" },
    { title: "查看高频关键词", desc: "查看算法统计的高频词", tool: "reason", toolLabel: "学科前沿", how: "面板的「高频关键词」按 TF 统计展示领域高频术语，快速把握研究重心。" },
    { title: "核对热点文献", desc: "确认高关注文献", tool: "literature", toolLabel: "文献库", how: "对面板列出的高关注文献在文献库核对，确认其研究价值与引用情况。" },
    { title: "识别方法转向", desc: "分析研究方法的变化", tool: "reason", toolLabel: "推理工作台", how: "对方法转向用推理链分析（如「从定性到定量/从截面到面板」的趋势）。" },
    { title: "生成前沿简报", desc: "写成知识页简报", tool: "truth", toolLabel: "知识页", how: "在知识页记录前沿简报：热点/新议题/方法转向/高频词表/关键文献，定期更新。" },
    { title: "前沿报告技能", desc: "用研究报告技能生成简报", tool: "skills", toolLabel: "技能库 · market-research-reports", how: "用「market-research-reports 市场研究报告」技能把高频词/热点文献/方法转向整理为结构化前沿简报（领域阶段/热点/趋势），供选题与综述使用。" },
  ]
},

// ═══ 十一、论文写作与研究设计（S46-S50）═══
{
  id: "S46",
  title: "研究问题凝练与空白识别",
  group: "论文写作研究",
  goal: "基于现有文献库总结某一主题的研究现状，明确已解决/争议/空白问题，辅助提炼有学术价值的研究问题",
  steps: [
    { title: "定义研究主题", desc: "明确要凝练问题的主题", tool: "reason", toolLabel: "问题凝练", how: "在论文写作研究场景用「研究问题凝练」输入主题（如 资本下乡的乡村治理效应），系统检索文献并总结现状/争议/空白。" },
    { title: "查看覆盖矩阵", desc: "查看主题覆盖度识别空白方向", tool: "reason", toolLabel: "问题凝练", how: "面板的「主题覆盖矩阵」按高/中/低覆盖标注主题词分布，低覆盖词即潜在空白方向。" },
    { title: "评估研究问题", desc: "对建议的问题做价值评估", tool: "skills", toolLabel: "技能库 · idea-evaluator", how: "用「idea-evaluator」对面板建议的研究问题做五维评估（新颖/可行/重要），筛选最有价值的问题。" },
    { title: "验证非伪问题", desc: "确认问题不是伪问题", tool: "ask", toolLabel: "Ask 检索", how: "对候选问题用 Ask 检索「是否已有类似研究」，确认不是重复研究。" },
    { title: "沉淀选题依据", desc: "写成知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录：研究现状/空白清单/覆盖矩阵/选定的研究问题与价值依据。" }
  ]
},
{
  id: "S47",
  title: "研究框架与论证结构设计",
  group: "论文写作研究",
  goal: "针对研究问题推荐适配的论文结构（如理论研究型：概念辨析-理论溯源-现实关照-批判反思），拆解各章节核心论证任务",
  steps: [
    { title: "定义问题与类型", desc: "输入研究问题与研究类型", tool: "reason", toolLabel: "框架设计", how: "在论文写作研究场景用「研究框架设计」输入问题 + 类型（理论研究/实证/历史/比较/文本/政策），算法匹配结构模板。" },
    { title: "查看模板匹配", desc: "确认推荐的论文结构", tool: "reason", toolLabel: "框架设计", how: "面板展示匹配的结构模板（如 概念辨析→理论溯源→现实关照→批判反思）及适用场景。" },
    { title: "拆解章节任务", desc: "确认各章节的论证任务", tool: "reason", toolLabel: "框架设计", how: "面板列出每章的核心论证任务与逻辑关系，确认逻辑骨架完整。" },
    { title: "调整结构", desc: "按需调整章节", tool: "reason", toolLabel: "推理工作台", how: "对特殊研究问题用推理链调整结构（如增加「实证检验」章节），保持逻辑自洽。" },
    { title: "沉淀框架文档", desc: "写成知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录：结构模板/章节任务表/逻辑骨架，作为写作蓝图。" },
    { title: "大纲生成技能", desc: "用大纲技能完善框架", tool: "skills", toolLabel: "技能库 · outline-agent", how: "用「outline-agent 大纲生成」技能把研究框架细化为一二三级大纲（含章节任务分配），与面板的模板匹配结果对照完善。" },
  ]
},
{
  id: "S48",
  title: "论证链条补全与逻辑校验",
  group: "论文写作研究",
  goal: "梳理从核心论点到结论的完整推理步骤，识别逻辑断层，提示需要补充的理论依据或实证支撑",
  steps: [
    { title: "定义论点与结论", desc: "输入核心论点与目标结论", tool: "reason", toolLabel: "论证补全", how: "在论文写作研究场景用「论证链条补全」输入论点（如 资本下乡具有产业带动效应）与结论（如 会重塑乡村治理结构）。" },
    { title: "查看推理链条", desc: "检查推理步骤与断层", tool: "reason", toolLabel: "论证补全", how: "面板展示推理链条，断层环节红色高亮（如「产业带动→治理重塑」之间缺微观机制）。" },
    { title: "查看断层度", desc: "量化逻辑完整度", tool: "reason", toolLabel: "论证补全", how: "面板的断层度百分比提示逻辑完整程度（0% 完整 / 高% 需重构）。" },
    { title: "补充论证材料", desc: "检索支撑证据", tool: "ask", toolLabel: "Ask 检索", how: "对面板提示的缺失环节（如 微观机制），用 Ask 检索相关文献补充理论/实证支撑。" },
    { title: "沉淀论证图", desc: "写成知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录：推理链条表（每步含前提/推论/断层）/补充材料/最终论证图。" },
    { title: "批判检验技能", desc: "用批判思维技能校验论证链", tool: "skills", toolLabel: "技能库 · scientific-critical-thinking", how: "用「scientific-critical-thinking 科学批判思维」技能对补全后的论证链做逻辑检验（证据充分性/假设/反例），确保断层度降为零。" },
  ]
},
{
  id: "S49",
  title: "研究方法适配建议",
  group: "论文写作研究",
  goal: "针对研究主题推荐适配的哲社科研究方法（文本研究法、比较研究法、历史分析法、质性研究法等），说明适用边界与常见误区",
  steps: [
    { title: "定义主题与类型", desc: "输入研究主题与类型", tool: "reason", toolLabel: "方法适配", how: "在论文写作研究场景用「研究方法适配」输入主题与类型，算法按关键词匹配方法（文本/比较/历史/质性/定量/辩证）。" },
    { title: "查看方法匹配", desc: "查看算法匹配的方法清单", tool: "reason", toolLabel: "方法适配", how: "面板展示方法特征匹配（适用场景/边界/误区），快速了解候选方法。" },
    { title: "查看细化建议", desc: "查看 LLM 细化的推荐", tool: "reason", toolLabel: "方法适配", how: "面板的「方法推荐」给出每种方法的理由/操作要点/误区，确认最适配的方法。" },
    { title: "验证方法可行性", desc: "确认数据/材料可得性", tool: "ask", toolLabel: "Ask 检索", how: "对选定方法用 Ask 检索材料可得性（如 历史资料是否充分/数据是否可获取）。" },
    { title: "沉淀方法说明", desc: "写成知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录：选定方法/适用边界/操作要点/误区警示，纳入研究方法章节。" },
    { title: "方法实现技能", desc: "用实证技能验证方法可落地", tool: "skills", toolLabel: "技能库 · 00.1-Python 实证", how: "用「00.1-Full-empirical-analysis-skill_Python」技能验证建议的研究方法可落地（数据要求/模型/稳健性设计），与面板方法匹配结果对照。" },
  ]
},
{
  id: "S50",
  title: "反方视角与反驳意见生成",
  group: "论文写作研究",
  goal: "主动提供对立学派的批评观点、逻辑反例、理论前提质疑，帮助研究者预判反驳，完善自身论证",
  steps: [
    { title: "输入论点与论证", desc: "粘贴核心论点与论证文本", tool: "reason", toolLabel: "反方视角", how: "在论文写作研究场景用「反方视角生成」输入论点（如 资本下乡必然促进乡村现代化）与论证段落。" },
    { title: "查看弱化检测", desc: "查看算法扫描的易攻击点", tool: "reason", toolLabel: "反方视角", how: "面板的「前提弱化检测」标出绝对化表述（必然/显著/唯一等），即反方最易攻击的位置。" },
    { title: "查看对立批评", desc: "了解对立学派的批评", tool: "reason", toolLabel: "反方视角", how: "面板展示对立批评/逻辑反例/前提质疑，帮助理解反方立场。" },
    { title: "预判反驳", desc: "准备回应策略", tool: "reason", toolLabel: "推理工作台", how: "用推理链分析哪些批评最有力，哪些可以回应，准备针对性回应。" },
    { title: "完善论证", desc: "把反方视角融入论文", tool: "truth", toolLabel: "知识页", how: "在知识页记录：反方批评清单/弱化点/回应策略，完善论证后重跑反方视角验证。" },
    { title: "评审视角检验", desc: "用评审技能预演反方攻击", tool: "skills", toolLabel: "技能库 · academic-paper-reviewer", how: "用「academic-paper-reviewer 学术评审」技能模拟评审专家对论点攻击（方法/证据/逻辑/贡献），与面板的弱化检测结果对照，提前堵住反驳点。" },
  ]
},

// ═══ 十二、论文写作输出（S51-S55）═══
{
  id: "S51",
  title: "高质量文献综述生成",
  group: "论文写作输出",
  goal: "针对指定主题，按研究缘起-发展脉络-学派分歧-研究共识-现存不足结构生成综述初稿，突出学术脉络，标注文献来源",
  steps: [
    { title: "定义综述主题", desc: "明确综述主题", tool: "reason", toolLabel: "综述生成", how: "在论文写作输出场景用「高质量文献综述生成」输入主题，系统检索文献并按五段结构生成综述初稿。" },
    { title: "核对来源标注", desc: "确认每观点有文献来源", tool: "ask", toolLabel: "Ask 检索", how: "对综述中标注来源的观点抽查用 Ask 检索原文，确认来源标注准确。" },
    { title: "检查学术脉络", desc: "确认是脉络而非观点堆砌", tool: "reason", toolLabel: "推理工作台", how: "检查综述是否有演进脉络（研究如何从早期发展到当前），而非简单罗列观点。" },
    { title: "补充关键文献", desc: "补入遗漏的重要文献", tool: "literature", toolLabel: "文献库", how: "对照综述引用的文献清单，用文献库检索确认无遗漏重要文献（可用 S05 文献综述的检索结果交叉验证）。" },
    { title: "去AI味检测", desc: "综述全文AI痕迹检测与降重", tool: "skills", toolLabel: "技能库 · humanize-chinese", how: "打开技能库调用「humanize-chinese 中文AI去痕迹」技能，对综述初稿跑 detect 检测评分；分数偏高（学术场景阈值）用 academic 模式改写降重（适配知网/维普 AIGC 检测）。" },
    { title: "沉淀综述初稿", desc: "存入知识页", tool: "truth", toolLabel: "知识页", how: "在知识页保存去AI味后的综述初稿（五段结构 + 引用清单），作为论文文献综述章节的基础。" }
  ]
},
{
  id: "S52",
  title: "学术段落扩写与润色",
  group: "论文写作输出",
  goal: "基于核心观点扩展为严谨的学术段落，补充理论依据、调整表述逻辑，去除口语化、主观化表达",
  steps: [
    { title: "输入核心观点", desc: "明确要扩写的核心观点", tool: "reason", toolLabel: "段落扩写", how: "在论文写作输出场景用「学术段落扩写」输入核心观点（如 资本下乡具有产业带动效应）与主题。" },
    { title: "查看扩写结果", desc: "获取扩写的学术段落", tool: "reason", toolLabel: "段落扩写", how: "面板展示扩写后的学术段落（300-500字）与补充的理论依据。" },
    { title: "检查口语化", desc: "确认口语化表达已去除", tool: "reason", toolLabel: "段落扩写", how: "面板的「口语化检测」标出原文中的口语/主观表达，确认扩写后已规范。" },
    { title: "核对表达对照", desc: "查看原文→规范的改写", tool: "reason", toolLabel: "段落扩写", how: "面板的「表达规范对照」展示原文表达→规范表达的改写，确认术语体适配。" },
    { title: "去AI味检测", desc: "对扩写段落做AI痕迹检测与改写", tool: "skills", toolLabel: "技能库 · humanize-chinese", how: "打开技能库调用「humanize-chinese 中文AI去痕迹」技能，对扩写后的段落跑 detect 检测（机械连接词/AI高频词/评分），分数偏高用 rewrite 改写，确保投稿前 AIGC 检测可通过。" },
    { title: "沉淀段落", desc: "存入论文草稿", tool: "truth", toolLabel: "知识页", how: "在知识页保存去AI味后的扩写段落，纳入论文相应章节。" }
  ]
},
{
  id: "S53",
  title: "规范化学术要件生成",
  group: "论文写作输出",
  goal: "按照期刊/学位论文要求生成摘要、关键词、引言、结论、英文摘要等模块初稿，突出创新点、方法与核心结论",
  steps: [
    { title: "输入论文信息", desc: "填写标题/主题/方法/发现/类型", tool: "reason", toolLabel: "学术要件", how: "在论文写作输出场景用「规范化学术要件」填写论文信息（标题/主题/方法/核心发现/类型），系统按模板生成各要件。" },
    { title: "核对摘要", desc: "确认摘要含目的/方法/结果/结论", tool: "reason", toolLabel: "学术要件", how: "检查生成的中文摘要是否符合【目的】【方法】【结果】【结论】结构，突出创新点。" },
    { title: "核对关键词", desc: "确认 3-5 个核心关键词", tool: "reason", toolLabel: "学术要件", how: "检查关键词是否覆盖核心概念，可手动增删。" },
    { title: "核对英文摘要", desc: "确认英文摘要对应中文", tool: "reason", toolLabel: "学术要件", how: "检查英文摘要与中文摘要内容对应，术语翻译准确。" },
    { title: "去AI味检测", desc: "要件文本AI痕迹检测", tool: "skills", toolLabel: "技能库 · humanize-chinese", how: "打开技能库调用「humanize-chinese 中文AI去痕迹」技能，对摘要/引言/结论跑 detect 检测（机械连接词/AI高频词），评分偏高用 rewrite 改写；英文摘要可用「humanizer_academic」去除英文 AI 写作模式。" },
    { title: "沉淀要件", desc: "存入论文文档", tool: "truth", toolLabel: "知识页", how: "在知识页保存各要件（摘要/关键词/引言/结论/英文摘要），作为投稿准备材料。" }
  ]
},
{
  id: "S54",
  title: "引文与参考文献格式化",
  group: "论文写作输出",
  goal: "支持 GB/T 7714、APA、MLA 等主流引文格式，自动生成规范的参考文献列表，核对正文引文与参考文献的一一对应",
  steps: [
    { title: "粘贴参考文献", desc: "粘贴原始参考文献列表", tool: "reason", toolLabel: "引文格式化", how: "在论文写作输出场景用「引文格式化」粘贴参考文献原文（每行一条），选择目标格式（GB/T 7714/APA/MLA）。" },
    { title: "查看自动转换", desc: "查看算法转换结果", tool: "reason", toolLabel: "引文格式化", how: "面板的「算法自动转换」展示每条引文从原文→目标格式的转换，检查准确性。" },
    { title: "核对完整性", desc: "确认无遗漏与错误", tool: "reason", toolLabel: "引文格式化", how: "面板的「LLM 完整转换」给出完整列表，「核对发现问题」标出格式错误与修正建议。" },
    { title: "正文引文核对", desc: "确认正文引文与列表对应", tool: "ask", toolLabel: "Ask 检索", how: "用 Ask 检索正文中的引文标注，与参考文献列表一一核对，修正遗漏。" },
    { title: "导出参考文献", desc: "复制最终列表", tool: "truth", toolLabel: "知识页", how: "复制转换后的参考文献列表存入论文，提交前再核对一次。" },
    { title: "引文管理技能", desc: "用引文管理技能校验格式", tool: "skills", toolLabel: "技能库 · citation-management", how: "用「citation-management 引用管理」技能导出标准格式（GB/T 7714/BibTeX），并核对正文引文与列表一一对应，消除格式错误。" },
  ]
},
{
  id: "S55",
  title: "多场景语体适配",
  group: "论文写作输出",
  goal: "适配期刊论文、学位论文、会议论文、理论宣传文稿、课程论文等不同写作场景的语体差异，在严谨性、通俗性、理论深度之间调整",
  steps: [
    { title: "粘贴原文", desc: "粘贴待适配的文本", tool: "reason", toolLabel: "语体适配", how: "在论文写作输出场景用「多场景语体适配」粘贴原文，选择目标场景（期刊/学位/会议/宣传/课程论文）。" },
    { title: "查看语体规则", desc: "了解该场景的语体要求", tool: "reason", toolLabel: "语体适配", how: "面板展示语体规则库（该场景的严谨度/规则列表），确认适配方向。" },
    { title: "检查口语化", desc: "确认口语化表达已处理", tool: "reason", toolLabel: "语体适配", how: "面板的「口语化检测」标出原文问题表达。" },
    { title: "查看改写结果", desc: "获取改写后文本", tool: "reason", toolLabel: "语体适配", how: "面板展示改写后的文本与「调整对照」（原文→改写后），确认语体到位。" },
    { title: "去AI味检测", desc: "适配后文本AI痕迹检测", tool: "skills", toolLabel: "技能库 · humanize-chinese", how: "打开技能库调用「humanize-chinese 中文AI去痕迹」技能，对适配后的文本跑 detect 检测；若评分偏高用 style 模式（学术/宣传/课程论文风格）改写，兼顾语体与自然度。" },
    { title: "沉淀适配文本", desc: "存入对应文稿", tool: "truth", toolLabel: "知识页", how: "在知识页保存去AI味后的适配文本，用于目标场景投稿/发表。" }
  ]
},

// ═══ 十三、论文质量检查（S56-S60）═══
{
  id: "S56",
  title: "概念一致性校验",
  group: "论文质量检查",
  goal: "全文扫描核心概念的使用，识别同一概念前后内涵不一致、偷换概念的问题，提示易混淆概念的差异",
  steps: [
    { title: "粘贴论文文本", desc: "粘贴待检查的论文全文或章节", tool: "reason", toolLabel: "概念校验", how: "在论文质量检查场景用「概念一致性校验」粘贴论文文本，系统扫描核心概念使用。" },
    { title: "查看算法检测", desc: "查看易混淆概念对", tool: "reason", toolLabel: "概念校验", how: "面板的「算法检测」按易混淆概念库（异化/物化、国家/政府、资本/资金等）扫描同一段落混用的情况。" },
    { title: "查看 LLM 检测", desc: "查看内涵不一致与偷换概念", tool: "reason", toolLabel: "概念校验", how: "面板的「内涵不一致」标出同一概念前后内涵变化的位置，确认是否偷换概念。" },
    { title: "修正概念使用", desc: "统一概念内涵", tool: "reason", toolLabel: "推理工作台", how: "对发现的问题在推理工作台确认概念的规范内涵，修正论文中的使用。" },
    { title: "复检", desc: "重跑校验确认修正", tool: "reason", toolLabel: "概念校验", how: "修正后重跑概念校验，确认无遗留问题。" }
  ]
},
{
  id: "S57",
  title: "引文准确性核查",
  group: "论文质量检查",
  goal: "核对引文内容与标注文献的一致性，识别断章取义、误引、错标出处，提示直接引用与间接引用的规范差异",
  steps: [
    { title: "粘贴文本与文献", desc: "粘贴正文与参考文献列表", tool: "reason", toolLabel: "引文核查", how: "在论文质量检查场景用「引文准确性核查」粘贴正文（含引文）+ 参考文献列表。" },
    { title: "查看引文统计", desc: "查看直接/间接引用统计", tool: "reason", toolLabel: "引文核查", how: "面板的「引文统计」展示直接引用/间接引用/引文标记/参考文献数量，确认引用规范。" },
    { title: "查看引文问题", desc: "查看误引/断章取义", tool: "reason", toolLabel: "引文核查", how: "面板的「引文问题」标出引文与文献不一致的地方（误引/断章取义/错标出处）。" },
    { title: "核对对应关系", desc: "确认正文-文献一一对应", tool: "reason", toolLabel: "引文核查", how: "面板的「正文-文献对应」标出匹配/缺失/多余的引文，修正遗漏。" },
    { title: "修正引文", desc: "按规范修正", tool: "reason", toolLabel: "引文核查", how: "对直接引用补页码、对间接引用补出处，修正后重跑核查。" },
    { title: "引文核验技能", desc: "用引文验证技能深度核查", tool: "skills", toolLabel: "技能库 · citation-verification", how: "用「citation-verification 引文核验」技能对每条引文做深度核验（原文对照/引用规范/页码/间接引用标识），补充面板算法检测的盲区。" },
  ]
},
{
  id: "S58",
  title: "逻辑自洽性检查",
  group: "论文质量检查",
  goal: "识别论证中的逻辑矛盾、循环论证、论据不支撑论点、推理跳跃等问题，标记逻辑薄弱环节",
  steps: [
    { title: "粘贴论文文本", desc: "粘贴待检查文本", tool: "reason", toolLabel: "逻辑检查", how: "在论文质量检查场景用「逻辑自洽性检查」粘贴论文文本。" },
    { title: "查看算法标记", desc: "查看循环论证/矛盾信号", tool: "reason", toolLabel: "逻辑检查", how: "面板的「算法检测」按信号词模式（因为…所以…因为 / 虽然…但是…然而…但是）扫描循环论证与矛盾。" },
    { title: "查看逻辑问题", desc: "查看矛盾/循环/跳跃", tool: "reason", toolLabel: "逻辑检查", how: "面板列出逻辑矛盾、循环论证、论据薄弱、推理跳跃的具体位置与详情。" },
    { title: "补充论证", desc: "修补薄弱环节", tool: "reason", toolLabel: "推理工作台", how: "对推理跳跃/论据薄弱处用推理链补充论证，用 S48 论证补全能力深化。" },
    { title: "复检", desc: "重跑确认逻辑自洽", tool: "reason", toolLabel: "逻辑检查", how: "修正后重跑逻辑检查，确认无遗留问题。" },
    { title: "批判逻辑技能", desc: "用批判思维技能复核逻辑", tool: "skills", toolLabel: "技能库 · scientific-critical-thinking", how: "修正后用「scientific-critical-thinking 科学批判思维」技能独立复核论证逻辑（循环论证/矛盾/跳跃），与面板算法标记交叉确认。" },
  ]
},
{
  id: "S59",
  title: "学术不端风险提示",
  group: "论文质量检查",
  goal: "识别未标注出处的转述、大段重合表述，提示需要补充引文的位置，辅助规避无意识抄袭与不当引用风险",
  steps: [
    { title: "粘贴文本与源", desc: "粘贴待查文本与疑似来源", tool: "reason", toolLabel: "不端风险", how: "在论文质量检查场景用「学术不端风险提示」粘贴待查文本 + 疑似来源文本（留空则只做内部检查）。" },
    { title: "查看重合度", desc: "查看算法重合度与判定", tool: "reason", toolLabel: "不端风险", how: "面板展示 N-gram 重合度（6-gram 指纹）与风险判定（低/中/高风险），长段重合片段红色标出。" },
    { title: "查看未标注段落", desc: "查看疑似未标注转述", tool: "reason", toolLabel: "不端风险", how: "面板标出无引文标记的段落（疑似未标注出处的转述），需补引文。" },
    { title: "补充引文", desc: "在提示位置补引文", tool: "ask", toolLabel: "Ask 检索", how: "对提示的引文位置用 Ask 检索原文出处，补上规范引文。" },
    { title: "AI生成风险检测", desc: "检测与降重AI生成痕迹", tool: "skills", toolLabel: "技能库 · humanize-chinese", how: "打开技能库调用「humanize-chinese 中文AI去痕迹」技能：中文稿用 detect 检测 AI 痕迹评分，偏高用 academic 模式降重（适配知网/维普/万方 AIGC 检测）；英文稿件用「humanizer_academic 学术论文去AI痕迹」技能去除 AI 写作模式（破折号/膨胀断言/AI词汇等）。" },
    { title: "复检", desc: "重跑确认风险消除", tool: "reason", toolLabel: "不端风险", how: "补充引文并降重后重跑检查，确认重合度下降、无未标注段落、AI 痕迹评分达标。" }
  ]
},
{
  id: "S60",
  title: "格式规范适配",
  group: "论文质量检查",
  goal: "适配不同期刊、高校的格式要求，统一字体、行距、标题层级、脚注格式、参考文献格式",
  steps: [
    { title: "粘贴论文文本", desc: "粘贴含标题的论文文本", tool: "reason", toolLabel: "格式适配", how: "在论文质量检查场景用「格式规范适配」粘贴论文文本，选择目标格式（期刊/学位/党校/高校学报）。" },
    { title: "查看格式规则", desc: "了解目标格式要求", tool: "reason", toolLabel: "格式适配", how: "面板展示目标格式的规则库（标题层级/字体/行距/参考文献格式）。" },
    { title: "查看标题层级", desc: "检测当前标题层级", tool: "reason", toolLabel: "格式适配", how: "面板的「检测到的标题层级」列出当前标题结构，「标题层级问题」标出不符合规则处。" },
    { title: "查看调整对照", desc: "查看格式调整项", tool: "reason", toolLabel: "格式适配", how: "面板的「格式调整对照」展示各调整项（原文→调整后），确认格式适配到位。" },
    { title: "应用格式", desc: "按调整项修改论文", tool: "truth", toolLabel: "知识页", how: "按调整对照在论文中应用格式修改（标题层级/字体/行距/参考文献），提交前再跑一次确认。" }
  ]
},

// ═══ 十四、理论思辨拓展（S61-S65）═══
{
  id: "S61",
  title: "理论前提反思",
  group: "理论思辨拓展",
  goal: "揭示当前研究默认的理论预设、价值立场与认识论前提，分析前提合理性，提供替代的理论视角与研究范式",
  steps: [
    { title: "输入主张与文本", desc: "粘贴研究主张与研究文本", tool: "reason", toolLabel: "前提反思", how: "在理论思辨拓展场景用「理论前提反思」输入研究主张（如 市场能够自发调节）与研究文本。" },
    { title: "查看算法检测", desc: "查看前提信号词", tool: "reason", toolLabel: "前提反思", how: "面板的「算法检测」按前提分类库（市场有效性/理性人/价值中立等信号词）扫描默认假设。" },
    { title: "查看前提分析", desc: "查看 LLM 的前提合理性分析", tool: "reason", toolLabel: "前提反思", how: "面板的「前提分析」给出各前提的类型与合理性分析。" },
    { title: "查看替代范式", desc: "评估替代视角", tool: "reason", toolLabel: "前提反思", how: "面板的「替代视角」提供其他范式（如 批判范式替代实证范式），评估其适用性。" },
    { title: "沉淀反思笔记", desc: "写入知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录：识别的前提清单/合理性分析/替代范式，纳入论文方法论反思章节。" }
  ]
},
{
  id: "S62",
  title: "跨学科视角拓展",
  group: "理论思辨拓展",
  goal: "引入相邻学科的理论资源与分析框架，丰富单一学科的研究视角（如为政治经济学引入社会学、政治学、法学的交叉视角）",
  steps: [
    { title: "输入主题与学科", desc: "填写研究主题与当前学科", tool: "reason", toolLabel: "跨学科", how: "在理论思辨拓展场景用「跨学科视角拓展」输入主题（如 资本下乡的乡村治理效应）与学科（政治经济学）。" },
    { title: "查看学科映射", desc: "查看算法推荐的交叉学科", tool: "reason", toolLabel: "跨学科", how: "面板的「学科映射候选」按映射库推荐社会学/政治学/法学等交叉学科与框架。" },
    { title: "查看跨学科视角", desc: "查看 LLM 细化的应用方式", tool: "reason", toolLabel: "跨学科", how: "面板的「跨学科视角」给出各框架的应用方式与潜在洞见。" },
    { title: "评估适用性", desc: "确认边界与可行性", tool: "ask", toolLabel: "Ask 检索", how: "对选定的交叉框架用 Ask 检索相关文献，确认其在主题中的适用性与边界。" },
    { title: "沉淀交叉视角", desc: "写入知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录：推荐学科/框架/应用方式/洞见/边界，丰富论文的理论视角。" }
  ]
},
{
  id: "S63",
  title: "理论与现实联结",
  group: "理论思辨拓展",
  goal: "辅助将抽象理论应用于现实问题分析，搭建理论命题-现实案例-机制分析的桥梁（如用资本积累理论分析乡村振兴、平台经济）",
  steps: [
    { title: "输入理论与案例", desc: "填写理论/命题/现实案例", tool: "reason", toolLabel: "理论联结", how: "在理论思辨拓展场景用「理论与现实联结」输入理论（资本积累理论）、命题、现实案例（每行一条）。" },
    { title: "查看案例匹配", desc: "查看算法匹配的相关案例", tool: "reason", toolLabel: "理论联结", how: "面板的「算法案例匹配」按 embedding 相似度标出与理论最相关的案例（乡村振兴/平台经济等）。" },
    { title: "查看机制分析", desc: "查看案例的机制分析", tool: "reason", toolLabel: "理论联结", how: "面板的「案例机制分析」给出每个案例匹配的理论命题与机制分析。" },
    { title: "验证联结逻辑", desc: "确认理论应用合理", tool: "ask", toolLabel: "Ask 检索", how: "对机制分析用 Ask 检索现实数据/新闻报道验证，确认理论与现实的联结成立。" },
    { title: "沉淀联结分析", desc: "写入知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录：理论命题/案例/机制分析/联结逻辑/适用边界，纳入论文案例分析章节。" }
  ]
},
{
  id: "S64",
  title: "理论创新点识别",
  group: "理论思辨拓展",
  goal: "识别现有研究的理论局限与可创新空间（概念/视角/方法/框架），评估创新点的学术价值",
  steps: [
    { title: "输入主题与文本", desc: "粘贴主题与研究现状", tool: "reason", toolLabel: "创新识别", how: "在理论思辨拓展场景用「理论创新点识别」输入主题与研究现状文本。" },
    { title: "查看创新信号", desc: "查看算法扫描的研究空间", tool: "reason", toolLabel: "创新识别", how: "面板的「创新信号」按信号词（尚未/空白/争议/有待）标出研究空间位置。" },
    { title: "查看创新点", desc: "查看四类创新点", tool: "reason", toolLabel: "创新识别", how: "面板的「创新点」给出概念/视角/方法/框架四类创新建议与学术价值。" },
    { title: "验证新颖性", desc: "确认创新点未重复", tool: "ask", toolLabel: "Ask 检索", how: "对候选创新点用 Ask 检索「是否已有类似研究」，确认新颖性。" },
    { title: "沉淀创新定位", desc: "写入知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录：理论局限/创新点清单/创新定位，纳入论文创新点章节。" },
    { title: "创新评估技能", desc: "用想法评估技能验证创新性", tool: "skills", toolLabel: "技能库 · idea-evaluator", how: "用「idea-evaluator 想法评估」技能对识别出的创新点做五维评估（新颖性/影响力/可行性/成本/广度），与面板的创新信号检测对照，确认创新定位站得住。" },
  ]
},
{
  id: "S65",
  title: "理论体系建构",
  group: "理论思辨拓展",
  goal: "将分散的理论命题整合为自洽的理论框架，梳理核心概念与逻辑关系，检测体系一致性",
  steps: [
    { title: "输入命题", desc: "填写主题与命题（每行一条）", tool: "reason", toolLabel: "体系建构", how: "在理论思辨拓展场景用「理论体系建构」输入主题与理论命题（每行一条，至少 2 条）。" },
    { title: "查看框架", desc: "查看整合的理论框架", tool: "reason", toolLabel: "体系建构", how: "面板展示整合后的理论体系框架与核心概念定义。" },
    { title: "查看逻辑关系", desc: "查看命题间的逻辑关系", tool: "reason", toolLabel: "体系建构", how: "面板的「命题逻辑关系」梳理命题间的支撑/推导/并列关系。" },
    { title: "检查一致性", desc: "查看算法检测的张力", tool: "reason", toolLabel: "体系建构", how: "面板的「命题张力」标出矛盾信号，确认体系自洽性说明与薄弱环节。" },
    { title: "沉淀理论体系", desc: "写入知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录：理论框架/核心概念/逻辑关系/自洽性/薄弱环节，作为论文理论建构章节。" }
  ]
},
{
  id: "S66",
  title: "政经C刊选题",
  group: "政经C刊科研",
  goal: "基于马理论C刊选题方法论（四步法/理论接口/选题矩阵/悖论选题/编辑校验）生成有发表潜力的选题",
  steps: [
    { title: "输入热点概念", desc: "输入时代热点/政策概念", tool: "cjournal", toolLabel: "政经C刊科研", how: "在「政经C刊科研」tab 的「四步法选题」输入时代热点（如 人工智能、算力、耐心资本），系统按四步法生成选题：时代问题→政经对象→经典理论→中间机制。" },
    { title: "查看选题与机制", desc: "查看生成的选题与中间机制", tool: "cjournal", toolLabel: "政经C刊科研 · 四步法", how: "查看面板输出的选题标题与四步推导（特别是第四步中间机制：A通过什么机制改变B），确认有理论纵深而非政策解读。" },
    { title: "选题矩阵扩展", desc: "用选题矩阵做系列开发", tool: "cjournal", toolLabel: "政经C刊科研 · 矩阵", how: "在「选题矩阵」输入核心概念（如 人工智能），生成母题+系列选题（×劳动/×时间/×消费/×治理），形成连续研究主线。" },
    { title: "悖论问题提炼", desc: "用悖论选题找问题张力", tool: "cjournal", toolLabel: "政经C刊科研 · 悖论", how: "在「悖论选题」输入观察到的现象，生成「为什么A却B」式悖论问题与题目（如 数字官僚主义式命名），确认选题有张力。" },
    { title: "编辑三标准校验", desc: "用编辑标准检验选题", tool: "cjournal", toolLabel: "政经C刊科研 · 校验", how: "在「编辑校验」输入候选题目，用编辑三标准（时代紧迫性/理论解释力/现实指导价值）校验，未通过的调整后复检。" },
    { title: "匹配期刊定位", desc: "按期刊口味匹配投稿目标", tool: "cjournal", toolLabel: "政经C刊科研 · 期刊", how: "在「理论接口·期刊·种子」查看期刊定位匹配（党校学报偏统战/东南学术偏学理/经济纵横偏热点），选匹配的目标期刊。" },
    { title: "沉淀选题档案", desc: "存入知识页", tool: "truth", toolLabel: "知识页", how: "在知识页记录选题档案：选题/四步推导/矩阵/悖论/编辑校验结果/目标期刊，作为论文写作的基础。" }
  ]
}
];
