// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// SkillShelfPanel.tsx — 技能货架(2026-10-02)
//
// 由来(对照 Respal 的 Skills 广场): 本仓有 200+ 个技能, 但只有一张**平铺列表** ——
//   SkillsPanel 能按分类折叠、能搜、能看详情, 但没有任何"逛"的形态:
//   · 看不见每个技能是**哪个版本 / 谁写的 / 什么来源** —— 而这些字段 SKILL.md 里一直有,
//     只是没有任何代码读(frontmatter 的 version/tags/author/origin 全仓零解析);
//   · 看不见**热度** —— `/api/skills/usage` 从上线起就没有前端调用者;
//   · 分类与标签没有统计, 无法回答"哪类最多、哪个标签跨了几类"。
//
// ⚠ 热度只覆盖 **Agent 任务**里召回过的技能(埋点在 agent-task-service), 手动浏览/健康检查
//   都不计数。所以这里标的是"被 Agent 用过几次"而不是"被看过几次" —— 界面上如实写出来,
//   免得用户以为 0 = 没人用。
import { useEffect, useMemo, useState } from "react";
import { Loader2, LayoutGrid, Search, Boxes, Tag, Star, TrendingUp, RefreshCw } from "lucide-react";
import { cn } from "../lib/utils";

interface ShelfSkill {
  name: string;
  zhName?: string;
  description: string;
  zhDescription?: string;
  zhCategory?: string;
  version?: string;
  author?: string;
  license?: string;
  tags: string[];
  origin?: string;
  whenToUse?: string;
  cloudSource?: string;
  hasHealthcheck: boolean;
  useCount: number;
  successCount: number;
}
interface ShelfData {
  total: number;
  skills: ShelfSkill[];
  categories: Array<{ name: string; count: number }>;
  tags: Array<{ name: string; count: number }>;
  sources: Array<{ name: string; count: number }>;
}

const SORTS = [
  { value: "", label: "默认" },
  { value: "hot", label: "最常用" },
  { value: "name", label: "按名称" },
  { value: "version", label: "按版本" },
];

