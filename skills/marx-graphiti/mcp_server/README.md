# graphrag-marx MCP Server

马克思主义理论 GraphRAG 知识检索 MCP 服务器。为 Claude Code 提供 Neo4j 知识图谱的只读查询和轻量运维能力。

## 版本

- **Server**: v2.0
- **MCP Protocol**: stdio
- **Python**: >= 3.10
- **Dependencies**: `mcp >= 1.0`, `neo4j`, `requests`

## 部署

### 前置条件

1. Neo4j 运行在 `bolt://127.0.0.1:11001`（用户 `neo4j`，密码 `neo4j123`）
2. Python 环境已安装 `mcp` 包
3. `D:\Desktop\执行流程\pipeline\` 包可导入（`sys.path` 包含父目录）

### 注册（Claude Code）

在 `%USERPROFILE%\.claude\mcp.json` 中添加：

```json
{
  "mcpServers": {
    "graphrag-marx": {
      "type": "stdio",
      "command": "python",
      "args": ["-c", "import sys; sys.path.insert(0, r'D:\\Desktop\\执行流程'); from mcp_server.server import mcp; mcp.run(transport='stdio')"],
      "env": {
        "PYTHONIOENCODING": "utf-8"
      }
    }
  }
}
```

### 手动测试

```bash
cd D:\Desktop\执行流程
python -c "
import asyncio
from mcp_server.server import mcp
async def t():
    tools = await mcp.list_tools()
    resources = await mcp.list_resources()
    prompts = await mcp.list_prompts()
    print(f'{len(tools)} tools, {len(resources)} resources, {len(prompts)} prompts')
asyncio.run(t())
"
# Expected: 17 tools, 2 resources, 1 prompts
```

## API 参考

### 工具 (17)

#### 检索链（核心 GraphRAG 路径）

| 工具 | 说明 | 成本 |
|---|---|---|
| `search_by_concept` | 关键词匹配实体名/类别 | 免费 |
| `hybrid_search_entities` | 向量语义搜索+图扩展 | ~¥0.0001 |
| `get_entity_info` | 实体详情+1-hop邻居 | 免费 |
| **`get_distill_content`** | **五层文献蒸馏知识** | 免费 |
| **`get_domain_knowledge`** | **领域四层全局知识** | 免费 |
| `search_literature` | 论文元数据搜索 | 免费 |
| `get_paper_info` | 单篇论文详情 | 免费 |
| `run_cypher_read` | 自定义只读 Cypher | 免费 |

#### 质量与运维

| 工具 | 说明 |
|---|---|
| `get_pipeline_status` | 图库完整状态（节点/索引/模块） |
| `get_cost_dashboard` | API 成本仪表盘（RMB） |
| `run_quality_check` | 10 项数据质量检查 |
| `check_neo4j_health` | Neo4j 配置审计 |
| `check_md_integrity` | MD 文件完整性扫描 |
| `list_backups` | Neo4j 备份清单 |
| `get_cache_stats` | SQLite 缓存统计 |
| `run_env_check` | 环境快速验证 |
| `get_progress_report` | get_pipeline_status 别名 |

### 资源 (2)

| URI | 说明 | MIME |
|---|---|---|
| `graphrag://schema` | 图 Schema（节点/关系/属性） | application/json |
| `graphrag://status` | 图库实时状态快照 | application/json |

### Prompt 模板 (1)

| 名称 | 参数 | 说明 |
|---|---|---|
| `analyze_marxist_concept` | `concept: str` | 生成"分析某概念"的结构化 prompt |

## 架构

```
server.py
  ├── lifespan          → 启动健康检查 + 关闭清理
  ├── infrastructure    → Neo4j 单例 / 日志 / 输入校验 / Cypher 安全
  ├── resources (2)     → schema / status
  ├── prompt (1)        → analyze_marxist_concept
  └── tools (17)        → 按5类分组
```

关键设计决策：

- **惰性导入**：仅 `hybrid_search_entities` 加载 `QwenEmbeddingClient`（含 API 密钥），其余工具通过 `pipeline.neo4j` 直接连接
- **连接单例**：Neo4j 连接懒加载+线程安全，错误后自动重置
- **安全边界**：写操作正则拦截 + 参数注入检测 + 输入长度截断
- **错误不崩溃**：所有工具 `try/except` 返回结构化错误 dict，不抛异常

## 安全

| 层面 | 措施 |
|---|---|
| 数据 | 所有工具只读，写操作被 `_WRITE_RE` 拦截 |
| API Key | `hybrid_search_entities` 的 embedding key 在 lazy import 中，绝不返回 |
| 输入 | 参数截断（max 500 chars）、Cypher 注入关键词检测 |
| 日志 | 记录所有错误到 `.mcp_logs/`，不含 API 密钥 |

## 变更记录

### v2.0 (2026-07-01)
- 新增 `get_distill_content`、`get_domain_knowledge` 两个核心 GraphRAG 检索工具
- 新增 `lifespan` 生命周期管理
- 新增 `graphrag://schema`、`graphrag://status` 两个资源
- 新增 `analyze_marxist_concept` Prompt 模板
- 全面输入校验、日志、Cypher 注入防护
- 命名从 `kg-pipeline` → `graphrag-marx`

### v1.0 (2026-07-01)
- 初始 15 工具版本
