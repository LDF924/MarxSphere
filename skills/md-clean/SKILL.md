---
name: md-clean
description: "清洗 Obsidian 论文 Markdown → 入库就绪格式：裁剪 frontmatter 至仅 title + paperTitle，剔除 .index.md / _信息.md，保留 original + 摘要 + 术语表 + 问答 4 文件；pdf2obsidian 每篇 1化6 产出，本 skill 清洗后 4 文件入库，为 marx-cognee-ingest 和 marx-graphiti-ingest 做数据准备。Use when 需将 pdf2obsidian 产出规范化、入库前 frontmatter 裁剪或论文 MD 清洗；Don't use when 输入非 pdf2obsidian 产出、需保留 index/信息文件、或仅需单文件转换；e.g. 将某篇论文的 6 个 MD 文件清洗为 4 个标准文件并裁剪 frontmatter；耗时约 1-2 分钟/篇，成本约 ¥0（本地运行）。"
triggers: [清洗MD, 清洗Markdown, 入库准备, frontmatter清理, 论文MD清洗, 规范化MD, 裁剪frontmatter]
notTriggers: [清洗PDF, PDF转Markdown, 概念查询, 语义搜索]
category_zh: 知识管理
origin: self-made
title_zh: Obsidian论文清洗
---

# md-clean Skill — Obsidian 论文 Markdown 清洗入库

> **定位**：将 pdf2obsidian 产出的完整 Obsidian Markdown（每篇 1化6：original.md/摘要.md/术语表.md/问答.md/index.md/信息.md）清洗为双引擎入库就绪格式（最小化 frontmatter，仅保留 `title` + `paperTitle`，剔除 index/信息 2 文件）。参考已清洗的「资本下乡」500 篇文献格式。

## 一、调用决策

```
用户说"清洗MD"/"入库准备"/"裁剪frontmatter"
  │
  ├─ 情况 A：用户明确指定了源目录和目标目录
  │   → 直接执行 clean_md_for_ingest.py <source> <target>
  │
  ├─ 情况 B：用户只指定了源目录，未指定目标
  │   → 确认目标路径后执行
  │
  ├─ 情况 C：用户未指定任何路径，但在 Obsidian 课题文献库上下文中
  │   → 根据记忆中的 pipeline 推断路径，与用户确认后执行
  │
  └─ 情况 D：用户问"这是什么"/"怎么用"
      → 输出本文档的清洗规则摘要
```

## 二、清洗规则

对每个论文子目录 `{标题}_{作者}/`：

| 源文件 | 操作 |
|---|---|
| `{标题}_{作者}.original.md` | **保留**，删除 frontmatter 中除 `title`/`paperTitle` 外的所有字段 |
| `摘要.md` | **保留**，同上清理 frontmatter |
| `术语表.md` | **保留**，同上清理 frontmatter |
| `问答.md` | **保留**，同上清理 frontmatter |
| `{标题}_{作者}.index.md` | **剔除**（不入库） |
| `{标题}_{作者}_信息.md` | **剔除**（不入库） |
| `*.log` | **跳过** |
| 其他非目录文件 | **跳过** |

### Frontmatter 清洗细节

源 frontmatter（pdf2obsidian 产出，~12 行）：
```yaml
---
title: ...
paperTitle: ...
translatedTitle: ...
lang: zh-CN
sourceHash: sha256:...
sourcePdf: ...
indexNote: ...
createdAt: ...
detectedSourceLanguage: zh-CN
translationSkipped: true
---
```

清洗后仅保留：
```yaml
---
title: ...
paperTitle: ...
---
```

## 三、执行

```bash
python "${CLAUDE_SKILL_DIR}/scripts/clean_md_for_ingest.py" "<source_dir>" "<target_dir>"
```

### 参数说明

| 参数 | 说明 | 示例 |
|------|------|------|
| `source_dir` | pdf2obsidian 产出的 Markdown 目录（含子目录） | `E:\Obsidian Vault\...\Markdown` |
| `target_dir` | 清洗后输出目录 | `D:\Desktop\ov_import\课题名称` |

