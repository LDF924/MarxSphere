-- 068_writing_corpus.sql — 学术写作语料库（2026-08-16）
-- 四大子库: 文本范例 / 核心概念 / 论证逻辑 / 词汇句式
-- 设计原则: 语料是可复用学术资产（借鉴逻辑与句式, 不照搬原文）
-- 积累→整理→应用 三层工作流的数据底座

-- ① 文本范例库: 高质量段落（中英文）, 标记适用写作模块
CREATE TABLE IF NOT EXISTS writing_corpus_texts (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  language text NOT NULL DEFAULT 'zh',           -- zh / en
  text text NOT NULL,                            -- 段落全文（范例）
  source text,                                   -- 出处（论文/专著/作者+年份）
  writing_module text NOT NULL DEFAULT '引言',    -- 适用写作模块: 引言/综述/实证分析/结论/讨论/方法/摘要
  tags text[] NOT NULL DEFAULT '{}',             -- 标签（主题/风格）
  note text,                                     -- 使用说明（借鉴点/可替换处）
  created_by text NOT NULL DEFAULT 'manual',     -- 来源: manual(手动) / agent(自动沉淀) / pdf(管道提取)
  source_task_id uuid,                           -- agent 沉淀时的任务 id
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wct_module ON writing_corpus_texts (writing_module, language);
CREATE INDEX IF NOT EXISTS idx_wct_tags ON writing_corpus_texts USING gin (tags);

-- ② 核心概念库: 领域关键理论/模型（定义/提出者/演进/边界）
CREATE TABLE IF NOT EXISTS writing_corpus_concepts (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name text NOT NULL UNIQUE,                     -- 概念名
  definition text NOT NULL,                      -- 定义（准确表述）
  proposer text,                                 -- 提出学者/学派
  year text,                                     -- 提出年份（文本, 允许"1950s"）
  evolution jsonb NOT NULL DEFAULT '[]'::jsonb,  -- 理论演进: [{year, scholar, contribution}]
  boundary text,                                 -- 适用边界/局限
  related text[] NOT NULL DEFAULT '{}',          -- 关联概念
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wcc_name ON writing_corpus_concepts (name);
CREATE INDEX IF NOT EXISTS idx_wcc_tags ON writing_corpus_concepts USING gin (tags);

-- ③ 论证逻辑库: 论证范式（结构可复用）
CREATE TABLE IF NOT EXISTS writing_corpus_logics (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name text NOT NULL,                            -- 范式名（如"现象→理论抽象"）
  pattern_type text NOT NULL DEFAULT 'general',  -- 现象抽象/多案例对比/辩证结构/实证递进/归纳-演绎
  structure jsonb NOT NULL DEFAULT '[]'::jsonb,  -- 步骤: [{step, desc}]
  example text,                                  -- 典型示例（简短）
  usage_hint text,                               -- 何时使用/解决什么问题
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wcl_type ON writing_corpus_logics (pattern_type);

-- ④ 词汇句式库: 按语义分组的高级表达（替代基础词）
CREATE TABLE IF NOT EXISTS writing_corpus_expressions (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  semantic_group text NOT NULL,                  -- 因果/对比/研究缺口/总结发现/让步/强调/示例/过渡
  expression text NOT NULL,                      -- 高级表达（中/英）
  zh_meaning text,                               -- 中文释义/使用场景
  en_example text,                               -- 英文例句
  replace_for text,                              -- 替代的基础词/表达（如 show → demonstrate）
  language text NOT NULL DEFAULT 'en',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wce_group ON writing_corpus_expressions (semantic_group);

-- ═══ 种子数据: 每库预置经典示例（立即可用, 后续用户扩充）═══

-- 核心概念库种子（马理论+社会科学经典）
INSERT INTO writing_corpus_concepts (name, definition, proposer, year, evolution, boundary, related) VALUES
('剩余价值', '商品价值中由雇佣工人剩余劳动创造、被资本家无偿占有的部分, 体现资本对劳动的剥削关系。', '马克思', '1867', '[{"year":1867,"scholar":"马克思","contribution":"《资本论》第一卷系统阐述剩余价值生产(绝对/相对剩余价值)"},{"year":1894,"scholar":"恩格斯","contribution":"《资本论》第三卷整理平均利润率与剩余价值分配"}]', '适用于资本主义生产方式分析; 对非雇佣劳动形态(个体经营)适用性需限定。', ARRAY['资本积累','利润率','剥削率']),
('制度变迁', '制度在外部冲击或内部压力下发生调整、演进的过程, 分为强制性变迁与诱致性变迁。', '诺斯', '1990', '[{"year":1971,"scholar":"戴维斯/诺斯","contribution":"提出制度变迁理论框架"},{"year":1990,"scholar":"诺斯","contribution":"《制度、制度变迁与经济绩效》系统化"}]', '解释长期制度演化有效; 对短期制度移植分析需结合政治经济学视角。', ARRAY['路径依赖','交易成本','制度均衡']),
('路径依赖', '历史事件对制度与技术的锁定效应, 早期选择会持续影响后续发展轨迹。', '大卫/阿瑟', '1985', '[{"year":1985,"scholar":"大卫","contribution":"QWERTY键盘案例分析"},{"year":1988,"scholar":"阿瑟","contribution":"技术选择正反馈模型"}]', '适用于技术选择与制度演化; 对完全理性行为者模型解释力下降。', ARRAY['制度变迁','锁定效应','报酬递增']),
('双重效应', '同一经济社会过程同时产生正面效应与负面效应, 需辩证把握其内在张力。', '马克思', '1867', '[{"year":1867,"scholar":"马克思","contribution":"资本积累的一般规律揭示财富积累与贫困积累并存"}]', '用于辩证分析范式; 须以实证证据区分主导效应。', ARRAY['辩证分析','资本积累','利益分配']),
('国家能力', '国家将其政策意图转化为实际结果的能力, 包括汲取、渗透、再分配与规制能力。', '斯考切波/王绍光', '1985', '[{"year":1985,"scholar":"斯考切波","contribution":"把国家带回分析中心"},{"year":1993,"scholar":"王绍光/胡鞍钢","contribution":"国家能力四维分类(汲取/渗透/再分配/规制)"}]', '适用于国家-社会关系分析; 对市场自发秩序主导领域适用性有限。', ARRAY['国家-社会关系','汲取能力','规制能力'])
ON CONFLICT (name) DO NOTHING;

-- 论证逻辑库种子
INSERT INTO writing_corpus_logics (name, pattern_type, structure, example, usage_hint) VALUES
('现象→理论抽象', '现象抽象', '[{"step":1,"desc":"呈现具体现象/案例事实(数据或事件)"},{"step":2,"desc":"指出该现象不能被既有理论充分解释(研究缺口)"},{"step":3,"desc":"提炼现象的抽象特征, 与理论概念对接"},{"step":4,"desc":"提出理论命题(现象上升为一般规律)"}]', '塘约村集体收入增长3.2倍 → 既有"资本下乡"研究多聚焦负面效应 → 抽象出"要素重组激活集体资产"机制 → 命题: 资本与集体经济的兼容条件。', '解决"就事论事、缺乏理论升华"的问题; 引言与结论常用。'),
('多案例对比', '多案例对比', '[{"step":1,"desc":"选择可比较案例(控制变量: 同地域/同时期)"},{"step":2,"desc":"逐一呈现各案例核心事实与关键变量"},{"step":3,"desc":"对比异同, 识别决定结果差异的关键因素"},{"step":4,"desc":"归纳条件性结论(何种条件下何种效应)"}]', '贵州塘约村(集体合作社)与山东代村(土地股份合作)对比: 制度安排差异→农户参与度差异→收入分配差异。', '解决"单案例说服力弱"问题; 实证章节常用。'),
('论点-论据-反驳-再论证', '辩证结构', '[{"step":1,"desc":"提出核心论点(明确立场)"},{"step":2,"desc":"正面论据支持(证据+引用)"},{"step":3,"desc":"预设反驳: 提出可能质疑或反例"},{"step":4,"desc":"回应反驳并强化论证(限定条件/补充证据/修正表述)"}]', '论点: 资本下乡总体利大于弊 → 论据: 要素激活证据 → 反驳: 利益挤占风险 → 再论证: 在"规制到位"条件下利大于弊。', '解决"论证单薄、说服力弱"问题; 讨论章节常用。'),
('实证递进', '实证递进', '[{"step":1,"desc":"基准回归(核心变量初步检验)"},{"step":2,"desc":"控制变量/固定效应(排除混淆)"},{"step":3,"desc":"稳健性检验(替换指标/子样本/工具变量)"},{"step":4,"desc":"机制检验(中介/异质性, 揭示内在机理)"}]', '基准OLS → 加入控制变量与省份固定效应 → 工具变量法处理内生性 → 分组异质性检验。', '解决"实证结果单薄"问题; 实证分析章节标准结构。'),
('归纳-演绎结合', '归纳-演绎', '[{"step":1,"desc":"归纳: 从文献与经验材料中提炼一般性观察"},{"step":2,"desc":"演绎: 从理论假设推导可检验命题"},{"step":3,"desc":"实证: 命题与观察互相印证/修正"},{"step":4,"desc":"结论: 一般性规律及其边界条件"}]', '从多篇案例研究归纳"集体经营效率受制度设计影响" → 演绎推导"产权明晰度与效率正相关" → 实证检验。', '解决"理论脱离材料"或"材料缺乏理论"的两极问题; 综述与结论常用。')
ON CONFLICT DO NOTHING;

-- 词汇句式库种子（四组核心语义）
INSERT INTO writing_corpus_expressions (semantic_group, expression, zh_meaning, en_example, replace_for) VALUES
('因果', 'This study attributes the observed variation to ...', '本研究将观察到的差异归因于...', 'This study attributes the observed variation in land transfer outcomes to institutional arrangements.', 'because of'),
('因果', 'The results are consistent with the interpretation that ...', '结果与以下解释一致: ...', 'The results are consistent with the interpretation that capital inflow activates idle collective assets.', 'shows that'),
('因果', 'A growing body of evidence suggests that ...', '越来越多的证据表明...', 'A growing body of evidence suggests that collective economy resilience hinges on governance quality.', 'many studies show'),
('对比', 'In contrast to earlier findings, ...', '与早期研究结论不同, ...', 'In contrast to earlier findings, our results indicate a more nuanced relationship.', 'unlike'),
('对比', 'Whereas conventional wisdom emphasizes ..., this paper highlights ...', '传统观点强调..., 本文则突出...', 'Whereas conventional wisdom emphasizes extraction, this paper highlights the activation dimension.', 'but'),
('对比', 'The distinction between A and B is critical, as ...', '区分A与B至关重要, 因为...', 'The distinction between land transfer and land-use rights transfer is critical, as their legal consequences differ.', 'A is different from B'),
('研究缺口', 'Despite the extensive literature on ..., little attention has been paid to ...', '尽管...研究丰富, 但较少关注...', 'Despite the extensive literature on capital inflow, little attention has been paid to its institutional boundary conditions.', 'few studies'),
('研究缺口', 'This gap is particularly salient given ...', '考虑到..., 这一缺口尤为突出', 'This gap is particularly salient given the recent legal reforms of collective economic organizations.', 'missing'),
('研究缺口', 'The existing scholarship has largely overlooked ...', '既有研究很大程度上忽视了...', 'The existing scholarship has largely overlooked the interaction between capital and collective governance.', 'did not study'),
('总结发现', 'Taken together, these findings suggest that ...', '综合来看, 这些发现表明...', 'Taken together, these findings suggest that dual-track institutional design outperforms single-track approaches.', 'so'),
('总结发现', 'This paper contributes to the literature by ...', '本文对文献的贡献在于...', 'This paper contributes to the literature by integrating legal-institutional and economic perspectives.', 'we did'),
('总结发现', 'The evidence points to a more complex picture than ...', '证据指向比...更复杂的图景', 'The evidence points to a more complex picture than the dichotomous framing in prior work.', 'it is complicated'),
('让步', 'While ... may be true, it does not necessarily imply ...', '尽管...可能成立, 但这并不必然意味着...', 'While rent-seeking may occur, it does not necessarily imply that all capital inflow is extractive.', 'but'),
('强调', 'It is worth emphasizing that ...', '值得强调的是...', 'It is worth emphasizing that institutional constraints, not factor scarcity, drive the observed disparities.', 'important'),
('过渡', 'Building on this foundation, ...', '在此基础之上, ...', 'Building on this foundation, we examine the micro-mechanisms of collective asset activation.', 'next')
ON CONFLICT DO NOTHING;
