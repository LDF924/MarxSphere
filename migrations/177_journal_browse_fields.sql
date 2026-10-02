-- 177_journal_browse_fields.sql — 期刊库补 field / language / pinyin / abbr
--
-- 由来(2026-10-02): 速度面板与期刊库要做「按学科 / 按首字母 / 按拼音」三种检索,
--   而 `cjournal_journals` 只有 `topic_tags`(选题标签) 与 `style`(自由文本)。
--   实测 80 本刊的现有字段: level(南核/北核/C扩) 是**级别**不是学科, 拿它当学科
--   筛出来的"南核"横跨党建/经济/哲学/历史, 对选刊没有帮助。
--
-- 与 Respal 的对照: 它的 Journal 形状是 `{name, field, language, pinyin, abbr}`,
--   `pinyin` 直接支撑界面上的「按首字母」「按拼音搜索」两个选择器。
--
-- ═══ 为什么 pinyin 是**入库回填**而不是查询时算 ═══
--   本仓没有拼音库依赖(实测 node_modules 无 pinyin/hanzi/pypinyin), 而全部刊名
--   **去重后只有 130 个不同汉字** —— 小到可以内嵌一张完整映射表。
--   回填成列还带来两个好处: 可按拼音建索引排序、前端不必再算一遍。
--
-- ═══ field 为什么用推导而不是逐刊标注 ═══
--   80 本刊逐个人工标学科会引入"谁说了算"的口径问题; 而 `topic_tags` 是**80/80
--   全有**的(实测), 且标签本身就是选题领域(「政治经济学」「党建理论」「国外马克思主义」)。
--   所以按关键词规则从标签推 field, 规则集中在一处、可复核、可重跑。
--   推不出来的留 '综合' —— 不硬塞。
--
-- 幂等: add column if not exists。回填是**条件回填**(只在 field 为空时写),
--   重复执行不会覆盖人工订正过的值。

alter table cjournal_journals add column if not exists field    text;
alter table cjournal_journals add column if not exists language text default 'zh';
alter table cjournal_journals add column if not exists pinyin   text;
alter table cjournal_journals add column if not exists abbr     text;

comment on column cjournal_journals.field is
  '学科领域(经济学/政治学/党建/哲学/马克思主义理论/综合…)。由 topic_tags 规则推导, 见 177 迁移; 人工订正过的不被重跑覆盖。';
comment on column cjournal_journals.pinyin is
  '刊名全拼(无声调, 小写)。支撑「按拼音搜索」与按音序排列。由 130 字表生成, 见 types/digest 的 PY 表。';
comment on column cjournal_journals.abbr is
  '刊名首字母缩写(如 中国社会科学 → zgshkx)。支撑「按首字母」选择器。';

-- ═══ 学科推导(条件回填, 不覆盖已有值) ═══
-- 顺序即优先级: 越具体的规则越靠前。用 like any 而不是逐条 case, 是为了让
-- "一个标签命中多条规则时取第一条"这件事一眼可读。
update cjournal_journals set field = case
  when exists (select 1 from unnest(coalesce(topic_tags,'{}')) t where t like '%经济%' or t like '%资本论%' or t like '%财经%') then '经济学'
  when exists (select 1 from unnest(coalesce(topic_tags,'{}')) t where t like '%党建%' or t like '%党史%' or t like '%党的%') then '党建'
  when exists (select 1 from unnest(coalesce(topic_tags,'{}')) t where t like '%马克思%' or t like '%社会主义%' or t like '%国外理论%') then '马克思主义理论'
  when exists (select 1 from unnest(coalesce(topic_tags,'{}')) t where t like '%政治%' or t like '%治理%' or t like '%国际%') then '政治学'
  when exists (select 1 from unnest(coalesce(topic_tags,'{}')) t where t like '%哲学%' or t like '%伦理%' or t like '%美学%') then '哲学'
  when exists (select 1 from unnest(coalesce(topic_tags,'{}')) t where t like '%历史%' or t like '%史%' or t like '%考古%') then '历史学'
  when exists (select 1 from unnest(coalesce(topic_tags,'{}')) t where t like '%社会%' or t like '%人口%' or t like '%民族%') then '社会学'
  when exists (select 1 from unnest(coalesce(topic_tags,'{}')) t where t like '%教育%' or t like '%教学%') then '教育学'
  when exists (select 1 from unnest(coalesce(topic_tags,'{}')) t where t like '%文学%' or t like '%语言%' or t like '%文化%') then '文学'
  when exists (select 1 from unnest(coalesce(topic_tags,'{}')) t where t like '%法%' or t like '%法律%') then '法学'
  else '综合'
end
where field is null;

-- 语言: 80 本全是中文刊(实测刊名全为汉字), 但**不假设**以后加的也是 —— 留列默认 'zh'
update cjournal_journals set language = 'zh' where language is null;

create index if not exists idx_cjournal_journals_field on cjournal_journals (field);
create index if not exists idx_cjournal_journals_pinyin on cjournal_journals (pinyin);
