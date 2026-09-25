// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// SiteContentPanel.tsx — SocialSci P2: 站点内容页(公告/帮助/法律条款/学术资源导航)
// 形态对齐(参考产品内容页语义, 原创实现): 纯前端静态数据驱动, 不改 server 主流程
//   J1 新闻/公告 | J2 帮助中心 | J3 条款/隐私/免责 | J4 学术资源导航
//
// V418(2026-09-15): 全量更新 —— 原内容停在 2026-09-06, 且面板内**不能导航**:
//   帮助里写"进入「科研工作台 DAG」"但菜单实际叫「课题流程编排」, 用户照着找不到。
//   本次: ① 公告/帮助按 09-07~09-15 真实落地功能重写 ② 加 onNavigate, 帮助条目直接跳视图
//   ③ 条款补上 2026-09-15 安全整改后的事实(AES-256-GCM/BYOK/外部令牌) ④ 资源导航对齐平台真接入
import { useState, useEffect, type ReactNode } from "react";
import { BookOpen, ChevronRight, ExternalLink, FileText, HelpCircle, Info, Landmark, Megaphone, Scale, ShieldCheck, ScrollText } from "lucide-react";
import type { WorkspaceView } from "../App";

type TabId = "announce" | "help" | "legal" | "resources";

/** 可跳转到的视图 = 除自身与"home"外的全部视图(含 settings —— 帮助里要引导生成外部接入令牌) */
type NavTarget = Exclude<WorkspaceView, "home" | "site-content">;

// 科研助手 [data-control] 埋点: tab id → <view>:<key>
const TAB_CONTROLS: Record<TabId, string> = {
  announce: "site-content:announce",
  help: "site-content:help",
  legal: "site-content:legal",
  resources: "site-content:resources",
};

// ═══ 静态内容数据 ═══
const ANNOUNCEMENTS = [
  {
    date: "2026-09-15", title: "安全审计整改 15 项", tag: "安全",
    body: "越权/审计留痕/沙箱逃逸/密钥明文/提示注入五类问题全量修复: 工具权限改为 fail-closed(未登记即拒绝)、BYOK 密钥升级 AES-256-GCM 加密存储、沙箱环回地址默认拦截、提示注入防护入库。",
  },
  {
    date: "2026-09-15", title: "模型名统一 + 挂起熔断", tag: "稳定性",
    body: "DeepSeek 官方已启用新模型名 deepseek-flash; 旧名 deepseek-chat / deepseek-v4-flash 会返回 200 响应头但正文挂起(静默失败)。现已统一新名, 并对挂起模型加 8 秒首字节熔断 + 自动回退 deepseek-v4-pro。",
  },
  {
    date: "2026-09-15", title: "记忆层一键激活", tag: "记忆",
    body: "「记忆」面板新增 OpenViking 状态徽标与一键激活: 显示离线时点一下即可拉起, 无需再依赖后台保活。同时修复嵌入密钥配置错误与队列毒消息导致的长期卡死。",
  },
  {
    date: "2026-09-15", title: "研途写作舱升级", tag: "写作",
    body: "文献检索接入真实数据源, 并修复跨用户越权与素材丢失问题; 各模块产物可一键送入写作舱。",
  },
  {
    date: "2026-09-14", title: "科研助手全站覆盖", tag: "助手",
    body: "科研助手现在覆盖全部 48 个工作台视图, 能感知当前页上下文; Vue 子应用(编辑器/评审/绘图/编排)内的操作按钮也可被助手直接调用。",
  },
  {
    date: "2026-09-14", title: "技能越用越熟闭环", tag: "技能",
    body: "修复中文技能召回恒为 0、使用效果不回写两处断链; 同名技能不再重复克隆(原 144 行技能里只有 15 个不同名字)。",
  },
  {
    date: "2026-09-13", title: "课题流程编排上线", tag: "编排",
    body: "可视化 DAG 科研编排: 五阶段论文模板一键铺开 / 自然语言转研究框架 / 节点级工作界面 / 素材自动入库并注入下游写作节点; 画布参数已真实生效, 节点成本与开关可见。",
  },
  {
    date: "2026-09-12", title: "论文质量评审升级", tag: "评审",
    body: "新增审稿库(使用统计/规则来源/覆盖率), 支持批量评审、审核标准可组合、模板导入导出、期刊对比、纵向对比与编辑器联动; 卡死的排队任务现在可取消可删除。",
  },
  {
    date: "2026-09-12", title: "修复界面假登录", tag: "修复",
    body: "登录过期后前端仍显示已登录、所有请求 401 却无人响应的问题已修复, 现在会正确跳回登录态。",
  },
  {
    date: "2026-09-11", title: "编辑器 AI 计费与积分门控", tag: "计费",
    body: "编辑器 AI 助手全部动作纳入成本账本与积分门控; 模型注册表扩展至 DeepSeek / 通义千问 / Claude 三类可切换。",
  },
];

