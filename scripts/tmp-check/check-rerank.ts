import { pool } from '../../src/db/pool.js';
async function main() {
  try {
    const r = await pool.query("SELECT metadata FROM ai_provider_settings WHERE id='global'");
    const row = r.rows[0];
    if (row?.metadata) {
      const m = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      console.log('metadata 里的 rerank:', JSON.stringify(m.rerank || m.RERANK || '（无）').slice(0, 200));
    } else {
      console.log('无 metadata');
    }
  } catch (e: any) {
    console.log('查询失败:', e.message?.slice(0, 100));
  }
  await pool.end();
}
main();
