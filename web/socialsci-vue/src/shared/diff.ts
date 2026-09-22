/**
 * 章节级版本对比(V425 D3) —— 段落对齐 + 词级差异。
 *
 * 为什么按**段落**对齐而不是整篇 diff: 正文动辄上万字, 整篇做 LCS 既慢又会把
 * 「某一段被改写」摊成一大片红绿噪声 —— 用户真正要看的是"哪几段变了"。
 * 段内再用词级 LCS, 只标出真正改动的那几个词。
 *
 * 相似度阈值 0.34 是实测调出来的: 低于它, 两段毫不相干的文字也会被凑成一对(然后满屏红绿);
 * 高于它, 「整段重写」会被当成"删除 + 新增"而不是"改写"。
 */

/** 段落切分: 空行优先, 没有空行时退回单换行(中文论文常常一段一行而不留空行) */
export function splitParagraphs(text: string): string[] {
  const raw = String(text ?? "").replace(/\r\n/g, "\n");
  const byBlank = raw.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (byBlank.length > 1) return byBlank;
  return raw.split(/\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 词级切分: 汉字**逐字**、拉丁字母与数字**成词**、标点各自成符号。
 * 逐字是为了让中文改一个词只亮那个词, 而不是整段(中文没有空格, 按词切需要分词器,
 * 逐字反而更准且零依赖)。
 */
function tokens(s: string): string[] {
  return String(s ?? "").match(/[一-龥]|[A-Za-z]+|\d+(?:\.\d+)?|[^\s]/g) ?? [];
}

/** 词级 LCS 差异 */
export function diffWords(a: string, b: string): Array<{ t: "same" | "del" | "add"; s: string }> {
  const A = tokens(a), B = tokens(b);
  // 长段(尤其整章)做 O(n*m) 会卡: 超过阈值就降级成"整段标注"而不是逐词 —— 宁可粗糙也不能卡死界面
  if (A.length * B.length > 400_000 || A.length > 4000 || B.length > 4000) {
    const out: Array<{ t: "same" | "del" | "add"; s: string }> = [];
    if (a) out.push({ t: "del", s: a });
    if (b) out.push({ t: "add", s: b });
    return out;
  }
  const n = A.length, m = B.length;
  // dp[i][j] = LCS 长度(滚动数组省内存)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<{ t: "same" | "del" | "add"; s: string }> = [];
  const push = (t: "same" | "del" | "add", s: string) => {
    const last = out[out.length - 1];
    if (last && last.t === t) last.s += s;
    else out.push({ t, s });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push("same", A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push("del", A[i]); i++; }
    else { push("add", B[j]); j++; }
  }
  while (i < n) push("del", A[i++]);
  while (j < m) push("add", B[j++]);
  return out;
}

/** 段落相似度(用词集合的 Dice 系数) —— 比编辑距离便宜, 且对"改写"够灵敏 */
function similarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return A.length === B.length ? 1 : 0;
  const bag = new Map<string, number>();
  for (const t of A) bag.set(t, (bag.get(t) ?? 0) + 1);
  let hit = 0;
  for (const t of B) {
    const c = bag.get(t) ?? 0;
    if (c > 0) { hit++; bag.set(t, c - 1); }
  }
  return (2 * hit) / (A.length + B.length);
}

export type ParaDiff =
  | { kind: "same"; oldIdx: number; newIdx: number; text: string }
  | { kind: "changed"; oldIdx: number; newIdx: number; before: string; after: string; segs: ReturnType<typeof diffWords> }
  | { kind: "removed"; oldIdx: number; text: string }
  | { kind: "added"; newIdx: number; text: string };

const THRESHOLD = 0.34;

/**
 * 段落对齐 + 差异。用**前后指针**而不是完整 LCS:
 *   正文改动通常是局部的(改几段、删几段), 首尾对齐能吃掉全部相同的前后缀,
 *   中间那一段再按相似度贪心配对。完整 LCS 在几千段上是 O(n²), 会卡。
 */
export function diffParagraphs(before: string, after: string): ParaDiff[] {
  const A = splitParagraphs(before), B = splitParagraphs(after);
  const out: ParaDiff[] = [];

  // ① 前缀: 完全相同的直接过
  let i = 0, j = 0;
  while (i < A.length && j < B.length && A[i] === B[j]) {
    out.push({ kind: "same", oldIdx: i, newIdx: j, text: A[i] });
    i++; j++;
  }

  // ② 后缀: 从两端往中间数, 遇到第一处不同就停。
  //   ⚠ 这里第一版写错过: 判断条件里把已经吃掉的前缀长度也减了一遍, 于是后缀会**多留一段**,
  //   结果是"中间插了一段"被算成 [same, removed, added, added] —— 多出一个凭空删除。
  //   正确的边界只有一条: 从末尾数的第 k 段不得越过已消费的前缀(A.length-1-k >= i)。
  let k = 0;
  while (A.length - 1 - k >= i && B.length - 1 - k >= j && A[A.length - 1 - k] === B[B.length - 1 - k]) k++;
  const tail: ParaDiff[] = [];
  for (let t = k - 1; t >= 0; t--) {
    const ai = A.length - 1 - t, bi = B.length - 1 - t;
    tail.unshift({ kind: "same", oldIdx: ai, newIdx: bi, text: A[ai] });
  }

  // ③ 中段: 按相似度贪心配对
  const aEnd = A.length - k, bEnd = B.length - k;
  while (i < aEnd || j < bEnd) {
    if (i < aEnd && j < bEnd) {
      if (similarity(A[i], B[j]) >= THRESHOLD) {
        out.push(A[i] === B[j]
          ? { kind: "same", oldIdx: i, newIdx: j, text: A[i] }
          : { kind: "changed", oldIdx: i, newIdx: j, before: A[i], after: B[j], segs: diffWords(A[i], B[j]) });
        i++; j++;
        continue;
      }
      /**
       * 这一段对不上, 要看**谁是多出来的** —— 判据是"跳过它之后能不能对上"。
       *
       * ⚠ 两个方向很容易写反(我第一版就写反了, 表现为"插入一段"被报成"删除一段"再加两段新增):
       *   · A[i] 与 B[j+1] 更像  → 说明 **B[j] 是插入来的**, 应该记 added 并推进 j;
       *   · B[j] 与 A[i+1] 更像  → 说明 **A[i] 是被删掉的**, 应该记 removed 并推进 i。
       * 越界的一侧给 -1, 保证它不会因为"另一边是 0"而误胜。
       */
      const simBIsInsert = (j + 1 < bEnd) ? similarity(A[i], B[j + 1]) : -1;
      const simAIsDeleted = (i + 1 < aEnd) ? similarity(B[j], A[i + 1]) : -1;
      if (simBIsInsert >= simAIsDeleted) { out.push({ kind: "added", newIdx: j, text: B[j] }); j++; }
      else { out.push({ kind: "removed", oldIdx: i, text: A[i] }); i++; }
    } else if (i < aEnd) {
      out.push({ kind: "removed", oldIdx: i, text: A[i] }); i++;
    } else {
      out.push({ kind: "added", newIdx: j, text: B[j] }); j++;
    }
  }
  return [...out, ...tail];
}

/** 变更统计(给"共 N 处改动"这类概述用) */
export function diffStats(d: ParaDiff[]) {
  return {
    changed: d.filter((x) => x.kind === "changed").length,
    removed: d.filter((x) => x.kind === "removed").length,
    added: d.filter((x) => x.kind === "added").length,
    same: d.filter((x) => x.kind === "same").length,
  };
}
