# Elicit → MarxSphere 能力差距分析

> 2026-09-04 · 分析对象: Elicit(闭源 SaaS, elicit.com; Ought 孵化, CEO A. Stuhlmüller)
> 信息来源: 官网 + API docs + 独立评测(公开报道)
> 注: Elicit 闭源无源码, 本文为**机制/产品层对照**(哪些能力值得 MarxSphere 参考思路)。

## 一、Elicit 核心机制 vs MarxSphere 现状

| Elicit 能力 | 机制 | MarxSphere 现状 | 评价 |
|---|---|---|---|
| **语义文献检索**(138M 论文+54.5万临床试验) | 自然语言语义搜索, 过滤: 年份/期刊四分位/研究类型(RCT/综述/Meta)/关键词/有PDF/已撤稿排除 | 自建全文库(深) + external-sources(OA 回退 OpenAlex/Crossref) 检索广度弱(无 138M 元数据检索) | ◐ **真差距: 广度** |
| **数据提取成表**(核心卖点) | 研究问题 → 筛论文 → 提取字段(研究设计/样本量/干预/对照/结局/效应值)→ 可排序可导出表, 最多 20-30 列 | 引文核验/学术服务有提取, 但无"跨论文字段 → 可排序列对比表"工作台 | ○ **真差距(产品形态)** |
| **系统综述自动化**(PRISMA 2020) | 搜索→筛选(含排除理由引文)→双人筛查(ELicit 可做第二审稿人)→提取(每值一键链到源引用/图表)→PRISMA 流程图+CSV/XLSX 导出, 全程可审计 | 无(文献综述是生成式文本, 无"筛选-提取-流程图"阶段化工作流) | ○ **真差距** |
| **Elicit Reports**(deep research) | 问题 → 自动检索+筛选+提取+综合 → 报告(MD/PDF/DOCX, 句子级引用) | 有文献综述场景 + 写作工作台(新), 但无"证据综合报告(带句级引用链)" | ◐ 部分 |
| **引文轨迹**(citing/cited 网络) | 引用网络探索 | citation-graph-service(引用网络算法) | ● 有 |
| **API + MCP**(Search/Reports/SysReview 三端点) | 开发者可编程调用 | 有对外 API/MCP(sag-mcp) | ● 有 |
| **PDF 上传分析** | 私人 Library | 文献库入库 + 附件解析 | ● 有 |

## 二、真差距 Top 3(值得移植参考)

1. **跨论文字段提取对比表(综述矩阵自动化)** — Elicit 定义性功能: 把"N 篇论文的效应值/样本量/设计"提成一张可排序列。MarxSphere 有提取能力(实证/引文侧)但无此"表格化工作台"。**参考思路**: 做"文献提取矩阵"——选论文集 → 定义提取列(自定义, 如样本量/方法/结论) → LLM 逐篇提 → 表(可排序/导出 CSV) → 每格链到源文。
2. **筛选-提取-流程图阶段化系统综述流(PRISMA 式)** — 把综述从"生成文本"变"阶段化工作流": 检索记录数 → 去重 → 标题筛选(记录排除理由)→ 全文筛选 → 纳入集 → 提取。MarxSphere 的溯源/审计基建(provenance)可给每步留痕, 天然契合 PRISMA 可审计要求。
3. **句级引用报告(证据综合)** — 每句结论可点回来源(已有引文核验, 扩到"报告生成时句句绑定")。

## 三、Elicit 弱项(对我们反而是强项)
- 幻觉风险(80-90% 自称准确, 需人工核验)→ MarxSphere 反幻觉架构纪律 + 取证实证更硬
- 搜索不可复现(PRISMA 硬伤)→ MarxSphere provenance/快照天然可复现
- **理论/非实证领域弱(生物医学向)→ 马理论/人文社科恰恰是我们的主场**
- 正式综述严谨性不足 → 我们的溯源+格式自检是补强

## 四、建议(按价值排序)
1. **文献提取矩阵**(表格化提取对比) — 高价值, 人文社科适用(提取: 研究方法/核心概念/数据来源/主要结论)
2. **PRISMA 式筛选流**(阶段化 + 每步留痕) — 中高, 与溯源基建天然结合
3. 句级引用报告 — 中, 扩展现有引文核验

> 结论: Elicit 的"广检索+表提取+阶段化综述"是对 MarxSphere"深库+硬溯源"的**互补方向**; 建议优先做 #1 提取矩阵(体验级, 复用现有 LLM 提取 + 写作台表格)。

## 五、来源
- Elicit API 介绍 https://elicit.com/blog/elicit-api
- Elicit Research Agent https://elicit.com/blog/introducing-elicit-research-agent
- Elicit MCP README https://github.com/elicit/api-examples/blob/main/integrations/mcp/README.md
- PRISMA 2020 https://elicit.com/blog/systematic-review-for-prisma-2020
