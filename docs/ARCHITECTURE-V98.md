# MarxSphere 架构归档 — GBrain 机制 + 检索增强

> ⚠️ **历史归档**（2026-08-02）：V98 版本改动记录，供回滚参考。
> 当前架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

> 日期：2026-08-02
> 版本：V98（在 基础上新增 7 项机制）
> 说明：本档记录本次全部改动，供后续维护与回滚参考。

## 一、改动总览

| # | 机制 | 类型 | 文件 | 状态 |
|---|------|------|------|------|
| A | Compiled Truth + 时间线 | 新功能 | `truth-service.ts` + `010_knowledge_pages.sql` + `TruthPanel.tsx` | ✅ |
| B | Skillify 技能固化 | 新功能 | `scripts/skillify.ts` + `skills-service.ts` + SkillsPanel 表单 | ✅ |
| ① | 标题独立检索臂 | 检索增强 | `search-service.ts` + `repositories.ts` | ✅ |
| ② | 多路 RRF 融合 | 检索增强 | `rrf.ts` + `search-service.ts` | ✅ |
| ③ | 时间衰减加权 | 检索增强 | `rrf.ts` + `search-service.ts` + `repositories.ts` | ✅ |
| ④ | 别名消解 | 检索增强 | `alias.ts` + `search-service.ts` | ✅ |

## 二、新增文件清单

### 后端服务
- `src/services/rrf.ts` — RRF 融合 + gauss 时间衰减纯函数
- `src/services/alias.ts` — 别名消解（entity_norm_dict.json）
- `src/services/truth-service.ts` — Compiled Truth + Timeline 核心
- `src/db/repositories.ts` — 新增 `searchEventsByText`（BM25 臂）+ created_at

### 数据库
- `migrations/010_knowledge_pages.sql` — knowledge_pages + page_entries 两表
 - knowledge_pages: 页面（Compiled Truth 区，可改写）
 - page_entries: 时间线（证据轨迹，只追加）

### 前端
- `web/src/components/TruthPanel.tsx` — 知识页面板（truth + 时间线）
- `web/src/components/SkillsPanel.tsx` — 加 Skillify 表单
- `web/src/App.tsx` — 加"知识页"标签（现 10 个）
- `web/src/lib/api.ts` + `types.ts` — truth + skillify API

### 脚本/工具
- `scripts/skillify.ts` — Skillify CLI 生成脚本
- `scripts/sag-env-healthcheck.sh` — 环境健康检查

## 三、检索机制技术细节

### RRF 三臂融合（search-service.ts step6）
```
candidateIds = unique([...seedEventIds, ...expanded.eventsetIds])
臂1 content_vector: coarseRankEventsByContent (内容向量余弦)
臂2 title_vector: searchEventsByTitleVector (标题向量)
臂3 bm25_text: searchEventsByText (search_text 全文检索)
→ reciprocalRankFusion(k=60) → 过滤到候选集合 → 时间衰减
```

### 时间衰减
```
gaussTimeDecay(createdAt, sigma=365天):
 boost = exp(-0.5 * ((ageDays/sigma)^2))
applyTimeDecay: final = score * (1 - 0.15 + 0.15 * decay)
```

### 别名消解
```
aliasNormalize(query):
 1. 整词查 entity_norm_dict.json（743 条）
 2. 括号别名形式 "x（别名）" 归一
→ effectiveQuery 用于实体召回 + BM25 臂
```

## 四、API 端点

### Compiled Truth + Timeline
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/truth/pages` | 页面列表 |
| POST | `/api/truth/pages` | 创建页面 |
| GET | `/api/truth/pages/:id` | 页面 + 时间线 |
| GET | `/api/truth/pages/title/:title` | 按标题查 |
| PUT | `/api/truth/pages/:id/compiled-truth` | 重写 Compiled Truth |
| POST | `/api/truth/pages/:id/entries` | 追加时间线 |

### Skillify
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/skills/skillify` | 生成 skill |

## 五、验证记录

- RRF 纯函数：3 臂命中排前，armsHit 正确 ✅
- 时间衰减：昨天→1.0，10年前→0.0 ✅
- 别名：merton（1987）→ merton ✅
- truth-service 全链路：建页→证据→重写→3 时间线 ✅
- skillify CLI：生成符合规范 SKILL.md ✅
- 全量 typecheck + vite build：0 错误 ✅

## 六、运行与回滚

### 运行
```bash
cd %SAG_ROOT%
npm run typecheck # 类型检查
npx tsx src/db/migrate.ts # 应用迁移（010 已应用）
npx tsx src/index.ts # 启动后端 :4173
```

### 回滚
- 检索机制：`search-service.ts` 的 step6 恢复纯向量粗排即可（备份在 git）
- Compiled Truth：`drop table page_entries; drop table knowledge_pages;` + 删路由
- 所有改动均为增量，不破坏 既有功能（推理走 inference-service 独立）

## 七、已知限制

1. 时间衰减用 `created_at`（入库时间）代理，非论文年份；事件 `start_time` 列存在但未回填
2. 别名消解依赖 `entity_norm_dict.json` 现有 743 条（文献引用归一为主，领域别名待扩充）
3. RRF 效果需跑 eval-22metrics 对比确认（未评测，因后端当前未运行）
