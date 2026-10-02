// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// journal-browse.ts — 期刊库的「学科 / 首字母 / 拼音」检索
//
// 支撑迁移 177 加的四列。这一层是**纯函数 + 一次回填**, 不引入拼音依赖。
//
// ═══ 为什么是内嵌 130 字表而不是引 pinyin 库 ═══
//   本仓 80 本期刊的刊名**去重后只有 130 个不同汉字**(实测), 而 npm 上的拼音库
//   动辄几 MB(带多音字词典)。为 130 个字拉一个库不划算, 且多音字在**刊名**这个
//   场景里几乎不会出问题(刊名是固定专名, 不是自由文本)。
//   代价是: 以后新增的刊若含表外的字, 该字会被跳过 —— 所以 `pinyinOf` 对表外的字
//   返回原文而不是静默丢弃, 让"缺字"在界面上看得见。

/** 130 个汉字的拼音(无声调)。按 cjournal_journals 的 80 个刊名去重提取。 */
const PY: Record<string, string> = {
  "一":"yi","与":"yu","世":"shi","丛":"cong","东":"dong","中":"zhong","主":"zhu","义":"yi","习":"xi","争":"zheng",
  "京":"jing","人":"ren","代":"dai","价":"jia","会":"hui","值":"zhi","光":"guang","克":"ke","党":"dang","共":"gong",
  "内":"nei","刊":"kan","动":"dong","北":"bei","区":"qu","南":"nan","古":"gu","史":"shi","吉":"ji","哲":"zhe",
  "国":"guo","坛":"tan","复":"fu","外":"wai","大":"da","天":"tian","学":"xue","实":"shi","家":"jia","导":"dao",
  "小":"xiao","山":"shan","岳":"yue","州":"zhou","师":"shi","平":"ping","广":"guang","建":"jian","开":"kai","当":"dang",
  "心":"xin","志":"zhi","态":"tai","思":"si","想":"xiang","战":"zhan","报":"bao","探":"tan","改":"gai","放":"fang",
  "政":"zheng","教":"jiao","文":"wen","旗":"qi","日":"ri","旦":"dan","时":"shi","明":"ming","是":"shi","月":"yue",
  "术":"shu","杂":"za","林":"lin","校":"xiao","核":"he","横":"heng","武":"wu","毛":"mao","民":"min","求":"qiu",
  "汉":"han","江":"jiang","河":"he","治":"zhi","泽":"ze","津":"jin","济":"ji","浙":"zhe","海":"hai","湖":"hu",
  "版":"ban","特":"te","献":"xian","现":"xian","理":"li","界":"jie","白":"bai","的":"de","研":"yan","社":"she",
  "福":"fu","科":"ke","稿":"gao","究":"jiu","管":"guan","索":"suo","红":"hong","纵":"zong","线":"xian","经":"jing",
  "统":"tong","育":"yu","色":"se","苏":"su","蒙":"meng","西":"xi","观":"guan","视":"shi","论":"lun","评":"ping",
  "财":"cai","辑":"ji","邓":"deng","野":"ye","长":"chang","问":"wen","革":"ge","题":"ti","马":"ma","鸣":"ming"
};

/** 刊名 → 全拼(无声调, 小写)。**表外的字原样保留** —— 缺字要看得见, 不能静默丢。 */
export function pinyinOf(name: string): string {
  const s = String(name || "");
  let out = "";
  for (const ch of s) {
    if (PY[ch]) out += PY[ch];
    // 括号/空格等非汉字直接跳过(不影响检索), 但**表外的汉字**保留原文
    else if (/[一-龥]/.test(ch)) out += ch;
    // 其余(ASCII 字母数字)小写保留
    else if (/[A-Za-z0-9]/.test(ch)) out += ch.toLowerCase();
  }
  return out;
}

/** 刊名 → 首字母缩写。只取汉字的首字母与 ASCII 字母, 跳过标点与括号。 */
export function abbrOf(name: string): string {
  const s = String(name || "");
  let out = "";
  for (const ch of s) {
    if (PY[ch]) out += PY[ch][0];
    else if (/[A-Za-z0-9]/.test(ch)) out += ch.toLowerCase();
    // 表外的汉字: 用原文占位(而不是跳过), 否则缩写长度会与刊名对不上
    else if (/[一-龥]/.test(ch)) out += ch;
  }
  return out.slice(0, 12);
}

/** 学科推导 —— 与迁移 177 的 SQL 规则**保持同一口径**。
 *
 *  为什么这里是 JS 而不是只留 SQL: SQL 那次是**一次性回填**, 而新建的刊(期刊同步
 *  管道会加)需要在插入时就带上 field。两处必须同规, 所以规则写在这里、SQL 引同样的
 *  关键词。改动任一处都要同步另一处 —— 这是本文件唯一需要人工维护的耦合。
 */
export function fieldOfTopicTags(tags: string[] | null | undefined): string {
  const t = (tags ?? []).join(" ");
  if (!t) return "综合";
  if (/经济|资本论|财经/.test(t)) return "经济学";
  if (/党建|党史|党的/.test(t)) return "党建";
  if (/马克思|社会主义|国外理论/.test(t)) return "马克思主义理论";
  if (/政治|治理|国际/.test(t)) return "政治学";
  if (/哲学|伦理|美学/.test(t)) return "哲学";
  if (/历史|史|考古/.test(t)) return "历史学";
  if (/社会|人口|民族/.test(t)) return "社会学";
  if (/教育|教学/.test(t)) return "教育学";
  if (/文学|语言|文化/.test(t)) return "文学";
  if (/法|法律/.test(t)) return "法学";
  return "综合";
}

/** 把 80 本刊缺的 pinyin/abbr/field 回填进库。
 *  条件更新: 只写空值, 不覆盖人工订正过的。可重复执行。 */
export async function backfillJournalBrowseFields(): Promise<{ updated: number }> {
  const { pool } = await import("../../db/pool.js");
  const r = await pool.query(
    `select id, name, field, pinyin, abbr, topic_tags from cjournal_journals
      where pinyin is null or abbr is null or field is null`
  );
  let updated = 0;
  for (const row of r.rows) {
    const py = row.pinyin ?? pinyinOf(row.name);
    const ab = row.abbr ?? abbrOf(row.name);
    const fd = row.field ?? fieldOfTopicTags(row.topic_tags);
    await pool.query(
      `update cjournal_journals set pinyin = $2, abbr = $3, field = $4 where id = $1`,
      [row.id, py, ab, fd]
    );
    updated++;
  }
  return { updated };
}

export const journalBrowse = { pinyinOf, abbrOf, fieldOfTopicTags, backfillJournalBrowseFields };
