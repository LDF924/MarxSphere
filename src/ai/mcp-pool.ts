// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// mcp-pool.ts — V92: MCP 多实例连接池, 消除单进程串行排队瓶颈
// Cognee: 4 实例 × p-limit(3) = 12 并发
// Graphiti: 4 实例 × p-limit(3) = 12 并发
// 8 个 Python 进程并行, 全部 23 路检索一次并行无排队
import { RichMcpClient, RichMcpClientConfig } from "../ai/rich-mcp-client.js";
import { logger } from "../observability/logger.js";

const POOL_SIZE = (() => {
  // V156: 环境变量覆盖 — 轻量验证用 MCP_POOL_SIZE=2（~1.2GB），默认 10（V95: 6→10 消除 Graphiti 9路超时）
  const fromEnv = Number(process.env.MCP_POOL_SIZE);
  return Number.isFinite(fromEnv) && fromEnv >= 1 && fromEnv <= 10 ? fromEnv : 10;
})();

interface PooledClient {
  client: RichMcpClient;
  busy: boolean;
  index: number;
}

export class McpPool {
  private clients: PooledClient[] = [];
  private ready = false;

  constructor(
    private name: string,
    private baseConfig: RichMcpClientConfig,
  ) {}

  async init(): Promise<boolean> {
    const results = await Promise.allSettled(
      Array.from({ length: POOL_SIZE }, async (_, i) => {
        const cfg = { ...this.baseConfig, name: `${this.name}-${i + 1}` };
        const client = new RichMcpClient(cfg);
        await client.connect();
        const ready = await client.probe();
        if (!ready) throw new Error(`instance ${i + 1} probe failed`);
        this.clients.push({ client, busy: false, index: i });
      })
    );
    const ok = results.filter(r => r.status === 'fulfilled').length;
    this.ready = ok > 0;
    console.log(`[sag] ${this.name} pool: ${ok}/${POOL_SIZE} instances ready`);
    return this.ready;
  }

  isReady(): boolean { return this.ready && this.clients.length > 0; }

  getClientCount(): number { return this.clients.length; }

  /** 获取任意空闲实例 — 如果全部 busy 则等待第一个释放, 连接断开自动重连 */
  async acquire(): Promise<RichMcpClient> {
    const tryAcquire = async (): Promise<RichMcpClient | null> => {
      // round-robin: 从最少使用的开始
      const sorted = [...this.clients].sort((a, b) => (a.busy ? 1 : 0) - (b.busy ? 1 : 0));
      for (const c of sorted) {
        if (c.busy) continue;
        // V96: 检测连接状态, 断开则自动重连
        if (!c.client.isConnected()) {
          logger.warn({ mcp: `${this.name}-${c.index + 1}` }, "MCP disconnected, auto-reconnecting...");
          const ok = await c.client.reconnect();
          if (!ok) continue; // 重连失败, 跳过这个实例
        }
        c.busy = true;
        return c.client;
      }
      return null;
    };

    const client = await tryAcquire();
    if (client) return client;

    // 全部 busy — 轮询等待, 每 50ms 检查一次
    return new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        const c = await tryAcquire();
        if (c) { clearInterval(timer); resolve(c); }
      }, 50);
      // 最长等 120s — 超时不仅清理定时器, 还要 reject（防调用方无限挂起）
      setTimeout(() => {
        clearInterval(timer);
        reject(new Error('MCP pool acquire timeout'));
      }, 120_000);
    });
  }

  release(client: RichMcpClient): void {
    const entry = this.clients.find(c => c.client === client);
    if (entry) entry.busy = false;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<any> {
    const client = await this.acquire();
    try {
      try {
        return await client.callTool(name, args, timeoutMs);
      } catch (err: any) {
        // V96: 连接在调用中途断开 (isConnected 检测不到的底层死亡) → 重连后重试一次
        const msg = (err?.message || String(err)) || '';
        const isConnErr = /not connected|Not connected|disconnected|transport.*close|ETIMEDOUT|Connection closed|No such process/i.test(msg);
        if (isConnErr) {
          logger.warn({ mcp: this.name, tool: name, err: msg.slice(0, 120) }, "MCP callTool conn error — reconnect & retry");
          const ok = await client.reconnect();
          if (ok) {
            return await client.callTool(name, args, timeoutMs);
          }
        }
        throw err;
      }
    } finally {
      this.release(client);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map(c => c.client.close().catch(() => {})));
    this.clients = [];
    this.ready = false;
  }
}
