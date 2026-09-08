# 闭源社会科学科研系统前端解码：学术编辑器(EditorView) + 科研审查(Review) 模块

> 解码对象（prettier 格式化后 minified chunk，行号以格式化文件为准）：
> - `formatted/EditorView-CaKgg_bg.js` — 40843 行，学术编辑器整包（含 TipTap v3 + ProseMirror + docx 客户端）
> - `formatted/ReviewView-B4QyxKEn.js` — 37255 行，科研审查整包（含 PDF.js、docx-preview、jsonrepair）
> - `formatted/LibraryHome-CugeBZHb.js` — 2089 行，审稿库（期刊库/标准库管理）
> - `EditorView-CkEB1QCK.css` / `ReviewView-gnBufk0W.css` — scoped CSS
> 辅助文件：`full/reviewLibrary-J1jAubsl.js`（审稿库 Pinia store）、`full/index-xpWAkSSw.js`（共享 chunk：全部 API 客户端 q/jobs/tasks/dag/… + 鉴权 + SSE helper）
> 行号引用格式 = `E:1234`(EditorView) / `R:1234`(ReviewView) / `L:1234`(LibraryHome) / `S:…`(shared chunk 为 minified 单行，按内容锚点)。

---

## 0. 全局架构速览（跨模块）

- **主框架**：Vue 3 Composition API（`<script setup>` 风格编译产物，渲染函数 + `withScopeId`），子块带 `__scopeId`：`E:18294` 等。
- **共享 chunk `index-xpWAkSSw.js` 导出（`S:export{…}`）关键别名**（供两文件 import 解引用）：
  - `fr = Ql = fr(...)` → Pinia **defineStore**；`b0` = `qt(...)`(别名 `R as P0`) → 组件外获取 store。
  - `go(aJ) = Go()` → 鉴权头构造：`{ "Content-Type":"application/json", ...(token&&{Authorization:"Bearer "+token}) }`，token 取自 `localStorage["skf_auth_token"]`（`S:const dr="/api", op="skf_auth_token"`）。
  - `q = async q(e,t)` → 通用 fetch：`fetch("/api"+e, {headers:Go(t.headers),...t})`，401 触发 `ap()`（清 token + 广播 `auth-expired`），错误统一抛 `{status, code, message:error}`。**所有共享客户端均由此封装**。
  - `ha($)` = `q0` jobs 客户端、`P0(R)`=`Ql=useXxxStore`(获取 Pinia store)、`al(E)`=toast 函数（`addToast` 拆包）、`rp(aJ)`=Go()、`aC(A0)`=v-html 指令封装、`x0`=new Set 包装、`Mm(aL)`/`yu(aL)` = UI helpers（`addToast`/`confirm`）。
- **两模块命名空间 CSS 族**：Editor=`.ade-*`（academic editor），Review=`.review-*` + 局部 tailwind（对话区大量 tailwind 原子类，桌面应用 UI 自绘：AI 面板/工具栏/抽屉纯自绘，无组件库）。

---

## 1. LibraryHome（审稿库，L:2089 行）— 最小闭环参考

### 1.1 组件树
| 组件 | 行号 | props | emits | 用途 |
|---|---|---|---|---|
| `JournalEditDialog` | `L:51` | `mode`(create/edit/parse), `recordId` | `close`, `saved` | 新增/编辑/粘贴解析期刊投稿要求 |
| `StandardEditDialog` | `L:1054` | 同上 | 同上 | 审核标准 CRUD + AI 解析评分标准 |
| `JournalList` | `L:542` | — | `view`, `edit` | 期刊列表（搜索/分类筛选/删除/双入口弹窗） |
| `StandardList` | `L:1563` | — | `view`, `edit` | 标准列表（维度/准则计数/默认+内置徽标/删除） |
| 默认导出 `ReviewLibrary` | `L:1924-2089` | — | — | 页容器：tab(期刊库/标准库) + router-link 返回审稿 + 挂载 4 个子弹窗 |

### 1.2 业务逻辑流
- **AI 解析（parse mode）**：textarea 粘贴原文 → `store.parseJournal(text)` → 返回 `{name?, category?, structuredRules?}` → 回填表单（`L:138-148`）。standard 版返回 `{name?, scope?, dimensions:[{name,description}]}` 回填维度数组 `L:1070-1086`。
- **投稿须知文本→结构化规则算法（前端本机，L:65-109）**：逐行匹配正则：
  - `/(\d+)[-~～至到]+(\d+)\s*(字|词|字符)/` → `wordCount={min,max,unit}`；
  - `/引用|citation|gb\/t|apa|mla|chicago/i` → `referenceFormat`；
  - `/风格|语气|人称|被动|主动|学术/` → `languageStyle[]`；`/结构|章节|文献综述|方法|结论|引言/` → `structureRequirements[]`；`/盲审|英文|摘要|关键词|声明|利益/` → `specialNotes[]`；`/禁止|不得|不允许|不能|请勿/` → `forbiddenItems[]`；兜底也进 specialNotes。行首 `[-*·•] ` 剥除。
  - 反向 `structuredRules → 文本行` 序列化 `f()`（L:110-137，用于编辑态回显）。
