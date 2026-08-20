// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// eval-32-metrics.ts — RAGAS v3 评测体系（2026-08-06 由 eval-22-metrics.ts 改名，与输出文件 eval_32metrics.json 对齐）
// 注: 旧名 "eval-22" 为历史遗留 (早期版本仅22项指标)，V280 起输出名与指标数一致，V284 起脚本名同步改名
//     当前实际评测 32 评分项 (A1-A12 + B1-B9 + C1-C3 + D1-D7)
//     旧版备份保留在 eval-22-metrics.ts.bak-*/vXXX-ok（历史快照，未改名）
// V40: +A9 context_json_contamination (规则4正则在行级检测JSON/YAML/元数据噪音 + LLM验证)
// V39 修复汇总:
//   P0: SIGINT第二次强制退出+循环shuttingDown检查+循环后统一保存 | safeSaveJSON unlinkSync增加warn日志
//   P0: 信号量排队超时3分钟(SEMAPHORE_TIMEOUT_MS) | embedding接入信号量管控(EMBED_DISABLE可关)
//   P0: RateLimit指数退避(2s+随机3s) | safeSaveJSON清理残留tmp | classifyLLMError
//   P0: calcDimAvg直接读item.score(移除二次mergeScore) | eval_failed不剔除仅告警
//   P0: llmJudge拆分为_llmJudgeOnce(无锁)+llmJudgeSingle(带锁) | runThreeRoundMedian外层持锁
//   P0: FETCH_TIMEOUT_MS 3600s→90s | mergeScore类型安全
//   P1: IQR阈值环境变量IQR_THRESHOLD可调 | B组降级随机延迟防限流 | 信号量泄漏检测
//   P1: B组降级补齐强制3轮 | writeFileSync原子rename→safeSaveJSON
//   P1: RE_NUM_EXTRACT加\b边界防负数 | token_efficiency下界0.1 | IQR四分位距
//   P1: embedding重试1次 | EVAL_QUESTIONS去重 | Fisher-Yates洗牌 | gold_dataset字段校验
//   P1: gold_dataset.json/输出文件损坏try/catch | traceId串联SAG日志
//   P2: SampleEvalResult接口扩展 | D维度阈值常量化 | computeNDCG注释 | RE_STRUCTURED_STEPS扩展
//   P2: MetricItem增加variance_warning/eval_failed | CANDIDATES自动推导+去重 | JUDGE_LLM_MODEL常量
//   P2: 预编译13个正则 | 全局熔断4h+卡死位置输出 | eval_failed报表可视化 | clip添加[TRUNCATED]
//   P3: logInfo/logWarn/logError带时间戳ts() | 进度[当前/总数] | DEEPSEEK_KEY/EMBEDDING_KEY启动校验
// V41: B维度 factual_consistency 增加交叉验证 — 当 faith/hallu/correct 两项≤0.3 且 fc≥0.75 时,
//   自动降权 (Q44踩坑: 内部自洽但答案张冠李戴给了满分)
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'fs';
import * as http from 'http';
import * as https from 'https';
import { classifyError } from '../src/services/error-recovery-map.js';

const SAG_API = 'http://localhost:4173';
const PROJECT_ID = 'c609acbf-1d6e-4bd5-9ae1-92fa6c64021a';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const EMBEDDING_URL = process.env.EMBEDDING_ENDPOINT || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-v4';
const EMBEDDING_KEY = process.env.EMBEDDING_API_KEY || process.env.DASHSCOPE_API_KEY || '';
const DS_URL = process.env.DS_BASE_URL || 'https://api.deepseek.com/v1/chat/completions';
const OUTPUT = process.env.EVAL_OUTPUT || 'eval_32metrics.json';

// 题号可通过环境变量 EVAL_QUESTIONS 覆盖, 逗号分隔 (如 "Q05,Q06,Q07,Q08")
const EVAL_QUESTIONS = process.env.EVAL_QUESTIONS
  ? process.env.EVAL_QUESTIONS.split(',').map(s => s.trim())
  : null;

// 只评测指定维度, 逗号分隔 (如 "A" / "A,B" / "A,B,C,D")
const EVAL_DIMS = (process.env.EVAL_DIMS || '').split(',').map(s => s.trim()).filter(Boolean);

// 双轨融合策略: rule_only | llm_only | max | min | avg (默认: max)
const EVAL_MERGE_POLICY = (process.env.EVAL_MERGE_POLICY || 'max').toLowerCase();

let CANDIDATES: Record<string, string> = {
  '概念定义': 'Q01', '事实检索': 'Q02', '多跳推理': 'Q03', '政策评估': 'Q04',
};

async function callSAG(query: string, paperId?: string, questionId?: string) {
  const t0 = Date.now();
  // V387: 强制 template 模式 — 评测口径需与基线一致(52步+_debugCoarse产出),
  // 且 auto-adaptive 的 trace 不含 _debugCoarse, 会导致 A 维度(chunks/pgChunks)全空
  // V387: 显式 sources 三库全开(pg+graphiti+cognee) — 服务端默认仅 pg, 需显式传参才走三库
  const body: any = { sourceId: PROJECT_ID, query, topK: 15, mode: "template", sources: ["pg", "graphiti", "cognee"] };
  if (paperId) body.paperId = paperId;
  // V294: 反思闭环归因联动 — 带 question_id 让推理侧反思时能查到 eval_failures 归因
  if (questionId) body.questionId = questionId;
  let res: any;
  // V302(P0-10): 故障分类驱动重试 — 只重试可重试类别(限流/超时/过载), 其余直接抛
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await safeFetch(SAG_API + '/api/reason/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, FETCH_TIMEOUT_MS);
      if (!res.ok) throw new Error('SAG HTTP ' + res.status);
      const dur = Date.now() - t0;
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        return { ...json, totalMs: dur };
      } catch {
        const cls = classifyError(new Error('JSON parse failed after 3 attempts'));
        if (attempt < 2 && cls.retryable) {
          console.log('  SAG JSON parse retry ' + (attempt + 1));
          continue;
        }
        throw new Error('JSON parse failed after 3 attempts');
      }
    } catch (e: any) {
      const cls = classifyError(e);
      // 可重试（限流/超时/过载）→ 退避重试; 不可重试 → 直接抛
      if (attempt < 2 && cls.retryable) {
        const s = cls.strategy;
        if (s.kind === 'retry_backoff') {
          const delay = s.baseMs + Math.random() * s.jitterMs;
          console.log('  SAG ' + cls.category + ' retry ' + (attempt + 1) + ' (退避 ' + (delay / 1000).toFixed(1) + 's)');
          await new Promise(r => setTimeout(r, delay));
        }
        continue;
      }
      throw e;
    }
  }
  throw new Error('callSAG failed');
}

// ====================== 并发限速信号量 ======================
const CONCURRENCY_LIMIT = 3;
const SEMAPHORE_TIMEOUT_MS = 180000;
let activeJudges = 0;
const judgeSemaphore: Array<() => void> = [];
async function acquireJudgeSlot(): Promise<void> {
  if (judgeSemaphore.length >= MAX_SEMAPHORE_QUEUE) {
    throw new Error('JUDGE queue overflow: ' + judgeSemaphore.length + ' tasks queued');
  }
  if (activeJudges >= CONCURRENCY_LIMIT) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = judgeSemaphore.indexOf(resolve as any);
        if (idx >= 0) judgeSemaphore.splice(idx, 1);
        reject(new Error('Semaphore wait timeout after ' + (SEMAPHORE_TIMEOUT_MS / 1000) + 's'));
      }, SEMAPHORE_TIMEOUT_MS);
      const wrapped = () => { clearTimeout(timer); resolve(); };
      judgeSemaphore.push(wrapped);
    });
  }
  activeJudges++;
}
function releaseJudgeSlot(): void {
  activeJudges--;
  const next = judgeSemaphore.shift();
  if (next) next();
}

// 日志工具
const LOG_PREFIX = '[eval]';
function ts(): string { return new Date().toISOString().substring(11, 19); }
function logInfo(msg: string) { console.log(LOG_PREFIX + ' ' + ts() + ' ' + msg); }
function logWarn(msg: string) { console.warn(LOG_PREFIX + ' [WARN] ' + ts() + ' ' + msg); }
function logError(msg: string) { console.error(LOG_PREFIX + ' [ERROR] ' + ts() + ' ' + msg); }

// ═══════════ SSE 进度协议（eval-server.ts 逐行解析）═══════════
// 格式: [EVAL-SSE] {"type":"question_start"|"question_done"|"metric_done"|"phase"|"log", ...}
// CLI 直跑时仅多一行注释式输出，不影响任何既有消费逻辑
function emitProgress(evt: unknown) {
  console.log('[EVAL-SSE] ' + JSON.stringify(evt));
}
// 指标名 → 维度编号（SSE 事件里带 cat 供前端分组着色）
const METRIC_CAT_MAP: Record<string, string> = {
  context_recall: 'A1', context_precision: 'A2', context_relevancy: 'A3', entity_utilization: 'A4',
  mrr: 'A5', ndcg: 'A6', context_diversity: 'A7', cross_doc_coverage: 'A8',
  context_json_contamination: 'A9', paper_hit: 'A10', paper_recall_at_k: 'A11', source_grounded: 'A12',
  answer_correctness: 'B1', answer_completeness: 'B2', answer_relevancy: 'B3', faithfulness: 'B4',
  hallucination_rate: 'B5', factual_consistency: 'B6', citation_f1: 'B7', conciseness: 'B8',
  answer_readability: 'B9', cot_quality: 'C1', multi_hop_accuracy: 'C2', reasoning_depth: 'C3',
  stage2_latency_norm: 'D1', stage3_latency_norm: 'D2', stage4_latency_norm: 'D3', end_to_end_norm: 'D4',
  token_efficiency: 'D5', neo4j_query_norm: 'D6', pg_query_norm: 'D7',
  stage2_latency_ms: 'D-raw', stage3_latency_ms: 'D-raw', stage4_latency_ms: 'D-raw',
  end_to_end_latency_ms: 'D-raw', neo4j_query_count: 'D-raw', pg_query_count: 'D-raw',
};
function clip(s: string | undefined | null, maxLen: number): string {
  if (!s) return '';
  return s.length <= maxLen ? s : s.substring(0, maxLen) + '[TRUNCATED]';
}

if (!(AbortSignal as any).timeout) {
  logError('Node.js >= 18 required (AbortSignal.timeout missing)');
  process.exit(1);
}

