# OutlineEditor 组件源码解码(InputView-DwlhRWpv.js, 闭源 Vue3 SFC)

## 组件契约
- props: { modelValue: { type: String, default: "" } }  ← 目录=多行文本字符串(非对象数组!)
- emits: ["update:modelValue", "change"]
- 中文序号: ["一".."二十"]

## 核心函数(全部解码)
| 函数 | 行为 |
|---|---|
| b() | 生成 id: "o"+递增+"_"+Date.now() |
| k() | 默认骨架: [1,2,3].map → 3 章每章 2 空子节, collapsed:false |
| L(a) | **多行文本→目录树解析器**: 逐行 trim, 行首"一、"或"1."等 → 一级; 缩进/编号 → 子节 |
| M() | + 一级章节: push {id,title:"",children:[],collapsed:false} |
| O(a) | 一级行"+" 添加子节: a.children.push, 展开该章 |
| P(a) | 删除一级(a 索引) |
| z(a,n) | 删除子节 |
| j(a,n) | 上移/下移(边界 disabled: 首行不能上移, 末行不能下移) |
| $() | **插入模板**: 硬编码五段式多行文本(一、引言 3子节 / 二、文献综述与分析框架 3子节 / 三、现状描述或案例呈现 2子节 / 四、问题分析与对策建议 2子节 / 五、结语 2子节) → L() 解析替换全部 |
| W() | 清除目录 → k() 回默认 3 章 |
| N() | computed 计数: `${一级} 个一级 · ${二级} 个二级`(二级 0 时 `${n} 个章节`) |

## 行渲染结构(实测 DOM 反向)
- 一级行 div.group: [中文序号 span.text-red-500 粗体 w-8] [input 双向(placeholder 输入一级标题)] [工具组: + 添加子节/▼折叠或▶展开/↑(首行 disabled)/↓(末行 disabled)/✕]
- 子节行 div.tree-child: 缩进 + input(placeholder 输入子节标题) + ✕
- 折叠: collapsed=true → tree-collapsed class(子节隐藏)
- 空目录: 居中空态 "目录为空，请添加章节或插入模板" + 红链"插入模板"

## data-assistant 动作埋点
- 插入模板: trigger=insert_outline_template success=outline_updated
- 空态插入: workflow_outline_insert_template_empty

# InputView 主组件解码(同一 chunk 9385 起)

## setup 数据/逻辑
- **store 引用**: s=input store(全局), f=task store, g=toast; 字段: s.input.title / s.input.sampleFiles / s.clarifyAnswers / s.clarifyLoading / s.submitting
- **autoSaveDraft()**: 每次字段变更自动存草稿(store 层)
- **拖拽/选择文件上传**: dataTransfer.files / input.files → L() 逐个 ot() 解析(txt FileReader / docx pdfjs extractRawText / pdf pdfjs worker) → push sampleFiles{name,size,content} → buildSampleContent() 重建正文 + autoSaveDraft()
- **文件大小格式化**: <1024 B / <1MB KB / else MB
- **方法三卡**: B=[{value:qualitative|quantitative|mixed,label:定性研究/定量研究/混合方法,desc:含\n换行的副文案}]
- **引导提问 8 分类**: O={scope:范围界定,concept:概念维度,method:研究方法,theory:理论基础,data:数据来源,innovation:创新聚焦,structure:章节逻辑,general:补充信息}
- **分类颜色映射**: P={scope:bg-blue-50 text-blue-700, concept:bg-purple-50 text-purple-700, method:bg-green-50 text-green-700, theory:bg-orange-50 text-orange-700, data:bg-cyan-50 text-cyan-700, innovation:bg-pink-50 text-pink-700, structure:bg-indigo-50 text-indigo-700, general:bg-gray-50 text-gray-600}
- **clarifyAnswers 已答计数**: computed(有值 trim 非空计数)
- **$()**: 打开引导 → fetchClarifyQuestions()
- **W() 提交**: await s.submitAnalysis() → toast "章节清单已生成"; 失败 g.show(message)
- **mount**: currentTaskId 存在则 loadNode("input") 恢复现场
- **页面根 async 状态**: data-assistant-async-busy = submitting||clarifyLoading; reason=正在提交研究信息/正在生成需求澄清问题

## 页面骨架
- workflow-page max-w-4xl mx-auto px-6 py-8 pb-16 min-w-0 h-full overflow-y-auto
- h1 "信息录入" text-2xl font-bold text-gray-800 + 副文案
- 主题输入: label.block.text-sm.font-medium + input w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none
