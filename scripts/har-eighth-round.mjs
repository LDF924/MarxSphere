/**
 * 第八轮逐条对拍:台账判定文案 vs dump 原始证据的行为级复核
 * 法: 不信任台账"✅"标注——对每条动作型请求,重提 dump 的请求体/响应体,
 * 与台账判定文案 + 我方源码端点签名交叉核。输出:
 *  1) 台账 ✅ 但 dump 响应中仍有异常/空/错误痕迹的条目(假阳性候选)
 *  2) 台账 ⚠/❌ 条目确认
 *  3) 大响应(>2KB)清单供逐字段人工核
 */
import fs from 'node:fs';

const dump = JSON.parse(fs.readFileSync('./data/.har-full-dump.json', 'utf8'));
const doc = fs.readFileSync('./docs/HAR-LINE-BY-LINE.md', 'utf8');
const lines = doc.split('\n').filter((l) => /^#\d+\|/.test(l));

const byId = {};
for (const line of lines) {
  const m = line.match(/^#(\d+)\|([^|]*)\|([^|]*)\|(\d+)\|([^|]*)\|(.*)$/);
  if (!m) continue;
  byId[Number(m[1])] = { t: m[2], method: m[3], st: Number(m[4]), path: m[5], verdict: m[6] };
}

const actionRows = Object.keys(byId)
  .map(Number)
  .filter((id) => {
    const e = dump[id - 1];
    const v = byId[id].verdict;
    return e && !e.isPoll && !e.isAsset && !/心跳/.test(v);
  });

const big = [];
const emptyRespActions = [];
const errLike = [];
const httpNon200 = [];
for (const id of actionRows) {
  const e = dump[id - 1];
  const v = byId[id].verdict;
  const resp = e.resp || '';
  const post = e.post || '';
  // 1) 非200动作
  if (e.st >= 400) httpNon200.push({ id, st: e.st, path: e.normPath, resp: resp.slice(0, 200), verdict: v.slice(0, 50) });
  // 2) 动作型但响应为空字符串且非204
  if (!resp && e.st !== 204) emptyRespActions.push({ id, st: e.st, path: e.normPath });
  // 3) 大响应
  if (resp.length > 2000 && e.st === 200) big.push({ id, sz: resp.length, path: e.normPath, head: resp.slice(0, 90).replace(/\n/g, ' ') });
  // 4) 响应体含错误痕迹
  if (/error|failed|fail|exception|"code"|invalid/i.test(resp) && e.st < 400) errLike.push({ id, path: e.normPath, resp: resp.slice(0, 160) });
}

console.log('=== 动作型条目总数:', actionRows.length, '===');
console.log('\n=== A. 非200动作型(' + httpNon200.length + ') ===');
for (const r of httpNon200) console.log('#' + r.id, r.st, r.path, '|', r.resp.slice(0, 120), '| doc:', r.verdict.slice(0, 40));
console.log('\n=== B. 动作型但空响应(非204)(' + emptyRespActions.length + ') ===');
for (const r of emptyRespActions) console.log('#' + r.id, r.st, r.path);
console.log('\n=== C. 大响应>2KB(' + big.length + ') — 需字段核 ===');
for (const r of big) console.log('#' + r.id, r.sz + 'B', r.path, '|', r.head);
console.log('\n=== D. <400 但响应含错误字眼(' + errLike.length + ') ===');
for (const r of errLike) console.log('#' + r.id, r.path, '|', r.resp.slice(0, 140));

// 输出抽样到文件供人工细看
fs.writeFileSync('/tmp/har-8th-round.json', JSON.stringify({
  actionRows: actionRows.length,
  httpNon200, emptyRespActions, big: big.map((r) => ({ ...r, resp: (dump[r.id - 1].resp || '').slice(0, 1200) })), errLike,
}, null, 1));