// ═══════════ 预编译正则 ═══════════
const RE_YAML_FRONTMATTER = /^---[\s\S]*?---\s*/;
const RE_MD_RETURN_LINK = /^\*\*← 返回：\*\*.*?\n\n/m;
const RE_NON_ALPHANUM = /[^一-龥a-zA-Z0-9\s]/g;
const RE_JSON_BLOCK = /^```json\s*/;
const RE_JSON_TRAIL = /\s*```$/;
const RE_JSON_OBJECT = /{[\s\S]*}/;
const RE_JSON_ARRAY = /\[.*?\]/s;
const RE_NUM_EXTRACT = /\b([01](?:\.\d+)?)\b/;
const RE_REFUSAL = /抱歉|无法回答|未找到|信息不足|知识库中未找到/;
const RE_PAPERTITLE = /paperTitle:\s*(.+)/;
const RE_TITLE_LINE = /^title:\s*(.+)/m;
const RE_SECTION_SPLIT = /\n## /;
const RE_STRUCTURED_STEPS = /(?:第[一二三四五六七八九十]+[，、]|步骤\s*\d+|[\[ ](?i:Step)\s*\d+[\] ]|[①-⑨]|（\d+）|[（(][一二三四五六七八九十]+[)）]|\*\*[一二三四五六七八九十]+、|\*\*[1-9]\.|[1-9][.、]|^[一二三四五六七八九十]+[、])/gm;

// ====================== TS 类型定义 ======================
interface MetricItem {
  score: number | null;
  rule_score?: number | null;
  llm_score?: number | null;
  reason?: string;
  source?: 'rule' | 'judge' | 'mixed' | 'raw';
  variance_warning?: boolean;
  eval_failed?: boolean;
}
interface SampleEvalResult {
  question_id: string;
  question_type: string;
  overall: number;
  dimA: number;
  dimB: number;
  dimC: number;
  dimD: number;
  metrics: Record<string, MetricItem>;
  meta?: { lowConfidence?: boolean; variance?: number };
  hypothesis?: string;
  fusedContext?: string;
  entity_names?: string[];
  _debugCoarse?: any;
  _debugRefined?: any;
  error?: string;
}

// 全局常量
const MAX_CONTEXT_LEN = 6000;
const MAX_HYP_LEN = 1500;
const JUDGE_TIMEOUT_MS = parseInt(process.env.EVAL_JUDGE_TIMEOUT_MS || '60000', 10);  // V388: judge超时可配置(pro模型需更长)
const JUDGE_MAX_TOKENS = 5000;
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '18000000', 10);  // V388: 默认30分钟, 与服务端3000s超时对齐
const TOP_K = 15;
const CHUNK_TEXT_PREVIEW = 800;
const CHUNK_TEXT_MID = 200;
const CHUNK_TEXT_A8 = 300;
const A2_CONTENT_MID_LEN = 300;
const A3_SECTION_LEN = 800;
const A4_FC_LEN = 2000;
const A5_GOLD_LEN = 500;
const A8_SAMPLE_COUNT = 8;
const A4_LLM_MAX = 6;
const NDCG_TOP = 9;
const A3_MAX_SECTIONS = 8;
const DIM_WEIGHTS = { A: 0.40, B: 0.35, C: 0.25, D: 0.00 };
const IQR_THRESHOLD = parseFloat(process.env.IQR_THRESHOLD || '0.3');
const MAX_SEMAPHORE_QUEUE = parseInt(process.env.JUDGE_MAX_QUEUE || '50', 10);
const BATCH_FALLBACK_DELAY_MS = parseInt(process.env.BATCH_FALLBACK_DELAY || '100', 10);
const MAX_LATENCY_S2 = 30000;
const MAX_LATENCY_S3 = 60000;
const MAX_LATENCY_S4 = 40000;
const MAX_E2E = 90000;
const MAX_NEO4J_QUERY = 20;
const MAX_PG_QUERY = 15;

/** 统一区间钳位 [0,1] */
function clampScore(n: number | null): number | null {
  if (n === null) return null;
  if (isNaN(n) || !isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

/** 原子写入JSON；写完后清理tmp */
function safeSaveJSON(filePath: string, data: unknown) {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try { renameSync(tmp, filePath); } catch { writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8'); }
  try { unlinkSync(tmp); } catch (err) { logWarn('无法清理临时文件 ' + tmp + ': ' + String(err)); }
}

// ═══════════ P0-1: 逐题分数导出（供 significance.ts 配对检验 / failure-attribution.ts 归因）═══════════
// 每题输出四维分数(a/b/c/d) + overall + 达标标记(overall>=0.55) + 归因证据(low_metrics/answer/fused_context_head)，
// 按 Q01..Q50 顺序写入 eval_32metrics_perq.json
// 新增文件，不动 eval_32metrics.json 主结构（保持 EvalPanel 兼容）
const PERQ_OUTPUT = process.env.EVAL_PERQ_OUTPUT || 'eval_32metrics_perq.json';
function savePerQuestionScores(results: SampleEvalResult[]) {
  try {
    const valid = results.filter(r => !r.error);
    const perq = valid.map(r => {
      // 归因证据: 低分指标(<0.55)名列表 + 答案头部 + fusedContext 头部(供 failure-attribution 引用)
      const lowMetrics = Object.entries(r.metrics || {})
        .filter(([, m]) => typeof m.score === 'number' && m.score < 0.55)
        .map(([k, m]) => `${k}=${(m.score as number).toFixed(2)}`);
      return {
        question_id: r.question_id,
        question_type: r.question_type,
        overall: r.overall,
        dimA: r.dimA, dimB: r.dimB, dimC: r.dimC, dimD: r.dimD,
        passed: r.overall >= 0.55,   // 达标标记（significance.ts 配对 McNemar 用）
        eval_error: false,
        low_metrics: lowMetrics.slice(0, 12),        // 归因证据1: 低分指标
        answer: (r.hypothesis || '').substring(0, 500), // 归因证据2: 答案头部
        fused_context_head: (r.fusedContext || '').substring(0, 400), // 归因证据3: 检索上下文头部
      };
    });
    // 保留 error 条目的题号（significance.ts 需要知道哪些题配对缺失）
    const errored = results.filter(r => r.error).map(r => ({ question_id: r.question_id, question_type: r.question_type, overall: 0, dimA: 0, dimB: 0, dimC: 0, dimD: 0, passed: false, eval_error: true }));
    safeSaveJSON(PERQ_OUTPUT, { generated_at: new Date().toISOString(), question_count: valid.length + errored.length, questions: [...perq, ...errored] });
    logInfo('逐题分数已导出: ' + PERQ_OUTPUT + ' (' + perq.length + ' 题有效)');
  } catch (e: any) {
    logWarn('savePerQuestionScores 失败(不影响主结果): ' + String(e).substring(0, 80));
  }
}

/** 安全 fetch：独立 AbortController（V388: 改用原生 http 模块, 规避 Node 24 fetch(undici) 内置 5 分钟 headersTimeout）
 *  — 服务器推理重题 >5 分钟时 undici 会强制断连报 fetch failed, 而服务器端仍在正常处理
 *  — http.request 无此默认超时, 只有我们的 30 分钟 AbortController
 */
async function safeFetch(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const u = new URL(url);
    const isHttp = u.protocol === 'http:' || u.protocol === 'https:';
    if (!isHttp) throw new Error('unsupported protocol: ' + u.protocol);
    const mod = u.protocol === 'http:' ? http : https;
    const bodyStr = (typeof options.body === 'string') ? options.body : JSON.stringify(options.body || {});
    const headers: Record<string, string> = { 'Content-Type': (options.headers as any)?.['Content-Type'] || 'application/json' };
    for (const [k, v] of Object.entries((options.headers as any) || {})) { if (k !== 'Content-Type') headers[k] = String(v); }
    if (bodyStr && !headers['Content-Length']) headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    const raw = await new Promise<any>((resolve, reject) => {
      const req = mod.request(u, {
        method: (options.method || 'GET').toUpperCase(),
        headers,
        signal: controller.signal,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, buf: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
    const textCache = raw.buf.toString('utf8');
    return {
      ok: raw.ok,
      status: raw.status,
      text: async () => textCache,
      json: async () => JSON.parse(textCache),
      headers: new Headers(),
    } as unknown as Response;
  } finally { clearTimeout(timer); }
}

/** 安全释放 slot */
async function withJudgeSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireJudgeSlot();
  const t0 = Date.now();
  try { return await fn(); }
  finally {
    const held = Date.now() - t0;
    if (held > JUDGE_TIMEOUT_MS * 1.5) logWarn('signal: slot held ' + (held / 1000).toFixed(0) + 's (possible leak)');
    releaseJudgeSlot();
  }
}

// V381: Judge 模型可配置（EVAL_JUDGE_MODEL 覆盖，默认 deepseek-v4-flash；可选 deepseek-v4-pro/qwen3.7-max）
const JUDGE_LLM_MODEL = process.env.EVAL_JUDGE_MODEL || 'deepseek-v4-flash';
// V381: Judge 端点/Key 独立可配（多源评测——选 qwen3.7-max 时走 DashScope）
const JUDGE_URL = process.env.EVAL_JUDGE_BASE_URL || DS_URL;
const JUDGE_KEY = process.env.EVAL_JUDGE_API_KEY || DEEPSEEK_KEY;

// ====================== LLM 底层请求封装 ======================
/** 单指标打分（无锁） */
async function _llmJudgeOnce(prompt: string): Promise<{ score: number | null; reason?: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fullPrompt = prompt + '\n严格返回JSON：{"score":0~1浮点数,"reason":"一句话说明依据"}';
      const res = await safeFetch(JUDGE_URL, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + JUDGE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: JUDGE_LLM_MODEL, messages: [{ role: 'user', content: fullPrompt }], temperature: 0, max_tokens: JUDGE_MAX_TOKENS }),
      }, JUDGE_TIMEOUT_MS);
      const rawResp: any = await res.json();
      const rawText = rawResp.choices?.[0]?.message?.content || '';
      const cleaned = rawText.trim().replace(RE_JSON_BLOCK, '').replace(RE_JSON_TRAIL, '');
      try { const obj = JSON.parse(cleaned); if (typeof obj.score === 'number') return { score: clampScore(obj.score)!, reason: obj.reason }; } catch {}
      const numMatch = cleaned.match(RE_NUM_EXTRACT);
      if (numMatch) return { score: clampScore(parseFloat(numMatch[1]))!, reason: '纯数字提取' };
      if (attempt === 0) continue;
      return { score: null, reason: '解析失败' };
    } catch (err) {
      if (attempt === 0) {
        const cls = classifyLLMError(err);
        logWarn('llmJudgeOnce retry: ' + cls + ' — ' + String(err).substring(0, 60));
        if (cls === 'RateLimit') await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
        continue;
      }
      return { score: null, reason: classifyLLMError(err) };
    }
  }
  return { score: null, reason: '解析失败' };
}

