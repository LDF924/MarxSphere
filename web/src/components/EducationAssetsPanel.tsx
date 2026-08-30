// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// EducationAssetsPanel.tsx — 教育复用资产浏览（V389：模板/案例/示例课程）
// 展示 education-templates/（场景模板）、data/education-cases.json（教学案例库）、
// 示例课程入库状态（seed-edu-courses.ts），供教育从业者复用。
import { useEffect, useState } from "react";
import { BookOpen, Loader2, FileText, Database, CheckCircle2 } from "lucide-react";

interface TemplateMeta { file: string; name?: string; description?: string; route?: { method?: string; path?: string }; id?: number; scope?: string }
interface CaseItem { id?: string; title?: string; scenario?: string; subject?: string; highlights?: string[] }

export function EducationAssetsPanel({ role = "teacher" }: { role?: "student" | "teacher" }) {
  const [tab, setTab] = useState<"templates" | "cases" | "courses" | "external">("templates");
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [courses, setCourses] = useState<{ seeded: boolean; count: number; seedCommand: string; courses?: Array<{ title: string; subject: string; content: string }> } | null>(null);
  const [selected, setSelected] = useState<{ name: string; data: unknown } | null>(null);
  const [loading, setLoading] = useState(true);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importName, setImportName] = useState("");
  const [importData, setImportData] = useState("");
  // 外部资源源
  const [sources, setSources] = useState<Array<{ id: string; name: string; type: string; url: string; kind: string; enabled: boolean }>>([]);
  const [newSrcName, setNewSrcName] = useState("");
  const [newSrcUrl, setNewSrcUrl] = useState("");
  const [newSrcKind, setNewSrcKind] = useState("courses");
  const [fetchResult, setFetchResult] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const t = await fetch(`/api/education/asset-store?role=${role}&kind=templates`).then((r) => r.json());
        setTemplates((t.assets || []).map((a: any) => ({ file: a.name, name: a.name, description: String(a.data?.description || ""), route: a.data?.route, id: a.id, scope: a.scope })));
      } catch { /* 忽略 */ }
      try {
        const c = await fetch(`/api/education/asset-store?role=${role}&kind=cases`).then((r) => r.json());
        setCases((c.assets || []).map((a: any) => ({ ...a.data, id: a.id })));
      } catch { /* 忽略 */ }
      try {
        const co = await fetch("/api/education/assets?kind=courses").then((r) => r.json());
        setCourses(co.courses ? co : { seeded: false, count: 0, seedCommand: "npx tsx scripts/seed-edu-courses.ts", courses: [] });
      } catch {
        setCourses({ seeded: false, count: 0, seedCommand: "npx tsx scripts/seed-edu-courses.ts", courses: [] });
      }
      try {
        const src = await fetch("/api/education/sources").then((r) => r.json());
        setSources(src.sources || []);
      } catch { /* 忽略 */ }
      setLoading(false);
    })();
  }, []);

  /** 示例课程一键入库 */
  const seedCourses = async () => {
    setImporting(true);
    setImportMsg(null);
    try {
      const r = await fetch("/api/education/assets/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "seed-courses" }),
      }).then((res) => res.json());
      setImportMsg(r.ok ? `✅ ${r.note}` : `❌ ${r.error || "失败"}`);
      // 刷新课程状态
      const co = await fetch("/api/education/assets?kind=courses").then((res) => res.json());
      setCourses(co);
    } catch (e: any) {
      setImportMsg(`❌ ${String(e?.message || e).slice(0, 80)}`);
    } finally {
      setImporting(false);
    }
  };

  /** 模板/案例导入（JSON 写入） */
  const importAsset = async (kind: "templates" | "cases" | "courses") => {
    if (!importName.trim() || !importData.trim()) { setImportMsg("请填写文件名与 JSON 内容"); return; }
    setImporting(true);
    setImportMsg(null);
    try {
      let data: unknown;
      try { data = JSON.parse(importData); } catch { setImportMsg("❌ JSON 解析失败"); setImporting(false); return; }
      const fileName = kind === "templates" ? `${importName.trim().replace(/[^a-z0-9-]/gi, "")}.json` : importName.trim().endsWith(".json") ? importName.trim() : `${importName.trim()}.json`;
      const r = await fetch("/api/education/asset-store/add", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, kind, name: fileName.replace(".json", ""), data }),
      }).then((res) => res.json());
      setImportMsg(r.ok ? `✅ 已保存「${r.asset?.name}」（${role === "student" ? "学生空间" : "教师空间"}）` : `❌ ${r.error || "失败"}`);
      // 刷新列表
      if (kind === "templates") {
        const t = await fetch(`/api/education/asset-store?role=${role}&kind=templates`).then((res) => res.json());
        setTemplates((t.assets || []).map((a: any) => ({ file: a.name, name: a.name, description: String(a.data?.description || ""), route: a.data?.route, id: a.id, scope: a.scope })));
      } else if (kind === "cases") {
        const c = await fetch(`/api/education/asset-store?role=${role}&kind=cases`).then((res) => res.json());
        setCases((c.assets || []).map((a: any) => ({ ...a.data, id: a.id })));
      } else {
        const co = await fetch("/api/education/assets?kind=courses").then((res) => res.json());
        setCourses(co);
      }
    } catch (e: any) {
      setImportMsg(`❌ ${String(e?.message || e).slice(0, 80)}`);
    } finally {
      setImporting(false);
    }
  };

  /** 新增资源源 */
  const addSource = async () => {
    if (!newSrcName.trim() || !newSrcUrl.trim()) { setFetchResult("请填写来源名称与地址"); return; }
    const id = newSrcName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const r = await fetch("/api/education/sources/upsert", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: newSrcName.trim(), type: "url", url: newSrcUrl.trim(), kind: newSrcKind, enabled: true }),
    }).then((res) => res.json());
    if (r.ok) {
      setFetchResult(`✅ 已添加来源「${newSrcName}」`);
      setNewSrcName(""); setNewSrcUrl("");
      const src = await fetch("/api/education/sources").then((res) => res.json());
      setSources(src.sources || []);
    } else setFetchResult(`❌ ${r.error || "失败"}`);
  };

  /** 拉取并导入外部资源 */
  const importExternal = async (sourceId: string) => {
    setFetchResult("拉取中…");
    const r = await fetch("/api/education/sources/import", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId }),
    }).then((res) => res.json());
    setFetchResult(r.ok ? `✅ ${r.note || "导入完成"}` : `❌ ${r.error || "失败"}`);
    if (r.ok && r.imported > 0) {
      const co = await fetch("/api/education/assets?kind=courses").then((res) => res.json());
      setCourses(co);
    }
  };

  const loadTemplate = async (t: TemplateMeta) => {
    // 从当前列表取该模板的完整数据（data 已在列表里）
    setSelected({ name: t.name || t.file, data: t.route ? { name: t.name, description: t.description, route: t.route } : t });
  };

  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
        <BookOpen className="h-3.5 w-3.5 text-emerald-600" /> 教育复用资产
      </div>
      {/* Tab 切换 */}
      <div className="mb-2 flex gap-1">
        {([["templates", "场景模板"], ["cases", "教学案例库"], ["courses", "示例课程"], ["external", "外部资源"]] as const)
          .map(([k, label]) => (
          <button key={k} onClick={() => { setTab(k); setSelected(null); }}
            className={`rounded-lg px-3 py-1.5 text-[12px] transition-colors ${tab === k ? "bg-emerald-600 text-white" : "bg-muted text-foreground/70 hover:bg-muted/70"}`}>
            {label}
          </button>
        ))}
      </div>

      {loading ? <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中…</div> : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {/* 列表区 */}
          <div className="space-y-1.5">
            {tab === "templates" && templates.map((t) => (
              <div key={t.file} className="flex items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 py-2">
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium">{t.name || t.file}</div>
                  <div className="truncate text-[10px] text-muted-foreground">{t.description}</div>
                  {t.route?.path && <div className="text-[9px] font-mono text-emerald-700">{t.route.method} {t.route.path}</div>}
                </div>
                <button onClick={() => void loadTemplate(t)} className="shrink-0 rounded bg-muted px-2 py-1 text-[10px] hover:bg-muted/70">查看</button>
              </div>
            ))}
            {tab === "cases" && cases.map((c) => (
              <div key={c.id}
                onClick={() => setSelected({ name: c.title || c.id || "", data: c })}
                className={`cursor-pointer rounded-lg border px-2.5 py-2 transition-colors ${selected?.name === (c.title || c.id) ? "border-emerald-400 bg-emerald-500/15" : "border-border/70 bg-background hover:bg-muted/40"}`}>
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium">{c.title}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{c.scenario}</span>
                  <span className="text-[9px] text-muted-foreground">{c.subject}</span>
                </div>
                {(c.highlights || []).length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {c.highlights!.map((h, i) => <span key={i} className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] text-emerald-700">{h}</span>)}
                  </div>
                )}
              </div>
            ))}
            {tab === "courses" && courses && (
              <>
                <div className="rounded-lg border border-border/70 bg-background px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <Database className="h-3.5 w-3.5 text-emerald-600" />
                    <span className="text-[12px] font-medium">示例课程（政治经济学 / 数学）</span>
                    {courses.seeded ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : null}
                  </div>
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    {courses.seeded ? `已入库 ${courses.count} 条知识切片` : "尚未入库"}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <div className="flex-1 rounded bg-muted/50 px-2 py-1 font-mono text-[9px] text-foreground/70">{courses.seedCommand}</div>
                    <button onClick={() => void seedCourses()} disabled={importing}
                      className="shrink-0 rounded bg-emerald-600 px-2.5 py-1 text-[10px] text-white hover:bg-emerald-700 disabled:opacity-50">
                      {importing ? <Loader2 className="inline h-3 w-3 animate-spin" /> : "一键入库"}
                    </button>
                  </div>
                </div>
                {(courses.courses || []).map((c, i) => (
                  <div key={i}
                    onClick={() => setSelected({ name: c.title, data: { title: c.title, subject: c.subject, content: c.content } })}
                    className={`cursor-pointer rounded-lg border px-2.5 py-2 transition-colors ${selected?.name === c.title ? "border-emerald-400 bg-emerald-500/15" : "border-border/70 bg-background hover:bg-muted/40"}`}>
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium">{c.title}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{c.subject}</span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-[10px] leading-4 text-muted-foreground">{c.content}</div>
                  </div>
                ))}
              </>
            )}
            {tab === "external" && (
              <div className="space-y-1.5">
                <div className="rounded-lg border border-border/70 bg-background px-2.5 py-2">
                  <div className="text-[11px] font-medium text-foreground/80">接入外部教育资源共享（学校资源库 / 公开平台 / HTTP JSON 接口）</div>
                  <div className="mt-1 text-[10px] text-muted-foreground">配置来源地址后一键拉取并导入资产库（课程切片直接入库可检索）</div>
                </div>
                {sources.map((s2) => (
                  <div key={s2.id} className="flex items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12px] font-medium">{s2.name}</span>
                        <span className={`rounded px-1.5 py-0.5 text-[9px] ${s2.enabled ? "bg-emerald-50 text-emerald-700" : "bg-muted text-muted-foreground"}`}>{s2.enabled ? "已启用" : "未配置"}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{s2.kind}</span>
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground">{s2.url || "（未配置地址）"}</div>
                    </div>
                    <button onClick={() => void importExternal(s2.id)} disabled={!s2.enabled}
                      className="shrink-0 rounded bg-emerald-600 px-2.5 py-1 text-[10px] text-white hover:bg-emerald-700 disabled:opacity-50">拉取导入</button>
                  </div>
                ))}
                <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-2">
                  <div className="mb-1 text-[10px] font-medium text-muted-foreground">新增来源（如学校资源库 API / 公开平台 JSON）</div>
                  <div className="flex flex-wrap gap-1">
                    <input value={newSrcName} onChange={(e) => setNewSrcName(e.target.value)} className="w-28 rounded-lg border bg-background px-2 py-1 text-[11px]" placeholder="来源名称" />
                    <input value={newSrcUrl} onChange={(e) => setNewSrcUrl(e.target.value)} className="min-w-0 flex-1 rounded-lg border bg-background px-2 py-1 text-[11px]" placeholder="资源地址（https://…/assets.json）" />
                    <select value={newSrcKind} onChange={(e) => setNewSrcKind(e.target.value)} className="rounded-lg border bg-background px-2 py-1 text-[11px]">
                      <option value="courses">课程</option><option value="cases">案例</option><option value="templates">模板</option>
                    </select>
                    <button onClick={() => void addSource()} className="shrink-0 rounded bg-muted px-2.5 py-1 text-[11px] hover:bg-muted/70">添加</button>
                  </div>
                </div>
                {fetchResult && <div className="text-[10px]">{fetchResult}</div>}
              </div>
            )}
          </div>
          {/* 详情区 */}
          <div className="rounded-lg border border-border/60 bg-background p-2.5">
            {selected ? (
              <>
                <div className="mb-1.5 text-[11px] font-semibold text-foreground/80">{selected.name}</div>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[10px] leading-relaxed text-foreground/70">
                  {JSON.stringify(selected.data, null, 2)}
                </pre>
              </>
            ) : (
              <div className="py-8 text-center text-[11px] text-muted-foreground">
                {tab === "templates" ? "选择左侧模板查看输入样例与预期输出" : tab === "cases" ? "点击左侧案例查看完整详情" : "点击左侧课程切片查看内容"}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 导入区（按 Tab 导入对应类型；示例课程也可导入条目到资产空间） */}
      <div className="mt-2 rounded-lg border border-dashed border-border/60 bg-muted/20 p-2">
        <div className="mb-1 text-[10px] font-medium text-muted-foreground">
          导入 {tab === "templates" ? "场景模板" : tab === "cases" ? "教学案例" : tab === "courses" ? "示例课程" : "（外部资源用上方来源配置）"} · {role === "student" ? "存入学生端空间" : "存入教师端空间"}
        </div>
        {tab !== "external" && (
          <div className="flex gap-1">
            <input value={importName} onChange={(e) => setImportName(e.target.value)}
              className="min-w-0 w-32 rounded-lg border bg-background px-2 py-1 text-[11px]" placeholder="文件名（如 my-template）" />
            <input value={importData} onChange={(e) => setImportData(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border bg-background px-2 py-1 text-[11px] font-mono" placeholder='JSON 内容（如 {"name":"我的模板",...}）' />
            <button onClick={() => void importAsset(tab === "templates" ? "templates" : tab === "cases" ? "cases" : "courses")} disabled={importing}
              className="shrink-0 rounded bg-muted px-2.5 py-1 text-[11px] hover:bg-muted/70 disabled:opacity-50">
              {importing ? <Loader2 className="inline h-3 w-3 animate-spin" /> : "导入"}
            </button>
          </div>
        )}
        {importMsg && <div className="mt-1 text-[10px]">{importMsg}</div>}
      </div>
    </div>
  );
}
