// scripts/lib/seed-viz-file.ts — 往 blob-store 放一张真图, 供探针用
//
// 为什么要单独一个文件: 探针都是 `node xxx.mjs`(纯 HTTP + CDP), **读不了应用的 TS ESM**
//   (`src/db/pool.ts` 里是 `./env.js` 这种 ESM 写法, 裸 node 解析不到 .ts)。
//   所以由探针 `tsx` 起一个子进程来播种 —— 探针本身仍保持"不 import 应用代码"的约定。
//
// 用法: npx tsx scripts/lib/seed-viz-file.ts <文件名>   → stdout 打印可访问的 URL 路径
import { putObject } from "../../src/services/blob-store.js";
import { pool } from "../../src/db/pool.js";

/** 1x1 红点 PNG */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const name = process.argv[2] || "probe-authed.png";
const username = process.argv[3] || "audit";
const { rows } = await pool.query("select id from users where username=$1", [username]);
const uid = rows[0]?.id;
if (!uid) {
  console.error(`找不到用户 ${username}`);
  process.exit(1);
}
await putObject(`viz-files/${uid}/${name}`, PNG);
console.log(`/api/viz/files/data/viz-files/${uid}/${name}`);
await pool.end();
