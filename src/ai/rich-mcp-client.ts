// rich-mcp-client.ts — stdio MCP 客户端, 用于连接 Graphiti / Cognee
// P0 hardened: stderr relay, readiness probe, heartbeat, abort, close SIGKILL, 180s default
// P1: concurrency limiter support (p-limit)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { logger } from "../observability/logger.js";

export interface McpToolCallResult {
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
  durationMs: number;
}

export interface RichMcpClientConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  concurrencyLimit?: (fn: () => Promise<any>) => Promise<any>;
}

export class RichMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected = false;
  private ready = false;
  private lastError: string | null = null;
  private lastErrorTime = 0;
  private lastPingTime = 0;
  private activeController: AbortController | null = null;
  private childPid: number | null = null;
  private limit: ((fn: () => Promise<any>) => Promise<any>) | null = null;

  constructor(private cfg: RichMcpClientConfig) {
    this.limit = cfg.concurrencyLimit ?? null;
  }

  getPid(): number | null { return this.childPid; }

  async connect(signal?: AbortSignal): Promise<string[]> {
    if (this.connected) return this.listToolNames();
    this.client = new Client({ name: "sag-11005", version: "0.1.0" });
    const transportEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) transportEnv[k] = v;
    }
    for (const [k, v] of Object.entries(this.cfg.env ?? {})) {
      transportEnv[k] = v;
    }
    this.transport = new StdioClientTransport({
      command: this.cfg.command,
      args: this.cfg.args,
      env: transportEnv,
      stderr: "pipe",
    });
    try {
      await this.client.connect(this.transport, { timeout: 1800_000, signal });
      this.connected = true;
      this.lastError = null;
      this.lastErrorTime = 0;
      this.pipeStderr();
      try {
        const proc = (this.transport as any).process;
        if (proc?.pid) {
          this.childPid = proc.pid;
          logger.info({ pid: proc.pid, mcp: this.cfg.name }, "MCP subprocess started");
        }
      } catch {}
      const tools = await this.listToolNames();
      if (tools.length === 0) {
        logger.warn({ mcp: this.cfg.name }, "MCP connect OK but listTools returned empty");
        this.ready = false;
      } else {
        this.ready = true;
        logger.info({ mcp: this.cfg.name, toolCount: tools.length }, "MCP ready");
      }
      return tools;
    } catch (e) {
      this.lastError = (e as any)?.message || String(e);
      this.lastErrorTime = Date.now();
      this.ready = false;
      await this.transport.close().catch(() => {});
      this.connected = false;
      throw e;
    }
  }

  private pipeStderr(): void {
    if (!this.transport) return;
    try {
      const stderr = (this.transport as any).stderr;
      if (stderr && typeof stderr.on === 'function') {
        const label = "mcp:" + this.cfg.name;
        stderr.on('data', (chunk: Buffer) => {
          const lines = chunk.toString('utf-8').trimEnd();
          if (lines) logger.warn({ mcp: label }, lines);
        });
      }
    } catch {}
  }

  private async listToolNames(): Promise<string[]> {
    const res = await this.client!.listTools(undefined);
    return res.tools.map((t) => t.name);
  }

  async probe(): Promise<boolean> {
    if (!this.connected || !this.client) return false;
    try {
      const tools = await this.listToolNames();
      this.ready = tools.length > 0;
      return this.ready;
    } catch {
      this.ready = false;
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  isResponsive(): boolean {
    if (!this.isConnected()) return false;
    if (this.lastPingTime === 0) return true;
    return (Date.now() - this.lastPingTime) < 30 * 60 * 1000;
  }

  getLastError(): string | null {
    if (!this.lastError) return null;
    if (Date.now() - this.lastErrorTime > 5 * 60 * 1000) return null;
    return this.lastError;
  }

  abort(): void {
    if (this.activeController) {
      this.activeController.abort();
      this.activeController = null;
    }
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolCallResult> {
    if (!this.isConnected()) throw new Error(this.cfg.name + " not connected");
    const run = async () => {
      const start = Date.now();
      this.activeController = new AbortController();
      const controller = this.activeController;
      try {
        const res = await (this.client as any).callTool(
          { name, arguments: args },
          undefined,
          { timeout: timeoutMs ?? 1800_000, signal: controller.signal },
        );
        this.lastPingTime = Date.now();
        return {
          toolName: name,
          arguments: args,
          result: res.content,
          durationMs: Date.now() - start,
        };
      } finally {
        if (this.activeController === controller) {
          this.activeController = null;
        }
      }
    };
    return this.limit ? this.limit(run) : run();
  }

  async reconnect(): Promise<boolean> {
    logger.warn({ mcp: this.cfg.name }, "MCP reconnecting...");
    await this.close();
    try {
      await this.connect();
      logger.info({ mcp: this.cfg.name }, "MCP reconnected OK");
      return true;
    } catch (e) {
      logger.error({ mcp: this.cfg.name, err: (e as any)?.message }, "MCP reconnect failed");
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.childPid) {
      try { process.kill(this.childPid, 'SIGTERM'); await new Promise(r => setTimeout(r, 2000)); } catch {}
      try { process.kill(this.childPid, 0); } catch { this.childPid = null; }
    }
    if (this.childPid) {
      try { process.kill(this.childPid, 'SIGKILL'); } catch {}
      this.childPid = null;
    }
    if (this.transport) {
      await this.transport.close().catch(() => {});
    }
    this.connected = false;
    this.ready = false;
    this.client = null;
    this.transport = null;
  }
}
