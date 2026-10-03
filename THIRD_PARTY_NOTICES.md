# 第三方声明(Third-Party Notices)

本文件列出 SocioSeek 开发中借鉴/移植的开源项目及其许可义务。SocioSeek 遵循 **AGPL v3 + SocioSeek-Exception 商业授权**,对以下作品的借用已按各开源协议履行署名与声明义务。

---

## 0. SAG 底座(Zleap-AI, MIT)— 基础架构来源

- **仓库**: https://github.com/Zleap-AI/SAG
- **许可**: MIT License
- **使用方式**: **基础架构改造(跨语言全栈重写)** — 本地 SocioSeek 的检索内核基于 SAG 的"事件-实体索引 + 查询时动态超边"架构改造为 TypeScript 实现:事件中心混合检索(search-service)、三层推理检索链(inference-service)、MCP 服务器形态、chunk→event→entities 数据模型(events/event_entities 表)。
- **引入文件**(文件头均标注 "Based on Zleap-AI/SAG (MIT License)"):
  - `src/services/search-service.ts`(事件中心混合检索)
  - `src/services/inference-service.ts`(Cognee 粗检索 → Graphiti 精炼 → SAG 融合三层链路)
  - `src/mcp/server.ts`(MCP 服务器)
  - `src/db/repositories.ts`(事件/实体/关联表 SQL 与多跳检索)
  - `src/db/vector.ts`(向量检索)
- **MIT 义务履行**:
  - ✅ 版权与来源声明(本文件 + 文件头 "Based on Zleap-AI/SAG")
  - ✅ 许可文本归档 `THIRD_PARTY_LICENSES/mit.txt`
- **改造说明**: 原版为 Python(FastAPI + zleap-sag 引擎),本地为 TypeScript 重写并叠加自研能力(52 步推理状态机、三库图谱 Graphiti/Cognee、学习闭环、65 科研场景),已超出移植范畴,属架构级改造。上游持续更新(v1.8.4, 2026-08-30),本地按需回溯吸收。

---

## 0.1 GBrain(MIT)— 检索增强移植

- **仓库**: https://github.com/(GBrain 检索系统,上游仓库以实际来源为准)
- **许可**: MIT License
- **借鉴内容**: 检索增强纯函数(源码级移植)— 加权 RRF 融合(backlink/title/时间衰减/Chronicle 类型 boost)、RRF 公式(1/(k+rank))、别名消解(alias)、文本净化(sanitize)、查询意图分类与动态 k 调参。
- **引入文件**(文件头均标注 "从 GBrain 源码移植"):
  - `src/services/gbrain-boosts.ts`(加权 RRF + boost 链,移植自 gbrain search hybrid v0.43)
  - `src/services/rrf.ts`(RRF 融合)
  - `src/services/alias.ts`(别名消解)
  - `src/services/sanitize.ts` / `src/services/log-sanitizer.ts`(文本净化与日志脱敏)
  - `src/ai/rerank-client.ts`、`src/api/server.ts`(boost/rerank 调用点)
- **适配说明**: GBrain 的 boost 系数在 YC 创投语料上调参(backlink 0.05 / recency 半衰期 365d / chronicle 1.4/1.3/0.8),本地保留算法、系数中性可调(文件头有马理论/哲社科适配注释)。
- **MIT 义务履行**:
  - ✅ 版权与来源声明(本文件 + 文件头 "从 GBrain 源码移植")
  - ✅ 许可文本归档 `THIRD_PARTY_LICENSES/mit.txt`

---

## 0.2 PDF2Obsidian(yeora26/PDF2Obsidian, MIT)— vendor 完整引入

