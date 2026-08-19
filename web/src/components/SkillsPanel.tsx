// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// SkillsPanel.tsx — 技能注册表面板：列出全部 skill + 触发词 + 健康检查 + Skillify 固化 + 自动更新检测 + GitHub 发现
import { useState, useEffect, type FC } from "react";
import { Boxes, BookOpen, ChevronRight, Copy, Check, Loader2, Play, ExternalLink, CheckCircle2, XCircle, Wand2, Plus, Sparkles, Search, X, RefreshCw, Star, GitBranch, AlertTriangle, MessageSquareText } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { LlmModelSelector, TASK_ROLES } from "./LlmModelSelector";
import type { SkillRecord, SkillUpdateResult, DiscoverResult } from "../types";

interface HealthResult {
  status: string;
  output: string;
  exitCode: number | null;
}

export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [healthMap, setHealthMap] = useState<Record<string, HealthResult>>({});
  const [checking, setChecking] = useState<string | null>(null);
  // V327: 技能审计摘要（P1-2）
  const [audit, setAudit] = useState<{ exists: boolean; total?: number; complete?: number; gaps?: Array<{ gap: string; count: number }> } | null>(null);
  const loadAudit = () => { void api.getSkillAudit().then(setAudit).catch(() => setAudit(null)); };
  useEffect(() => {
    loadAudit();
    const timer = window.setInterval(loadAudit, 30000);
    return () => window.clearInterval(timer);
  }, []);
  // V331: 技能语义搜索（P1-3 找技能）
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ skillName: string; similarity: number }> | null>(null);
  const [searching, setSearching] = useState(false);
  const doSearch = async () => {
    const q = searchQ.trim();
    if (!q) { setSearchResults(null); return; }
    setSearching(true);
    try {
      const r = await api.searchSkills(q);
      setSearchResults(r.candidates);
    } catch { setSearchResults([]); }
    setSearching(false);
  };
  // Skillify 表单状态
  const [showSkillify, setShowSkillify] = useState(false);
  const [skName, setSkName] = useState("");
  const [skTitle, setSkTitle] = useState("");
  const [skDesc, setSkDesc] = useState("");
  const [skTriggers, setSkTriggers] = useState("");
  const [skSteps, setSkSteps] = useState("");
  const [skChecklist, setSkChecklist] = useState("");
  const [skResult, setSkResult] = useState<string | null>(null);
  const [skillifying, setSkillifying] = useState(false);
  // Skillify 自动检测候选
  const [candidates, setCandidates] = useState<Array<{ topic: string; count: number; lastQuery: string }>>([]);
  const [generating, setGenerating] = useState<string | null>(null);
  // 详情弹层
  const [detailSkill, setDetailSkill] = useState<SkillRecord | null>(null);
  const [detail, setDetail] = useState<{ skillMd: string; zhDoc?: string; files: string[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 搜索 + 全展开
  const [searchQuery, setSearchQuery] = useState("");
  const [allOpen, setAllOpen] = useState(false);
  const [copiedSkill, setCopiedSkill] = useState<string | null>(null);
  // 自动更新检测
  const [updates, setUpdates] = useState<SkillUpdateResult | null>(null);
  const [updateLoading, setUpdateLoading] = useState(false);
  const [upstreamChecking, setUpstreamChecking] = useState(false);
  const [confirmedSkills, setConfirmedSkills] = useState<Set<string>>(new Set());
  // GitHub 发现
  const [ghNeed, setGhNeed] = useState("");
  const [ghMode, setGhMode] = useState<"api" | "claude">("api");
  const [ghLoading, setGhLoading] = useState(false);
  const [ghResult, setGhResult] = useState<DiscoverResult | null>(null);
  const [ghError, setGhError] = useState<string | null>(null);
  const [ghAiAvailable, setGhAiAvailable] = useState<boolean | null>(null);
  const [ghScope, setGhScope] = useState<"repositories" | "code" | "users" | "issues">("repositories");
  const [ghDirectQuery, setGhDirectQuery] = useState("");
  const [ghDirectResults, setGhDirectResults] = useState<Array<Record<string, unknown>>>([]);
  const [ghDirectLoading, setGhDirectLoading] = useState(false);

  const runScan = async () => {
    setUpdateLoading(true);
    try {
      const r = await api.scanSkillUpdates();
      setUpdates(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdateLoading(false);
    }
  };

  const checkUpstream = async () => {
    setUpstreamChecking(true);
    try {
      const r = await api.checkSkillUpstream();
      setUpdates(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpstreamChecking(false);
    }
  };

  const confirmSkill = async (name: string) => {
    try {
      const r = await api.confirmNewSkill(name);
      setConfirmedSkills((prev) => new Set(prev).add(name));
      setUpdates((prev) => prev ? { ...prev, newSkills: prev.newSkills.filter((s) => s.name !== name) } : prev);
      if (r.ok) setSkResult(`✅ 已添加技能 ${name}（归类：${r.category}）`);
      api.listSkills().then((data) => setSkills(data.skills));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const dismissModification = async (name: string) => {
    try {
      await api.dismissSkillUpdate(name);
      setUpdates((prev) => prev ? { ...prev, modifiedSkills: prev.modifiedSkills.filter((s) => s.name !== name) } : prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runDiscover = async () => {
    if (!ghNeed.trim()) return;
    setGhLoading(true);
    setGhError(null);
    try {
      const r = await api.githubDiscover({ need: ghNeed.trim(), mode: ghMode });
      setGhResult(r);
    } catch (err) {
      setGhError(err instanceof Error ? err.message : String(err));
    } finally {
      setGhLoading(false);
    }
  };

  const runDirectSearch = async () => {
    if (!ghDirectQuery.trim()) return;
    setGhDirectLoading(true);
    setGhError(null);
    try {
      const r = await api.searchExternalSource({ source: "github", query: ghDirectQuery.trim(), limit: 8 });
      if (r.error) setGhError(r.error);
      else setGhDirectResults(r.items);
    } catch (err) {
      setGhError(err instanceof Error ? err.message : String(err));
    } finally {
      setGhDirectLoading(false);
    }
  };

  useEffect(() => {
    api.listSkills()
      .then((data) => setSkills(data.skills))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
    // 加载 Skillify 候选
    api.getSkillifyCandidates(3)
      .then((data) => setCandidates(data.candidates))
      .catch(() => {});
    // 技能更新检测（首次进面板即建基线）
    void runScan();
    // Claude Code 可用性探测（GitHub 发现智能模式）
    api.aiExecuteStatus()
      .then((s) => setGhAiAvailable(s.available))
      .catch(() => setGhAiAvailable(false));
  }, []);

  const openDetail = async (skill: SkillRecord) => {
    setDetailSkill(skill);
    setDetailLoading(true);
    setDetail(null);
    try {
      const data = await api.getSkillDetail(skill.name);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const copyTriggers = async (skill: SkillRecord) => {
    const text = skill.triggers.length > 0 ? skill.triggers.slice(0, 6).join("、") : skill.zhName || skill.name;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedSkill(skill.name);
      setTimeout(() => setCopiedSkill(null), 1500);
    } catch {
      setError("复制失败");
    }
  };

  useEffect(() => {
    api.listSkills()
      .then((data) => setSkills(data.skills))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
    // 加载 Skillify 候选
    api.getSkillifyCandidates(3)
      .then((data) => setCandidates(data.candidates))
      .catch(() => {});
  }, []);

  const runHealthcheck = async (skill: SkillRecord) => {
    if (!skill.hasHealthcheck) return;
    setChecking(skill.name);
    try {
      const result = await api.runSkillHealthcheck(skill.name);
      setHealthMap((prev) => ({ ...prev, [skill.name]: result }));
    } catch (err) {
      setHealthMap((prev) => ({
        ...prev,
        [skill.name]: { status: "error", output: err instanceof Error ? err.message : String(err), exitCode: null }
      }));
    } finally {
      setChecking(null);
    }
  };

  const doSkillify = async () => {
    if (!skName.trim() || !skSteps.trim()) return;
    setSkillifying(true);
    setSkResult(null);
    try {
      const result = await api.skillify({
        name: skName.trim(),
        title: skTitle.trim() || skName.trim(),
        description: skDesc.trim() || undefined,
        triggers: skTriggers.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        steps: skSteps.split("\n").map((s) => s.trim()).filter(Boolean),
        checklist: skChecklist.split("\n").map((s) => s.trim()).filter(Boolean)
      });
      if (result.ok) {
        setSkResult(`✅ Skillify 成功: ${result.path}`);
        setSkName(""); setSkTitle(""); setSkDesc(""); setSkTriggers(""); setSkSteps(""); setSkChecklist("");
        setShowSkillify(false);
        api.listSkills().then((data) => setSkills(data.skills));
      } else {
        setSkResult(`❌ ${result.error}`);
      }
    } catch (err) {
      setSkResult(`❌ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSkillifying(false);
    }
  };

  const generateCandidate = async (topic: string) => {
    setGenerating(topic);
    try {
      const result = await api.generateSkillifySkill(topic);
      if (result.ok) {
        setSkResult(`✅ 自动固化成功: ${result.path}`);
        setCandidates((prev) => prev.filter((c) => c.topic !== topic));
        api.listSkills().then((data) => setSkills(data.skills));
      } else {
        setSkResult(`❌ ${result.error}`);
      }
    } catch (err) {
      setSkResult(`❌ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenerating(null);
    }
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto w-full max-w-[1400px] space-y-4">
        <div className="flex items-center gap-2">
          <Boxes className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">技能注册表（{skills.length} 个 skill）</h2>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => { setShowSkillify((current) => !current); setSkResult(null); }}>
            <Wand2 className="mr-1 h-3.5 w-3.5" /> Skillify 固化
          </Button>
        </div>

        {/* V327: 技能审计摘要条（P1-2 前端展示） */}
        <div className="rounded-md border border-border bg-background p-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="flex items-center gap-1 font-medium"><CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> 描述四要素（触发/边界/示例/代价）</span>
            {audit ? (
              <>
                <span className="rounded bg-green-50 px-1.5 py-0.5 text-green-700">齐全 {audit.complete}/{audit.total}</span>
                {(audit.gaps || []).map((g) => (
                  <span key={g.gap} className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">{g.gap} {g.count}</span>
                ))}
                {audit.complete === audit.total && (
                  <span className="text-green-600">✅ 全部达标</span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">审计报告未生成（运行 scripts/audit-skill-descriptions.ts）</span>
            )}
            <button type="button" onClick={loadAudit} className="ml-auto flex items-center gap-1 rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted/70">
              <RefreshCw className="h-3 w-3" /> 刷新
            </button>
          </div>
        </div>

        {/* V331: 技能语义搜索框（P1-3 找技能）— 输入需求语义找技能 */}
        <div className="rounded-md border border-border bg-background p-2.5">
          <div className="flex items-center gap-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void doSearch(); }}
              placeholder="输入需求找技能，如「用 R 做面板数据回归」「写学术论文」…"
              className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/50 focus:border-primary"
            />
            <button type="button" onClick={() => void doSearch()} disabled={searching}
              className="flex items-center gap-1 rounded bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {searching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />} 找技能
            </button>
          </div>
          {searchResults !== null && (
            <div className="mt-2 space-y-1">
              {searchResults.length === 0 ? (
                <div className="text-xs text-muted-foreground">未找到匹配技能（低于相似度阈值，可换个说法）</div>
              ) : (
                searchResults.map((r, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 rounded border border-border/50 px-2 py-1 text-xs">
                    <span className="truncate">{r.skillName}</span>
                    <span className="shrink-0 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700">{(r.similarity * 100).toFixed(0)}%</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* 工具栏：搜索 + 展开/收起全部 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="搜索技能（名称 / 中文名 / 触发词 / 描述）…"
              className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-8 text-sm outline-none transition-all duration-150 placeholder:text-muted-foreground hover:border-primary/40 focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/70"
            />
            {searchQuery ? (
              <button type="button" onClick={() => setSearchQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent" aria-label="清空">
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <Button size="sm" variant="outline" onClick={() => setAllOpen((current) => !current)}>
            {allOpen ? <ChevronRight className="mr-1 h-3.5 w-3.5 rotate-90" /> : <ChevronRight className="mr-1 h-3.5 w-3.5" />}
            {allOpen ? "全部收起" : "全部展开"}
          </Button>
        </div>

        {/* 自动更新检测横幅 */}
        {!updateLoading && updates && (updates.newSkills.length > 0 || updates.modifiedSkills.length > 0 || updates.upstreamUpdates.length > 0 || updates.baselineEstablished) && (() => {
          const lastShown = Number(localStorage.getItem("sag:skill-update-version") ?? "0");
          const hasNew = updates.newSkills.length + updates.modifiedSkills.length + updates.upstreamUpdates.length > 0;
          if (updates.baselineEstablished && !hasNew && lastShown >= updates.baselineVersion) return null;
          if (hasNew && lastShown >= updates.baselineVersion) return null;
          const dismiss = () => localStorage.setItem("sag:skill-update-version", String(updates.baselineVersion));
          return (
            <Card className="border-accent/40 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <GitBranch className="h-4 w-4 text-accent" />
                {updates.baselineEstablished ? `技能基线已建立（${updates.stats.total} 项）· 扫描 ${updates.stats.scannedMs}ms` : `技能更新检测（扫描 ${updates.stats.total} 项 · ${updates.stats.scannedMs}ms）`}
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" variant="outline" disabled={upstreamChecking} onClick={() => void checkUpstream()}>
                    {upstreamChecking ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                    检查上游更新
                  </Button>
                  {!updates.baselineEstablished && (
                    <Button size="sm" variant="outline" onClick={() => { dismiss(); }}>
                      知道了
                    </Button>
                  )}
                </div>
              </div>
              <div className="mb-2 flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={updateLoading} onClick={() => void runScan()}>
                  {updateLoading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                  重新扫描
                </Button>
              </div>

              {updates.newSkills.length > 0 && (
                <div className="space-y-2">
                  <div className="text-sm font-medium text-primary">🆕 发现 {updates.newSkills.length} 个新技能（点击确认添加）</div>
                  {updates.newSkills.map((skill) => (
                    <div key={skill.name} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium font-mono">{skill.name}</div>
                        <div className="text-xs text-muted-foreground">
                          自动归类：
                          <span className={cn("rounded px-1.5 py-0.5 text-xs", skill.category === "未分类" ? "bg-yellow-100 text-yellow-700" : "bg-accent text-muted-foreground")}>
                            {skill.category}
                          </span>
                          {skill.category === "未分类" ? "（建议手动补充 category_zh 后刷新）" : ""}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button size="sm" variant="outline" disabled={confirmedSkills.has(skill.name)} onClick={() => void confirmSkill(skill.name)}>
                          {confirmedSkills.has(skill.name) ? <Check className="mr-1 h-3.5 w-3.5 text-green-600" /> : <Plus className="mr-1 h-3.5 w-3.5" />}
                          确认添加
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {updates.modifiedSkills.length > 0 && (
                <div className="mt-2 space-y-1">
                  <div className="text-sm font-medium text-amber-600">⚠️ {updates.modifiedSkills.length} 个技能本地已修改</div>
                  {updates.modifiedSkills.slice(0, 8).map((m) => (
                    <div key={m.name} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-1.5">
                      <div className="min-w-0">
                        <span className="font-mono text-xs font-medium">{m.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {m.kind === "content" ? "内容变更" : "文件变更"} · 自 {new Date(m.since).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => void dismissModification(m.name)}>知道了</Button>
                    </div>
                  ))}
                  {updates.modifiedSkills.length > 8 && (
                    <div className="text-xs text-muted-foreground">…还有 {updates.modifiedSkills.length - 8} 项</div>
                  )}
                </div>
              )}

              {updates.upstreamUpdates.length > 0 && (
                <div className="mt-2 space-y-1">
                  <div className="text-sm font-medium text-blue-600">🌐 {updates.upstreamUpdates.length} 个技能 GitHub 上游有新版本</div>
                  {updates.upstreamUpdates.map((u) => (
                    <div key={u.name} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-1.5">
                      <div className="min-w-0 text-xs">
                        <span className="font-mono font-medium">{u.name}</span>
                        <span className="ml-2 text-muted-foreground">本地 {u.localVersion} → 上游 {u.latestVersion}</span>
                      </div>
                      <a href={u.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline">
                        打开仓库 <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          );
        })()}

        {/* GitHub 发现（需求直通 + 直接搜索） */}
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <GitBranch className="h-4 w-4 text-primary" /> GitHub 发现（开源技能/工具检索）
          </div>
          <Textarea
            value={ghNeed}
            onChange={(event) => setGhNeed(event.target.value)}
            placeholder="用自然语言描述需求，例如：我想找三农领域开源的数据分析工具，支持中文语料的文本挖掘…"
            rows={2}
            className="mb-2"
          />
          <div className="flex flex-wrap items-center gap-2">
            {(["api", "claude"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setGhMode(m)}
                disabled={m === "claude" && ghAiAvailable === false}
                title={m === "claude" && ghAiAvailable === false ? "LLM API 不可用" : undefined}
                className={cn(
                  "rounded-full px-3 py-1 text-xs transition-colors",
                  ghMode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                  m === "claude" && ghAiAvailable === false && "cursor-not-allowed opacity-50"
                )}
              >
                {/* 2026-08-07 Claude Code 智能 → LLM 智能（直调 LLM API） */}
                {m === "api" ? "纯 API 快速" : "LLM 智能"}
              </button>
            ))}
            {/* 2026-08-07 LLM 模型选择 */}
            <LlmModelSelector roles={TASK_ROLES.search} />
            <Button size="sm" disabled={ghLoading || !ghNeed.trim()} onClick={() => void runDiscover()}>
              {ghLoading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Search className="mr-1 h-3.5 w-3.5" />}
              发现
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <select
                value={ghScope}
                onChange={(event) => setGhScope(event.target.value as typeof ghScope)}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
              >
                <option value="repositories">仓库</option>
                <option value="code">代码</option>
                <option value="users">用户</option>
                <option value="issues">议题</option>
              </select>
              <input
                value={ghDirectQuery}
                onChange={(event) => setGhDirectQuery(event.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void runDirectSearch(); }}
                placeholder="直接搜索 GitHub…"
                className="h-8 w-52 rounded-md border border-border bg-background px-2 text-xs"
              />
              <Button size="sm" variant="outline" disabled={ghDirectLoading || !ghDirectQuery.trim()} onClick={() => void runDirectSearch()}>
                {ghDirectLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>

          {ghError && <div className="mt-2 rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">{ghError}</div>}
          {ghResult?.rateLimited && (
            <div className="mt-2 rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
              GitHub 匿名限流（60 次/时）已接近上限。在 .env 配置 GITHUB_TOKEN 可提升至 5000 次/时。
            </div>
          )}

          {ghResult?.analysis && (
            <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
              <div className="mb-1 flex items-center gap-1 text-xs font-medium text-primary">
                <MessageSquareText className="h-3.5 w-3.5" /> Claude Code 筛选结论
              </div>
              <pre className="whitespace-pre-wrap text-xs leading-5">{ghResult.analysis.slice(0, 2000)}</pre>
            </div>
          )}

          {ghResult && ghResult.items.length > 0 && (
            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
              {ghResult.items.map((item, index) => (
                <div key={index} className="rounded border border-border p-2">
                  <div className="flex items-center gap-1">
                    <span className="truncate font-mono text-xs font-medium">{item.repo}</span>
                    {item.matchedTerm && <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.matchedTerm}</span>}
                  </div>
                  {item.stars > 0 && (
                    <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      <Star className="h-3 w-3 text-amber-400" /> {item.stars.toLocaleString()}
                      {item.language ? ` · ${item.language}` : ""}
                    </div>
                  )}
                  {item.description && <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.description}</div>}
                  {item.url && <a href={item.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-primary hover:underline">打开 →</a>}
                </div>
              ))}
            </div>
          )}

          {ghDirectResults.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="text-xs font-medium text-muted-foreground">直通搜索「{ghDirectQuery}」结果（{ghDirectResults.length}）</div>
              {ghDirectResults.map((rec, index) => {
                const r = rec as Record<string, unknown>;
                const title = String(r.name ?? r.title ?? "");
                const stars = r.stars ? Number(r.stars) : 0;
                const language = String(r.language ?? "");
                const description = String(r.description ?? "");
                const url = r.url ? String(r.url) : "";
                return (
                  <div key={index} className="rounded border border-border p-2">
                    <div className="text-sm font-medium">{title.slice(0, 100)}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {stars > 0 && <span className="mr-1">⭐ {stars.toLocaleString()}</span>}
                      {language ? <span className="mr-1">· {language}</span> : null}
                      {description ? `· ${description.slice(0, 90)}` : ""}
                    </div>
                    {url && <a href={url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">查看 →</a>}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Skillify 自动检测候选（GBrain 机制6） */}
        {candidates.length > 0 && (
          <Card className="border-accent/40 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-4 w-4 text-accent" /> Skillify 检测到重复工作流（可固化）
            </div>
            <div className="space-y-2">
              {candidates.map((candidate) => (
                <div key={candidate.topic} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{candidate.topic}</div>
                    <div className="text-xs text-muted-foreground">已成功 {candidate.count} 次 · 最近: {candidate.lastQuery.slice(0, 30)}</div>
                  </div>
                  <Button size="sm" variant="outline" disabled={generating === candidate.topic} onClick={() => void generateCandidate(candidate.topic)}>
                    {generating === candidate.topic ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1 h-3.5 w-3.5" />}
                    固化为 skill
                  </Button>
                </div>
              ))}
            </div>
          </Card>
        )}

        {showSkillify && (
          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <Wand2 className="h-4 w-4" /> 把成功工作流固化为 skill
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <input
                value={skName}
                onChange={(event) => setSkName(event.target.value)}
                placeholder="skill 名（小写英文，如 marx-litreview）"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <input
                value={skTitle}
                onChange={(event) => setSkTitle(event.target.value)}
                placeholder="标题（如：马理论文献综述工作流）"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <input
              value={skDesc}
              onChange={(event) => setSkDesc(event.target.value)}
              placeholder="一句话描述（会成为 skill 的 description）"
              className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <input
              value={skTriggers}
              onChange={(event) => setSkTriggers(event.target.value)}
              placeholder="触发词（逗号分隔，如：文献综述,引文追踪）"
              className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <Textarea
              value={skSteps}
              onChange={(event) => setSkSteps(event.target.value)}
              placeholder={"执行步骤（每行一步）\n1. 外部检索\n2. 引文滚雪球\n3. 证据核验"}
              rows={4}
              className="mt-2"
            />
            <Textarea
              value={skChecklist}
              onChange={(event) => setSkChecklist(event.target.value)}
              placeholder="Checklist（每行一项，可选）：每论断有出处 / 引用真实"
              rows={2}
              className="mt-2"
            />
            <div className="mt-3 flex items-center gap-2">
              <Button onClick={() => void doSkillify()} disabled={skillifying || !skName.trim() || !skSteps.trim()}>
                {skillifying ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
                固化生成
              </Button>
              <Button variant="outline" onClick={() => setShowSkillify(false)}>取消</Button>
            </div>
            {skResult && <div className="mt-2 text-sm">{skResult}</div>}
          </Card>
        )}

        {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>}

        {/* 按分类分组：可折叠收纳（点标题展开/收起），按研究相关性排序 */}
        {(() => {
          const groups = new Map<string, typeof skills>();
          for (const skill of skills) {
            const cat = skill.zhCategory || "未分类";
            if (!groups.has(cat)) groups.set(cat, []);
            groups.get(cat)!.push(skill);
          }
          // 搜索过滤
          const q = searchQuery.trim().toLowerCase();
          if (q) {
            for (const [cat, list] of groups) {
              const filtered = list.filter((s) =>
                s.name.toLowerCase().includes(q) ||
                (s.zhName || "").toLowerCase().includes(q) ||
                (s.description || "").toLowerCase().includes(q) ||
                (s.triggers || []).some((t) => t.toLowerCase().includes(q))
              );
              groups.set(cat, filtered);
            }
          }
          // 哲社科研究相关性优先级：核心写作/检索 → 研究方法 → 管理/图谱 → 辅助 → 视觉/设计
          const CAT_PRIORITY = [
            "总入口", "推理检索", "知识图谱",
            "论文写作", "文献检索", "文献引用", "文献阅读",
            "研究方法", "实证分析",
            "知识管理", "基金申报", "研究报告",
            "数据工具", "内部支持",
            "绘图", "汇报展示", "设计", "工具", "未分类"
          ];
          const sortedCats = Array.from(groups.keys())
            .filter((cat) => groups.get(cat)!.length > 0)
            .sort((a, b) => {
              const ia = CAT_PRIORITY.indexOf(a);
              const ib = CAT_PRIORITY.indexOf(b);
              return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
            });
          if (sortedCats.length === 0) {
            return <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">未找到匹配「{searchQuery}」的技能</div>;
          }
          return sortedCats.map((cat) => (
            <CategoryGroup
              key={`${cat}-${allOpen ? "open" : "local"}`}
              name={cat}
              skills={groups.get(cat)!}
              checking={checking}
              healthMap={healthMap}
              onHealthcheck={runHealthcheck}
              onOpenDetail={(s) => void openDetail(s)}
              onCopyTriggers={(s) => void copyTriggers(s)}
              initiallyOpen={allOpen || Boolean(q)}
              copiedSkill={copiedSkill}
            />
          ));
        })()}

        {/* 技能详情弹层 */}
        {detailSkill ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setDetailSkill(null)}>
            <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-background shadow-xl" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">{detailSkill.name}</span>
                    {detailSkill.zhName ? <span className="rounded bg-primary/15 px-1.5 py-0.5 text-xs text-primary">{detailSkill.zhName}</span> : null}
                    {detailSkill.zhCategory ? <span className="rounded bg-accent px-1.5 py-0.5 text-xs text-muted-foreground">{detailSkill.zhCategory}</span> : null}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{detailSkill.path}</div>
                </div>
                <button type="button" onClick={() => setDetailSkill(null)} className="rounded-md p-1 text-muted-foreground hover:bg-accent" aria-label="关闭">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {detailLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载详情…</div>
                ) : detail ? (
                  <div className="space-y-4">
                    {detail.zhDoc ? (
                      <div>
                        <div className="mb-1 text-xs font-semibold text-primary">中文说明</div>
                        <pre className="whitespace-pre-wrap rounded bg-muted/40 p-3 text-xs leading-5">{detail.zhDoc.slice(0, 3000)}</pre>
                      </div>
                    ) : null}
                    <div>
                      <div className="mb-1 text-xs font-semibold text-primary">SKILL.md 内容</div>
                      <pre className="max-h-96 whitespace-pre-wrap overflow-y-auto rounded bg-muted/40 p-3 font-mono text-[11px] leading-5">{detail.skillMd.slice(0, 6000)}</pre>
                    </div>
                    <div>
                      <div className="mb-1 text-xs font-semibold text-primary">文件结构（{detail.files.length}）</div>
                      <div className="flex flex-wrap gap-1">
                        {detail.files.map((f) => (
                          <span key={f} className="rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{f}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">详情加载失败</div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {!loading && skills.length === 0 && <div className="text-sm text-muted-foreground">未发现任何 skill</div>}
      </div>
    </section>
  );
}

/** 分类折叠组：默认收起，点击标题展开 */
function CategoryGroup(props: {
  name: string;
  skills: SkillRecord[];
  checking: string | null;
  healthMap: Record<string, HealthResult>;
  onHealthcheck: (skill: SkillRecord) => void;
  onOpenDetail: (skill: SkillRecord) => void;
  onCopyTriggers: (skill: SkillRecord) => void;
  initiallyOpen?: boolean;
  copiedSkill?: string | null;
}) {
  const { name, skills } = props;
  const [open, setOpen] = useState(Boolean(props.initiallyOpen));
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 bg-accent/30 px-3 py-2 text-left transition-colors hover:bg-accent/50"
        aria-expanded={open}
      >
        <span className={cn("text-muted-foreground transition-transform duration-200", open && "rotate-90")}>
          <ChevronRight className="h-4 w-4" />
        </span>
        <span className="text-sm font-semibold">{name}</span>
        <span className="rounded bg-primary/15 px-1.5 py-0.5 text-xs text-primary">{skills.length}</span>
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">{open ? "收起" : "展开"}</span>
      </button>
      {open ? (
        <div className="grid grid-cols-1 gap-3 p-2 md:grid-cols-2">
          {skills.map((skill) => (
            <SkillCard key={skill.name} skill={skill} checking={props.checking} healthMap={props.healthMap} onHealthcheck={props.onHealthcheck} onOpenDetail={props.onOpenDetail} onCopyTriggers={props.onCopyTriggers} copied={props.copiedSkill === skill.name} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 过滤非中英文字符（韩文/日文等触发词不展示） */
function filterTriggers(triggers: string[]) {
  return triggers
    .map((t) => t.replace(/[^一-鿿぀-ヿa-zA-Z0-9\s\-（）()·.]+/g, "").trim())
    .filter(Boolean);
}

/** 过滤描述中的韩文/日文（保留中英文与标点） */
function filterNonCJK(text: string) {
  if (!text) return text;
  return text
    .replace(/[가-힣ㄱ-ㅎㅏ-ㅣ]+/g, "")
    .replace(/[ぁ-んァ-ン]+/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/,\s*,+/g, ",")
    .trim();
}

function SkillCard(props: {
  skill: SkillRecord;
  checking: string | null;
  healthMap: Record<string, HealthResult>;
  onHealthcheck: (skill: SkillRecord) => void;
  onOpenDetail: (skill: SkillRecord) => void;
  onCopyTriggers: (skill: SkillRecord) => void;
  copied?: boolean;
}) {
  const { skill, checking, healthMap, copied } = props;
  const triggers = filterTriggers(skill.triggers).slice(0, 8);
  const health = healthMap[skill.name];
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold">{skill.name}</span>
            {skill.zhName ? (
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-xs font-medium text-primary">{skill.zhName}</span>
            ) : null}
            {skill.zhCategory ? (
              <span className="rounded bg-accent px-1.5 py-0.5 text-xs text-muted-foreground">{skill.zhCategory}</span>
            ) : null}
          </div>
          <div className="mt-1 line-clamp-3 text-xs text-muted-foreground">{filterNonCJK(skill.zhDescription || skill.description) || "(无描述)"}</div>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-xs",
            skill.hasHealthcheck ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground"
          )}
          title={skill.hasHealthcheck ? "该技能带自检脚本，可运行健康检查" : "该技能无健康检查脚本（外部下载技能包特性，不影响使用）"}
        >
          {skill.hasHealthcheck ? "健康检查✓" : "无脚本"}
        </span>
      </div>

      {triggers.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {triggers.map((trigger) => (
            <span key={trigger} className="rounded bg-accent px-1.5 py-0.5 text-xs">{trigger}</span>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Button variant="outline" size="sm" onClick={() => void props.onOpenDetail(skill)}>
          <BookOpen className="mr-1 h-3.5 w-3.5" />
          查看详情
        </Button>
        <Button variant="outline" size="sm" onClick={() => void props.onCopyTriggers(skill)}>
          {copied ? <Check className="mr-1 h-3.5 w-3.5 text-green-600" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
          {copied ? "已复制" : "复制触发词"}
        </Button>
        {skill.hasHealthcheck && (
          <Button variant="outline" size="sm" disabled={checking === skill.name} onClick={() => void props.onHealthcheck(skill)}>
            {checking === skill.name ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />}
            健康检查
          </Button>
        )}
        <a href={`file:///${skill.skillMdPath.replace(/\\/g, "/")}`} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline">
          SKILL.md <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {health && (
        <div className={cn(
          "mt-3 rounded-md border px-3 py-2 text-xs",
          health.status === "ok" ? "border-green-200 bg-green-50 text-green-700" : "border-yellow-200 bg-yellow-50 text-yellow-800"
        )}>
          <div className="flex items-center gap-1 font-medium">
            {health.status === "ok" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
            {health.status === "ok" ? "通过" : `异常（exit ${health.exitCode ?? "?"}）`}
          </div>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[10px]">{health.output.slice(0, 600)}</pre>
        </div>
      )}
    </Card>
  );
}
