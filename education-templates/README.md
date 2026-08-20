# 教育场景模板（education-templates）

可复用的教育场景示例模板，供教育从业者/开发者直接参考与二次开发。
每份模板含：输入样例 + 预期输出 + 对应 API 路由。
数据均为模拟数据，不涉个人信息；复用需遵守 AGPL v3 + 商业授权双许可（见 LICENSE）。

## 模板清单

| 模板 | 场景 | API 路由 | 文件 |
|---|---|---|---|
| 作业辅导 | 题目解析（分步提示） | `POST /api/education/homework/solve` | [homework-solve.json](homework-solve.json) |
| 苏格拉底辅导 | 追问式引导 | `POST /api/education/agent/socratic` | [socratic.json](socratic.json) |
| 学情诊断 | 薄弱点分析 | `POST /api/education/diagnosis` | [diagnosis.json](diagnosis.json) |
| 教师备课 | 完整教案 | `POST /api/education/lesson-plan` | [lesson-plan.json](lesson-plan.json) |
| 学习陪伴 | 共情陪伴 | `POST /api/education/companion` | [companion.json](companion.json) |