export function SkillShelfPanel({ onOpenDetail }: { onOpenDetail?: (name: string) => void }) {
  const [data, setData] = useState<ShelfData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState("");
  const [onlyTagged, setOnlyTagged] = useState(false);

  const load = () => {
    setLoading(true); setErr("");
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (tag) params.set("tag", tag);
    if (q.trim()) params.set("q", q.trim());
    if (sort) params.set("sort", sort);
    void fetch(`/api/skills/shelf?${params}`)
      .then((r) => r.json())
      .then((d) => { if (d?.skills) setData(d); else setErr(d?.error || "货架加载失败"); })
      .catch((e) => setErr(String(e?.message || e).slice(0, 120)))
      .finally(() => setLoading(false));
  };
  // 输入框每次按键都请求太吵 —— 只在提交/清空/换筛选时拉
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [category, tag, sort]);

  const rows = useMemo(
    () => (data?.skills ?? []).filter((s) => !onlyTagged || s.tags.length > 0),
    [data, onlyTagged]
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <LayoutGrid className="h-4 w-4 text-primary" />技能货架
        </div>
        <span className="text-xs text-muted-foreground">
          {data ? `${rows.length} / ${data.total} 个` : ""}
        </span>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") load(); }}
            placeholder="搜索技能名 / 描述 / 标签，回车"
            className="w-64 rounded-md border border-border bg-transparent py-1.5 pl-7 pr-2 text-xs"
            data-control="skills:search"
          />
        </div>
        <button type="button" onClick={load} className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent"
          data-control="skills:refresh"><RefreshCw className="h-3 w-3" /></button>
      </div>

      {err ? <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{err}</div> : null}

      {/* 侧栏式统计: 分类 / 标签 / 来源 —— 三个维度都要能点, 且统计基于**全量** */}
      {data ? (
        <div className="grid gap-2 lg:grid-cols-3">
          <div className="rounded-md border border-border p-2">
            <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <Boxes className="h-3 w-3" />分类（{data.categories.length}）
            </div>
            <div className="flex flex-wrap gap-1">
              <button type="button" onClick={() => setCategory("")}
                className={cn("rounded-full border px-2 py-0.5 text-[11px]", !category ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent")}>
                全部 {data.skills.length}
              </button>
              {data.categories.map((c) => (
                <button key={c.name} type="button" onClick={() => setCategory(category === c.name ? "" : c.name)}
                  className={cn("rounded-full border px-2 py-0.5 text-[11px]", category === c.name ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent")}>
                  {c.name} <span className="opacity-60">{c.count}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col rounded-md border border-border p-2">
            <div className="mb-1.5 flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <Tag className="h-3 w-3" />标签（{data.tags.length}）{tag ? <button className="ml-1 text-primary hover:underline" onClick={() => setTag("")}>清除</button> : null}
            </div>
          {/**
            * ⚠ 这里改过两轮, 两次都是"滚动轨高度不对", 但原因是两件事:
            *
            *  第一轮 `max-h-24`: 最大高度**小于内容高**时才生效, 而 overflow 会把
            *    滚动轨一起裁掉 —— 出来是"只画了半截的滑轨"。
            *  第二轮 `h-28`(固定 112px): 轨完整了, 但**卡片的高度不归它管** ——
            *    三张卡在同一行 grid 里, 行高由最高的那张(分类)决定(实测 207px),
            *    于是标签框底下空出 62px, 轨只跑了卡片的一截。用户报的正是这个。
            *
            *  正解是**让框去填卡片**: 卡片改成纵向 flex, 框 `flex-1` 吃掉标题之外的
            *  全部高度, `min-h-28` 兜住"卡片本身很矮"的场合(否则会被压成一条)。
            *  这样轨的上下端永远贴着卡片的可用高度。
            */}
            <div className="flex min-h-28 flex-1 flex-wrap content-start gap-1 overflow-y-auto pr-1">
              {data.tags.length === 0 ? <span className="text-[11px] text-muted-foreground/60">核心 SKILL.md 里还没有 tags 字段</span> : null}
              {data.tags.map((t) => (
                <button key={t.name} type="button" onClick={() => setTag(tag === t.name ? "" : t.name)}
                  className={cn("rounded-full border px-2 py-0.5 text-[11px]", tag === t.name ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent")}>
                  {t.name} <span className="opacity-60">{t.count}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-md border border-border p-2">
            <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <Star className="h-3 w-3" />来源
            </div>
            <div className="flex flex-wrap gap-1">
              {data.sources.map((s) => (
                <span key={s.name} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                  {s.name} <span className="opacity-60">{s.count}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {SORTS.map((s) => (
          <button key={s.value} type="button" onClick={() => setSort(s.value)}
            className={cn("rounded-md border px-2 py-1", sort === s.value ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent")}>
            {s.label}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-muted-foreground">
          <input type="checkbox" checked={onlyTagged} onChange={(e) => setOnlyTagged(e.target.checked)} />
          只看带标签的
        </label>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载货架…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
          没有匹配的技能。试试清除筛选条件。
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => onOpenDetail?.(s.name)}
              className="flex flex-col gap-1 rounded-lg border border-border p-2.5 text-left transition-colors hover:border-primary/40 hover:bg-accent/30"
              data-control={`skills:card`}
            >
              <div className="flex items-start gap-1.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.zhName || s.name}</span>
                {s.version ? <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">v{s.version}</span> : null}
              </div>
              {s.zhName ? <div className="truncate font-mono text-[10px] text-muted-foreground/70">{s.name}</div> : null}
              <div className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                {s.zhDescription || s.description || "（无描述）"}
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
                {s.zhCategory ? <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{s.zhCategory}</span> : null}
                {s.tags.slice(0, 3).map((t) => (
                  <span key={t} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">#{t}</span>
                ))}
                {s.cloudSource ? <span className="rounded bg-emerald-400/10 px-1.5 py-0.5 text-[10px] text-emerald-300">广场</span> : null}
                {s.hasHealthcheck ? <span className="rounded bg-sky-400/10 px-1.5 py-0.5 text-[10px] text-sky-300">可自检</span> : null}
                {s.useCount > 0 ? (
                  <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground" title={`被 Agent 任务召回 ${s.useCount} 次，成功 ${s.successCount} 次`}>
                    <TrendingUp className="h-2.5 w-2.5" />{s.useCount}
                  </span>
                ) : null}
                {s.author ? <span className="ml-auto truncate text-[10px] text-muted-foreground/60">{s.author}</span> : null}
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="text-[10px] text-muted-foreground/60">
        热度数字来自 Agent 任务的技能召回埋点（agent-task-service）；手动浏览与健康检查不计数，所以 0 不等于没人用。
      </div>
    </div>
  );
}

export default SkillShelfPanel;
