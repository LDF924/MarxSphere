import { pool } from '../../src/db/pool.js';
async function main() {
  const r = await pool.query("SELECT llm_api_key, llm_base_url, llm_model FROM ai_provider_settings WHERE id='global'");
  const row = r.rows[0];
  if (row) {
    const k = String(row.llm_api_key || '');
    console.log('数据库 llm_api_key:', k.slice(0, 6) + '*** 长度' + k.length);
    console.log('数据库 llm_base_url:', row.llm_base_url);
    console.log('数据库 llm_model:', row.llm_model);
  }
  await pool.end();
}
main();
