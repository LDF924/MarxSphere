-- 160_research_checkup.sql — 中期检查 / 结项验收: 上传的检查表与逐项台账
--
-- 由来(2026-09-27 用户拍板): 17 环节里的中期检查、结项验收此前**明确排除在外**,
--   排除理由写的是"那些是项目管理不是研究"。**这条理由站不住** —— 按它推,
--   批6(评审返修)与批9(录用出版)同样不是"研究", 但那两批都做了。
--
--   真正的分界线是另一条, 而且是本仓反复验证过的一条:
--   **这件事的数据在不在平台手上。**
--     中期检查要的是"学院/学校给的那张检查表" —— 平台没有;
--     结项验收要的是"项目的结项书模板 + 成果认定口径" —— 平台也没有。
--   没有数据来源而硬做的功能, 做出来就是"生成一段放之四海皆准的套话",
--   而用户把它填进真实表格会被打回来。这与批9 否掉"让模型写版权声明"是同一条判据
--   (见 post-acceptance.ts 开头那段)。
--
--   所以这两项**现在做**, 但形态是「上传检查表 → 逐项对着填 → 缺失项明确留空」,
--   与批9 的校样核对同一模式: 平台负责把已有的事实整理进去, **不替用户编**。
--
-- ⚠ 本表只存"用户上传的检查表 + 逐项填写结果"。
--   **自动填进去的值不在这里** —— 它们是每次读取时从项目的真数据现算的
--   (章节/素材/假设/发现/申报文书/投稿记录/转化记录/版本历史), 存一份快照必然漂移,
--   而"检查表里写着 12 章、实际有 15 章"是会被受理方当场抓出来的。
--
-- 幂等: create table if not exists / create index if not exists。

create table if not exists research_checkup_documents (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references research_projects(id) on delete cascade,
  -- midterm(中期检查) / final(结项验收) —— 两份表结构相同, 用 kind 区分。
  -- 拆两张表会让拆条/导出/前端三处各抄一遍; 两者的差别只在"表里的条目"。
  kind        text not null check (kind in ('midterm', 'final')),
  -- 原始文本(用户粘贴或从上传文件提取的)。**留着**, 因为条目拆错了要能回到原文对。
  raw_text    text not null default '',
  source_name text not null default '',     -- 上传的文件名(粘贴时为空)
  -- 拆出来的条目。形状见 src/services/checkup-service.ts 的 CheckupItem:
  --   { section, label, hint, kind: auto|manual|platform_missing, value, autoSource }
  -- kind 是**在服务端算的**(要读项目真数据), 前端只渲染 —— 所以这里存的是结果。
  items       jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 一个项目同一类只留一份: 用户重新上传是**替换**整张表, 不是并排两份
--   (并排会让"我到底该交哪一份"变成一个真实存在但没人该问的问题)。
create unique index if not exists uq_research_checkup_project_kind
  on research_checkup_documents (project_id, kind);