function classifyLLMError(err: any): string {
  const msg = String(err).toLowerCase();
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid api key')) return 'AuthError';
  if (msg.includes('429') || msg.includes('rate limit')) return 'RateLimit';
  if (msg.includes('timeout') || msg.includes('abort')) return 'Timeout';
  if (msg.includes('econnrefused') || msg.includes('enotfound')) return 'NetworkError';
  return 'UnknownError';
}

/** 带锁版本 */
async function llmJudgeSingle(prompt: string): Promise<{ score: number | null; reason?: string }> {
  return await withJudgeSlot(() => _llmJudgeOnce(prompt));
}

/** 批量多指标评测 */
async function llmJudgeBatchObject(prompt: string): Promise<Record<string, number>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await withJudgeSlot(async () => {
      try {
        const fullPrompt = prompt + '\n【强制JSON】只返回{"key":分数}格式，key必须是指标名，value是0~1浮点数。禁止其他文字。\n';
        const res = await safeFetch(DS_URL, {
          method: "POST",
          headers: { "Authorization": "Bearer " + DEEPSEEK_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ model: JUDGE_LLM_MODEL, messages: [{ role: "user", content: fullPrompt }], temperature: 0, max_tokens: 2000 }),
        }, JUDGE_TIMEOUT_MS);
        const rawResp: any = await res.json();
        const rawText = rawResp.choices?.[0]?.message?.content || "";
        const cleaned = rawText.trim().replace(RE_JSON_BLOCK, "").replace(RE_JSON_TRAIL, "");
        const jsonMatch = cleaned.match(RE_JSON_OBJECT);
        if (!jsonMatch) return null;
        const parsed = JSON.parse(jsonMatch[0]);
        const output: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed)) { if (typeof v === "number") output[k] = clampScore(v)!; }
        return output;
      } catch { return null; }
    });
    if (result !== null) return result;
    if (attempt === 0) continue;
  }
  return {};
}

/** 请求返回数字数组（用于A2 chunk相关性）；解析失败自动重试1次 */
async function llmJudgeArray(prompt: string): Promise<number[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await withJudgeSlot(async () => {
      try {
        const fullPrompt = prompt + '\n只返回一维JSON数组，1代表相关，0代表无关，无任何额外文字';
        const res = await safeFetch(DS_URL, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + DEEPSEEK_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: JUDGE_LLM_MODEL, messages: [{ role: 'user', content: fullPrompt }], temperature: 0, max_tokens: 400 }),
        }, JUDGE_TIMEOUT_MS);
        const rawResp: any = await res.json();
        const rawText = rawResp.choices?.[0]?.message?.content || '';
        const cleaned = rawText.trim().replace(RE_JSON_BLOCK, '').replace(RE_JSON_TRAIL, '');
        const arrMatch = cleaned.match(RE_JSON_ARRAY);
        if (!arrMatch) return null;
        const arr = JSON.parse(arrMatch[0]);
        return Array.isArray(arr) ? arr : null;
      } catch { return null; }
    });
    if (result !== null) return result;
    if (attempt === 0) continue;
  }
  return null;
}

// ====================== 规则工具函数 ======================
function computeMRR(chunks: string[], goldKeywords: string[]): { mrr: number; firstRelevantRank: number } {
  for (let i = 0; i < chunks.length; i++) {
    for (const kw of goldKeywords) { if (chunks[i].includes(kw)) return { mrr: 1 / (i + 1), firstRelevantRank: i + 1 }; }
  }
  return { mrr: 0, firstRelevantRank: chunks.length + 1 };
}
function computeNDCG(chunks: string[], goldKeywords: string[]): number {
  let dcg = 0;
  for (let i = 0; i < chunks.length; i++) {
    let relevant = 0;
    for (const kw of goldKeywords) if (chunks[i].includes(kw)) { relevant = 1; break; }
    dcg += relevant / Math.log2(i + 2);
  }
  const idcg = 1 / Math.log2(2);
  return idcg > 0 ? dcg / idcg : 0;
}

function normalizeReverse(val: number, maxThreshold: number): number {
  if (val <= 0) return 1;
  return Math.max(0, 1 - val / maxThreshold);
}

/** 三轮采样取中位数；用IQR判断离散度 */
async function runThreeRoundMedian<T>(runner: () => Promise<T>, extract: (res: T) => number | null): Promise<{ median: number | null; variance: number; warning: boolean; sample_count: number }> {
  const vals: number[] = [];
  for (let i = 0; i < 3; i++) {
    const ret = await runner();
    const s = extract(ret);
    if (s !== null) vals.push(s);
  }
  if (vals.length === 0) return { median: null, variance: 0, warning: false, sample_count: 0 };
  vals.sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  const q1 = vals[Math.floor(vals.length * 0.25)];
  const q3 = vals[Math.floor(vals.length * 0.75)];
  const iqr = vals.length >= 3 ? q3 - q1 : (vals.length >= 2 ? vals[vals.length - 1] - vals[0] : 0);
  return { median, variance: iqr, warning: iqr > IQR_THRESHOLD, sample_count: vals.length };
}