- **评审标准维度默认模板（保存时生成，L:1090-1106）**：每条维度 `{id:"dim_"+ts+rand, name, weight:3, description, thresholds:{excellent:90,good:75,pass:60}, aiInstruction: 请从以下角度审查论文的"X"方面：desc, criteria:[{id:"c_"+ts, title:desc||name}]}`。
- **删除**：`confirm("确定删除「name」？")` → store.delete；内置(isBuiltIn)记录不显示删除钮（L:905-942, 1810）。
- 卡片徽标体系：isBuiltIn→蓝"内置" / isVerified→绿勾"已验证" / 其他→琥珀"待确认"（L:742-770）；标准另有 isDefault→绿"默认"（L:1690）。
- 空态引导文案 + loading spinner（红色主题 #red-600 系按钮 = 全库主色）。

### 1.3 API 契约（由 reviewLibrary store `L:26` 引用，端点定义在共享 chunk `S:J0`）
store 状态：`journals[], journalsLoading, currentJournal, journalSearch, journalFilter, filteredJournals(computed), standards[], standardsLoading, currentStandard, defaultStandard(computed find isDefault||[0]), parsing`。
- `GET /review/library/journals` → resp `{data:Journal[]}`；`GET /review/library/journals/:id`；`POST /review/library/journals {name, category, structuredRules}`；`PUT /review/library/journals/:id 同体`；`DELETE …/:id`
- `POST /review/library/journals/parse {rawText, fileName}` → `{data:{name?, category?, structuredRules?}}`
- standards 同构；额外 `PUT /review/library/standards/:id/default {isDefault:boolean}`。
- store 行为细节：list 失败置空数组仅 console.error；create/update 成功 push/替换本地数组；`init()` = Promise.all 双拉（L:26 store 单行）。
- 列表渲染字段（后端契约）：`{id, name, category, isBuiltIn, isVerified, useCount, structuredRules:{wordCount:{min,max,unit}, referenceFormat, languageStyle[]}}`；standard: `{id,name,scope,description,isDefault,isBuiltIn,useCount,dimensions:[{name,criteria:[…]}]}`。

### 1.4 状态/数据流
- 页面态在 `LibraryHome`：`tab: G("journal")`、`editJournalId/editStandardId + dialog 布尔`；子列表内部只持 `showParse/showCreate` 布尔。保存成功 → 父调 `store.fetchJournals()` 刷新（L:996-1016）。
- 弹窗 Teleport to body；遮罩 self 点击关闭；Esc/Enter 未绑（仅按钮）；确认钮 disabled 条件：parse 模式 = 无原文或 parsing；表单模式 = 无 name(或+无 category for journal)。

---

## 2. ReviewView（科研审查，R:37255 行）

### 2.0 文件内容分布
`R:1-620` JSON 状态机解析器(jsonrepair 内核) → `R:623-1198` **review Pinia store(核心状态机)** → `R:1199-1502` ReviewSettings → `R:1503-1984` ReviewInput → `R:1985-2046` ReviewProgress → `R:2048-2955` ReviewResult → `R:2956-6873` docx-preview 库 → `R:6874-7154` ReviewDocxViewer → `R:7155-35350`(PDF.js + pdfjs-viewer 大量代码) → `R:35351-35825` ReviewPdfViewer → `R:35826-36566` ReviewDetail → `R:36567-36723` ReviewHistoryRail → `R:36724-37255` ReviewView(容器)。

### 2.1 组件树
| 组件 | 行号 | props | emits | 职责 |
|---|---|---|---|---|
| `ReviewSettings` | `R:1220` | — | — | 严格度三档/选用期刊/勾选审核标准(多选)/额外要求 |
| `ReviewInput` | `R:1537` | — | `submitted {title,content,fileName,sourceFileId,sourceType}` | 论文输入：粘贴/上传切换 + 校验 + 提取 |
| `ReviewProgress` | `R:1990` | — | `cancel` | 审稿中动画（scope d0c837b2） |
| `ReviewResult` | `R:2096` | — | `showDetail`, `reReview` | 评分卡片 + 维度条 + 核心问题 + 导出(PDF/Word) |
| `ReviewDocxViewer` | `R:6874` | `fileId`, `annotations[]`, `activeAnnotationId` | `select` | docx 原文渲染 + 批注热区浮层；expose `scrollToAnnotation` |
| `ReviewPdfViewer` | `R:35369` | 同上 | 同上 | PDF 原文 + 页级高亮层；expose `scrollToAnnotation` |
| `ReviewDetail` | `R:35882` | — | `back` | 原文对照：左原文/右批注两栏 |
| `ReviewHistoryRail` | `R:36577` | `jobs[]`, `activeJobId` | `select`, `retry` | 往期审稿 rail（20 条） |
| 默认 `ReviewView` | `R:36724` | — | — | 容器：4 页面状态机路由 + 任务恢复 |

