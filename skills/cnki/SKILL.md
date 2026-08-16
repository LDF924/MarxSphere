---
name: cnki
description: "Use when 用户需从知网批量下载PDF或抓取引文网络（如文献综述、引文分析）；Don't use when 目标文献不在知网、需下载非PDF格式（如CAJ）、或网络/Edge浏览器不可用；e.g. 输入“区块链供应链金融”可自动抓取该论文的参考文献、引证文献、共引文献、同被引文献及二级文献并输出JSON，同时逐篇下载当前页全部PDF并自动比对补漏；耗时约5-15分钟/篇，成本约0元（需知网权限）。"
triggers: [知网, 批量下载, PDF下载, 引文, 参考文献, 引证文献, 共引文献, cnki, 知网下载, 引文网络]
category_zh: 文献检索
origin: self-made
title_zh: 知网一体化工具
---

# 知网一体化工具

两个能力，均依赖 CDP Proxy（来自 `web-access` skill）。

## ① 批量下载 PDF

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/cnki_workflow.sh"
```

流程：CDP Proxy → 列出Tab → 选择搜索页+下载文件夹 → 逐篇点击下载 → 比对补漏 → 汇报。

## ② 引文网络全自动抓取（v2.0）

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/cnki_citations.sh" "论文标题"
# 或交互式：bash cnki_citations.sh（提示输入标题）
```

**全自动流程**（从零开始，无需人工干预）：

```
① 检查 CDP Proxy（Edge 需已登录知网）
② 查找或自动创建知网搜索页 tab（无 tab 时自动新建）
③ 检测登录状态：
   - 已登录 → 跳过登录直接搜索
   - 未登录 → 自动 CARSI 登录（IdP页→点知网链接→登录表单→信息释放同意→机构选择）
④ 导航搜索页 + 搜索关键词
⑤ 轮询等待论文链接出现（最多 30 秒）
⑥ 关闭旧详情页 → JS 点击论文链接（知网需 el.click() 触发）
⑦ 等待详情页加载 → 滚动到引文区域触发懒加载
⑧ 逐个点击 6 种引文 tab（每次滚动+点击+等待加载）
⑨ 输出 JSON 到 data/citations-{md5}.json
```

**输出格式**：

```json
{
  "paperTitle": "论文标题",
  "tabs": {
    "references": [{"raw": "[1] 作者.标题[J].期刊,年份"}],
    "citations": [],
    "coreferences": [],
    "cocitations": [],
    "secondreferences": [],
    "secondcitations": []
  }
}
```

**关键技巧**（踩坑记录）：
- 引文数据是**懒加载**：必须滚动到 `#refpartdiv` 区域才触发加载
- 详情页需 **JS 点击（el.click()）** 打开（真实鼠标事件不触发知网 JS 处理）
- tab 切换后**每次都要重新滚动**触发懒加载
- eval 传 JS 用**临时文件 + --data-binary**（避免 shell 引号转义）
- 每次抓取前**关闭旧详情页 tab**（避免选中旧论文）

## 依赖

CDP Proxy 基础设施来自 `web-access` skill：

```bash
node "${CLAUDE_SKILL_DIR}/../web-access/scripts/check-deps.mjs" --browser edge
```
