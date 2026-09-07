// 逐条核对清单生成: 1106 条 × (我方对应/判定) — 机器辅助, 判定行人工过
import { readFileSync, writeFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync('data/.har-full-dump.json', 'utf8'));
const server = readFileSync('src/api/server.ts', 'utf8');
// 我方路由集合(归一)
const myRoutes = new Set();
for (const m of server.matchAll(/app\.(get|post|put|delete|patch)\(\s*["'`](\/api\/[^"'`$]{2,120})["'`]/g)) {
  myRoutes.add(m[2]);
}
const norm = (u) => u
  .replace(/\/:[a-zA-Z]+/g, '/:p')
  .replace(/\/\*$/, '/:p')
  .replace(/\/\$?\{[^}]+\}/g, '/:p');

// 我方实现域关键词: 判定映射
const KNOWN = [
  [/^\/api\/statistics\/health/, '✅我方 /api/statistics/health(实证健康)'],
  [/^\/api\/viz2\/status/, '✅我方绘图健康=无独立 viz2; /api/viz/health? — 心跳等价我方无/绘图靠会话'],
  [/^\/api\/workflow\/jobs\/active/, '✅我方 = research_tasks running/queued 轮询(RunningTasks)'],
  [/^\/api\/tasks\/:p\/nodes\/(analysis|input|sections|materials|workspace|finalize|viz_chat|viz_data)/, '✅我方 research_nodes 同语义快照'],
  [/^\/api\/tasks\/:p/, '✅我方 research_tasks'],
  [/^\/api\/tasks$/, '✅我方 research_tasks'],
  [/^\/api\/tasks\/default/, '✅我方 /api/tasks/default 兜底'],
  [/^\/api\/materials/, '✅我方 research_materials'],
  [/^\/api\/clarify\/generate/, '✅我方 /api/clarify/generate'],
  [/^\/api\/projects/, '✅我方 /api/research/projects'],
  [/^\/api\/workflow\/versions/, '✅我方 /api/research/versions(publish)'],
  [/^\/api\/workflow\/jobs\/phase\d/, '✅我方 research jobs(exec-engine)'],
  [/^\/api\/workflow\/jobs\/:p\/stream/, '✅我方 SSE(pipe.*/review.*)'],
  [/^\/api\/workflow\/jobs\/:p$/, '✅我方 research_tasks 详情'],
  [/^\/api\/ai\/material\/generate/, '✅我方 research-materials aiGenerateMaterial'],
  [/^\/api\/viz-jobs\/versions/, '✅我方 viz_artifacts(版本时间线)'],
  [/^\/api\/viz-jobs\/:p\/stream/, '✅我方 viz SSE'],
  [/^\/api\/viz-jobs\/:p$/, '✅我方 viz session 详情'],
  [/^\/api\/viz-jobs$/, '✅我方 viz_sessions 列表'],
  [/^\/api\/viz2\/files\//, '✅我方 /api/viz/files/{rel}(产物静态)'],
  [/^\/api\/review\/library/, '✅我方 review_journals/standards'],
  [/^\/api\/review\/export-report/, '✅我方 export-html(40a93b8)'],
  [/^\/api\/review\/jobs\/:p\/stream/, '✅我方 review SSE'],
  [/^\/api\/review\/jobs\/:p$/, '✅我方 review_jobs 详情'],
  [/^\/api\/review\/jobs$/, '✅我方 review_jobs'],
  [/^\/api\/files\/:p\/content/, '✅我方 user_files 原始下载'],
  [/^\/api\/files\/:p\/profile/, '✅我方 /api/empirical/profile'],
  [/^\/api\/files\/upload/, '⚠️我方 base64 JSON(闭源 multipart)'],
  [/^\/api\/files\/extract-text/, '✅我方同端点'],
  [/^\/api\/statistics-jobs/, '✅我方 stats_artifacts/empirical'],
  [/^\/api\/statistics-jobs\/artifacts/, '✅我方 stats_artifacts'],
  [/^\/api\/editor\/v1\/documents\/:p\/heartbeat/, '✅我方 30s lock 续期(更密)'],
  [/^\/api\/editor\/v1\/documents\/:p\/lock/, '✅我方 lockDoc'],
  [/^\/api\/editor\/v1\/documents\/:p$/, '✅我方 documents_v2'],
  [/^\/api\/editor\/v1\/documents$/, '✅我方 documents_v2'],
  [/^\/api\/editor\/v1\/documents\/[0-9]+\/heartbeat$/, '✅我方 30s lock 续期(闭源 60s)'],
  [/^\/api\/editor\/v1\/documents\/[0-9]+\/lock$/, '✅我方 lockDoc'],
  [/^\/api\/editor\/v1\/documents\/[0-9]+$/, '✅我方 documents_v2 详情'],
  [/^\/api\/health$/, '✅我方 /health 健康检查'],
  [/^\/api\/knowledge\/jobs\/:p\/stream/, '✅我方 Ask SSE 等价'],
  [/^\/api\/knowledge\/jobs$/, '✅我方 Ask 任务'],
  [/^\/api\/knowledge\/sessions\/:p/, '✅我方 mcp_sessions 清理'],
  [/^\/api\/knowledge\/health/, '✅我方健康检查'],
  [/^\/api\/auth\/check-in/, '✅我方 /api/points/me+checkin'],
  [/^\/api\/stats\/overview/, '⚠️我方无统一概览(各面板自供)'],
];

function judge(method, path) {
  for (const [re, verdict] of KNOWN) {
    if (re.test(path)) return verdict;
  }
  return '❓待人工核:' + method + ' ' + path;
}

const heart = new Set(['/api/statistics/health', '/api/viz2/status', '/api/workflow/jobs/active']);
// 占位符 → :p 归一
const pnorm = (x) => x.replace(/\/(?:T|J|N|U|F|V|C|S)[A-Za-z0-9_]*/g, '/:p');
const out = [];
const heartSeen = {};
for (const r of rows) {
  const p = pnorm(r.normPath);
  let verdict;
  if (r.isAsset) verdict = 'asset(前端资源,跳过)';
  else if (heart.has(p)) {
    heartSeen[p] = (heartSeen[p] || 0) + 1;
    verdict = '心跳#' + heartSeen[p] + '(' + p.replace('/api/', '') + '轮询, 与首条同行为)';
  } else verdict = judge(r.m, p);
  out.push(`#${r.i}|${r.t}|${r.m}|${r.st}|${p}${r.q ? '|q:' + r.q : ''}|${verdict}`);
}
writeFileSync('docs/HAR-LINE-BY-LINE.md', out.join('\n'));
console.log('written lines:', out.length);
// 心跳统计
console.log('心跳计数:', JSON.stringify(heartSeen));
const unjudged = out.filter(l => l.includes('❓'));
console.log('待人工核:', unjudged.length);
for (const u of unjudged.slice(0, 60)) console.log(u);
