---
name: marx-ingest-all
description: "Use when 需要将 ov_import 文件系统下的文献一键同步入库至 Cognee、Graphiti 和 paper_id_map 三库；Don't use when 仅需单库更新或源文件非 ov_import 真源；e.g. 输入文件夹名 \"10ab12cd34ef\" 自动生成 paper_id \"10ab12cd34ef\" 并完成三库联动；耗时约 15 分钟/500 篇，成本约 ¥2（API 调用），NUL 清洗 + 429 重试 + 幂等三重保障。"
triggers: [入库, 新增文献, 三库同步, 文献入库, 一键入库, 批量入库, 同步知识图谱]
notTriggers: [纯编程, 通用聊天, 检索查询]
category_zh: 知识图谱
origin: self-made
title_zh: 一键三库联动入库
---

# marx-ingest-all — 一键三库联动入库

> **版本**: V2 | **日期**: 2026-08-06 | **核心原则**: ov_import 文件系统为唯一真源
> **流水线上游**: cnki → pdf2obsidian → md-clean → 本 skill → (Cognee/Graphiti 就绪) → marx-sag 检索
> **当前进度**: 500 篇批量入库进行中（2026-08-06 已入库 200+，batch-ingest-log.json 监控）

## 零、定位与全链路

### 0.0 mermaid 流程图（2026-08-06）

```mermaid
graph LR
    CNKI[cnki 下载] --> P2O[pdf2obsidian 1化6]
    P2O --> CLEAN[md-clean 清洗 4文件]
    CLEAN --> OV[ov_import 唯一真源<br/>D:/Desktop/ov_import]
    OV --> MAP[rebuild_paper_id_map<br/>md5[:12] 确定性映射]
    OV --> COG[Cognee<br/>add + cognify<br/>Neo4j 11003+LanceDB]
    OV --> GRAPH[Graphiti<br/>chunk+实体+蒸馏+超边<br/>Neo4j 11001]
    MAP --> PG[(PG documents<br/>paper_id 对齐)]
    COG --> SAG[marx-sag 推理检索]
    GRAPH --> SAG
    PG --> SAG
```

### 0.1 ASCII 全链路

```
cnki 下载 → pdf2obsidian 转MD → md-clean 清洗 → ov_import 落地
     ↓
【本 skill】marx-ingest-all 一键三库同步
     ├── Cognee (Neo4j 11003): add + cognify（知识图谱+向量）
     ├── Graphiti (Neo4j 11001): chunk + 实体抽取 + 五层蒸馏
     └── PG/paper_id_map.json: 确定性 paper_id 映射
     ↓
marx-sag 推理工作台（四路分调检索）
```

**核心价值**：新增文献只需丢进 `ov_import`，一条命令同步三库，paper_id 三库对齐。

## 零·A、前置依赖与环境自检（每次入库前必跑）

> 共 9 项依赖。全部通过才允许执行 `orchestrate_ingest.py --all`。
> 任一 FAIL → 先修复再入库（修复指引见 §八 踩坑记录）。
> 统一环境变量：`PY=%USERPROFILE%/cognee/.venv312/Scripts/python.exe`（所有脚本共用此 venv）。
> PG 连接串：`postgres://sag_lite:sag_lite_pass@127.0.0.1:5540/sag_lite`

### 依赖1：ov_import 唯一真源目录（500 篇基准）

两个分类目录必须存在，`*.original.md` 计数 = 500（208 + 292）。

```bash
# 两个分类目录存在 + 计数（通过标准：输出 208 和 292，总计 500）
for d in "D:/Desktop/ov_import"/*/; do echo "$(find "$d" -name '*.original.md' | wc -l)  $d"; done
find "D:/Desktop/ov_import" -name "*.original.md" | wc -l    # 通过标准: 500
```

### 依赖2：paper_id_map.json 可写（SAG-main 根目录）

```bash
# 通过标准: 文件存在 且 -w 有写权限
[ -f "%USERPROFILE%/SAG-main/paper_id_map.json" ] && [ -w "%USERPROFILE%/SAG-main/paper_id_map.json" ] && echo OK || echo FAIL
```