### 输出示例

```
[1] 论文标题A_作者A
[2] 论文标题B_作者B
...
[292] 论文标题Z_作者Z

Done. Total dirs: 292, success: 292, errors: 0
```

## 四、验证

清洗完成后自动验证：

1. **目录数一致**：`ls <target> | wc -l` ≈ 源目录数
2. **每目录 4 文件**：`original.md` + `摘要.md` + `术语表.md` + `问答.md`
3. **无残留**：`find <target> -name "*.index.md" -o -name "*_信息.md" | wc -l` → 0
4. **Frontmatter 最小化**：`head -4 <target>/任意论文/*.original.md` 仅含 `title` + `paperTitle`

## 五、与下游 Skill 的衔接

```
pdf2obsidian (PDF → Obsidian MD)
      │
      ▼
md-clean (裁剪 frontmatter + 剔除索引文件)  ← 本 Skill
      │
      ├─→ D:\Desktop\ov_import\{课题名称}\  (292 个文件夹 × 4 文件)
      │
      ▼
marx-cognee-ingest / marx-graphiti-ingest  (双引擎入库)
```

## 六、脚本

| 文件 | 用途 |
|------|------|
| `scripts/clean_md_for_ingest.py` | 单文件 Python 脚本，无外部依赖（仅标准库） |

### 可调参数（编辑脚本常量）

| 常量 | 默认值 | 说明 |
|------|--------|------|
| `KEEP_FILES` | `{".original.md", "摘要.md", "术语表.md", "问答.md"}` | 保留文件后缀匹配集 |
| `FRONTMATTER_RE` | `r"^---\s*\n(.*?)\n---\s*\n"` | YAML frontmatter 正则 |

## 七、踩坑记录与修复（2026-07-12）

md-clean 在双引擎入库流程中涉及以下故障：

| # | 故障 | 症状 | 修复 |
|---|------|------|------|
| 1 | 源目录含中文路径+空格 | Path 构造失败 | 前置检查自动规范化路径 |
| 2 | 目标磁盘空间不足 | 写到一半中断 | 前置检查 disk_usage，<100MB FATAL |
| 3 | 文件编码非 UTF-8 | UnicodeDecodeError 整篇跳过 | gbk 编码自动降级恢复 |
| 4 | Ctrl+C 中断残留 | 目标目录有半成品 | 覆盖式更新，不产生冲突 |
| 5 | 源目录无子文件夹 | 全量跳过无输出 | 前置检查 FATAL 退出 |
| 6 | frontmatter 非标准 YAML | 正则 miss 全篇丢弃 | 保留原文，不做修改 |

## 八、边界情况处理

| 情况 | 行为 |
|------|------|
| 无 frontmatter 的文件 | 直接复制，不做修改 |
| 文件名含特殊字符（`"` `：` `__`） | 原样保留，Windows 已支持 |
| 目标目录已存在 | 覆盖式更新 |
| 源文件读取失败 | 打印 `READ ERROR`，继续处理其他文件 |
| 源文件非 UTF-8 编码 | 自动尝试 gbk 编码恢复，恢复成功继续，失败跳过 |
| 源目录不存在 | FATAL 退出并提示 |
| 目标目录不可写 | FATAL 退出并提示 |
| 源目录无子文件夹 | FATAL 退出并提示 |

### 前置条件检查（运行前）

脚本启动时自动检查：源目录存在且包含子文件夹、目标目录可写。任一条件不满足立即 FATAL 退出，避免白跑。

### 自动自愈

- 非 UTF-8 文件自动尝试 gbk 编码恢复
- 已存在的目标文件覆盖式更新，不产生冲突

---

*与 pdf2obsidian、marx-cognee-ingest、marx-graphiti-ingest 配套，构成 PDF → 清洗 → 入库 → 检索完整闭环。*
*Last updated: 2026-07-12*
