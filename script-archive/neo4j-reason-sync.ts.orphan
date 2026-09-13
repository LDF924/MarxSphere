// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// neo4j-reason-sync.ts — 推理元数据同步到 Neo4j 11005
// 每当 PG 中创建推理记录，可选同步到 Neo4j 图节点
import { pool } from "../db/pool.js";

export interface Neo4jSyncInput {
  graphitiMCP: any; // RichMcpClient 实例，已连接到 Graphiti (可复用)
}

/** 将一次推理任务同步到 Neo4j 图 */
export async function syncReasonToNeo4j(taskId: string, graphitiMCP: any): Promise<void> {
  const task = await pool.query("SELECT * FROM query_tasks WHERE id = $1", [taskId]);
  if (task.rows.length === 0) return;

  const outlines = await pool.query("SELECT * FROM outlines WHERE task_id = $1 ORDER BY order_index", [taskId]);
  const steps = await pool.query("SELECT * FROM retrieve_steps WHERE task_id = $1", [taskId]);
  const hypotheses = await pool.query("SELECT * FROM infer_hypotheses WHERE task_id = $1", [taskId]);
  const evals = await pool.query("SELECT * FROM eval_records WHERE task_id = $1", [taskId]);

  const t = task.rows[0];
  const safe = (s: string) => s.replace(/'/g, "\\'");

  try {
    // 创建 QueryTask 节点
    await graphitiMCP.callTool("run_cypher_read", {
      cypher: `MERGE (qt:QueryTask {id: '${t.id}'}) SET qt.query = '${safe(t.query)}', qt.status = '${t.status}', qt.createdAt = '${t.created_at}'`
    });

    // 创建 Outline 节点 + 关系
    for (const o of outlines.rows) {
      await graphitiMCP.callTool("run_cypher_read", {
        cypher: `MERGE (o:Outline {id: '${o.id}'}) SET o.title = '${safe(o.title)}', o.description = '${safe(o.description || "")}', o.orderIndex = ${o.order_index}, o.depth = ${o.depth}, o.status = '${o.status}'`
      });
      await graphitiMCP.callTool("run_cypher_read", {
        cypher: `MATCH (qt:QueryTask {id: '${t.id}'}), (o:Outline {id: '${o.id}'}) MERGE (qt)-[:TASK_OUTLINES]->(o)`
      });
    }

    // 创建 RetrieveStep 节点 + 关系
    for (const s of steps.rows) {
      await graphitiMCP.callTool("run_cypher_read", {
        cypher: `MERGE (rs:RetrieveStep {id: '${s.id}'}) SET rs.engine = '${s.engine}', rs.searchType = '${s.search_type || ""}', rs.query = '${safe(s.query)}', rs.durationMs = ${s.duration_ms || 0}, rs.status = '${s.status}'`
      });
      if (s.outline_id) {
        await graphitiMCP.callTool("run_cypher_read", {
          cypher: `MATCH (o:Outline {id: '${s.outline_id}'}), (rs:RetrieveStep {id: '${s.id}'}) MERGE (o)-[:OUTLINE_RETRIEVES]->(rs)`
        });
      }
    }

    // 创建 Hypothesis 节点 + 关系
    for (const h of hypotheses.rows) {
      await graphitiMCP.callTool("run_cypher_read", {
        cypher: `MERGE (h:InferHypothesis {id: '${h.id}'}) SET h.content = '${safe(h.content?.substring(0, 500) || "")}', h.confidence = ${h.confidence || 0.5}, h.status = '${h.status}'`
      });
      await graphitiMCP.callTool("run_cypher_read", {
        cypher: `MATCH (qt:QueryTask {id: '${t.id}'}), (h:InferHypothesis {id: '${h.id}'}) MERGE (qt)-[:TASK_HYPOTHESES]->(h)`
      });
    }

    // 创建 EvalRecord 节点 + 关系
    for (const e of evals.rows) {
      await graphitiMCP.callTool("run_cypher_read", {
        cypher: `MERGE (er:EvalRecord {id: '${e.id}'}) SET er.overallScore = ${e.overall_score || 0}, er.passed = ${e.passed || false}, er.notes = '${safe(e.notes || "")}'`
      });
      if (e.hypothesis_id) {
        await graphitiMCP.callTool("run_cypher_read", {
          cypher: `MATCH (h:InferHypothesis {id: '${e.hypothesis_id}'}), (er:EvalRecord {id: '${e.id}'}) MERGE (h)-[:HYPOTHESIS_EVALUATES]->(er)`
        });
      }
    }
  } catch (err) {
    // Neo4j 同步失败不阻塞 PG 主流程
    console.error("[neo4j-sync]", err);
  }
}
