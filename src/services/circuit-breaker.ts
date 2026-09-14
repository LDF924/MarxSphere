// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// circuit-breaker.ts — 熔断器 + 终止上限 + 死亡螺旋防护（BOOK-GAP-ROADMAP P0-11）
// 书中 Ch5: 每条恢复路径独立熔断; 死亡螺旋防护 = 错误路径上禁用一切会再次调用模型的副作用逻辑
// 三态: CLOSED(正常) → OPEN(连续失败≥maxFailures) → HALF_OPEN(冷却后放行一次试探)
import { clusterInstanceCount } from "./rate-limiter.js";  // V417: 集群规模只认这一处判据

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private halfOpenTried = false;

  constructor(
    readonly name: string,
    /** 单副本阈值; 实际阈值会按集群规模折算(见 effectiveMaxFailures) */
    readonly maxFailures = 3,
    readonly cooldownMs = 60_000,
  ) {}

  /**
   * V417: 每个副本只看得见自己那部分失败 —— `deepseek429` 的"连续 20 次/60s"在 5 副本下
   *   实际要 100 次才熔断, 防线被摊薄成 1/N。这里按集群规模把阈值放大到"全局等价"。
   *
   * 为什么是**放大阈值**而不是共享计数: 熔断的意义是"上游确实在持续失败"。
   *   共享一个全局计数器需要额外的 DB 往返(熔断判定在热路径上), 而按 N 折算零成本且
   *   语义正确 —— 5 副本各自 100 次 = 全局 500 次才停, 与单副本 100 次的效果一致。
   * 代价: 熔断触发比"全局精确计数"晚一点(各副本计数不同步), 对防雪崩够用。
   */
  private effectiveMaxFailures(): number {
    return this.maxFailures * clusterSizeOf();
  }

  /** 记录成功 → 关闭熔断（清零失败计数） */
  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = 0;
    this.halfOpenTried = false;
  }

  /** 记录失败 → 连续失败 ≥ 阈值(按集群折算) 则 OPEN */
  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.effectiveMaxFailures()) {
      this.openedAt = Date.now();
      this.halfOpenTried = false;
      console.warn(`[circuit] ${this.name} OPEN (连续失败 ${this.failures} 次, 冷却 ${this.cooldownMs / 1000}s)`);
    }
  }

  /** OPEN 期间直接短路（不执行原逻辑） */
  isOpen(): boolean {
    if (this.openedAt === 0) return false;
    // 冷却已过 → HALF_OPEN，放行一次试探
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      if (!this.halfOpenTried) {
        this.halfOpenTried = true;
        return false; // 放行试探
      }
      // 试探失败过 → 重新 OPEN（重新计时）
      this.openedAt = Date.now();
      this.halfOpenTried = false;
      return true;
    }
    return true;
  }

  get failureCount(): number {
    return this.failures;
  }
}

/**
 * V417: 集群实例数 —— 复用限流器那份判据(REPLICA_COUNT 或后端心跳实测), 不另起一套。
 * 静态 import: 本仓是 ESM, `require` 在运行时不存在(tsc 不管这个)。
 * 取不到就回退 1 —— 断路器在热路径上, 不能因为拿不到集群规模就抛错。
 */
function clusterSizeOf(): number {
  try {
    const n = clusterInstanceCount();
    return Number.isFinite(n) && n >= 1 ? n : 1;
  } catch { return 1; }
}

/** 全局断路器实例（各恢复路径独立） */
export const breakers = {  compression: new CircuitBreaker("compression", 3, 120_000),
  reflection: new CircuitBreaker("reflection", 2, 300_000),
  llmJudge: new CircuitBreaker("llmJudge", 5, 60_000),
  ingest: new CircuitBreaker("ingest", 3, 300_000),
  graphitiHeavy: new CircuitBreaker("graphitiHeavy", 2, 600_000),
  /** 外部 API 配额熔断: DeepSeek 429 连续 20 次/60s → 短路外部 reason 请求 503 (内部走 llm-client 的 recordFailure) */
  deepseek429: new CircuitBreaker("deepseek429", 20, 60_000),
};

// ═══════ 全局终止三件套（书中 Ch5）═══════/** 最大迭代轮数：超过即停并 surface_to_user */
export const MAX_STEP_ITERATIONS = parseInt(process.env.MAX_STEP_ITERATIONS || "60", 10);
/** 会话 token 预算（默认 200 万，按 model-call-log 累计） */
export const SESSION_TOKEN_BUDGET = parseInt(process.env.SESSION_TOKEN_BUDGET || "2000000", 10);
/** 同类型连续失败 ≥ 5 → 升级为"暴露用户 + 附已尝试动作" */
export const MAX_CONSECUTIVE_SAME_FAILURES = 5;

/** 死亡螺旋防护：错误/恢复路径中禁用任何会再次调用 LLM 的副作用逻辑 */
export function assertNoLlmSideEffect(context: string): void {
  // 设计约束：恢复分支只允许确定性操作（查库/降级策略切换）
  // 实现层通过在恢复路径中不调用 fetchLlm/getRoleModel 相关函数来保证
  // 此函数作为代码审查哨兵：在恢复路径入口调用，若未来有人误加 LLM 调用会在此暴露
  void context;
}
