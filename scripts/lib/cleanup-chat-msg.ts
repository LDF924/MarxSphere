// scripts/lib/cleanup-chat-msg.ts — 删掉探针造的会话
import { pool } from "../../src/db/pool.js";
const sid = process.argv[2];
if (sid) {
  await pool.query("delete from mcp_messages where session_id=$1", [sid]);
  await pool.query("delete from mcp_sessions where id=$1", [sid]);
}
await pool.end();
