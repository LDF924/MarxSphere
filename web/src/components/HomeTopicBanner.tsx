// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// HomeTopicBanner.tsx — 首页「当前课题」: 可输入 / 可固定 / 自动出关键词候选(2026-10-03)
//
// 由来(用户): 改前这一块是**两处硬编码** —— 横幅上写死一条基金项目名, Hero 下面那行
//   关键词(农业农村现代化 · 资本下乡 · 工商资本 · 资本治理)也是源码字面量。
//   用户要的是: 课题自己输入、点了「固定」就存下来; 输入时**自动识别该课题并列出关键词
//   候选**, 勾选后就呈现在首页上。
//
// ═══ 三个设计取舍 ═══
//  ① **关键词不是自动塞进去的**: 候选由后端两路生成(本仓语料分词 + LLM 学科扩写),
//     但必须用户勾选才生效。自动填一堆用户没认过的词, 比让他勾一遍更糟 ——
//     首页要呈现的是"他的研究主线", 不是模型的猜测。
//  ② **候选标明出处**: `corpus`(本仓文献与期刊标签里真出现过)与 `llm`(模型按学科语境推断)
//     分开显示。用户据此知道哪些词有证据、哪些是建议 —— 这跟他判断该不该勾直接相关。
//  ③ **字号随课题长度收缩**: 课题全称常有 20-40 字(带项目级别前缀), 固定字号必然溢出或
//     缩成一行小字。按字数分档给字号与色阶, 长的自动降级, 短的反之 —— 用户说的
//     「字体、字号、字色能自动弄好」就是这个意思。
import { useEffect, useMemo, useState } from "react";
import { Sparkles, BookOpenCheck, ChevronRight, Pencil, Pin, Loader2, X, Check, Tag } from "lucide-react";
import { cn } from "../lib/utils";
import { api } from "../lib/api";

export interface HomeTopic {
  title: string;
  keywords: string[];
}

interface Candidate {
  text: string;
  origin: "corpus" | "llm";
  from?: string;
}

interface SuggestResult {
  topic: string;
  candidates: Candidate[];
  sources: Array<{ id: string; ok: boolean; count: number; note?: string }>;
}

/**
 * 课题全称的字号/字色分档。
 *
 * 分档而不是 `clamp()`: 首页这块是**一行不换行**的展示(换行会把横幅撑高、挤掉下面的
 * 入口按钮), 所以必须在"放得下"的前提下选字号。按字数分四档, 长题降字号并逐级减弱字色,
 * 让 40 字的项目全称仍然读得完, 而 6 个字的短题不会显得小气。
 */
function titleType(title: string): { size: string; color: string; leading: string } {
  const n = Array.from(title).length;
  if (n <= 12) return { size: "text-lg md:text-2xl", color: "text-accent-foreground", leading: "leading-snug" };
  if (n <= 24) return { size: "text-base md:text-xl", color: "text-accent-foreground", leading: "leading-snug" };
  if (n <= 40) return { size: "text-sm md:text-lg", color: "text-foreground/90", leading: "leading-snug" };
  return { size: "text-xs md:text-base", color: "text-foreground/80", leading: "leading-snug" };
}

