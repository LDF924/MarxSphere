// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// AigcDetectPanel.tsx — AIGC 率检测与降重对比(2026-10-01, 自旧项目 AItoolman 移植)
//
// 由来: 本仓原先只有"**降** AIGC"(研途写作舱的三档改写), **没有检测** ——
//   用户改完不知道到底降没降下来。这个面板补上闭环。
//
// ═══ 界面上的措辞为什么保守 ═══
//   分数是**标定集上的相对刻度**, 不是"AI 生成概率"。服务侧注释写明 AUC 0.957 是在
//   40 篇真实论文 vs 18 篇模型输出的标定集上测的, 换模型/换学科会漂移。
//   所以这里: 一律说"更像/更不像", 不说"是/不是"; 主用途写清是**同一篇改前改后对比**。
//
// ═══ 第一版为什么丑 ═══
//   10 条等宽灰条 + 右侧一个孤零零的数字 —— 信息密度极低, 而且看不出"这个特征
//   对结论有多大影响"。改成: 每条显示**双向刻度**(人类端↔AI端) + 贡献分 + 悬停出
//   锚点值(人类中位 / AI 中位), 让"为什么给这个分"是**看得见的**。
import { useState } from "react";
import { ScanSearch, ArrowRight, Sparkles, Activity, FlaskConical, ShieldCheck } from "lucide-react";
import {
  PanelHeader, PanelCard, PanelButton, PanelEmpty, PanelNotice, panelInputCls, StatTile, panelAccent, PillGroup,
} from "./PanelShell";
import { AigcExternalPanel } from "./AigcExternalPanel";
import { cn } from "../lib/utils";

interface Feature {
  key: string; label: string; value: number; weight: number; contribution: number;
  aiLike?: number; higherIsAi?: boolean; applicable?: boolean;
  anchor?: { human: number; ai: number };
}
interface Result {
  aiScore: number; verdict: string; lang?: string; features?: Feature[]; note?: string;
  reliable?: boolean; topSignals?: string[];
}
interface DiffResult { delta: number; before?: Result; after?: Result; verdict?: string; note?: string }

/** 检测结论 → 建议的降重强度。这里把"分"翻译成"接下来该怎么做" */
function suggestTier(aiScore: number): "light" | "medium" | "heavy" {
  if (aiScore >= 80) return "heavy";
  if (aiScore >= 62) return "medium";
  return "light";
}
const TIER_LABEL: Record<string, string> = { light: "轻度降重", medium: "中度降重", heavy: "重度降重" };

const VERDICT: Record<string, { label: string; cls: string; bar: string }> = {
  likely_human: { label: "更像人类写作", cls: "text-emerald-300", bar: "from-emerald-500 to-teal-400" },
  mixed: { label: "混合特征", cls: "text-amber-300", bar: "from-amber-500 to-orange-400" },
  likely_ai: { label: "更像 AI 生成", cls: "text-red-300", bar: "from-red-500 to-rose-400" },
  insufficient: { label: "样本不足，不给结论", cls: "text-slate-400", bar: "from-slate-600 to-slate-500" },
};

/** 环形分数表 —— 比一个大数字好在"一眼看出落在哪一档" */
function ScoreDial({ score, verdict, accentCls }: { score: number; verdict: string; accentCls: string }) {
  const R = 46, C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const v = VERDICT[verdict] ?? VERDICT.mixed;
  return (
    <div className="relative h-[120px] w-[120px] shrink-0">
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        <circle cx="60" cy="60" r={R} fill="none" stroke="currentColor" strokeWidth="8" className="text-border/40" />
        <circle cx="60" cy="60" r={R} fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"
          className={accentCls} strokeDasharray={`${C * pct} ${C}`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn("text-2xl font-bold tabular-nums", v.cls)}>{Math.round(score)}</span>
        <span className="text-[9px] text-muted-foreground">/ 100</span>
      </div>
    </div>
  );
}

/** 一条特征: 双向刻度(人类端 ←→ AI端) + 当前值标记 + 贡献分 */
function FeatureRow({ f }: { f: Feature }) {
  const aiLike = f.applicable === false ? null : (f.aiLike ?? 0.5);
  const dim = f.applicable === false;
  return (
    <div className={cn("group rounded-lg border border-border/50 px-3 py-2 transition-colors hover:bg-accent/30", dim && "opacity-45")}>
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-medium">{f.label}</span>
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground" title="该项对总分的贡献">
          贡献 {dim ? "—" : Math.round(f.contribution)}
        </span>
      </div>
      <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-gradient-to-r from-emerald-500/25 via-amber-500/20 to-red-500/25">
        {aiLike !== null && (
          <div className="absolute top-0 h-full w-[3px] rounded-full bg-foreground shadow-sm"
            style={{ left: `calc(${aiLike * 100}% - 1.5px)` }} />
        )}
      </div>
      <div className="mt-1 flex items-center justify-between text-[9px] text-muted-foreground">
        <span>人类端</span>
        {f.anchor && !dim && (
          <span className="tabular-nums opacity-0 transition-opacity group-hover:opacity-100">
            锚点：人类中位 {f.anchor.human} / AI 中位 {f.anchor.ai} · 实测值 {f.value}
          </span>
        )}
        <span>AI 端</span>
      </div>
    </div>
  );
}

