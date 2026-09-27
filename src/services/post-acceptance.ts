// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
/**
 * post-acceptance.ts — 录用之后的**选项表**（版权许可 / 开放获取）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 为什么这里**只有选项与说明，没有生成**
 *
 * 批9 要补的是 17 环节里的第 16(录用出版)。最初想按批4/5 的 kind 模式做成
 * "让模型写一份版权声明/OA 说明" —— **否掉了**，理由两条:
 *
 *   ① 版权许可(版权转让 / CC BY / CC BY-NC-ND…)与 OA 形式(订阅 / 金色 / 绿色 / 混合)
 *      都是**标准条款的选择**，文本是固定的。让模型"写一份"等于让它复述这些条款 ——
 *      写错就是**权利让渡错**，而这种错当事人当场看不出来。
 *   ② 校样检查要**看到校样**。校样是编辑部发来的文件，平台手上没有；
 *      让模型写"校样检查清单"只会得到一段放之四海皆准的套话，而用户需要的是
 *      "对着这份校样逐项核"。
 *
 * 所以这一批做的是**选择 + 模板填入 + 人工核对**，与批5 的投稿声明同一模式:
 * 平台负责把"有哪些选项、各自的含义与代价"摆清楚，**不替用户决定**。
 *
 * ⚠ 这份表**前后端各存一份**(前端在 `web/socialsci-vue/src/shared/post-acceptance.ts`)，
 *   由单测锁住一致 —— 与 `declarations.ts` / `stages.ts` 同一套做法。
 *   为什么不共享一个模块: soc 子应用与后端 tsconfig 不同，跨根 import 会两边都构建不了。
 */
export interface OptionItem {
  /** 存进库的值(英文短码, 不随后端文案变) */
  key: string;
  /** 展示名 */
  label: string;
  /** 这是什么、什么代价 —— **必须写在界面上**, 否则用户只能凭名字猜 */
  hint: string;
}

/**
 * 版权许可。
 *
 * ⚠ 顺序按"从让渡最多到保留最多": 版权转让 → CC BY → CC BY-NC → CC BY-NC-ND。
 *   提醒用户"越往后你保留的越多、但期刊越可能不接受"这件事，由 hint 承担。
 */
export const LICENSE_OPTIONS: readonly OptionItem[] = Object.freeze([
  { key: "transfer", label: "版权转让（传统订阅制）", hint: "著作权转让给期刊，你保留署名权与合理使用。多数中文社科期刊的默认选项。" },
  { key: "cc-by", label: "CC BY（署名）", hint: "允许他人任意使用与再分发，只要署名。**最开放**，但你也放弃了独占。" },
  { key: "cc-by-nc", label: "CC BY-NC（署名-非商业）", hint: "在 CC BY 基础上禁止商业使用。常用于不希望被商业转载的研究。" },
  { key: "cc-by-nc-nd", label: "CC BY-NC-ND（署名-非商业-禁演绎）", hint: "再加「禁止改编」。**约束最多**，但有些期刊不接受。" },
  { key: "other", label: "其他 / 按期刊模板", hint: "期刊给了自己的版权协议模板 —— 按其要求填写，不要套用上面的。" },
]);

/**
 * 开放获取形式。
 *
 * 这是很多作者的**盲区**: "OA"不是一个开关，而是四条路径，代价完全不同。
 * 把差别摊开写是这张表存在的全部意义。
 */
export const OA_OPTIONS: readonly OptionItem[] = Object.freeze([
  { key: "subscription", label: "订阅制（非 OA）", hint: "读者付费/机构订阅。作者不付费，但文章不在网上公开可读。" },
  { key: "gold", label: "金色 OA（期刊官网即时开放）", hint: "期刊把文章直接公开，通常要**作者付版面费/APC**。费用额度要提前问清。" },
  { key: "green", label: "绿色 OA（自存档）", hint: "文章按期刊规定存入机构库/个人主页。**不额外付费**，但常有 embargo 期（6–24 个月）。" },
  { key: "hybrid", label: "混合（期刊可选 OA）", hint: "同一期刊里部分文章 OA。选它=付 APC 换开放，不选就是订阅制。" },
  { key: "undecided", label: "还没定 / 待与编辑部确认", hint: "先记着。**不要凭空选一个** —— 选错会影响费用与复用权利。" },
]);

/**
 * 校样要核什么 —— 一份**可勾选的清单**。
 *
 * 为什么给清单而不是让用户自己写: 校样阶段**改不动内容**(只能改排版与事实错误)，
 * 而"哪些还能改、哪些不能"恰恰是作者最容易做错的地方(有人趁机大改，被要求重新走流程)。
 * 这份清单把"该核什么"与"改了会怎样"一起写出来。
 */
export const PROOF_CHECKLIST: readonly string[] = Object.freeze([
  "作者姓名、单位、署名顺序是否与投稿一致",
  "基金项目名称与编号是否写全、写对",
  "标题、摘要、关键词有无排印错误",
  "图表编号与正文引用是否对得上",
  "参考文献的年份、卷期、页码有无错漏",
  "数字、单位、公式有无转排错误",
]);

/** 把 key 转成展示名; 未知 key 原样返回(不吞) */
export function labelOf(options: readonly OptionItem[], key: string): string {
  return options.find((o) => o.key === key)?.label ?? key;
}
