// dual-engine-service.ts — 双库调度服务：同时调 Graphiti + Cognee，结果融合
import type { RichMcpClient } from "../ai/rich-mcp-client.js";
import type { Pool } from "pg";
import { pool } from "../db/pool.js";

export interface RetrieveInput {
  sourceId: string;
  taskId: string;
  outlineId?: string;
  query: string;
  engines?: ("graphiti" | "cognee")[]; // 默认都调
}

export interface EngineResult {
  engine: "graphiti" | "cognee" | "hybrid";
  toolName: string;
  result: unknown;
  durationMs: number;
  error?: string;
}

export interface RetrieveOutput {
  results: EngineResult[];
  totalDurationMs: number;
}

export class DualEngineService {
  constructor(
    private graphiti: RichMcpClient | null,
    private cognee: RichMcpClient | null,
    private dbPool: Pool = pool,
  ) {}

  /** 智能调度: 先调 Graphiti 获取权威事实, 再根据结果质量决定是否补充 Cognee */
  async retrieve(input: RetrieveInput): Promise<RetrieveOutput> {
    const engines = input.engines ?? ["graphiti", "cognee"];
    const results: EngineResult[] = [];
    const startAll = Date.now();

    // 第一步: 始终先调 Graphiti (领域权威事实库)
    let graphitiResult: EngineResult | null = null;
    if (engines.includes("graphiti")) {
      try {
        graphitiResult = await this.callGraphiti(input.query);
        results.push(graphitiResult);
      } catch (e: any) {
        results.push({ engine: "graphiti", toolName: "", result: null, durationMs: 0, error: e.message } as EngineResult);
      }
    }

    // 第二步: 评估 Graphiti 结果质量, 决定是否调 Cognee
    const needsCognee = engines.includes("cognee") && (!graphitiResult || graphitiResult.error || this.isResultThin(graphitiResult));
    if (needsCognee) {
      try {
        const cogneeResult = await this.callCognee(input.query);
        results.push(cogneeResult);
      } catch (e: any) {
        results.push({ engine: "cognee", toolName: "", result: null, durationMs: 0, error: e.message } as EngineResult);
      }
    }

    // 第二步后: 做交叉验证
    if (graphitiResult && !graphitiResult.error) {
      const cogneeResults = results.filter((r) => r.engine === "cognee");
      if (cogneeResults.length > 0) {
        const validation = this.crossValidate(graphitiResult.result, cogneeResults[0].result);
        results.push({
          engine: "hybrid",
          toolName: "cross_validate",
          result: validation,
          durationMs: 0,
        } as EngineResult);
      }
    }

    // 记录检索步骤
    for (const r of results) {
      await this.logStep(input, r);
    }

    return { results, totalDurationMs: Date.now() - startAll };
  }

  /** 检查 Graphiti 结果是否太薄, 需要 Cognee 补充 */
  private isResultThin(result: EngineResult): boolean {
    if (!result.result) return true;
    if (Array.isArray(result.result)) {
      // 判断返回的条目数太少
      const items = result.result as any[];
      return items.length < 3;
    }
    if (typeof result.result === "string") {
      return result.result.length < 200;
    }
    return false;
  }

  private async callGraphiti(query: string): Promise<EngineResult> {
    if (!this.graphiti) return { engine: "graphiti", toolName: "", result: null, durationMs: 0, error: "Graphiti 未连接" };
    const result = await this.graphiti.callTool("chunk_search_entities", { query, limit: 10 });
    return { engine: "graphiti", toolName: "chunk_search_entities", result: result.result, durationMs: result.durationMs };
  }

  private async callCognee(query: string): Promise<EngineResult> {
    if (!this.cognee) return { engine: "cognee", toolName: "", result: null, durationMs: 0, error: "Cognee 未连接" };
    const result = await this.cognee.callTool("cognee_search", { query_text: query, limit: 10 });
    return { engine: "cognee", toolName: "cognee_search", result: result.result, durationMs: result.durationMs };
  }

  private async logStep(input: RetrieveInput, r: EngineResult) {
    try {
      await this.dbPool.query(
        `INSERT INTO retrieve_steps (task_id, outline_id, engine, search_type, query, parameters, result_count, duration_ms, status, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          input.taskId,
          input.outlineId ?? null,
          r.engine,
          r.toolName,
          input.query,
          JSON.stringify({ engines: input.engines }),
          Array.isArray(r.result) ? r.result.length : 0,
          r.durationMs,
          r.error ? "failed" : "completed",
          r.error ?? null,
        ]
      );
    } catch {
      // 不阻塞主流程
    }
  }

  /** 交叉验证：Graphiti 和 Cognee 结果共同确认的段落更可信 */
  crossValidate(graphitiResult: unknown, cogneeResult: unknown): {
    shared: string[];
    graphitiOnly: string[];
    cogneeOnly: string[];
  } {
    const gTexts = this.extractTexts(graphitiResult);
    const cTexts = this.extractTexts(cogneeResult);
    const gSet = new Set(gTexts);
    const cSet = new Set(cTexts);
    const shared = gTexts.filter((t) => cSet.has(t));
    const graphitiOnly = gTexts.filter((t) => !cSet.has(t));
    const cogneeOnly = cTexts.filter((t) => !gSet.has(t));
    return { shared, graphitiOnly, cogneeOnly };
  }

  private extractTexts(result: unknown): string[] {
    if (!result) return [];
    if (Array.isArray(result)) {
      return result
        .map((item: any) => item?.text ?? item?.content ?? "")
        .filter(Boolean);
    }
    return [];
  }
}
