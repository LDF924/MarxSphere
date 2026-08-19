// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// sources-registry.ts — MarxSphere 统一数据源注册表（30 个外部源）
// 每个源：名称/类型/状态/URL/说明。供前端 SourcesPanel 展示 + 后端接入判断。
// 类型: api(开放API) | web(网页转PDF) | mcp(现成MCP) | auth(需注册/机构)
// 状态: active(已接入) | ready(可接入,未接入) | requires_auth(需注册/权限) | deprecated

export interface DataSource {
  id: string;
  name: string;
  type: "api" | "web" | "mcp" | "auth";
  status: "active" | "ready" | "requires_auth";
  url: string;
  category: string;       // 学术/政策/理论/数据/国际
  description: string;
  fitScore: 1 | 2 | 3;    // 贴合度：3=核心 2=重要 1=可选
}

export const DATA_SOURCES: DataSource[] = [
  // ─── 政策 / 政府权威源 ───
  {
    id: "gov-cn-policy",
    name: "中国政府网政策文件库",
    type: "mcp",
    status: "active",
    url: "https://www.gov.cn/zhengce/zhengcewenjianku",
    category: "政策",
    description: "国务院政策全文检索（China-Central-Policy-MCP）",
    fitScore: 3
  },
  {
    id: "moa",
    name: "农业农村部官网",
    type: "web",
    status: "ready",
    url: "https://www.moa.gov.cn",
    category: "政策",
    description: "涉农法律/法规/公报/土地流转专栏",
    fitScore: 3
  },
  {
    id: "central-no1",
    name: "中央一号文件历年全文",
    type: "web",
    status: "ready",
    url: "https://www.gov.cn/zhengce/zhengcewenjianku",
    category: "政策",
    description: "2004-2026 历年三农最高纲领",
    fitScore: 3
  },
  {
    id: "jhsjk",
    name: "习近平系列重要讲话数据库",
    type: "web",
    status: "ready",
    url: "http://jhsjk.people.cn",
    category: "政策",
    description: "三农/乡村振兴/共同富裕论断一手出处",
    fitScore: 3
  },
  {
    id: "lilun-db",
    name: "中国共产党思想理论资源数据库",
    type: "auth",
    status: "requires_auth",
    url: "https://data.lilun.cn",
    category: "政策",
    description: "中央文献/领导人著作权威定本（需机构权限）",
    fitScore: 3
  },
  {
    id: "people-data",
    name: "人民数据库",
    type: "auth",
    status: "requires_auth",
    url: "http://data.people.com.cn",
    category: "理论",
    description: "人民日报评论/言论/学术理论库（需机构权限）",
    fitScore: 2
  },

  // ─── 理论 / 媒体源 ───
  {
    id: "qstheory",
    name: "求是网 + 红旗文稿",
    type: "web",
    status: "active",
    url: "http://www.qstheory.cn",
    category: "理论",
    description: "党中央机关刊《求是》《红旗文稿》",
    fitScore: 3
  },
  {
    id: "xuexi-cn",
    name: "学习强国",
    type: "web",
    status: "requires_auth",
    url: "https://www.xuexi.cn",
    category: "理论",
    description: "总书记重要论述/权威理论文章/要闻时政",
    fitScore: 3
  },
  {
    id: "people-theory",
    name: "人民日报理论版",
    type: "web",
    status: "active",
    url: "http://theory.people.com.cn",
    category: "理论",
    description: "人民日报理论文章聚合",
    fitScore: 3
  },
  {
    id: "gmw-theory",
    name: "光明日报理论版",
    type: "web",
    status: "active",
    url: "https://theory.gmw.cn",
    category: "理论",
    description: "光明理论/哲学社科导向",
    fitScore: 2
  },
  {
    id: "studytimes",
    name: "学习时报",
    type: "web",
    status: "active",
    url: "https://www.studytimes.cn",
    category: "理论",
    description: "中央党校机关报/四报理论聚合",
    fitScore: 2
  },
  {
    id: "ce-theory",
    name: "经济日报理论版",
    type: "web",
    status: "active",
    url: "http://theory.people.com.cn",
    category: "理论",
    description: "经济政策理论解读（转载聚合）",
    fitScore: 2
  },
  {
    id: "cssn",
    name: "中国社会科学网/马研网",
    type: "web",
    status: "active",
    url: "https://www.cssn.cn",
    category: "学术",
    description: "社科院学术网/《马克思主义研究》动态",
    fitScore: 2
  },
  {
    id: "aisixiang",
    name: "爱思想网",
    type: "web",
    status: "active",
    url: "https://www.aisixiang.com",
    category: "理论",
    description: "公益学术/政经深度文章",
    fitScore: 1
  },

  // ─── 学术数据库 ───
  {
    id: "ncpssd",
    name: "国家哲社文献中心 NCPSSD",
    type: "auth",
    status: "requires_auth",
    url: "https://www.ncpssd.cn",
    category: "学术",
    description: "国家级开放哲社平台/核心期刊全",
    fitScore: 3
  },
  {
    id: "nssf-projects",
    name: "国家社科基金立项库",
    type: "auth",
    status: "requires_auth",
    url: "https://www.nopss.gov.cn",
    category: "学术",
    description: "立项Excel下载/课题地图（NCPSSD项目库）",
    fitScore: 3
  },
  {
    id: "rdfybk",
    name: "人大复印报刊资料",
    type: "auth",
    status: "requires_auth",
    url: "https://www.rdfybk.com",
    category: "学术",
    description: "人大复印转载/评价指标（需校园网）",
    fitScore: 3
  },
  {
    id: "sklib",
    name: "马克思主义学术资源库",
    type: "auth",
    status: "requires_auth",
    url: "https://sklib.cn",
    category: "学术",
    description: "社科院马工程研究成果",
    fitScore: 2
  },
  {
    id: "nlc",
    name: "国家图书馆（文津）",
    type: "auth",
    status: "requires_auth",
    url: "https://www.nlc.cn",
    category: "学术",
    description: "读者卡远程175个数据库/兜底通道",
    fitScore: 2
  },
  {
    id: "openalex",
    name: "OpenAlex",
    type: "api",
    status: "active",
    url: "https://openalex.org",
    category: "学术",
    description: "全球开放学术图数据库/英文文献免key",
    fitScore: 3
  },
  {
    id: "core",
    name: "CORE.ac.uk",
    type: "api",
    status: "active",
    url: "https://core.ac.uk",
    category: "学术",
    description: "全球OA全文聚合/开放API",
    fitScore: 2
  },
  {
    id: "cnki",
    name: "CNKI 知网",
    type: "auth",
    status: "active",
    url: "https://www.cnki.net",
    category: "学术",
    description: "中文文献主力（已有 cnki skill）",
    fitScore: 3
  },

  // ─── 数据 / 统计 ───
  {
    id: "stats-gov",
    name: "国家统计数据发布库",
    type: "api",
    status: "ready",
    url: "https://data.stats.gov.cn",
    category: "数据",
    description: "1400万+笔统计/三农数据JSON接口",
    fitScore: 3
  },
  {
    id: "github",
    name: "GitHub",
    type: "api",
    status: "active",
    url: "https://github.com",
    category: "数据",
    description: "开源代码/仓库/用户/议题搜索（REST API，无 token 限 60 次/时）",
    fitScore: 2
  },

  // ─── 国际 / 马克思主义 ───
  {
    id: "mia",
    name: "MIA 中文马克思主义文库",
    type: "web",
    status: "ready",
    url: "https://www.marxists.org/chinese",
    category: "国际",
    description: "《资本论》/马恩文集全文/引文溯源",
    fitScore: 3
  },
  {
    id: "monthly-review",
    name: "Monthly Review",
    type: "api",
    status: "ready",
    url: "https://monthlyreview.org",
    category: "国际",
    description: "国际批判政治经济学/RSS订阅",
    fitScore: 3
  },
  {
    id: "worldbank",
    name: "World Bank OKR",
    type: "api",
    status: "active",
    url: "https://openknowledge.worldbank.org",
    category: "国际",
    description: "世行政策报告/农业农村实证PDF",
    fitScore: 3
  },
  {
    id: "nber",
    name: "NBER Working Papers",
    type: "web",
    status: "ready",
    url: "https://www.nber.org",
    category: "国际",
    description: "涉农/发展经济学工作论文PDF",
    fitScore: 2
  },
  {
    id: "ssrn",
    name: "SSRN / SocArXiv",
    type: "api",
    status: "ready",
    url: "https://www.ssrn.com",
    category: "国际",
    description: "社科预印本/涉农经济working paper",
    fitScore: 2
  },
  {
    id: "rrpe",
    name: "RRPE / Capital & Class",
    type: "auth",
    status: "requires_auth",
    url: "https://journals.sagepub.com",
    category: "国际",
    description: "激进政治经济学核心英文刊（部分OA）",
    fitScore: 2
  },
  {
    id: "cpeer",
    name: "中国政治经济学智库/公众号",
    type: "web",
    status: "ready",
    url: "https://www.cpeer.org",
    category: "理论",
    description: "马政经前沿内容流（公众号矩阵）",
    fitScore: 2
  }
];

export function getSourcesByStatus(status: DataSource["status"]): DataSource[] {
  return DATA_SOURCES.filter((s) => s.status === status);
}

export function getSourcesByType(type: DataSource["type"]): DataSource[] {
  return DATA_SOURCES.filter((s) => s.type === type);
}

export const sourcesRegistry = {
  list: () => DATA_SOURCES,
  byStatus: getSourcesByStatus,
  byType: getSourcesByType,
  count: DATA_SOURCES.length
};
