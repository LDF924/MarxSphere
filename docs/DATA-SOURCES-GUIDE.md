# MarxSphere 外部数据源目录与导入指南

> 31 个外部数据源统一注册于 `src/services/sources-registry.ts`（代码内），前端「数据源」面板展示。
> 本文档为**外部资源目录**：哪些随包可用、哪些需注册、如何导入。数据本身不随仓库分发（版权/体积/实时性），提供链接与接入方式。

## 一、源类型说明

| 类型 | 含义 | 是否随包 |
|---|---|---|
| `api` | 开放 API（免 key 或需少量配置） | 代码已接入，随包可用 |
| `web` | 网页源（浏览器/转 PDF 抓取） | 代码已接入，随包可用 |
| `mcp` | 现成 MCP 服务 | 代码已接入 |
| `auth` | 需注册/机构订阅 | **需用户自行获取权限**，代码提供接入点 |

**状态说明**：`active`=已接入可用；`ready`=可接入（配置后可用）；`requires_auth`=需注册/权限。

## 二、31 个数据源目录

### 政策 / 政府权威源（5）

| 源 | 类型/状态 | 链接 | 导入方式 |
|---|---|---|---|
| 中国政府网政策文件库 | mcp/active | https://www.gov.cn/zhengce/zhengcewenjianku | 已接入（MCP） |
| 农业农村部官网 | web/ready | https://www.moa.gov.cn | 网页抓取（PDF） |
| 中央一号文件历年全文 | web/ready | https://www.gov.cn/zhengce/zhengcewenjianku | 网页抓取 |
| 国家统计数据发布库 | api/ready | https://data.stats.gov.cn | 开放 API 接入 |
| 学习强国 | web/requires_auth | https://www.xuexi.cn | 需账号登录后抓取 |

### 理论 / 权威理论源（9）

| 源 | 类型/状态 | 链接 | 导入方式 |
|---|---|---|---|
| 习近平系列重要讲话数据库 | web/ready | http://jhsjk.people.cn | 网页抓取（公开可读） |
| 中国共产党思想理论资源数据库 | auth/requires_auth | https://data.lilun.cn | 机构订阅后接入 |
| 人民数据库 | auth/requires_auth | http://data.people.com.cn | 机构订阅后接入 |
| 求是网 + 红旗文稿 | web/active | http://www.qstheory.cn | 已接入（网页） |
| 人民日报理论版 | web/active | http://theory.people.com.cn | 已接入 |
| 光明日报理论版 | web/active | https://theory.gmw.cn | 已接入 |
| 学习时报 | web/active | https://www.studytimes.cn | 已接入 |
| 经济日报理论版 | web/active | http://theory.people.com.cn | 已接入 |
| 中国社会科学网/马研网 | web/active | https://www.cssn.cn | 已接入 |

### 学术文献源（8）

| 源 | 类型/状态 | 链接 | 导入方式 |
|---|---|---|---|
| 国家哲社文献中心 NCPSSD | auth/requires_auth | https://www.ncpssd.cn | 机构账号后接入 |
| 国家社科基金立项库 | auth/requires_auth | https://www.nopss.gov.cn | 注册后接入 |
| 人大复印报刊资料 | auth/requires_auth | https://www.rdfybk.com | 机构订阅 |
| 马克思主义学术资源库 | auth/requires_auth | https://sklib.cn | 注册后接入 |
| 国家图书馆（文津） | auth/requires_auth | https://www.nlc.cn | 机构账号 |
| CNKI 知网 | auth/active | https://www.cnki.net | 已接入（需机构/个人账号） |
| 爱思想网 | web/active | https://www.aisixiang.com | 已接入 |
| 中国政治经济学智库 | web/ready | https://www.cpeer.org | 网页抓取 |

### 国际 / 开放学术源（7）

| 源 | 类型/状态 | 链接 | 导入方式 |
|---|---|---|---|
| OpenAlex | api/active | https://openalex.org | **免费 API 免 key**，已接入 |
| CORE.ac.uk | api/active | https://core.ac.uk | 开放 API（可选 key），已接入 |
| World Bank | api/active | https://openknowledge.worldbank.org | 开放 API，已接入 |
| GitHub | api/active | https://github.com | 开放 API，已接入 |
| MIA 中文马克思主义文库 | web/ready | https://www.marxists.org/chinese | 网页抓取（公开） |
| Monthly Review | api/ready | https://monthlyreview.org | 开放 API |
| NBER Working Papers | web/ready | https://www.nber.org | 网页抓取 |
| SSRN / SocArXiv | api/ready | https://www.ssrn.com | 开放 API |
| RRPE / Capital & Class | auth/requires_auth | https://journals.sagepub.com | 机构订阅 |

## 三、导入指南

### 3.1 已接入源（active）——零配置

```bash
# 直接在前端「数据源」面板选择 → 检索/导入
# OpenAlex / CORE / World Bank / GitHub 免费免 key，开箱即用
```

### 3.2 需注册源（requires_auth）——三步接入

1. **注册/订阅**：到对应网站注册账号（或机构图书馆开通）
2. **获取凭据**：CNKI 机构账号 / NCPSSD 账号 / 数据库订阅
3. **配置**：在 `.env` 或「数据源」面板填入凭据 → 面板标记「已连接」

> 例：CNKI 知网——需学校图书馆 IP 或知网个人账号；配置后走 `cnki` 源检索。

### 3.3 网页源（web）——手动导入

```bash
# 方式一：前端「文档入库」粘贴/上传（PDF/Markdown/TXT → 自动切片+向量化）
# 方式二：示例脚本
npx tsx examples/demo-ingest.ts   # 演示入库流程
```

### 3.4 批量导入外部 PDF 文献

```bash
# 把 PDF 放入目录后（LITERATURE_DIR 指向），系统自动扫描入库
# 或走 seed-corpus 脚本
npx tsx examples/seed-corpus/ingest-seed-corpus.ts
```

## 四、数据合规说明

- **不随仓库分发**：上述源均为**外部链接/API**，数据留在源站或用户本机，仓库不含其内容
- **用户自备权限**：auth 类源需用户自行获取合法访问权限（机构订阅/账号）
- **演示数据**：`examples/seed-corpus/` 为公开种子语料（可再分发）；教学案例库 `data/education-cases.json` 为自建（已随仓库）
- 详见 [OPEN-SOURCE-DISCLOSURE.md](OPEN-SOURCE-DISCLOSURE.md)
