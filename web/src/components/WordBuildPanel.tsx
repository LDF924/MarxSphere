// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// WordBuildPanel.tsx — Word 成品构建: LaTeX 公式 + 封面目录(2026-10-01, 自旧项目 AItoolman 移植)
//
// 由来: 本仓原先导出的 docx 里**公式是纯文本**(全仓 grep OMML/latex2mathml = 0),
//   而且**没有封面、没有目录**。旧项目这两个工具是明文源码随包分发的, 是唯一能直搬的部分。
//
// 第一版丑在: 大 textarea + 右侧一列裸 input/select/checkbox。改成**左右双栏**
//   (左边写正文, 右边配置), 并把"公式会变成什么"讲清楚 —— 这是本功能唯一的卖点,
//   用户看不出差别就不会用。
import { useEffect, useState } from "react";
import {
  Wand2, Download, AlertTriangle, CheckCircle2, FileText, Sigma, BookMarked, Loader2, ArrowRight,
} from "lucide-react";
import {
  PanelHeader, PanelCard, PanelButton, PanelEmpty, panelInputCls, PillGroup, panelAccent,
} from "./PanelShell";
import { cn } from "../lib/utils";
import { putHandoff, HANDOFF_KIND } from "../lib/handoff";

interface Health { ok: boolean; python: string; missing: string[]; hint?: string; error?: string }

const SAMPLE = String.raw`本文考察偏向机制的形成路径。

$$P = f(X, W, \Theta)$$

其中 \( P \) 为路径结果向量[1]，\( \Theta \) 为参数集。验证误差为：

$$E = \| \hat{P} - P \|_2^2 + \lambda \| \Theta \|_1$$`;

