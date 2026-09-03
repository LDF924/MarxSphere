# Zleap-AI/SAG 评审与落地总结

> 项目周期:2026-09-01 至 2026-09-02 ｜ 12 个 commit ｜ 32 文件 +2948/−271
> 关联文档:[ZLEAP-SAG-REVIEW.md](ZLEAP-SAG-REVIEW.md)(评审报告)· [BACKUP-RESTORE.md](BACKUP-RESTORE.md)(备份使用说明)

---

## 一、项目背景

对 GitHub 仓库 [Zleap-AI/SAG](https://github.com/Zleap-AI/SAG)(v1.8.4, 2444 星, MIT)做源码级评审,并落地其 5 项建议。评审核心结论:

- **本地 MarxSphere 的事件中心 RAG 架构源自 Zleap SAG 改造**(TypeScript 全栈重写),非独立实现
- 本地在检索深度(52 步推理/三库混合/学习闭环)与业务广度上远超上游;上游在**工程完备性、产品化封装、对外接口**上领先
- 结论:**回溯吸收上游演进,不值得重写**

## 二、评审产出

| 产出 | 说明 |
| --- | --- |
| [ZLEAP-SAG-REVIEW.md](ZLEAP-SAG-REVIEW.md) | 架构深读、双方关系定性、5 项差距对比、落地路线 |
| 合规修复 | THIRD_PARTY_NOTICES 引用文件名统一 + 补全 SAG 底座/GBrain/PDF2Obsidian 三条缺失声明 |

## 三、落地成果(5 项建议全部完成)

### P0:OpenAI 兼容端点(`293c9ade`)
- `POST /api/openai/chat/completions`(+ `/v1` 别名),把本地知识库当"模型"调用
- 响应含 `sag.citations`(sourceId/chunkId/heading/score),支持 SSE 流式
- 鉴权:`/api/openai` → reason 权限;配额 kind=reason;本机豁免
- 验证:openai SDK 2.30.0 非流式/流式实测 + 401/403 外部令牌测试

### P1:事件抽取提示词契约化(`4ffdab8e`)
- prompt/schema/entity_types 外移 `src/ingestion/prompts/` 单一真源
- 新增 zod 程序化校验(校验失败回退本地 + `schemaRejected` 日志)
- 系统提示词 3083 字符逐字一致;红线测试全绿
- 真实对比:改造后抽取质量 ≥ 改造前(LLM 结果 vs 本地回退)

### P1:知识库备份/恢复 .sagbak(`8f707547` + `ec7be6b6`)
- 格式:manifest.json(semver/sha256/行数/向量声明)+ pg_data.sql + schema.sql + neo4j JSONL
- PG 导出 docker exec pg_dump(18 万行 2.3GB 实测);Neo4j 分页拉取 JSONL
- 恢复 = 全量替换(校验→schema→数据→图谱→COUNT 复核),幂等
- 保留策略:BACKUP_KEEP 默认 3 份滚动,防磁盘堆积
- 与 E 盘每日 pg_dump 并存(补图谱备份 + 清单校验 + 手动触发 + 恢复流程)

### P2:MCP 工具补齐(`bb1e5e0f`)
- 新增 `sag_grep` / `sag_outline` / `sag_list_documents` / `sag_get_chunk`(10 工具总计)
- grep 用 tsvector GIN 索引(零新索引成本);get_chunk 限定 source
- 验证:MCP SDK Client 端到端 4 工具全通过

### P2:关系边向量剪枝(`fc11bdd5` + `2132df11`)
- `event_entities.embedding`(只写不读)首次启用:relationalFanout 按边-query 余弦相似度剪枝
- 阈值默认 0.35(`RELATIONAL_EDGE_THRESHOLD` 可调,0=禁用);不传 queryVector 完全向后兼容
- **全量 53 题评测 0.8841 与基线持平零退化**

## 四、收尾工作

| Commit | 内容 |
| --- | --- |
| `70443ac5` | README 三语版本基线统一(30 题 0.870 → 53 题 0.884) |
| `1555ab2c` | 阈值调优实验:4 道多跳题 × 0.3/0.35/0.4,**0.35 均值 0.903 最优**(0.3 噪音 −0.24, 0.4 剪光 recall=0) |
| `195c9d03` | OPEN-SOURCE-DISCLOSURE 同步(OpenAI 端点/备份/边剪枝/测试数 332) |

## 五、验证成果汇总

| 验证项 | 结果 |
| --- | --- |
| 全量 53 题评测 | **0.8841,与基线持平零退化**(边剪枝上线后) |
| 单元测试 | **332/332 全绿**(新增 39 个:备份 9 + 契约 14 + openai 12 + 边剪枝相关) |
| typecheck | 前后端全过 |
| OpenAI SDK 2.30.0 | 非流式/流式/引用/401/403 全实测 |
| MCP SDK | 10 工具端到端调用通过 |
| 真实备份 | 2.3GB 完成 + sha256 校验通过 |
| 抽取对比 | 契约化后质量 ≥ 改造前(LLM 结果 vs 本地回退) |

## 六、关键经验教训

1. **探索代理会漏系统层面事实**:E 盘每日备份(计划任务 SAG-PGBackup)被误判为"无备份机制"——用户纠正后补上"与现有机制并存"的设计
2. **评测脚本断点续传特性**:EVAL_QUESTIONS 只重跑指定题、旧题沿用旧结果——对比实验必须用 EVAL_OUTPUT 独立文件,否则结果被污染
3. **阈值必须数据驱动**:0.5 阈值假设被边分布标定推翻(p50 仅 0.26-0.38),最终 0.35 经 3 档实验确认
4. **schema 校验要守住行为红线**:zod 过严会改变"多 items 归一化"等既有行为——先跑红线测试抓回归
5. **git stash 误弹旧 stash 风险**:工作区干净时 `git stash pop` 会弹出历史 stash 造成冲突——用 worktree 做版本对比更安全

## 七、当前状态

- 服务运行中(4173,默认阈值 0.35),工作区干净
- 遗留可选:边剪枝阈值进一步细调(0.32/0.37)、OpenAI 端点接入 Dify 验证、备份恢复演练

---

*本文档由 Claude Code 整理(2026-09-02),供 MarxSphere 项目存档。*