const HELP_ITEMS: Array<{ q: string; a: string; view?: NavTarget; link?: string }> = [
  {
    q: "如何开始一个科研项目?",
    a: "「课题流程编排」新建空白画布, 或选五阶段论文模板(自动铺好研究要素节点与连线) → 双击节点打开工作界面执行 → 素材自动入库, 可注入下游写作节点。也可以先走「研途写作舱」的五步向导, 从研究问题一路做到成稿。",
    view: "dag-workbench",
  },
  {
    q: "论文写完后怎么自查?",
    a: "三步递进: ①「学术文本工作台」选中文本做六模式改写 + 全文一致性检查 ②「论文质量评审」传全文跑维度评分卡(可选目标期刊规则) ③「格式智能评测」做投稿格式预检。引文真实性用「引文核验」单独查。",
    view: "editor",
  },
  {
    q: "文献从哪里来? 外部检索能查到什么?",
    a: "四种进法: ①「文献库」本地上传(支持 PDF 批量与 Obsidian 管道) ②「文献管理」接 Zotero / RSS ③「外部检索」按 OpenAlex / Unpaywall 查全球开放学术元数据并带回原文链接 ④ 平台内置的 MCP/API 供外部 Agent 调用入库。",
    view: "literature",
  },
  {
    q: "引用是否真实存在, 怎么验?",
    a: "「引文核验」做三维核验: 元数据真伪(Crossref + OpenAlex 双查) / 语境相关性 / 断言支持度。结果会指出哪条引用查无此文、哪条存在但与本文语境不符。",
    view: "citation-verify",
  },
  {
    q: "绘图能基于我的真实数据吗?",
    a: "可以, 而且默认如此。「成果可视化工坊」里上传 CSV 后, Agent 先跑 analyze_data 真实计算再出图, 避免幻觉图表; 产物带自审修订与可再编辑的 SVG 版本。",
    view: "plot-agent",
  },
  {
    q: "问卷和统计分析怎么做?",
    a: "「实证研究」是一整条链路: 问卷生成/识别 → 信效度检验(α/KMO/Bartlett) → 题项诊断 → LLM 缺失值插补 → 变量敲定(反幻觉白名单) → 分析管道 → 回归建模(M1-M6 渐进控制/固定效应/稳健性) → 证据账本 → 质量闸门。",
    view: "empirical-research",
  },
  {
    q: "「记忆」面板显示 OpenViking 离线怎么办?",
    a: "点面板上方的「一键激活」即可拉起, 等待徽标转为在线(约十秒)。记忆层负责跨会话记住你的偏好、经验与历史交互, 离线时推理仍可正常工作, 只是不再累积新记忆。",
    view: "memory",
  },
  {
    q: "积分如何获得与消耗?",
    a: "获得: 每日签到(+20)、兑换码、邀请奖励。消耗: 按 AI 功能调用计点(冻结 → 核销对账)。余额不足时冻结会失败并提示, 不会透支。平台 token 成本与用户积分是两套独立账本, 可在「账户计费」查看。",
    view: "billing",
  },
  {
    q: "数据与文献存在哪里? 会不会上传?",
    a: "默认全部存于你自有的本地/自托管环境: PostgreSQL(pgvector 向量库)+ Neo4j 双图谱(Graphiti / Cognee)+ LanceDB。只有当你使用云端模型时, 单次请求所需的文本片段会发给对应模型服务商, 不用于训练。",
  },
  {
    q: "怎么把 MarxSphere 接进 Claude Code 或 Codex?",
    a: "「设置」页生成 sag_xxx 令牌 → 填入 Claude Code 的 .mcp.json 或 Codex 的 config.toml → 外部 Agent 即可直接调用推理、多源检索与文档入库。令牌按权限分级, 可随时吊销。",
    view: "settings",
  },
  {
    q: "如何获取支持?",
    a: "见下方「联系我们」: 站内反馈 / 邮箱 / 微信服务号。帮助中心会随版本持续补充。",
  },
];