### 2.2 Review store 状态机（核心，R:623-1198）
state：`pageState: "input_ready"|"reviewing"|"result_view"|"detail_view"`、`reviewing bool`、`currentStep`、`stepMessage`、`reviewSteps=[{key:1,label:"审稿进行中",done}]`、`currentJobId`、paper 六元组 `{paperTitle, paperContent, paperFileName, paperSourceFileId, paperSourceType}`、`settings={strictness:"standard", journalId:null, standardIds:[], customRequirements:""}`、`result`。
derived：`overallScore/grade/dimensions/annotations/topSuggestions`(从 result 解包)；`issueStats`（遍历 dimensions[].issues[] severity major/minor/suggestion 计数，R:663-675）。
方法：`setPaper/resetPaper/showResult/showDetail/backToInput/backToResult`(页面切换)；`setSSECallbacks` 把 **3 个回调挂到 window 全局** `__rfSSEStatus / __rfReviewToken / __rfReviewError`（SSE worker 在另一窗口/独立运行时写入）——注意回调语义：`__rfSSEStatus(U)`: U.step===0 → reviewing=false 且 result_view + 解析最终文段；U.step===-1 → 仅 message 更新（不 done）；否则 step 递增 + done。R:721-738。
`parseFinalResult(文本)`：**LLM 原始输出四级容错解析**（R:768-816+ jsonrepair 状态机 R:271-620）：①`JSON.parse` 直解 → ②剥 ```json 围栏/弯引号/注释 + 自研状态机 repair(Vm) → ③大括号平衡 repair(B) → ④quoted-string repair(k) → ⑤最后兜底：`{paperTitle, wordCount, rawOutput:原文, parseFailed:true}` 并 toast（R:1079-1106）。console.log 打印原文前后各 500-1000 字符便于诊断。
`collectState()/restoreFromState()`：全量快照/恢复（供 sidebar 任务快照，R:1120-1163）；`cancelReview`：abort + 复位 + 清 window 全局。

### 2.3 业务逻辑流
**A. 输入阶段**：粘贴 tab：≥100 字启用（R:1554）；上传 tab：选择/拖拽 → 扩展名校验(txt/docx/pdf) → `POST /api/files/extract-text`(multipart FormData, 去 Content-Type 由浏览器带 boundary) → `{text, metadata:{sourceType, pageCount, extractedPages, reviewChunkCount, truncated, extractionWarnings}, fileId}`；text<100 字报错；truncated 警告"仅提取前 N 页"（R:1588-1632）。submitted 载荷带 sourceFileId/sourceType 供原文对照。
**B. 提交(ReviewView `_()` R:37026-37064)**：
1. sidebar 任务门：无 `currentTaskId` 或模块非 review → `createTaskWithTitle(标题,"review")`；否则 setCurrentTaskName。
2. `POST /api/review/jobs {title, content, settings, sidebarTaskId, sourceFileId}`（S:q0）→ `{job:{id}}`。
3. 快照 active → 刷新 jobs → URL `/review?jobId=` → 开始轮询/SSE。
**C. 进度**：`E(jobId)`（R:36886-36924）= getJob 快照 → 若未终态：**EventSource `/api/review/jobs/:id/stream`** 监听 `review.completed/failed/cancelled/status` 4 事件，任一触发再 getJob 收敛；onerror → 1.5s 后重连（无 EventSource 则 1.2s 纯轮询）。等待文案 `progress_message || queued?"等待审稿任务执行...":"正在审稿..."`。
**D. 终态处理 `C(job)`（R:36835-36885）**：completed 且有 result → result.wordCount 用 content.length 兜底；同 jobId 去重(f 变量)防重复 showResult；sidebar 快照 completed；任务列表刷新。failed → alert(error.message)+backToInput；cancelled → backToInput。**"分段审稿"后端契约**：ReviewInput 上传态显示 `reviewChunkCount>1 → "将分 N 段审稿后汇总全文结论"`（R:1811-1821）。
**E. 重试/取消**：retryJob 409 → 弹已有运行任务名并尝试恢复其 SSE（R:36772-36800）；cancelJob → 快照 cancelled。
**F. 结果页操作**：导出 PDF = `POST /api/review/export-report`（body: `{...result, paperTitle}`，headers rp()）→ resp text/html → window.open+write+print()；被拦则下载 .html（R:2151-2189）。导出 Word = 前端 docx 库拼装：标题/总分/等级/评语 + **正文逐段匹配批注** highlightText→CommentRangeStart/End+CommentReference 双模式（空白归一化后 indexOf，未命中批注 console 列表），Packer.toBlob + FileSaver（R:2190-2398）。（注：UI 提示 Word 导出为测试功能。）
**G. 原文对照(ReviewDetail)**：三态渲染——pdf→ReviewPdfViewer / docx→ReviewDocxViewer / txt 或无文件→纯文本高亮段（annotation-highlight span + [N] 重叠数标）。批注聚合：dimensions[].issues[] 展开为 {id,type(severity 映射),dimension,highlightText=originalText,comment=problem|issue|description,correction=suggestion,location} ∪ annotations[]；文本定位三级算法 d()：直接 indexOf → 空白归一化 posMap → 去空白首尾夹逼（R:35905-35931）。已处理/未处理 tabs(Set 内存态)、上一条/下一条。PDF/DOCX 高亮矩形层（见 2.5）。

### 2.4 API 契约（审稿域全部端点）
由 `S:q0 jobs / J0 library / K0 files` + R 内联 fetch：
- `POST /review/jobs {title, content, settings:{strictness,journalId,standardIds[],customRequirements}, sidebarTaskId, sourceFileId}` → `{job:{id,…}}`
- `GET /review/jobs?limit=N` → `{jobs:[{id,title,status:queued|running|completed|failed|cancelled, created_at, source_file_name, source_file_type, progress_message, error:{message}, result, settings, sidebar_task_id}]}`
- `GET /review/jobs/:id` → `{job}`；`POST /review/jobs/:id/cancel`；`DELETE /review/jobs/:id`；`POST /review/jobs/:id/retry` → `{job}`（409=已有运行任务，body/err.code）
- `GET /review/jobs/:id/stream` = **SSE**，事件名：`review.completed / review.failed / review.cancelled / review.status`
- `POST /review/history`(无参数) `GET /review/:id` `DELETE /review/:id`（另一处历史 API，未在 UI 主链路）
- `POST /api/files/extract-text` multipart(file) → `{text, metadata:{sourceType,pageCount,extractedPages,reviewChunkCount,truncated,extractionWarnings[]}, fileId}`（ReviewInput 内联 fetch R:1588）
- `GET /api/files/:fileId/content` (Authorization) → raw bytes（ReviewDocxViewer R:6978 / ReviewPdfViewer R:35369）
- `POST /api/review/export-report {…result, paperTitle}` → `text/html`（打印友好报告）
- 共享 S:q0 另含 `listJobs/getJob/createJob/cancelJob/deleteJob/retryJob`、`K0.upload→POST /files/upload`、`K0.profile→GET /files/:id/profile`、tasks API `Rt`：`GET /tasks?module=` `POST /tasks` `PUT /tasks/:id`(saveSnapshot={phase,status,phaseLabel,snapshot}) `POST /tasks/:id/switch` `POST /tasks/:id/release-lock` `GET /tasks/:id/nodes`…（sidebar 协作）
- 共享 SSE helper `sn(path,body,eventName)` / `ma`（event/data 帧解析，终止事件名=期望事件）。

### 2.5 原文渲染 + 批注热区实现（复刻重点）
**DOCX（R:6874-7154）**：fetch 内容 → **docx-preview `nx(arrayBuffer, docxEl, container, {className:"review-docx", breakPages:true, …})`**（库内嵌 R:2956-6873）→ 等渲染 → 对每条 annotation：`highlightText` 去空白后与渲染文本 DOM 的**全局空白压缩文本**逐字符 indexOf（TreeWalker SHOW_TEXT + 位置映射 `{node,offset}` 数组，R:6893-6942）→ `document.createRange` 定位 → 逐 clientRect 生成绝对定位热区按钮（相对 contentRef 容器 rect），`data-docx-ann-id`、is-active 类；点热区 → 命中 rect 列表内轮换下一个批注（R:6952-6970）；ResizeObserver 重算。
**PDF（R:35369-35825）**：pdfjs `getDocument({data})` + 自研 canvas 渲染（IntersectionObserver rootMargin 900px 懒渲染 + devicePixelRatio 节流 ≤2）；页宽 fit `max(320, clientWidth-32)`, cap 900。**批注页归属两法**：①`location|comment` 中 `/PDF\s*第?\s*(\d+)\s*页/i` → 直接页号；②highlightText 去 `【PDF第N页…】` 前缀逐页全文搜（R:35398-35410, 35580-35590）。页内高亮 = getTextContent items 字符级映射（去空白），transform 矩阵乘 → 行矩形 → **相邻行合并算法 T()**（top 差≤3|h*0.35 且左重叠 12px 内并框，R:35430-35447）→ 绝对定位按钮覆盖层 `data-pdf-ann-id`。渲染失败页提供"重新渲染"。
**纯文本对照**：空白归一化定位(逐字符 posMap) + 高亮段点击 → 右侧列表滚动(双向同步)；高亮段含多处重叠时 sup [count]（R:36240-36278）。

### 2.6 ReviewView 容器（R:36724-37255）
- 页面 4 态 switch（R:37222-37243）：input_ready→ReviewInput / reviewing→ReviewProgress / result_view→ReviewResult / detail_view→ReviewDetail。
- **路由/URL 状态同步**：query.jobId 进入→ E() 恢复；`?new=1` → 重置；watch query.new 卸载重置（R:36939-36958）。
- **sidebar 任务快照联动**：`P(taskId)` 恢复 = `GET task(snapshot.reviewWorkspace)` → `restoreFromState` 或旧格式字段兜底（R:36972-36999）；watch currentTaskId 自动装载（c 守卫防循环）；提交时若 sidebar 已有同名 review 模块任务直接复用（否则 createTaskWithTitle）。`S(taskId,status)` 快照写 `PUT /tasks/:id`（phase:0, phaseLabel: grade分/已完成/审稿中）；409/ACTIVE_PROJECT_LOCKED 容忍。
- 顶部数据属性（供外部自动化）`data-assistant-task-state/has-content/task-label`（R:37098-37106），按钮 `data-assistant-control="review_new_review"`。
- 历史 rail 双击 select 规则：queued/running → 恢复 SSE；completed → v() 装载内容；failed/cancelled 禁用 + retry 按钮（R:36640-36700）。

---

## 3. EditorView（学术编辑器，E:40843 行）

### 3.0 文件内容分布
`E:1-15400` ProseMirror 内核(markdown 解析/序列化/jsonrepair 等依赖) → `E:15436-15494` EditorContent 挂载组件 + useEditor 工厂 → `E:15500-17750` axios 全量库（内嵌）→ `E:17786-17900` **Axios 实例 + 文档/标签/文件 API 函数** → `E:17901-18087` **document Pinia store** → `E:18100-18294` TopBar → `E:18295-18448` SideBar → `E:18449-18594` editor-ai 客户端(SSE) → `E:18595-18890` **editor-ai Pinia store** → `E:18891-18961` 格式预设(4 模板+localStorage) → `E:18962-19952` AIPanel → `E:19953-20143` VersionHistory → `E:20144-23200` TipTap 核心 markdown 扩展(bold/italic/code/blockquote…) → `E:23200-24450` StarterKit 全量扩展包 → `E:24450-29000` 更多扩展(table/placeholder/highlight/image/code-block-lowlight/表格 resize…) → `E:38987-39163` lowlight 语言表(29 语言) + highlight 注册 → `E:39167-39288` **学术扩展 academicTextStyle/academicBlockStyle** → `E:39289-39315` **useEditor GN() 装配** → `E:39316-40843` **Editor 主组件(默认导出)**。

### 3.1 API 层（全部基于 Axios `Te = De.create({baseURL:"/api/editor/v1", timeout:30000})`，E:17804-17808）
**鉴权/拦截**：request 拦截加 `Authorization: Bearer token` + `X-Main-Token`（token=`localStorage["skf_auth_token"]`，E:17809-17821，`_skipAuth` 可跳过）。response 拦截：409 → **window CustomEvent `"doc-conflict"`**（detail=body，版本冲突 UI 钩子）；401 → 清 token + `Dm()`（跳登录）；网络层失败 → `{error:{code:"NETWORK_ERROR", message:"…请确保 editor-backend 已启动 (localhost:8000)"}}`。
**文档函数（E:17848-17900）**：
- `GET /documents?page&page_size` → `{data:{items:[{id,title,word_count,updated_at,content_hash}], pagination:{total}}}`
- `GET /documents/:id` → `{data:{id,title,content(JSON 树),content_hash,word_count,updated_at}}`
- `POST /documents {title}` → `{data}`；`PUT /documents/:id {content, content_hash, title?}`（content_hash 乐观并发控制）
- `DELETE /documents/:id`；`POST /documents/:id/lock` → lockInfo / `POST …/unlock` / `POST …/heartbeat`（长文档会话）
- `GET /tags` → `[{id,name,color}]`；`POST /tags {name,color}`；`DELETE /tags/:id`
- `POST /files` multipart → `{data:{url, storage_path}}`（图片上传，E:17881-17887）
- 附加(主组件用)：`POST /documents/import` multipart → `{data:{html(标清 html), title}}`；`POST /documents/:id/export {html, title, format_options:{preset,font_family,font_size,line_height,first_line_indent}}` responseType blob → docx
- `GET /documents/:id/versions` → `[{id,version_num,created_at,change_summary,word_count}]`；`POST /documents/:id/versions/:vid/restore`（E:19985-20012）
- **editor-ai（E:18449-18594）**：
  - `GET /ai/models`；`GET/POST /ai/conversations`；`DELETE /ai/conversations/:id`
  - 对话/单任务双入口 `POST /api/editor/v1/ai/jobs`（body 分别 `{message, conversation_id, document_content?, document_id?}` 或 `{action, text, context, language, document_id}`）→ `{job_id}`
  - `GET /api/editor/v1/ai/jobs/:id/stream`（SSE，手写 parser 按 `\n\n` 分帧，事件 **delta/model/done/error**：delta.content 追加；done 内 message_id/content；error {message, is_retriable}）；`POST /ai/jobs/:id/cancel`；`POST /ai/jobs/:id/retry` → `{data:{job_id}}`
  - `POST /ai/chart {description, chart_type}` → `{data:{code}}`（E:18572-18575）

### 3.2 document store（E:17901-18087，Pinia `gu("document")`）
state：documents/paged(loadMore 一次性 page+page_size 拉全量)/currentDocument/currentContent(JSON 树)/contentHash(排序键规范化 JSON 字符串 Uo)/lastSavedHash/saveStatus `saved|saving|unsaved|error`/lockInfo/tags。
要点：
- `fetchDocument(id)` 后 `localStorage["editor.activeDocumentId"]=id`；`contentHash = canonicalStringify(content)`（对象键排序 Aa()，E:17888-17900）用于高效变更检测。
- `saveDocument(id, content, title?)`：**仅当 canonical(content)≠lastSavedHash 才 PUT**；body 带 `content_hash`（乐观锁）。成功同步列表项 title/word_count/updated_at。
- **锁会话心跳**：`acquireDocumentLock(id)`→ 串行队列(x()) + 成功即启动 `setInterval 60s` heartbeat（503 容忍；锁主换人时 R() 停表）。unmount/切文档 release。
- 删除文档事件广播 `CustomEvent("editor-documents-changed")`（列表联动）；`markUnsaved()` 防重入 saving 态。
- 409/401 事件在拦截器已转发 doc-conflict/auth-expired。

### 3.3 editor-ai store（E:18595-18890）
state：panelOpen/activeTab/conversations[]/currentConversationId/messages[]/isLoading/streamingContent/currentModel/activeJobId(`localStorage["editor.activeJobId"]` 启动恢复)/lastJobStatus(idle|running|completed|failed|cancelled)。
- 对话流程：无会话先 POST 建会话（标题默认"新对话"，完成后若仍为"新对话"则改取 message 前 30 字）→ 本地 push user/assistant(streaming) 两条 → SSE 累积；onDone 替换 assistant.id=message_id。
- **job 断点续传**：mounted `recoverActiveJob()`：若 localStorage 有 jobId → `POST retry` 重排队 → 重新连 stream（E:18748-18799）。
- assistDocument(action,text,context,language) 返回累积全文（全文动作 text=前 6e4 字符截断，见 AIPanel）；错误把 `\n错误:…` 追加结果尾。
- 取消：AbortController.abort() + POST cancel。

### 3.4 组件树
| 组件 | 行号 | props/emits | 职责 |
|---|---|---|---|
| `EditorContent`(库) | `E:15436` | editor | 挂载 tiptap view.dom 到 slot（把 view.dom.parentNode 子节点 append 进容器，contentComponent/appContext 桥接 Vue 语境 + createNodeViews） |
| `TopBar` | `E:18101` | emits save/toggle-version-history/create-document | 标题 + 保存/版本历史/状态徽标 + "新建文档"弹窗；监听 `editor-open-new-document` 事件开弹窗 |
| `SideBar` | `E:18305` | emits create/select/delete | 文档 rail（word_count zh-CN 千分位 + MM-DD HH:mm） |
| `AIPanel` | `E:18997` | props {editor} | 6 tab 辅助工具（详见 3.6） |
| `VersionHistory` | `E:19965` | props {documentId,isOpen}, emits close/restored | 抽屉版版本列表 + 恢复（confirm 提示"当前内容将自动备份为新版本"） |
| 默认导出 `Editor` | `E:39364`（name:"Editor" E:39363, scopeId data-v-8380a051） | — | 三栏布局 + 工具栏 + 页面事件 + 导出/导入/图表插入全部编排 |

### 3.5 编辑器核心装配（GN() E:39289-39315 = 复刻模板）
```
extensions: [
  StarterKit.configure({codeBlock:false, link:false, underline:false}), // 内嵌 20+ 扩展
  Placeholder.configure({placeholder:"开始输入..."}),
  Link.configure({openOnClick:false, HTMLAttributes:{rel:"noopener noreferrer", target:"_blank"}}), // rk=bh
  Underline, academicTextStyle(KN), academicBlockStyle(VN),
  TextAlign.configure({types:["heading","paragraph"]}),
  Highlight.configure({multicolor:true}),
  Image.configure({inline:false, allowBase64:true}),   // Dh
  ImageResize=Image.extend({name:"imageResize", allowBase64:true}),
  Table.configure({resizable:true}), // tableKit: Table/TableCell/TableHeader/TableRow
  CodeBlockLowlight.configure({lowlight: 29 语言注册表 zN})
]
```
- `useEditor` 单例逻辑 E:39465-39469：`GN(G(store.currentContent), onUpdate)`；onUpdate → `store.currentContent = editor.getJSON()` + `store.markUnsaved()` + **1200ms 防抖自动保存** `ae()`（E:39506-39522）。
- 双向同步 watch：currentContent 变（切文档/恢复）→ JSON 差异比较才 setContent（E:39470-39480）；currentDocument → acquireLock。
- **A4 纸张视觉**（CSS）：`.tiptap{min-height:297mm;width:210mm;padding:56px 64px; box-shadow}` + CSS 变量 `--ade-doc-font-family/size/line-height/paragraph-margin/first-line-indent` 由格式预设(4 档：通用学术/中文期刊/APA/学位论文)动态注入；预设 localStorage key `"ade-format-preset"`（E:18942-18953）。
- **排版命令**：自研 mark `academicTextStyle`(fontFamily/fontSize/color) + 段落 attr(block style) lineHeight/paragraphSpacing；工具栏字体 6 种（宋/黑/楷/雅黑/TNR/Arial）、字号 6 档（小五~三号 9-16pt 映射 px）、行距 5 档、段后距 5 档、文字色/荧光色 color input、清格式链（clearAcademicTextStyle+unsetHighlight+unsetLineHeight+unsetParagraphSpacing+unsetAllMarks）。
- **保存编排 z()/H()**：getJSON→saveDocument(id,json,title)；ctrl/cmd+S 拦截（E:39808-39810）；beforeunload(onUnmounted) flush 保存 + releaseLock + editor.destroy。
- 切换文档链：先 flush 保存 → releaseLock → fetch → 新文档 acquireLock；失败回锁。删除当前文档后自动打开列表第一篇。
- **路由意图**：`/editor?new=1&dialog=1`→打开新建弹窗；`/editor?new=1`→直接建"未命名学术文档"；`/editor?documentId=N`→打开；无参→恢复 `localStorage["editor.activeDocumentId"]`（失败清除）→ 若还有 activeJobId 自动开 AI 面板 quick tab。
- 链接弹窗：校验 `^https?://`；图片：file → POST /files → url 规范化（`storage_path` 以 /uploads/ 开头则前缀 `/api/editor`）→ setImage。
- **Word 导入**：POST /documents/import → 无当前文档则 createDocument(title=响应 title||文件名)+fetch；有则 `commands.setContent(响应 html)` → markUnsaved+保存。
- **Word 导出**：getHTML → POST /documents/:id/export blob → Blob(MIME word) → a[download="标题.docx"]。
- **AI 结果落文（window CustomEvent 总线）**：
  - `ai-apply`：detail {content, mode?:"replaceSelection", from, to, originalText} — replaceSelection 先做 from/to 有效 + **原文回读校验**（doc.textBetween 必须===originalText，否则 toast "原选区已发生变化"），insertContentAt；否则光标处 insertContent。
  - `ai-insert-chart`：detail {code, type} — mermaid* → 动态 import mermaid → SVG → FileReader dataURL → setImage；echarts* → 动态 import echarts → 离屏 600x400 div init → setOption → 500ms → getDataURL(png, pixelRatio 2) → setImage；其他 → `<pre><code>` HTML 转义插入。
