/**
 * declarations.ts — 投稿声明的数据模型与完整性检查。
 *
 * ## 为什么单独一份
 *
 * 五项声明（作者贡献 / 利益冲突 / 基金资助 / 致谢 / 数据可得性）**没有一个字节能由模型生成**：
 *   · 基金号编错 = 学术不端（不是"写得不好"）；
 *   · 作者贡献写错 = 署名纠纷；
 *   · 数据可得性写错 = 承诺了给不出的数据。
 * 库里**没有任何作者/基金字段**（research_projects 与 users 都没有），所以它只能是用户填的。
 *
 * 模型在这件事上的**唯一**合法用途是把用户填的内容润色成期刊要求的措辞 ——
 * 而那是**可选**的，且永远以用户填的为唯一事实源。
 *
 * 因此这份表的职责是：把"填齐了没有"这件事**说得清楚**，而不是替用户编。
 *
 * ## 存储
 *
 * 落在 `research_nodes` 的 `declarations` 节点（节点表无键约束，加新键不需要迁移）。
 */

export type DeclKey = "authorship" | "funding" | "conflict" | "acknowledgement" | "dataAvailability";

export interface DeclDef {
  key: DeclKey;
  /** 中文标题（导出时作为小标题） */
  label: string;
  /** 填什么、为什么必须填 —— 直接展示给用户，不藏在 tooltip 里 */
  hint: string;
  /** 期刊常见的要求口径（给填写当参照） */
  template: string;
  /** 是否**必须**填。作者贡献/利益冲突几乎每家期刊都要（利益冲突即使没有也要写"无"） */
  required: boolean;
  /** 留空时的占位提示 */
  placeholder: string;
}

export const DECLARATIONS: readonly DeclDef[] = Object.freeze([
  {
    key: "authorship",
    label: "作者贡献声明",
    hint: "按 CRediT 口径写清每位作者做了什么。不要只写「共同完成」—— 审稿与编辑部要的是可分派的贡献。",
    template: "张三：研究设计、数据分析、论文撰写；李四：文献检索、数据收集；王五：方法指导、修改定稿。",
    required: true,
    placeholder: "姓名：贡献；姓名：贡献",
  },
  {
    key: "funding",
    label: "基金资助",
    hint: "写清**项目名称 + 编号 + 资助机构**。编号必须与立项文件一致 —— 编错编号属学术不端。没有则写「无资助」。",
    template: "国家社会科学基金一般项目「XXX」（编号：20BJL001）；无其它资助。",
    required: true,
    placeholder: "项目名称（编号：XXX）；或「无资助」",
  },
  {
    key: "conflict",
    label: "利益冲突声明",
    hint: "**没有也要写「无」**。留空与写「无」在编辑部看来是两回事：前者是待补，后者是已声明。",
    template: "作者声明不存在利益冲突。",
    required: true,
    placeholder: "无。（如有请具体说明）",
  },
  {
    key: "acknowledgement",
    label: "致谢",
    hint: "不满足署名条件但有实质帮助的人（数据提供方、审稿意见、会议讨论）。**与作者贡献是两回事**，别把合作者写进致谢。",
    template: "感谢 XX 单位提供数据支持；感谢 XX 会议参会者的修改建议。",
    required: false,
    placeholder: "可选。没有可留空。",
  },
  {
    key: "dataAvailability",
    label: "数据可得性声明",
    hint: "说明数据在哪、怎么拿到。**不要承诺给不出的数据** —— 编辑部与读者会真的来要。受限数据要写清受限原因与申请途径。",
    template: "本文数据来源于 XX 数据库（公开可获取）；分析代码可向通讯作者索取。",
    required: false,
    placeholder: "数据存放位置与获取方式；或说明受限原因",
  },
]);

export type Declarations = Partial<Record<DeclKey, string>>;

/** 证据来源 —— 可供导出的声明块 */
export interface DeclProblem {
  key: DeclKey;
  label: string;
  /** `missing` = 必填但空；`thin` = 填了但太短（很可能只是占位） */
  kind: "missing" | "thin";
  detail: string;
}

/**
 * 完整性检查 —— 投稿前"要件齐不齐"。
 *
 * 判据刻意**不检查内容对不对**（那要人判断），只检查"有没有填"与"是不是明显敷衍"。
 * 「利益冲突」单列一条：只写了"无"也算齐 —— 那是有效声明，不是敷衍。
 */
export function checkDeclarations(d: Declarations | null | undefined): DeclProblem[] {
  const out: DeclProblem[] = [];
  for (const def of DECLARATIONS) {
    const v = String(d?.[def.key] ?? "").trim();
    if (!v) {
      if (def.required) out.push({ key: def.key, label: def.label, kind: "missing", detail: "必填项留空" });
      continue;
    }
    // 「利益冲突=无」是完整声明，不该被判敷衍
    if (def.key === "conflict" && /^无[。.！!]?$|不存在|无冲突|没有利益冲突/.test(v)) continue;
    if (v.length < 8) out.push({ key: def.key, label: def.label, kind: "thin", detail: `只填了 ${v.length} 个字，可能是占位` });
  }
  return out;
}

/** 快照/节点里存的原始对象 → 规范化（去空白、丢掉未知键） */
export function normDeclarations(raw: unknown): Declarations {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Declarations = {};
  for (const d of DECLARATIONS) {
    const v = String(o[d.key] ?? "").trim();
    if (v) out[d.key] = v;
  }
  return out;
}

/** 生成可拼进终稿的 Markdown 块（只含**有内容**的项，不导出空标题） */
export function declarationsToMarkdown(d: Declarations): string {
  const parts: string[] = [];
  for (const def of DECLARATIONS) {
    const v = String(d[def.key] ?? "").trim();
    if (v) parts.push(`**${def.label}**：${v}`);
  }
  return parts.join("\n\n");
}
