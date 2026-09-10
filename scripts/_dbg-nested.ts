import { pool } from "../src/db/pool.js";

const r = await pool.query(`select id, title, content from documents_v2 where id=$1`,
  ["4156f03c-b2fe-4d70-af39-bd5e89b95abb"]);
const doc = JSON.parse(r.rows[0].content);

const texts: any[] = [];
const walk = (n: any) => {
  if (!n || typeof n !== "object") return;
  if (n.type === "text") texts.push(n);
  if (Array.isArray(n.content)) n.content.forEach(walk);
};
walk(doc);
console.log("文本节点数:", texts.length);
for (const [i, t] of texts.entries()) {
  const s = String(t.text ?? "");
  console.log(`\n[节点${i}] 长度=${s.length}`);
  console.log("  开头:", JSON.stringify(s.slice(0, 50)));
  console.log("  结尾:", JSON.stringify(s.slice(-50)));
  try { const j = JSON.parse(s.trim()); console.log("  parse OK, type =", j?.type); }
  catch (e) { console.log("  parse 失败:", String((e as Error).message).slice(0, 160)); }
}
process.exit(0);
