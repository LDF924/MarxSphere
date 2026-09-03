# 第三方声明(Third-Party Notices)

本文件列出 MarxSphere 开发中借鉴/移植的开源项目及其许可义务。MarxSphere 遵循 **AGPL v3 + MarxSphere-Exception 商业授权**,对以下作品的借用已按各开源协议履行署名与声明义务。

---

## 0. SAG 底座(Zleap-AI, MIT)— 基础架构来源

- **仓库**: https://github.com/Zleap-AI/SAG
- **许可**: MIT License
- **使用方式**: **基础架构改造(跨语言全栈重写)** — 本地 MarxSphere 的检索内核基于 SAG 的"事件-实体索引 + 查询时动态超边"架构改造为 TypeScript 实现:事件中心混合检索(search-service)、三层推理检索链(inference-service)、MCP 服务器形态、chunk→event→entities 数据模型(events/event_entities 表)。
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

> 本文件由 MarxSphere 团队维护(2026-08-31)。如有遗漏,请提交 issue 补充。
