// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ingest-pipeline.ts — 新论文增量管道: MD → Cognee → Graphiti → SAG 记录
import { pool } from "../db/pool.js";

export interface NewPaperInput {
  sourceId: string;
  title: string;
  content: string;
  mdPath?: string;
}

export interface IngestPipelineResult {
  paperId: string;
  cogneeJobId?: string;
  graphitiJobId?: string;
  status: string;
  steps: { engine: string; status: string; durationMs: number; error?: string }[];
}

/** 增量管道: 新论文走 Cognee → Graphiti → SAG 单向流
 *
 *  实际入库由用户的 marx-graphiti-ingest / marx-cognee-ingest skill 执行
 *  SAG 负责记录 IngestJob 状态和 paper_id 分配
 */
export async function runNewPaperPipeline(
  input: NewPaperInput,
  graphitiMCP: any,
  cogneeMCP: any,
): Promise<IngestPipelineResult> {
  const steps: IngestPipelineResult["steps"] = [];
  const paperId = hashTitle(input.title);

  // 1. 记录 SAG IngestJob (Cognee 入库)
  const t0 = Date.now();
  const cogJob = await pool.query(
    `INSERT INTO ingest_jobs (source_id, engine, job_type, status, started_at)
     VALUES ($1, 'cognee', 'ingest', 'running', now()) RETURNING id`,
    [input.sourceId]
  );
  const cogJobId = cogJob.rows[0].id;

  try {
    // 调 Cognee MCP 入库 (add + cognify)
    await cogneeMCP.callTool("cognee_add", { content: input.content, title: input.title });
    const addMs = Date.now() - t0;
    steps.push({ engine: "cognee", status: "completed", durationMs: addMs });

    await cogneeMCP.callTool("cognee_cognify", {});
    const cognifyMs = Date.now() - t0 - addMs;
    steps.push({ engine: "cognee", status: "completed", durationMs: cognifyMs });

    await pool.query(
      `UPDATE ingest_jobs SET status = 'completed', completed_at = now() WHERE id = $1`,
      [cogJobId]
    );
  } catch (e: any) {
    await pool.query(
      `UPDATE ingest_jobs SET status = 'failed', error = $2 WHERE id = $1`,
      [cogJobId, e.message]
    );
    steps.push({ engine: "cognee", status: "failed", durationMs: Date.now() - t0, error: e.message });
    return { paperId, status: "failed", steps };
  }

  // 2. 记录 SAG IngestJob (Graphiti 精炼)
  const t1 = Date.now();
  const gJob = await pool.query(
    `INSERT INTO ingest_jobs (source_id, engine, job_type, status, started_at)
     VALUES ($1, 'graphiti', 'distill', 'running', now()) RETURNING id`,
    [input.sourceId]
  );
  const gJobId = gJob.rows[0].id;

  try {
    // 调 Graphiti MCP 精炼 (需要等 Cognee 完成后)
    // 此处 Graphiti 需要拉取 Cognee 的标准化数据
    await graphitiMCP.callTool("run_cypher_read", {
      query: `MERGE (p:Paper {paper_id: '${paperId}'}) SET p.title = '${input.title}', p.source = 'cognee'`,
      params: {}
    });
    const distillMs = Date.now() - t1;
    steps.push({ engine: "graphiti", status: "completed", durationMs: distillMs });

    await pool.query(
      `UPDATE ingest_jobs SET status = 'completed', completed_at = now() WHERE id = $1`,
      [gJobId]
    );
  } catch (e: any) {
    await pool.query(
      `UPDATE ingest_jobs SET status = 'failed', error = $2 WHERE id = $1`,
      [gJobId, e.message]
    );
    steps.push({ engine: "graphiti", status: "failed", durationMs: Date.now() - t1, error: e.message });
  }

  return {
    paperId,
    cogneeJobId: cogJobId,
    graphitiJobId: gJobId,
    status: "completed",
    steps,
  };
}

function hashTitle(title: string): string {
  const { createHash } = require("crypto");
  return createHash("md5").update(title.toLowerCase().trim()).digest("hex").slice(0, 12);
}