const LEGAL_SECTIONS = [
  {
    icon: ShieldCheck, title: "隐私政策",
    body: "本平台数据默认存储于你自有的本地/自托管环境中。使用云端模型 API 时, 仅在单次请求处理所需的范围内向模型服务商发送文本, 不用于训练。用户自备的模型密钥(BYOK)以 AES-256-GCM 加密存储, 密钥不回显; 日志输出前经脱敏处理。",
  },
  {
    icon: Scale, title: "条款声明",
    body: "本平台为科研辅助工具。AI 生成内容仅供研究参考, 使用者须自行核实文献真实性、数据来源与合规性, 并对最终成果负责。平台的引文核验、格式评测等能力是辅助手段, 不构成学术合规的最终判定。",
  },
  {
    icon: Landmark, title: "版权与开源",
    body: "MarxSphere 以 AGPL-3.0 开源(含例外条款), 源码见仓库 LICENSE。平台内置知识图谱语料来自公开学术资源, 引用均保留来源溯源。第三方组件的许可与出处见 THIRD_PARTY_NOTICES。",
  },
  {
    icon: Megaphone, title: "免责说明",
    body: "AI 辅助写作能力(润色/改写/去 AI 痕迹)仅优化表达, 不改变事实与结构; 全文一致性检查不验证文献是否真实存在(该职责由引文核验承担)。使用者须遵守所在机构的学术规范与投稿要求。",
  },
];

// 资源导航: 与平台真实接入保持一致 —— 标「已内置接入」的条目在站内有对应能力
const RESOURCE_GROUPS = [
  { category: "学术数据库", color: "#f59e0b", sites: [
    { name: "中国知网 CNKI", url: "https://www.cnki.net", desc: "中文学术资源数据库" },
    { name: "百度学术", url: "https://xueshu.baidu.com", desc: "中文学术搜索" },
    { name: "Web of Science", url: "https://www.webofscience.com", desc: "国际权威引文数据库" },
    { name: "国家哲学社会科学文献中心", url: "https://www.ncpssd.org", desc: "社科开放资源" },
  ]},
  { category: "开放获取 / 预印本", color: "#10b981", sites: [
    { name: "OpenAlex", url: "https://openalex.org", desc: "全球开放学术元数据(平台已内置接入)" },
    { name: "Unpaywall", url: "https://unpaywall.org", desc: "开放获取全文定位(平台已内置接入)" },
    { name: "CNKI 海外开放学术", url: "https://oversea.cnki.net", desc: "开放学术搜索" },
    { name: "arXiv", url: "https://arxiv.org", desc: "预印本(计算机/交叉学科)" },
  ]},
  { category: "统计与数据", color: "#3b82f6", sites: [
    { name: "国家统计局", url: "https://www.stats.gov.cn", desc: "宏观统计年鉴" },
    { name: "世界银行开放数据", url: "https://data.worldbank.org", desc: "跨国面板数据" },
    { name: "中国家庭追踪调查 CFPS", url: "https://www.isss.pku.edu.cn/cfps", desc: "微观追踪调查" },
    { name: "中国综合社会调查 CGSS", url: "http://www.cssod.org", desc: "社会调查数据" },
  ]},
  { category: "文献管理与写作", color: "#8b5cf6", sites: [
    { name: "Zotero", url: "https://www.zotero.org", desc: "文献管理(平台已内置接入)" },
    { name: "Obsidian", url: "https://obsidian.md", desc: "知识库笔记(平台已内置管道)" },
    { name: "DeepL", url: "https://www.deepl.com", desc: "学术翻译" },
    { name: "Grammarly", url: "https://www.grammarly.com", desc: "英文语法检查" },
  ]},
];

export function SiteContentPanel({ onNavigate }: { onNavigate?: (view: WorkspaceView) => void } = {}) {
  const [tab, setTab] = useState<TabId>("announce");
  // 部署版本: 从 /health 读。站点内容页此前没有任何版本信息, 用户报障时无从判断跑的是哪一版。
  // /health 是白名单路由(免鉴权), 所以这里直接 fetch 不经过 api.ts 的令牌包装。
  const [version, setVersion] = useState("");
  useEffect(() => {
    let cancelled = false;
    void fetch("/health")
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j?.version) setVersion(String(j.version)); })
      .catch(() => { /* 读不到就不显示, 不编造 */ });
    return () => { cancelled = true; };
  }, []);

  const tabBtn = (id: TabId, label: string, icon: ReactNode) => (
    <button key={id} data-control={TAB_CONTROLS[id]} onClick={() => setTab(id)}
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
          {version ? <span className="rounded-full bg-slate-800/70 px-2 py-0.5 font-mono text-[10px] text-slate-500">v{version}</span> : null}
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
                  {a.tag ? <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300">{a.tag}</span> : null}
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
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500 transition group-open:rotate-90" />
                </summary>
                <p className="mt-2 text-xs leading-relaxed text-slate-400">{h.a}</p>
                {h.view && onNavigate ? (
                  <button
                    type="button"
                    onClick={() => onNavigate(h.view as WorkspaceView)}
                    className="mt-2 inline-flex items-center gap-1 rounded-md bg-sky-500/15 px-2 py-1 text-[11px] text-sky-300 transition hover:bg-sky-500/25"
                  >
                    前往对应工作台<ChevronRight className="h-3 w-3" />
                  </button>
                ) : null}
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
