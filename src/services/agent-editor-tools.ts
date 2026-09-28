// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-editor-tools.ts — V419: 学术文本工作台(/api/editor/v1/*)能力工具化
//
// 由来(2026-09-29): 编辑器那一整套后端(文档 CRUD / 选区改写 / 全文检查 / 题名摘要 / 引文检查 /
//   AI job / 图表代码 / Word 导出 / 学术写作模型)在对话侧**零覆盖** —— 用户在对话里说
//   "帮我把这篇的逻辑过一遍""把标题优化一下", AI 够不着, 只能让他自己去点面板。
//   本文件把它接上。封面的能力对着 server.ts 的 /api/editor/v1/* 逐条核过。
//
// ## 三条硬约束(每条都是实测踩过的坑, 后来者请勿绕过)
//
//  1) **直连 service, 绝不 fetch 自家 HTTP 端点。**
//     `AgentToolDef.run(args)` 的签名里**没有调用者的 token**, 而 /api/editor/v1/* 全部挂
//     requireUser —— 服务器 fetch 自己不带 Authorization, 实测返回 401「未登录」。身份只能
//     从 currentUserId() 取(request-context 的 AsyncLocalStorage, 由 server 的 handler 包进去)。
//     同目录 agent-view-tools.ts 里 V419 那段的注释记着同一条。
//
//  2) ⚠ **不要用 doc_edit**。它操作的是知识库 `documents` 表(doc-session-service 的
//     WriterLease 协议), 而编辑器里的论文在 `documents_v2` 表(editor-service)。
//     这是**两张不同的表**, 拿编辑器文档 id 去 doc_edit 是改错东西 —— 而且**静默**:
//     它按 id 查 `documents`, 查不到就报"文档不存在", 查得到就改的是知识库里的另一条。
//     已确认为一次误判, 记在此处提醒后来者: 编辑器文档一律走本文件的 editor_doc_* 工具。
//
//  3) 每条工具注释都标了 **读/写** —— 接线者据此决定是否登记进 WRITE_TOOLS 与 TOOL_MIN_ROLE。
//     本文件**不自己改**那两个集合: 工具名/risk 与角色闸是两套独立判据, 只写 risk:"safe"
//     挡不住只读会话(本仓记过这条)。
//
// ## risk 取值口径
//   · 产出**新东西**(改写稿 / 题名摘要 / 引文建议 / 图表代码 / docx 文件 / 新建文档) → "safe":
//     本仓先例是 view_task_create 与 record_learning_event / todo_update(同样落库)都放 safe,
//     因为纯新增不覆盖既有资产。⚠ 新建/删除两条的具体登记由接线者定, 我把理由写在各自注释里。
//   · **动用户已经写好的字**(覆盖正文 / 回档 / 删文档 / 改全局模型配置) → "review"。
//     那条线很清楚: 产出新东西可以直接做, 动人家已写的字要先问。
//
// ## 异常与截断
//   异常兜底为「（…不可用: …）», 不抛断工具循环(与 agent-view-tools 的 safeCall 同源)。
//   AI 类工具烧钱: 入参按**后端 prompt 自己的截断长度**截(传更长只是白烧 token), 结果也截。
import type { AgentToolDef } from "./agent-tool-router.js";
import { currentUserId } from "./request-context.js";

/** 安全地执行服务调用, 异常兜底为可读文本(不抛断工具循环) */
async function safeCall(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e: any) {
    return `（编辑器能力不可用: ${String(e?.message || e).slice(0, 150)}）`;
  }
}

/** 没有登录身份时的统一说明 —— 对话触发的工具带得上身份, 后台/定时任务没有 */
const NO_USER = "（需要登录身份 — 对话触发的工具会带上传入者身份; 后台任务里没有）";

/** 结果截断(工具结果进上下文, 全量吐回既贵又读不完) */
const OUT_MAX = 1500;

/**
 * 入参截断 —— 数值**不是**我拍的, 是后端 prompt 自己的 slice 长度:
 *   rewriteText : text.slice(0, 6000)      / editor-service.ts:179
 *   checkFulltext / generateTitleAbstract : slice(0, 12000)（:229 / :277）
 *   formatReferences : slice(0, 8000)      （:321）
 * 传超过这个长度的文本, 后端直接丢掉尾巴却不告诉任何人 —— 这里先截并在结果里说明。
 */
const MAX_SELECTION = 6000;
const MAX_FULLTEXT = 12000;
const MAX_REFS = 8000;

/**
 * 编辑器正文 → 纯文本。
 * documents_v2.content 是**字符串**(前端存的是 TipTap 的 JSON 序列化, 也可能本来就是纯文本),
 * 直接把 JSON 喂给 AI 是拿大半 token 换回一堆语法噪声。口径与前端 AIPanel.vue 的
 * plainTextOf 一致(那边是唯一在使用的那份), 免得两边对同一篇文档给出不同的"全文"。
 */
function plainText(raw: unknown): string {
  let s = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  if (!s) return "";
  if (s.trim().startsWith("{")) {
    try {
      const out: string[] = [];
      const walk = (n: any) => {
        if (!n || typeof n !== "object") return;
        if (typeof n.text === "string") out.push(n.text);
        if (Array.isArray(n.content)) n.content.forEach(walk);
      };
      walk(JSON.parse(s));
      s = out.join("\n");
    } catch { /* 不是 JSON → 当纯文本处理 */ }
  } else {
    s = s.replace(/<[^>]+>/g, "");
  }
  return s;
}

/**
 * docId → 文档行。省略 docId 时取该用户**最近更新的**一篇 —— 对话里没人会去报 UUID。
 * 但结果里必须**说清取的是哪一篇**: 用户以为看的是甲篇、实际取的是乙篇, 是那种最难发现的
 * 误会(工具跑通了、数据全对, 只是对象不对)。
 */
async function resolveDoc(uid: string, docIdRaw: unknown): Promise<{ doc: Record<string, any> } | { error: string }> {
  const { getDoc, listDocs } = await import("./editor-service.js");
  const id = String(docIdRaw ?? "").trim();
  if (id) {
    const doc = await getDoc(uid, id) as Record<string, any> | null;
    if (!doc) return { error: `（文档 ${id.slice(0, 8)}… 不存在或不属于你 — 先用 view_editor_docs 查 id）` };
    return { doc };
  }
  const res = await listDocs(uid, { page: 1, pageSize: 1 });
  const first = (res?.items ?? [])[0] as Record<string, any> | undefined;
  if (!first) return { error: "【编辑文档】你还没有文档 — 到「学术文本工作台」新建, 或用 editor_doc_create 建一篇。" };
  const doc = await getDoc(uid, String(first.id)) as Record<string, any> | null;
  if (!doc) return { error: "（取最近更新的文档失败 — 请显式给 docId）" };
  return { doc };
}

