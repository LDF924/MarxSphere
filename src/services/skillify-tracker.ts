// skillify-tracker.ts — Skillify 自动检测固化（GBrain 机制6）
// 记录检索/工作流模式，检测重复成功（≥3 次同类）→ 生成候选 skill
import fs from "node:fs";
import path from "node:path";

const TRACK_FILE = path.join(process.env.SAG_ROOT || process.cwd(), "skillify-tracking.json");

interface TrackedPattern {
  topic: string;         // 主题（query 关键词）
  count: number;
  lastQuery: string;
  lastAt: string;
  evidenceSamples: string[];
}

interface TrackingData {
  patterns: TrackedPattern[];
}

function loadTracking(): TrackingData {
  try {
    if (fs.existsSync(TRACK_FILE)) {
      return JSON.parse(fs.readFileSync(TRACK_FILE, "utf-8"));
    }
  } catch {
    // 损坏则重建
  }
  return { patterns: [] };
}

function saveTracking(data: TrackingData): void {
  fs.writeFileSync(TRACK_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function extractTopic(query: string): string {
  // 取 query 的核心词（去掉疑问词/连接词）
  const cleaned = query.replace(/[？?。，,、；;：:！!（）()"「」『』《》【】\[\]{}''\s]/g, " ")
    .split(" ")
    .filter((w: string) => w.length >= 2 && w.length <= 12)
    .slice(0, 3);
  return cleaned.join("·") || query.slice(0, 10);
}

/**
 * 记录一次检索/工作流
 */
export function recordPattern(query: string, success: boolean, evidenceTitles: string[] = []): void {
  if (!success || !query.trim()) return;
  const data = loadTracking();
  const topic = extractTopic(query);

  const existing = data.patterns.find((p) => p.topic === topic);
  if (existing) {
    existing.count += 1;
    existing.lastQuery = query;
    existing.lastAt = new Date().toISOString();
    if (evidenceTitles.length > 0) {
      existing.evidenceSamples = existing.evidenceSamples.concat(evidenceTitles.slice(0, 2)).slice(0, 5);
    }
  } else {
    data.patterns.push({
      topic,
      count: 1,
      lastQuery: query,
      lastAt: new Date().toISOString(),
      evidenceSamples: evidenceTitles.slice(0, 5)
    });
  }
  saveTracking(data);
}

/**
 * 检测重复成功模式（≥ threshold 次的同类工作流）→ 候选 skill
 */
export function detectSkillifyCandidates(threshold = 3): Array<{
  topic: string;
  count: number;
  lastQuery: string;
  evidenceSamples: string[];
}> {
  const data = loadTracking();
  return data.patterns
    .filter((p) => p.count >= threshold)
    .sort((a, b) => b.count - a.count)
    .map((p) => ({
      topic: p.topic,
      count: p.count,
      lastQuery: p.lastQuery,
      evidenceSamples: p.evidenceSamples
    }));
}

/**
 * 清空追踪数据（测试用）
 */
export function resetTracking(): void {
  saveTracking({ patterns: [] });
}

export const skillifyTracker = {
  recordPattern,
  detectSkillifyCandidates,
  resetTracking,
  trackFile: TRACK_FILE
};
