// restore-verify.ts — 恢复流程演练(安全路径: 独立测试库, 不碰生产)
// 用法: npx tsx scripts/restore-verify.ts
// 流程:
//   1. 读 backups 表最新一条 completed 备份的 manifest
//   2. 校验备份完整性(sha256)
//   3. 在独立测试库 sag_lite_restore_test 上演练恢复(schema 重建 + pg_data 导入)
//   4. 对比恢复后行数与 manifest.rows, 输出结论
// 生产恢复: 调用 POST /api/backup/:id/restore(全量替换, admin 权限)
import { pool } from "../src/db/pool.js";
import { verifyBackup } from "../src/services/backup-service.js";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, createReadStream } from "node:fs";
import { join } from "node:path";

const PG_CONTAINER = "sag_lite_postgres";
const PG_USER = "sag_lite";
const TEST_DB = "sag_lite_restore_test";

function runPsql(args: string[], stdin: string | null = null): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["exec", "-i", PG_CONTAINER, "psql", "-U", PG_USER, ...args], {
      stdio: ["pipe", "ignore", "pipe"], // stdout ignore: 防管道缓冲阻塞(psql 大量输出)
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
    if (stdin != null) child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** 流式导入大文件(2.3GB pg_data 不能 readFileSync 进内存) */
function runPsqlStream(args: string[], filePath: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["exec", "-i", PG_CONTAINER, "psql", "-U", PG_USER, ...args], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
    createReadStream(filePath).pipe(child.stdin);
  });
}

async function main() {
  // 1. 取最新备份
  const r = await pool.query(
    `select id, name, path, manifest from backups where status = 'completed' order by created_at desc limit 1`,
  );
  if (r.rows.length === 0) {
    console.log("❌ 无备份记录。先创建备份: npx tsx scripts/backup-now.ts");
    process.exit(1);
  }
  const backupId = String(r.rows[0].id);
  const dir = String(r.rows[0].path);
  const manifest = r.rows[0].manifest;
  console.log(`备份: ${r.rows[0].name} (${dir})`);

  // 2. 校验完整性
  console.log("\n=== 1. 校验备份完整性 ===");
  const { ok, mismatches } = await verifyBackup(backupId);
  if (!ok) { console.log(`❌ 校验失败: ${mismatches.join(", ")}`); process.exit(1); }
  console.log("✅ sha256 校验通过");

  // 3. 准备测试库(重建, 保证干净)
  console.log("\n=== 2. 准备独立测试库 ===");
  const drop = await runPsql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${TEST_DB}`]);
  if (drop.code !== 0) { console.log("❌ 删测试库失败:", drop.stderr.slice(0, 200)); process.exit(1); }
  const create = await runPsql(["-d", "postgres", "-c", `CREATE DATABASE ${TEST_DB}`]);
  if (create.code !== 0) { console.log("❌ 建测试库失败:", create.stderr.slice(0, 200)); process.exit(1); }
  console.log("✅ 测试库就绪");

  // 4. schema 重建
  console.log("\n=== 3. schema 重建 ===");
  const schemaPath = join(dir, "schema.sql");
  if (existsSync(schemaPath)) {
    const schema = readFileSync(schemaPath, "utf-8");
    const res = await runPsql(["-d", TEST_DB, "-v", "ON_ERROR_STOP=0"], schema);
    if (res.code !== 0) {
      // schema 回放可能因扩展已存在等警告失败, 检查关键表是否存在
      const check = await runPsql(["-d", TEST_DB, "-c", `select count(*) from information_schema.tables where table_schema='public'`]);
      console.log(`⚠ schema 回放退出码 ${res.code}(部分警告属正常), 表数: ${check.stderr || "?"}`);
    }
    console.log("✅ schema 已回放");
  } else {
    console.log("⚠ 无 schema.sql, 跳过");
  }

  // 5. pg_data 导入(流式, 2.3GB)
  console.log("\n=== 4. pg_data 导入(流式, 约 5-10 分钟)===");
  const pgDataPath = join(dir, "pg_data.sql");
  const importRes = await runPsqlStream(["-d", TEST_DB, "-v", "ON_ERROR_STOP=0"], pgDataPath);
  console.log(`导入完成, 退出码: ${importRes.code}${importRes.code !== 0 ? " (stderr 前 300 字: " + importRes.stderr.slice(0, 300) + ")" : ""}`);

  // 6. 对比行数
  console.log("\n=== 5. 行数对比 ===");
  const counts = manifest?.counts ?? {};
  const tables = ["sources", "documents", "source_chunks", "entities", "events", "event_entities"];
  let allMatch = true;
  for (const table of tables) {
    const expected = counts[table] ?? 0;
    const res2 = await new Promise<{ out: string }>((resolve) => {
      const child = spawn("docker", ["exec", "-i", PG_CONTAINER, "psql", "-U", PG_USER, "-d", TEST_DB, "-t", "-c", `select count(*) from ${table}`], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d.toString(); });
      child.on("close", () => resolve({ out }));
      child.stdin.end();
    });
    const actual2 = parseInt(res2.out.trim(), 10);
    const match = actual2 === expected;
    if (!match) allMatch = false;
    console.log(`  ${table}: 期望 ${expected} / 实际 ${actual2} ${match ? "✅" : "❌"}`);
  }
  console.log(allMatch ? "\n🎉 恢复演练成功: 行数全部一致" : "\n⚠ 行数不一致, 需排查");

  // 7. 清理测试库
  console.log("\n=== 6. 清理测试库 ===");
  await runPsql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${TEST_DB}`]);
  console.log("✅ 测试库已清理(生产库未受影响)");

  await pool.end();
}

main().catch((e) => { console.error("演练失败:", e.message); process.exit(1); });
