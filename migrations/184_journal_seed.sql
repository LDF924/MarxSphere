-- 184_journal_seed.sql — 期刊画像种子(80 本马理论/社科期刊)
--
-- ⚠ **为什么需要这个迁移**(2026-10-04 查清):
--   这 80 本(南核 67 / C扩 9 / 北核 4)原先**只存在于本机 PostgreSQL 里** ——
--   代码、迁移、种子脚本里一条都没有(全历史搜刊名 = 空; 176 只建表不插数据)。
--   后果不是"某处少了几条", 而是**任何新环境都是空库**: CI、同事、换机器、
--   `docker compose down -v` 之后都起不来。而它藏了三天才被发现, 因为
--   10-03 之前的探针没有一条真读这张表 —— 直到 probe-writing-cabin-v425b 断言
--   "投稿前检查页要出现 南核/北核/C扩 级别标签" 才开始红。
--   (同一个模式的第二次: 前一次是文献库, 见项目记忆里的 'CI 起了 PG 却从不迁移'。)
--
-- 幂等: `on conflict (id) do update` —— 重复跑不产生第二份。
--
-- 字段口径: id = 拼音首字母(与 177 迁移回填的 abbr 同口径, 供前端按首字母检索);
--   level ∈ 南核 / 北核 / C扩 / 其他; topic_tags 用于热点匹配; pinyin 供拼音检索。
-- 数据来源: 2026-09-18 的库备份(backups/sagbak_20260918174019.sagbak), 即那 80 本的唯一副本。

insert into cjournal_journals
  (id, name, level, org, topic_tags, style, official_site, field, language, pinyin, abbr)
