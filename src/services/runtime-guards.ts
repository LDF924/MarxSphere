// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/runtime-guards.ts — V404-23: 运行时防护(借鉴 OpenSquilla 引擎防护, 自写 TS)
// 组合三防护:
//   H1 progressWatchdog: "连续工具/检索活动无产出(写库/最终结果)" → warn → 触发终止(observe-first)
//   H2 repetitionGuard:   流式输出复读检测(归一化字符定点采样, 周期相似度≥0.985 且重复≥8 次 → 判复读)
//   H4 decodeSubprocess:  Windows 子进程输出 CP936/代码页感知解码(UTF-8 读取乱码时回退系统代码页)
// 全部自包含纯逻辑, 便于单测; 由 agent 循环/工具层喂事件。

// ═══ H2: 复读检测(repetition_guard 移植核心) ═══
export interface RepetitionPolicy {
  minSimilarity: number;      // 默认 0.985
  minRepetitions: number;     // 默认 8 次周期重复
  checkStrideChars: number;   // 每 N 个归一化字符检查一次, 默认 256
  maxCandidateSuffix: number; // 周期候选后缀最长字符数
}

const DEFAULT_REP_POLICY: RepetitionPolicy = {
  minSimilarity: 0.985,
  minRepetitions: 8,
  checkStrideChars: 256,
  maxCandidateSuffix: 2048,
};

export interface RepetitionDetection {
  similarity: number;
  period: number;
  repetitions: number;
  /** 截取一段复读文本供日志 */
  sample: string;
}

/** 归一化: 空白折叠、小写; 返回字符数组(逐字符归一, 兼容中文) */
function normalizeChars(text: string): string[] {
  const out: string[] = [];
  let lastWs: string | null = null;
  for (const ch of text) {
    if (/\s/.test(ch)) {
      const n = ch === "\r" || ch === "\n" ? "\n" : " ";
      if (n !== lastWs) { out.push(n); lastWs = n; }
    } else {
      out.push(ch.toLowerCase());
      lastWs = null;
    }
  }
  return out;
}

/** 最长公共后缀相似度: 文本尾部与更早段落的周期重叠率 */
function tailPeriodSimilarity(normalized: string[], candidatePeriod: number): { similarity: number; repetitions: number } {
  const n = normalized.length;
  if (n < candidatePeriod * 2 || candidatePeriod <= 0) return { similarity: 0, repetitions: 0 };
  let match = 0;
  let total = 0;
  // 对比尾 candidatePeriod 与它前面的 candidatePeriod
  for (let i = 0; i < candidatePeriod; i++) {
    const a = normalized[n - candidatePeriod + i];
    const b = normalized[n - candidatePeriod * 2 + i];
    total++;
    if (a === b) match++;
  }
  const similarity = match / Math.max(1, total);
  // 从尾往前数连续满足相似的周期数
  let repetitions = 1;
  let pos = n - candidatePeriod;
  while (pos - candidatePeriod >= 0) {
    let m = 0;
    for (let i = 0; i < candidatePeriod; i++) {
      if (normalized[pos - candidatePeriod + i] === normalized[pos + i]) m++;
    }
    if (m / candidatePeriod < 0.9) break;
    repetitions++;
    pos -= candidatePeriod;
  }
  return { similarity, repetitions };
}

/** 复读检测器(流式): feed(text) → 返回需剥除的重复文本或 null */
export class RepetitionGuard {
  private policy: RepetitionPolicy;
  private buffer: string[] = [];
  private normalizedCount = 0;

  constructor(policy?: Partial<RepetitionPolicy>) {
    this.policy = { ...DEFAULT_REP_POLICY, ...policy };
  }

  reset(): void {
    this.buffer = [];
    this.normalizedCount = 0;
  }

  /** 喂入新文本; 若检测到复读循环, 返回检测结果(调用方应终止/截断), 否则 null */
  feed(text: string): RepetitionDetection | null {
    const chars = normalizeChars(text);
    this.buffer.push(...chars);
    this.normalizedCount += chars.length;
    // 缓冲裁剪(只保留最近 maxCandidateSuffix*3 防止无界增长)
    const cap = this.policy.maxCandidateSuffix * 3;
    if (this.buffer.length > cap) this.buffer = this.buffer.slice(-cap);
    if (this.normalizedCount < this.policy.checkStrideChars) return null;
    this.normalizedCount = 0;
    const n = this.buffer.length;
    // 尝试多个候选周期(从 4 到缓冲一半, 步进 1 — 中文句周期任意长度, 固定步进会漏检)
    let best: RepetitionDetection | null = null;
    const maxPeriod = Math.min(Math.floor(n / 2), this.policy.maxCandidateSuffix, 1024);
    for (let period = 4; period <= maxPeriod; period++) {
      const { similarity, repetitions } = tailPeriodSimilarity(this.buffer, period);
      if (similarity >= this.policy.minSimilarity && repetitions >= this.policy.minRepetitions) {
        if (!best || repetitions > best.repetitions) {
          best = { similarity, period, repetitions, sample: this.buffer.slice(-Math.min(period * 2, 200)).join("") };
        }
      }
    }
    return best;
  }
}

// ═══ H1: 进度哨兵(progress_watchdog 移植核心, 观察式) ═══
export type WatchdogAction = "observe" | "warn" | "block";

export interface WatchdogObservation {
  /** 本轮是否成功产出(写库/最终结果/用户可见输出) */
  artifactCompleted?: boolean;
  /** 检索/读取类工具成功(只读不写) */
  sourceContextSuccess?: boolean;
  /** 本轮签名(如步骤标题/工具名) — 相同签名连续出现才累计 */
  signature?: string;
  /** 工具报错(用于重复错误检测) */
  toolError?: string | null;
  /** provider 调用失败 */
  providerFailure?: string | null;
  /** 写盘/入库计数 */
  writeCount?: number;
}

