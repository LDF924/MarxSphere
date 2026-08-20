# 常见问题（FAQ）

## 安装与启动

### Q1: `npm run quickstart` 后浏览器打不开怎么办？
1. 确认终端显示 `http://localhost:4173` 且没有报错
2. 手动打开 `http://localhost:4173`
3. 若端口被占：`netstat -ano | findstr 4173` 找到 PID，`taskkill /PID <PID> /F` 后重试

### Q2: 服务起来了但 `/health` 显示 `db: down`？
- PostgreSQL 未启动：`docker compose up -d` 启动数据库容器
- 连接串错误：检查 `.env` 的 `DATABASE_URL` 是否与 docker-compose.yml 一致（默认 `postgres://sag_lite:sag_lite_pass@localhost:5540/sag_lite`）

### Q3: 需要安装哪些软件？
| 必需 | 说明 |
|---|---|
| Node.js ≥ 20 | 运行环境 |
| Docker | 一键启动数据库（`docker compose up -d`） |
| **可选** | Python 3.12（推理 MCP 池/实证分析）、Neo4j（图谱增强，docker compose 已含） |

## 配置与密钥

### Q4: 哪些 Key 必须配？
- **LLM_API_KEY**（推理/对话）：不配则 AI 功能不可用
- **EMBEDDING_API_KEY**（向量检索）：不配则 Ask/推理检索不到结果
- 配置位置：`.env`（复制自 `.env.example`）

### Q5: 文献库/政策库/资料库页面是空的？
这三个页面扫描**本地文件夹**（不是数据库）。在 `.env` 配置路径指向您的文献目录：
```env
LITERATURE_DIR=D:\我的文献\学术期刊
POLICY_DIR=D:\我的文献\政策资料
VAULT_ROOT=D:\我的文献
```
- 不装 Obsidian 也行，指向任意文件夹即可
- 未配置时页面为空，但 **Ask 检索/52 步推理不受影响**（用种子语料）

### Q6: 启动时的「启动环境检查」警告是什么？
服务启动时自动检查配置，缺什么给什么提示（如 `⚠️ LITERATURE_DIR: 目录不存在`）。**不影响启动**，按提示配置对应项即可。

## 功能使用

### Q7: 怎么体验检索？（没有自己的文献）
仓库自带 50 篇种子语料：
```bash
npx tsx examples/seed-corpus/ingest-seed-corpus.ts
```
入库后 Ask 检索 / 52 步推理即可用。

### Q8: AI 对话没有回复？
1. 检查 `LLM_API_KEY` 是否配置且余额充足
2. 看浏览器 F12 控制台/Network 是否有报错
3. 换模型试试（输入区模型下拉切换）

### Q9: 推理/检索结果为空？
- 最常见：`EMBEDDING_API_KEY` 未配置（向量检索不可用）
- 或：语料未入库（先跑种子语料入库）

## 开发与发布

### Q10: typecheck 报 pdf2obsidian module-not-found？
vendor 编译产物未构建（gitignored）：
```bash
cd vendor/pdf2obsidian && pnpm install && pnpm -r --filter "./packages/**" build && cd ../..
```

### Q11: 怎么发新版本？
```bash
git tag v0.4.0
git push origin v0.4.0
```
CI 自动构建桌面端安装包并上传 Release（无需本地打包）。

### Q12: CI 是干什么的？
每次推送代码到 GitHub，自动运行：类型检查 → 154 单元测试 → 构建 → 浏览器冒烟测试。全绿显示 ✅，有问题显示 ❌——相当于免费的自动质检。

## 其他

### Q13: 桌面端和 Web 版什么关系？
同一套系统。桌面端（Electron）把 Web + 后端打包成安装包，双击即用，自动引导启动数据库。Web 版适合服务器部署。

### Q14: 数据存在哪？
- 文献/向量/实体：PostgreSQL（docker 卷 `sag_lite_pgdata`）
- 图谱：Neo4j（`sag_graphiti_neo4jdata` / `sag_cognee_neo4jdata`）
- 建议定期备份 docker 卷（`docker run --rm -v sag_lite_pgdata:/data -v $(pwd):/backup alpine tar czf /backup/pgdata.tar.gz /data`）

### Q15: 「AI+教育」是什么？怎么用？

顶部导航「**AI+教育**」Tab → 学生端「我的学习」/ 教师端「教师工作台」两个子 Tab：
- **学生端**：苏格拉底式五步打磨（记录→发散→验证→聚焦→压力测试）、作业辅导闭环（解析→错题→变式）、BKT 认知诊断、学习进度追踪、自动闭环周报、复习提醒、阅读/编程学习
- **教师端**：备课辅助（大纲/教案/课件/分层）、作业与考试（出题/批改/错题报告/组卷）、课堂互动（讨论题/随堂测验/总结）、思政内容四维核验、知识点先修图
- 每个功能区都有「Demo 演示」按钮，一键体验

### Q16: 教育功能需要额外配置吗？

不需要额外密钥——复用主系统的 LLM/Embedding 配置。部分能力需要：拍照识题走 SenseNova 视觉模型（`SENSENOVA_API_KEY`，未配则优雅降级提示）；口语测评需本地 whisper（`pip install faster-whisper`）。

### Q17: 教育数据安全吗？

教育数据合规（§4.2 设计）：学生数据匿名化（默认 `student_id`）、日志脱敏（`sanitizeLine`）、语音仅本地处理会话后即删、数据保留期自动清理（30 天可配）、`/api/education` 权限门控制访问。教育输出不替代教师/学校评价。