values
  ('sjshzyyj', '世界社会主义研究', '南核', '中国社会科学院马克思主义研究院', array['世界社会主义', '国际共运']::text[], '世界社会主义', null, '马克思主义理论', 'zh', 'shijieshehuizhuyiyanjiu', 'sjshzyyj'),
  ('dnxs', '东南学术', '南核', '福建省社会科学界联合会', array['学理化', '理论纵深']::text[], '学理化、理论纵深', 'http://www.dnxs.net.cn/', '综合', 'zh', 'dongnanxueshu', 'dnxs'),
  ('dyxc', '东岳论丛', '南核', '山东社会科学院', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'dongyueluncong', 'dylc'),
  ('zgdsyj', '中共党史研究', '南核', '中共中央党史和文献研究院', array['中共党史', '领袖研究']::text[], '党史研究', null, '党建', 'zh', 'zhonggongdangshiyanjiu', 'zgdsyj'),
  ('zgtshzy', '中国特色社会主义研究', '南核', '北京市社会科学院', array['中国特色社会主义', '理论创新']::text[], '中国化时代化、理论创新', 'http://www.zgtshzyy.com/', '马克思主义理论', 'zh', 'zhongguoteseshehuizhuyiyanjiu', 'zgtsshzyyj'),
  ('zgshkx', '中国社会科学', '南核', '中国社会科学院', array['哲学社会科学综合', '马克思主义']::text[], '顶级综合社科', 'http://www.cssn.cn/', '马克思主义理论', 'zh', 'zhongguoshehuikexue', 'zgshkx'),
  ('zhongshan-xb', '中山大学学报(社科版)', '南核', '中山大学', array['哲学社会科学', '马克思主义']::text[], '高校学报', null, '马克思主义理论', 'zh', 'zhongshandaxuexuebaoshekeban', 'zsdxxbskb'),
  ('zzxk', '中州学刊', '南核', '河南省社会科学院', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'zhongzhouxuekan', 'zzxk'),
  ('rwzz', '人文杂志', '南核', '陕西省社会科学院', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'renwenzazhi', 'rwzz'),
  ('rmrb-ll', '人民日报·理论版', '南核', '人民日报社', array['理论文章', '政策解读']::text[], '理论阵地(报纸)', null, '综合', 'zh', 'renminribaolilunban', 'rmrbllb'),
  ('gmrb-ll', '光明日报·理论版', '南核', '光明日报社', array['理论文章', '学术前沿']::text[], '理论阵地(报纸)', null, '综合', 'zh', 'guangmingribaolilunban', 'gmrbllb'),
  ('dsyjjx', '党史研究与教学', '南核', '中共福建省委党校', array['党史研究', '教学']::text[], '党史研究', null, '党建', 'zh', 'dangshiyanjiuyujiaoxue', 'dsyjyjx'),
  ('dangjian', '党建', '南核', '中共中央宣传部《党建》杂志社', array['党建理论', '党的建设']::text[], '党建理论宣传', null, '党建', 'zh', 'dangjian', 'dj'),
  ('ddwx', '党的文献', '南核', '中央党史和文献研究院', array['党的文献', '领袖思想']::text[], '文献研究、领袖思想', null, '党建', 'zh', 'dangdewenxian', 'ddwx'),
  ('neimenggu-shkx', '内蒙古社会科学', '南核', '内蒙古社会科学院', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'neimenggushehuikexue', 'nmgshkx'),
  ('beijing-dx', '北京大学学报(哲社版)', '南核', '北京大学', array['哲学社会科学', '马克思主义']::text[], '高校学报', null, '马克思主义理论', 'zh', 'beijingdaxuexuebaozhesheban', 'bjdxxbzsb'),
  ('nankai-xb', '南开学报(哲社版)', '南核', '南开大学', array['哲学社会科学', '马克思主义']::text[], '高校学报', null, '马克思主义理论', 'zh', 'nankaixuebaozhesheban', 'nkxbzsb'),
  ('jilin-daxue', '吉林大学社会科学学报', '南核', '吉林大学', array['哲学社会科学', '马克思主义']::text[], '高校学报', null, '马克思主义理论', 'zh', 'jilindaxueshehuikexuexuebao', 'jldxshkxxb'),
  ('gwlldt', '国外理论动态', '南核', '中央党史和文献研究院', array['国外马克思主义', '理论动态']::text[], '国外理论跟踪', null, '马克思主义理论', 'zh', 'guowaililundongtai', 'gwlldt'),
  ('fudan-xb', '复旦学报(社科版)', '南核', '复旦大学', array['哲学社会科学', '马克思主义']::text[], '高校学报', null, '马克思主义理论', 'zh', 'fudanxuebaoshekeban', 'fdxbskb'),
  ('tjshkx', '天津社会科学', '南核', '天津社会科学院', array['哲学社会科学', '理论前沿']::text[], '理论前沿、综合社科', 'http://www.tjshkx.com/', '哲学', 'zh', 'tianjinshehuikexue', 'tjshkx'),
  ('xxyts', '学习与探索', '南核', '黑龙江省社会科学院', array['哲学社会科学', '理论创新']::text[], '理论创新、综合社科', 'http://www.xxyts.cn/', '哲学', 'zh', 'xuexiyutansuo', 'xxyts'),
  ('xsyk', '学术月刊', '南核', '上海市社会科学界联合会', array['哲学社会科学', '理论创新']::text[], '理论创新、综合社科', 'http://www.xsyk021.com/', '哲学', 'zh', 'xueshuyuekan', 'xsyk'),
  ('xuejie', '学术界', '南核', '安徽省社会科学界联合会', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'xueshujie', 'xsj'),
  ('xsyj', '学术研究', '南核', '广东省社会科学界联合会', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'xueshuyanjiu', 'xsyj'),
  ('sdshkx', '山东社会科学', '南核', '山东省社会科学界联合会', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'shandongshehuikexue', 'sdshkx'),
  ('gdshkx', '广东社会科学', '南核', '广东省社会科学院', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'guangdongshehuikexue', 'gdshkx'),
  ('guangxi-shkx', '广西社会科学', '南核', '广西社会科学界联合会', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'guangxishehuikexue', 'gxshkx'),
  ('ddshjy', '当代世界与社会主义', '南核', '中央党史和文献研究院', array['世界社会主义', '国际共运']::text[], '国际共运研究', null, '马克思主义理论', 'zh', 'dangdaishijieyushehuizhuyi', 'ddsjyshzy'),
  ('ddshzywt', '当代世界社会主义问题', '南核', '山东大学', array['当代世界社会主义', '科学社会主义']::text[], '世界社会主义研究', null, '马克思主义理论', 'zh', 'dangdaishijieshehuizhuyiwenti', 'ddsjshzywt'),
  ('ddjjj', '当代经济研究', '南核', '吉林财经大学/中国《资本论》研究会', array['《资本论》', '政治经济学', '习近平经济思想']::text[], '资本论研究、政经', 'http://www.ddjjyj.com/', '经济学', 'zh', 'dangdaijingjiyanjiu', 'ddjjyj'),
  ('sxjyj', '思想教育研究', '南核', '中国高等教育学会', array['思想政治教育', '马克思主义理论']::text[], '思政教育', null, '马克思主义理论', 'zh', 'sixiangjiaoyuyanjiu', 'sxjyyj'),
  ('sxlly', '思想理论教育', '南核', '上海市教育科学研究院', array['思政教育', '马克思主义理论']::text[], '思政教育', null, '马克思主义理论', 'zh', 'sixianglilunjiaoyu', 'sxlljy'),
  ('sxllyd', '思想理论教育导刊', '南核', '高等教育出版社', array['思政教育', '马克思主义理论']::text[], '思政教育、理论导刊', 'http://www.sxllyd.com/', '马克思主义理论', 'zh', 'sixianglilunjiaoyudaokan', 'sxlljydk'),
  ('tsyzm', '探索与争鸣', '南核', '上海市社会科学界联合会', array['学术争鸣', '理论前沿']::text[], '争鸣、前沿', 'http://www.tsyzm.com/', '综合', 'zh', 'tansuoyuzhengming', 'tsyzm'),
  ('gaige', '改革', '南核', '重庆社会科学院', array['经济改革', '制度变迁']::text[], '改革研究', 'http://www.reform.net.cn/', '经济学', 'zh', 'gaige', 'gg'),
  ('zhengzhi-yan', '政治学研究', '南核', '中国社会科学院政治学研究所', array['政治学理论', '治理']::text[], '政治学理论', null, '政治学', 'zh', 'zhengzhixueyanjiu', 'zzxyj'),
  ('zzjjxpl', '政治经济学评论', '南核', '中国人民大学', array['政治经济学', '中国特色社会主义政治经济学']::text[], '政治经济学理论创新', 'http://crpe.ruc.edu.cn/', '经济学', 'zh', 'zhengzhijingjixuepinglun', 'zzjjxpl'),
  ('jxyyj', '教学与研究', '南核', '中国人民大学', array['马克思主义理论', '思政教育', '政治经济学']::text[], '思政理论、教学研究', 'https://jxyj.ruc.edu.cn/', '经济学', 'zh', 'jiaoxueyuyanjiu', 'jxyyj'),
  ('mzd-dxp', '毛泽东邓小平理论研究', '南核', '上海社会科学院', array['马克思主义中国化', '领袖思想']::text[], '中国化时代化', null, '马克思主义理论', 'zh', 'maozedongdengxiaopinglilunyanjiu', 'mzddxpllyj'),
  ('qiushi-xuekan', '求实', '南核', '中共江西省委党校', array['马克思主义中国化', '党建']::text[], '党校理论', null, '党建', 'zh', 'qiushi', 'qs'),
  ('qiushi', '求是', '南核', '中国共产党中央委员会', array['党的理论', '路线方针政策']::text[], '党的理论阵地', 'http://www.qstheory.cn/', '党建', 'zh', 'qiushi', 'qs'),
  ('jhxk', '江海学刊', '南核', '江苏省社会科学院', array['哲学社会科学', '理论纵深']::text[], '理论纵深、综合社科', 'http://www.jhxk.cn/', '哲学', 'zh', 'jianghaixuekan', 'jhxk'),
  ('jsshkx', '江苏社会科学', '南核', '江苏省哲学社会科学界联合会', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'jiangsushehuikexue', 'jsshkx'),
  ('hbxk', '河北学刊', '南核', '河北省社会科学院', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'hebeixuekan', 'hbxk'),
  ('henan-shkx', '河南社会科学', '南核', '河南省社会科学界联合会', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'henanshehuikexue', 'hnshkx'),
  ('zhejiang-xk', '浙江学刊', '南核', '浙江省社会科学院', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'zhejiangxuekan', 'zjxk'),
  ('hubei-xk', '湖北社会科学', '南核', '湖北省社会科学界联合会', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'hubeishehuikexue', 'hbshkx'),
  ('llsy', '理论视野', '南核', '中共中央党校', array['马克思主义理论', '党建']::text[], '党校理论', 'http://www.lilunshiy.com/', '党建', 'zh', 'lilunshiye', 'llsy'),
  ('shzyyj', '社会主义研究', '南核', '华中师范大学', array['社会主义理论', '中国特色社会主义']::text[], '社会主义理论', null, '马克思主义理论', 'zh', 'shehuizhuyiyanjiu', 'shzyyj'),
  ('shkx', '社会科学', '南核', '上海社会科学院', array['哲学社会科学综合', '马克思主义']::text[], '综合社科、理论前沿', 'http://www.shehuikexue.org/', '马克思主义理论', 'zh', 'shehuikexue', 'shkx'),
  ('shkxzx', '社会科学战线', '南核', '吉林省社会科学院', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'shehuikexuezhanxian', 'shkxzx'),
  ('shkxjk', '社会科学辑刊', '南核', '辽宁省社会科学院', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'shehuikexuejikan', 'shkxjk'),
  ('fjlt', '福建论坛(人文社科版)', '南核', '福建省社会科学院', array['哲学社会科学综合']::text[], '综合社科', null, '哲学', 'zh', 'fujianluntanrenwenshekeban', 'fjltrwskb'),
  ('kxshzy', '科学社会主义', '南核', '中国科学社会主义学会', array['科学社会主义', '中国特色社会主义']::text[], '科学社会主义理论', 'http://www.kxshtzy.com/', '马克思主义理论', 'zh', 'kexueshehuizhuyi', 'kxshzy'),
  ('hqwg', '红旗文稿', '南核', '求是杂志社', array['理论宣传', '政策解读']::text[], '理论宣传、政策', 'http://www.qstheory.cn/hqwg/', '综合', 'zh', 'hongqiwengao', 'hqwg'),
  ('jjxdt', '经济学动态', '南核', '中国社会科学院经济研究所', array['经济学动态', '理论前沿']::text[], '经济理论动态', 'http://www.jjxdt.org/', '经济学', 'zh', 'jingjixuedongtai', 'jjxdt'),
  ('jjxj', '经济学家', '南核', '西南财经大学', array['政治经济学', '经济理论', '改革']::text[], '经济理论、改革', null, '经济学', 'zh', 'jingjixuejia', 'jjxj'),
  ('jjllygl', '经济理论与经济管理', '南核', '中国人民大学', array['经济理论', '经济管理']::text[], '经济理论、管理', 'http://www.jjllygl.com/', '经济学', 'zh', 'jingjililunyujingjiguanli', 'jjllyjjgl'),
  ('jjyj', '经济研究', '南核', '中国社会科学院经济研究所', array['经济学综合', '理论前沿']::text[], '经济理论顶刊', 'http://www.erj.cn/', '经济学', 'zh', 'jingjiyanjiu', 'jjyj'),
  ('jjzongheng', '经济纵横', '南核', '吉林省社会科学院', array['经济热点', '政策经济', '生产力']::text[], '经济热点、政策经济', null, '经济学', 'zh', 'jingjizongheng', 'jjzh'),
  ('xibei-shkx', '西北师大学报(社科版)', '南核', '西北师范大学', array['哲学社会科学', '马克思主义']::text[], '高校学报', null, '马克思主义理论', 'zh', 'xibeishidaxuebaoshekeban', 'xbsdxbskb'),
  ('xinan-daxue', '西南大学学报(社科版)', '南核', '西南大学', array['哲学社会科学', '马克思主义']::text[], '高校学报', null, '马克思主义理论', 'zh', 'xinandaxuexuebaoshekeban', 'xndxxbskb'),
  ('cjwt', '财经问题研究', '南核', '东北财经大学', array['财经理论', '经济问题']::text[], '财经理论', 'http://www.cjwt.net/', '经济学', 'zh', 'caijingwentiyanjiu', 'cjwtyj'),
  ('mkszyyxsh', '马克思主义与现实', '南核', '中央党史和文献研究院', array['马克思主义经典', '当代现实']::text[], '经典与现实结合', 'http://www.mkszyyxsh.com/', '马克思主义理论', 'zh', 'makesizhuyiyuxianshi', 'mkszyyxs'),
  ('mkszyllxk', '马克思主义理论学科研究', '南核', '高等教育出版社', array['马克思主义理论学科建设']::text[], '学科建设研究', null, '马克思主义理论', 'zh', 'makesizhuyililunxuekeyanjiu', 'mkszyllxkyj'),
  ('mkszyyj', '马克思主义研究', '南核', '中国社会科学院马克思主义研究院', array['马克思主义中国化', '经典理论时代化']::text[], '经典理论时代化、理论创新', 'http://www.mkszyyj.com/', '马克思主义理论', 'zh', 'makesizhuyiyanjiu', 'mkszyyj'),
  ('dangzheng-yj', '党政研究', '北核', '中共四川省委党校', array['党建', '马克思主义理论']::text[], '党校理论', null, '党建', 'zh', 'dangzhengyanjiu', 'dzyj'),
  ('lilun-xuekan', '理论学刊', '北核', '中共山东省委党校', array['马克思主义中国化', '党建']::text[], '党校理论', null, '党建', 'zh', 'lilunxuekan', 'llxk'),
  ('lilun-dk', '理论导刊', '北核', '中共陕西省委党校', array['马克思主义理论', '党建']::text[], '党校理论', null, '党建', 'zh', 'lilundaokan', 'lldk'),
  ('changbai-xk', '长白学刊', '北核', '中共吉林省委党校', array['马克思主义理论', '党建']::text[], '党校理论', null, '党建', 'zh', 'changbaixuekan', 'cbxk'),
  ('djyj', '党建研究', 'C扩', '中共中央组织部党建研究所', array['党建理论', '组织建设']::text[], '党建研究', null, '党建', 'zh', 'dangjianyanjiu', 'djyj'),
  ('xxdjysx', '学校党建与思想教育', 'C扩', '湖北教育报刊社', array['学校党建', '思政教育']::text[], '校园思政', null, '党建', 'zh', 'xuexiaodangjianyusixiangjiaoyu', 'xxdjysxjy'),
  ('kaifang-shidai', '开放时代', 'C扩', '广州市社会科学院', array['马克思主义', '社会理论', '当代问题']::text[], '理论纵深、当代问题', null, '马克思主义理论', 'zh', 'kaifangshidai', 'kfsd'),
  ('sxlzx', '思想理论战线', 'C扩', '国防大学', array['马克思主义理论', '思政']::text[], '军事院校理论', null, '马克思主义理论', 'zh', 'sixianglilunzhanxian', 'sxllzx'),
  ('wuhan-daxue', '武汉大学学报(哲社版)', 'C扩', '武汉大学', array['哲学社会科学', '马克思主义']::text[], '高校学报', null, '马克思主义理论', 'zh', 'wuhandaxuexuebaozhesheban', 'whdxxbzsb'),
  ('xiandai-zhexue', '现代哲学', 'C扩', '中山大学', array['马克思主义哲学', '哲学理论']::text[], '哲学理论', null, '马克思主义理论', 'zh', 'xiandaizhexue', 'xdzx'),
  ('shzyhxjz', '社会主义核心价值观研究', 'C扩', '清华大学', array['核心价值观', '德育']::text[], '价值观研究', null, '综合', 'zh', 'shehuizhuyihexinjiazhiguanyanjiu', 'shzyhxjzgyj'),
  ('tyzxxyj', '统一战线学研究', 'C扩', '重庆社会主义学院', array['统一战线', '政协']::text[], '统战研究', null, '综合', 'zh', 'tongyizhanxianxueyanjiu', 'tyzxxyj'),
  ('sqyj', '苏区研究', 'C扩', '江西省社会科学界联合会', array['苏区历史', '革命根据地']::text[], '革命史研究', null, '历史学', 'zh', 'suquyanjiu', 'sqyj')

on conflict (id) do update set
  name          = excluded.name,
  level         = excluded.level,
  org           = excluded.org,
  topic_tags    = excluded.topic_tags,
  style         = excluded.style,
  -- 官网列种子里有 24 条为空 —— 别用 null 把抓取管道后来补上的值覆盖掉
  official_site = coalesce(excluded.official_site, cjournal_journals.official_site),
  field         = excluded.field,
  language      = excluded.language,
  pinyin        = excluded.pinyin,
  abbr          = excluded.abbr;