/** 文档行的公共行格式 */
function docLine(d: Record<string, any>, i: number): string {
  const locked = String(d.locked_by ?? "");
  return `${i + 1}. ${String(d.title ?? "(无题)").slice(0, 40)} — ${Number(d.word_count ?? 0)} 字 · ${String(d.status ?? "draft")}`
    + `${locked ? " · 🔒被锁" : ""} · 更新 ${String(d.updated_at ?? "").slice(0, 10)}\n   docId: ${d.id}`;
}

/** 创作类工具的名称 → 中文(只用于结果文案; 取值真源在 editor-service 的 MODE_PROMPT / CHECK_MODES 等表里) */
const REWRITE_MODES = ["polish", "de-template", "condense", "expand", "proofread", "journal-style", "humanize"] as const;
const REWRITE_CN: Record<string, string> = {
  polish: "学术润色", "de-template": "去模板化", condense: "压缩冗余", expand: "扩展论证",
  proofread: "校对", "journal-style": "期刊风格", humanize: "降低 AI 痕迹",
};
const CHECK_MODES = ["logic", "cohesion", "consistency", "submission"] as const;
const CHECK_CN: Record<string, string> = {
  logic: "全文逻辑检查", cohesion: "章节衔接检查", consistency: "变量-方法-结论一致性", submission: "投稿前检查",
};
const CHECK_ALIAS: Record<string, string> = {
  logic_check: "logic", section_coherence_check: "cohesion",
  variable_method_conclusion_check: "consistency", submission_check: "submission",
};
const TITLE_MODES = ["title", "abstract", "keywords"] as const;
const TITLE_CN: Record<string, string> = { title: "优化标题", abstract: "优化摘要", keywords: "提取关键词" };
const CITATION_KINDS = ["consistency", "format"] as const;
const CITATION_CN: Record<string, string> = { consistency: "引用一致性检查", format: "格式与语言检查" };

/**
 * renderChart 返回的是**不带前缀**的对象 key(`viz-files/<uid>/<hash>.png`, 见其 persistArtifacts),
 * 但 /api/viz/files/* 那条路由的合法 URL 必须在 viz-files 之前带一段前缀 —— readVizFile 用
 * `clean.indexOf("/viz-files/<uid>/")` 定位(viz-exec-service.ts:269), 前缀缺了它直接判"路径非法"。
 * 实测(2026-09-29): **同一个文件**, `/api/viz/files/data/viz-files/…` 返回 200 image/png,
 *   `/api/viz/files/viz-files/…` 返回 404 —— 不是鉴权问题, 是路径形态。
 * V399 那个 view_chart_digitize 工具没有这个问题, 因为 agent 那边存的是带 data/ 的历史路径。
 */
function vizFileUrl(rel?: string): string {
  const s = String(rel ?? "").trim().replace(/^\/+/, "");
  if (!s) return "";
  return `/api/viz/files/${s.startsWith("viz-files/") ? `data/${s}` : s}`;
}

