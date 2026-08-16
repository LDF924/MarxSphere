import pg from "pg";
import { config } from "../config/env.js";
import pLimit from "p-limit";

const { Pool } = pg;

const pgLimit = pLimit(2);  // P1: max 2 concurrent PG queries

export async function queryWithLimit(
  sql: string,
  params?: any[],
): Promise<pg.QueryResult<any>> {
  return pgLimit(() => pool.query(sql, params));
}

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
});

// P0-4e: 30s query timeout prevents hung queries from blocking the pipeline
pool.on('connect', async (client) => {
  try { await client.query("SET statement_timeout = '300s'"); } catch {}
});

// P1-11: connection-level error handler (prevents pg default crash)
pool.on('error', (err) => {
  console.error('[db] pool error:', err.message);
});

export async function closePool(): Promise<void> {
  await pool.end();
}

// P1-11: retryable query wrapper with exponential backoff
const RETRYABLE_CODES = new Set(['ECONNREFUSED', '57P01', '08000', '40001', '53300', 'ETIMEDOUT']);

export async function queryWithRetry(
  sql: string,
  params?: any[],
  opts?: { maxRetries?: number; baseDelay?: number },
): Promise<pg.QueryResult<any>> {
  const maxRetries = opts?.maxRetries ?? 2;
  const baseDelay = opts?.baseDelay ?? 200;
  let lastErr: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await pool.query(sql, params);
    } catch (e: any) {
      lastErr = e;
      const retryable = RETRYABLE_CODES.has(e.code) || e.message?.includes('Connection terminated');
      if (!retryable || attempt >= maxRetries) throw e;
      const delay = baseDelay * Math.pow(2, attempt);
      console.warn(`[db] query retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${e.code || e.message?.substring(0, 60)}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
