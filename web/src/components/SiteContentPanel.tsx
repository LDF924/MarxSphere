// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// SiteContentPanel.tsx — SocialSci P2: 站点内容页(公告/帮助/法律条款/学术资源导航)
// 形态对齐(闭源产品内容页语义, 原创实现): 纯前端静态数据驱动, 不改 server 主流程
//   J1 新闻/公告 | J2 帮助中心 | J3 条款/隐私/免责 | J4 学术资源导航
import { useState } from "react";
import { BookOpen, ChevronRight, ExternalLink, FileText, HelpCircle, Info, Landmark, Megaphone, Scale, ShieldCheck, ScrollText } from "lucide-react";

type TabId = "announce" | "help" | "legal" | "resources";

// ═══ 静态内容数据 ═══
const ANNOUNCEMENTS = [
  { date: "2026-09-06", title: "科研工作台 DAG 编排上线", body: "可视化 DAG 科研编排已上线: 支持五阶段论文模板一键铺开 / 自然语言转研究框架 / 节点级工作界面与素材闭环。" },
  { date: "2026-09-05", title: "审稿实验室开放", body: "AI 审稿实验室支持: 期刊投稿须知智能解析入库 / 分段流式审稿 / 维度评分卡 / Word 批注导出。" },
  { date: "2026-09-03", title: "学术编辑器升级", body: "新增选中文本六模式改写(润色/压缩/去模板/语病/期刊风格/消除AI痕迹)与全文一致性检查。" },
  { date: "2026-08-30", title: "积分体系启用", body: "每日签到 +20 分; 兑换码/邀请码可得积分; 各 AI 模块按量计点(冻结-实扣对账, 禁止透支)。" },
  { date: "2026-08-28", title: "对话式科研绘图上线", body: "自然语言出图 → 真实数据计算 → 自审修订闭环 → PNG + 可编辑 SVG 版本化产物。" },
];

const HELP_ITEMS = [
  { q: "如何开始一个科研项目?", a: "进入「科研工作台 DAG」→ 新建空白画布或选五阶段论文模板(自动铺好研究要素节点与连线)→ 双击节点打开工作界面执行/编辑 → 素材自动入库可注入下游写作节点。" },
  { q: "论文写作后如何自查?", a: "三种方式: ①「学术编辑器」选中文本做六模式改写/全文一致性检查 ②「审稿实验室」传全文跑维度评分卡(可选用目标期刊规则) ③「格式智能评测」做投稿格式预检。" },
  { q: "绘图能基于我的真实数据吗?", a: "可以。在「科研绘图」会话里上传 CSV, Agent 先跑 analyze_data 真实计算再出图, 避免幻觉图表; 产物带自审修订与可再编辑 SVG。" },
  { q: "积分如何获得与消耗?", a: "获得: 每日签到(+20)、兑换码、邀请奖励; 消耗: 按 AI 功能调用计点(冻结→核销对账)。余额不足时冻结失败会提示, 不会透支。" },
  { q: "数据与文献存在哪里?", a: "本地 PostgreSQL(PG 向量库)+ Neo4j 双图谱(Graphiti/Cognee)+ LanceDB; 文献入库支持 PDF 批量与 Obsidian 管道。" },
  { q: "如何获取支持?", a: "见下方「联系我们」: 反馈表单/邮箱/微信服务号; 帮助中心将持续补充。" },
];

const LEGAL_SECTIONS = [
  { icon: ShieldCheck, title: "隐私政策", body: "本平台数据默认存储于您自有的本地/自托管环境中。使用云端模型 API 时, 仅在单次请求处理所需范围内向模型服务商发送文本, 不用于训练。密钥与令牌加密存储。" },
  { icon: Scale, title: "条款声明", body: "本平台为科研辅助工具。AI 生成内容仅供研究参考, 使用者须自行核实文献真实性、数据来源与合规性, 并对最终成果负责。" },
  { icon: Landmark, title: "版权与开源", body: "MarxSphere 以 AGPL-3.0 开源(含例外条款)。平台内置知识图谱语料来自公开学术资源, 引用均保留来源溯源。" },
  { icon: Megaphone, title: "免责说明", body: "AI 辅助写作能力(润色/改写/去AI痕迹)仅优化表达, 不改变事实与结构; 全文检查不验证文献真实存在与否(与引文三维核验功能分工)。使用者须遵守所在机构学术规范。" },
];