- **仓库**: https://github.com/yeora26/PDF2Obsidian
- **许可**: MIT License — Copyright (c) 2025 PDF2Obsidian Contributors
- **使用方式**: **vendor 完整保留 + 适配层** — 开源项目整体存放于 `vendor/pdf2obsidian/`(含上游 LICENSE),本地通过适配层复用其完整管线(importPdf):MinerU 解析 → 规范化 → 翻译 → Obsidian 导出 → 质量检查;适配层独立实现(不修改上游源码)。
- **引入文件**:
  - `vendor/pdf2obsidian/`(上游完整项目,LICENSE 保留)
  - `src/services/pdf2obsidian-adapter.ts`(适配层,文件头标注来源)
  - `src/services/p2o-service.ts` / `p2o-domain-engine.ts` / `mineru-go-adapter.ts` / `agent-pdf-tool.ts`(集成调用)
- **MIT 义务履行**:
  - ✅ 版权与来源声明(上游 LICENSE 随 vendor 保留 + 本文件 + 适配层文件头)
  - ✅ 许可文本归档 `THIRD_PARTY_LICENSES/mit.txt`

---

## 1. TraitTutor

- **仓库**: https://github.com/traittutor/traittutor
- **许可**: Apache License 2.0
- **借鉴内容**: 学习引擎核心设计(源码级移植)— BKT 概念掌握模型、确定性组件选择器、事件账本与强证据闸门、学习画布 UI、评估-校准结构不变量、组件白名单与答案服务端持有
- **移植文件**(文件头均标注 "借鉴 TraitTutor"):
  - `src/services/learning-evidence-service.ts`
  - `src/services/learning-selector-service.ts`
  - `src/services/learning-plan-service.ts`
  - `src/services/material-review-service.ts`
  - `src/services/education-intent-service.ts`
  - `src/services/education-compass-service.ts`
  - `src/services/spaced-repetition-service.ts`
  - `src/services/component-executor-service.ts`
  - `src/services/learning-events-graph-sync.ts`
  - `src/services/capability-registry-service.ts`
  - `web/src/components/LearningCanvas.tsx`
  - `web/src/learning.css`(设计类体系)
- **Apache 2.0 义务履行**:
  - ✅ 版权与来源声明(文件头注释)
  - ✅ 修改说明(注释标注 "源码移植/对照")
  - ✅ 本 NOTICE 文件
  - ✅ 上游 NOTICE 已保留(仓库根 NOTICE 文件)
  - ✅ Apache 2.0 完整文本归档于 THIRD_PARTY_LICENSES/apache-2.0.txt

## 2. LingxiLearn

- **仓库**: https://github.com/LingXi-Org/LingxiLearn
- **许可**: MIT License — Copyright (c) 2026 LingXi-Org
- **借鉴内容**: 验证债务(verification_debt)、内容寻址去重、闭式状态转移表、状态提案(proposal-only)、评测纪律(not_observed≠pass)、复习优先级单尺子、Capability 注册表与确定性候选生成、SVG 可视化产物、学习多 Agent 协作
- **移植文件**(文件头均标注 "借鉴 LingxiLearn"):
  - `src/services/spaced-repetition-service.ts`
  - `src/services/learning-evidence-service.ts`
  - `src/services/learning-plan-service.ts`
  - `src/services/education-eval-service.ts`
  - `src/services/capability-registry-service.ts`
  - `src/services/learning-agent-orchestrator.ts`
  - `src/services/component-executor-service.ts`
  - `src/services/material-review-service.ts`
- **MIT 义务履行**:
  - ✅ 版权声明保留(本 NOTICE + 文件头)
  - ✅ 许可文本随分发(MIT 全文归档于 THIRD_PARTY_LICENSES/mit.txt)

---

## 其他参考(未移植代码,仅设计参考)

| 仓库 | 许可 | 用途 |
|---|---|---|
| BizAtlas(商舆) | 无 LICENSE 文件 | 设计哲学参考(确定性计算/三级降级),未移植代码 |
| lingxi-nlp | 无 LICENSE 文件 | 极简会话后端,未移植 |
| lingxi-org 官网/灵犀学 | 网站 | 产品形态参考,未移植 |
| frowang(论文分享模式) | - | 分享链接交互模式借鉴,无代码复用 |

