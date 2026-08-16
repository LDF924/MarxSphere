#!/bin/bash
# sag-healthcheck.sh — SAG V25 全链路诊断
set -e
echo "══════════════════════════════════════════════════"
echo "  SAG V25 全链路健康检查 $(date '+%H:%M:%S')"
echo "  P0 hardened: MCP lifecycle + timeout + embedding"
echo "══════════════════════════════════════════════════"
echo ""

# ─── 1. 数据库端口 ───
echo "【1/8】数据库在线"
for port in 5540 11001 11003; do
  label=""; case $port in
    5540) label="PostgreSQL (SAG)" ;;
    11001) label="Neo4j Graphiti" ;;
    11003) label="Neo4j Cognee" ;;
  esac
  if netstat -ano 2>/dev/null | grep -q ":$port.*LISTENING"; then
    echo "  [OK] $label (:$port)"
  else
    echo "  [FAIL] $label (:$port)"
  fi
done
echo ""

# ─── 2. 超时常量 ───
echo "【2/8】超时配置"
grep -q "MCP_CONNECT_TIMEOUT_MS = 120_000" src/api/reason-handler.ts && echo "  [OK] reason-handler 120s connect" || echo "  [FAIL] reason-handler connect timeout"
grep -q 'timeout: 180_000' src/ai/rich-mcp-client.ts && echo "  [OK] rich-mcp-client 180s connect" || echo "  [FAIL] rich-mcp-client connect timeout"
grep -q 'timeoutMs ?? 180_000' src/ai/rich-mcp-client.ts && echo "  [OK] rich-mcp-client callTool default 180s" || echo "  [FAIL] rich-mcp-client callTool timeout"
grep -q "withTimeout" src/services/inference-service.ts && echo "  [OK] inference-service withTimeout wrapper" || echo "  [FAIL] withTimeout missing"
grep -q "statement_timeout = '30s'" src/db/pool.ts && echo "  [OK] PG statement_timeout=30s" || echo "  [FAIL] PG statement_timeout"
echo ""

# ─── 3. MCP 生命周期强化 ───
echo "【3/8】MCP 生命周期"
grep -q "pipeStderr" src/ai/rich-mcp-client.ts && echo "  [OK] stderr relay" || echo "  [FAIL] stderr relay missing"
grep -q "async probe" src/ai/rich-mcp-client.ts && echo "  [OK] readiness probe" || echo "  [FAIL] probe missing"
grep -q "trackClient" src/api/reason-handler.ts && echo "  [OK] client tracking + exit cleanup" || echo "  [FAIL] trackClient missing"
grep -q "SIGTERM" src/api/reason-handler.ts && echo "  [OK] SIGTERM/SIGINT handler" || echo "  [FAIL] signal handler missing"
grep -q "SIGKILL" src/ai/rich-mcp-client.ts && echo "  [OK] close() SIGKILL fallback" || echo "  [FAIL] SIGKILL missing"
echo ""

# ─── 4. Python venv ───
echo "【4/8】Python venv"
PYTHON="COGNEE_DIR/.venv312/Scripts/python.exe"
[ -f "$PYTHON" ] && echo "  [OK] venv Python" || echo "  [FAIL] venv Python not found"
echo ""

# ─── 5. SAG API ───
echo "【5/8】SAG API :4173"
if netstat -ano 2>/dev/null | grep -q ":4173.*LISTENING"; then
  echo "  [OK] SAG :4173 listening"
  echo "  → quick probe: $(curl -s -X POST http://localhost:4173/api/reason/query -H 'Content-Type: application/json' -d '{"sourceId":"8ecb4299-1bec-45d5-afef-6da5c3843ef3","query":"test","topK":1}' 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('taskId','NO_TASKID')[:8] + '...')" 2>/dev/null || echo "  (probe skipped)")"
else
  echo "  [OFFLINE] :4173"
fi
echo ""

# ─── 6. external_entities embedding ───
echo "【6/8】external_entities embedding"
grep -q "external_entities_embedding_hnsw" migrations/009_external_entities_embedding.sql && echo "  [OK] migration exists" || echo "  [FAIL] migration missing"
grep -q "pgEntityVectors" src/services/inference-service.ts && echo "  [OK] entity vector search active" || echo "  [FAIL] entity vector search removed"
grep -q "backfill-entity-embeddings" scripts/backfill-entity-embeddings.ts && echo "  [OK] backfill script exists" || echo "  [FAIL] backfill script missing"
echo ""

# ─── 7. 分级错误处理 ───
echo "【7/8】错误处理"
grep -q "RETRIEVAL_TIMEOUT" src/api/server.ts && echo "  [OK] server.ts timeout→503" || echo "  [FAIL] graded error missing"
grep -q "queryWithRetry" src/db/pool.ts && echo "  [OK] DB queryWithRetry" || echo "  [FAIL] retry missing"
grep -q "pool.on('error'" src/db/pool.ts && echo "  [OK] DB error handler" || echo "  [FAIL] DB error handler missing"
grep -q "dedupDropped" src/services/inference-service.ts && echo "  [OK] fuseResults global dedup" || echo "  [FAIL] dedup missing"
grep -q "SAG 系统提示" src/services/inference-service.ts && echo "  [OK] empty context guard" || echo "  [FAIL] guard missing"
echo ""

# ─── 8. Python 侧修复确认 ───
echo "【8/8】Python 侧修复"
RERANKER="PYTHON_SITE/pythoncore-3.14-64/Lib/site-packages/graphiti_core/cross_encoder/openai_reranker_client.py"
if [ -f "$RERANKER" ]; then
  grep -q "strict=True" "$RERANKER" 2>/dev/null && echo "  [FAIL] zip(strict=True) still present in reranker!" || echo "  [OK] zip(strict=True) removed"
  grep -q "scores.append(0.5)" "$RERANKER" 2>/dev/null && echo "  [OK] logprobs fallback 0.5" || echo "  [WARN] logprobs fallback not found"
else
  echo "  [WARN] reranker file not found at expected path"
fi
echo ""

echo "══════════════════════════════════════════════════"
echo "  检查完成"
echo "══════════════════════════════════════════════════"
