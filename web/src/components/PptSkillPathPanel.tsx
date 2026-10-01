// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// PptSkillPathPanel.tsx — PPT 的第二条生成路径: 走外部技能(2026-10-01)
//
// ═══ 为什么这条路径不能长得像上面那条 ═══
//   上面那条(大纲 → 脚本 → 配图 → 导出)是**自建管线**: 点一下, 几十秒出稿, 每一页
//   都能改、能单独重生 —— 它的价值在"可控 + 快"。
//   这条路走的是**技能**: 由 Agent 按技能的完整指令逐页构建。它慢(分钟级)、要花额度,
//   换来的是技能作者迭代过很多轮的版式与叙事结构。
//
//   两条路的差别**必须写在界面上**, 否则用户点"技能生成"会以为界面卡死了。
//   (服务端 `SKILL_PATH_NOTE` 提供这段文案, 这里不另抄一份。)
//
// ═══ 为什么任务建好不自动跑 ═══
//   与定时任务同一条纪律: 自动执行会在用户没看见的时候花钱, 而这一步动辄 5–10 分钟。
//   所以这里只**建任务**, 明确告诉用户"去任务面板点启动"。
//
// ═══ 产物形态为什么要标出来 ═══
//   本机 5 个"看起来都能做 PPT"的技能里, 有 3 个根本产不出可编辑 .pptx
//   (paper-slide-deck 只出图 / beamer 出 PDF)。不标出来的话, 用户要改字时才会发现。
import { useEffect, useState } from "react";
import {
  Wand2, Loader2, AlertTriangle, Play, FileText, Image as ImageIcon, FileType2, BookOpen,
} from "lucide-react";
import {
  PanelCard, PanelButton, PanelEmpty, PanelNotice, panelInputCls, StatTile, panelAccent,
} from "./PanelShell";
import { cn } from "../lib/utils";

interface Skill {
  id: string; label: string; output: "pptx" | "images" | "pdf" | "guide";
  outputLabel: string; bestFor: string; caveat?: string; installed: boolean;
}

const OUTPUT_ICON = {
  pptx: FileType2, images: ImageIcon, pdf: FileText, guide: BookOpen,
} as const;

