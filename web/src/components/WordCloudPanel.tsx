// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// WordCloudPanel.tsx — 词云(2026-10-01, 自旧项目 AItoolman 移植)
//
// 由来: 本仓原先**完全没有词云**。旧项目有 `save_wordcloud`。
//
// ═══ 中文词云的两个静默坑(决定了这里的交互) ═══
//   ① **字体必须真有汉字字形**。用个纯拉丁字体(arial.ttf)会出**一片空白** ——
//      文件生成成功、大小正常、不报错。所以面板顶部直接显示服务端自检的字体名与版本,
//      不可用时按钮禁用并说明原因, 而不是让用户对着一张白图猜。
//   ② **短文本会被词频门槛挡掉**。默认 minCount=2, 而短文本里每个词本来就只出现一两次
//      —— 用户粘一段正常中文却被告知"没有关键词"。服务端现在会自动降档重试并回 note,
//      这里把 note 显式展示出来(降档不是看不见的行为)。
import { useEffect, useState, useMemo } from "react";
import { Cloud, Download, AlertTriangle, CheckCircle2, Palette } from "lucide-react";
import {
  PanelHeader, PanelCard, PanelButton, PanelEmpty, panelInputCls, PillGroup, StatTile, panelAccent,
} from "./PanelShell";
import { cn } from "../lib/utils";

interface Health { ok: boolean; font?: string; version?: string; error?: string }
interface Word { word: string; weight?: number; count?: number; size?: number }

/** 配色方案 —— 交给服务端 colormap, 比让用户传色值友好 */
const COLORMAPS = [
  { id: "viridis", label: "青绿" },
  { id: "plasma", label: "紫橙" },
  { id: "cool", label: "冷色" },
  { id: "autumn", label: "暖色" },
  { id: "Set2", label: "柔和" },
] as const;

