# full/ 深度逆向资产索引(2026-09-08 全量逆向)

> 与 deep/(真机 DOM 采集)互补: full/ 是**代码层逆向**(chunk 全量下载+格式化+逻辑解码)。
> 采集法: 11 路由 headless 遍历收集资源 → 33 JS/CSS 全量下载 → prettier babel 格式化 →
> 子代理逐行精读产出实现逻辑解码。

## 原始资产(格式化 JS, 可读源码)
- `formatted/` 在 probe 目录, 仓库内为根级格式化副本:
  - EditorView-CaKgg_bg.js(40843 行, 学术编辑器整包含 TipTap/ProseMirror)
  - ReviewView-B4QyxKEn.js(37255 行, 审稿整包含 PDF.js/docx-preview/jsonrepair)
  - QuickModeView-DJU6Ms4b.js(18020 行, DAG 画布; L1-13472=vue-flow 库本体)
  - MaterialsView/WorkspaceView/SectionsView/InputView/FinalizeView/VizView/StatisticsView/
    FloatingAssistant/LibraryHome/index-CppOCefa(共享 task 面板等)
- CSS scoped(每组件局部样式, UI 样式体系核心): 11 个文件, 类族统计见下
- route-chunk-map.md: 11 路由 → 40 资源映射

## 解码文档(核心成果)
| 文件 | 内容 | 关键发现 |
|---|---|---|
| decoded-stats-viz.md | statistics 17 方法 + viz 绘图 | 17 方法请求体契约/SSE 13 事件/三线表 Word 导出 9000DXA/Python 异常中文翻译表/plotly 渲染链 |
| decoded-editor-review.md | editor + review + 审稿库 | 审稿库纯前端正则解析 6 类归槽/LLM 五级容错 JSON/编辑器独立后端 localhost:8000 + content_hash 乐观锁/1200ms 防抖保存/TipTap 装配 |
| decoded-workflow-quick.md | quick DAG 全解 | AgentFlowNode/Canvas 三组件/vue-flow 边界/消息 kinds 6 类/Phase1-5 主执行管线/POST /api/workflow/jobs/phase2~4 |
| decoded-workflow-materials.md | 素材准备 | 素材 CRUD/生成/文献解析流程 |
| decoded-workflow-workspace-finalize.md | 创作+合稿 | 章节生成/合稿/导出流程 |
| decoded-workflow-INDEX.md | 索引 | 跨文档导览 |

## 样式体系(CSS 解码, css-styles-decoded.md 361 规则)
- editor: ade- 体系 213 规则(布局变量 280/420px、topbar sticky、三栏)
- quick: 48KB 最大(agent-flow-node 190px、canvas-context-menu 220px、start-gate 440px)
- review/statistics/viz: 各 3-6KB 语义类(-mb/-sm 后缀、三线表)
- 主色: 深藏青 #1e4d8c/#9bb8d8(非 indigo, 二次覆盖 tailwind)

## 共享基建(跨模块, index-xpWAkSSw.js)
- API: q()=fetch /api+url + Bearer skf_auth_token; 401→auth-expired 广播
- 任务体系: GET/POST /tasks?module=x + nodes KV + switch/release-lock
- module 枚举: workflow/review/statistics/viz/knowledge/editor
- 素材导入: POST /workflow/versions/artifacts/import
- confirm: 全局 tc()(无头安全)
