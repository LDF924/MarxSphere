/**
 * ingest-seed-corpus.ts — 种子语料一键入库
 *
 * 将 examples/seed-corpus/ 下的 50 篇文献（1化6 产物：original + 摘要/术语表/问答）
 * 批量写入 PG（pgvector 向量 + 词法检索），并抽取实体，供 SAG 四源检索体验。
 *
 * 用法:
 *   npx tsx examples/seed-corpus/ingest-seed-corpus.ts
 *
 * 前置:
 *   1. 数据库已启动（docker compose up -d，PG :5540）
 *   2. 服务未运行也可（直接连库）；若服务在跑，入库后重启 4173 使检索立即可见
 *
 * 说明:
 *   - 每篇论文取其 .original.md 正文（含标题/作者/摘要元数据）入库为独立 source
 *   - 摘要/术语表/问答作为 metadata 附加，保留 1化6 结构化信息
 *   - 幂等：相同 sourceId 重复执行会更新而非重复插入
 *   - 语料为评测金标数据集同源文献（evaluation/gold_dataset.json 对应 53 题）
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { ingestionService } from "../../src/services/ingestion-service.js";
import { closePool } from "../../src/db/pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname);

/** 从 frontmatter 中取 title（若无则回退文件名） */
function extractTitle(md: string, fallback: string): string {
  const m = md.match(/^---\ntitle:\s*(.+)\n/);
  return m ? m[1].replace(/<sub>.*?<\/sub>/g, "").trim() : fallback;
}

async function main(): Promise<void> {
  const roots = readdirSync(CORPUS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => join(CORPUS_DIR, e.name));

  console.log(`═`.repeat(60));
  console.log(`MarxSphere 种子语料入库 — 扫描 ${roots.length} 个分类目录`);
  console.log(`═`.repeat(60));

  let totalSources = 0;
  let totalChunks = 0;

  for (const root of roots) {
    const papers = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    console.log(`\n📁 ${root.split(/[\\/]/).pop()}（${papers.length} 篇）`);

    for (const paper of papers) {
      const dir = join(root, paper.name);
      const origFile = readdirSync(dir).find((f) => f.endsWith(".original.md"));
      if (!origFile) {
        console.log(`  ⚠️ 跳过 ${paper.name}（无 original.md）`);
        continue;
      }
      const content = readFileSync(join(dir, origFile), "utf8");
      const title = extractTitle(content, paper.name);

      // 附加 1化6 结构化信息到 metadata
      const metadata: Record<string, string> = {};
      for (const f of ["摘要.md", "术语表.md", "问答.md"]) {
        if (existsSync(join(dir, f))) {
          const key = f.replace(".md", "");
          metadata[key] = readFileSync(join(dir, f), "utf8").slice(0, 2000);
        }
      }

      const result = await ingestionService.ingestDocument({
        sourceId: `seed-${paper.name}`,
        title,
        content,
        metadata,
        extract: true,
      });

      totalSources += 1;
      totalChunks += result.chunkCount;
      console.log(`  ✅ ${title.slice(0, 42)} → ${result.chunkCount} chunks`);
    }
  }

  console.log(`\n═`.repeat(60));
  console.log(`完成：${totalSources} 篇 / ${totalChunks} chunks`);
  console.log(`接下来：npm run dev 后打开「Ask 检索」或「52 步推理」体验四源检索`);
  console.log(`评测金标 53 题与语料对应：evaluation/gold_dataset.json`);
  console.log(`═`.repeat(60));
}

main()
  .catch((err) => {
    console.error("入库失败:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