export interface WatchdogConfig {
  repeatedToolErrorThreshold: number;       // 同错误连续 ≥3 → warn
  sourceContextWithoutWriteThreshold: number; // 只读检索无产出 ≥8 → warn
  observeOnly: boolean;                     // 只告警不强制(observe-first)
}

const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  repeatedToolErrorThreshold: 3,
  sourceContextWithoutWriteThreshold: 8,
  observeOnly: true,
};

export interface WatchdogDecision {
  action: WatchdogAction;
  reason: string;
}

/** 进度哨兵(每轮调用 observe 喂事件) */
export class ProgressWatchdog {
  private config: WatchdogConfig;
  private toolErrorCount = 0;
  private lastToolError: string | null = null;
  private readOnlyCount = 0;
  private lastSignature: string | null = null;
  private warnedAt: { toolError?: number; readOnly?: number } = {};

  constructor(config?: Partial<WatchdogConfig>) {
    this.config = { ...DEFAULT_WATCHDOG_CONFIG, ...config };
  }

  observe(o: WatchdogObservation): WatchdogDecision {
    // 有产出 → 重置进度敏感计数
    if (o.artifactCompleted || (o.writeCount ?? 0) > 0) {
      this.toolErrorCount = 0;
      this.readOnlyCount = 0;
      this.lastToolError = null;
      this.lastSignature = null;
      return { action: "observe", reason: "progress" };
    }
    // 只读检索无产出累计(相同签名连续才算)
    if (o.sourceContextSuccess) {
      if (o.signature && o.signature === this.lastSignature) this.readOnlyCount++;
      else if (o.signature) { this.lastSignature = o.signature; this.readOnlyCount = 1; }
      else this.readOnlyCount++;
      if (this.readOnlyCount >= this.config.sourceContextWithoutWriteThreshold && this.readOnlyCount % this.config.sourceContextWithoutWriteThreshold === 0) {
        this.warnedAt.readOnly = this.readOnlyCount;
        return { action: this.config.observeOnly ? "warn" : "block", reason: `连续 ${this.readOnlyCount} 轮只读检索无产出(可能空转) — ${o.signature || "未知签名"}` };
      }
    }
    // 重复工具错误
    if (o.toolError) {
      if (o.toolError === this.lastToolError) this.toolErrorCount++;
      else { this.lastToolError = o.toolError; this.toolErrorCount = 1; }
      if (this.toolErrorCount >= this.config.repeatedToolErrorThreshold && this.toolErrorCount % this.config.repeatedToolErrorThreshold === 0) {
        this.warnedAt.toolError = this.toolErrorCount;
        return { action: this.config.observeOnly ? "warn" : "block", reason: `同工具错误重复 ${this.toolErrorCount} 次: ${o.toolError.slice(0, 80)}` };
      }
    }
    void this.warnedAt;
    return { action: "observe", reason: "no_signal" };
  }
}

// ═══ H4: Windows 子进程输出代码页感知解码(subprocess_encoding 移植) ═══
/**
 * 解码子进程输出字节: 先按 UTF-8 读; 若出现替换符/C1 控制符(疑似误读),
 * 回退到系统代码页(CP936 等)重读, 取"更不像误读"者。
 */
function misreadScore(t: string): number {
  let score = 0;
  for (let i = 0; i < t.length; i++) {
    const cp = t.charCodeAt(i);
    if (cp === 0xfffd) score += 1;            // 替换符
    else if (cp >= 0x80 && cp <= 0x9f) score += 1; // C1 控制符(代码页字节被当 UTF-8 的指纹)
  }
  return score;
}

/** 尽力探测 Windows 系统代码页名; 非 Windows 或探测失败 → null */
function windowsCodePage(): string | null {
  try {
    if (process.platform !== "win32") return null;
    // 无 execFileSync 时用环境变量/默认: 中文系统最常见 CP936
    return process.env.SAG_FALLBACK_CODEPAGE || "936";
  } catch { return null; }
}

/** 代码页号 → TextDecoder 标签(常用映射; 未知码页回退 gbk) */
function decoderLabelFor(cp: string): string {
  switch (String(cp).trim()) {
    case "936": case "gbk": return "gbk";
    case "932": case "sjis": return "shift_jis";
    case "949": case "ks_c_5601": return "euc-kr";
    case "950": case "big5": return "big5";
    case "65001": case "utf-8": return "utf-8";
    default: return "gbk";
  }
}

export function decodeSubprocessOutput(raw: Buffer | Uint8Array | null | undefined): string {
  if (!raw || raw.length === 0) return "";
  const bytes = Buffer.from(raw);
  // 1) UTF-8 读取
  const utf8Text = bytes.toString("utf8");
  const utf8Score = misreadScore(utf8Text);
  // 2) 系统代码页回退(utf8 读起来明显像误读才试)
  if (utf8Score === 0) return utf8Text;
  try {
    const label = decoderLabelFor(windowsCodePage() || "936");
    if (label === "utf-8") return utf8Text;
    const fallback = new TextDecoder(label).decode(bytes);
    const fallbackScore = misreadScore(fallback);
    if (fallbackScore < utf8Score) return fallback;
  } catch { /* TextDecoder 不支持该编码 → 保持 utf8 */ }
  return utf8Text;
}

/** 给 Python 子进程注入 UTF-8 输出环境(从源头避免乱码) */
export function pythonUtf8Env(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
}

export const runtimeGuards = { RepetitionGuard, ProgressWatchdog, decodeSubprocessOutput, pythonUtf8Env };
