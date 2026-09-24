// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// project-export-service.ts — 项目整包导出(V425 A3)
//
// 由来: 写作舱已有**单件**导出(合稿页的 Word/PPT/Markdown/HTML), 但没有**整包** ——
//   用户做完一个项目, 手上能拿走的只有最终那一篇; 章节、素材、版本沿革、研究信息全部留在库里。
//   换机器/交接/归档/答辩留底这几种场景要的恰恰是"我当时做了什么", 而不只是"最后写了什么"。
//
// 为什么**不压缩成 tar 而用 zip**: zip 是 Windows 资源管理器双击可开、微信/邮件不会被拦的格式,
//   而目标用户是社科研究者, 不是开发者。为此自己写一个最小的 zip 写入器(见 zipStore),
//   只用 node:zlib 的 deflateRaw —— 不引第三方包(本仓依赖面已经很大, 一个纯格式问题不值得再加一个)。
//
// 内容取舍:
//   · **正文、章节、素材、版本沿革、研究信息** 五块齐全 —— 每一块都是"用户自己做出来的东西";
//   · 素材里上传的**二进制文件不打包**: 那些文件存在 uploads/ 且路径分散, 复制整棵树既有权限风险
//     也容易把无关文件带进去。所以素材条目只出**文本形态**(含文件名与来源链接), 并在 README 里
//     写清楚"附件本身未包含"—— 宁可少给也不能让用户以为包里有。
//   · 不含任何服务端凭据、日志、其它项目的数据。
import { deflateRawSync } from "node:zlib";
import { pool } from "../db/pool.js";
import { getWorkbenchSnapshot } from "./chapter-skill-service.js";
import { listMaterials } from "./research-materials-service.js";
import { listVersions, listNodeHistory } from "./research-pipeline-service.js";
import { exportOutlineDocx, type OutlineNode } from "./paper-outline-service.js";

/**
 * workbench 快照的形状。**全部 optional** —— 快照本来就是"客户端提交的视图",
 *   项目刚建、某个阶段没跑过时这些键都不在。写成必填会让每个访问点都要先做存在性判断,
 *   写死成具体类型又会在后端加字段时静默谎报。这里只声明**本文件真的会读的那几个键**。
 */
interface WbSnapshot {
  sections?: Array<Record<string, unknown>>;
  input?: Record<string, unknown>;
  mergedTitle?: string;
  mergedAbstract?: string;
  mergedKeywords?: string;
  mergedFullText?: string;
  mergedReferences?: string;
}

// ── 最小 zip 写入器 ──
// 只支持 deflate 与 store 两种方式; 不做 zip64(整包是纯文本, 上限按几十 MB 估, 远不到 4GB)。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

type Entry = { name: string; data: Buffer };

/** DOS 时间/日期(1980 基准) —— zip 头里是本地时间, 不带时区 */
function dosStamp(d: Date): { time: number; date: number } {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

/**
 * 组装 zip。文件名统一 UTF-8 并置 bit 11(EFS) —— 否则中文名在 Windows 资源管理器里是乱码。
 * 目录条目不单列: 解压器按路径自动建目录。
 */
function buildZip(entries: Entry[], now = new Date()): Buffer {
  const { time, date } = dosStamp(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const raw = e.data.length;
    const deflated = deflateRawSync(e.data);
    // 压不小就存原文 —— 短文件 deflate 后往往更大
    const useDeflate = deflated.length < raw;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0x0800, 6);        // flags: UTF-8 名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);            // version made by
    ch.writeUInt16LE(20, 6);            // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);            // extra len
    ch.writeUInt16LE(0, 32);            // comment len
    ch.writeUInt16LE(0, 34);            // disk
    ch.writeUInt16LE(0, 36);            // internal attrs
    ch.writeUInt32LE(0, 38);            // external attrs
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

// ── 文件名与内容工具 ──
/**
 * 章节标题直接当文件名会炸 —— 三类字符各自的问题都不一样:
 *   · Windows 非法字符 \ / : * ? " < > |  → 建不出文件;
 *   · 结尾的空格与点 → Windows 会静默截掉, 包内路径与用户所见对不上;
 *   · 开头的点 → 解压后是隐藏文件, 用户以为丢了。
 * 统一换成下划线, 并留兜底名, 保证**永远能建出文件**。
 */
function safeName(s: string, fallback: string): string {
  const t = String(s ?? "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[\s.]+$/g, "")
    .trim();
  return (t || fallback).slice(0, 60);
}
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * 换算成"人话"的大小。
 *
 * ⚠ 必须按**已解码文本的字节数**(Buffer.byteLength), 不能按 JS 字符串的 .length ——
 *   后者是 UTF-16 码元数, 一个汉字算 1 而不是 3, 报出来的体积会系统性偏小
 *   (实测一篇 10 万字的论文会被显示成 33KB)。
 */
function humanSize(s: string): string {
  const n = Buffer.byteLength(String(s ?? ""), "utf8");
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} 字节`;
}
/** 已知字节数时的同一个换算(如已生成的 docx buffer) */
function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} 字节`;
}
/**
 * 字数。与页面口径**故意不同**: 这里只做粗略体量提示, 按"汉字 1 字 + 连续拉丁词 1 词"计 ——
 * 纯 .length 会把一段英文报成几百"字", 与用户对"字数"的直觉差一个数量级。
 * 精确字数各页有各页的算法(合稿页是去空白字符数), 这里不冒充那个数。
 */
function wordCount(s: string): number {
  const t = String(s ?? "");
  const cjk = (t.match(/[一-龥]/g) ?? []).length;
  const latin = (t.match(/[A-Za-z]+/g) ?? []).length;
  const digits = (t.match(/\d+/g) ?? []).length;
  return cjk + latin + digits;
}

function inputSection(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const rows: Array<[string, string]> = [
    ["标题", String(i.title ?? "")],
    ["大纲", String(i.outline ?? "")],
    ["目标字数", i.totalWordCount ? String(i.totalWordCount) : ""],
    ["研究方法", String(i.researchMethod ?? "")],
    ["研究要求", String(i.requirements ?? "")],
  ];
  const clarify = i.clarifyAnswers as Record<string, string> | undefined;
  const lines = [`# 研究信息`, ""];
  for (const [k, v] of rows) if (v) lines.push(`- **${k}**：${v}`);
  if (clarify && Object.keys(clarify).length) {
    lines.push("", "## 澄清问答", "");
    for (const [q, a] of Object.entries(clarify)) if (a) lines.push(`- **${q}**：${a}`);
  }
  const files = i.sampleFiles as Array<{ name?: string; size?: number }> | undefined;
  if (Array.isArray(files) && files.length) {
    lines.push("", "## 参考样本(仅文件名, 原文件未包含在包内)", "");
    for (const f of files) lines.push(`- ${f?.name ?? "未命名"}${f?.size ? ` (${f.size} 字节)` : ""}`);
  }
  return lines.join("\n") + "\n";
}

function materialsSection(mats: Array<Record<string, unknown>>): string {
  const KIND: Record<string, string> = {
    note: "笔记", citation: "文献", data_result: "数据结果", figure: "图表",
    file: "文件", theory: "理论", table: "表格",
  };
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const m of mats) {
    const k = String(m.kind ?? "note");
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  const lines = [`# 素材清单`, "", `共 ${mats.length} 条。**上传的附件原文件未包含在包内**, 此处是文本内容与来源信息。`, ""];
  for (const [kind, arr] of groups) {
    lines.push(`## ${KIND[kind] ?? kind}（${arr.length} 条）`, "");
    for (const m of arr) {
      // ⚠ 字段名以 listMaterials 的 mapMaterialRow 输出为准(camelCase): 它把 source_type/content_md/
      //   references_json 分别映成 sourceType/contentMd/references。照数据库列名读会全空 ——
      //   素材清单里会出现"每条都没内容"的假象(本仓在别处踩过同一个坑)。
      lines.push(`### ${String(m.title ?? "未命名")}`, "");
      const refs = [m.sourceType, m.sourceUrl, m.analysisMethod].filter(Boolean).map(String);
      if (refs.length) lines.push(`> 来源/方法：${refs.join(" · ")}`, "");
      const caption = String(m.caption ?? "").trim();
      if (caption) lines.push(caption, "");
      const body = String(m.contentMd ?? m.summary ?? "").trim();
      lines.push(body || "_(该条目没有文本内容)_", "");
      const refList = m.references;
      if (Array.isArray(refList) && refList.length) {
        lines.push("关联文献：", "");
        for (const r of refList) {
          const o = (r ?? {}) as Record<string, unknown>;
          lines.push(`- ${String(o.title ?? o.text ?? JSON.stringify(r))}`);
        }
        lines.push("");
      }
    }
  }
  return lines.join("\n") + "\n";
}

function versionsSection(
  versions: Array<{ version: number; label: string; status: string; created_at: unknown }>,
  histories: Array<{ nodeKey: string; items: Array<{ version: number; by_role: string; note: string; created_at: unknown }> }>,
): string {
  const LABEL: Record<string, string> = {
    phase2_architecture: "框架设计确认", phase3_materials: "素材版本",
    phase4_text: "正文生成完成", phase5_final: "终稿", phase5_revision: "修订稿",
  };
  const ts = (v: unknown) => (v ? new Date(String(v)).toLocaleString("zh-CN") : "");
  const lines = ["# 版本沿革", "", "## 阶段版本", ""];
  if (!versions.length) lines.push("_(没有发布过阶段版本)_");
  else {
    lines.push("| 版本 | 阶段 | 状态 | 时间 |", "| --- | --- | --- | --- |");
    for (const v of versions) lines.push(`| v${v.version} | ${LABEL[v.label] ?? v.label} | ${v.status} | ${ts(v.created_at)} |`);
  }
  lines.push("", "## 节点改动历史", "");
  for (const h of histories) {
    if (!h.items.length) continue;
    lines.push(`### ${h.nodeKey}（${h.items.length} 次）`, "");
    for (const it of h.items) lines.push(`- v${it.version} · ${it.by_role} · ${ts(it.created_at)}${it.note ? ` · ${it.note}` : ""}`);
    lines.push("");
  }
  if (!histories.some((h) => h.items.length)) lines.push("_(没有节点历史: 节点第一次写入不产生历史, 从第二次改动起才有记录)_");
  return lines.join("\n") + "\n";
}

/** 扁平章节表 → 大纲树(与合稿页 buildOutlineTree 同一套规则: 先按 order 排, 再挂父子) */
function buildTree(sections: Array<Record<string, unknown>>): OutlineNode[] {
  const ordered = [...sections].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
  const byId = new Map<string, OutlineNode & { id: string; parentId?: string | null }>();
  for (const s of ordered) {
    byId.set(String(s.id ?? ""), {
      id: String(s.id ?? ""), title: String(s.title ?? "未命名章节"),
      level: Number(s.level ?? 1), content: String(s.content ?? ""),
      parentId: (s.parentId as string | null | undefined) ?? null, children: [],
    });
  }
  const roots: OutlineNode[] = [];
  for (const s of ordered) {
    const node = byId.get(String(s.id ?? ""));
    if (!node) continue;
    const parent = node.parentId ? byId.get(String(node.parentId)) : null;
    if (parent) parent.children = [...(parent.children ?? []), node];
    else roots.push(node);
  }
  return roots;
}

/** 导出给单测用: zip 组装器自己写的格式代码, 必须能被**独立实现**读出来才算对 */
export const __testables = { buildZip, safeName, crc32 };

export interface BundleResult { ok: boolean; buffer?: Buffer; fileName?: string; error?: string; notes?: string[] }

/**
 * 打包整个项目。
 *
 * 每一块都**独立容错**: 某一块查不到(如 Word 生成依赖 Python 而机器上没装)不终止整包,
 * 而是把原因写进 README 的"未能包含"一节 —— 用户拿到的是"少了什么、为什么", 而不是一个 500。
 */
export async function exportProjectBundle(userId: string, projectId: string): Promise<BundleResult> {
  const proj = await pool.query(
    `select id, title, status, phase, phase_label, created_at, updated_at from research_projects where id=$1 and user_id=$2`,
    [projectId, userId]
  );
  if (!proj.rows.length) return { ok: false, error: "PROJECT_NOT_FOUND" };
  const p = proj.rows[0] as Record<string, unknown>;
  const title = String(p.title ?? "未命名研究");
  const notes: string[] = [];

  /**
   * ⚠ `getWorkbenchSnapshot` 返回的是**包装对象** `{snapshot, englishAbstract}`, 不是快照本身。
   *   直接当快照用会得到一个"什么键都没有"的对象 —— 读出来全是 undefined, 而导出**照样成功**,
   *   产物只是空的(实测: README 里写"正文体量 0 字 / 章节 0 个", 而库里明明有 2 章 800 字)。
   *   这类"读错一层、但不报错"是本仓反复出现的失效形态, 所以这里显式解包并留注释。
   */
  const wb = await getWorkbenchSnapshot(userId, projectId);
  const snap = ((wb?.snapshot ?? {}) as WbSnapshot);
  const sections = (snap.sections ?? []) as Array<Record<string, unknown>>;
  const mergedFull = String(snap.mergedFullText ?? "");
  const mergedTitle = String(snap.mergedTitle ?? "") || title;

  const entries: Entry[] = [];

  // ① 正文: 有合稿用合稿, 没有就把各章正文拼起来并**在标题里注明这是未合稿的拼装** ——
  //   两者内容差别很大(合稿经过语言优化与去 AI 味), 不加区分地当作"论文"会误导。
  const bodyParts: string[] = [`# ${mergedTitle}`, ""];
  const abs = String(snap.mergedAbstract ?? "").trim();
  const kws = String(snap.mergedKeywords ?? "").trim();
  if (abs) bodyParts.push("## 摘要", "", abs, "");
  if (kws) bodyParts.push(`**关键词**：${kws}`, "");
  if (mergedFull) {
    bodyParts.push(mergedFull, "");
  } else if (sections.length) {
    notes.push("正文未合稿：包内 `论文.md` 是各章正文的拼装稿，未经合稿的语言优化与格式统一。");
    bodyParts.push("> ⚠ 本项目尚未执行合稿，以下为各章正文的拼装。", "");
    for (const s of sections) {
      const c = String(s.content ?? "").trim();
      if (!c) continue;
      bodyParts.push(`${"#".repeat(Math.min(Number(s.level ?? 1) + 1, 6))} ${String(s.title ?? "")}`, "", c, "");
    }
  } else {
    notes.push("项目里还没有正文内容。");
  }
  const refs = String(snap.mergedReferences ?? "").trim();
  if (refs) bodyParts.push("## 参考文献", "", refs, "");
  entries.push({ name: "论文.md", data: Buffer.from(bodyParts.join("\n"), "utf8") });

  // ② 章节逐篇(便于单独取用某一章)
  let i = 0;
  for (const s of sections) {
    i++;
    const c = String(s.content ?? "").trim();
    if (!c) continue;
    const nm = `章节/${pad(i)}-${safeName(String(s.title ?? ""), "未命名")}.md`;
    entries.push({ name: nm, data: Buffer.from(`# ${String(s.title ?? "")}\n\n${c}\n`, "utf8") });
  }

  // ③ Word(走既有的 python-docx 生成器; 缺 python 时降级为提示, 不影响整包)
  if (sections.length) {
    try {
      const r = await exportOutlineDocx({
        paperTitle: mergedTitle,
        nodes: buildTree(sections),
        references: { text: refs, needsManual: !refs, sources: [] },
      });
      if (r.ok && r.base64) entries.push({ name: "论文.docx", data: Buffer.from(r.base64, "base64") });
      else notes.push(`Word 未能生成：${r.error ?? "导出器未返回内容"}`);
    } catch (e) {
      notes.push(`Word 未能生成：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ④ 素材
  const mats = await listMaterials(userId, projectId).catch(() => []) as Array<Record<string, unknown>>;
  entries.push({ name: "素材清单.md", data: Buffer.from(materialsSection(mats), "utf8") });

  // ⑤ 版本沿革(阶段版本 + 各节点改动历史)
  const versions = await listVersions(userId, projectId).catch(() => []);
  const NODE_KEYS = ["input", "sections", "materials", "finalize", "analysis"];
  const histories: Array<{ nodeKey: string; items: Array<{ version: number; by_role: string; note: string; created_at: unknown }> }> = [];
  for (const k of NODE_KEYS) {
    const items = await listNodeHistory(userId, projectId, k).catch(() => []);
    if (items.length) histories.push({ nodeKey: k, items });
  }
  entries.push({ name: "版本沿革.md", data: Buffer.from(versionsSection(versions, histories), "utf8") });

  // ⑥ 研究信息
  entries.push({ name: "研究信息.md", data: Buffer.from(inputSection(snap.input), "utf8") });

  // ⑦ README —— 说清楚**包是什么、里面有什么、没有什么**。
  //   不写这一段, 用户看到素材清单里只有文本会以为附件丢了。
  const docxEntry = entries.find((e) => e.name === "论文.docx");
  const chapCount = entries.filter((e) => e.name.startsWith("章节/")).length;
  const readme = [
    `# ${title}`, "",
    `导出时间：${new Date().toLocaleString("zh-CN")}`,
    `项目状态：${String(p.status ?? "")} · 阶段 ${Number(p.phase ?? 0)} ${String(p.phase_label ?? "")}`,
    // 体量与字数写在最前面 —— 接手/归档的人第一眼要知道"这是多大的东西、多少字"
    `正文体量：${wordCount(mergedFull || sections.map((s) => String(s.content ?? "")).join(""))} 字 / ${humanSize(mergedFull || sections.map((s) => String(s.content ?? "")).join(""))}（章节 ${sections.length} 个、素材 ${mats.length} 条、历史版本 ${versions.length} 个）`,
    "", "## 包内文件", "",
    "| 文件 | 内容 | 体量 |", "| --- | --- | --- |",
    `| \`论文.md\` | 标题/摘要/关键词/正文/参考文献 | ${humanSize(mergedFull || sections.map((s) => String(s.content ?? "")).join(""))} |`,
    docxEntry
      ? `| \`论文.docx\` | 按章节层级排版的可编辑 Word | ${humanBytes(docxEntry.data.length)} |`
      : "| _(无 `论文.docx`)_ | 未生成，原因见下 | — |",
    `| \`章节/\` | 每一章单独一个 Markdown 文件 | ${chapCount} 个文件 |`,
    `| \`素材清单.md\` | 全部素材的文本内容、来源与关联文献 | ${mats.length} 条 |`,
    `| \`版本沿革.md\` | 阶段版本表 + 各节点的逐次改动历史 | ${versions.length} 个阶段版本 |`,
    "| `研究信息.md` | 标题/大纲/方法/要求/澄清问答 | — |",
    "", "## 未包含", "",
    "- **上传的附件原文件**（PDF/Word/图片等）不在此包内，素材清单里保留其文件名与来源链接。",
    "- 平台侧的检索库、图谱数据不导出。",
    ...notes.map((n) => `- ${n}`),
    "",
  ].join("\n");
  // README 放最前, 双击解压第一眼就能看到
  entries.unshift({ name: "README.md", data: Buffer.from(readme, "utf8") });

  return {
    ok: true,
    buffer: buildZip(entries),
    fileName: `${safeName(title, "研究项目")}-整包.zip`,
    notes,
  };
}