### 依赖3：orchestrate_ingest.py 存在（SAG-main/scripts/）

```bash
# 通过标准: 输出 OK
[ -f "%USERPROFILE%/SAG-main/scripts/orchestrate_ingest.py" ] && echo OK || echo FAIL
```

### 依赖4：Cognee API 可用（Neo4j 11003 + LanceDB 目录）

```bash
# 通过标准: 输出 "Cognee 11003 ok" 且无异常
$PY -c "
from neo4j import GraphDatabase
d=GraphDatabase.driver('bolt://127.0.0.1:11003',auth=('neo4j','neo4j123'))
d.verify_connectivity(); print('Cognee 11003 ok'); d.close()"

# LanceDB 目录（通过标准: 输出真实路径，至少一个存在）
ls -d "%USERPROFILE%/cognee/cognee/.cognee_system/databases/cognee.lancedb" \
      "%USERPROFILE%/cognee/.cognee_system/databases/cognee.lancedb" 2>/dev/null
```

### 依赖5：Graphiti 可用（Neo4j 11001）

```bash
# 通过标准: 输出 "Graphiti 11001 ok" 且无异常
$PY -c "
from neo4j import GraphDatabase
d=GraphDatabase.driver('bolt://127.0.0.1:11001',auth=('neo4j','neo4j123'))
d.verify_connectivity(); print('Graphiti 11001 ok'); d.close()"
```

### 依赖6：PG 可用（PostgreSQL 5540 + documents 表）

```bash
# 通过标准: 输出 "documents count: N"（N>0）且无异常
$PY -c "
import psycopg2
conn=psycopg2.connect('postgres://sag_lite:sag_lite_pass@127.0.0.1:5540/sag_lite')
cur=conn.cursor()
cur.execute('select count(*) from documents'); print('documents count:',cur.fetchone()[0])
cur.close(); conn.close()"
```

### 依赖7：API Key 状态（数据库 ai_provider_settings 优先）

> **重要**：LLM/Embedding 配置以 PG `ai_provider_settings` 表为准，改 `.env` 无效（踩坑 #11）。
> 通过标准：`llm_api_key` 与 `embedding_api_key` 均非空（True）。

```bash
$PY -c "
import psycopg2
conn=psycopg2.connect('postgres://sag_lite:sag_lite_pass@127.0.0.1:5540/sag_lite')
cur=conn.cursor()
cur.execute(\"select llm_model, embedding_model, (llm_api_key is not null and length(llm_api_key)>10), (embedding_api_key is not null and length(embedding_api_key)>10) from ai_provider_settings where id='global'\")
print(cur.fetchone())
cur.close(); conn.close()"
```

### 依赖8：LLM 超时 300s（llm_timeout_ms=300000）

> 改 `.env` 无效，必须在数据库表改（踩坑 #9）。低于 300000 会导致长文档抽取 abort。

```bash
# 通过标准: 输出 300000（即 300s）
$PY -c "
import psycopg2
conn=psycopg2.connect('postgres://sag_lite:sag_lite_pass@127.0.0.1:5540/sag_lite')
cur=conn.cursor()
cur.execute(\"select llm_timeout_ms from ai_provider_settings where id='global'\")
print(cur.fetchone()[0])
cur.close(); conn.close()"
```

### 依赖9：batch-ingest-log.json 可写（监控日志）

```bash
# 通过标准: 输出 OK
[ -w "%USERPROFILE%/SAG-main/batch-ingest-log.json" ] && echo OK || echo FAIL
```

### 前置依赖一键自检（全 9 项）

