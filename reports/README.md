# 评测报告样例

这里的 4 份是**脚本输出样例**，不是工程记录 —— 留着是因为前端要读它们。

## 谁在读

前端「评测 → 学习引擎」面板经 `GET /api/eval/reports` 读它们，渲染四张卡：

| 文件 | 面板卡片 | 生成脚本 |
|---|---|---|
| `significance_report.md` | 配对显著性检验 | `npx tsx scripts/significance.ts --before <a.json> --after <b.json>` |
| `failure_report.md` | 失败归因 | `npx tsx scripts/failure-attribution.ts` |
| `tp_report.md` | 轨迹前缀回归 | `npx tsx scripts/trajectory-prefix-eval.ts` |
| `kappa_report.md` | 评判者金标校准 | `npx tsx scripts/judge-calibration.ts` |

接口按 `reports/` → 根目录 的顺序找（见 `src/api/server.ts` 的 `/api/eval/reports`），
所以放这里与放根目录等效，放这里更整齐。

## 删了会怎样

接口返回 `{"files":[]}`，前端四张卡**全部空白**，而且**不报错** ——
看起来像"还没跑过评测"，实际是文件没了。
2026-09-30 清工程记录时误删过一次，已恢复，故留此说明。

## 两个必须同步的地方

文件名写死在两处，**改名要同时改**：

- `src/api/server.ts` 的 `EVAL_REPORT_NAMES`（防目录穿越白名单）
- `web/src/components/LearningToolsSection.tsx` 的 `REPORTS` 映射表

## 另外三份**开发仓**不入库

`scripts/` 还会输出 `cross_judge_report.md` / `prompt_regression_report.md` /
`skill-audit-report.md` —— 那三份**没有任何读取方**（前端不读、白名单里也没有），
跑脚本时落在根目录即可，不必提交。它们各自的内容是：

| 文件 | 是什么 | 生成脚本 |
|---|---|---|
| `cross_judge_report.md` | 异源交叉评判（主 judge vs qwen）的逐题分歧率 | `npx tsx scripts/cross-judge.ts` |
| `prompt_regression_report.md` | 提示词变更后的快速回归通过情况 | `npx tsx scripts/prompt-regression.ts` |
| `skill-audit-report.md` | 技能 description 四要素完整性审计 | `npx tsx scripts/audit-skill-descriptions.ts` |

⚠ **开源仓库里这三份是历史遗留**（2026-08 之前就在那儿了，早于"开发仓不入库"这个决定），
2026-09-30 决定**保留**：它们是评测统计，不含工程记录 / 外部产品对照 / 自审交接，
公开着没有风险，而撤掉反而会让引用过的人困惑。于是两仓在这一点上**有意不一致** ——
`sync-open.mjs` 每次会把这 3 个报成"残留"，那是预期的，**不要照它提示去删**。