export function PptSkillPathPanel() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState("");
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [created, setCreated] = useState<{ taskId: string; skillId: string } | null>(null);
  const a = panelAccent("violet");

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/ppt/skills", {
          headers: { Authorization: `Bearer ${localStorage.getItem("sag_token") ?? ""}` },
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d?.error?.message || d?.error || `读取技能失败(${r.status})`);
        setSkills(d.skills ?? []);
        setNote(d.note ?? "");
        setSelected((cur) => cur || (d.skills ?? []).find((s: Skill) => s.installed)?.id || "");
      } catch (e) { setErr((e as Error).message); }
    })();
  }, []);

  const sel = skills.find((s) => s.id === selected) ?? null;
  const installed = skills.filter((s) => s.installed);

  const run = async () => {
    if (!sel || !title.trim()) { setErr("请选技能并填写标题"); return; }
    setBusy("run"); setErr(""); setCreated(null);
    try {
      const r = await fetch("/api/ppt/skill-run", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("sag_token") ?? ""}` },
        body: JSON.stringify({ skillId: sel.id, title, sourceText: source, extra }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || d?.error || "创建失败");
      setCreated({ taskId: d.taskId, skillId: d.skillId });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };

  return (
    <div className="space-y-3">
      <PanelNotice type="info">
        <div className="flex items-start gap-1.5">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <div>
            <b>这是第二条路径，与上面的管线不同。</b>
            <div className="mt-1 leading-5">{note || "技能路径由 Agent 按技能指令逐页构建，较慢且按模型调用计费。"}</div>
          </div>
        </div>
      </PanelNotice>

      {err && <PanelNotice type="err">{err}</PanelNotice>}

      {installed.length === 0 ? (
        <PanelEmpty>
          本机没有安装任何 PPT 技能 —— 技能在 ~/.claude/skills 下，是<b>本机资产</b>，不随仓库分发。
          装好之后刷新本页即可看到。（新机器 / CI 上没有是正常的。）
        </PanelEmpty>
      ) : (
        <>
          <PanelCard title="选择技能" icon={<Wand2 />}
            actions={<span className="text-[10px] text-muted-foreground">
              已装 {installed.length} / {skills.length}
            </span>}>
            <div className="grid gap-2 md:grid-cols-2">
              {skills.map((s) => {
                const Icon = OUTPUT_ICON[s.output];
                const on = selected === s.id;
                return (
                  <button key={s.id} type="button" disabled={!s.installed}
                    onClick={() => setSelected(s.id)}
                    className={cn("rounded-xl border p-3 text-left transition-colors",
                      !s.installed ? "border-border/40 opacity-45" :
                      on ? cn(a.ring, "bg-accent/40") : "border-border/50 hover:bg-accent/40")}>
                    <div className="flex items-center gap-2">
                      <span className={cn("flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br text-white",
                        s.output === "pptx" ? "from-violet-500 to-purple-600" : "from-slate-500 to-slate-600")}>
                        <Icon className="h-3 w-3" />
                      </span>
                      <span className="text-[12px] font-semibold">{s.label}</span>
                      {!s.installed && <span className="ml-auto rounded bg-slate-500/15 px-1 py-px text-[9px] text-slate-400">未安装</span>}
                    </div>
                    <div className="mt-1.5 text-[10.5px] leading-4 text-muted-foreground">{s.bestFor}</div>
                    <div className={cn("mt-1.5 text-[10px]",
                      s.output === "pptx" ? "text-emerald-300/90" : "text-amber-300/90")}>
                      产物：{s.outputLabel}
                    </div>
                    {s.caveat && (
                      <div className="mt-1 rounded border border-amber-500/25 bg-amber-500/5 px-1.5 py-1 text-[9.5px] leading-4 text-amber-300/80">
                        {s.caveat}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </PanelCard>

          <PanelCard title="这次要做什么" icon={<FileText />}>
            <div className="space-y-2">
              <div>
                <label className="mb-1 block text-[10px] text-muted-foreground">演示稿标题（必填）</label>
                <input value={title} onChange={(e) => setTitle(e.target.value)}
                  placeholder="例如「农村集体经济与共同富裕研究进展」" className={panelInputCls} />
              </div>
              <div>
                <label className="mb-1 block text-[10px] text-muted-foreground">
                  源文本（可选，但论文类技能没有它就做不了 —— 粘贴论文正文 / 摘要 / 大纲）
                </label>
                <textarea value={source} onChange={(e) => setSource(e.target.value)} rows={7}
                  placeholder="把论文原文或详细大纲粘进来…" className={panelInputCls} />
                {source.trim() && (
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    {source.replace(/\s/g, "").length} 字
                  </div>
                )}
              </div>
              <div>
                <label className="mb-1 block text-[10px] text-muted-foreground">额外要求（可选）</label>
                <input value={extra} onChange={(e) => setExtra(e.target.value)}
                  placeholder="例如「给课题组汇报，15 分钟，重点讲方法」" className={panelInputCls} />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
              <PanelButton accent="violet" busy={busy === "run"} disabled={!sel || !title.trim()} onClick={() => void run()}>
                <Wand2 className="h-3.5 w-3.5" />创建生成任务
              </PanelButton>
              <span className="text-[10px] text-muted-foreground">
                只建任务，<b>不会自动开始</b> —— 建好后去 Agent 任务面板点启动。
              </span>
            </div>
          </PanelCard>

          {created && (
            <PanelCard title="任务已创建" icon={<Play />}>
              <div className="flex flex-wrap items-center gap-3">
                <StatTile accent="violet" value={created.skillId} label="技能" />
                <div className="min-w-[240px] flex-1">
                  <div className="text-[11px] font-medium">下一步：去 Agent 任务面板启动它</div>
                  <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                    任务目标里已经写好了「加载哪个技能 + 这次的标题/源文本/要求」，启动后由 Agent 执行。
                    产物（.pptx）会由 Agent 报出路径。
                  </div>
                  <div className="mt-1.5 font-mono text-[10px] text-muted-foreground">taskId: {created.taskId}</div>
                </div>
              </div>
              <div className="mt-2.5">
                <PanelButton accent="violet" variant="outline" size="sm"
                  onClick={() => { window.location.hash = "agent"; }}>
                  去 Agent 任务面板
                </PanelButton>
              </div>
            </PanelCard>
          )}
        </>
      )}
    </div>
  );
}