```bash
# 全部通过的输出含 9 个 OK：目录计数 208/292/500 + paper_id_map 可写 + 编排器存在
# + 双 Neo4j 连通 + PG 计数 + 双 key 非空 + llm_timeout_ms=300000 + 日志可写
PY=%USERPROFILE%/cognee/.venv312/Scripts/python.exe
for d in "D:/Desktop/ov_import"/*/; do echo "$(find "$d" -name '*.original.md' | wc -l)  $d"; done
find "D:/Desktop/ov_import" -name "*.original.md" | wc -l
[ -f "%USERPROFILE%/SAG-main/paper_id_map.json" ] && [ -w "%USERPROFILE%/SAG-main/paper_id_map.json" ] && echo OK || echo FAIL
[ -f "%USERPROFILE%/SAG-main/scripts/orchestrate_ingest.py" ] && echo OK || echo FAIL
[ -w "%USERPROFILE%/SAG-main/batch-ingest-log.json" ] && echo OK || echo FAIL
$PY -c "
from neo4j import GraphDatabase
for port,label in [(11003,'Cognee'),(11001,'Graphiti')]:
    d=GraphDatabase.driver(f'bolt://127.0.0.1:{port}',auth=('neo4j','neo4j123'))
    d.verify_connectivity(); print(label,port,'ok'); d.close()"
$PY -c "
import psycopg2
conn=psycopg2.connect('postgres://sag_lite:sag_lite_pass@127.0.0.1:5540/sag_lite')
cur=conn.cursor()
cur.execute('select count(*) from documents'); print('documents count:',cur.fetchone()[0])
cur.execute(\"select llm_timeout_ms, (llm_api_key is not null and length(llm_api_key)>10), (embedding_api_key is not null and length(embedding_api_key)>10) from ai_provider_settings where id='global'\")
print('timeout/llm_key/emb_key:',cur.fetchone())
cur.close(); conn.close()"
```

## 零·B、入库状态自检（监控/续跑前）

### ① documents 表入库计数

```bash
# 通过标准: 数字随批量入库增长（2026-08-06 基准: 228，目标 500）
$PY -c "
import psycopg2
conn=psycopg2.connect('postgres://sag_lite:sag_lite_pass@127.0.0.1:5540/sag_lite')
cur=conn.cursor()
cur.execute('select count(*) from documents'); print('documents:',cur.fetchone()[0])
cur.close(); conn.close()"
```

### ② batch-ingest-log.json ok/fail 统计

```bash
# 通过标准: ok 随入库增长，fail 不增长（2026-08-06 基准: ok=215, fail=1167）
$PY -c "
import json
from collections import Counter
d=json.load(open('%USERPROFILE%/SAG-main/batch-ingest-log.json',encoding='utf-8'))
c=Counter(x.get('status') for x in d)
print('total:',len(d),'ok:',c.get('ok',0),'fail:',c.get('fail',0))"
```

### ③ 入库进程存活检查

```bash
# 通过标准: 有 python 进程输出数字；任务完成后（基准 500 篇全入库）此检查自然为 0，属正常
tasklist //FI "IMAGENAME eq python.exe" 2>/dev/null | grep -c python.exe
# 或细粒度看具体脚本:
ps aux 2>/dev/null | grep -E "batch_extract|ingest_papers|orchestrate" | grep -v grep
```

## 一、核心机制

### 1.1 唯一真源 = ov_import 文件系统

```
D:\Desktop\ov_import\                ← 唯一真源（硬编码）
├── 资本下乡（2012—2026年6月）\         208 篇
│   └── 每篇一个文件夹，含 4 个 md:
│       <名>.original.md  / 摘要.md  / 术语表.md  / 问答.md
└── 资本规范与引导、资本治理（2012—2026年6月）\  292 篇
    └── 同上
```

**"论文目录"判定**：叶子文件夹内存在 `*.original.md` 即算一篇论文。
**扫描深度**：两层递归（顶层分类目录 → 论文文件夹）。**排除**：`.` 开头的隐藏目录。

### 1.2 paper_id 确定性 hash（三库对齐的锚）

```
paper_id = md5(folder_name)[:12]

例: "信息资本与无公害农药..._石志恒" → 787937c3844c
```

- **稳定可复现**：同一文件夹名永远生成同一 paper_id
- **重建安全**：`rebuild_paper_id_map.py` 对已存在的 `title == folder` 复用旧 id（保住 gold_dataset 引用），只给新论文生成新 id

