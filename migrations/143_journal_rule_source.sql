-- 143_journal_rule_source.sql — 规则来源标注 + AI 原文留存(供一键回退重解析)
--
-- 由来(2026-09-12 用户反馈"审稿库还能做哪些加法"): 期刊规则混着两种来源 —— AI 从投稿须知
-- 抽的, 和人手工填/改的 —— 但界面上分不出来。后果是: AI 抽歪了一条, 用户改过之后没法
-- "退回重抽"(不知道哪些是 AI 的、也不知道当初喂进去的原文是什么)。
--
-- 字段语义:
--   rule_source       'ai' = 整批由 AI 解析入库且未再编辑; 'manual' = 用户新建或编辑过
--   ai_source_text    AI 解析时**实际喂进去的原文**(与 submission_guide_text 分开:
--                     后者是用户可编辑的展示字段, 用户改了它不该影响"回退重抽"的结果)
--   ai_parsed_at      上次 AI 解析时刻(前端据此提示"规则已过期, 可重抽")
--
-- 幂等: 重复执行安全; 已有行按"有规则但无来源"记为 manual(保守: 不谎称是 AI 产出)

alter table review_journals add column if not exists rule_source text;
alter table review_journals add column if not exists ai_source_text text not null default '';
alter table review_journals add column if not exists ai_parsed_at timestamptz;

-- 回填历史行: 已经有规则的旧数据无法判断来源, 保守记为 manual(不确定时不冒充 AI 产出)
update review_journals
   set rule_source = 'manual'
 where rule_source is null
   and parsed_rules is not null
   and parsed_rules::text not in ('{}', 'null', '');

comment on column review_journals.rule_source is '规则来源: ai=AI 解析且未编辑, manual=用户新建或编辑过';
comment on column review_journals.ai_source_text is 'AI 解析时喂入的投稿须知原文(供一键回退重解析)';
comment on column review_journals.ai_parsed_at is '上次 AI 解析时刻';
