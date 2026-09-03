# 知识库备份与恢复(.sagbak)

> Zleap-AI/SAG 评审 P1 落地 — 参照 OCTX 设计契约(semver / 清单 / 完整性校验 / 向量兼容声明),用本地表结构实现的轻量备份格式。

## 备份内容

```
backups/sagbak_YYYYMMDD_HHMMSS.sagbak/
├── manifest.json        # 清单(semver / 各部分 sha256 / 行数统计 / 向量模型声明)
├── pg_data.sql          # PG 全量数据(pg_dump --data-only --column-inserts)
├── schema.sql           # PG 表结构快照(pg_dump --schema-only, 恢复时全量回放)
├── neo4j_graphiti.json  # Graphiti 图谱(JSONL: 节点+关系, 分页拉取)
└── neo4j_cognee.json    # Cognee 图谱(JSONL)
```

**边界**:Cognee LanceDB 向量库位于仓库外(COGNEE_DIR),不在备份范围内(manifest.warnings 明示)。

## 与现有 E 盘脚本的关系

`E:\SAG-backups\backup-pg.sh`(计划任务 SAG-PGBackup 每日 3:17)已覆盖 **PG 每日全量 + WAL 归档**,继续保留作为兜底。本方案补充:

- **Neo4j 图谱备份**(Graphiti/Cognee 两库,原无任何保护)
- **清单 + 校验**(sha256 逐部分验证,原 dump 无完整性元数据)
- **手动触发 + API + 前端面板**(原仅计划任务)
- **恢复流程**(原无恢复演练)

## 使用

### CLI

```bash
npx tsx scripts/backup-now.ts          # 全量(需 Neo4j 容器运行)
npx tsx scripts/backup-now.ts --pg-only  # 仅 PG(Neo4j 未启动时)
npx tsx scripts/restore-verify.ts      # 恢复演练(独立测试库, 不碰生产)
```

### API(需 admin 权限;本机豁免)

```bash
# 创建备份(异步任务, 202 + 轮询 GET /api/jobs)
curl -X POST http://127.0.0.1:4173/api/backup -H "Content-Type: application/json" -d '{}'

# 列表
curl http://127.0.0.1:4173/api/backup

# 校验完整性(重算 sha256 对比 manifest)
curl http://127.0.0.1:4173/api/backup/<id>/verify

# 恢复(异步, 全量替换! 恢复前自动重新校验)
curl -X POST http://127.0.0.1:4173/api/backup/<id>/restore

# 删除
curl -X DELETE http://127.0.0.1:4173/api/backup/<id>
```

### Web 面板

知识中心 → 备份/恢复:创建备份、查看列表(时间/大小/各部件 sha256/行数)、校验、恢复(二次确认)、删除。

## 恢复流程(全量替换, 幂等)

1. **校验**:重算各部分 sha256 对比 manifest,不符即中止
2. **schema 重建**:psql 回放 schema.sql(老备份无则 TRUNCATE 核心表)
3. **PG 数据**:psql 流式导入 pg_data.sql(`--column-inserts` 保证 FK 顺序)
4. **Neo4j 重建**:`DETACH DELETE` 清空 → 节点流重建(收集 id 映射)→ 关系流重建
5. **校验**:PG COUNT 对比 manifest.rows + Neo4j 节点/关系数
6. 更新 restored_at

> ⚠ 恢复是破坏性操作(全量替换生产数据),仅 admin 可执行,恢复前强制重算 sha256。

## 恢复演练(推荐定期执行)

`npx tsx scripts/restore-verify.ts` 在**独立测试库**(`sag_lite_restore_test`)上完整演练恢复流程,不碰生产:

1. 取最新备份 + sha256 完整性校验
2. 建测试库 → schema 回放 → pg_data 流式导入(2.3GB/18 万行约 15 分钟)
3. 6 张核心表行数与 manifest 对比(全部一致 = 恢复链路可靠)
4. 清理测试库

2026-09-02 首次演练通过:sources 1 / documents 503 / chunks 7555 / entities 66002 / events 7550 / event_entities 101261 全部对齐。

## 注意事项

- **保留策略**:默认只保留最近 **3 份**备份(`BACKUP_KEEP` 环境变量可调,0=不清理),创建新备份后自动删除最旧的——避免每日备份堆积撑爆磁盘。E 盘脚本是覆盖模式(永远 1 份),本方案是滚动保留 N 份。
- Neo4j 容器未运行:默认备份失败并提示启动命令(`docker compose up -d neo4j-graphiti neo4j-cognee`),或 `--pg-only` / `includeGraphs:false`
- 备份非一致性点:PG/Neo4j 分时导出,期间写入可能造成轻微不一致(manifest 记录时间戳);建议低写入期执行
- 恢复后前端需刷新页面;Neo4j 连接池无脏缓存
- 向量数据依赖 embedding 模型(MAAS v4 1024d),manifest.embedding 声明;更换模型后旧向量不兼容
- 备份过程不占宿主机内存(pg_dump 在容器内流式写文件,峰值 < 50MB)