### 1.3 三库对齐表（关键）

| 库 | 标识字段 | 对齐方式 |
|---|---|---|
| 文件系统 | 文件夹名 | 唯一真源 |
| paper_id_map.json | `title` | = 文件夹名 |
| Graphiti Neo4j | `Episode.source_folder` | = 文件夹名 |
| Cognee Neo4j | `TextDocument.title` | 含文件夹名 |

**对齐失败的症状**：verify 时"覆盖度 < 100%"或检索查不到——先查 source_folder/title 是否等于文件夹名。

## 二、前置检查（每次入库前）

```bash
# 0.1 数据库在线?
#     PostgreSQL :5540 (Docker)  — paper_id_map 存储
#     Neo4j Graphiti :11001
#     Neo4j Cognee :11003
curl -s http://localhost:7474/ 2>/dev/null   # Neo4j HTTP (11001/11003)
docker ps 2>/dev/null | grep -i postgres      # PG 容器

# 0.2 Python 环境（所有脚本统一用这个 venv）
PY=%USERPROFILE%/cognee/.venv312/Scripts/python.exe
$PY -c "import neo4j, cognee; print('env ok')"

# 0.3 残留进程清理（避免并行写库冲突）
taskkill /F /IM python.exe /FI "WINDOWTITLE ne *" 2>/dev/null
# 或检查: ps aux | grep -E "batch_extract|ingest|distill" | grep -v grep
```

**红线**：**不要**同时跑两个会话的入库（Graphiti 实体抽取写 Neo4j 会冲突）。

## 三、编排器 orchestrat_ingest.py（主入口）

位置: `%USERPROFILE%\SAG-main\scripts\orchestrate_ingest.py`（7 个 step 函数）

### 3.1 命令一览

```bash
cd %USERPROFILE%\SAG-main
PY=%USERPROFILE%/cognee/.venv312/Scripts/python.exe

$PY scripts/orchestrate_ingest.py --scan      # Step1: 只扫描，报新增/变更（安全，推荐先跑）
$PY scripts/orchestrate_ingest.py --map       # Step2: 扫描+重建 paper_id_map（安全）
$PY scripts/orchestrate_ingest.py --cognee    # Step3: Cognee 增量入库 (add+cognify)
$PY scripts/orchestrate_ingest.py --chunk     # Step4: Graphiti 切块+向量
$PY scripts/orchestrate_ingest.py --extract   # Step5: Graphiti 实体抽取（最耗时）
$PY scripts/orchestrate_ingest.py --distill   # Step6: Graphiti 五层蒸馏
$PY scripts/orchestrate_ingest.py --hyperedge # Step8: Graphiti 超边抽取 (V166+, 知识片段层)
$PY scripts/orchestrate_ingest.py --graphiti  # = --chunk --extract --distill --hyperedge 串行
$PY scripts/orchestrate_ingest.py --verify    # Step7: 三库完整性校验
$PY scripts/orchestrate_ingest.py --all       # 全流程（新增文献时推荐）
```

### 3.2 各 step 内部实现（排障参考）

| Step | 函数 | 行为 |
|---|---|---|
| 1 | `step1_scan()` | 递归扫 ov_import → 对比 map 的 title 集合 → 打印新增论文名 |
| 2 | `step2_map()` | 调 `rebuild_paper_id_map.py`（失败即 exit 1） |
| 3 | `step3_cognee()` | 调 `marx-cognee-ingest/scripts/ingest_papers_batch.py` |
| 4 | `step4_chunk()` | 调 `marx-graphiti/scripts/module_chunk_v2.py` |
| 5 | `step5_extract()` | 调 `marx-graphiti/scripts/batch_extract_full.py` |
| 6 | `step6_distill()` | 调 `marx-graphiti/scripts/distill_robust.py`，**PYTHONPATH 加 `D:\Desktop\执行流程`** |
| 7 | `step7_verify()` | 直连 11001/11003 查计数 + 覆盖度；map 缺失数 |

