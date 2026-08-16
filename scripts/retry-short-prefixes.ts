// retry-short-prefixes.ts — 重跑短前缀（fallback 标题拼接版 → LLM 简述）
// 2026-08-12：P1-1 完成后 146 个前缀过短，用 LLM 补简述
import { pool } from "../src/db/pool.js";
import { toVectorLiteral } from "../src/db/vector.js";
import { embeddingClient } from "../src/ai/embedding-client.js";
import "dotenv/config";

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? "";

async function generatePrefix(docTitle: string, heading: string, contentPreview: string): Promise<string> {
  const system = "你是一个检索增强助手。为给定的论文片段生成一个 30-80 字的上下文前缀，格式以『节选自《论文标题》章节标题』开头，然后简述本节主题。只输出前缀文本本身。";
  const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `论文标题: ${docTitle}\n章节: ${heading}\n片段开头: ${contentPreview}` }
      ],
      max_tokens: 200,
      temperature: 0.1
    })
  });
  const d = await r.json();
  const text = (d?.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("空前缀");
  return text.replace(/^["']|["']$/g, "").replace(/\n/g, " ");
}

async function main() {
  // 查短前缀 chunk（长度 < 25 = fallback 标题拼接）
  const r = await pool.query(`
    select c.id, c.document_id, c.heading, c.content, d.title as doc_title
    from source_chunks c
    left join documents d on d.id = c.document_id
    where c.metadata ? 'contextualPrefix' and length(c.metadata->>'contextualPrefix') < 25
  `);
  const chunks = r.rows;
  console.log(`短前缀 chunk: ${chunks.length}`);

  let ok = 0, fail = 0;
  for (const chunk of chunks) {
    const docTitle = chunk.doc_title ?? "未命名文档";
    const heading = chunk.heading && chunk.heading !== "Introduction" && chunk.heading.trim().length > 1
      ? chunk.heading.trim().slice(0, 60) : "全文";
    const contentPreview = chunk.content.slice(0, 300);
    try {
      const prefix = await generatePrefix(docTitle, heading, contentPreview);
      const augmented = `[节选自${prefix}]\n${chunk.content}`;
      const embedding = await embeddingClient.generate(augmented);
      await pool.query(
        `update source_chunks
         set embedding = $2::vector,
             metadata = (metadata::jsonb) || jsonb_build_object('contextualPrefix', $3::text)
         where id = $1`,
        [chunk.id, toVectorLiteral(embedding), prefix]
      );
      ok++;
    } catch {
      fail++;
    }
  }
  console.log(`完成: ${ok} 成功, ${fail} 失败`);
  await pool.end();
}

main().catch((e) => { console.error("失败:", e); process.exit(1); });
