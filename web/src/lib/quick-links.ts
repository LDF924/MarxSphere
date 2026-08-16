// quick-links.ts — 实时建联：前端正则从文本抽取三元组（零 LLM）
// 可配置关系类型：中文名 + 正则句式（英文/中文均可），用户可在面板自定义
// 用法：extractQuickLinks(text, relationTypes) → Array<{ subject, relation, object, relationLabel }>

/** 关系类型：label 中文名 + patterns 正则句式列表（组1=主语，组2=宾语） */
export interface RelationType {
  id: string;
  label: string;
  patterns: string[];
}

export interface QuickLinkTriple {
  subject: string;
  /** 关系类型 id */
  relation: string;
  /** 关系类型中文名 */
  relationLabel: string;
  object: string;
}

// 主语/宾语候选（英文）：大写开头词簇 + 可选小写连续词，结尾前瞻防吞句尾
const EN_ENTITY = String.raw`[A-Z][A-Za-z0-9&'-]*(?:\s+(?:[A-Z][A-Za-z0-9&'-]*|[a-z]{1,2}(?=\s[A-Z])))*(?![a-z])`;
// 主语候选（中文）：动词前 ≤5 汉字 + 机构后缀；须以句首/标点后/空白后开始（防从词中间匹配）
const CN_SUBJECT = String.raw`(?<=^|[，。；：、\s])[一-龥]{2,5}(?:公司|集团|合作社|企业|研究院|大学|学院|中心|银行|基金|协会|部|委|办|局|村|镇|县|市|省)?`;
// 宾语候选（中文）：动词后 ≤6 汉字 + 机构后缀；负向前瞻：后不能紧跟介词/虚词（防吞「土地给丁村」中的「给丁村」）
const CN_OBJECT = String.raw`[一-龥]{2,6}(?:公司|集团|合作社|企业|研究院|大学|学院|中心|银行|基金|协会|部|委|办|局|村|镇|县|市|省)?(?!给|于|在|向|把|将|为|的|和|与|并|而|这|那|其)`;

/** 默认关系类型（贴合哲社科/马理论语境，英文+中文句式） */
export const DEFAULT_RELATION_TYPES: RelationType[] = [
  {
    id: "capital-injection",
    label: "资本注入",
    patterns: [
      String.raw`(${EN_ENTITY})\s+invested\s+in\s+(${EN_ENTITY})`,
      String.raw`(${EN_ENTITY})\s+is\s+an?\s+(?:[A-Z][A-Za-z0-9-]*\s+)*investor\s+at\s+(${EN_ENTITY})`,
      String.raw`(${CN_SUBJECT})投资(?:了|于)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})注资(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})入股(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})引导(?:了)?(${CN_OBJECT})投资`,
      String.raw`(${CN_SUBJECT})吸引(?:了)?(${CN_OBJECT})投资`
    ]
  },
  {
    id: "founded",
    label: "创办",
    patterns: [
      String.raw`(${EN_ENTITY})\s+(?:co-)?founded\s+(${EN_ENTITY})`,
      String.raw`(${EN_ENTITY})\s+established\s+(${EN_ENTITY})`,
      String.raw`(${EN_ENTITY})\s+is\s+the\s+founder\s+of\s+(${EN_ENTITY})`,
      String.raw`(${CN_SUBJECT})创办(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})创立(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})成立(?:了)?(${CN_OBJECT})`
    ]
  },
  {
    id: "upholds",
    label: "坚持",
    patterns: [
      String.raw`(${CN_SUBJECT})坚持(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})贯彻(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})落实(?:了)?(${CN_OBJECT})`
    ]
  },
  {
    id: "advances",
    label: "推进",
    patterns: [
      String.raw`(${CN_SUBJECT})推进(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})深化(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})推动(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})促进(?:了)?(${CN_OBJECT})`
    ]
  },
  {
    id: "guides",
    label: "规范引导",
    patterns: [
      String.raw`(${CN_SUBJECT})规范引导(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})引导(?:了)?(${CN_OBJECT})发展`,
      String.raw`(${CN_SUBJECT})鼓励(?:了)?(${CN_OBJECT})发展`
    ]
  },
  {
    id: "empowers",
    label: "赋能",
    patterns: [
      String.raw`(${CN_SUBJECT})赋能(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})激活(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})助力(?:了)?(${CN_OBJECT})`
    ]
  },
  {
    id: "constrains",
    label: "制约",
    patterns: [
      String.raw`(${CN_SUBJECT})制约(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})限制(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})阻碍(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})约束(?:了)?(${CN_OBJECT})`
    ]
  },
  {
    id: "drives",
    label: "带动",
    patterns: [
      String.raw`(${CN_SUBJECT})带动(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})拉动(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})辐射(?:了)?(${CN_OBJECT})`
    ]
  },
  {
    id: "leads",
    label: "领导",
    patterns: [
      String.raw`(${EN_ENTITY})\s+leads\s+(${EN_ENTITY})`,
      String.raw`(${EN_ENTITY})\s+heads\s+(${EN_ENTITY})`,
      String.raw`(${CN_SUBJECT})领导(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})主持(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})主导(?:了)?(${CN_OBJECT})`
    ]
  },
  {
    id: "works-at",
    label: "任职",
    patterns: [
      String.raw`(${EN_ENTITY})\s+works\s+at\s+(${EN_ENTITY})`,
      String.raw`(${CN_SUBJECT})任职(?:于|在)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})供职(?:于|在)?(${CN_OBJECT})`
    ]
  },
  {
    id: "cooperates",
    label: "合作",
    patterns: [
      String.raw`(${EN_ENTITY})\s+partners?\s+with\s+(${EN_ENTITY})`,
      String.raw`(${EN_ENTITY})\s+collaborates?\s+with\s+(${EN_ENTITY})`,
      String.raw`(${CN_SUBJECT})与(${CN_OBJECT})合作`,
      String.raw`(${CN_SUBJECT})联合(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})共建(?:了)?(${CN_OBJECT})`
    ]
  },
  {
    id: "guarantees",
    label: "保障",
    patterns: [
      String.raw`(${CN_SUBJECT})保障(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})保护(?:了)?(${CN_OBJECT})`
    ]
  },
  {
    id: "regulates",
    label: "规范",
    patterns: [
      String.raw`(${CN_SUBJECT})规范(?!引导)(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})约束(?:了)?(${CN_OBJECT})`,
      String.raw`(${CN_SUBJECT})规制(?:了)?(${CN_OBJECT})`
    ]
  },
  {
    id: "transfers",
    label: "流转",
    patterns: [
      // X将Y流转 / X把Y流转 → 宾语在「将/把」后
      String.raw`(${CN_SUBJECT})(?:将|把)(${CN_OBJECT})流转`,
      // X流转了Y（Y 后跟「给/于」等介词则停）
      String.raw`(${CN_SUBJECT})流转(?:了)?(${CN_OBJECT})(?=给|于|到|给$|$|，|。|；)`
    ]
  }
];

