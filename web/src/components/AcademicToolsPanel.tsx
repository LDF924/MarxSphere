// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// AcademicToolsPanel.tsx — 学术研究专属能力交互面板（S41-S45）
// 学派脉络(师承关系) / 观点对比(共识分歧聚类) / 学术争鸣(交锋时间线) / 学者谱系(师承网络) / 学科前沿(高频词)
import { useState, useEffect, type FC } from "react";
import { Loader2, Play, AlertTriangle, GitBranch, Scale, Users, GraduationCap, BarChart3, Cpu, Link2, TrendingUp } from "lucide-react";
import { cn } from "../lib/utils";
import { LiteraturePreviewPanel, extractLiteratureRefs } from "./LiteraturePreviewPanel";

const API_BASE = "/api/academic";
const PROJECT_ID = "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";

interface AcademicToolsPanelProps {
  scenarioId: string;
}

interface ToolDef {
  id: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
  fields: Array<{ key: string; label: string; placeholder: string; type?: "text" | "textarea" }>;
  render: (result: any) => React.ReactNode;
}

async function callApi(path: string, body: Record<string, unknown>) {
  const res = await fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text.slice(0, 200) }; }
}

const TOOLS: ToolDef[] = [
  {
    id: "S41",
    title: "学派脉络 · 师承关系",
    desc: "输入理论流派名，LLM 梳理起源/代表人物/阶段/分歧/影响 + 算法提取代表人物共现关系",
    icon: <GitBranch className="h-4 w-4" />,
    fields: [
      { key: "schoolName", label: "流派名", placeholder: "如：西方马克思主义 / 法兰克福学派", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.error && <div className="rounded bg-red-500/10 p-2 text-xs text-red-400">{r.error}</div>}
        {r.overview?.origin && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">起源</div>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{r.overview.origin}</p>
          </div>
        )}
        {r.overview?.representatives?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">代表人物（{r.overview.representatives.length}）</div>
            {r.overview.representatives.map((p: any, i: number) => (
              <div key={i} className="mb-1 rounded border-l-2 border-violet-300 bg-muted/20 p-1.5 text-[11px]">
                <b>{p.name}</b>{p.work && <span className="text-muted-foreground">《{p.work}》</span>}
                {p.role && <span className="ml-1 text-muted-foreground">— {p.role}</span>}
              </div>
            ))}
          </div>
        )}
        {r.overview?.stages?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">发展阶段</div>
            {r.overview.stages.map((s: any, i: number) => (
              <div key={i} className="mb-1 flex items-start gap-2 text-[11px]">
                <span className="mt-0.5 rounded bg-primary/10 px-1 py-0.5 text-[10px]">{i + 1}</span>
                <div><b>{s.name}</b>{s.period && <span className="text-muted-foreground">（{s.period}）</span>}
                  <div className="text-muted-foreground">{s.features}</div></div>
              </div>
            ))}
          </div>
        )}
        {r.genealogy?.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1 text-xs font-semibold">
              <Link2 className="h-3.5 w-3.5 text-violet-500" /> 代表人物关系（共现）
            </div>
            {r.genealogy.map((g: any, i: number) => (
              <div key={i} className="mb-1 rounded border p-1.5 text-[11px]">
                <b>{g.person}</b> <span className="text-muted-foreground">· {g.relation} · {g.evidence}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S42",
    title: "观点对比 · 共识分歧",
    desc: "输入研究问题 + 多位学者，LLM 输出对照表 + 算法按 embedding 相似度聚类共识与分歧",
    icon: <Scale className="h-4 w-4" />,
    fields: [
      { key: "topic", label: "研究问题", placeholder: "如：资本下乡对农户的影响", type: "text" },
      { key: "scholars", label: "学者（逗号分隔）", placeholder: "如：黄宗智,温铁军,贺雪峰", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.error && <div className="rounded bg-red-500/10 p-2 text-xs text-red-400">{r.error}</div>}
        {r.comparisons?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">观点对照表</div>
            <div className="space-y-1.5">
              {r.comparisons.map((c: any, i: number) => (
                <div key={i} className="rounded border p-2">
                  <div className="text-xs font-medium">{c.scholar}</div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{c.view}</p>
                  {c.stance && <span className="mt-0.5 inline-block rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-800">立场：{c.stance}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        {r.clusters?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">共识 / 分歧聚类（embedding）</div>
            {r.clusters.map((cl: any, i: number) => (
              <div key={i} className={cn("mb-1 rounded p-1.5 text-[11px]", cl.label.startsWith("共识") ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400")}>
                {cl.label} <span className="text-[10px] opacity-70">(sim {cl.similarity})</span>
              </div>
            ))}
          </div>
        )}
        {r.consensus?.length > 0 && (
          <div className="rounded border border-green-200 p-2">
            <div className="text-xs font-semibold text-green-700">共识点</div>
            {r.consensus.map((c: string, i: number) => <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {c}</p>)}
          </div>
        )}
        {r.disputes?.length > 0 && (
          <div className="rounded border border-red-200 p-2">
            <div className="text-xs font-semibold text-red-700">争议点</div>
            {r.disputes.map((c: string, i: number) => <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {c}</p>)}
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S43",
    title: "学术争鸣 · 交锋时间线",
    desc: "输入争鸣主题，LLM 还原缘起/正反方/回合 + 算法按时间排序相关文献还原交锋脉络",
    icon: <Users className="h-4 w-4" />,
    fields: [
      { key: "debateTopic", label: "争鸣主题", placeholder: "如：非粮化 / 土地流转效率之争", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.error && <div className="rounded bg-red-500/10 p-2 text-xs text-red-400">{r.error}</div>}
        {r.debate?.origin && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">问题缘起</div>
            <p className="mt-1 text-[11px] text-muted-foreground">{r.debate.origin}</p>
          </div>
        )}
        {r.debate?.rounds?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">交锋回合（{r.debate.rounds.length}）</div>
            {r.debate.rounds.map((rnd: any, i: number) => (
              <div key={i} className="mb-2 flex gap-2">
                <div className="flex flex-col items-center">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-violet-500/15 text-[10px] font-bold text-violet-700">{i + 1}</span>
                  {i < r.debate.rounds.length - 1 && <div className="w-px flex-1 bg-border" />}
                </div>
                <div className="flex-1 rounded border p-2">
                  <div className="text-[11px] font-medium">{rnd.round}{rnd.period && <span className="ml-1 text-muted-foreground">（{rnd.period}）</span>}</div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{rnd.content}</p>
                </div>
              </div>
            ))}
          </div>
        )}
        {r.timeline?.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1 text-xs font-semibold">
              <TrendingUp className="h-3.5 w-3.5 text-violet-500" /> 相关文献时间线（{r.timeline.length}）
            </div>
            {r.timeline.map((t: any, i: number) => (
              <div key={i} className="mb-1 flex items-center gap-2 text-[11px]">
                <span className="rounded bg-muted px-1 py-0.5 text-[10px]">{t.date}</span>
                <span className="truncate">{t.title}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{t.role}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S44",
    title: "学者谱系 · 师承网络",
    desc: "输入学者名，LLM 梳理思想阶段/代表作/师承/影响 + 算法提取著作与关联学者",
    icon: <GraduationCap className="h-4 w-4" />,
    fields: [
      { key: "scholarName", label: "学者名", placeholder: "如：马克思 / 温铁军", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.error && <div className="rounded bg-red-500/10 p-2 text-xs text-red-400">{r.error}</div>}
        {r.profile?.stages?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">思想发展历程</div>
            {r.profile.stages.map((s: any, i: number) => (
              <div key={i} className="mb-2 rounded border p-2">
                <div className="flex items-center gap-2 text-[11px] font-medium">
                  <span className="rounded bg-primary/10 px-1 py-0.5 text-[10px]">{i + 1}</span>
                  {s.name}{s.period && <span className="text-muted-foreground">（{s.period}）</span>}
                </div>
                {s.works && <p className="mt-1 text-[10px] text-primary/70">代表作：{s.works}</p>}
                {s.views && <p className="mt-0.5 text-[11px] text-muted-foreground">{s.views}</p>}
              </div>
            ))}
          </div>
        )}
        {r.network?.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1 text-xs font-semibold">
              <Link2 className="h-3.5 w-3.5 text-violet-500" /> 学术网络（著作/关联）
            </div>
            {r.network.map((n: any, i: number) => (
              <div key={i} className="mb-1 flex items-center gap-2 rounded border p-1.5 text-[11px]">
                <span className="font-medium">{n.from}</span>
                <span className="text-muted-foreground">→</span>
                <span>{n.to}</span>
                <span className="ml-auto rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{n.type}</span>
              </div>
            ))}
          </div>
        )}
        {r.profile?.mentors?.length > 0 && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">师承</div>
            <p className="mt-1 text-[11px] text-muted-foreground">{r.profile.mentors.join(" · ")}</p>
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S45",
    title: "学科前沿 · 高频关键词",
    desc: "输入学科名，LLM 汇总热点/新议题/方法转向 + 算法统计高频关键词与高关注文献",
    icon: <BarChart3 className="h-4 w-4" />,
    fields: [
      { key: "discipline", label: "学科/领域", placeholder: "如：资本下乡 / 乡村治理", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.error && <div className="rounded bg-red-500/10 p-2 text-xs text-red-400">{r.error}</div>}
        {r.keywords?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">高频关键词（TF）</div>
            <div className="flex flex-wrap gap-1.5">
              {r.keywords.map((k: any, i: number) => (
                <span key={i} className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-700">
                  {k.word} <span className="text-[10px] opacity-60">×{k.count}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        {r.report?.hotTopics?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">研究热点</div>
            {r.report.hotTopics.map((t: string, i: number) => (
              <p key={i} className="text-[11px] text-muted-foreground">• {t}</p>
            ))}
          </div>
        )}
        {r.report?.emergingIssues?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">新兴议题</div>
            {r.report.emergingIssues.map((t: string, i: number) => (
              <p key={i} className="text-[11px] text-muted-foreground">• {t}</p>
            ))}
          </div>
        )}
        {r.hotDocs?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">高关注文献</div>
            {r.hotDocs.map((d: any, i: number) => (
              <div key={i} className="mb-1 flex items-center justify-between rounded border p-1.5 text-[11px]">
                <span className="truncate">{d.title}</span>
                <span className="ml-2 shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{d.chunks} 切片</span>
              </div>
            ))}
          </div>
        )}
      </div>
    ),
  },
];

export const AcademicToolsPanel: FC<AcademicToolsPanelProps> = ({ scenarioId }) => {
  const tool = TOOLS.find((t) => t.id === scenarioId);
  if (!tool) return null;
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [model, setModel] = useState<string>("");

  useEffect(() => {
    fetch("/api/llm/models").then((r) => r.json()).then((j) => {
      const list = j.models ?? [];
      setModels(list);
      if (!model && list.length) {
        fetch("/api/llm/models").then((r) => r.json()).then((j2) => {
          const map = j2.roleMap ?? {};
          setModel(map.reason || list[0].id);
        }).catch(() => setModel(list[0].id));
      }
    }).catch(() => {});
  }, []);

  const run = async () => {
    setLoading(true);
    setResult(null);
    try {
      let body: Record<string, unknown> = { sourceId: PROJECT_ID, model: model || undefined };
      if (scenarioId === "S42") {
        body = {
          topic: values.topic,
          scholars: (values.scholars ?? "").split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          sourceId: PROJECT_ID,
          model: model || undefined,
        };
      } else {
        for (const f of tool.fields) {
          if (values[f.key]) body[f.key] = values[f.key];
        }
      }
      const path = scenarioId === "S41" ? "/school"
        : scenarioId === "S42" ? "/view-comparison"
        : scenarioId === "S43" ? "/debate"
        : scenarioId === "S44" ? "/scholar"
        : "/frontier";
      const r = await callApi(path, body);
      setResult(r);
    } catch (e: any) {
      setResult({ error: String(e?.message || e) });
    }
    setLoading(false);
  };

  return (
    <div className="rounded-lg border bg-background/50 p-4">
      <div className="mb-3 flex items-center gap-2">
        {tool.icon}
        <span className="text-sm font-semibold">{tool.title}</span>
        <span className="text-[10px] text-muted-foreground">专属算法 · 可直接调用</span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{tool.desc}</p>
      <div className="mb-3 space-y-2">
        {tool.fields.map((f) => (
          <div key={f.key}>
            <label className="mb-0.5 block text-[11px] text-muted-foreground">{f.label}</label>
            {f.type === "textarea" ? (
              <textarea
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                rows={3}
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              />
            ) : (
              <input
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              />
            )}
          </div>
        ))}
      </div>
      <div className="mb-3 flex items-center gap-2">
        <div className="flex items-center gap-1.5 rounded border border-border bg-[#161b2e] px-2 py-1">
          <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="bg-[#161b2e] text-xs text-[#e6edf7] outline-none [color-scheme:dark] [&>option]:bg-[#161b2e] [&>option]:text-[#e6edf7]"
            title="分析模型（单次覆盖，不影响全局）"
          >
            <option value="">默认（reason 角色）</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label.replace(/（.*?）/, "")}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => void run()}
          disabled={loading}
          className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {loading ? "分析中…" : "开始分析"}
        </button>
      </div>


      {result && (
        <div className="mt-3 max-h-96 overflow-y-auto">
          {result.error && !result.overview && !result.comparisons && (
            <div className="flex items-center gap-1.5 rounded bg-red-500/10 p-2 text-xs text-red-400">
              <AlertTriangle className="h-3.5 w-3.5" /> {typeof result.error === "string" ? result.error : JSON.stringify(result.error).slice(0, 200)}
            </div>
          )}
          {tool.render(result)}
          {/* 文献预览（检索/分析用到的文献可预览+标注） */}
          <LiteraturePreviewPanel references={extractLiteratureRefs(result)} storageKeyPrefix="lit-Academic-" />

        </div>
      )}
    </div>
  );
};
