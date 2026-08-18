# 种子语料（Seed Corpus）

> 与**评测金标数据集同源**的 50 篇文献（`evaluation/gold_dataset.json` 53 题的出题论文），
> clone 后无需私有文献即可完整体验 MarxSphere 的四源检索（SAG + Graphiti + Cognee + PG）。

## 内容

- **50 篇论文**，每篇 1化6 产物（`original.md` 全文 + `摘要.md` + `术语表.md` + `问答.md`），共 200 个 Markdown 文件
- 主题：资本规范与引导、资本治理（2012—2026 年）
- 目录：`examples/seed-corpus/资本规范与引导、资本治理/`

## 一键入库

```bash
# 1. 启动数据库
docker compose up -d

# 2. 入库（直连 PG :5540，无需服务在跑）
npx tsx examples/seed-corpus/ingest-seed-corpus.ts

# 3. 启动服务后体验
npm run dev
# → Ask 检索 / 52 步推理 / 知识图谱 即可检索这批语料
```

- **幂等**：重复执行只更新不重复插入
- 每篇论文以 `.original.md` 正文入库为独立 source，摘要/术语表/问答作为 metadata 附加
- 入库后可用 `evaluation/gold_dataset.json` 的 53 题进行评测验证（`npx tsx scripts/eval-32-metrics.ts`）

## 体验示例

入库后可直接询问：

- 「根据该论文，马克思对资本本质的界定与古典政治经济学家的根本区别是什么？」
- 「规范地方法人金融机构资本构成对策的调查思考中，资本充足率下降的直接原因是什么？」
- 「在社会主义市场经济条件下规范和引导资本健康发展的路径有哪些？」

以上均为评测金标题目，可对照 `evaluation/gold_dataset.json` 的参考答案验证检索质量。

## 来源与合规

- 语料为**公开学术期刊论文**，包含作者与出处信息（各 `original.md` frontmatter）
- 用途：**功能演示与技术验证**，非商业再分发
- 若您持有其中某篇版权并希望移除，请在 Issue 中说明，我们将立即删除对应文件