**运行细节**：
- 每个子脚本 `subprocess.run([PY, script])`，`PYTHONPATH=GRAPHITI_ROOT`，超时 7200s（2h）
- 输出只打印最后 2500 字符（`r.stdout[-2500:]`）
- 失败打印 rc 和 stderr 末尾 1000 字符
- 子脚本超时 → 打印 `[TIMEOUT]`，**不会**杀进程（需手动查后台）

## 四、子脚本清单与参数

| 脚本 | 路径 | 作用 | 关键参数/行为 |
|---|---|---|---|
| 编排器 | `SAG-main\scripts\orchestrate_ingest.py` | 主入口 | `--scan/--map/--cognee/--chunk/--extract/--distill/--graphiti/--verify/--all` |
| map 重建 | `SAG-main\scripts\rebuild_paper_id_map.py` | 确定性 hash | `title == folder` 才复用旧 id；递归扫描 |
| Cognee 入库 | `marx-cognee-ingest\scripts\ingest_papers_batch.py` | add+cognify | 30篇/批；断点续传 `.batch_cache.json` |
| Graphiti chunk | `marx-graphiti\scripts\module_chunk_v2.py` | 切块+向量 | 递归扫描；写 Chunk 节点 + CHUNK_OF 关系 |
| Graphiti 实体 | `marx-graphiti\scripts\batch_extract_full.py` | 实体+关系 | **有 checkpoint 断点续传**；LLM deepseek-v4-flash |
| Graphiti 蒸馏 | `marx-graphiti\scripts\distill_robust.py` | 五层蒸馏 | 递归扫描；PYTHONPATH 需含 `D:\Desktop\执行流程` |

**各脚本的详细排障**见对应 skill：
- `marx-cognee-ingest/SKILL.md`（Cognee 入库细节）
- `marx-graphiti/SKILL.md`（chunk/实体/蒸馏细节）

## 五、完整使用流程（新增文献场景）

### 场景 A：新增几篇文献 → 全量同步

```bash
# 1. 把新论文的 4-md 文件夹放进 ov_import 对应分类目录
# 2. 前置检查（§二）
# 3. 一键全流程
$PY scripts/orchestrate_ingest.py --all
# 4. 校验
$PY scripts/orchestrate_ingest.py --verify
```

### 场景 B：入库中断/卡死 → 断点恢复

```bash
# 1. 杀卡死进程（查 PID）
ps aux | grep -E "batch_extract|ingest" | grep -v grep
taskkill /F /PID <pid>

# 2. 看 checkpoint 剩余量
#    Graphiti: 查 batch_extract_full.py 的 checkpoint 文件
#    Cognee:   .batch_cache.json

# 3. 从断点续跑（脚本自带断点续传，重复跑不会重做已完成篇）
$PY scripts/orchestrate_ingest.py --extract
$PY scripts/orchestrate_ingest.py --verify
```

**经验**：
- 实体抽取卡死特征：日志停在某篇不更新 + CPU 零增长 → 不是预算停机（无 BUDGET 标记），是网络/DB 挂起 → 杀进程续跑
- 续跑后日志新开文件（如 `graphiti_full334d.log`），确认 `Total papers: N, Done: X` 的 X 是 checkpoint 值

### 场景 C：只检测不动库

```bash
$PY scripts/orchestrate_ingest.py --scan   # 纯读，永远安全
```

## 六、状态验证（--verify 解读）

```
磁盘论文: 500
Graphiti: 500 Episode, 39499 Chunk, 12326 Entity, 500 Distill
  覆盖: chunk 500/500, 实体 500/500, 蒸馏 500/500   ← 三个都 500/500 才算完整
Cognee:  11550 DocumentChunk, 31253 Entity
paper_id_map: 500 条, 论文缺失: 0                    ← 0 才算完整
```

**判定标准**：
- Graphiti 三项覆盖 = 磁盘论文数 → 通过
- map 论文缺失 = 0 → 通过
- 任一覆盖不足 → 定位缺哪篇（`source_folder`/`title` 对齐问题或脚本中途失败）

