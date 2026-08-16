// add-contextual-prefix.ts — P1-1 上下文感知检索：为 chunk 生成上下文前缀 + 重建 embedding
// 2026-08-12 落地：索引期前缀锚定，预期提升 A2 (context_recall/precision)
// 用法: npx tsx scripts/add-contextual-prefix.ts
// 断点续传：progress 文件记录已处理 chunk id；失败重试；幂等（前缀已生成跳过）
import { pool } from "../src/db/pool.js";
import { toVectorLiteral } from "../src/db/vector.js";
import { embeddingClient } from "../src/ai/embedding-client.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import "dotenv/config";

const PROGRESS_FILE = "SAG_ROOT/data/contextual-prefix-progress.json";
const PREFIX_MARKER = "[节选自";
const BATCH_SIZE = 10;          // 每批 10 个 chunk（LLM 前缀生成 + embedding）
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? "";

/** 直接调 DeepSeek 生成上下文前缀（脚本独立，不依赖 llmClient 内部 settings） */
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
  const clean = text.replace(/^["']|["']$/g, "").replace(/\n/g, " ");
  if (!clean.startsWith("节选自")) return `节选自《${docTitle}》${heading}，${clean}`;
  return clean;
}

interface ChunkRow {
  id: string;
  document_id: string | null;
  heading: string | null;
  content: string;
}

async function main() {
  // 1. 断点续传：读进度
  let done = new Set<string>();
  if (existsSync(PROGRESS_FILE)) {
    const p = JSON.parse(readFileSync(PROGRESS_FILE, "utf-8"));
    done = new Set(p.done ?? []);
    console.log(`恢复进度: ${done.size} 个 chunk 已处理`);
  }

  // 2. 取全部 chunk（带文档标题）
  const chunksR = await pool.query<ChunkRow & { doc_title: string | null }>(`
    select c.id, c.document_id, c.heading, c.content, d.title as doc_title
    from source_chunks c
    left join documents d on d.id = c.document_id
    where c.content is not null and length(c.content) > 10
    order by c.created_at
  `);
  const chunks = chunksR.rows;
  console.log(`总 chunk: ${chunks.length}, 已处理: ${done.size}`);

  let processed = done.size;
  let failed = 0;
  const allDone = [...done];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    // 批内并行处理（2026-08-12：串行 60h → 并行 ~6h）
    await Promise.all(batch.map(async (chunk) => {
      if (done.has(chunk.id)) return;

      // 3. LLM 生成上下文前缀（verify 角色，flash 级）
      const docTitle = chunk.doc_title ?? "未命名文档";
      const heading = chunk.heading && chunk.heading !== "Introduction" && chunk.heading.trim().length > 1
        ? `"${chunk.heading.trim().slice(0, 60)}"`
        : "全文";
      const contentPreview = chunk.content.slice(0, 300);

      let prefix = "";
      try {
        prefix = await generatePrefix(docTitle, heading, contentPreview);
        if (prefix.length > 200) prefix = prefix.slice(0, 200);
      } catch (e) {
        // LLM 失败 fallback：用标题+章节拼接（不阻塞）
        prefix = `节选自《${docTitle}》${heading}`;
        failed++;
      }

      // 4. 拼接前缀 + 重建 embedding
      const augmented = `${PREFIX_MARKER}${prefix}]\n${chunk.content}`;
      try {
        const embedding = await embeddingClient.generate(augmented);
        // 覆盖 embedding（保留 content 原文在 documents.content 可回滚）
        await pool.query(
          `update source_chunks
           set embedding = $2::vector,
               metadata = (metadata::jsonb) || jsonb_build_object('contextualPrefix', $3::text)
           where id = $1`,
          [chunk.id, toVectorLiteral(embedding), prefix]
        );
        processed++;
        // V390修复: 仅在 embedding 成功后标记 done（失败不标记, 断点续传会重试 — 原失败也标记导致永久缺失）
        allDone.push(chunk.id);
        done.add(chunk.id);
      } catch (e) {
        failed++;
        console.log(`  embedding 失败 [${chunk.id.slice(0, 8)}]: ${(e as Error).message.slice(0, 60)}`);
      }
    }));  // Promise.all 闭合

    // 5. 批次进度落盘（断点续传）
    writeFileSync(PROGRESS_FILE, JSON.stringify({ done: allDone }));
    if (processed % 20 < BATCH_SIZE) {
      console.log(`  进度: ${processed}/${chunks.length} (失败 ${failed})`);
    }
  }

  writeFileSync(PROGRESS_FILE, JSON.stringify({ done: allDone }));
  console.log(`\n=== 完成 ===`);
  console.log(`处理: ${processed}/${chunks.length}, 失败: ${failed}`);
  console.log(`前缀示例: ${PREFIX_MARKER}...`);
  await pool.end();
}

main().catch((e) => {
  console.error("P1-1 失败:", e);
  process.exit(1);
});