// ====================== 核心评测入口 ======================
async function evalSingleSample(q: any, result: any): Promise<Record<string, MetricItem>> {
  const trace = result.trace || {};
  let hypothesis = trace.hypothesis?.content || '';
  // V95: 递归解包 JSON 格式的 hypothesis (如 {content: '{content: ...}'} 双层嵌套)
  for (let depth = 0; depth < 3; depth++) {
    const trimmed = hypothesis.trim();
    if (!trimmed.startsWith('{')) break;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        const inner = parsed.content || parsed.text || parsed.result || parsed.answer;
        if (typeof inner === 'string' && inner.length > 10) {
          hypothesis = inner;
          continue;
        }
        // 如果是纯对象但没有 content 字段, 取 JSON 原文
        break;
      }
      break;
    } catch { break; }
  }

  let fusedContext = trace.fusedContext || '';
  try {
    const parsed = JSON.parse(fusedContext);
    if (typeof parsed === 'object' && parsed !== null) fusedContext = parsed.content || parsed.text || parsed.result || parsed.answer || JSON.stringify(parsed);
  } catch {}

  const timings = trace.timings || {};
  const entityNames: string[] = trace.entityNames || [];
  const dc = trace._debugCoarse || result._debugCoarse || {};
  const dr = trace._debugRefined || result._debugRefined || {};
  const metrics: Record<string, MetricItem> = {};
  const runAllDims = (EVAL_DIMS.length === 0);
  // SSE 逐指标事件：Proxy 拦截 set —— 每个指标落定即推送（每行: key|cat|score|source），零侵入
  const metricProxy = new Proxy(metrics, {
    set(target, prop, value: MetricItem) {
      target[prop as string] = value;
      emitProgress({
        type: 'metric_done',
        question: q.id,
        key: prop as string,
        cat: METRIC_CAT_MAP[prop as string] || 'D',
        score: typeof value.score === 'number' ? value.score : null,
        rule_score: typeof value.rule_score === 'number' ? value.rule_score : null,
        llm_score: typeof value.llm_score === 'number' ? value.llm_score : null,
        source: value.source || 'rule',
        reason: value.reason || null,
      });
      return true;
    }
  });

  // ========== A 维度 ==========
  if (runAllDims || EVAL_DIMS.includes('A')) {
  const goldEntities: string[] = q.gold_entities || [];
  const fcForRecall = fusedContext;
  if (goldEntities.length > 0) {
    let embeddingFailed = false;
    const fcNorm = fcForRecall.trim();
    let totalWeight = 0;
    let weightedHits = 0;
    const unmatched: Array<{ entity: string; weight: number }> = [];
    for (const g of goldEntities) {
      const isCore = g.length >= 4 && !/^\d/.test(g);
      const weight = isCore ? 2 : 1;
      totalWeight += weight;
      const gNorm = g.trim();
      if (fcNorm.includes(gNorm)) { weightedHits += weight; continue; }
      const esc = gNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?:^|[^一-龥])${esc}(?:$|[^一-龥])`).test(fcNorm)) { weightedHits += weight; continue; }
      const goldChars = new Set(gNorm.replace(/\s/g, '').split(''));
      const fcCharsSet = new Set(fcNorm.replace(/\s/g, '').split(''));
      const overlap = [...goldChars].filter(c => fcCharsSet.has(c)).length;
      if (overlap >= goldChars.size * 0.8) { weightedHits += weight * 0.7; continue; }
      unmatched.push({ entity: gNorm, weight });
    }
    // embedding 语义兜底 (受信号量管控)
    let embeddingBonus = 0;
    if (unmatched.length > 0 && EMBEDDING_KEY && !process.env.EMBED_DISABLE) {
      try {
        await acquireJudgeSlot();
        try {
          for (let embAttempt = 0; embAttempt < 2; embAttempt++) {
            try {
              const embResp = await safeFetch(EMBEDDING_URL + '/embeddings', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + EMBEDDING_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: EMBEDDING_MODEL, input: [fcNorm.substring(0, 4000), ...unmatched.map(u => u.entity)] }),
              }, 30000);
              const ej = await embResp.json();
              const vecs: number[][] = (ej?.data || []).map((d: any) => d.embedding).filter((e: any) => Array.isArray(e) && e.length > 0);
              if (vecs.length >= 2) {
                const fcVec = vecs[0];
                const fcNorm2 = Math.sqrt(fcVec.reduce((s: number, v: number) => s + v * v, 0));
                for (let i = 0; i < Math.min(unmatched.length, vecs.length - 1); i++) {
                  const eVec = vecs[i + 1];
                  if (!Array.isArray(eVec)) continue;
                  const eNorm = Math.sqrt(eVec.reduce((s: number, v: number) => s + v * v, 0));
                  const dot = fcVec.reduce((s: number, v: number, j: number) => s + v * (eVec[j] || 0), 0);
                  if (fcNorm2 > 0 && eNorm > 0 && dot / (fcNorm2 * eNorm) >= 0.85) embeddingBonus += unmatched[i].weight * 0.7;
                }
              }
              break;
            } catch (e) {
              if (embAttempt === 0) { logWarn('A1 embedding retry: ' + String(e).substring(0, 60)); continue; }
              embeddingFailed = true;
              logWarn('A1 embedding fail: ' + String(e).substring(0, 80));
            }
          }
        } finally { releaseJudgeSlot(); }
      } catch (e) { embeddingFailed = true; logWarn('A1 embedding slot error: ' + String(e).substring(0, 80)); }
    }
    weightedHits += embeddingBonus;
    const structuralRecall = totalWeight > 0 ? weightedHits / totalWeight : 0;
    const promptA1 = `问题：${q.question}\n标准答案：${q.gold_answer}\n检索上下文：${fcForRecall.substring(0, MAX_CONTEXT_LEN)}
评估上下文覆盖金标答案关键信息点程度。结构化匹配基准值：${structuralRecall.toFixed(2)}`;
    const a1Res = await withJudgeSlot(() => runThreeRoundMedian(() => _llmJudgeOnce(promptA1), d => d.score));
    metricProxy.context_recall = { score: mergeScore(structuralRecall, a1Res.median), rule_score: structuralRecall, llm_score: a1Res.median, source: 'mixed' };
    if (embeddingFailed) metricProxy.context_recall.eval_failed = true;
    if (a1Res.warning) metricProxy.context_recall.variance_warning = true;
    if (a1Res.sample_count < 3) metricProxy.context_recall.eval_failed = true;
  } else {
    const promptA1 = `问题：${q.question}\n标准答案：${q.gold_answer}\n检索上下文：${fcForRecall.substring(0, MAX_CONTEXT_LEN)}
评估上下文覆盖金标答案关键信息点程度。0=无覆盖，1=完全覆盖`;
    const a1Res = await withJudgeSlot(() => runThreeRoundMedian(() => _llmJudgeOnce(promptA1), d => d.score));
    metricProxy.context_recall = { score: a1Res.median, rule_score: null, llm_score: a1Res.median, source: 'judge' };
    if (a1Res.warning) metricProxy.context_recall.variance_warning = true;
    if (a1Res.sample_count < 3) metricProxy.context_recall.eval_failed = true;
  }

  // A2
  const allChunks: Array<{ text: string; engine: string }> = [];
  for (const c of (dc.chunks || [])) if (c?.hasText) allChunks.push({ text: c.textPreview || '', engine: 'cognee' });
  for (const c of (dc.pgChunks || [])) if (c?.hasText) allChunks.push({ text: c.textPreview || '', engine: 'pgvector' });
  if (allChunks.length > 0) {
    const chunkCount = Math.min(allChunks.length, 10);
    const qKeywords = (q.question || '').replace(RE_NON_ALPHANUM, ' ').split(/\s+/).filter((w: string) => w.length >= 3).slice(0, 6);
    const aKeywords = (q.gold_answer || '').replace(RE_NON_ALPHANUM, ' ').split(/\s+/).filter((w: string) => w.length >= 3).slice(0, 4);
    const goldKeywords = [...new Set([...qKeywords, ...aKeywords])];
    let kwHitCnt = 0;
    for (let i = 0; i < chunkCount; i++) { if (goldKeywords.some((kw: string) => allChunks[i].text.includes(kw))) kwHitCnt++; }
    const a2Rule = kwHitCnt / chunkCount;
    let relevantCnt = 0;
    for (let i = 0; i < chunkCount; i++) {
      const c = allChunks[i];
      const cleanText = c.text.replace(RE_YAML_FRONTMATTER, '').replace(RE_MD_RETURN_LINK, '');
      const midStart = Math.max(0, Math.floor(cleanText.length/2 - 150));
      const contentPreview = cleanText.substring(midStart, midStart + 300);
      const p = '判断以下分块与问题的相关程度(输出0~1之间的小数，不是0/1):\n问题: ' + q.question + '\n分块[' + i + '](' + c.engine + '): ' + contentPreview + '\n评分标准:\n- 0.8-1.0: 分块包含回答问题所需的关键信息\n- 0.4-0.7: 分块与问题领域相关, 但主要是背景信息而非直接答案\n- 0.0-0.3: 分块与问题几乎无关, 或主要是文件元数据(YAML/返回链接/目录)\n只输出一个0~1之间的数字分数。';
      const res = await llmJudgeSingle(p);
      if (res.score !== null && res.score > 0) relevantCnt += Math.min(1, res.score);
    }
    const a2Llm = relevantCnt / chunkCount;
    metricProxy.context_precision = { score: mergeScore(a2Rule, a2Llm), rule_score: a2Rule, llm_score: a2Llm, source: 'mixed' };
  } else {
    metricProxy.context_precision = { score: 0, rule_score: 0, llm_score: null, source: 'rule' };
  }

  // A3 — V42修复: 整体语义评估替代逐section打分, 避免信息碎片化丢分
  if (fcForRecall.length > 10) {
    const goldKeywords2 = (q.gold_answer || '').replace(RE_NON_ALPHANUM, ' ').split(/\s+/).filter((w: string) => w.length >= 2).slice(0, 12);
    let kwDensity = 0;
    for (const kw of goldKeywords2) { const matches = fcForRecall.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')); if (matches) kwDensity += matches.length; }
    const a3Rule = Math.min(1, kwDensity / Math.max(1, fcForRecall.length / 50));
    // V42: 整体语义评估 — 把整个fusedContext(截断6000)一次性给LLM, 评估与金标的语义覆盖度
    const pA3 = '你是RAG检索质量评测专家。\n问题：' + q.question + '\n标准答案：' + q.gold_answer + '\n检索上下文(融合后)：' + fcForRecall.substring(0, MAX_CONTEXT_LEN) + '\n请评估: 检索上下文中有多大比例的内容对回答该问题有实质信息价值?\n- 1.0: 几乎全部内容直接相关且信息丰富\n- 0.7: 大部分相关,有少量背景/噪声\n- 0.4: 约一半相关,一半噪声\n- 0.0: 几乎全是噪声或无关内容\n只输出一个0~1浮点数。';
    const a3LlmRes = await llmJudgeSingle(pA3);
    const a3Llm = a3LlmRes.score !== null ? a3LlmRes.score : 0;
    metricProxy.context_relevancy = { score: mergeScore(a3Rule, a3Llm), rule_score: a3Rule, llm_score: a3Llm, source: 'mixed' };
  } else {
    metricProxy.context_relevancy = { score: 0, source: 'rule' };
  }

  // A4
  const allEntityNames: string[] = [];
  for (const e of entityNames.slice(0, 20)) allEntityNames.push(e);
  for (const e of (dr.entities || []).concat(dr.hybridEntities || [])) if (e?.name) allEntityNames.push(e.name);
  const uniqueEntities = [...new Set(allEntityNames)].filter(n => n && n.length >= 2);
  const normalize = (s: string) => s.toLowerCase().replace(/[^一-龥a-z0-9]/g, '').trim();
  if (uniqueEntities.length > 0) {
    let hit = 0;
    const fcText = fusedContext;
    const fcNorm = normalize(fcText);
    const unmatchedNames: string[] = [];
    for (const name of uniqueEntities) {
      if (fcText.includes(name) || (normalize(name).length >= 3 && fcNorm.includes(normalize(name)))) { hit++; }
      else { unmatchedNames.push(name); }
    }
    let llmHits = 0;
    for (const name of unmatchedNames.slice(0, A4_LLM_MAX)) {
      const p = '实体: ' + name + '\n上下文(前2000字): ' + fcText.substring(0, A4_FC_LEN) + '\n此实体概念是否在上文中被讨论或蕴含? 输出0(未被讨论)到1(明确讨论)之间的小数。';
      const res = await llmJudgeSingle(p);
      if (res.score !== null) llmHits += res.score;
    }
    const a4Rule = hit / uniqueEntities.length;
    const a4Llm = (hit + llmHits) / uniqueEntities.length;
    metricProxy.entity_utilization = { score: mergeScore(a4Rule, a4Llm), rule_score: a4Rule, llm_score: a4Llm, source: 'mixed' };
  } else {
    metricProxy.entity_utilization = { score: 0, source: 'rule' };
  }

  // A5 + A6 — V42修复: chunk来源扩展(Cognee+PG), gold关键词放宽, MRR阈值降低
  const dcChunks: string[] = (dc.chunks || []).filter((c: any) => c?.hasText).map((c: any) => c.textPreview || '');
  const dcPgChunks: string[] = (dc.pgChunks || []).filter((c: any) => c?.hasText).map((c: any) => c.textPreview || '');
  const chunkTexts: string[] = [...dcChunks, ...dcPgChunks].slice(0, TOP_K);
  if (chunkTexts.length > 0) {
    let a5Rule = 0;
    // V42: gold关键词放宽到2字词+12个(原3字词+8个), 增加中部文本匹配补漏
    const gkA5 = (q.gold_answer || '').replace(RE_NON_ALPHANUM, ' ').split(/\s+/).filter((w: string) => w.length >= 2).slice(0, 12);
    for (let i = 0; i < Math.min(chunkTexts.length, 9); i++) {
      const mid = chunkTexts[i].length > 500 ? chunkTexts[i].substring(Math.floor(chunkTexts[i].length/2-100), Math.floor(chunkTexts[i].length/2+100)) : '';
      if (gkA5.some((kw: string) => chunkTexts[i].includes(kw) || mid.includes(kw))) { a5Rule = 1 / (i + 1); break; }
    }
    const goldText = q.gold_answer || '';
    const evalCount = Math.min(chunkTexts.length, NDCG_TOP);
    const similarities: number[] = [];
    for (let i = 0; i < evalCount; i++) {
      const p = '评估chunk与金标的语义相关度(0=无关,1=匹配): 金标: ' + goldText.substring(0, A5_GOLD_LEN) + ' Chunk[' + i + ']: ' + chunkTexts[i].substring(0, CHUNK_TEXT_PREVIEW) + ' 只输出0~1小数。';
      const res = await llmJudgeSingle(p);
      similarities.push(res.score !== null ? res.score : 0);
    }
    let a5Llm = 0;
    // V42: MRR相关度阈值 0.5→0.25, 避免过滤掉弱关联但有信息量的chunk
    for (let i = 0; i < similarities.length; i++) { if (similarities[i] >= 0.25) { a5Llm = 1 / (i + 1); break; } }
    // 软化兜底: 如果所有chunk都<0.25但best>0, 用 best/(bestRank+1) 给分
    if (a5Llm === 0 && similarities.length > 0) {
      let bestSim = 0, bestRank = 0;
      for (let i = 0; i < similarities.length; i++) { if (similarities[i] > bestSim) { bestSim = similarities[i]; bestRank = i + 1; } }
      a5Llm = bestSim > 0 ? bestSim / (bestRank + 1) : 0;
    }
    metricProxy.mrr = { score: mergeScore(a5Rule, a5Llm), rule_score: a5Rule, llm_score: a5Llm, source: 'mixed' };
    let dcgRule = 0;
    // V42: NDCG rule 同步使用中部文本匹配补漏 (与MRR rule保持一致)
    for (let i = 0; i < Math.min(chunkTexts.length, 9); i++) {
      const mid = chunkTexts[i].length > 500 ? chunkTexts[i].substring(Math.floor(chunkTexts[i].length/2-100), Math.floor(chunkTexts[i].length/2+100)) : '';
      const hit = gkA5.some((kw: string) => chunkTexts[i].includes(kw) || mid.includes(kw)) ? 1 : 0;
      dcgRule += hit / Math.log2(i + 2);
    }
    const a6Rule = Math.min(1, dcgRule / (1 / Math.log2(2)));
    let dcg = 0; for (let i = 0; i < similarities.length; i++) { dcg += Math.max(0, similarities[i]) / Math.log2(i + 2); }
    const idcg = 1 / Math.log2(2);
    const a6Llm = Math.min(1, idcg > 0 ? dcg / idcg : 0);
    metricProxy.ndcg = { score: mergeScore(a6Rule, a6Llm), rule_score: a6Rule, llm_score: a6Llm, source: 'mixed' };
  } else {
    metricProxy.mrr = { score: 0, source: 'rule' };
    metricProxy.ndcg = { score: 0, source: 'rule' };
  }

  // A7
  const chunkMidTexts: string[] = [];
  for (const c of (dc.chunks || [])) {
    if (c?.hasText) { const t = (c.textPreview || '').replace(RE_YAML_FRONTMATTER, ''); const mid = t.length > 400 ? t.substring(Math.floor(t.length/2-100), Math.floor(t.length/2+100)) : t; chunkMidTexts.push(mid.replace(/\s+/g,' ').trim()); }
  }
  for (const c of (dc.pgChunks || [])) {
    if (c?.hasText) { const t = (c.textPreview || '').replace(RE_YAML_FRONTMATTER, ''); const mid = t.length > 400 ? t.substring(Math.floor(t.length/2-100), Math.floor(t.length/2+100)) : t; chunkMidTexts.push(mid.replace(/\s+/g,' ').trim()); }
  }
  const diversitySet = new Set(chunkMidTexts);
  const a7Rule = chunkMidTexts.length > 0 ? diversitySet.size / chunkMidTexts.length : 0;
  let a7Llm: number | null = null;
  if (Math.min(chunkMidTexts.length, 8) >= 2) {
    const sample = chunkMidTexts.slice(0, 8);
    const p = '判断片段独立信息占比(0=重复,1=独立)。只输出0~1小数。\n' + sample.map((t, i) => '[' + i + ']' + t.substring(0, 200)).join('\n');
    const res = await llmJudgeSingle(p);
    if (res.score !== null) a7Llm = res.score;
  }
  metricProxy.context_diversity = { score: mergeScore(a7Rule, a7Llm), rule_score: a7Rule, llm_score: a7Llm, source: 'mixed' };

  // A8
  const docSet = new Set<string>();
  for (const c of (dc.chunks || [])) { if (c?.hasText) { const t = c.textPreview || ''; const m = t.match(RE_PAPERTITLE) || t.match(RE_TITLE_LINE); if (m) docSet.add(m[1].trim()); } }
  for (const c of (dc.pgChunks || [])) { if (c?.hasText) { const t = c.textPreview || ''; const m = t.match(RE_PAPERTITLE) || t.match(RE_TITLE_LINE); if (m) docSet.add(m[1].trim()); } }
  const a8Rule = Math.min(1, docSet.size / 5);
  let a8Llm: number | null = null;
  if (allChunks.length > 0) {
    const sample = allChunks.slice(0, Math.min(A8_SAMPLE_COUNT, allChunks.length)).map((c, i) => '[' + i + ']' + c.text.substring(0, CHUNK_TEXT_A8)).join('\n');
    const p = '识别检索片段来源于几篇不同独立论文?首先判断大约几篇(如果判断5篇及以上则按5篇计), 然后用 篇数÷5 得出0~1之间的小数(如1篇→0.2, 3篇→0.6), 只输出一个0~1浮点数, 严禁输出整数。\n' + sample;
    const res = await llmJudgeSingle(p);
    if (res.score !== null) a8Llm = Math.min(1, res.score);
  }
  metricProxy.cross_doc_coverage = { score: mergeScore(a8Rule, a8Llm), rule_score: a8Rule, llm_score: a8Llm, source: 'mixed' };

  // A9 — context_json_contamination: 检测 fusedContext 是否混入 JSON/YAML/元数据等非语义噪音
  const fcLines = fcForRecall.split('\n').filter((l: string) => l.trim().length > 0);
  const totalLines = fcLines.length;
  if (totalLines > 0) {
    // 规则层：统计含噪音特征的行数
    const reJsonBlock = /[\{\[][\s\S]*?[\}\]]/;
    const reYamlLine = /^\s*[\w.-]+:\s/;
    const reHighSymbol = /[{}[\]":|\\\/>]{8,}/;        // 一行中8+个特殊符号 → 疑似数据行
    const reMarkdownMeta = /^(---|\*\*← 返回|paperTitle:|title:|created:|updated:|tags:)/;
    let contaminatedLines = 0;
    for (const line of fcLines) {
      const t = line.trim();
      if (reMarkdownMeta.test(t)) { contaminatedLines++; continue; }
      if (reYamlLine.test(t) && t.length < 200 && (t.match(/:/g) || []).length >= 2) { contaminatedLines++; continue; }
      if (reJsonBlock.test(t) && t.length > 20) { contaminatedLines++; continue; }
      const symbolCount = (t.match(/[{}[\]":|\\\/>]/g) || []).length;
      if (symbolCount >= 8 && symbolCount / t.length > 0.3) { contaminatedLines++; continue; }
    }
    const a9Rule = 1 - Math.min(1, contaminatedLines / totalLines);

    // LLM 层：采集疑似污染样本让 LLM 判定
    let a9Llm: number | null = null;
    const suspicious = fcLines.filter((l: string) => {
      const t = l.trim();
      return reJsonBlock.test(t) || reYamlLine.test(t) || reHighSymbol.test(t) || reMarkdownMeta.test(t);
    }).slice(0, 6);
    if (suspicious.length > 0) {
      const sample = suspicious.map((l: string, i: number) => `[${i}] ${l.substring(0, 300)}`).join('\n');
      const p = '以下是从检索上下文中抽取的疑似非语义噪音行（JSON片段/YAML元数据/机器符号）。请判定整个上下文被这类噪音污染的程度，输出0~1小数：\n- 1.0: 全部是自然语言内容，无任何机器噪音\n- 0.7-0.9: 偶有格式化标记但以可读文本为主\n- 0.4-0.6: 噪音和内容混杂各半\n- 0.0-0.3: 大量JSON/YAML/元数据，严重污染\n疑似噪音行：\n' + sample + '\n只输出一个0~1浮点数。';
      const res = await llmJudgeSingle(p);
      if (res.score !== null) a9Llm = res.score;
    } else {
      a9Llm = 1.0; // 没有检测到疑似噪音行，上下文干净
    }
    metricProxy.context_json_contamination = { score: mergeScore(a9Rule, a9Llm), rule_score: a9Rule, llm_score: a9Llm, source: 'mixed' };
  } else {
    metricProxy.context_json_contamination = { score: 1.0, rule_score: 1.0, llm_score: null, source: 'rule' };
  }

  // A10-A12 — paper_id 命中校验分层指标 (V96: 召回相关 ≠ 召回目标论文)
  // 关键: 检索可能召回"语义相关"的其它论文, 但没召回标准答案所属论文 → 这些指标暴露该盲区
  const goldPaperTitle = (q.paper_title || '').trim();
  const goldPaperId = (q.paper_id || '').trim();
  const paperTitleKey = goldPaperTitle
    // 去掉可能的 _作者 后缀用于子串匹配, 但保留完整标题做严格匹配
    ? goldPaperTitle
    : '';
  const normPaper = (s: string) => s.replace(/——|──|—/g, '-').replace(/\s+/g, '').toLowerCase();

  // A10 paper_hit — fusedContext 是否包含目标论文内容 (规则, 二进制)
  // 判定: 目标论文标题变体 出现在 fusedContext 中
  const paperVariants = (() => {
    const vs: string[] = [];
    if (paperTitleKey) {
      vs.push(paperTitleKey);
      // 去 _作者 后缀 (取最后一个 _ 前的部分, 保留副标题)
      const m = paperTitleKey.match(/^(.+?)(?:_[^_]+)$/);
      const noAuthor = m ? m[1].trim() : '';
      if (noAuthor.length >= 6) vs.push(noAuthor);
      // 标题首段 (破折号前)
      const firstSeg = paperTitleKey.split(/[_—]/)[0].trim();
      if (firstSeg.length >= 6) vs.push(firstSeg);
    }
    // 去重 (保持顺序)
    return [...new Set(vs.filter((v: string) => v.length >= 6))];
  })();
  const fcNorm = normPaper(fcForRecall);
  const paperHitInContext = paperVariants.some((v: string) => fcNorm.includes(normPaper(v)));
  const a10Rule = paperHitInContext ? 1 : 0;

  // A11 paper_recall@k — 检索原始结果 (dc.chunks/pgChunks) 中目标论文占比
  // 用论文标题在 chunk 原文中出现与否判断该 chunk 是否属于目标论文
  const paperChunks = allChunks.filter((c: any) => paperVariants.some((v: string) => normPaper(c.text).includes(normPaper(v))));
  const a11Rule = allChunks.length > 0 ? Math.min(1, paperChunks.length / allChunks.length) : 0;

  // A12 source_grounded — 答案是否基于目标论文内容 (而非泛泛猜测/否认)
  // 判定: 若答案明确否认("未提供论文") → 0
  //       若答案引用了目标论文标题 → 1
  //       若 fusedContext 含目标论文 且 答案未否认 → 1 (答案基于检索到的目标论文)
  //       否则 → 0.5 (模糊)
  const hypNorm = normPaper(hypothesis);
  const paperHitInHyp = paperVariants.some((v: string) => hypNorm.includes(normPaper(v)));
  const deniedPaper = /未提供|没有提供|未在对话|无法访问|您并未|无法直接引用|没有明确给出|未收录/.test(hypothesis.substring(0, 300));
  const a12Rule = deniedPaper ? 0 : (paperHitInHyp || a10Rule ? 1 : 0.5);  // a10Rule: fusedContext已含目标论文

  metricProxy.paper_hit = { score: a10Rule, rule_score: a10Rule, llm_score: null, source: 'rule' };
  metricProxy.paper_recall_at_k = { score: a11Rule, rule_score: a11Rule, llm_score: null, source: 'rule' };
  metricProxy.source_grounded = { score: a12Rule, rule_score: a12Rule, llm_score: null, source: 'rule' };

  } // 结束 A 维度

  // ========== B 维度 ==========
  if (runAllDims || EVAL_DIMS.includes('B')) {
  const bDims = [
    { key: "answer_correctness", desc: "答案与标准答案语义一致性，1完全一致。答案比金标更详细且有实质内容不扣分，只要覆盖了金标核心要点即可满分" },
    { key: "answer_completeness", desc: "覆盖标准答案核心要点，拓展不扣分。如果答案包含了金标中所有关键信息点，即使表述更详细也视为满分" },
    { key: "answer_relevancy", desc: "回答是否直接针对提问，无无关发散" },
    { key: "faithfulness", desc: "所有事实陈述均可在检索上下文找到依据" },
    { key: "hallucination_rate", desc: "反幻觉，1无编造事实，0大量虚假信息" },
    { key: "factual_consistency", desc: "回答内部事实逻辑不自相矛盾" },
    { key: "citation_f1", desc: "引用精确度与来源可验证综合得分" },
    { key: "conciseness", desc: "文本简洁程度。回答比金标更详细且有实质内容不扣分。只扣: 明显重复啰嗦、信息冗余、无信息的填充句。详细论述或文献综述风格不扣分" },
    { key: "answer_readability", desc: "文本结构分层、表达清晰度" },
  ];
  const bKeys = bDims.map(d => d.key);
  const bAccum: Record<string, number[]> = {};
  for (const k of bKeys) bAccum[k] = [];
  for (let round = 0; round < 3; round++) {
    const shuffledB = [...bDims];
    for (let i = shuffledB.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffledB[i], shuffledB[j]] = [shuffledB[j], shuffledB[i]]; }
    const bPromptText = `你是RAG评测专家。
问题：${q.question}
标准答案：${q.gold_answer}
AI回答：${hypothesis.substring(0, MAX_HYP_LEN)}

请对以下维度打分：
${shuffledB.map((d, i) => `${i + 1}. ${d.key}: ${d.desc}`).join('\n')}`;
    const bScores = await llmJudgeBatchObject(bPromptText);
    let hasAny = false;
    for (const k of bKeys) { if (typeof bScores[k] === 'number') { bAccum[k].push(bScores[k]); hasAny = true; } }
    if (!hasAny) {
      logWarn('B组 round=' + round + ' batchJudge失败, 降级逐项补评');
      for (const d of bDims) {
        const ctxForB = ['faithfulness','hallucination_rate','citation_f1','factual_consistency'].includes(d.key) ? ' 检索上下文: ' + fusedContext.substring(0, 3000) : '';
        await new Promise(r => setTimeout(r, 50 + Math.random() * BATCH_FALLBACK_DELAY_MS));
        const sj = await llmJudgeSingle('你是RAG专家。请就以下维度评分(0~1数字): ' + d.desc + ' 问题: ' + q.question + ' 金标: ' + q.gold_answer + ' 回答: ' + hypothesis.substring(0, MAX_HYP_LEN) + ctxForB + ' 只返回一个0~1数字');
        if (sj.score !== null) bAccum[d.key].push(sj.score);
      }
    }
  }
  for (const d of bDims) {
    while (bAccum[d.key].length < 3) {
      logWarn('B组 ' + d.key + ' 仅' + bAccum[d.key].length + '条, 补调单评');
      const ctxForB = ['faithfulness','hallucination_rate','citation_f1','factual_consistency'].includes(d.key) ? ' 检索上下文: ' + fusedContext.substring(0, 3000) : '';
      const sj = await llmJudgeSingle('你是RAG专家。请就以下维度评分(0~1数字): ' + d.desc + ' 问题: ' + q.question + ' 金标: ' + q.gold_answer + ' 回答: ' + hypothesis.substring(0, MAX_HYP_LEN) + ctxForB + ' 只返回一个0~1数字');
      bAccum[d.key].push(sj.score ?? 0);
    }
    const vals = bAccum[d.key].sort((a, b) => a - b);
    metricProxy[d.key] = { score: vals.length > 0 ? vals[Math.floor(vals.length / 2)] : null, source: 'judge' };
    if (vals.length < 3) metricProxy[d.key].eval_failed = true;
  }

  // B-cross-verify: factual_consistency 交叉验证
  // 防止 "内部自洽但内容全错" 的情况 (例如faithfulness=0, hallucination_rate=0, 但factual_consistency=1)
  // Q44 V41踩坑: SAG张冠李戴答了另一篇论文, 内部逻辑自洽→给满分, 但答案全错
  const fcScore = metrics.factual_consistency?.score;
  const faithScore = metrics.faithfulness?.score;
  const halluScore = metrics.hallucination_rate?.score;  // 反幻觉: 1=无编造, 0=全是编造
  const correctScore = metrics.answer_correctness?.score;
  if (fcScore !== null && fcScore !== undefined && faithScore !== null && halluScore !== null && correctScore !== null) {
    // 交叉验证条件: factual_consistency很高, 但faithfulness/hallucination/answer_correctness至少两项很低
    const lowCount = [faithScore, halluScore, correctScore].filter(s => (s ?? 0) <= 0.3).length;
    if (fcScore >= 0.75 && lowCount >= 2) {
      // 内部自洽但答案高度幻觉 → 拉低 factual_consistency
      const penalty = 1 - (faithScore + halluScore + correctScore) / 3;
      const adjusted = Math.max(0.1, fcScore * (1 - penalty * 0.7));
      logWarn('B-cross-verify: factual_consistency ' + fcScore.toFixed(2) + ' → ' + adjusted.toFixed(2) +
        ' (faith=' + faithScore.toFixed(2) + ' hallu=' + halluScore.toFixed(2) + ' correct=' + correctScore.toFixed(2) + ')');
      metricProxy.factual_consistency = { ...metricProxy.factual_consistency, score: adjusted, source: 'judge', reason: '交叉验证降权: 内部自洽但faithfulness/hallucination/correctness过低' };
    }
  }
  } // 结束 B 维度

  // ========== C 维度 ==========
  if (runAllDims || EVAL_DIMS.includes('C')) {
  let reasoningText = trace.hypothesis?.reasoning || '';
  if (!reasoningText || reasoningText.length < 20) {
    const steps = hypothesis.match(RE_STRUCTURED_STEPS) || [];
    if (steps.length >= 2) reasoningText = `[从答案推断] 包含${steps.length}个结构化步骤标记: ${steps.slice(0, 5).join(', ')}... 完整回答(前1500字): ${hypothesis.substring(0, 1500)}`;
    else reasoningText = `[无显式推理步骤] 回答采用连贯论述结构, 需从段落逻辑判断推理链完整性。完整回答(前1500字): ${hypothesis.substring(0, 1500)}`;
  }
  // C1 — V42修复: concept/fact 题型 COT disabled, cot_quality=null (与 C2 处理一致)
  if (q.question_type === '概念定义' || q.question_type === '事实检索') {
    metricProxy.cot_quality = { score: null, source: 'rule', reason: "题型不适用(COT disabled)", eval_failed: false };
  } else {
    const promptC1 = `你是COT推理质量评测专家。严格按五级离散刻度打分(只输出: 0/0.25/0.5/0.75/1.0)。5级锚点定义:
  0=完全无推理，仅复述检索内容；
  0.25=有推理意图但逻辑跳跃或断裂，步骤明显不连贯；
  0.5=单步因果推理基本正确，但缺乏中间连接环节；
  0.75=两步推理链清晰：前提→中间→结论，逻辑连贯；
  1.0=三步以上完整推理链，每一步有明确信息源或上下文依据支撑。

  问题：${q.question}
  标准答案：${q.gold_answer}
  AI回答(前800字)：${hypothesis.substring(0, 800)}
  推理线索：${reasoningText.substring(0, 600)}`;
    const cotRes = await withJudgeSlot(() => runThreeRoundMedian(() => _llmJudgeOnce(promptC1), d => d.score));
    metricProxy.cot_quality = { score: cotRes.median, source: 'judge' };
    if (cotRes.warning) metricProxy.cot_quality.variance_warning = true;
    if (cotRes.sample_count < 3) metricProxy.cot_quality.eval_failed = true;
  }

  // C2
  if (q.question_type === '多跳推理') {
    const promptC2 = `多跳推理问题：${q.question}
标准答案：${q.gold_answer}
AI回答：${hypothesis.substring(0, 800)}
严格按5级刻度(0/0.25/0.5/0.75/1.0)评估多跳推理链路：0=完全断裂，0.25=部分跳但关键跳缺失，0.5=基本正确有少量跳跃，0.75=完整推理链，1=完整且每跳有上下文依据`;
    const c2Res = await withJudgeSlot(() => runThreeRoundMedian(() => _llmJudgeOnce(promptC2), d => d.score));
    metricProxy.multi_hop_accuracy = { score: c2Res.median, source: 'judge' };
    if (c2Res.warning) metricProxy.multi_hop_accuracy.variance_warning = true;
    if (c2Res.sample_count < 3) metricProxy.multi_hop_accuracy.eval_failed = true;
  } else {
    metricProxy.multi_hop_accuracy = { score: null, source: 'rule', reason: "题型不适用", eval_failed: false };
  }

  // C3
  const hasRefusal = RE_REFUSAL.test(hypothesis);
  const promptC3 = `你是推理质量评测专家。对以下三项分别评分(均为0/0.25/0.5/0.75/1.0五级刻度)，返回JSON:
1. "logical_coherence": 回答是否存在逻辑跳跃(0=多处跳跃/断裂, 1=完全连贯)
2. "no_implicit_assumption": 是否不依赖隐含假设(0=大量未声明前提, 1=所有前提明确)
3. "refusal_reasonableness": ${hasRefusal ? "信息不足拒答=1, 推脱性拒答=0" : "无拒答=1(视为满分)"}

问题：${q.question}
标准答案：${q.gold_answer}
AI回答：${hypothesis.substring(0, 1000)}

严格返回JSON: {"logical_coherence":0.5,"no_implicit_assumption":0.75,"refusal_reasonableness":1.0}`;
  const c3Scores = await llmJudgeBatchObject(promptC3);
  let c3Vals = [c3Scores.logical_coherence, c3Scores.no_implicit_assumption, c3Scores.refusal_reasonableness].filter(v => v != null);
  if (c3Vals.length === 0) {
    logWarn('C3 batchJudge失败, 回退逐项评分');
    const items = [ ['logical_coherence','回答是否存在逻辑跳跃(0=多处跳跃, 1=完全连贯)'], ['no_implicit_assumption','是否不依赖隐含假设(0=大量未声明前提, 1=所有前提明确)'], ['refusal_reasonableness', hasRefusal ? '信息不足拒答=1, 推脱性拒答=0' : '无拒答=1(视为满分)'] ];
    const fallback: number[] = [];
    for (const [k, desc] of items) {
      const sj = await llmJudgeSingle(`你是推理质量评测专家。请就以下维度评分(0~1,五级刻度0/0.25/0.5/0.75/1.0): ${desc}\n问题: ${q.question}\n金标: ${q.gold_answer}\n回答: ${hypothesis.substring(0, 1000)}\n只返回0~1数字`);
      fallback.push(sj.score ?? 0);
    }
    c3Vals = fallback;
  }
  metricProxy.reasoning_depth = { score: c3Vals.length > 0 ? c3Vals.reduce((s, v) => s + v, 0) / c3Vals.length : 0, source: 'judge' };
  } // 结束 C 维度

  // ========== D 维度 ==========
  if (runAllDims || EVAL_DIMS.includes('D')) {
  const dMetrics: Record<string, MetricItem> = {
    stage2_latency_norm: { score: normalizeReverse(timings.stage2_coarse ?? 0, MAX_LATENCY_S2), source: 'rule' },
    stage3_latency_norm: { score: normalizeReverse(timings.stage3_refine ?? 0, MAX_LATENCY_S3), source: 'rule' },
    stage4_latency_norm: { score: normalizeReverse(timings.stage4_total ?? 0, MAX_LATENCY_S4), source: 'rule' },
    end_to_end_norm: { score: normalizeReverse(result.totalMs ?? 0, MAX_E2E), source: 'rule' },
    neo4j_query_norm: { score: normalizeReverse((timings as any).neo4j_queries || 0, MAX_NEO4J_QUERY), source: 'rule' },
    pg_query_norm: { score: normalizeReverse((timings as any).pg_queries || 0, MAX_PG_QUERY), source: 'rule' },
    stage2_latency_ms: { score: timings.stage2_coarse ?? 0, source: 'raw' },
    stage3_latency_ms: { score: timings.stage3_refine ?? 0, source: 'raw' },
    stage4_latency_ms: { score: timings.stage4_total ?? 0, source: 'raw' },
    end_to_end_latency_ms: { score: result.totalMs ?? 0, source: 'raw' },
    neo4j_query_count: { score: (timings as any).neo4j_queries ?? 0, source: 'raw' },
    pg_query_count: { score: (timings as any).pg_queries ?? 0, source: 'raw' },
  };
  const goldChars2 = (q.gold_answer || "").length;
  const hypChars2 = hypothesis.length;
  const rawRatio2 = hypChars2 > 0 ? goldChars2 / 1.5 / Math.max(1, hypChars2 / 1.5) : 0;
  dMetrics.token_efficiency = { score: Math.min(1, Math.sqrt(Math.max(0.1, rawRatio2))), source: 'rule' };
  for (const [k, v] of Object.entries(dMetrics)) metricProxy[k] = v;
  }

  return metrics;
}

/** 融合双轨评分 */
function mergeScore(rule: number | null | undefined, llm: number | null | undefined): number | null {
  const r = (rule != null) ? rule : null;
  const l = (llm != null) ? llm : null;
  if (r === null && l === null) return null;
  if (r === null) return l;
  if (l === null) return r;
  switch (EVAL_MERGE_POLICY) {
    case 'rule_only': return r;
    case 'llm_only':  return l;
    case 'max':       return Math.max(r, l);
    case 'min':       return Math.min(r, l);
    case 'avg':       return (r + l) / 2;
    default:          return Math.max(r, l);
  }
}

/** 维度平均分 — 直接读 item.score */
function calcDimAvg(metrics: Record<string, MetricItem>, keys: string[]): number {
  const vals: number[] = [];
  for (const k of keys) {
    const item = metrics[k];
    if (!item || item.source === 'raw') continue;
    if (item.score !== null) vals.push(item.score);
  }
  return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
}

async function main() {
  if (!DEEPSEEK_KEY) { logError('DEEPSEEK_API_KEY 未设置'); process.exit(1); }
  if (!EMBEDDING_KEY) { logError('EMBEDDING_API_KEY / DASHSCOPE_API_KEY 未设置'); process.exit(1); }

  const GLOBAL_DEADLINE_MS = 4 * 3600 * 1000;
  let lastQid = '';
  const globalTimer = setTimeout(() => { logError('全局超时熔断, 最后处理: ' + (lastQid || 'none')); process.exit(1); }, GLOBAL_DEADLINE_MS);

  let shuttingDown = false;
  process.on('SIGINT', () => {
    if (shuttingDown) {
      logWarn('收到第二次SIGINT，强制退出');
      process.exit(1);
    }
    shuttingDown = true;
    logWarn('收到 SIGINT，等待当前任务结束并保存结果...');
    // 不立刻exit，让本轮循环执行完毕后自然退出；循环头部会检查 shuttingDown
  });

  let gold: any[];
  try { gold = JSON.parse(readFileSync('gold_dataset.json', 'utf8')); }
  catch (e: any) { logError('gold_dataset.json 解析失败: ' + (e.message?.substring(0, 80) || String(e))); process.exit(1); }
  for (const g of gold) {
    if (!g.id || !g.question_type || !g.question) { logWarn('gold_dataset.json 字段缺失, id=' + (g.id || 'UNKNOWN') + ' — 跳过此题'); continue; }
  }
  // 过滤出有效题目（必须有 id/question_type/question）
  gold = gold.filter((g: any) => g.id && g.question_type && g.question);
  let results: SampleEvalResult[] = [];
  if (existsSync(OUTPUT)) {
    try { results = JSON.parse(readFileSync(OUTPUT, 'utf8')); }
    catch (e: any) { logWarn('输出文件损坏, 重新开始评测'); results = []; }
  }

  if (EVAL_QUESTIONS) {
    const seenIds = new Set<string>();
    const uniqueQids = EVAL_QUESTIONS.filter(id => !seenIds.has(id) && seenIds.add(id));
    if (uniqueQids.length !== EVAL_QUESTIONS.length) logWarn('EVAL_QUESTIONS 包含重复题号, 已去重');
    const seenTypes = new Map<string, number>();
    CANDIDATES = Object.fromEntries(uniqueQids.map(id => { const q = gold.find((g: any) => g.id === id); const t = q?.question_type || 'unknown'; const c = (seenTypes.get(t) || 0) + 1; seenTypes.set(t, c); return [c === 1 ? t : t + '_' + c, id]; }));
  } else {
    const typeMap = new Map<string, string[]>();
    for (const g of gold) { if (!typeMap.has(g.question_type)) typeMap.set(g.question_type, []); typeMap.get(g.question_type)!.push(g.id); }
    CANDIDATES = {};
    for (const [t, ids] of typeMap) { for (let i = 0; i < ids.length; i++) { CANDIDATES[i === 0 ? t : t + '_' + (i + 1)] = ids[i]; } }
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log(`  RAGAS v3 评测启动 | 待评测 ${Object.keys(CANDIDATES).length} 道题目`);
  console.log('════════════════════════════════════════════════════════════\n');
  emitProgress({ type: 'phase', phase: 'start', total: Object.keys(CANDIDATES).length, output: OUTPUT });

  const taskList = Object.entries(CANDIDATES);
  let taskIdx = 0;
  for (const [qType, qId] of taskList) {
    if (shuttingDown) { logWarn('已收到SIGINT, 跳过剩余任务'); break; }
    taskIdx++;
    const progress = `[${taskIdx}/${taskList.length}]`;
    const finished = results.find(r => r.question_id === qId);
    // V88K: 新结果优先覆盖旧 error 条目, 只有非 error 条目才跳过
    if (finished && !finished.error) { console.log(`[${qType}] ${qId} — 已完成，跳过`); continue; }
    // 如果旧条目是 error, 移除它并重新评测
    if (finished && finished.error) {
      results = results.filter(r => r.question_id !== qId);
      console.log(`[${qType}] ${qId} — 旧条目有错误, 重新评测`);
    }
    const q = gold.find(g => g.id === qId);
    if (!q) { console.log(`[${qType}] ${qId} — 未找到`); continue; }
    if (!q.md_path || !Array.isArray(q.relevant_paragraphs) || q.relevant_paragraphs.length === 0) {
      console.log(`[${qType}] ${qId} — 缺少 md_path/relevant_paragraphs, 跳过`); continue;
    }

    console.log(`\n${progress} [${qType}] ${qId}: ${clip(q.question, 80)}`);
    emitProgress({ type: 'question_start', question: qId, qtype: qType, index: taskIdx, total: taskList.length });
    // V95: 题间延迟15s — 避免22路全开后SAG进程过热导致后续题目超时
    if (taskIdx > 1) { await new Promise(r => setTimeout(r, 15000)); }
    lastQid = qId;
    process.stdout.write('  → 请求SAG推理接口... ');
    let sagResult: any;
    try { sagResult = await callSAG(q.question, q.paper_id, q.id); }
    catch (e: any) {
      console.log('失败:', e.message.substring(0, 70));
      results.push({ question_id: q.id, question_type: qType, overall: 0, dimA: 0, dimB: 0, dimC: 0, dimD: 0, metrics: {}, error: 'SAG调用异常:' + e.message });
      emitProgress({ type: 'question_done', question: q.id, ok: false, error: 'SAG调用异常:' + e.message.substring(0, 120) });
      safeSaveJSON(OUTPUT, results); continue;
    }
    if (sagResult.error) {
      console.log('SAG业务错误:', sagResult.error);
      results.push({ question_id: q.id, question_type: qType, overall: 0, dimA: 0, dimB: 0, dimC: 0, dimD: 0, metrics: {}, error: sagResult.error });
      emitProgress({ type: 'question_done', question: q.id, ok: false, error: String(sagResult.error).substring(0, 120) });
      safeSaveJSON(OUTPUT, results); continue;
    }
    console.log(`OK，耗时 ${(sagResult.totalMs / 1000).toFixed(1)}s`);

    process.stdout.write('  → 执行全维度指标评测... ');
    const metrics = await evalSingleSample(q, sagResult);

    const A_KEYS = ['context_recall','context_precision','context_relevancy','entity_utilization','mrr','ndcg','context_diversity','cross_doc_coverage','context_json_contamination','paper_hit','paper_recall_at_k','source_grounded'];
    const B_KEYS = ['answer_correctness','answer_completeness','answer_relevancy','faithfulness','hallucination_rate','factual_consistency','citation_f1','conciseness','answer_readability'];
    const C_KEYS = q.question_type === '多跳推理' ? ['cot_quality','reasoning_depth','multi_hop_accuracy'] : ['cot_quality','reasoning_depth'];
    const D_KEYS = ['stage2_latency_norm','stage3_latency_norm','stage4_latency_norm','end_to_end_norm','token_efficiency','neo4j_query_norm','pg_query_norm'];

    const dimA = calcDimAvg(metrics, A_KEYS);
    const dimB = calcDimAvg(metrics, B_KEYS);
    const dimC = calcDimAvg(metrics, C_KEYS);
    const dimD = calcDimAvg(metrics, D_KEYS);
    const overall = DIM_WEIGHTS.A * dimA + DIM_WEIGHTS.B * dimB + DIM_WEIGHTS.C * dimC + DIM_WEIGHTS.D * dimD;

    console.log(`综合得分: ${overall.toFixed(3)} | A:${dimA.toFixed(3)} B:${dimB.toFixed(3)} C:${dimC.toFixed(3)} D:${dimD.toFixed(3)}`);
    results.push({
      question_id: q.id, question_type: qType, overall, dimA, dimB, dimC, dimD, metrics,
      hypothesis: sagResult.trace?.hypothesis?.content || '',
      fusedContext: sagResult.trace?.fusedContext || '',
      entity_names: sagResult.trace?.entityNames || [],
      _debugCoarse: sagResult.trace?._debugCoarse || {},
      _debugRefined: sagResult.trace?._debugRefined || {},
    });
    emitProgress({ type: 'question_done', question: q.id, ok: true, overall, dimA, dimB, dimC, dimD });
    safeSaveJSON(OUTPUT, results);
  }

  // V38.1: 循环结束后统一保存一次，确保SIGINT降级路径也落地
  safeSaveJSON(OUTPUT, results);
  // P0-1: 循环结束后同步导出逐题分数（significance/failure-attribution 的输入）
  savePerQuestionScores(results);

  console.log('\n\n===================== 评测汇总报表 =====================');
  const byType: Record<string, SampleEvalResult[]> = {};
  for (const r of results) { if (!r.error) { if (!byType[r.question_type]) byType[r.question_type] = []; byType[r.question_type].push(r); } }
  const avg = (arr: number[]) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const typeList = Object.keys(byType);

  console.log(`{"题型".padEnd(14)}${"综合分".padEnd(10)}${"A检索".padEnd(10)}${"B答案".padEnd(10)}${"C推理".padEnd(10)}${"D效率"}`);
  console.log('-'.repeat(70));
  for (const t of typeList) {
    const g = byType[t];
    console.log(`${t.padEnd(14)}${avg(g.map(x=>x.overall)).toFixed(3).padEnd(10)}${avg(g.map(x=>x.dimA)).toFixed(3).padEnd(10)}${avg(g.map(x=>x.dimB)).toFixed(3).padEnd(10)}${avg(g.map(x=>x.dimC)).toFixed(3).padEnd(10)}${avg(g.map(x=>x.dimD)).toFixed(3)}`);
  }
  const valid = results.filter(x => !x.error);
  if (valid.length > 0) {
    console.log('-'.repeat(70));
    console.log(`{"全局均值".padEnd(14)}${avg(valid.map(x=>x.overall)).toFixed(3).padEnd(10)}${avg(valid.map(x=>x.dimA)).toFixed(3).padEnd(10)}${avg(valid.map(x=>x.dimB)).toFixed(3).padEnd(10)}${avg(valid.map(x=>x.dimC)).toFixed(3).padEnd(10)}${avg(valid.map(x=>x.dimD)).toFixed(3)}`);
  }

  console.log('\n\n===================== 逐指标明细 =====================');
  // 32 个指标定义 (A=12, B=9, C=3, D=7)
  const METRIC_SPEC: Record<string, { cat: string; desc: string; source: string; inScore: boolean }> = {
    context_recall:         { cat:'A1', desc:'实体召回 — gold_entities在fusedContext中的命中率(规则max LLM)', source:'mixed', inScore:true },
    context_precision:      { cat:'A2', desc:'分块精度 — LLM判定检索chunk与问题相关比例', source:'judge', inScore:true },
    context_relevancy:      { cat:'A3', desc:'上下文相关性 — fusedContext有效信息占比(3轮中位数)', source:'judge', inScore:true },
    entity_utilization:     { cat:'A4', desc:'实体利用率 — 检索实体在fusedContext中的命中率(子串+embedding兜底)', source:'rule', inScore:true },
    mrr:                    { cat:'A5', desc:'MRR — embedding语义首相关排名倒数(关键词fallback)', source:'embedding', inScore:true },
    ndcg:                   { cat:'A6', desc:'NDCG — embedding语义排序质量归一化折损累积增益', source:'embedding', inScore:true },
    context_diversity:      { cat:'A7', desc:'分块多样性 — 去YAML+取中部200字去重比例', source:'rule', inScore:true },
    cross_doc_coverage:     { cat:'A8', desc:'跨文档覆盖 — 检索覆盖的论文来源数(min(1,count/5))', source:'rule', inScore:true },
    context_json_contamination: { cat:'A9', desc:'上下文JSON噪音 — fusedContext中非语义噪音行占比，规则+LLM双轨', source:'mixed', inScore:true },
    paper_hit:              { cat:'A10', desc:'论文命中 — fusedContext是否含目标论文标题片段(规则0/1)', source:'rule', inScore:true },
    paper_recall_at_k:      { cat:'A11', desc:'论文召回率 — 检索原始chunk中目标论文占比', source:'rule', inScore:true },
    source_grounded:        { cat:'A12', desc:'溯源达标 — 答案引用目标论文(0否认/0.5未提/1引用)', source:'rule', inScore:true },
    answer_correctness:     { cat:'B1', desc:'答案正确性 — 与金标语义一致性', source:'judge', inScore:true },
    answer_completeness:    { cat:'B2', desc:'答案完整性 — 覆盖金标核心要点(答多不扣分)', source:'judge', inScore:true },
    answer_relevancy:       { cat:'B3', desc:'答案相关性 — 是否直接针对提问无发散', source:'judge', inScore:true },
    faithfulness:           { cat:'B4', desc:'忠实度 — 事实陈述是否有检索上下文依据', source:'judge', inScore:true },
    hallucination_rate:     { cat:'B5', desc:'反幻觉率 — 是否编造不存在事实(1=无编造)', source:'judge', inScore:true },
    factual_consistency:    { cat:'B6', desc:'事实一致性 — 回答内部事实逻辑不矛盾', source:'judge', inScore:true },
    citation_f1:            { cat:'B7', desc:'引用准确度 — 来源标注可验证性综合得分', source:'judge', inScore:true },
    conciseness:            { cat:'B8', desc:'简洁度 — 答多且有实质不扣,只扣真冗余', source:'judge', inScore:true },
    answer_readability:     { cat:'B9', desc:'可读性 — 文本结构分层表达清晰度', source:'judge', inScore:true },
    cot_quality:            { cat:'C1', desc:'COT推理链质量 — 五级离散(0/.25/.5/.75/1)3轮中位数', source:'judge', inScore:true },
    multi_hop_accuracy:     { cat:'C2', desc:'多跳推理准确率 — 仅多跳题型评测(否则null)', source:'judge', inScore:true },
    reasoning_depth:        { cat:'C3', desc:'推理深度 — 逻辑连贯+无隐含假设+拒答合理性三项分评均值', source:'judge', inScore:true },
    stage2_latency_norm:    { cat:'D1', desc:'Stage2归一化耗时 — 1-min(1,ms/30000)', source:'rule', inScore:false },
    stage3_latency_norm:    { cat:'D2', desc:'Stage3归一化耗时 — 1-min(1,ms/60000)', source:'rule', inScore:false },
    stage4_latency_norm:    { cat:'D3', desc:'Stage4归一化耗时 — 1-min(1,ms/40000)', source:'rule', inScore:false },
    end_to_end_norm:        { cat:'D4', desc:'端到端归一化耗时 — 1-min(1,ms/90000)', source:'rule', inScore:false },
    token_efficiency:       { cat:'D5', desc:'Token效率 — √(金标字符数/回答字符数),软化长度惩罚', source:'rule', inScore:false },
    neo4j_query_norm:       { cat:'D6', desc:'Neo4j查询归一化 — 1-min(1,n/20)', source:'rule', inScore:false },
    pg_query_norm:          { cat:'D7', desc:'PG查询归一化 — 1-min(1,n/15)', source:'rule', inScore:false },
  };
  const metricOrder = Object.keys(METRIC_SPEC);
  for (const key of metricOrder) {
    const spec = METRIC_SPEC[key];
    const vals = typeList.map(t => { const items = (byType[t] || []).filter((r: any) => r.metrics?.[key]?.score != null); return items.length === 0 ? '     -' : avg(items.map((r: any) => r.metrics[key]?.score ?? 0)).toFixed(3); });
    const applicable = valid.filter((r: any) => r.metrics?.[key]?.score != null);
    const total = applicable.length > 0 ? avg(applicable.map((r: any) => r.metrics[key]?.score ?? 0)) : null;
    const failedCount = valid.filter((r: any) => r.metrics?.[key]?.eval_failed).length;
    const failFlag = failedCount > 0 ? ` [!${failedCount}]` : '';
    const prefix = `${spec.inScore ? '★' : ' '}${spec.cat} ${key}`;
    console.log(`${(prefix + failFlag).padEnd(40)}${vals.join('        ')}  ${total !== null ? total.toFixed(3) : '  null'}`);
    console.log(`  ${spec.source.padEnd(9)} ${spec.desc}`);
  }
  const failSummary: string[] = [];
  for (const r of valid) { const fails = Object.entries(r.metrics || {}).filter(([, m]) => m.eval_failed).map(([k]) => k); if (fails.length > 0) failSummary.push(`  ${r.question_id}(${r.question_type}): ${fails.join(', ')}`); }
  if (failSummary.length > 0) { console.log('\n--- eval_failed 明细 ---'); console.log(failSummary.join('\n')); }
  console.log(`\n★=计入综合分  D维度纯观测不计入`);
  console.log(`\n评测结果持久化路径: ${OUTPUT}`);
  emitProgress({ type: 'phase', phase: 'done', output: OUTPUT });
  clearTimeout(globalTimer);
  return results;
}
main().catch(err => { console.error('程序全局异常:', err); process.exit(1); });