---

## 3. openai/codex(V400, 2026-09-01)

| 能力 | 许可 | 使用方式 | 引入文件 |
|---|---|---|---|
| Agent Loop 架构对齐(预算/压缩/钩子/权限/输入队列) | Apache 2.0 | 设计模式+阈值+提示词模板移植(源码为 Rust, 按模式 TS 自研) | `src/services/agent-reminder-service.ts`、`agent-elicitation-service.ts`、`agent-mailbox-service.ts`、`approval-cache-service.ts`、`agent-hooks.ts`(Stop/PreToolUse/PostToolUse/PermissionRequest)、`agent-guardian-service.ts`(熔断) |

- **Apache 2.0 义务履行**: ✅ 来源声明(本表 + 文件头"codex 对齐"标注) · ✅ 完整文本归档 `THIRD_PARTY_LICENSES/apache-2.0.txt` · ✅ 修改说明(注释标注对齐的 codex 文件:行号)
- **未复制 Rust 源码**: 仅移植设计模式/阈值(6_144/50K/90% 窗)/提示词模板, 无代码级复制

---

## 4. Rimagination 开源生态(V399, 2026-08-31)

| 仓库 | 许可 | 使用方式 | 引入文件 |
|---|---|---|---|
| [Rimagination/mineru-go](https://github.com/Rimagination/mineru-go) | MIT | 源码完整引入(修改: 增加 MINERU_TOKEN 兼容) | `vendor/mineru-go/mineru_api_convert.py` |
| [Rimagination/instsci](https://github.com/Rimagination/instsci) | MIT | 源提炼(裁减为无重依赖版, 新增 OpenAlex 源) | `vendor/instsci-oa/oa_fallback.py` |
| [Rimagination/scansci-pdf](https://github.com/Rimagination/scansci-pdf) | Apache 2.0 | 模块提炼(md_export 清洗逻辑 + search 参考) | `vendor/scansci-pdf/md_export.py`、`md_clean_cli.py` |
| [Rimagination/citation-lab](https://github.com/Rimagination/citation-lab) | 无 LICENSE 文件 | 方法论移植(三维核验: 元数据真伪/语境相关性/断言支持度, 纯自研实现) | `vendor/citation-lab/verify_claim.py`(自研) |
| [Rimagination/easymeta](https://github.com/Rimagination/easymeta) | MIT | 方法论移植(证据综合审计原则, 纯 Python 自研实现) | `scripts/empirical_metaanalysis.py`(自研) |
| [Rimagination/good-question](https://github.com/Rimagination/good-question) | MIT | 技能源码引入(仅加 title_zh/category_zh 元数据) | `~/.claude/skills/good-question/` |
| [Rimagination/good-story](https://github.com/Rimagination/good-story) | MIT | 技能源码引入(同上) | `~/.claude/skills/good-story/` |
| [Rimagination/gongwen-draft](https://github.com/Rimagination/gongwen-draft) | MIT | 技能源码引入(同上) | `~/.claude/skills/gongwen-draft/` |
| [Rimagination/bili-note](https://github.com/Rimagination/bili-note) | MIT | 技能源码引入(同上) | `~/.claude/skills/bili-note/` |
| [Rimagination/dy-note](https://github.com/Rimagination/dy-note) | MIT | 技能源码引入(同上) | `~/.claude/skills/dy-note/` |
| [Rimagination/thu-digitizer](https://github.com/Rimagination/thu-digitizer) | MIT | 技能源码引入(同上) | `~/.claude/skills/thu-digitizer/` |
| [Rimagination/ChatMem](https://github.com/Rimagination/ChatMem) | MIT | 仅设计参考(低 token 回忆架构), 未移植代码 | - |
| [Rimagination/chuan-check](https://github.com/Rimagination/chuan-check) | MIT | 仅设计参考(证据分级方法论), 未移植代码 | - |
| [Rimagination/ggmapcn](https://github.com/Rimagination/ggmapcn) | 见上游 | 仅评估(需 R+sf 环境, 未引入) | - |

- **MIT 义务履行**: ✅ 版权与来源声明(本表 + vendor LICENSE 保留) · ✅ 许可全文归档 `THIRD_PARTY_LICENSES/mit.txt`
- **Apache 2.0 义务履行**: ✅ 来源声明(文件头 + 本表) · ✅ 完整文本归档 `THIRD_PARTY_LICENSES/apache-2.0.txt`
- **citation-lab**: 上游无 LICENSE 文件, 已按"方法论移植+自研实现"处理, 文件头标注来源; 若上游后续补充许可, 按许可条款补充声明

---

## 附:MIT License(用于 LingxiLearn 声明)

```
MIT License

Copyright (c) 2026 LingXi-Org

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 附:Apache License 2.0 摘要(用于 TraitTutor 声明)

完整文本见 https://www.apache.org/licenses/LICENSE-2.0 。核心义务:
- 保留版权、专利、商标与归属声明
- 修改的文件需显著标注变更
- 衍生作品在相同条款下分发
- NOTICE 文件(若上游提供)不得修改

---

## 8. 论文格式检查(2026-09-03 移植, MIT)

本地 SocioSeek 的 .docx 论文格式检查器移植自以下 MIT 项目(完整 LICENSE 保留于 vendor/format-check/):

### 8.1 thesis-format-checker(emptyinkpot, MIT)
- **仓库**: https://github.com/emptyinkpot/thesis-format-checker
- **移植内容**: `vendor/format-check/thesis_format_checker/`(docx_inspector 样式提取 + standard/rules.py 49 条 Word 级规则 + yaml preset 体系)
- **用途**: .docx 样式级格式检查(页边距/字号/行距/缩进/页眉页码/封面字段/表格/图表题注/参考文献上标等)

### 8.2 thesis-format-fixer(kankanliuyi-lgtm, MIT)
- **仓库**: https://github.com/kankanliuyi-lgtm/thesis-format-fixer
- **移植内容**: `vendor/format-check/thesis-format-fixer/scripts/`(extract_template_rules.py 学校模板规则提取)
- **用途**: 从学校官方 .docx 模板提取可复用格式规则

### 8.3 china-thesis-docx-formatter(keyingshuzhi, MIT)
- **仓库**: https://github.com/keyingshuzhi/china-thesis-docx-formatter
- **移植内容**: `vendor/format-check/china-thesis/scripts/`(docx_rules.py / analyze_docx.py 模板规则 JSON 提取)
- **用途**: 从学校模板提取可审计规则 JSON

### 8.4 paper_format_agent(zxyasfas, MIT)
- **仓库**: https://github.com/zxyasfas/paper_format_agent
- **移植内容**: `vendor/format-check/paper_format_agent/`(格式化 pipeline + 内容指纹保护 + 评分报告)
- **用途**: 按规则自动格式化 .docx, 内容指纹保护证明正文未被改动
- **仓库**: https://github.com/keyingshuzhi/china-thesis-docx-formatter
- **移植内容**: `vendor/format-check/china-thesis/scripts/`(docx_rules.py / analyze_docx.py 模板规则 JSON 提取)
- **用途**: 从学校模板提取可审计规则 JSON

统一入口: `vendor/format-check/format-check-cli.py`(inspect / extract-text / extract-template 三子命令, 由 TS 后端 format-docx-service.ts 子进程调用)

---

## 9. 观澜 / Guanlan(MIT)— 中文互联网研究能力借鉴

- **仓库**: https://github.com/shenyangs/Guanlan
- **许可**: MIT License (Copyright (c) 2026 Guanlan Team)
- **使用方式**: **源码移植**(非整包 vendor)。Guanlan 是 Python CLI-first 的中文互联网研究底座
  (约 10 万行), 我们取其**正文抽取与质量判据的实现**, 逐函数转成 TypeScript 写入本仓既有服务
  (未整包引入, 未引入其 Python 运行时):
  - **信源路由**(`src/services/opinion-router.ts`): 意图 → 信源的映射思路, 以及
    "每个源标注 authority / sample / freshness 三维价值 + 「适合问什么 / 别拿它问什么」"的
    画像设计。**数据是我们自己的 28 个源**(Guanlan 的 50 域名/36 scope 与我们的源不重合)。
  - **热榜**(`src/services/hotboard-service.ts`): 榜单目录与 `evidence_role` 标注的设计
    (把"热榜是注意力样本、不是事实"做成结构化字段)。聚合端点 `newsnow.busiyi.world` 为
    Guanlan 所使用的公开第三方服务, 不属 Guanlan 代码。
  - **网页正文抽取 + 质量报告**(`src/services/web-read-service.ts`): **源码移植**自
    `guanlan/web/_legacy_web_impl.py` 的 `_extract_article_text` / `_extract_density_text` /
    `_text_body_score` / `_content_score` / `_content_candidates` / `_prefer_main_content` /
    `_drop_noise_blocks` / `_is_noise_content_line`, 以及 `guanlan/web/_read_impl.py` 的
    `assess_read_quality`(判据字段 `score / chars / cjk_chars / noise_hits / mojibake /
    weak / label` 与评分权重照搬)。
    ⚠ 移植时的一处**语义差异已在本仓注释与测试中记明**: 原文 `re.fullmatch(r"[\W_]+", line)`
    依赖 Python 3 正则的 Unicode 感知(`\w` 含 CJK), 而 JS 的 `\w` 只有 `[A-Za-z0-9_]` ——
    直译会让**所有中文行被判成噪声**。本仓改用 `/^[^\p{L}\p{N}]+$/u` 还原原语义。
    (本仓与其不同之处只有一处: 抓取走直连而非 Jina Reader, 因其主路在本网络环境不通。)
  - **网页归档**(`src/services/web-archive-service.ts` + `migrations/182_web_archive.sql`):
    快照序列 + 段落级偏移 + 差异比对的语义(其 `unchanged` 口径、`content_hash` 判据)。
  - **每日简报**(第二批, 2026-10-04): **源码移植**自 `guanlan/daily.py`(1960 行),
    逐函数转 TypeScript 写入 `src/services/daily-brief-service.ts` —— 采集归一
    (`_normalize_*_items`) / 指纹去重(`_merge_daily_items` / `_daily_fingerprint` /
    `_canonical_url`) / 打分排序(`_daily_score` / `_query_overlap_score` /
    `_topic_match_strict`) / **栏目配额选稿**(`_select_daily_items` / `_daily_section_caps`) /
    候补池(`_build_daily_overflow_items`) / 采编自检(`_build_editorial_health` /
    `_build_daily_source_health`) / 边界与下一步(`_daily_boundaries` / `_daily_next_steps`) /
    渲染(`format_daily_markdown` / `format_daily_context`)。配套移植:
    `guanlan/daily_quality.py`(548 行)→ `src/services/daily-quality-service.ts`(来源分层 A/B/C/D、
    时效分层、栏目归属、软 SEO 判据); `guanlan/daily_storylines.py`(409 行)→
    `src/services/daily-storyline-service.ts`(主线聚类、风险标记、置信度、动作建议、编辑决策卡);
    `guanlan/daily_history.py`(164 行)→ 同文件的 `buildHistoryDelta` / `recordDailyHistory`。
    前端 `web/src/components/DailyBriefPanel.tsx` 对应其 `daily_renderers.py` 的章节结构。
  - **主题 Wiki**(第二批, 2026-10-04): **源码移植**自 `guanlan/archive_wiki.py`(902 行),
    → `src/services/topic-wiki-service.ts` —— `build_archive_wiki` / `_enrich_wiki_record`
    (core/candidate 分档)/ `_group_by_topic` / `_wiki_record_priority` /
    `build_archive_wiki_context` + `format_archive_wiki_context`(证据包与「回答规则」)/
    `_write_llm_wiki` 及全部 `_render_llm_*`(purpose / schema / index / log /
    graph.json / manifest)/ `_build_llm_wiki_graph` / `_llm_wiki_entities` /
    `_record_entities`。前端 `web/src/components/TopicWikiPanel.tsx` 对应其 `_render_wiki_html`。
- **未使用的部分**: Guanlan 的 `search` / `research` / `stock` 等模块**未采用** ——
  它们依赖 Exa MCP 等外部付费服务, 而本仓已有自己的检索 provider 抽象
  (`src/services/search-provider-registry.ts`: bocha / tavily / exa)。
  其 `_run_daily_lane_searches`(同一 query 换 4 个 scope 各跑一遍的扇形检索)**未移植**:
  本仓的舆情检索一次要跑 28 个源, 扇形就是 4×28 次请求, 而换来的只是同一批源上多几个
  关键词变体。这是**有意的取舍**, 需要更宽覆盖时应在检索路由层做, 不在日报层叠请求。
- **移植时按本仓语境改过的地方**(行为与原版**不同**, 逐条记明以便与上游对照):
  1. **来源分层新增 `academic` 栏目**。原版栏目体系(A/B/C/D × official/ecosystem/community/
     trust/other)里没有学术这一档, 对科研平台会让文献被挤进 "ecosystem"。本仓把
     同行评审归 A、预印本归 B 并各自带边界文案。
  2. **自有域名/仿冒域名表换成可配置项**。原版那份是品牌监测的自有域名(`wps.cn` 等),
     本仓默认给政务与央媒 —— 对社科研究, A 层主体是"官方发布"而不是企业自述。
  3. **风险词表从「一词即触发」改为「强词一个 / 弱词两个」**。原版是品牌监测口径,
     通用检索下「安全」(行车安全/粮食安全)、「数据」这类词会导致近乎恒真的误报。
  4. **风险词匹配前剥掉网页样板文字**(版权声明/免责声明/责任编辑…)。中文主流站的摘要
     几乎全都带「版权所有」, 不剥的话 compliance 强词「版权」会把整个 B 层媒体判成合规风险。
  5. **`reputation` 组去掉「道歉」「舆情」并降为 medium**。原版把"网上有人投诉"当品牌当天的
     高风险事件; 对研究者「争议」只说明这事有分歧, 不构成风险。
  6. **今日简报历史落表而非写文件**。原版写 `~/.guanlan/daily/history.jsonl`(单机单用户),
     本仓是多用户服务, 落到 `daily_brief_history` 表按 user 隔离, 否则 A 用户的对比基准
     会掺进 B 用户的采集记录。**判据一行业未改**。
  7. **wiki 输出目录由服务端推导**(基目录 + buildId), 不接受调用方传路径 ——
     原版是 CLI, 路径是用户参数; 本仓是服务端, 可写文件的接口路径可控即任意写。
  8. **实体抽取去掉上游项目名**(「观澜」/guanlan), 否则每个 wiki 的头号实体都是它。
  9. **Chinese 无分隔符标题的簇键**: 原版的 4 字滑窗是位置相关的, 同事件的转载会各成一条
     主线(实测 2 条同事件标题聚成 2 条线); 本仓改用固定长度前缀(8 字)。
- **MIT 义务履行**:
  - ✅ 版权与来源声明(本文件 + 上述各文件头部注释均注明"对照开源项目 观澜/Guanlan, MIT")
  - ✅ 已登记**具体移植文件与函数名**(见上), 移植部分保留原文的判据与权重;
    上述 9 处**有意偏离**已逐条记明, 便于与上游对照与回溯
- **许可文本**: `THIRD_PARTY_LICENSES/mit.txt`(与第 0/0.1 节共用同一 MIT 文本)

> 本文件由 SocioSeek 团队维护(2026-10-04)。如有遗漏,请提交 issue 补充。

