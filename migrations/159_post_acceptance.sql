-- 159_post_acceptance.sql — 批9: 录用之后的出版事务与传播复用
--
-- 由来(2026-09-27 全流程审计): 17 环节里的第 16(录用出版)、17(传播与复用)此前
-- **零实现**。投稿记录表(research_submissions)建到 `accepted` 状态就停了 ——
-- 那之后的事(选什么许可、走不走 OA、校样核了没、成果后来去了哪)平台一样不问。
-- 而复现材料打包已经在 2026-09-27 的批9 里做了(project-export-service 的 复现材料/)。
--
-- ⚠ **为什么校样/版权/OA 不做成 LLM 生成**:
--   · 校样检查要**看到校样**, 而校样是编辑部发来的文件 —— 平台手上没有,
--     让模型"写一份校样检查"只会得到一段放之四海皆准的套话;
--   · 版权/许可(版权转让书 / CC BY / CC BY-NC-ND…)与 OA 形式(订阅 / 金色 / 绿色 / 混合)
--     都是**标准条款的选择** —— 文本是固定的, 编出来是有害的(写错许可 = 权利让渡错)。
--   所以这三项按「**选择 + 模板填入 + 人工核对**」做, 与批5 的投稿声明同一模式。
--   成果转化与后续方向则是**用户自己记录的清单**, 更不该由模型代笔。
--
-- 幂等: add column if not exists / create table if not exists / create index if not exists。

-- ═══ 录用之后: 出版事务(挂在投稿记录上, 一次投稿一份) ═══
-- 为什么挂在 submissions 而不是新开一张表: 这些字段是**这次投稿**的属性
--   (投给 A 刊选了 CC BY, 改投 B 刊可能要重选), 拆表会让"这次投稿的全部信息"
--   散在两张表里, 而读取侧永远是一起取的。
alter table research_submissions add column if not exists license       text not null default '';
alter table research_submissions add column if not exists license_note  text not null default '';
alter table research_submissions add column if not exists oa_choice     text not null default '';
alter table research_submissions add column if not exists oa_note       text not null default '';
-- 校样: 三个字段而不是一个布尔 —— "核对过"与"核出问题没有"是两件事。
--   只记布尔的话, 用户核出问题却只能写在 note 里, 界面上分不清"没核"与"核了有问题"。
alter table research_submissions add column if not exists proof_checked boolean not null default false;
alter table research_submissions add column if not exists proof_notes   text not null default '';
-- 录用日期。submitted_on 是"投出", 这个才是"确定录用" —— 后续排期/成果登记都要它。
alter table research_submissions add column if not exists accepted_on   date;

-- ═══ 传播与复用: 成果转化 + 后续研究方向 ═══
-- 两者共用一张表、用 kind 区分:
--   形状完全相同(一条一条的短记录 + 说明), 拆两张表会让两边的 CRUD 各抄一遍;
--   而语义差别只在"这件事是已发生的(转化)还是待做的(方向)"。
--   查询侧永远按 kind 分别取, 不需要跨 kind 的 join。
create table if not exists research_followups (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references research_projects(id) on delete cascade,
  kind        text not null default 'direction'
                check (kind in ('translation','direction')),
  -- 转化: "被《XX》2026年第3期引用" / "政策报告采纳" / "媒体报道"…
  -- 方向: "把样本扩到县域层面" / "换识别策略做稳健性"…
  title       text not null default '',
  detail      text not null default '',
  -- 转化条目常有发生时间(被引用的时间), 方向条目常没有。都放 date, 可空。
  happened_on date,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_research_followups_project
  on research_followups (project_id, kind, sort_order, created_at);