- 状态栏：word_count/已锁定；辅助自动化 data-*：`data-assistant-task-state`/`data-assistant-has-content`/`data-assistant-task-label`。

### 3.6 AIPanel 六 tab（E:18962-19952，本地渲染公式/表格的管线）
- **check 全文检查**（4 动作：`logic_check 全文逻辑检查 / section_coherence_check 章节衔接检查 / variable_method_conclusion_check 变量-方法-结论一致性 / submission_check 投稿前检查`）→ 全文(≤60000 字, E:19247) assistDocument，**不直接改正文**。
- **local 选区修改**（5 动作：`academic_polish / reduce_ai_tone / compress_redundancy / expand_argument / proofread`）→ 需要选中；上下文=选区前后各 4000 字英文标头包装 `Context before/after selection`（E:19202-19239）。
- **title 题名摘要**（3：`title_optimize(5候选)/ abstract_optimize / keywords_generate`）。
- **citation 引用格式**（2：`citation_consistency_check / format_check`，明示"不判断文献真实存在与否"）。
- **format 格式模板**：4 预设单选（持久化）。
- **chart 图表**：类型 5（mermaid_flowchart/mermaid_mindmap/echarts_bar/echarts_line/echarts_pie）→ `POST /ai/chart {description, chart_type}` → code → `<ChartRenderer code chart-type>` 预览（ChartRenderer-DVxWvy7W.js 共享组件）→ 插入按钮发 ai-insert-chart 事件。
- 结果区渲染管线（x computed E:19018-19053）：**katex 先行提取公式** `(\$\$…\$\$|\\\(…\\\)|\\\[…\\\])` → renderToString 占位 `@@EDITOR_FORMULA_n@@` → marked(breaks) → 占位回填 → DOMPurify sanitize → innerHTML(类 markdown-body)。
- 动作按钮全带 disabled(isLoading 或无文本)；取消/失败重试（retryActiveJob）；结果操作：复制(clipboard)/替换选中内容/插入到光标；失败卡片 `--error` 态。
- **面板宽度拖拽**：mousedown 拖 resize handle → CSS var `--ade-ai-panel-width`(clamp 340-720) → 松手存 `localStorage["ade-ai-panel-width"]`（E:19366-19392）；启动恢复。
- 编辑器 selectionUpdate 监听联动 tab 显示"当前选区 N 字"。

