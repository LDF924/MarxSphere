# 第三方声明(Third-Party Notices)

本文件列出 MarxSphere 开发中借鉴/移植的开源项目及其许可义务。MarxSphere 遵循 **AGPL v3 + MarxSphere-Exception 商业授权**,对以下作品的借用已按各开源协议履行署名与声明义务。

---

## 1. TraitTutor

- **仓库**: https://github.com/traittutor/traittutor
- **许可**: Apache License 2.0
- **借鉴内容**: 学习引擎核心设计(源码级移植)— BKT 概念掌握模型、确定性组件选择器、事件账本与强证据闸门、学习画布 UI、评估-校准结构不变量、组件白名单与答案服务端持有
- **移植文件**(文件头均标注 "借鉴 TraitTutor"):
  - `src/services/learning-evidence-service.ts`
  - `src/services/learning-selector-service.ts`
  - `src/services/learning-plan-service.ts`
  - `src/services/material-review-service.ts`
  - `src/services/education-intent-service.ts`
  - `src/services/education-compass-service.ts`
  - `src/services/spaced-repetition-service.ts`
  - `src/services/component-executor-service.ts`
  - `src/services/learning-events-graph-sync.ts`
  - `src/services/capability-registry-service.ts`
  - `web/src/components/LearningCanvas.tsx`
  - `web/src/learning.css`(设计类体系)
- **Apache 2.0 义务履行**:
  - ✅ 版权与来源声明(文件头注释)
  - ✅ 修改说明(注释标注 "源码移植/对照")
  - ✅ 本 NOTICE 文件
  - ⚠️ 若 TraitTutor 附带 NOTICE 文件需一并保留——当前仓库根未发现 NOTICE,如有将补充

## 2. LingxiLearn

- **仓库**: https://github.com/LingXi-Org/LingxiLearn
- **许可**: MIT License — Copyright (c) 2026 LingXi-Org
- **借鉴内容**: 验证债务(verification_debt)、内容寻址去重、闭式状态转移表、状态提案(proposal-only)、评测纪律(not_observed≠pass)、复习优先级单尺子、Capability 注册表与确定性候选生成、SVG 可视化产物、学习多 Agent 协作
- **移植文件**(文件头均标注 "借鉴 LingxiLearn"):
  - `src/services/spaced-repetition-service.ts`
  - `src/services/learning-evidence-service.ts`
  - `src/services/learning-plan-service.ts`
  - `src/services/education-eval-service.ts`
  - `src/services/capability-registry-service.ts`
  - `src/services/learning-agent-orchestrator.ts`
  - `src/services/component-executor-service.ts`
  - `src/services/material-review-service.ts`
- **MIT 义务履行**:
  - ✅ 版权声明保留(本 NOTICE + 文件头)
  - ✅ 许可文本随分发(如需附 MIT LICENSE 文本,见本文件末尾)

---

## 其他参考(未移植代码,仅设计参考)

| 仓库 | 许可 | 用途 |
|---|---|---|
| BizAtlas(商舆) | 无 LICENSE 文件 | 设计哲学参考(确定性计算/三级降级),未移植代码 |
| lingxi-nlp | 无 LICENSE 文件 | 极简会话后端,未移植 |
| lingxi-org 官网/灵犀学 | 网站 | 产品形态参考,未移植 |
| frowang(论文分享模式) | - | 分享链接交互模式借鉴,无代码复用 |

---

## 附:MIT License(用于 LingxiLearn 声明)

```
MIT License

Copyright (c) 2026 LingXi-Org

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 附:Apache License 2.0 摘要(用于 TraitTutor 声明)

完整文本见 https://www.apache.org/licenses/LICENSE-2.0 。核心义务:
- 保留版权、专利、商标与归属声明
- 修改的文件需显著标注变更
- 衍生作品在相同条款下分发
- NOTICE 文件(若上游提供)不得修改

> 本文件由 MarxSphere 团队维护(2026-08-31)。如有遗漏,请提交 issue 补充。