export function HomeTopicBanner({ topic, onSaved, onOpenReason }: {
  topic: HomeTopic;
  onSaved: (t: HomeTopic) => void;
  /** 点课题标题 = 围绕它去推理(带题面过去), 与"保存"是两件事 */
  onOpenReason: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(topic.title);
  const [picked, setPicked] = useState<string[]>(topic.keywords);
  const [manual, setManual] = useState("");
  const [sug, setSug] = useState<SuggestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // 外部(重新加载/切换用户)把 topic 换掉时要跟上 —— 否则编辑框里还留着上一条课题
  useEffect(() => { setDraft(topic.title); setPicked(topic.keywords); }, [topic.title, topic.keywords.join("|")]);

  const open = () => {
    setEditing(true); setErr("");
    // 打开时就带出当前关键词, 让用户看到"现在已经选了什么"再增删
    setPicked(topic.keywords);
  };
  const close = () => { setEditing(false); setSug(null); setErr(""); setManual(""); };

  /** 识别: 后端跑「本仓语料分词 + LLM 学科扩写」两路 */
  const recognize = async () => {
    const t = draft.trim();
    if (t.length < 2) { setErr("课题名至少 2 个字"); return; }
    setBusy(true); setErr("");
    try {
      const d = await api.suggestHomeTopicKeywords(t);
      setSug(d as SuggestResult);
      // 识别出的候选**默认全不勾** —— 当前已有选择保留原样, 用户自己点要哪些
    } catch (e) {
      setErr(String((e as Error)?.message ?? e).slice(0, 160));
    } finally { setBusy(false); }
  };

  const toggle = (w: string) =>
    setPicked((s) => (s.includes(w) ? s.filter((x) => x !== w) : [...s, w]));

  const addManual = () => {
    const w = manual.trim();
    if (!w) return;
    if (!picked.includes(w)) setPicked((s) => [...s, w]);
    setManual("");
  };

  /** 固定 = 落库(一人一条 upsert), 首页据此呈现 */
  const pin = async () => {
    const t = draft.trim();
    if (t.length < 2) { setErr("课题名至少 2 个字"); return; }
    setSaving(true); setErr("");
    try {
      const d = await api.setHomeTopic({ title: t, keywords: picked });
      onSaved({ title: String(d.title ?? t), keywords: Array.isArray(d.keywords) ? d.keywords : picked });
      close();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e).slice(0, 160));
    } finally { setSaving(false); }
  };

  const corpus = useMemo(() => (sug?.candidates ?? []).filter((c) => c.origin === "corpus"), [sug]);
  const llm = useMemo(() => (sug?.candidates ?? []).filter((c) => c.origin === "llm"), [sug]);
  const ty = titleType(topic.title || "（尚未设置课题）");

  return (
    <div className="mt-6 w-full rounded-lg border border-primary/25 bg-gradient-to-r from-primary/10 via-background/40 to-primary/10 p-5 text-center transition-colors hover:border-primary/50">
      <div className="flex items-center justify-center gap-2 text-xs font-medium uppercase tracking-widest text-primary/70">
        <Sparkles className="h-3.5 w-3.5" />
        当前课题
        <Sparkles className="h-3.5 w-3.5" />
        <button
          type="button" onClick={editing ? close : open}
          className="ml-2 inline-flex items-center gap-1 rounded-full border border-primary/30 px-2 py-0.5 text-[10px] normal-case tracking-normal text-primary/80 hover:bg-primary/10"
          data-control="home:topic-edit"
        >
          {editing ? <X className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
          {editing ? "取消" : "编辑"}
        </button>
      </div>

      {!editing ? (
        <>
          <button
            type="button"
            onClick={() => onOpenReason(topic.title)}
            className={cn("mt-2 flex w-full items-center justify-center gap-2 font-semibold transition-colors hover:text-primary", ty.size, ty.color, ty.leading)}
            title="点击进入推理，围绕本课题提问"
            data-control="home:topic-title"
          >
            <BookOpenCheck className="h-4 w-4 shrink-0 text-primary" />
            <span className="text-left">{topic.title || "尚未设置课题 —— 点右上角「编辑」填入"}</span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
          {topic.keywords.length ? (
            <div className="mt-2.5 flex flex-wrap items-center justify-center gap-1.5" data-control="home:topic-keywords">
              {topic.keywords.map((k) => (
                <span key={k} className="rounded-full border border-primary/25 bg-primary/5 px-2.5 py-0.5 text-[11px] text-accent-foreground/90">
                  {k}
                </span>
              ))}
            </div>
          ) : null}
          <p className="mt-1.5 text-xs text-muted-foreground/80">点击进入推理，围绕本课题开展研究</p>
        </>
      ) : (
        <div className="mt-3 space-y-3 text-left">
          {/* 课题全称 */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">课题全称</label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void recognize(); }}
                placeholder="例：农业农村现代化进程中工商资本规范与引导路径研究"
                className="min-w-[16rem] flex-1 rounded-md border border-border bg-background/70 px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none"
                data-control="home:topic-input"
              />
              <button
                type="button" onClick={() => void recognize()} disabled={busy}
                className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
                data-control="home:topic-recognize"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                {busy ? "识别中…" : "识别关键词"}
              </button>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              回车也可以识别。识别会读你已经入库的文献与期刊标签，并让模型按学科语境补一批候选。
            </p>
          </div>

          {err ? <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">{err}</div> : null}

          {/* 已选 */}
          <div>
            <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <Check className="h-3 w-3" />已选关键词（{picked.length}）—— 这几个会显示在首页
            </div>
            <div className="flex flex-wrap gap-1.5" data-control="home:topic-picked">
              {picked.length === 0 ? <span className="text-[11px] text-muted-foreground/60">还没有选。下面识别一批，或直接手输。</span> : null}
              {picked.map((k) => (
                <button
                  key={k} type="button" onClick={() => toggle(k)}
                  className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-[11px] text-primary hover:bg-primary/20"
                  title="点击取消"
                >
                  {k}<X className="h-2.5 w-2.5" />
                </button>
              ))}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addManual(); } }}
                placeholder="手动加一个关键词，回车加入"
                className="w-56 rounded-md border border-border bg-background/70 px-2 py-1 text-[11px] focus:border-primary/50 focus:outline-none"
                data-control="home:topic-manual"
              />
            </div>
          </div>

          {/* 候选: 按出处分两组 —— 用户要能分辨"哪来的" */}
          {sug ? (
            <div className="space-y-2 rounded-md border border-border/60 bg-background/40 p-2">
              {corpus.length ? (
                <div>
                  <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-emerald-300/90">
                    <Tag className="h-3 w-3" />本仓语料里出现过的（{corpus.length}）—— 点一下加入
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {corpus.map((c) => (
                      <button
                        key={c.text} type="button" onClick={() => toggle(c.text)}
                        className={cn("rounded border px-2 py-0.5 text-[11px]",
                          picked.includes(c.text) ? "border-primary/50 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:bg-accent")}
                        title={c.from}
                      >{c.text}</button>
                    ))}
                  </div>
                </div>
              ) : null}
              {llm.length ? (
                <div>
                  <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-sky-300/90">
                    <Sparkles className="h-3 w-3" />模型按学科语境推断的（{llm.length}）—— 仅供参考
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {llm.map((c) => (
                      <button
                        key={c.text} type="button" onClick={() => toggle(c.text)}
                        className={cn("rounded border px-2 py-0.5 text-[11px]",
                          picked.includes(c.text) ? "border-primary/50 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:bg-accent")}
                      >{c.text}</button>
                    ))}
                  </div>
                </div>
              ) : null}
              {!corpus.length && !llm.length ? (
                <div className="px-1 py-1 text-[11px] text-muted-foreground">
                  这一轮没给出候选。{(sug.sources ?? []).filter((s) => !s.ok).map((s) => `${s.id} 失败：${s.note ?? ""}`).join("；")}
                </div>
              ) : null}
              {/* 哪一路没跑起来要如实说 —— 否则"候选就这些"会被误读成"这个课题没词可提" */}
              {(sug.sources ?? []).some((s) => !s.ok) ? (
                <div className="text-[10px] text-amber-300/80">
                  注意：{(sug.sources ?? []).filter((s) => !s.ok).map((s) => `${s.id} 这一路没跑起来（${s.note ?? "未知原因"}）`).join("；")} —— 上面的候选是剩下的那一路给的。
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button" onClick={() => void pin()} disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              data-control="home:topic-pin"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pin className="h-3 w-3" />}
              {saving ? "保存中…" : "固定到这个课题"}
            </button>
            <button type="button" onClick={close} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent">取消</button>
            <span className="text-[10px] text-muted-foreground/70">固定后写入你的账号，换设备也在。</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default HomeTopicBanner;