/** @param onViewInGraph 嵌入文献库时由宿主提供: 点词频里的词 → 切到共现图谱 */
export function WordCloudPanel({ onViewInGraph }: { onViewInGraph?: (word: string) => void } = {}) {
  const [health, setHealth] = useState<Health | null>(null);
  const [text, setText] = useState("");
  const [maxWords, setMaxWords] = useState(120);
  const [cmap, setCmap] = useState<string>("viridis");
  const [bg, setBg] = useState<"dark" | "light">("dark");
  const [imageSrc, setImageSrc] = useState("");
  const [words, setWords] = useState<Word[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const d = await (await fetch("/api/wordcloud/health")).json();
        // 后端是旧版本/代理出错时返回的形状不是 Health, 逐字段兜底(否则 .join 崩整页)
        setHealth({
          ok: Boolean(d?.ok),
          font: typeof d?.font === "string" ? d.font : undefined,
          version: typeof d?.version === "string" ? d.version : undefined,
          error: d?.error ? "接口返回异常(后端可能还是旧版本)" : undefined,
        });
      } catch { setHealth({ ok: false, error: "自检请求失败" }); }
    })();
  }, []);

  const run = async () => {
    if (!text.trim()) { setErr("请先粘贴语料"); return; }
    setBusy(true); setErr(""); setImageSrc(""); setWords([]); setNote("");
    try {
      const r = await fetch("/api/wordcloud/render", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("sag_token") || ""}` },
        body: JSON.stringify({
          text, maxWords, lang: "auto",
          colormap: cmap,
          background: bg === "dark" ? "#0f172a" : "white",
        }),
      });
      const d = await r.json();
      // ⚠ 字段是 `imageBase64`(值已是 data URL)。第一版读 `d.base64` —— 图永远不显示且不报错。
      if (!r.ok || !d.ok) throw new Error(d?.error?.message || d?.error || "生成失败");
      if (!d.imageBase64) throw new Error("接口返回成功但没有图（字段名可能变了）");
      setImageSrc(d.imageBase64);
      setWords(d.words ?? []);
      setNote(d.note ?? "");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const a = panelAccent("violet");
  const fontName = useMemo(() => health?.font?.split(/[\\/]/).pop() ?? "", [health?.font]);

  return (
    <div className="space-y-3">
      <PanelHeader
        icon={<Cloud />} accent="violet" title="词云"
        subtitle="从语料抽词频并渲染成词云图。中文分词与中文字体由服务端处理"
        actions={
          health?.ok ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
              <CheckCircle2 className="h-3 w-3" />渲染可用 · {fontName}{health.version ? ` · v${health.version}` : ""}
            </span>
          ) : health ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
              <AlertTriangle className="h-3 w-3" />渲染不可用
            </span>
          ) : null
        }
      />

      {health && !health.ok && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            词云渲染不可用{health.error ? `：${health.error}` : ""}
            <div className="mt-0.5 text-amber-400/70">
              需要 python 的 <code>wordcloud</code> 库 + 一个<b>含汉字字形</b>的字体。
              用纯拉丁字体会出一片空白的图（文件生成成功、不报错）。
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[1fr_260px]">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={9}
          placeholder="粘贴语料（论文摘要、访谈记录、政策文本…）"
          className={panelInputCls} />

        <PanelCard icon={<Palette />} title="样式">
          <div className="space-y-3">
            <div>
              <div className="mb-1.5 text-[10px] text-muted-foreground">配色</div>
              <div className="flex flex-wrap gap-1">
                {COLORMAPS.map((c) => (
                  <button key={c.id} type="button" onClick={() => setCmap(c.id)}
                    className={cn("rounded-md border px-2 py-1 text-[10px] transition-colors",
                      cmap === c.id ? "border-violet-500/50 bg-violet-500/15 text-violet-300" : "border-border/60 text-muted-foreground hover:bg-accent")}>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[10px] text-muted-foreground">底色</div>
              <PillGroup accent="violet" value={bg} onChange={setBg}
                options={[{ value: "dark", label: "深色" }, { value: "light", label: "浅色" }]} />
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
                <span>最多词数</span><span className="tabular-nums text-foreground">{maxWords}</span>
              </div>
              <input type="range" min={20} max={400} step={10} value={maxWords}
                onChange={(e) => setMaxWords(Number(e.target.value))}
                className="w-full accent-violet-500" />
            </div>
            <PanelButton accent="violet" busy={busy} onClick={() => void run()}
              disabled={health?.ok === false} className="w-full justify-center">
              生成词云
            </PanelButton>
          </div>
        </PanelCard>
      </div>

      {err && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{err}</div>}

      {imageSrc && (
        <PanelCard icon={<Cloud />} title="词云图"
          actions={
            <>
              <StatTile accent="violet" value={words.length} label="入图词数" />
              <a href={imageSrc} download="wordcloud.png"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/60 px-2.5 py-1 text-[11px] hover:bg-accent">
                <Download className="h-3 w-3" />下载 PNG
              </a>
            </>
          }>
          {note && (
            <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300/90">
              {note}
            </div>
          )}
          <div className="overflow-hidden rounded-lg border border-border/40">
            <img src={imageSrc} alt="词云" className="w-full" />
          </div>
        </PanelCard>
      )}

      {words.length > 0 && (
        <PanelCard title="词频（前 60）">
          <div className="flex flex-wrap gap-1">
            {words.slice(0, 60).map((w, i) => {
              const wt = w.weight ?? w.count ?? 0;
              const max = Math.max(...words.slice(0, 60).map((x) => x.weight ?? x.count ?? 1), 1);
              const scale = 0.85 + (wt / max) * 0.75;
              return (
                /**
                 * 词条可点: 跳到共现图谱看**这个词跟谁一起出现** —— 词云只给词频,
                 * 回答不了"它和什么相关", 而那正是下一步要问的。
                 * 两个视图共用同一套抽词(keyword-network-service), 所以同一个词一定在那边。
                 */
                <button key={`${w.word}-${i}`} type="button"
                  onClick={() => onViewInGraph?.(w.word)}
                  disabled={!onViewInGraph}
                  className={cn("rounded-md border px-1.5 py-0.5 transition-colors",
                    onViewInGraph ? "hover:bg-accent cursor-pointer" : "cursor-default", a.ring, a.text)}
                  style={{ fontSize: `${scale * 11}px` }}
                  title={onViewInGraph ? `在共现图谱中查看「${w.word}」` : `权重 ${wt}`}>
                  {w.word}
                </button>
              );
            })}
          </div>
        </PanelCard>
      )}

      {!imageSrc && !busy && !err && (
        <PanelEmpty>粘贴语料后点「生成词云」—— 短文本会自动降低词频门槛并在图上注明</PanelEmpty>
      )}
    </div>
  );
}
