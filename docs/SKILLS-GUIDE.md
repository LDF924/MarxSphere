# MarxSphere Skill 目录与导入指南

> 仓库自带 **10 个自研 Skill**（`skills/` 目录，已随源码分发、已进桌面端打包）。
> 外部 Skill（社区/第三方）不随包分发，本文档提供目录、链接与导入指南。

## 一、自研 Skill（10 个，随仓库/桌面端打包）

| Skill | 用途 | 依赖 |
|---|---|---|
| **marx-agent** | 马理论 AI Agent 总入口：统一调度 SAG 推理 + Ask 检索 + 科研场景 + 三库图谱 | 系统本身 |
| **marx-sag** | SAG 推理工作台：52 步推理链路 + 真实 token 采集 + 32 指标评测 | 系统本身 |
| **marx-graphiti** | Graphiti 知识图谱检索：超边/社区/实体推理问答 | Neo4j 11001 + LLM |
| **marx-graphiti-ingest** | Graphiti 批量入库：500 篇文档 6 阶段流程（断点续传/原子 checkpoint） | Neo4j + LLM |
| **marx-cognee** | Cognee 知识图谱检索：实体/切片混合检索（BM25 + 向量 RRF） | Neo4j 11003 + LanceDB |
| **marx-cognee-ingest** | Cognee 批量入库：分块 + 实体抽取 + 断点续传 + 完整性校验 | Neo4j + LLM |
| **marx-ingest-all** | 三库联动入库：ov_import 文献一键同步（Cognee + Graphiti + paper_id_map） | 三库 |
| **cnki** | 知网批量下载 PDF + 引文网络抓取（引证/共引/同被引） | Edge 浏览器 + 知网权限 |
| **pdf2obsidian** | PDF → Obsidian 笔记：解析/摘要/术语表/问答（1 篇 6 产出） | LLM |
| **md-clean** | 论文 Markdown 清洗：frontmatter 裁剪 + 文件精简（入库前准备） | 无 |

> **安装位置**：`skills/` 目录。桌面端安装包已含（`resources/sag/skills/`），Web 端随源码仓库。

## 二、外部 Skill（不随包，提供目录与链接）

以下为社区/第三方 Skill，与本仓库无依赖关系，按需获取：

| Skill | 来源 | 链接 | 说明 |
|---|---|---|---|
| Claude Code Skills | Anthropic 官方 | https://github.com/anthropics/skills | 官方 Skill 仓库（PDF/PPTX/XLSX/Docx 等） |
| Awesome Claude Skills | 社区合集 | https://github.com/awesome-claude-code/awesome-claude-skills | 社区 Skill 索引 |
| 网络检索/研究 | web-access 等 | 见各 Skill 仓库 README | 按需搜索获取 |

## 三、Skill 导入指南

### 3.1 自研 Skill（随仓库）——零导入

```bash
# 仓库 clone 后 skills/ 已就绪
ls skills/                # 10 个自研 skill

# 桌面端安装包已内置（resources/sag/skills/）
```

### 3.2 外部 Skill——三步导入

1. **获取**：从来源（如 anthropics/skills）clone 或下载目标 skill 目录
2. **放置**：复制到本仓库 `skills/<skill-name>/`（含 `SKILL.md`）
3. **验证**：重新启动服务，Skill 出现在技能面板

```bash
# 示例：导入官方 PDF skill
git clone https://github.com/anthropics/skills.git /tmp/skills
cp -r /tmp/skills/pdf /path/to/MarxSphere/skills/pdf
# 重启后「技能」面板可见
```

### 3.3 Claude Code 环境（个人用）

```bash
# 全局安装到 ~/.claude/skills/
cp -r skills/* ~/.claude/skills/
# 或项目级 .claude/skills/
```

## 四、Skill 与 MCP 工具的关系

- **Skill** = 提示词工作流（引导 Agent 调用系统能力），本仓库 10 个自研 skill 均围绕 MarxSphere 自身能力编排
- **MCP 工具** = 可编程接口（`/mcp` 标准 I/O），外部 Agent（Claude Code/Codex）可经 MCP 直接调用 MarxSphere 的推理/检索/教育能力
- 接入方式见 [docs/quickstart.md](quickstart.md)（MCP 接入）与 [docs/api-reference.md](api-reference.md)
