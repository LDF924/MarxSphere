// backup-now.ts — CLI 一键备份(验证产物)
// 用法: npx tsx scripts/backup-now.ts [--pg-only]
// 产物: backups/sagbak_*.sagbak/(manifest.json + pg_data.sql + schema.sql [+ neo4j_*.json])
import { createBackup } from "../src/services/backup-service.js";
import { pool } from "../src/db/pool.js";

async function main() {
  const pgOnly = process.argv.includes("--pg-only");
  console.log(`开始备份(includeGraphs=${!pgOnly})...`);
  const backup = await createBackup({ includeGraphs: !pgOnly });
  console.log("✅ 备份完成:");
  console.log(`  名称: ${backup.name}`);
  console.log(`  路径: ${backup.path}`);
  console.log(`  大小: ${(backup.size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  数据统计: ${JSON.stringify(backup.manifest?.counts ?? {})}`);
  const warnings = backup.manifest?.warnings ?? [];
  if (warnings.length > 0) {
    console.log("  警告:");
    for (const w of warnings) console.log(`    ⚠ ${w}`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error("备份失败:", e.message);
  process.exit(1);
});
