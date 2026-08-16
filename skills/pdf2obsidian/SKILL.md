---
name: pdf2obsidian
description: "PDF批量转换为Obsidian笔记：解析中文论文PDF→Markdown→元数据提取→AI摘要/术语表/问答→写入本地Obsidian库，每篇1化6产出（original.md/摘要.md/术语表.md/问答.md/index.md/信息.md，2026-08-06确认）。Use when 需将多篇中文论文PDF系统化整理为可检索、带摘要和问答的Obsidian笔记库。Don't use when 输入为扫描版图片PDF（无OCR层）、非中文论文、或仅需单文件快速转换无需结构化产出。e.g. 输入10篇CVPR中文论文PDF，输出60个Markdown文件，含每篇的AI摘要、术语表、问答及索引页。耗时约3-5分钟/篇（视PDF页数和API调用），成本约¥0.1-0.5/篇（AI摘要与问答API费用）。"
triggers: [PDF转Obsidian, 论文转换, PDF解析, 批量转换]
category_zh: 知识管理
origin: self-made
title_zh: PDF转Obsidian笔记
---

# pdf2obsidian — PDF 批量转 Obsidian 笔记

> 解析中文论文 PDF → Markdown → 元数据提取 → AI 摘要/术语表/问答 → 写入本地 Obsidian 库

## 何时使用

- 用户要求把 PDF 批量转换为 Obsidian 笔记
- 中文论文 PDF 解析与入库准备
- 论文元数据提取（标题/作者/年份）

## 功能

1. 解析中文论文 PDF 为 Markdown
2. 提取元数据（标题、作者、年份等）
3. 生成 AI 摘要 / 术语表 / 问答
4. 写入本地 Obsidian 库（E:\1.Obsidian Vault）

## 产出格式（1化6，2026-08-06 确认）

每篇 PDF 产出 6 个文件：

| 文件 | 内容 | 用途 |
|---|---|---|
| `{标题}_{作者}.original.md` | 原文全文 | 入库主文件（Cognee/Graphiti/PG） |
| `摘要.md` | AI 摘要 | 文献库浏览 |
| `术语表.md` | 核心术语表 | 文献库浏览 |
| `问答.md` | 问答解析 | 文献库浏览 |
| `index.md` | 索引 | md-clean 剔除（不入库） |
| `信息.md` | 元数据信息 | md-clean 剔除（不入库） |

**清洗链路**：pdf2obsidian 1化6 → md-clean（裁 frontmatter + 剔除 index/信息）→ 4 文件入库 → marx-ingest-all 三库联动。

## 说明

- 输出为入库就绪格式（配合 md-clean 使用）
- 详见 `references/` 目录的详细文档
- 500 篇已全部转换（2026-08-06，批量入库进行中）

*Last updated: 2026-08-06 (1化6 产出格式确认)*
