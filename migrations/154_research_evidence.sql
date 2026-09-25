-- 154_research_evidence.sql
--
-- 由来(2026-09-25): 写作舱的正文是**没有研究证据的**。实测三条:
--   ① 章节生成的 prompt 里根本没有"数据/结果/发现"的位置 —— 它只拿到
--      论文主题/论点/大纲/前文/语体/文献池/样例(paper-outline-service.generateChapter);
--   ② 后端**写好了**一条素材注入通道(`runLlmJob` 里的 `【可用素材】`), 但它只在
--      `chapter_gen|finalize|writing` 三种 jobKind 下触发, 而那是 executorMap **没命中**时的
--      兜底分支 —— 写作舱用的 jobKind 全部命中 executorMap, 且那三种 jobKind 全仓无人创建
--      ⇒ 这条通道是**死代码, 一次都没执行过**;
--   ③ 假设(H1..Hn)只存在于 analysis 节点的 JSON 里, 没有"用数据检验它"这一步, 更没有回写。
--
-- 于是"研究"与"写作"是两件互不相干的事: 跑完回归, 正文里一个字都不会变。
-- 本迁移建两张表, 把这条线接上。
--
-- ⚠ 为什么不复用 research_materials 的 section_ids:
--   那是"这条素材挂在哪几章"(素材视角, 多对多, 靠 jsonb 数组), 适合资料管理;
--   这里要的是**逐章的依据清单 + 用户自己写的"用它做什么"说明**(章节视角, 有序, 可带备注),
--   还要能引用"某次分析"(stats_jobs.id)、"某条假设"这些**不是素材**的东西。
--   硬塞进 section_ids 会得到一个既不能排序、也不能写理由、还不能引用分析的半成品。
--
-- 幂等: create table if not exists / drop trigger if exists before create。

-- ═══ 章节依据 ═══
-- ref_id 是**无外键的软引用**: 它按 kind 指向 research_materials.id / stats_jobs.id /
--   research_hypotheses.id 三张不同的表。加外键就必须拆成三张表或三列, 而查询侧永远
--   是"按章节一次取全部依据", 拆开只会让这个主查询变成三次 join + 合并。
--   代价: 被引用对象删除后依据行会悬空 —— 读取侧**按 kind 逐类过滤**并丢弃取不到的,
--   不报错、不显示空壳条目(buildEvidenceBlock 的 shape 就是这么写的)。
create table if not exists research_chapter_evidence (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references research_projects(id) on delete cascade,
  section_id  text not null,
  kind        text not null check (kind in ('material','analysis','hypothesis','finding')),
  ref_id      text not null,
  note        text not null default '',
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

-- 主查询形状: 按项目取全部(前端一次拉全项目所有章节的依据, 切章不重查)
create index if not exists idx_chapter_evidence_project
  on research_chapter_evidence (project_id, section_id, sort_order);

-- 同一章同一依据只应有一条(前端是全量替换式保存, 这条只是防并发重复插入)
create unique index if not exists uq_chapter_evidence_ref
  on research_chapter_evidence (project_id, section_id, kind, ref_id);

-- ═══ 假设检验台账 ═══
-- 与 analysis 节点里的 `hypotheses: string[]` 的关系:
--   analysis 节点那份是**框架设计阶段由 LLM 生成**的假设草案, 只有文本;
--   本表是**台账** —— 同一批假设, 但多了"检验结论 + 依据"(这是真实科研里必须有的一步)。
--   syncHypothesesFromAnalysis() 负责把草案灌进来(只补不覆盖), 之后以本表为准。
--   反过来不行: 结论写在 jsonb 数组里没法按假设检索, 也没法只改一条。
create table if not exists research_hypotheses (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references research_projects(id) on delete cascade,
  -- "H1" / "H2"... —— 正文里引用的就是它, 所以项目内唯一
  code         text not null default '',
  text         text not null default '',
  -- 四态而不是布尔: "还没跑数据"与"跑了但结果不显著"是两回事, 合成 false 会让
  --   进度条把"待检验"显示成"已否定"
  verdict      text not null default 'pending'
                 check (verdict in ('pending','supported','partially_supported','rejected')),
  -- 依据 = 哪次分析的哪个系数 + 显著性。自由文本, 但正文章节核验(A3)会拿它做提示。
  evidence_ref text not null default '',
  rationale    text not null default '',
  sort_order   int  not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_research_hypotheses_project
  on research_hypotheses (project_id, sort_order, created_at);
create unique index if not exists uq_research_hypotheses_code
  on research_hypotheses (project_id, code) where code <> '';

-- ═══ 发现台账(B: 系统产生发现) ═══
-- 每行 = **一个可溯源的发现**: 某个分析跑出来的某个变量上的某个显著系数。
-- 与 A 批的区别: A 是"研究者带证据进来", 这里是"系统自己从结果里挖出候选发现"。
-- 因此溯源列(哪次分析/哪个变量/系数/标准误/p/N)是**必填的**, claim 只是它的自然语言外壳。
-- 不给溯源列的"发现"就是模型编的 —— 那在学术上是灾难, 所以不设"手填发现"这条路。
create table if not exists research_findings (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references research_projects(id) on delete cascade,
  -- 来源分析(stats_jobs.id)。软引用, 同上。
  job_id      text not null default '',
  tool        text not null default '',
  var_name    text not null default '',
  coef        double precision,
  std_err     double precision,
  t_value     double precision,
  p_value     double precision,
  ci_low      double precision,
  ci_high     double precision,
  -- '***' / '**' / '*' / '' —— 存下来而不是每次现算, 因为阈值口径将来可能改, 而
  --   已经写进正文的那句话必须对得上当时的判定
  stars       text not null default '',
  n_obs       int,
  r_squared   double precision,
  -- 自然语言外壳(可由 LLM 优化, 但数字部分必须与上面各列一致 —— 核验会检查这一点)
  claim       text not null default '',
  status      text not null default 'candidate'
                check (status in ('candidate','adopted','dismissed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_research_findings_project
  on research_findings (project_id, created_at desc);
-- 同一个分析的同一个变量只应挖出一条(重复抽取时靠它去重, 而不是靠应用层比对浮点)
create unique index if not exists uq_research_findings_src
  on research_findings (project_id, job_id, var_name);
