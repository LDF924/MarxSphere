// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// rrf.ts — Reciprocal Rank Fusion（RRF）多路检索融合
// GBrain 第 7 步：多臂召回 → 1/(k+rank) 融合排序
//
// RRF 公式: score(item) = Σ_arm  1 / (k + rank_arm(item))
// k 通常取 60（RRF 论文默认值），可调。

export interface RrfArm<T> {
  name: string;
  /** 该臂的排序结果，rank 从 1 开始 */
  items: T[];
  /** 从 item 提取唯一 id 的函数 */
  keyOf: (item: T) => string;
}

export interface RrfScored<T> {
  item: T;
  score: number;
  /** 每个臂贡献的倒数分（调试用） */
  contributions: Record<string, number>;
  /** 命中该 item 的臂数 */
  armsHit: number;
}

/**
 * 对多个召回臂做 RRF 融合
 * @param arms 各召回臂
 * @param k RRF 常数，默认 60
 * @returns 按融合分降序的列表
 */
export function reciprocalRankFusion<T>(arms: RrfArm<T>[], k = 60): RrfScored<T>[] {
  const scores = new Map<string, RrfScored<T>>();

  for (const arm of arms) {
    arm.items.forEach((item, index) => {
      const rank = index + 1;
      const key = arm.keyOf(item);
      const contribution = 1 / (k + rank);

      const existing = scores.get(key);
      if (existing) {
        existing.score += contribution;
        existing.armsHit += 1;
        existing.contributions[arm.name] = contribution;
      } else {
        scores.set(key, {
          item,
          score: contribution,
          contributions: { [arm.name]: contribution },
          armsHit: 1
        });
      }
    });
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score);
}

// ─── 时间衰减加权（GBrain 第 9 步 recency）───
// gauss 衰减: boost = exp(-0.5 * ((ageDays / sigma)^2))
// 论文默认 sigma=365(1年)，追踪前沿可调 90。

export function gaussTimeDecay(createdAt: string | undefined, sigmaDays = 365): number {
  if (!createdAt) return 1; // 无时间信息不衰减
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return 1;
  const ageDays = Math.max(0, (Date.now() - created) / 86_400_000);
  return Math.exp(-0.5 * Math.pow(ageDays / sigmaDays, 2));
}

/**
 * 对 RRF 融合结果应用时间衰减
 * 在原始融合分上加时间权重（乘性）：final = score * (1 - alpha + alpha * decay)
 * alpha 控制时间权重占比，默认 0.2（轻量），sigma 控制衰减速度。
 */
export function applyTimeDecay<T>(
  fused: RrfScored<T>[],
  options: {
    /** 从 item 提取 created_at 字符串 */
    createdAtOf: (item: T) => string | undefined;
    alpha?: number;
    sigmaDays?: number;
  }
): RrfScored<T>[] {
  const alpha = options.alpha ?? 0.2;
  const sigmaDays = options.sigmaDays ?? 365;
  const now = Date.now();

  return fused.map((entry) => {
    const created = options.createdAtOf(entry.item);
    const decay = gaussTimeDecay(created, sigmaDays);
    // 时间权重与内容权重按 alpha 混合
    const adjusted = entry.score * (1 - alpha + alpha * decay);
    return {
      ...entry,
      score: adjusted,
      contributions: {
        ...entry.contributions,
        recency: entry.score * alpha * decay
      }
    };
  }).sort((a, b) => b.score - a.score);
}