function download(b64: string, name: string) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function WordBuildPanel({ onNavigate }: { onNavigate?: (v: string) => void } = {}) {
  const [health, setHealth] = useState<Health | null>(null);
  const [content, setContent] = useState(SAMPLE);
  const [title, setTitle] = useState("论文标题");
  const [font, setFont] = useState("宋体");
  const [cover, setCover] = useState(true);
  const [position, setPosition] = useState<"high" | "center" | "low">("center");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const d = await (await fetch("/api/docx-build/health")).json();
        // 逐字段兜底: 后端是旧版本时返回的不是 Health 形状, 直接渲染会 .join 崩整页
        setHealth({
          ok: Boolean(d?.ok),
          python: typeof d?.python === "string" ? d.python : "",
          missing: Array.isArray(d?.missing) ? d.missing : [],
          hint: typeof d?.hint === "string" ? d.hint : undefined,
          error: d?.error ? "接口返回异常(后端可能还是旧版本)" : undefined,
        });
      } catch { setHealth({ ok: false, python: "", missing: [], error: "自检请求失败" }); }
    })();
  }, []);

  const build = async () => {
    if (!content.trim()) { setMsg({ text: "请先输入内容", ok: false }); return; }
    setBusy(true); setMsg(null);
    try {
      const r1 = await fetch("/api/docx-build/latex-to-docx", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, title, fontName: font }),
      });
      const d1 = await r1.json();
      if (!r1.ok || !d1.ok) throw new Error(d1?.error?.message || d1?.error || "公式转换失败");

      let base64 = d1.base64 as string;
      let note = `公式 ${d1.meta?.formulas ?? 0} 个已转为 Word 原生公式`;

      if (cover) {
        const r2 = await fetch("/api/docx-build/cover-toc", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docxBase64: base64, title, position, engine: "python" }),
        });
        const d2 = await r2.json();
        if (!r2.ok || !d2.ok) throw new Error(d2?.error?.message || d2?.error || "封面目录生成失败");
        base64 = d2.base64 as string;
        note += "；已加封面与目录";
      }

      download(base64, `${title || "document"}.docx`);
      setMsg({ text: `${note}。下载已开始。`, ok: true });
    } catch (e) {
      setMsg({ text: (e as Error).message, ok: false });
    } finally { setBusy(false); }
  };

  const a = panelAccent("sky");

  return (
    <div className="space-y-3">
      <PanelHeader
        icon={<FileText />} accent="sky" title="Word 成品构建"
        subtitle="含 LaTeX 公式的文本 → Word。公式转成原生 OMML（可在 Word 里点开编辑，不是图片也不是纯文本）"
        actions={
          health?.ok
            ? <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
                <CheckCircle2 className="h-3 w-3" />依赖就绪
              </span>
            : health
              ? <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
                  <AlertTriangle className="h-3 w-3" />依赖缺失
                </span>
              : null
        }
      />

      {health && !health.ok && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            {health.missing.length > 0
              ? <>python 依赖缺失：<code>{health.missing.join(", ")}</code></>
              : <>自检未通过{health.error ? `：${health.error}` : ""}</>}
            {health.hint && <div className="mt-0.5 text-amber-400/70">{health.hint}</div>}
          </div>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
        <PanelCard icon={<Sigma />} title="正文"
          actions={<span className="text-[10px] text-muted-foreground">$$…$$ 行间 · \(…\) 行内</span>}>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={14}
            className={panelInputCls + " font-mono leading-5"} />
        </PanelCard>

        <div className="space-y-3">
          <PanelCard icon={<BookMarked />} title="输出设置">
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-[10px] text-muted-foreground">标题</div>
                <input value={title} onChange={(e) => setTitle(e.target.value)} className={panelInputCls} />
              </div>
              <div>
                <div className="mb-1 text-[10px] text-muted-foreground">中文字体</div>
                <PillGroup accent="sky" value={font} onChange={setFont}
                  options={["宋体", "楷体", "黑体", "仿宋"].map((f) => ({ value: f, label: f }))} />
              </div>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/50 px-2.5 py-2 text-[11px]">
                <input type="checkbox" checked={cover} onChange={(e) => setCover(e.target.checked)}
                  className="accent-sky-500" />
                生成封面页与目录
              </label>
              {cover && (
                <div>
                  <div className="mb-1 text-[10px] text-muted-foreground">封面标题位置</div>
                  <PillGroup accent="sky" value={position} onChange={setPosition}
                    options={[{ value: "high", label: "偏上" }, { value: "center", label: "居中" }, { value: "low", label: "偏下" }]} />
                </div>
              )}
              <PanelButton accent="sky" busy={busy} onClick={() => void build()}
                disabled={health?.ok === false} className="w-full justify-center">
                <Wand2 className="h-3.5 w-3.5" />生成并下载 .docx
              </PanelButton>
            </div>
          </PanelCard>

          <PanelCard title="公式会变成什么">
            <div className="space-y-2 text-[10px] leading-4 text-muted-foreground">
              <p><b className="text-foreground">原生公式</b>：Word 里可以点开编辑、改符号、重排；期刊排版系统能识别。</p>
              <p><b className="text-foreground">不是图片</b>：图片公式放大会糊、不可检索、投稿时会被要求重做。</p>
              <p><b className="text-foreground">不是纯文本</b>：`\alpha` 这种 LaTeX 源码不会原样留在文档里。</p>
            </div>
          </PanelCard>
        </div>
      </div>

      {msg && (
        <div className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px]",
          msg.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-red-500/30 bg-red-500/10 text-red-300")}>
          {msg.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <div>
            {msg.text}
            {msg.ok && cover && (
              <div className="mt-0.5 text-emerald-400/70">
                目录用的是 Word 的 TOC 域 —— 纯 python-docx 算不出页码，文档里已写入自动更新标记，
                打开时 Word/WPS 会自动生成页码。
              </div>
            )}
            {/*
              导完顺手能查格式 —— 这两个动作在同一次"要投稿"里是连着的。
              不给这条路, 用户要自己去切 tab、再传一次同一个文件。
            */}
            {msg.ok && onNavigate && (
              <div className="mt-2">
                <button type="button"
                  onClick={() => { putHandoff("Word 成品构建", HANDOFF_KIND.DOCX_TO_EVAL, {}); onNavigate("format-eval"); }}
                  className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 px-2.5 py-1 text-[11px] hover:bg-emerald-500/15">
                  <ArrowRight className="h-3 w-3" />顺手查一下格式
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {!msg && !busy && <PanelEmpty>左侧贴正文（含 LaTeX 公式），右侧配置好后点「生成并下载」</PanelEmpty>}
    </div>
  );
}
