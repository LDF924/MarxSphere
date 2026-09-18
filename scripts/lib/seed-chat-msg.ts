// scripts/lib/seed-chat-msg.ts — 往对话会话里插一条消息(免调 LLM), 供探针验渲染
//
// 为什么需要: 要验"markdown 里的 `/api/...` 图片在对话气泡里渲染得出来", 走真实发消息
//   会调 LLM(慢且烧额度)。直接造库最省 —— 渲染链与真实消息完全一致(同一个 ChatPanel 分支)。
//
// 用法: npx tsx scripts/lib/seed-chat-msg.ts <会话标题> <消息内容>
import { randomUUID } from "node:crypto";
import { pool } from "../../src/db/pool.js";

const title = process.argv[2] || "探针会话";
const content = process.argv[3] || "seed";

const { rows: u } = await pool.query("select id, tenant_id from users where username=$1", ["audit"]);
const uid = u[0]?.id;
if (!uid) { console.error("找不到 audit 用户"); process.exit(1); }

// 形状照抄 repositories.ts 的 createMcpSession(mcp_sessions 没有 user_id 列)
const s = await pool.query(
  `insert into mcp_sessions (id, tenant_id, title, model, source_ids, metadata, kind)
   values ($1,$2,$3,null,'{}'::uuid[],'{}'::jsonb,'chat') returning id`,
  [randomUUID(), u[0].tenant_id ?? null, title]
);
const sid = s.rows[0].id;
await pool.query(
  "insert into mcp_messages (id, session_id, role, content, metadata) values ($1,$2,'assistant',$3,'{}'::jsonb)",
  [randomUUID(), sid, content]
);
console.log(sid);
await pool.end();