### 3.7 CSS 体系（EditorView-CkEB1QCK.css，197 条规则）
scoped 段（data-v 对照）：TopBar=`500ac1b8`、SideBar=`493134a1`、AIPanel=`e0631cb6`、VersionHistory=`7ad466f9`、主视图=`8380a051`（文件内除顶部少量全局变量/工具类外全 scoped）。BEM 类树与要点：
- `ade-layout`：CSS 变量 `--ade-sidebar-width:280px; --ade-ai-panel-width:420px`，flex column h100%，白底灰字 #f8fafc/#334155，外层 `overflow-x:auto`（小屏横滚）。
- `ade-layout__body`：flex row；`ade-editor-area` flex:1 column；`ade-editor-area__content` column；工具栏 `ade-editor-toolbar` min-height 72px，行宽 `min(1120px,100%)` wrap；分组 `ade-editor-toolbar__group`(B/I/U/S 块、H1-H3+P、UL/OL/引用/代码、对齐、链接/图片、undo/redo、导入/导出/辅助) 分离带。
- **A4 纸**：`ade-editor-tiptap-wrap{flex:1;overflow:auto;padding:24px;justify-content:center;background:#f8fafc}`；`.tiptap` = 210mm×297mm 白纸阴影，CSS 变量驱动字体/字号/行距/段距/首行缩进（2em 默认）；h1 24px/h2 20px/h3 16px；列表文字不缩进。
- `ade-document-rail`：280px 侧栏；entry `is-active` 蓝左条或高亮；hover 才显示删除（opacity 过渡）。
- `ade-ai-panel`：右侧抽屉 width:var；`__body max-height:38%`（结果卡占面板上部 62% 滚动）；resize-handle 5px col-resize。
- 状态点：`ade-topbar__status--green/yellow/gray`；版本历史项当前版 = #eff6ff + 3px #2563eb 左条 + "当前"蓝色胶囊。
- 主题色语言：主操作红(#dc2626 系)贯穿新建/保存按钮？——实际 TopBar/AI 用 slate/红混合：审稿库红系；编辑器内 #2563eb 蓝用于链接/版本/当前态；主布局 #334155/#1a365d 深蓝灰（进度动画 #1a365d 主深蓝）。

### 3.8 ReviewView CSS（ReviewView-gnBufk0W.css，48 规则）
scoped 段（data-v）：Progress=`d0c837b2`（animate-progress keyframes 15%→90% 3s 无限交变）、DocxViewer=`07cafe84`、PdfViewer=`fa89a8e3`、Detail=`416432a7`、HistoryRail=`86a36a32`、主视图=`926c2a39`。
- 高亮热区：`.pdf-annotation-rect` / `.docx-annotation-rect`：absolute 按钮，hover 提亮，`is-active` 红边高亮（z-index 分层：docx 内容 z-0、热区层独立 isolate）。
- `.annotation-highlight`（txt 原文高亮段）：hover/`.active` 变化；重叠计数 sup 红色 [N]。
- `review-history-rail`：窄 rail（右侧 180px 级）flex column，entry `is-active` 高亮；status 点五色（status-queued/running/completed/failed/cancelled）。
- `@media` 两处：rail 变窄 + `.review-workspace__main` 布局窄屏单列。

---

## 4. 状态持久化/事件总线汇总

| 键/事件 | 用途 | 位置 |
|---|---|---|
| `localStorage["skf_auth_token"]` | 全局 Bearer token（两后端共用） | S:op |
| `editor.activeDocumentId` | 最后打开文档恢复 | E:17930/39787 |
| `editor.activeJobId` | AI job 断点恢复（会话中途可 reload） | E:18604/18702 |
| `ade-format-preset` | 排版预设 | E:18942 |
| `ade-ai-panel-width` | AI 面板宽度 | E:18993 |
| window CustomEvent `ai-apply` / `ai-insert-chart` / `doc-conflict` / `editor-documents-changed` / `editor-open-new-document` / `auth-expired` | 跨组件总线（AIPanel→Editor 等） | 见各节 |
| window 全局 `__rfSSEStatus/__rfReviewToken/__rfReviewError` | review SSE 与编辑器窗口/外部 worker 桥接 | R:705-707 |
| Pinia（共享 chunk fr/defineStore） | document/editor-ai/review/reviewLibrary/settings/tasks 等 | 全篇 |

## 5. 后端推导（前端可见契约 → 我方最小实现面）
- editor-backend 独立服务 `localhost:8000`（前端/editor 双 token 化），路由前缀 `/api/editor/v1`；review 与其余模块同挂 `/api` 主服务（`/review/*`、`/files/*`、`/api/files/extract-text`、`/tasks/*`）。
- 关键算法都是"后端粗活、前端精修"：审稿文本提取/分段/LLM 长跑在后端(job+SSE)，**解析 LLM JSON、批注↔原文定位、pdf/docx 热区渲染、报告 docx 拼装**在前端。
- 复刻清单优先级（成本/价值）：①jobs+SSE 状态机 ②四层 JSON 容错解析 ③annotation 归一化匹配（txt/docx/pdf 三种定位）④docx 批注导出 ⑤editor: content_hash 乐观锁 + 1200ms 防抖保存 + 锁心跳 ⑥editor-ai job 断点续传。

（证据行号贯穿全文；LibraryHome 行号 L:；Review R:；Editor E:；共享 chunk S:。）
