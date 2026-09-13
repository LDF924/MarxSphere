// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// budget-gate.ts — 额度闸门的路径判定（不计费的操作一律放行）
//
// 由来(2026-09-13): 闸门原来是"整段前缀匹配" —— `/api/review/` 一刀切把纯读接口也拦了。
//   后果: 额度用尽的用户打开「论文质量评审」, 期刊库/评审标准/统计全是空的(402),
//   面板首屏就是坏的, 用户只会以为是 bug。format-eval 的 templates/rules(规则常量)
//   与 classical 的 argument-tree 也错杀。
//
// 判据是"这次请求烧不烧 token", 不是"GET 还是 POST": POST /api/review/jobs/:id/control
// 只是暂停/取消已有任务(不烧); 而 GET /api/review/jobs/:id/stream 是把已生成的评审正文
// 送出来(烧过 token 的产物)。所以豁免写**显式清单**, 不用方法大赦 —— 大赦会漏掉 stream。
import type { FastifyRequest } from "fastify";

const FREE_EXACT = new Set([
  "/api/format-eval/templates",     // 学校模板常量
  "/api/format-eval/rules",         // 规则库常量
  "/api/classical/argument-tree",   // 已存论点树
  "/api/editor/v1/ai/model",        // 当前模型名(下拉框用, 不烧 token)
]);

const FREE_READS = [
  /^\/api\/review\/jobs$/,          // 任务列表(任务详情它返回评审正文, 不豁免)
  /^\/api\/review\/journals$/,      // 期刊库列表
  /^\/api\/review\/standards$/,     // 评审标准列表
];

// paper-outline: 只有"生成正文/要件"烧 LLM; 导出是把已有大纲交给 python-docx 排版, 不花 token。
// (导出原先也没被拦 —— 因为整段 prefix 都不在闸门里, 那时 chapter/component 也一样没拦;
//  2026-09-13 把生成类纳入闸门时, 顺手把这条边界划清楚。)
const FREE_PAPER_OUTLINE = [
  /^\/api\/paper-outline\/export$/,
  /^\/api\/paper-outline\/export-pptx$/,
];

// 记录 id 的形状: 库里 review_journals/review_standards 的主键都是 uuid(迁移里是 gen_random_uuid)。
// 这里必须按 uuid 认, 不能放宽成"任意长串" —— 放宽到 11 位以上就会把 `/journals/batch-parse`
// 当成 "/journals/<id>"(写测试时真踩到过), 于是"批量解析投稿须知"这个烧 LLM 的接口被免费放行。
// 万一将来主键换成非 uuid, 这些分支会变成"多拦"(用户看到 402), 不会误放。
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const FREE_OPS = [
  new RegExp(`^/api/review/journals($|/${UUID}$)`),         // 期刊登记/改名/删除(parse、batch-parse 不在此列)
  new RegExp(`^/api/review/standards($|/${UUID}$)`),        // 评审标准增删改(standards/parse 不在此列)
  new RegExp(`^/api/review/standards/${UUID}/default$`),    // 设为默认(纯本地状态, 不调 LLM)
  /^\/api\/review\/stats$/,                                 // 统计
  /^\/api\/review\/jobs\/[^/]+\/control$/,                  // 暂停/取消/继续已有任务
];

/**
 * 路径判定: true = 不计费, 放行; false = 交给额度闸门判定。
 * 先查精确/子路径规则(比前缀更具体), 再查前缀(由调用方给)。
 */
function isFreeApiCall(method: string, url: string): boolean {
  // 用 URL 剥掉 query(不能直接 split `?` —— url 里的 `?` 只在 query 起始处有意义, 但这仍是最简做法)
  const pathname = url.split("?")[0];
  const m = method.toUpperCase();
  if (FREE_EXACT.has(pathname)) return true;
  if (m === "GET" && FREE_READS.some((re) => re.test(pathname))) return true;
  if (FREE_OPS.some((re) => re.test(pathname))) return true;
  if (FREE_PAPER_OUTLINE.some((re) => re.test(pathname))) return true;
  return false;
}

/**
 * 该请求是否要过额度闸门。
 * 注: `/api/review/jobs/:id` 故意**不在**豁免里 —— 它返回评审正文, 前端轮询时有正文可轮询
 *   就说明这次评审已经跑完了(不会再产生花费), 超额用户被挡在这里看到的是自己刚跑完的结果,
 *   没有新花费; 而真正常看的"跑到哪了"由队列页/任务列表(GET /api/review/jobs)覆盖。
 */
function needsBudgetCheck(method: string, url: string, prefixes: string[]): boolean {
  const pathname = url.split("?")[0];
  if (!prefixes.some((p) => pathname.startsWith(p))) return false;
  return !isFreeApiCall(method, url);
}

/** Fastify 适配: 取原始 url(含 query) */
export function requestNeedsBudgetCheck(request: FastifyRequest, prefixes: string[]): boolean {
  const raw = (request.raw?.url as string | undefined) || String((request as { url?: string }).url ?? "");
  return needsBudgetCheck(request.method, raw, prefixes);
}
