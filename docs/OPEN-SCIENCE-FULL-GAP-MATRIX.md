# open-science → MarxSphere 全能力差距矩阵(补充版)

> 承接 OPEN-SCIENCE-GAP-ANALYSIS.md 的"高价值精选",本文为**全量逐项对照**(30+ 维度)。
> 标注: ●=已有等价物 / ◐=部分有 / ○=缺 / —=不适用

## A. 平台/外壳层

| open-science 能力 | MarxSphere | 差距评价 |
|---|---|---|
| Tauri 2 桌面壳(mac/Win/Linux) | Electron 桌面壳(有,electron/ 目录) | ● 等价(技术栈不同,功能在) |
| OpenCode runtime sidecar(自带运行时) | 自有 agent 编排(22 工具)+ 外部 MCP | ● 等价(自研 vs 托管) |
| 项目工作区: import 现有文件夹 in-place(不复制) | 有 PG 入库/项目制 | ◐ 部分(无"导入任意文件夹为项目") |
| **无头 CLI `osd server`**(无显示器跑全工作台) | 有 4173 HTTP 服务(本机/局域网) | ◐ 部分(无专门 CLI 驱动命令) |
| **令牌网关远程访问**(LAN/手机浏览器,loopback 默认,只读/全权两种) | 有 API token 鉴权 + 局域网 IP 访问 | ● 等价 |
| **ACP 双向互操作**(驱动 Codex/Gemini CLI;或被 Zed/JetBrains 驱动) | 有 ACP 服务(acp-service.ts) | ● 等价 |
| 分屏平铺 N-ary + 拖拽停靠 + 每面板独立模型 | 单窗口 33 视图切换 | ◐ 部分(无多面板同时看) |
| 命令面板(command-palette) | 无(导航用菜单) | ○ 小缺口 |
| 7 语言 i18n(全 UI 静态打包几 KB) | 仅中英双语(t() 函数) | ◐ 部分 |
| 浅/暖/深三主题 + 每主题强调色 + UI 缩放 | 深浅两主题 | ◐ 部分 |

## B. 会话/历史层

| open-science 能力 | MarxSphere | 差距评价 |
|---|---|---|
| 多会话聊天/搜索历史/归档/恢复/导出 | 对话记录 + 检索(有) | ● 等价 |
| `@`文件引用 / `#`会话引用 / `/`命令 / `!` shell 模式 | 有 @语料库/技能引用 | ◐ 部分 |
| 会话级 git 无痕快照(专用 ref,不碰用户分支) | 有备份服务(非 git refs 级) | ◐ 部分 |
| **自动上下文压缩**(compaction block,可审计的摘要) | 有 context-compressor | ● 等价 |
| **历史缺陷自愈**(HistoryRepairBlock) | 有错误恢复(部分) | ◐ 部分 |
| /plan、/goal、/agent 模式 | 有预设模式(18 工具) | ● 等价 |

## C. 溯源/产物/复现层(open-science 最强区)

| open-science 能力 | MarxSphere | 差距评价 |
|---|---|---|
| **文件级 provenance.jsonl**(每次 write/edit 留痕,版本递增,越界拒绝) | 任务/审计日志,非文件级 | ○ **真缺口** |
| **环境锁**(实际用到的解释器 + pip freeze 内容寻址) | 有 python 运行时探测(agent-remote-exec) | ◐ 部分 |
| **runs 系统**(命令→白名单记 run;JSONL 真相 + SQLite 可弃索引 + 键集分页) | 任务队列 + 任务页 + 审计 | ◐ 部分(非 run 级) |
| **Reproduce 复现按钮**(生成预填 prompt 人机环,永不自动) | 无 | ○ 小缺口 |
| 产物 → 领域注册表 + 30 种查看器(molecule/FITS/VASP/基因组/qcode) | 有 PdfReader/图片/Markdown/CSV 查看 | ◐ 部分(无领域科学查看器) |

## D. 审查/质控层

| open-science 能力 | MarxSphere | 差距评价 |
|---|---|---|
| **fenced-JSON 审查协议**(任意 agent 消息末尾产出,前端卡片化) | 固定 UI 面板(引文核验/格式评测) | ○ **真缺口** |
| reviewer 只读 agent + 8 findings 限额 + checkpoint fork 后台审 | 有 agent guardian/reviewer | ◐ 部分 |
| traceability-review(引文可追溯,PDF 抽取+Crossref 解析) | 引文核验面板(citation-lab) | ● 等价(已做) |
| stats-integrity(execute-don't-interpret 铁律) | 实证工作台(部分统计检验) | ◐ 部分 |
| **integrity-auditor 取证三轨**(图像查重/数值尾数/量级/XLSX 聚合) | 无(引文核验只查引用存在) | ○ **真缺口,工具现成** |

## E. 研究流水线技能(ai4s-skills)

| 技能 | MarxSphere | 差距评价 |
|---|---|---|
| ai4s-agent 编排契约(slug 路径/披露一致性/单阶段直出) | 65 场景 + 12 服务,无统一路径契约 | ○ **真缺口(但非必需)** |
| research-explorer(宽方向→topic_matrix+预调研) | 有 V395 选题方法论 + 六方法 tab | ◐ 部分(缺矩阵化产物) |
| literature-survey(60+ 实引 PDF + 新鲜度门 ≥60% 近三年) | 综述场景(无 PDF/无新鲜度门) | ◐ 部分 |
| paper-writer(200+ 实引 PDF + G1-G8 门) | 论文写作场景 | ◐ 部分 |
| integrity-auditor(L1-L4 分级 + raw data 清单) | 论文质量检查(无图/数取证) | ◐ 部分 |
| mindmap-render | 前端图组件 | ● 等价 |

## F. 连接/生态层

| open-science 能力 | MarxSphere | 差距评价 |
|---|---|---|
| 浏览器控制(驱动你自己的 Chrome,profile/登录态保留,a11y 树读页) | 无(联网工具是 API 级,非浏览器驱动) | ○ **真缺口(需 Chrome)**,但马克思场景 API 检索够用 |
| MCP 连接器(精选开源 science MCP: paper-search/biomcp/FRED…) | 有 11+ MCP 工具(图谱/检索) | ● 等价(自己实现 vs 引用) |
| 审批对话框(approval-dialog) | 有 agent 审批门 | ● 等价 |
| Notebook(.ipynb 真文件 + 本地 kernel + uv 管理 Jupyter) | JupyterPanel + jupyter-service | ● 等价 |
| 远程计算(~/.ssh/config 注册+探测+提交任务) | agent-remote-exec(SSH/WSL) | ● 等价 |
| 查看器: DOCX/XLSX/PPTX | 有 pdf2obsidian/docx 支持 | ● 等价 |

## G. 总结:真缺口 Top 5(全量版)

按"open-science 有、MarxSphere 真没有 + 值得做"排序:

1. **文件级 provenance + 复现按钮**(溯源到文件,人机环复现) — 中工作量,信任核心
2. **integrity-auditor 取证三轨**(图像查重/数值取证,工具纯 Python 现成) — 低-中工作量,引文核验面板秒变"论文取证"
3. **fenced-JSON 审查协议**(通用结构化审查) — 低工作量,审查 UI 统一
4. **浏览器控制**(驱动 Chrome 读真实网页) — 中工作量,需 Chrome 依赖;马克思政策/期刊场景有用
5. **命令面板 + 多面板分屏**(桌面体验) — 中工作量,锦上添花

其余(领域查看器、i18n、git 快照等)为 ◐ 部分或低优先。
