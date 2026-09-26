/**
 * declarations.ts — 投稿声明的**后端侧镜像**（最小）。
 *
 * 为什么只有这么几行：声明的**填写界面**在前端（`web/socialsci-vue/src/shared/declarations.ts`
 * 有 label/hint/template/required/placeholder 那一整套），后端只需要两件事：
 *   1. 导出终稿时知道**按什么顺序、用什么小标题**把这些块拼进去；
 *   2. `project-export-service` 的整包里也要这一段。
 * 所以这里只镜像 `key + label + order`，其余是前端的事 —— 少一份重复就少一处会分叉的东西。
 *
 * ⚠ 但 `key` 与 `label` **必须逐字一致**：不一致的后果是"界面填的作者贡献，导出时不认这个键"，
 *   而那**不报错**，只是那段声明在导出文件里凭空消失。
 *   一致性由 `test/declarations.test.ts` 用文本解析前端那份来钉住（与 stages 同一套做法）。
 *
 * ## 内容为什么必须由人填
 *
 * 库里**没有任何作者/基金字段**（research_projects 与 users 都没有）。而这五项里：
 *   · 基金号编错 = 学术不端；作者贡献写错 = 署名纠纷；数据可得性写错 = 承诺了给不出的数据。
 * 模型在这件事上的唯一合法用途是**润色用户填的内容**，且永远以用户填的为唯一事实源。
 */

export interface DeclMeta {
  key: string;
  label: string;
  /** 导出时的顺序 */
  order: number;
}

export const DECLARATION_META: readonly DeclMeta[] = Object.freeze([
  { key: "authorship", label: "作者贡献声明", order: 1 },
  { key: "funding", label: "基金资助", order: 2 },
  { key: "conflict", label: "利益冲突声明", order: 3 },
  { key: "acknowledgement", label: "致谢", order: 4 },
  { key: "dataAvailability", label: "数据可得性声明", order: 5 },
]);

/**
 * 把声明对象拼成 Markdown 块。
 *
 * **只输出有内容的项** —— 空标题会让编辑以为"声明了这一项但没写"，
 *   而"没写"与"声明了没有"在投稿语境里是两件事（尤其利益冲突）。
 */
export function declarationsToMarkdown(raw: unknown): string {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const m of DECLARATION_META) {
    const v = String(o[m.key] ?? "").trim();
    if (v) parts.push(`**${m.label}**：${v}`);
  }
  return parts.join("\n\n");
}

/** 是否有任何一条声明（决定导出时要不要加这一节） */
export function hasAnyDeclaration(raw: unknown): boolean {
  return declarationsToMarkdown(raw).length > 0;
}