export function AigcDetectPanel({
  onSendToFinalize,
  onSendToWorkflow,
}: {
  /**
   * 把检测结论投给**统稿定稿的合并轮** —— 这是主出口。
   *
   * 2026-10-01 改方向: 原来唯一的出口是"送研途写作舱"(投到素材库当素材)。
   * 但"测出 AI 特征高"之后的下一步不是攒素材, 而是**降 AIGC 合稿** ——
   * 统稿定稿页的合并轮里有「降AIGC合稿」模式与轻/中/重三档强度, 那才是真正的落点。
   * 投到素材库, 用户到了那边找不到"降重"这个动作, 等于被放到了错的房间。
   */
  onSendToFinalize?: (report: {
    aiScore: number; verdict: string; tier: "light" | "medium" | "heavy"; features: string[];
  }) => void;
  /** 备用出口: 把段落本身当素材投给写作舱（用于"我想直接改这一段"） */
  onSendToWorkflow?: (text: string, title: string) => void;
} = {}) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [after, setAfter] = useState("");
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  /**
   * 自研 vs 外接 —— 两个引擎的结论**不该被平均成一个数**。
   *
   * 自研那套是固定阈值模型, 回答"在**我们的**刻度上有多像 AI"; 期刊/学校要的是
   * 指定平台那一家的判定。两者口径不同, 会给出不一样的分数 ——
   * 不一致本身就是有用的信息(说明这篇稿子处在两家判据的分界带上), 抹平它就看不到了。
   * 所以做成**并排两个选项卡**, 各自完整显示自己的结论。
   */
  const [engine, setEngine] = useState<"local" | "external">("local");

  const post = async (url: string, body: unknown) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message || d?.error || "请求失败");
    return d;
  };

  const run = async () => {
    if (!text.trim()) { setErr("请先粘贴要检测的文本"); return; }
    setBusy("detect"); setErr(""); setDiff(null);
    try { setResult(await post("/api/aigc/detect", { text, lang: "auto" }) as Result); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };

  const runDiff = async () => {
    if (!text.trim() || !after.trim()) { setErr("对比需要两段文本：改前与改后"); return; }
    setBusy("diff"); setErr("");
    try { setDiff(await post("/api/aigc/diff", { before: text, after, lang: "auto" }) as DiffResult); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };

  const v = result ? (VERDICT[result.verdict] ?? VERDICT.mixed) : null;
  const featureCount = result?.features?.length ?? 0;

  return (
    <div className="space-y-3">
      <PanelHeader
        icon={<ScanSearch />} accent="rose" title="AIGC 率检测"
        subtitle="识别文本的 AI 生成特征。分数是标定集上的相对刻度，主用途是同一篇稿子改前改后的对比"
        actions={
          <>
            <PillGroup accent="rose" value={engine} onChange={setEngine}
              options={[
                { value: "local" as const, label: "本机检测", hint: "离线标定模型，随时可跑、不花钱" },
                { value: "external" as const, label: "权威平台", hint: "GPTZero / 知网 / 维普 / 朱雀等，投稿前要过的那一家" },
              ]} />
            {result && engine === "local" && <StatTile accent="rose" value={featureCount} label="特征维度" />}
          </>
        }
      />

      {engine === "external" ? (
        <>
          {/* 两个引擎结论不一致是常事, 这里的交代是为了让用户别把两个数当同一把尺子 */}
          <PanelNotice type="info">
            外接平台与上面的「本机检测」是<b>两把不同的尺子</b>：本机那套是固定阈值模型（离线、随时可跑），
            外接的是各家平台自己的判据。<b>同一个稿子在两处拿到的分数不同是正常的</b> ——
            投稿/答辩认的是平台报告，所以以你选的那一家为准。
          </PanelNotice>
          <AigcExternalPanel text={text} title="AIGC 送检" accent="violet" />
        </>
      ) : (
      <>
      <div className="grid gap-3 lg:grid-cols-2">
        <PanelCard title="改前 / 待检测">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8}
            placeholder="粘贴论文段落…" className={panelInputCls} />
          <div className="mt-2 flex items-center gap-2">
            <PanelButton accent="rose" busy={busy === "detect"} onClick={() => void run()}>
              <ScanSearch className="h-3.5 w-3.5" />开始检测
            </PanelButton>
          </div>
        </PanelCard>

        <PanelCard title="改后（用于对比，可留空）">
          <textarea value={after} onChange={(e) => setAfter(e.target.value)} rows={8}
            placeholder="降重 / 改写之后的同一段…" className={panelInputCls} />
          <div className="mt-2 flex items-center gap-2">
            <PanelButton accent="rose" variant="outline" busy={busy === "diff"} onClick={() => void runDiff()}>
              <ArrowRight className="h-3.5 w-3.5" />对比改前改后
            </PanelButton>
          </div>
        </PanelCard>
      </div>

      {err && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{err}</div>}

      {result && (
        <PanelCard icon={<Activity />} title="检测结果"
          actions={<span className={cn("text-[11px] font-medium", v?.cls)}>{v?.label}</span>}>
          <div className="flex flex-wrap items-center gap-4">
            <ScoreDial score={result.aiScore} verdict={result.verdict}
              accentCls={cn("text-transparent")} />
            <div className="min-w-[200px] flex-1">
              <div className="flex h-2 overflow-hidden rounded-full">
                <div className="flex-1 bg-emerald-500/40" /><div className="flex-1 bg-amber-500/40" /><div className="flex-1 bg-red-500/40" />
              </div>
              <div className="mt-1 flex justify-between text-[9px] text-muted-foreground">
                <span>0 · 更像人类</span><span>50 · 混合</span><span>100 · 更像 AI</span>
              </div>
              {/* 标定集锚点写出来 —— 否则用户不知道 63 是好是坏 */}
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                标定集参考：人类写作中位 <b className="text-foreground">38</b>，模型输出中位 <b className="text-foreground">63</b>。
                换学科或换模型会有漂移，<b>不要跨语料比大小</b>。
              </p>
              {result.note && (
                <p className="mt-1 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[10px] text-amber-300/90">{result.note}</p>
              )}
            </div>
          </div>

          {result.features?.length ? (
            <div className="mt-3 grid gap-1.5 md:grid-cols-2">
              {result.features.map((f) => <FeatureRow key={f.key} f={f} />)}
            </div>
          ) : null}

          {/*
            "检测出问题"之后必须有 "怎么改" 的出口。
            第一版到分数就停了 —— 用户看完 86 分, 下一步只能自己复制文本、切到写作舱、
            再粘一次。这层联动是本项目原本缺的。

            2026-10-01 修正落点: 主出口从"送写作舱素材库"改成"送统稿定稿合稿" ——
            那里才有真正的降重动作(降AIGC合稿 + 三档强度), 素材库没有。
          */}
          {(onSendToFinalize || onSendToWorkflow) && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
              {onSendToFinalize && (
                <PanelButton accent="rose" size="sm"
                  onClick={() => onSendToFinalize({
                    aiScore: result.aiScore,
                    verdict: result.verdict,
                    tier: suggestTier(result.aiScore),
                    features: (result.topSignals ?? []).map((s) => String(s)),
                  })}>
                  <ArrowRight className="h-3 w-3" />送统稿定稿（降 AIGC 合稿）
                </PanelButton>
              )}
              {/*
                不把原文一起带过去 —— 这里的目标是"改整篇稿子", 而本面板检的是<b>一段</b>。
                把一段当整篇投过去, 用户到了统稿定稿会以为要合的就是这一段。
                原文另有出口(下面那个按钮, 它明确说"把这一段作为素材")。
              */}
              {onSendToFinalize && (
                <span className="text-[10px] text-muted-foreground">
                  带上检测结论与建议档位（本次为<b className="text-rose-300/90">{TIER_LABEL[suggestTier(result.aiScore)]}</b>），
                  到统稿定稿的「合并正文」轮选用
                </span>
              )}
              {onSendToWorkflow && (
                <PanelButton accent="rose" size="sm" variant="outline"
                  onClick={() => onSendToWorkflow(text, `待降 AIGC 段落（检测 ${Math.round(result.aiScore)} 分）`)}>
                  只看这一段：送写作舱改写
                </PanelButton>
              )}
            </div>
          )}
        </PanelCard>
      )}

      {diff && (
        <PanelCard icon={<Sparkles />} title="改前改后对比">
          <div className="flex flex-wrap items-center gap-3">
            <StatTile accent="rose" value={Math.round(diff.before?.aiScore ?? 0)} label="改前" />
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <StatTile accent="rose" value={Math.round(diff.after?.aiScore ?? 0)} label="改后" />
            <div className={cn("text-lg font-bold tabular-nums",
              diff.delta < 0 ? "text-emerald-300" : diff.delta > 0 ? "text-red-300" : "text-slate-400")}>
              {diff.delta > 0 ? "+" : ""}{Math.round(diff.delta)}
            </div>
            <span className={cn("text-[11px]", diff.delta < 0 ? "text-emerald-300" : diff.delta > 0 ? "text-red-300" : "text-muted-foreground")}>
              {diff.delta < 0 ? "AI 特征下降" : diff.delta > 0 ? "AI 特征上升" : "基本无变化"}
            </span>
          </div>
          {diff.note && <p className="mt-2 text-[10px] text-muted-foreground">{diff.note}</p>}
        </PanelCard>
      )}

      {!result && !busy && !err && <PanelEmpty>粘贴文本后点「开始检测」；想看降重效果就把改后的也贴上再点「对比改前改后」</PanelEmpty>}
      </>
      )}
    </div>
  );
}
