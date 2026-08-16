// retrieval-sources.ts — 检索源配置（三库任意组合：PG / Neo4j Graphiti / Neo4j Cognee）
// 设计目标：Ask 18 步 / 推理 49 步的检索源全可配置——
//   全关 / 只开一个 / 任意两个 / 全开，由前端开关 + localStorage 持久化
//
// 统一结果模型：三源输出归一化为 RetrievalHit { id, title, content, score, source }

export type RetrievalSource = "pg" | "graphiti" | "cognee";

export interface RetrievalSourceConfig {
  sources: RetrievalSource[];
}

/** 统一检索命中（三源归一化） */
export interface RetrievalHit {
  id: string;
  title: string;
  content: string;
  score: number;
  source: RetrievalSource;
  /** 原始数据（调试用） */
  raw?: unknown;
}

const DEFAULT_SOURCES: RetrievalSource[] = ["pg"];

const STORAGE_KEY_PREFIX = "sag:retrieval-sources:";

/** 读取某链路的源配置（localStorage 持久化，服务端用内存默认） */
export function loadSourceConfig(chain: "ask" | "reason", storage?: Pick<Storage, "getItem">): RetrievalSourceConfig {
  try {
    const raw = storage?.getItem(`${STORAGE_KEY_PREFIX}${chain}`);
    if (!raw) return { sources: [...DEFAULT_SOURCES] };
    const parsed = JSON.parse(raw) as { sources?: RetrievalSource[] };
    const sources = (parsed.sources ?? []).filter((s): s is RetrievalSource => s === "pg" || s === "graphiti" || s === "cognee");
    return { sources: sources.length > 0 ? sources : [...DEFAULT_SOURCES] };
  } catch {
    return { sources: [...DEFAULT_SOURCES] };
  }
}

/** 保存源配置（localStorage） */
export function saveSourceConfig(chain: "ask" | "reason", config: RetrievalSourceConfig, storage?: Pick<Storage, "setItem">): void {
  try {
    storage?.setItem(`${STORAGE_KEY_PREFIX}${chain}`, JSON.stringify(config));
  } catch { /* 忽略 */ }
}

/** 某源是否启用 */
export function hasSource(config: RetrievalSourceConfig, source: RetrievalSource): boolean {
  return config.sources.includes(source);
}