const RESOURCE_GROUPS = [
  { category: "学术数据库", color: "#f59e0b", sites: [
    { name: "中国知网 CNKI", url: "https://www.cnki.net", desc: "中文学术资源数据库" },
    { name: "百度学术", url: "https://xueshu.baidu.com", desc: "中文学术搜索" },
    { name: "Web of Science", url: "https://www.webofscience.com", desc: "国际权威引文数据库" },
    { name: "国家哲学社会科学文献中心", url: "https://www.ncpssd.org", desc: "社科开放资源" },
  ]},
  { category: "开放获取/预印本", color: "#10b981", sites: [
    { name: "CNKI 海外开放学术", url: "https://oversea.cnki.net", desc: "开放学术搜索" },
    { name: "OpenAlex", url: "https://openalex.org", desc: "全球开放学术元数据" },
    { name: "arXiv", url: "https://arxiv.org", desc: "预印本(计算机/交叉学科)" },
    { name: "PubMed", url: "https://pubmed.ncbi.nlm.nih.gov", desc: "生物医学文献" },
  ]},
  { category: "统计与数据", color: "#3b82f6", sites: [
    { name: "国家统计局", url: "https://www.stats.gov.cn", desc: "宏观统计年鉴" },
    { name: "世界银行开放数据", url: "https://data.worldbank.org", desc: "跨国面板数据" },
    { name: "中国家庭追踪调查 CFPS", url: "https://www.isss.pku.edu.cn/cfps", desc: "微观追踪调查" },
    { name: "中国综合社会调查 CGSS", url: "http://www.cssod.org", desc: "社会调查数据" },
  ]},
  { category: "文献管理与写作", color: "#8b5cf6", sites: [
    { name: "Zotero", url: "https://www.zotero.org", desc: "文献管理(平台已内置接入)" },
    { name: "DeepL", url: "https://www.deepl.com", desc: "学术翻译" },
    { name: "Grammarly", url: "https://www.grammarly.com", desc: "英文语法检查" },
    { name: "Obsidian", url: "https://obsidian.md", desc: "知识库笔记(平台已内置管道)" },
  ]},
];

export function SiteContentPanel() {
  const [tab, setTab] = useState<TabId>("announce");

  const tabBtn = (id: TabId, label: string, icon: React.ReactNode) => (
    <button key={id} onClick={() => setTab(id)}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition ${tab === id ? "bg-slate-600 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"}`}>
      {icon}{label}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Info className="h-5 w-5 text-sky-400" />
          <h2 className="text-base font-bold text-slate-100">站点内容</h2>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">科研工作台</span>
        </div>
        <div className="flex gap-1 rounded-lg bg-slate-800/80 p-0.5">
          {tabBtn("announce", "公告", <Megaphone className="h-3 w-3" />)}
          {tabBtn("help", "帮助中心", <HelpCircle className="h-3 w-3" />)}
          {tabBtn("legal", "条款与隐私", <ScrollText className="h-3 w-3" />)}
          {tabBtn("resources", "学术资源导航", <BookOpen className="h-3 w-3" />)}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-900/50 p-4">
        {tab === "announce" && (
          <div className="space-y-3">
            {ANNOUNCEMENTS.map((a) => (
              <div key={a.date + a.title} className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-3">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-slate-700/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">{a.date}</span>
                  <span className="text-sm font-medium text-slate-100">{a.title}</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{a.body}</p>
              </div>
            ))}
          </div>
        )}

        {tab === "help" && (
          <div className="space-y-2">
            {HELP_ITEMS.map((h) => (
              <details key={h.q} className="group rounded-lg border border-slate-700/50 bg-slate-800/40 p-3">
                <summary className="flex cursor-pointer items-center justify-between text-xs font-medium text-slate-200">
                  {h.q}
                  <ChevronRight className="h-3.5 w-3.5 text-slate-500 transition group-open:rotate-90" />
                </summary>
                <p className="mt-2 text-xs leading-relaxed text-slate-400">{h.a}</p>
              </details>
            ))}
            <div className="mt-4 rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 text-xs text-slate-300">
              <p className="font-semibold text-cyan-300">联系我们</p>
              <p className="mt-1 leading-relaxed text-slate-400">· 站内反馈: 任意页面右下「科研助手」或系统反馈入口<br/>· 邮箱/微信: 见管理员配置(运营管理面板)</p>
            </div>
          </div>
        )}

        {tab === "legal" && (
          <div className="grid gap-3 lg:grid-cols-2">
            {LEGAL_SECTIONS.map((s) => (
              <div key={s.title} className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                  <s.icon className="h-3.5 w-3.5 text-sky-400" />{s.title}
                </p>
                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">{s.body}</p>
              </div>
            ))}
          </div>
        )}

        {tab === "resources" && (
          <div className="grid gap-4 lg:grid-cols-2">
            {RESOURCE_GROUPS.map((g) => (
              <div key={g.category}>
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold" style={{ color: g.color }}>
                  <FileText className="h-3 w-3" />{g.category}
                </p>
                <div className="space-y-1.5">
                  {g.sites.map((s) => (
                    <a key={s.name} href={s.url} target="_blank" rel="noreferrer"
                      className="flex items-center justify-between rounded-lg border border-slate-700/40 bg-slate-800/30 px-3 py-2 transition hover:border-slate-500 hover:bg-slate-800">
                      <div>
                        <p className="text-xs font-medium text-slate-200">{s.name}</p>
                        <p className="text-[10px] text-slate-500">{s.desc}</p>
                      </div>
                      <ExternalLink className="h-3 w-3 shrink-0 text-slate-500" />
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