/** 从文本抽取三元组（同步、零 LLM）。英文主语需大写开头；中文主语 2-8 汉字。
 * 防御：跳过空/非法正则（空正则 exec 永不前进会死循环） */
export function extractQuickLinks(text: string, relationTypes: RelationType[] = DEFAULT_RELATION_TYPES): QuickLinkTriple[] {
  const triples: QuickLinkTriple[] = [];
  const seen = new Set<string>();

  for (const relation of relationTypes) {
    for (const pattern of relation.patterns) {
      const trimmed = (pattern || "").trim();
      if (!trimmed) continue; // 空 pattern 跳过（防空正则死循环）
      let regex: RegExp;
      try {
        regex = new RegExp(trimmed, "g");
      } catch {
        continue; // 非法正则跳过
      }
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const subject = match[1]?.trim();
        const object = match[2]?.trim();
        if (!subject || !object) continue;
        // 英文主语需大写开头（人名/机构名），跳过代词/小写；中文主语不限
        if (!/^[A-Z]/.test(subject) && !/^[一-龥]/.test(subject)) continue;
        const key = `${subject}|${relation.id}|${object}`;
        if (seen.has(key)) continue;
        seen.add(key);
        triples.push({ subject, relation: relation.id, relationLabel: relation.label, object });
      }
    }
  }

  return triples;
}

const STORAGE_KEY = "sag:quick-link-types:v1";

/** 加载自定义关系类型（无则用默认） */
export function loadRelationTypes(): RelationType[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RELATION_TYPES;
    const parsed = JSON.parse(raw) as RelationType[];
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_RELATION_TYPES;
    return parsed
      .filter((t) => typeof t?.id === "string" && typeof t?.label === "string" && Array.isArray(t?.patterns) && t.patterns.length > 0)
      // 过滤空 pattern（防空正则死循环）
      .map((t) => ({ ...t, patterns: t.patterns.filter((p) => typeof p === "string" && p.trim()) }))
      .filter((t) => t.patterns.length > 0);
  } catch {
    return DEFAULT_RELATION_TYPES;
  }
}

/** 保存自定义关系类型（localStorage） */
export function saveRelationTypes(types: RelationType[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(types));
  } catch {
    // localStorage 不可用则忽略
  }
}