export const EDITOR_TOOLS: AgentToolDef[] = [
  // ─────────────────────────────────────────────────────────────────────────────
  // 文档台账与正文(读写分得最清的四个)
  // ─────────────────────────────────────────────────────────────────────────────
  {
    // 读 — 不写任何东西
    name: "view_editor_docs", label: "编辑文档列表", risk: "safe",
    description: "列出「学术文本工作台」里当前用户的论文文档(标题/字数/状态/是否被锁/更新时间), 并给出 docId 供后续工具使用",
    params: {
      page: { type: "number", desc: "页码(默认1)" },
      pageSize: { type: "number", desc: "每页条数(默认20, 上限50)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const { listDocs } = await import("./editor-service.js");
      const pageSize = Math.min(Math.max(Number(a.pageSize) || 20, 1), 50);
      const res = await listDocs(uid, { page: Math.max(Number(a.page) || 1, 1), pageSize });
      const items = (res?.items ?? []) as Array<Record<string, any>>;
      if (!items.length) return "【编辑文档】还没有文档 — 到「学术文本工作台」新建, 或用 editor_doc_create 建一篇。";
      return `【编辑文档】共 ${res.total ?? items.length} 篇（第 ${res.page ?? 1} 页）\n` + items.map(docLine).join("\n");
    }),
  },
  {
    // 读 — 不写任何东西
    name: "view_editor_doc", label: "编辑文档读取", risk: "safe",
    description: "读「学术文本工作台」某篇论文的正文(纯文本预览)与元信息, 并给出 content_hash 乐观锁基准供 editor_doc_write 使用",
    params: {
      docId: { type: "string", desc: "文档 id; 省略则取最近更新的一篇" },
      maxChars: { type: "number", desc: "正文预览上限(默认3000, 上限12000)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const r = await resolveDoc(uid, a.docId);
      if ("error" in r) return r.error;
      const d = r.doc;
      // content_hash 只在"当前版本行"上 —— editor-service 没有导出这个查询, 那边是
      // server.ts 的 GET /documents/:docId 内联做的(server.ts:11148)。同一份 SQL 照抄,
      // 因为前端拿它当乐观锁基准, 换了口径两边就对不上了。
      let contentHash = "";
      try {
        const { pool } = await import("../db/pool.js");
        const hv = await pool.query(`select content_hash from doc2_versions where id=$1`, [d.current_version_id]);
        contentHash = String((hv.rows[0] as any)?.content_hash ?? "");
      } catch { /* hash 取不到不阻断(与 server 同口径) */ }
      const text = plainText(d.content);
      const max = Math.min(Math.max(Number(a.maxChars) || 3000, 500), 12000);
      const head = `【编辑文档】《${String(d.title ?? "(无题)")}》
docId: ${d.id}
${Number(d.word_count ?? 0)} 字 · ${String(d.status ?? "draft")} · 更新 ${String(d.updated_at ?? "").slice(0, 19)}
content_hash: ${contentHash || "（取不到 — editor_doc_write 将不做乐观锁校验）"}
锁: ${String(d.locked_by ?? "") ? `🔒 被 ${String(d.locked_by)} 持有(超过5分钟自动释放)` : "未锁"}`;
      return `${head}\n\n【正文${text.length > max ? `·前 ${max}/${text.length} 字` : "·全文"}】\n${text.slice(0, max) || "（空文档）"}`;
    }),
  },
  {
    // 写 — 落库新建一条 documents_v2(初始版本行 + 指针), 但不碰任何既有文档
    name: "editor_doc_create", label: "新建编辑文档", risk: "safe",
    description: "在「学术文本工作台」新建一篇论文文档(可带标题与初始正文), 返回 docId",
    params: {
      title: { type: "string", desc: "标题(默认「未命名文档」)" },
      content: { type: "string", desc: "初始正文(纯文本或 TipTap JSON 字符串; 可空)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const { createDoc } = await import("./editor-service.js");
      const title = String(a.title ?? "").trim() || "未命名文档";
      // ⚠ 不截断也不清洗 content: 前端存的就是 TipTap JSON 字符串, 洗了反而破坏格式
      const content = String(a.content ?? "");
      const r = await createDoc(uid, title, content);
      return `【已新建】《${title}》${content ? `（${content.replace(/\s/g, "").length} 字）` : "（空文档）"}\ndocId: ${r.id}\n到「学术文本工作台」打开即可编辑。`;
    }),
  },
  {
    // 写 — 真删数据; risk=review 见文件头的口径
    //   ⚠ 实测确认(2026-09-29): doc2_versions → documents_v2 的外键是 **ON DELETE CASCADE**,
    //   所以删主表会把版本历史一起带走 —— 删完**连回档的余地都没有**(我原以为版本行会留下,
    //   实测查到 delete_rule=CASCADE 才改的口径)。这是它必须是 review 而不是 safe 的硬理由。
    name: "editor_doc_delete", label: "删除编辑文档", risk: "review",
    description: "删除「学术文本工作台」的一篇论文文档。⚠ 不可逆: 版本历史行随外键级联一并删除, 删后无法回档。需人工审批",
    params: {
      docId: { type: "string", required: true, desc: "要删的文档 id(view_editor_docs 可查)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const docId = String(a.docId ?? "").trim();
      if (!docId) return "（需要 docId）";
      const { deleteDoc } = await import("./editor-service.js");
      const r = await deleteDoc(uid, docId);
      if (!r) return `（删除失败: 文档 ${docId.slice(0, 8)}… 不存在或不属于你）`;
      return `【已删除】文档 ${docId.slice(0, 8)}…（版本历史已随外键级联删除, 不可恢复）`;
    }),
  },
  {
    // 写 — **覆盖用户已写的正文**(这条就是"动人家字"的定义), risk=review
    name: "editor_doc_write", label: "写编辑文档", risk: "review",
    description: "改写「学术文本工作台」某篇论文的正文/标题/标签(自动写新版本行, 历史可回档)。带 content_hash 时做乐观锁校验, 他窗口改过会拒绝而不是覆盖。需人工审批",
    params: {
      docId: { type: "string", required: true, desc: "文档 id" },
      content: { type: "string", desc: "新正文(整篇覆盖; 纯文本或 TipTap JSON 字符串)。与 title/tags 至少给一个" },
      title: { type: "string", desc: "新标题" },
      tags: { type: "string", desc: "标签, 逗号分隔" },
      expectedContentHash: { type: "string", desc: "乐观锁基准(先用 view_editor_doc 取 content_hash); 不带则不校验" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const docId = String(a.docId ?? "").trim();
      if (!docId) return "（需要 docId）";
      const patch: { title?: string; content?: string; tags?: string[] } = {};
      if (a.title !== undefined) patch.title = String(a.title);
      if (a.content !== undefined) patch.content = String(a.content);
      if (a.tags !== undefined) patch.tags = String(a.tags).split(",").map((s) => s.trim()).filter(Boolean);
      if (!Object.keys(patch).length) return "（content / title / tags 至少给一个）";

      // 乐观锁: 照抄 server.ts PUT /documents/:docId 的判定(server.ts:11162)。
      // ⚠ 后端把 expectedContentHash **剔掉**再交给 saveDoc(表里没这列, 带上会 500),
      //   所以我这里也不把它传给 service。
      const expect = String(a.expectedContentHash ?? "").trim();
      if (expect && patch.content !== undefined) {
        const { pool } = await import("../db/pool.js");
        const cur = await pool.query(
          `select v.content_hash, v.content from doc2_versions v
             join documents_v2 d on d.current_version_id = v.id
            where d.id = $1 and d.user_id = $2`, [docId, uid]);
        const curHash = (cur.rows[0] as any)?.content_hash ?? null;
        const curContent = String((cur.rows[0] as any)?.content ?? "");
        // 判定同时看 hash 与正文: 只有"hash 变了**且**正文也不是我要写的这份"才算别人改过。
        // 少了 content 这一半, agent 自己重试同一份内容会被自己的上一次写入挡住。
        if (curHash && curHash !== expect && curContent !== patch.content) {
          return "（文档已在其他窗口被修改 — 请先 view_editor_doc 重读最新正文与 content_hash, 确认后再写）";
        }
      }

      const { saveDoc } = await import("./editor-service.js");
      const r = await saveDoc(uid, docId, patch);
      if (!r) return `（写入失败: 文档 ${docId.slice(0, 8)}… 不存在或不属于你）`;
      const what = [patch.content !== undefined ? "正文" : "", patch.title !== undefined ? "标题" : "", patch.tags !== undefined ? "标签" : ""].filter(Boolean).join("/");
      return `【已写入】文档 ${docId.slice(0, 8)}… 的${what} — 现 ${r.word_count ?? "?"} 字, 新版本 v${r.currentVersion ?? "?"}（历史保留, 可 editor_doc_restore 回档）`;
    }),
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // 编辑锁 / 版本
  // ─────────────────────────────────────────────────────────────────────────────
  {
    // 写 — 只改 documents_v2 的 locked_by/locked_at/status 这一栏, 不碰正文
    //   为什么是 safe: 锁有 5 分钟自动过期, 且**不阻断**任何读写(它不是悲观锁, 是提示位);
    //   最坏后果是别人看见"被锁"多等一会儿。
    name: "editor_doc_lock", label: "编辑文档加解锁", risk: "safe",
    description: "给「学术文本工作台」的文档加编辑锁(声明你在改, 5 分钟自动过期)或解锁",
    params: {
      docId: { type: "string", required: true, desc: "文档 id" },
      op: { type: "string", desc: "lock(默认) / unlock" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const docId = String(a.docId ?? "").trim();
      if (!docId) return "（需要 docId）";
      const { lockDoc, unlockDoc } = await import("./editor-service.js");
      if (String(a.op ?? "lock") === "unlock") {
        await unlockDoc(uid, docId);
        return `【已解锁】文档 ${docId.slice(0, 8)}…`;
      }
      const r = await lockDoc(uid, docId);
      return r.ok
        ? `【已加锁】文档 ${docId.slice(0, 8)}…（5 分钟无操作自动释放）`
        : "（加锁失败: 文档不存在/不属于你, 或正被他人锁定且未过期）";
    }),
  },
  {
    // 读 — 不写任何东西
    name: "view_editor_versions", label: "编辑文档版本列表", risk: "safe",
    description: "列出「学术文本工作台」某篇论文的历史版本(版本号/标题/字数/时间/来源), 供 editor_doc_restore 回档",
    params: {
      docId: { type: "string", required: true, desc: "文档 id" },
      limit: { type: "number", desc: "返回条数(默认10, 上限50)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const docId = String(a.docId ?? "").trim();
      if (!docId) return "（需要 docId）";
      // editor-service 只导出了 restoreDocVersion, 没有"列版本"的函数 —— 这条查询在
      // server.ts 的 GET /documents/:docId/versions 里内联(server.ts:11188)。
      // 照抄同一份 SQL(含 order by version desc limit 50), 保证与面板看到的是同一串版本。
      const { pool } = await import("../db/pool.js");
      const owner = await pool.query(`select id from documents_v2 where id=$1 and user_id=$2`, [docId, uid]);
      if (!owner.rows.length) return `（文档 ${docId.slice(0, 8)}… 不存在或不属于你）`;
      const r = await pool.query(
        `select version, content_hash, title, content_len, by_editor, created_at from doc2_versions
          where document_id=$1 order by version desc limit 50`, [docId]);
      const rows = r.rows as Array<Record<string, any>>;
      if (!rows.length) return "（没有版本记录）";
      const top = rows.slice(0, Math.min(Math.max(Number(a.limit) || 10, 1), 50));
      return `【版本历史】共 ${rows.length} 个（倒序）\n` + top.map((v, i) =>
        `${i + 1}. v${v.version} — ${String(v.title ?? "(无题)").slice(0, 30)} · ${Number(v.content_len ?? 0)} 字 · ${String(v.created_at ?? "").slice(0, 19)} · ${String(v.by_editor ?? "")}`
      ).join("\n");
    }),
  },
  {
    // 写 — **拿历史正文覆盖当前正文**(动人家字), risk=review
    name: "editor_doc_restore", label: "编辑文档版本回档", risk: "review",
    description: "把「学术文本工作台」某篇论文回档到某个历史版本(取该版正文写回, 并落一条新版本行 —— 回档本身也可再回档)。需人工审批",
    params: {
      docId: { type: "string", required: true, desc: "文档 id" },
      version: { type: "number", required: true, desc: "要回到的版本号(view_editor_versions 可查)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const docId = String(a.docId ?? "").trim();
      const version = Number(a.version);
      if (!docId || !version) return "（需要 docId 与 version）";
      const { restoreDocVersion } = await import("./editor-service.js");
      const r = await restoreDocVersion(uid, docId, version);
      if (!r) return `（回档失败: 文档 ${docId.slice(0, 8)}… 或版本 v${version} 不存在）`;
      return `【已回档】文档 ${docId.slice(0, 8)}… 回到 v${r.restoredFrom}（当前 v${r.currentVersion}; 回档前的正文仍在历史里）`;
    }),
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // AI 能力(4 检查 / 改写 / 题名摘要 / 引文) —— 全部直连 service, 不经 job 容器
  //
  // 为什么不走 editor-ai-job-service: 那套是**内存 Map + fire-and-forget**(见该文件头),
  // 创建即返回 job_id, 结果要另处轮询/SSE 取 —— 工具是一次调用拿一个结果, 走 job 等于
  // 让 agent 多绕两轮(且进程重启就丢)。下面四条直接调底层 service 函数, job 容器那套
  // 单独由 editor_ai_job / view_editor_ai_job 覆盖(用户要的就是"能创建/能查能取消")。
  //
  // 四条都是"产出新文本, 不动用户正文", risk=safe; 用户要落盘得自己接着说
  // "把改写稿写回第 X 段"(那一步会走 editor_doc_write = review)。
  // ─────────────────────────────────────────────────────────────────────────────
  {
    // 读 — 只出建议不写正文(editor-service 注释就写着"只给修改建议, 不直接改正文")
    name: "editor_fulltext_check", label: "论文全文检查", risk: "safe",
    description: "对论文全文做 AI 质检, 四种动作: logic(全文逻辑)/cohesion(章节衔接)/consistency(变量-方法-结论一致)/submission(投稿前)。只给修改建议, 不改正文; 不判断文献是否真实存在",
    params: {
      docId: { type: "string", desc: "文档 id; 省略则取最近更新的一篇(自动读全文)" },
      text: { type: "string", desc: "直接给全文(与 docId 二选一; 超过 12000 字会被截断 — 后端 prompt 也是这个长度)" },
      mode: { type: "string", required: true, desc: "动作: logic / cohesion / consistency / submission(也接受面板按钮名 logic_check 等)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const raw = String(a.mode ?? "").trim();
      const mode = (CHECK_ALIAS[raw] ?? raw) as string;
      if (!(CHECK_MODES as readonly string[]).includes(mode)) {
        return `（mode 需为 ${CHECK_MODES.join(" / ")}；面板按钮名 ${Object.keys(CHECK_ALIAS).join(" / ")} 也接受）`;
      }
      let text = String(a.text ?? "");
      let from = "";
      if (!text.trim()) {
        const r = await resolveDoc(uid, a.docId);
        if ("error" in r) return r.error;
        text = plainText(r.doc.content);
        from = `《${String(r.doc.title ?? "(无题)")}》`;
      }
      if (!text.trim()) return "（没有可检查的正文 — 文档是空的, 或 text 为空）";
      const truncated = text.length > MAX_FULLTEXT;
      const { checkFulltext } = await import("./editor-service.js");
      // 带 userId: 成本账本按用户归属(不带就记到平台账上)
      const r = await checkFulltext(text.slice(0, MAX_FULLTEXT), mode, { userId: uid });
      const lines = (r.checks ?? []).map((c) => {
        const fs = c.findings ?? [];
        return c.ok && !fs.length ? `✔ ${c.name}: 未发现问题` : `✘ ${c.name}: 发现 ${fs.length} 项\n` + fs.slice(0, 12).map((f, i) => `   ${i + 1}. ${String(f).slice(0, 200)}`).join("\n");
      });
      return `【${CHECK_CN[mode] ?? r.modeName}】${from}${truncated ? `（仅检查前 ${MAX_FULLTEXT} 字）` : ""}\n` + (lines.join("\n") || "（未返回建议）");
    }),
  },
  {
    // 读 — 产出的是**新文本**, 不落库也不改原文(要不要写回去由用户拿主意)
    name: "editor_rewrite", label: "学术文本改写", risk: "safe",
    description: "对选中的学术文本做改写: polish(学术润色)/de-template(去模板化)/condense(压缩冗余)/expand(扩展论证)/proofread(校对)/journal-style(期刊风格)/humanize(降低AI痕迹)。返回改写稿, 不自动写回正文",
    params: {
      text: { type: "string", required: true, desc: "要改写的选中文本(超过 6000 字会被截断 — 后端 prompt 也是这个长度)" },
      mode: { type: "string", required: true, desc: "改法: polish / de-template / condense / expand / proofread / journal-style / humanize" },
      context: { type: "string", desc: "选区上下文(仅供模型判断风格与衔接, 不会被改写; 上限 3000 字)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const mode = String(a.mode ?? "").trim();
      if (!(REWRITE_MODES as readonly string[]).includes(mode)) {
        return `（mode 需为 ${REWRITE_MODES.join(" / ")}）`;
      }
      const text = String(a.text ?? "");
      if (!text.trim()) return "（需要 text：要改写的文本）";
      const truncated = text.length > MAX_SELECTION;
      const { rewriteText } = await import("./editor-service.js");
      const r = await rewriteText(mode as never, text.slice(0, MAX_SELECTION), String(a.context ?? ""), { userId: uid });
      const out = String(r.text ?? "").trim();
      if (!out) return "（改写返回空内容 — 模型没吐正文, 稍后重试或换 mode）";
      return `【${REWRITE_CN[mode]}】${truncated ? `（仅改写前 ${MAX_SELECTION} 字）` : ""}（原 ${text.replace(/\s/g, "").length} 字 → ${out.replace(/\s/g, "").length} 字）\n\n${out.slice(0, OUT_MAX)}\n\n（如需落到文档里, 用 editor_doc_write；该步会走人工审批）`;
    }),
  },
  {
    // 读 — 同样只产出候选文本
    name: "editor_title_abstract", label: "标题摘要关键词", risk: "safe",
    description: "为论文生成/优化题名要件, 三种动作: title(5 个候选标题+优化理由)/abstract(摘要改写+原摘要问题)/keywords(关键词候选+依据)",
    params: {
      docId: { type: "string", desc: "文档 id; 省略则取最近更新的一篇(自动读全文)" },
      text: { type: "string", desc: "直接给全文(与 docId 二选一; 超过 12000 字会被截断)" },
      mode: { type: "string", required: true, desc: "动作: title / abstract / keywords" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const mode = String(a.mode ?? "").trim();
      if (!(TITLE_MODES as readonly string[]).includes(mode)) return `（mode 需为 ${TITLE_MODES.join(" / ")}）`;
      let text = String(a.text ?? "");
      let from = "";
      if (!text.trim()) {
        const r = await resolveDoc(uid, a.docId);
        if ("error" in r) return r.error;
        text = plainText(r.doc.content);
        from = `《${String(r.doc.title ?? "(无题)")}》`;
      }
      if (!text.trim()) return "（没有可用的正文 — 文档是空的, 或 text 为空）";
      const { generateTitleAbstract } = await import("./editor-service.js");
      const r = await generateTitleAbstract(text.slice(0, MAX_FULLTEXT), mode, { userId: uid });
      // ⚠ generateTitleAbstract 解析失败时返回**全空对象**且不报错(editor-service.ts:290),
      //   所以这里必须显式判空 —— 否则工具会"成功"返回一段空白。
      const parts: string[] = [];
      if (mode === "title") {
        if (!String(r.title ?? "").trim() && !(r.alternatives ?? []).length) return "（未返回标题 — 模型输出无法解析, 稍后重试）";
        parts.push(`推荐: ${r.title ?? ""}`);
        if (r.alternatives?.length) parts.push("候选:\n" + r.alternatives.map((t, i) => `  ${i + 1}. ${t}`).join("\n"));
        if (r.reason) parts.push(`理由: ${r.reason}`);
      } else if (mode === "abstract") {
        if (!String(r.abstract ?? "").trim() && !(r.issues ?? []).length) return "（未返回摘要 — 模型输出无法解析, 稍后重试）";
        parts.push(String(r.abstract ?? ""));
        if (r.issues?.length) parts.push("原摘要问题:\n" + r.issues.map((x) => `  - ${x}`).join("\n"));
      } else {
        if (!(r.keywords ?? []).length && !r.reason) return "（未返回关键词 — 模型输出无法解析, 稍后重试）";
        parts.push((r.keywords ?? []).map((k, i) => `${i + 1}. ${k}`).join("\n"));
        if (r.reason) parts.push(`依据: ${r.reason}`);
      }
      return `【${TITLE_CN[mode]}】${from}\n\n${parts.join("\n\n").slice(0, OUT_MAX)}`;
    }),
  },
  {
    // 读 — consistency 只出问题清单; format 会附带一份"规范化后的参考文献列表",
    //   那是**给用户看的产出**, 不自动写回正文(要写回是 editor_doc_write 的事)
    name: "editor_citation_check", label: "引文检查", risk: "safe",
    description: "引文检查两种动作: consistency(正文 [N] 标注与文末列表是否一一对应/跳号/姓名年份不一致)/format(标题与图表编号、语言风格、著录项是否齐全, 并给出规范化后的参考文献列表)。不判断文献是否真实存在",
    params: {
      docId: { type: "string", desc: "文档 id; 省略则取最近更新的一篇(自动读全文)" },
      text: { type: "string", desc: "直接给文本(与 docId 二选一; 超过 8000 字会被截断)" },
      kind: { type: "string", required: true, desc: "动作: consistency(引用一致性) / format(格式与语言)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const kind = String(a.kind ?? "").trim();
      if (!(CITATION_KINDS as readonly string[]).includes(kind)) return `（kind 需为 ${CITATION_KINDS.join(" / ")}）`;
      let text = String(a.text ?? "");
      let from = "";
      if (!text.trim()) {
        const r = await resolveDoc(uid, a.docId);
        if ("error" in r) return r.error;
        text = plainText(r.doc.content);
        from = `《${String(r.doc.title ?? "(无题)")}》`;
      }
      if (!text.trim()) return "（没有可检查的文本 — 文档是空的, 或 text 为空）";
      const { formatReferences } = await import("./editor-service.js");
      const r = await formatReferences(text.slice(0, MAX_REFS), kind as never, { userId: uid });
      const parts: string[] = [];
      if (r.stats) parts.push(`正文标注 ${r.stats.citedInText ?? 0} 处 · 文末列表 ${r.stats.listed ?? 0} 条`);
      // consistency 分支的 r.text 恒为空串(editor-service 明示"不输出规范化列表"), 只报问题
      if (String(r.text ?? "").trim()) parts.push("规范化后的参考文献:\n" + String(r.text).slice(0, 900));
      if (r.fixes?.length) parts.push("问题/修正点:\n" + r.fixes.slice(0, 12).map((f, i) => `${i + 1}. ${String(f).slice(0, 200)}`).join("\n"));
      return `【${CITATION_CN[kind]}】${from}\n\n` + (parts.join("\n\n") || "（未发现问题）");
    }),
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // AI job 容器(内存 Map + fire-and-forget; 与前端面板同一条契约)
  // ─────────────────────────────────────────────────────────────────────────────
  {
    // 写 — 创建会**真起一次 LLM 任务并冻结/核销积分**; cancel/retry 只动任务自身状态
    //   为什么不 review: 它不改用户的字。产出在 job.content 里, 落库与否是另一步
    //   (editor_doc_write = review)。
    name: "editor_ai_job", label: "编辑器 AI 任务", risk: "safe",
    description: "创建/取消/重试「学术文本工作台」的 AI 任务(与面板同一套 job 契约: 异步执行, 用 view_editor_ai_job 取结果)。action: rewrite/check/title/format_refs",
    params: {
      op: { type: "string", desc: "create(默认) / cancel / retry" },
      action: { type: "string", desc: "create 必填: rewrite(改写) / check(全文检查) / title(题名摘要) / format_refs(引文检查)" },
      text: { type: "string", desc: "create 必填: 待处理文本(全文或选区)" },
      mode: { type: "string", desc: "create 选填: 细动作(如 rewrite 的 polish / check 的 logic / title 的 abstract / format_refs 的 format)" },
      context: { type: "string", desc: "create 选填: 选区上下文" },
      documentId: { type: "string", desc: "create 选填: 关联的文档 id(仅作记录)" },
      jobId: { type: "string", desc: "cancel / retry 必填: 任务 id" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const { createAiJob, cancelAiJob, retryAiJob } = await import("./editor-ai-job-service.js");
      const op = String(a.op ?? "create").trim();

      if (op === "cancel") {
        const jobId = String(a.jobId ?? "").trim();
        if (!jobId) return "（需要 jobId）";
        // ⚠ 说清语义: 在途的 LLM 调用**无法真正中断**, cancel 只是把状态标掉、
        //   收尾时按"取消"归还积分而不是核销(job 服务里的 cancelled 标志, 见其注释)。
        return cancelAiJob(uid, jobId)
          ? `【已取消】任务 ${jobId.slice(0, 8)}…（在途的模型调用停不下来, 但结果不会按成功计费）`
          : "（取消失败: 任务不存在, 或已经跑完/已取消）";
      }
      if (op === "retry") {
        const jobId = String(a.jobId ?? "").trim();
        if (!jobId) return "（需要 jobId）";
        const j = await retryAiJob(uid, jobId);
        if (!j) return "（重试失败: 任务不存在, 或状态不是 failed/cancelled(只有失败/取消的才可重试)）";
        return `【已重新入队】任务 ${j.id.slice(0, 8)}…（重跑会再消耗一次积分）\n用 view_editor_ai_job 取结果。`;
      }

      const action = String(a.action ?? "").trim();
      const text = String(a.text ?? "");
      if (!["rewrite", "check", "title", "format_refs"].includes(action)) return "（action 需为 rewrite / check / title / format_refs）";
      if (!text.trim()) return "（需要 text）";
      // createAiJob 会抛: 同一用户并发超上限 / 积分不足(InsufficientPointsError)
      const job = await createAiJob(uid, {
        action, text, mode: String(a.mode ?? ""),
        context: String(a.context ?? ""),
        document_id: a.documentId !== undefined ? String(a.documentId) : undefined,
      });
      if (!job) return "（创建失败: action 非法）";
      return `【任务已创建】${job.id}\n模型: ${job.model}${job.points?.cost ? ` · 冻结 ${job.points.cost} 积分(成功核销, 失败归还)` : ""}\n用 view_editor_ai_job 传 jobId 取结果（任务只存内存, 30 分钟后清理; 服务重启即丢）。`;
    }),
  },
  {
    // 读 — 只查状态与结果
    name: "view_editor_ai_job", label: "编辑器 AI 任务查询", risk: "safe",
    description: "查「学术文本工作台」AI 任务的状态与结果(queued/running/done/failed/cancelled)。⚠ 任务存在内存 Map 里, 30 分钟过期、服务重启即丢",
    params: {
      jobId: { type: "string", required: true, desc: "任务 id(editor_ai_job 创建时返回)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const jobId = String(a.jobId ?? "").trim();
      if (!jobId) return "（需要 jobId）";
      // 只返回属于调用者的任务(getAiJob 已按 userId 过滤), 不另做权限判断
      const { getAiJob } = await import("./editor-ai-job-service.js");
      const j = getAiJob(uid, jobId);
      if (!j) return "（任务不存在或已过期 — 内存里的任务 30 分钟清理, 服务重启即丢; 结果要留存请落库/写回文档）";
      const ago = Math.round((Date.now() - j.createdAt) / 1000);
      const head = `【AI 任务】${j.action}${j.payload?.mode ? `/${String(j.payload.mode)}` : ""} — ${j.status}（${ago}s 前创建, 模型 ${j.model}）`;
      if (j.error) return `${head}\n失败原因: ${String(j.error).slice(0, 300)}`;
      const content = String(j.content ?? "");
      // ⚠ 状态可能是 done 而 content 仍为空: renderTitleContent / renderCitationContent 在
      //   模型输出解析不了时返回的是空串(job 服务那几个 render 函数末尾的 `|| ""` 分支)。
      //   实测确认过这条：所以不能只看 status, 必须按 content 判。
      if (!content.trim()) {
        return j.status === "done"
          ? `${head}\n（任务已完成但**没有内容** — 多半是模型输出没解析成功: 引文检查的"规范化列表"与摘要/关键词都有这种空产出分支。换模型或重试一次; 需要完整原始结果请用 editor_rewrite / editor_fulltext_check 这类直连工具）`
          : `${head}\n（还没有内容 — 排队中或刚启动, 稍后再查）`;
      }
      return `${head}\n\n${content.slice(0, OUT_MAX)}${content.length > OUT_MAX ? `\n…（截断, 全文 ${content.length} 字）` : ""}`;
    }),
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // 图表代码 / Word 导出 / 学术写作模型
  // ─────────────────────────────────────────────────────────────────────────────
  {
    // 读 — 产出"图 + 代码", 不改用户正文; 图落在用户自己的 viz 产物目录里
    //   形态对齐 server.ts 的 POST /api/editor/v1/chart-code(那边有 requireUser, 不能用 fetch)
    name: "editor_chart_code", label: "图表代码生成", risk: "safe",
    description: "按描述生成论文图表: 流程图/思维导图(mermaid, 直接返回图代码) 或 柱状图/折线图/饼图(matplotlib, 出图并返回图片地址)。可带 CSV 数据与列名, 让模型按真实列画",
    params: {
      description: { type: "string", required: true, desc: "图表需求描述(如 按年份画农村居民收入的柱状图, 三组对比)" },
      chart_type: { type: "string", desc: "mermaid_flowchart(流程图) / mermaid_mindmap(思维导图) / echarts_bar(柱状, 默认) / echarts_line(折线) / echarts_pie(饼)" },
      csv: { type: "string", desc: "数据 CSV 文本(带表头; 不给则模型自拟示意数据并在标签里标注)" },
      columns: { type: "string", desc: "列名, 逗号分隔且**必须与 CSV 表头一致**(如 year,gdp,region)。给了 CSV 就要给列名" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      // 出图产物按用户目录隔离(renderChart 用 userId 落盘), 没身份就别跑
      if (!uid) return NO_USER;
      const description = String(a.description ?? "").trim();
      if (!description) return "（需要 description: 图表需求描述）";
      const chartType = String(a.chart_type ?? "echarts_bar").trim();
      const csv = String(a.csv ?? "").trim();
      const cols = String(a.columns ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (csv && !cols.length) return "（带了 csv 就必须给 columns: 列名逗号分隔, 且与表头逐字一致 — 否则模型会猜列名并 KeyError）";

      const [{ getLlmEndpoint, fetchLlm }, { getRoleModel }] = await Promise.all([
        import("../ai/llm-common.js"), import("./llm-model-registry.js"),
      ]);
      const ep = getLlmEndpoint({ model: getRoleModel("reason") });
      // 数据块与提示词**照抄** server.ts:11405-11422 —— 那几句"不要重新创建 df/ax、
      //   不要 pd.read_csv"是踩过 KeyError/FileNotFoundError 之后才写下的, 不能省。
      const dataBlock = csv && cols.length
        ? `【数据列名(必须原样使用, 不得改写或翻译)】${cols.join(", ")}
【数据前几行样例(仅用于理解列含义, 不要在代码里硬编码这些值)】
${csv.split(/\r?\n/).slice(0, 6).join("\n")}
【数据规模】共 ${Math.max(0, csv.split(/\r?\n/).filter((l) => l.trim()).length - 1)} 行

【运行环境(严格遵守, 否则报错)】
代码运行时 df 与 ax 已由宿主准备好, 不要重新创建:
  - 不要 import matplotlib.pyplot / pandas, 不要 plt.subplots(), 不要 pd.read_csv()
  - 绝对不要给 DATA_CSV 赋值(宿主已注入正确路径, 覆盖它会导致找不到文件)
  - 直接用 df 取列(如 df['${cols[1] ?? cols[0]}']), 用 ax 画图(ax.bar / ax.plot / ax.scatter ...)
  - 中文字符串直接写在标签/图例里(python 字符串), 列名保持英文原样`
        : `【数据】本次无数据文件 —— 不要写 pd.read_csv, 也不要引用 df。
宿主已准备好 ax, 请直接用 ax 画图, 数值用示例数据(自拟并在标签中标注为"示意")。`;
      const typeHint = chartType.startsWith("mermaid")
        ? `图表形式: ${chartType === "mermaid_mindmap" ? "思维导图" : "流程图"}(用 graph TD / mindmap 语法, 本类型不需要数据)`
        : `图表形式: matplotlib 代码(用户选的类型 ${chartType} 仅作参考, 以需求描述为准)`;

      const res = await fetchLlm({
        url: ep.url, key: ep.key, model: ep.model,
        messages: [{
          role: "user", content: `你是科研绘图专家。按需求生成绘图代码, 输出 JSON:{"code":"...","title":"图表标题"}

${typeHint}
${dataBlock}

需求: ${description.slice(0, 800)}`,
        }],
        temperature: 0.4, maxTokens: 4000, timeoutMs: 240_000,
        ledger: { endpoint: "editor-chart", userId: uid, context: `chart:${chartType}` },
      });
      const text = res?.text ?? "";
      let code = "";
      try {
        code = String((JSON.parse(text.replace(/```json|```/g, "").trim()) as any)?.code ?? "");
      } catch { /* 解析失败 → 下面统一报"未生成代码" */ }
      if (!code) return "（AI 未能生成图代码 — 把需求写得更具体些再试, 或直接说明要画什么字段）";

      // mermaid 是前端直接渲染的图代码, 不过 python runner(与 server 同分支)
      if (chartType.startsWith("mermaid")) {
        /**
         * ⚠ 实测(2026-09-29): 这条分支**从端点抄来的提示词有缺陷** —— 提示里只写了
         *   "用 graph TD / mindmap 语法", 没说"不要写 matplotlib", 模型照样吐 python。
         *   端点那边只是把代码原样返回给前端渲染, 写错就渲染不出来; 这里的后果更糟:
         *   我会把它套进 ```mermaid 代码块**当成流程图**返回给对话, 而它根本不是。
         *   所以我加一道**形状判据**: 认不出 mermaid 关键字就如实说"这其实是代码",
         *   而不是把它伪装成图。
         */
        const looksMermaid = /^\s*(graph|flowchart|mindmap|sequenceDiagram|classDiagram|erDiagram|stateDiagram|journey|gantt|pie|timeline)\b/m.test(code);
        if (!looksMermaid) {
          return `【生成的其实是绘图代码，不是 ${chartType === "mermaid_mindmap" ? "思维导图" : "流程图"}】\n模型没按 mermaid 语法出图（这是已知的提示词弱约束）。可用的是下面这段代码:\n\`\`\`python\n${code.slice(0, 2000)}\n\`\`\`\n要真出图: 用 editor_chart_code 传 chart_type=echarts_bar 让它按既有那条 python 通道走。`;
        }
        return `【图代码·${chartType === "mermaid_mindmap" ? "思维导图" : "流程图"}】\n\`\`\`mermaid\n${code.slice(0, 4000)}\n\`\`\`\n（把这段贴进编辑器/AI 面板的图表区即可渲染）`;
      }
      const { renderChart } = await import("./viz-exec-service.js");
      const { withPoints, InsufficientPointsError } = await import("./points-gate.js");
      const { randomUUID } = await import("node:crypto");
      try {
        // 积分闸门与端点同一口径(viz:chart): 冻结→渲染→成功核销/失败归还
        const rendered = await withPoints(uid, "viz:chart", randomUUID(), () =>
          renderChart(uid, code, csv || undefined, csv ? cols : []));
        if (!rendered.ok) return `（渲染失败: ${String(rendered.error ?? "").slice(0, 250)}）\n生成的代码:\n\`\`\`python\n${code.slice(0, 800)}\n\`\`\``;
        return `【图表已生成】${csv && cols.length ? "使用真实数据" : "示意数据"}\n![图表](${vizFileUrl(rendered.pngRel)})\nSVG(可编辑): ${vizFileUrl(rendered.svgRel)}\n（图片需登录后查看; 代码 ${code.length} 字符）`;
      } catch (e: any) {
        if (e instanceof InsufficientPointsError) return `（积分不足, 未出图: ${e.message}）`;
        throw e;
      }
    }),
  },
  {
    // 读 — 生成的 .docx 落在数据根供下载, 不改任何文档
    name: "editor_export_docx", label: "导出 Word", risk: "safe",
    description: "把「学术文本工作台」的一篇论文导出为 Word(.docx): 走 python-docx 通道, 支持目标体例的行距版式与参考文献块。返回可下载地址",
    params: {
      docId: { type: "string", desc: "文档 id; 省略则取最近更新的一篇" },
      fontName: { type: "string", desc: "正文字体(默认 SimSun)" },
      fontSize: { type: "number", desc: "正文字号 pt(默认由 python 侧定)" },
      formatTarget: { type: "string", desc: "目标体例: 期刊论文 / 学位论文 / 党校期刊 / 高校学报(决定行距版式; 不给则 1.5 倍行距)" },
      references: { type: "string", desc: "参考文献块文本(逐条一行; 给了就写进文档末尾)" },
      referencesNeedsManual: { type: "boolean", desc: "参考文献著录不全, 需人工补录(会在文档里显式提醒)" },
      declarations: { type: "string", desc: "投稿声明 JSON 对象, 如 {\"作者贡献\":\"...\",\"基金\":\"...\",\"利益冲突\":\"...\"}" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const r = await resolveDoc(uid, a.docId);
      if ("error" in r) return r.error;
      const title = String(r.doc.title ?? "").trim() || "未命名学术文档";
      const body = plainText(r.doc.content);
      if (!body.trim()) return `（《${title}》是空文档 — 没有可导出的正文）`;

      /**
       * ⚠ 这里与**编辑器面板的"导出 Word"不是同一段拼装代码**:
       *   前端 EditorView.vue 是按 TipTap 的标题层级拆成"骨架 + 正文"两段式 nodes,
       *   而工具侧只拿到落库的 content 字符串(没有编辑器实例)。所以这里把正文视作
       *   单节(一个 level-1 块)交给导出 —— **标题层级、粗斜体、列表、表格都会降级/丢失**。
       *   这是已知限制, 不假装保真: 要保结构请让用户在编辑器里点导出。
       *   (前端那条路同样降级纯文本, 见 EditorView.vue 的注释; 区别只在于它至少保住了标题层级。)
       */
      const nodes = [{ id: "editor-doc", title, level: 1, content: body, children: [] as unknown[] }];

      // 体例四档: 取值真源在 exportOutlineDocx 内部的 LAYOUT 表(paper-outline-service.ts:472,
      // 函数内局部常量, 未导出)。所以这里**不做闸门**: 认不出就照原样传下去 + 提示一句,
      // 免得将来后端加第五档时这个工具先把合法值拒了。
      const KNOWN_TARGETS = ["期刊论文", "学位论文", "党校期刊", "高校学报"];
      const formatTarget = String(a.formatTarget ?? "").trim();
      const targetWarn = formatTarget && !KNOWN_TARGETS.includes(formatTarget)
        ? `\n⚠ 体例「${formatTarget}」不在已知四档(${KNOWN_TARGETS.join("/")})内, 后端会退回默认 1.5 倍行距 —— 请核对。` : "";

      let declarations: Record<string, string> | undefined;
      const declRaw = String(a.declarations ?? "").trim();
      if (declRaw) {
        try {
          const parsed = JSON.parse(declRaw) as Record<string, unknown>;
          declarations = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
        } catch {
          return "（declarations 需为 JSON 对象, 如 {\"作者贡献\":\"...\"}）";
        }
      }

      const { exportOutlineDocx } = await import("./paper-outline-service.js");
      const refs = String(a.references ?? "").trim();
      const out = await exportOutlineDocx({
        paperTitle: title,
        nodes: nodes as never[],
        fontName: String(a.fontName ?? "").trim() || undefined,
        fontSize: Number(a.fontSize) > 0 ? Number(a.fontSize) : undefined,
        formatTarget: (formatTarget || undefined) as never,
        references: refs ? { text: refs, needsManual: a.referencesNeedsManual === true, sources: [] } : undefined,
        declarations,
      });
      if (!out.ok || !out.base64) return `（导出失败: ${String(out.error ?? "无输出").slice(0, 250)}）`;

      /**
       * 落盘到与 /api/empirical/reports/:file 同一条可下载通道(它读 blob-store 的
       * `empirical/reports/<单层文件名>`, 走对象存储, 多副本也能下)。
       * 工具结果里**只回一句位置**: 一份 docx 的 base64 十几万字符, 塞进对话既烧 token
       * 也没法用(agent 上下文不是下载器)。
       */
      const { putObject } = await import("./blob-store.js");
      const { randomUUID } = await import("node:crypto");
      const fileName = `editor-docx-${Date.now()}-${randomUUID().slice(0, 8)}.docx`;
      const buf = Buffer.from(out.base64, "base64");
      await putObject(`empirical/reports/${fileName}`, buf);
      return `【Word 已导出】《${title}》${body.replace(/\s/g, "").length} 字 · ${Math.round(buf.length / 1024)} KB\n下载: /api/empirical/reports/${fileName}（需登录）${targetWarn}\n已知限制: 标题层级/富文本格式会降级为纯文本（工具侧拿不到编辑器结构, 与面板导出不同）${refs ? "" : "\n提示: 未传 references, 文档末尾没有参考文献块"}`;
    }),
  },
  {
    // 读 — 只看当前模型配置
    name: "view_editor_model", label: "学术写作模型查看", risk: "safe",
    description: "查看「学术文本工作台」AI 当前用的模型(editor 角色)与可切换的模型清单(含各模型密钥是否已配置)",
    params: {},
    run: async () => safeCall(async () => {
      const reg = await import("./llm-model-registry.js");
      const current = reg.getRoleModel("editor");
      const usable = reg.LLM_MODEL_REGISTRY.filter((m) => reg.isModelUsable(m.id));
      const lines = reg.LLM_MODEL_REGISTRY.map((m) => {
        const ok = reg.isModelUsable(m.id);
        return `${m.id === current ? "▶ " : "  "}${m.id} — ${m.label} · ${m.provider}${ok ? "" : `（密钥未配置: ${reg.getProviderEndpoint(m.provider).keyEnv}）`}${m.roles.includes("editor") ? "" : " [未声明 editor 角色]"}`;
      });
      return `【学术写作模型】当前: ${current}\n可切换（${usable.length}/${reg.LLM_MODEL_REGISTRY.length} 个密钥已配）:\n${lines.join("\n")}\n\n改: editor_set_model（全局配置, 影响所有用户的编辑器 AI）`;
    }),
  },
  {
    // 写 — **改的是全局配置**(agent_settings.llm_roles, 服务重启后仍生效), 而且影响
    //   所有人的编辑器 AI。这是我把它放 review 的唯一理由 —— 它不属于"某个用户的文档",
    //   改错了没有"回档"按钮(只能再切一次)。接线者若认为该由 manager 角色把守,
    //   登记 TOOL_MIN_ROLE 时按这条判断。
    name: "editor_set_model", label: "切换学术写作模型", risk: "review",
    description: "切换「学术文本工作台」AI 用的模型(editor 角色, 全局生效并持久化, 不影响推理链)。需人工审批",
    params: {
      modelId: { type: "string", required: true, desc: "模型 id(用 view_editor_model 看可选项; 密钥未配置的会被拒)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return NO_USER;
      const reg = await import("./llm-model-registry.js");
      const modelId = String(a.modelId ?? "").trim();
      if (!modelId) return "（需要 modelId）";
      const opt = reg.findModelOption(modelId);
      if (!opt) return `（未知模型: ${modelId} — 用 view_editor_model 看可选项）`;
      // 与 server.ts 的 PUT /ai/model 同一条校验: 密钥没配的模型切过去必然失败, 直接拒
      if (!reg.isModelUsable(modelId)) {
        return `（${opt.label} 的密钥未配置(${reg.getProviderEndpoint(opt.provider).keyEnv}), 无法使用）`;
      }
      reg.setRoleModel("editor", modelId);
      // 持久化: setRoleModel 只改内存, 服务重启就回默认值(server.ts:11294 的
      // saveModelSelection 就是为这个加的) —— 少了这一步, 切换会"看起来成功然后自己变回去"。
      await (await import("./agent-settings.js")).setAgentSetting("llm_roles", {
        modelMap: reg.getRoleModelMap(), editorSet: reg.isEditorModelSet(),
      });
      return `【已切换】学术写作模型 → ${opt.label}（${modelId}）\n已持久化; 全局生效, 只影响编辑器 AI, 不影响推理链。`;
    }),
  },
];

// vim: set ts=2 sw=2 et:
