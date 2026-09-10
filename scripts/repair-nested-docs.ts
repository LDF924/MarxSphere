// 检测并(可选)修复 documents_v2 中"正文里嵌了 JSON"的文档
//
// 成因: 前端 tiptap 的 setContent 收到 JSON 字符串时按 HTML 解析, 把整段 JSON 当纯文本插进正文;
//       保存后正文里就多了一个"内容为另一篇 JSON 文档"的文本节点, 逐次开合层层嵌套。
// 损坏形态(两种):
//   A. 文本节点 = 完整的 JSON doc                      → 直接用内层 doc 替换整篇
//   B. 文本节点 = 完整 JSON doc + 追加的普通文字        → 解开后把追加文字接回末尾
//
// 用法: npx tsx --env-file=.env scripts/repair-nested-docs.ts          (dry-run)
//       npx tsx --env-file=.env scripts/repair-nested-docs.ts --apply  (备份后写回)
import { pool } from "../src/db/pool.js";
import { writeFileSync } from "node:fs";

/** 从字符串开头切出第一个括号配平的 JSON 对象(尊重字符串与转义) */
function leadingJsonPrefix(s: string): { json: string; rest: string } | null {
  const t = s.trimStart();
  if (!t.startsWith("{")) return null;
  let depth = 0, inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { json: t.slice(0, i + 1), rest: t.slice(i + 1) };
    }
  }
  return null;
}

/** 该文本节点是否是嵌套的 doc(含"JSON doc + 尾部文字"形态) */
function nestedDocOf(n: any): { doc: any; rest: string } | null {
  if (!n || n.type !== "text" || typeof n.text !== "string") return null;
  const pre = leadingJsonPrefix(n.text);
  if (!pre) return null;
  if (!/"type"\s*:\s*"doc"/.test(pre.json.slice(0, 60))) return null;
  try {
    const doc = JSON.parse(pre.json);
    if (doc && typeof doc === "object" && doc.type === "doc") return { doc, rest: pre.rest };
  } catch { /* 不是合法 JSON, 不算损坏点 */ }
  return null;
}

/** 文档里第一个"包裹整篇"的嵌套文本节点 */
function findWrapping(doc: any): { doc: any; rest: string } | null {
  const texts: any[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "text") texts.push(n);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(doc);
  for (const n of texts) {
    const hit = nestedDocOf(n);
    if (hit) return hit;
  }
  return null;
}

function countNested(doc: any): number {
  let n = 0;
  const walk = (x: any) => {
    if (!x || typeof x !== "object") return;
    if (x.type === "text") {
      const pre = typeof x.text === "string" ? leadingJsonPrefix(x.text) : null;
      if (pre && /"type"\s*:\s*"doc"/.test(pre.json.slice(0, 60))) n++;
    }
    if (Array.isArray(x.content)) x.content.forEach(walk);
  };
  walk(doc);
  return n;
}

/** 解开全部嵌套; 尾部追加文字作为新段落接回 */
function unwrapAll(doc: any): { doc: any; rounds: number; rests: string[] } {
  let cur = doc;
  const rests: string[] = [];
  let rounds = 0;
  for (; rounds < 10; rounds++) {
    const wrap = findWrapping(cur);
    if (!wrap) break;
    const tail = wrap.rest.trim();
    if (tail) rests.push(tail);
    cur = wrap.doc;
  }
  if (rests.length) {
    // 追加文字是用户在损坏后继续写的, 接回末尾(倒序恢复原始先后)
    const extra = rests.reverse().map((t) => ({
      type: "paragraph",
      content: [{ type: "text", text: t }],
    }));
    cur = { ...cur, content: [...(cur.content ?? []), ...extra] };
  }
  return { doc: cur, rounds, rests };
}

function plainText(doc: any): string {
  let out = "";
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "text" && typeof n.text === "string") out += n.text;
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(doc);
  return out;
}

const apply = process.argv.includes("--apply");
const r = await pool.query(
  `select id, title, content, length(content) as len, updated_at from documents_v2 order by updated_at desc`);

const backups: Array<{ id: string; title: string; content: string }> = [];
let bad = 0;

for (const row of r.rows) {
  let doc: any;
  try { doc = JSON.parse(row.content); } catch { continue; }
  const before = countNested(doc);
  if (!before) continue;
  bad++;

  const { doc: fixed, rounds, rests } = unwrapAll(doc);
  const after = countNested(fixed);
  const text = plainText(fixed);

  console.log(`\n[X] ${row.title}  ${row.len}B  ${new Date(row.updated_at).toISOString().slice(0, 16)}`);
  console.log(`    id=${row.id}`);
  console.log(`    嵌套 ${before} 处 → 解开 ${rounds} 层 → 剩余 ${after} 处`);
  if (rests.length) console.log(`    接回追加文字 ${rests.length} 段: ${rests.map((t) => t.slice(0, 30)).join(" | ")}`);
  console.log(`    修复后长度 ${JSON.stringify(fixed).length}B, 正文 ${text.length} 字`);
  console.log(`    正文开头: ${text.slice(0, 60)}`);

  if (apply && after === 0) {
    backups.push({ id: row.id, title: row.title, content: row.content });
    await pool.query(
      `update documents_v2 set content=$2, word_count=$3, updated_at=now() where id=$1`,
      [row.id, JSON.stringify(fixed), text.replace(/\s/g, "").length]);
    console.log(`    ✓ 已写回`);
  } else if (apply) {
    console.log(`    ✗ 仍有嵌套, 跳过(需人工检查)`);
  }
}

if (apply && backups.length) {
  const f = `data/repair-backup-${Date.now()}.json`;
  writeFileSync(f, JSON.stringify(backups, null, 2), "utf-8");
  console.log(`\n原内容已备份: ${f} (${backups.length} 篇)`);
}

console.log(`\n=== ${r.rows.length} 篇中 ${bad} 篇嵌套损坏 ${apply ? "(已修复)" : "(dry-run, 未改动)"} ===`);
process.exit(0);
