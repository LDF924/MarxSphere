# 实证研究工作台增强 — 使用手册(V380+)

> MarxSphere 实证研究工作台从"方法执行器"升级为完整研究流水线。
> 前端入口: 工作台 → 「实证研究」(hash: #empirical-research), 左侧 11 区段导航。

## 1. 功能总览(10 功能)

| 区段 | 功能 | 关键机制 |
|---|---|---|
| 问卷生成器 | 按课题生成结构化问卷(题号/变量名/题干/选项/类型/跳转/衍生变量) | LLM + 结构后校验 + 重试 |
| 问卷识别 | 上传问卷文本自动识别主体/指标/变量结构 | 分块 LLM(≤8K字符/块) + 变量名去重 |
| 信效度 | 克隆巴赫α / KMO / Bartlett / 因子分析(主成分+varimax) | Python 实算(全手写) + LLM 解读 |
| 数据诊断 | 前期数据+田野信息 → 问卷问题/解决方案/补齐要点 | 缺失统计(TS) + LLM 诊断 |
| LLM插补 | 论文《基于大语言模型的国际信任民调数据插补》(杨锋等 2025)复现 | 缺失三分类 + LLM 逐条 + MICE/KNN/RF 对比 + 人工确认 |
| 变量敲定 | 被解释/核心解释/控制/识别策略 | LLM 四段式 + **白名单校验(反编造)** + 闸门 |
| 数据管道 | 缺失/缩尾/构造/筛选/描述五步 | Python 实执行 + Stata 模板下载 + verify 报告 |
| 回归 | 基准/FE/聚类SE/交互 + 稳健性/安慰剂/IV/事件研究模板 | LLM 生成 + **静态规则防呆** + Agent Debug |
| 证据账本 | 系数→代码/数据表/原始数据/文献 四维绑定 | **服务端按坐标读系数(禁手填)** + 闸门前置 |
| 方法执行 | 原 16 方法沙箱 | 不变 |

## 2. 人工闸门(4 节点)

选题 → 变量定义 → 识别策略 → 结果解释,状态机: `draft → locked → confirmed`,退回=回 draft + **级联回退后续节点**。每次操作写 audit 日志(含 before/after)。

- 通过前置: 数据管道/回归页依赖变量定义闸门;证据账本依赖结果解释闸门
- 前端: 各功能页底部 GateCard(锁定/确认/退回)

## 3. 反 hallucinate 三层防护

1. **白名单闸门(服务端强制)**: 所有 LLM 建议变量必须 ∈ 数据版本 columns; 失败 400 `VARIABLE_NOT_IN_DATA` 列出候选列, 不给二次机会
2. **系数防编造**: 证据账本 `add-from-result` 只收坐标 `{runId, tableIndex, rowIndex, colIndex}`, 数值由服务端从真实运行结果读取; 无手填接口
3. **静态规则防呆**: 聚类 SE 存在性 / N 注释样本量断言 / 交互项出现检查(不靠 LLM 自觉)

## 4. LLM 民调插补(论文复现)

- **方法**: 杨锋、侯煜欣、庞珣《基于大语言模型的国际信任民调数据插补》,《国际政治科学》2025年第4期(北大核心/CSSCI)
- **流程**: 缺失三分类(empty/junk/masked)→ LLM 逐条插补(上下文=该行其他变量+分布摘要+田野信息, 温度 0.2)→ 掩码重跑 15% 保真评估 → MICE/KNN/RF 对比 → 人工逐条确认
- **关键结论落地**: 空答→插补池; 乱答→不进池只警示(编码集比对); -88/-99→结构性排除; 横截面限制显式声明
- **论文发现对应**: LLM 在 MNAR 场景零样本优势(本实现通过掩码重跑保真评估验证); 本土模型优于国际模型(本实现用 DeepSeek)

## 5. API 一览

```
# 课题/问卷/数据
POST/GET /api/empirical/projects
POST /api/empirical/questionnaires/generate
POST /api/empirical/questionnaires/recognize
GET  /api/empirical/questionnaires?projectId=
POST/GET /api/empirical/data-versions

# 信效度/诊断/闸门
POST /api/empirical/reliability           # 异步轮询(复用 result/:taskId)
POST /api/empirical/diagnosis
POST /api/empirical/gates/upsert | /:id/lock | /:id/confirm | /:id/reopen | GET /gates

# 插补/变量
POST /api/empirical/imputation/start | /batch | /compare | GET /:runId
POST /api/empirical/variables/suggest | /save

# 管道/回归
POST /api/empirical/pipeline | /pipeline/stata | /pipeline/verify
POST /api/empirical/regression/generate | /run | /debug | GET /templates

# 账本/解释
POST /api/empirical/ledger/add-from-result | GET /ledger | /:id/update-refs | DELETE /:id
POST /api/empirical/ledger/citations | GET /ledger/citations
POST /api/empirical/interpretation/draft | /save
```

## 6. curl 快速验证

```bash
# 1. 建项目
curl -X POST localhost:4173/api/empirical/projects -H "Content-Type: application/json" \
  -d '{"title":"农村经营形态调查","topic":"调地意愿"}'
# 2. 生成问卷(20题, LLM ~60s)
curl -X POST localhost:4173/api/empirical/questionnaires/generate -H "Content-Type: application/json" \
  -d '{"projectId":"<PID>","topic":"二轮承包到期后农户调地意愿","nQuestions":20}'
# 3. 信效度(50份演示数据)
curl -X POST localhost:4173/api/empirical/reliability -H "Content-Type: application/json" \
  -d '{"data":{...},"scaleGroups":[{"name":"意愿","columns":["adj_willing","continue_will","abandon_right_will"]}]}'
# 4. 变量敲定(白名单校验)
curl -X POST localhost:4173/api/empirical/variables/suggest -H "Content-Type: application/json" \
  -d '{"columns":["adj_willing","identity","edu"],"nRows":50}'
# 5. 回归生成+执行
curl -X POST localhost:4173/api/empirical/regression/generate -H "Content-Type: application/json" \
  -d '{"data":{...},"spec":{"dep":"adj_willing","core":["identity","edu"],"cluster":"hukou","model":"ologit"}}'
# 6. 证据账本(解释闸门 confirm 后)
curl -X POST localhost:4173/api/empirical/ledger/add-from-result -H "Content-Type: application/json" \
  -d '{"projectId":"<PID>","runId":"<RUN>","tableIndex":0,"rowIndex":1,"colIndex":1}'
```

## 7. 部署与数据

- **迁移**: 039-042 已应用(幂等, `npm run db:migrate`)
- **Python venv**: `<EMPIRICAL_PYTHON_DIR>`(empirical_runner.py 委托分发 reliability/imputation/datapipeline)
- **LLM**: DeepSeek 生态(callLlm, jsonMode, thinking disabled)
- **前端**: vite build --watch 自动重打包, 4173 实时生效

## 8. 已知边界

- Stata 代码为**可复现模板**(需 ssc install winsor2/estout/reghdfe), 本机不执行 Stata
- 插补为横截面版(无 CFPS 类纵向数据)
- Agent Debug 只修语法/API/变量名错误, 不做假设检验; 内生性/平行趋势由研究者判断
- 解释草稿禁用词(因果/导致/有效)命中即拒, 需人工改写为统计描述