## 七、模型与成本（实体抽取）

| 组件 | 模型 | 单价 |
|---|---|---|
| 实体/关系抽取 | deepseek-v4-flash | ¥0.001/1K tokens |
| Embedding | text-embedding-v4 (MAAS) | ¥0.0007/1K tokens |
| 每篇 ~16K tokens | — | ≈ ¥0.016/篇 |
| 500 篇全量 | — | ≈ ¥8 |
| 预算上限 (config.py) | — | ¥10 |

**预算预停机**：成本累计超 ¥10 → `is_shutdown()` 触发 → 每篇 3-4s 快速 FAIL（不调 API）。**症状**：日志无 BUDGET 标记但连续快速 FAIL。直测 API 正常但脚本内快速失败 = 预算停机（区别于网络挂起卡死）。

## 八、踩坑记录

| # | 坑 | 症状 | 修复 |
|---|---|---|---|
| 1 | 目录递归扫描缺失 | 扫到 0 篇（论文在子目录） | `module_chunk_v2.py`/`distill_robust.py`/`rebuild_paper_id_map.py` 加递归 |
| 2 | paper_id 包含匹配吸收 | 短标题被长标题吸收（"实施意见"系列合并） | 改精确 `title == folder` 才复用 |
| 3 | checkpoint 非全量 | 实体抽取只处理了部分篇 | 另开窗口续跑剩余（断点续传） |
| 4 | 并行写 Neo4j 冲突 | 两会话同时入库数据错乱 | 严格串行，入库前 taskkill 残留 |
| 5 | 实体抽取卡死 | 日志停滞+CPU 零增长 | 杀进程，checkpoint 续跑 |
| 6 | 预算预停机误判 | 连续 3-4s FAIL 无 BUDGET 标记 | 直测 API 区分：API 正常+快速失败=预算；API 超时+挂起=网络 |
| 7 | **NUL 字节 (\x00)** | PG text 不接受，UTF8 错误/JSON 解析失败（13 篇文档含） | batch-ingest 上传前 `content.replace(/\x00/g, "")` |
| 8 | **429 限流** | INGEST_CONCURRENCY 默认 5 太高 | 降为 2（.env），脚本加重试（30s 等待） |
| 9 | **LLM 超时 60s 太短** | 长文档抽取 abort（单篇空耗 889s）→ 500 → 重试死循环 | **数据库 llm_timeout_ms=300000**（V260，改 .env 无效！） |
| 10 | **MAAS 欠费** | embedding 400/403 AccessDenied + LLM 402 | 查余额/充值；DeepSeek LLM 独立可用 |
| 11 | **数据库配置优先** | 改 .env 不生效（ai_provider_settings 表优先） | 改数据库表 embedding_base_url/api_key |
| 12 | **幂等三重保障** | 重复入库堆积 | findDocumentByTitle 预检 + upsert 冲突更新 + 唯一索引 documents(title, source_id) |

## 九、当前基准（V500，2026-08-06 更新）

```
磁盘论文: 500
Graphiti: 500 Episode, 21337 Entity, 39499 Chunk, 500 Distill, 1085 Community, 11702 HyperEdge, 166631 关系（2026-08-06）
Cognee:  11550 DocumentChunk, 31253 Entity, 248417 关系（2026-08-06）
PG:      200+/500 已入库（batch-ingest 进行中，documents 表）
paper_id_map: 500 条
```

**注**：2026-08-06 全量 500 篇入库进行中（batch-ingest-log.json 监控，~200 篇完成）。LLM 超时已修 300s，速度 ~2 分钟/篇。

## 十、关联

- **marx-cognee-ingest**：Cognee 入库细节（批次/断点/成本）
- **marx-graphiti-ingest**：Graphiti 入库监控（6阶段/方案B）
- **marx-cognee / marx-graphiti**：入库完成后的检索与 MCP 工具
- **marx-sag**：入库数据 → 推理工作台
- **md-clean**：入库前的 md 清洗（本 skill 上游）
- **pdf2obsidian**：PDF→Obsidian（更上游）
