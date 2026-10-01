// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// AigcExternalPanel.tsx — AIGC 外接权威检测平台(2026-10-01)
//
// 由来: 自研检测(左栏)回答的是"在**我们的**刻度上有多像 AI"; 但用户投稿前要过的是
//   **期刊/学校指定的那一家**。这个面板接的是那件事。
//
// ═══ 两条路, 界面必须说清楚为什么 ═══
//   2026-10-01 逐家打过端点, 世界是这样切的:
//     · 有公开 API  → 配密钥, 直接在面板里送检并拿回分数
//     · 没有公开 API 的国内平台(知网/维普/万方/朱雀/中科睿鉴)  → "导出送检包"
//       给人拿去做, 做完把结果**回填**回来
//   把后者伪造成一个"适配器"是自欺欺人。所以这里的 UI 就是两种形态,
//   而且**不隐藏**任何一家 —— 用户最认的那几家恰恰都在第二类里。
//
// ═══ 一处刻意的设计: 保存的分数必须配平台原文 ═══
//   回填表单里 `rawExcerpt`(平台报告原文) 是**有分数就必填**的。后端也这么校验。
//   理由写在 ppt 之外更重要的地方: 期刊/学校认的是**那家平台的报告**,
//   不是我们库里一个光秃秃的数字。只留数字的回填, 事后没人能复核它从哪来 ——
//   那和编一个数没区别。
import { useEffect, useState } from "react";
import {
  ShieldCheck, KeyRound, Send, Loader2, Download, ClipboardCheck, Trash2, Info, ExternalLink, AlertTriangle,
} from "lucide-react";
import {
  PanelCard, PanelButton, PanelEmpty, PanelNotice, panelInputCls, PillGroup, StatTile, panelAccent,
} from "./PanelShell";
import { cn } from "../lib/utils";

interface Provider {
  id: string; name: string; mode: "api" | "manual"; fields: Array<"apiKey" | "email">;
  consoleUrl?: string; langs: string; pricing?: string; note: string;
  configured: boolean; usable: boolean; blockedReason?: string;
}
interface Cred { provider: string; scope: "platform" | "personal"; hint: string; email: string; enabled: boolean; updatedAt: string }
interface Scan { id: string; provider: string; status: string; score: number | null; verdict: string | null; error: string; text_chars: number; latency_ms: number; created_at: string }
interface Manual { id: string; provider: string; title: string; score: number | null; verdict: string | null; reference_no: string; raw_excerpt: string; text_chars: number; created_at: string }

const VERDICT: Record<string, { label: string; cls: string }> = {
  likely_human: { label: "更像人类写作", cls: "text-emerald-300" },
  mixed: { label: "混合特征", cls: "text-amber-300" },
  likely_ai: { label: "更像 AI 生成", cls: "text-red-300" },
  insufficient: { label: "样本不足", cls: "text-slate-400" },
};

const MODE_LABEL: Record<string, string> = { api: "可直连", manual: "人工送检" };

/** 供上层(检测面板/统稿定稿)复用的"送检包"结果 */
export interface PackageResult { filename: string; content: string; guide: string[]; checklist: string[] }

export function AigcExternalPanel({ text, title, accent = "violet" }: {
  /** 从上层带下来的待检文本 —— 用户不用再粘一次 */
  text: string;
  /** 送检包的文件名/标题用它 */
  title?: string;
  accent?: "violet" | "rose";
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [creds, setCreds] = useState<Cred[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [manual, setManual] = useState<Manual[]>([]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [selected, setSelected] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [pkg, setPkg] = useState<PackageResult | null>(null);
  // 回填表单
  const [fp, setFp] = useState({ provider: "", score: "", raw: "", refNo: "" });

  const a = panelAccent(accent);
  const tok = () => {
    try { return localStorage.getItem("sag_token") ?? ""; } catch { return ""; }
  };
  const req = async (url: string, init?: RequestInit) => {
    const r = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok()}`, ...(init?.headers ?? {}) },
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error?.message || d?.error || `请求失败(${r.status})`);
    return d;
  };

  const reload = async () => {
    try {
      const [p, c, s, m] = await Promise.all([
        req("/api/aigc/external/providers"),
        req("/api/aigc/external/credentials"),
        req("/api/aigc/external/scans"),
        req("/api/aigc/external/manual"),
      ]);
      setProviders(p.providers ?? []);
      setCreds(c.credentials ?? []);
      setScans(s.scans ?? []);
      setManual(m.submissions ?? []);
      // 默认选中第一个"现在真能用"的; 没有则选第一个 api 模式但未配密钥的, 引导去配
      setSelected((cur) => cur || (p.providers ?? []).find((x: Provider) => x.usable)?.id
        || (p.providers ?? []).find((x: Provider) => x.mode === "api")?.id || "");
    } catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const sel = providers.find((p) => p.id === selected) ?? null;
  const cred = creds.find((c) => c.provider === selected) ?? null;
  const chars = text.replace(/\s/g, "").length;

  const saveKey = async () => {
    if (!sel || !keyInput.trim()) { setErr("请先填写密钥"); return; }
    setBusy("key"); setErr(""); setMsg("");
    try {
      await req("/api/aigc/external/credentials", {
        method: "POST",
        body: JSON.stringify({ provider: sel.id, apiKey: keyInput.trim(), email: emailInput.trim() || undefined }),
      });
      setKeyInput(""); setEmailInput("");
      setMsg(`已保存「${sel.name}」的密钥（加密存储，界面只回显后 4 位）`);
      await reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };

  const delKey = async () => {
    if (!sel) return;
    setBusy("key"); setErr("");
    try {
      await req(`/api/aigc/external/credentials/${sel.id}?scope=${cred?.scope ?? "personal"}`, { method: "DELETE" });
      setMsg(`已删除「${sel.name}」的密钥`); await reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };

  const doScan = async () => {
    if (!sel) return;
    if (!text.trim()) { setErr("没有可送检的文本 —— 先在左边粘贴或检测"); return; }
    setBusy("scan"); setErr(""); setMsg("");
    try {
      const r = await req("/api/aigc/external/scan", {
        method: "POST",
        body: JSON.stringify({ provider: sel.id, text, lang: /[一-龥]/.test(text) ? "zh" : "en" }),
      });
      setMsg(`${sel.name} 送检完成：AI 特征 ${r.score} / 100${r.summary ? ` —— ${r.summary}` : ""}`);
      await reload();
    } catch (e) { setErr((e as Error).message); await reload(); } finally { setBusy(""); }
  };

  /**
   * 生成送检包**并直接下载**。
   *
   * ⚠ 原来只生成不下载, 要用户再点一次「下载 xxx.txt」—— 而那个按钮叫「**导出**送检包」。
   *   "导出"承诺的就是"我拿到一个文件", 点了却什么也没落到磁盘上, 用户会以为
   *   它坏了或者被浏览器拦了。实测(2026-10-01 点击流): 点「导出」没有 download 事件。
   *   名字与行为对齐: 生成成功即下载, 面板上仍保留按钮供**重新下载**(关掉对话框/手滑之后)。
   */
  const makePackage = async () => {
    if (!sel) return;
    if (!text.trim()) { setErr("没有可送检的文本"); return; }
    setBusy("pkg"); setErr(""); setMsg("");
    try {
      const r = await req("/api/aigc/external/package", {
        method: "POST",
        body: JSON.stringify({ provider: sel.id, title: title || "送检文本", text }),
      });
      const made = { filename: r.filename, content: r.content, guide: r.guide ?? [], checklist: r.checklist ?? [] };
      setPkg(made);
      setFp((f) => ({ ...f, provider: sel.id }));
      saveBlob(made.content, made.filename);
      setMsg(`送检包已下载（${made.filename}）—— 按下面的步骤去平台检测，回来把结果填进「回填」`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };

  const saveBlob = (content: string, filename: string) => {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url; el.download = filename; el.click();
    URL.revokeObjectURL(url);
  };

  const downloadPkg = () => { if (pkg) saveBlob(pkg.content, pkg.filename); };

  const submitManual = async () => {
    if (!fp.provider) { setErr("请选择平台"); return; }
    setBusy("manual"); setErr(""); setMsg("");
    try {
      await req("/api/aigc/external/manual", {
        method: "POST",
        body: JSON.stringify({
          provider: fp.provider,
          title: title || "送检文本",
          score: fp.score.trim() === "" ? null : Number(fp.score),
          rawExcerpt: fp.raw,
          referenceNo: fp.refNo,
          text,
        }),
      });
      setFp({ provider: fp.provider, score: "", raw: "", refNo: "" });
      setMsg("回填已保存 —— 它会出现在下面的历史里，作为投稿时的凭证");
      await reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };

  const apiProviders = providers.filter((p) => p.mode === "api");
  const manualProviders = providers.filter((p) => p.mode === "manual");

  return (
    <div className="space-y-3">
      {err && <PanelNotice type="err">{err}</PanelNotice>}
      {msg && <PanelNotice type="ok">{msg}</PanelNotice>}

      {/* ── 服务商选择 ── */}
      <PanelCard title="选择平台" icon={<ShieldCheck />}
        actions={<span className="text-[10px] text-muted-foreground">
          共 {providers.length} 家 · {apiProviders.length} 家可直连
        </span>}>
        <div className="space-y-2">
          <div>
            <div className="mb-1.5 text-[10px] font-medium text-muted-foreground">可直连（配好自己的密钥即可送检）</div>
            <div className="grid gap-1.5 md:grid-cols-2">
              {apiProviders.map((p) => (
                <button key={p.id} type="button" onClick={() => { setSelected(p.id); setPkg(null); }}
                  className={cn("rounded-lg border p-2.5 text-left transition-colors",
                    selected === p.id ? cn(a.ring, "bg-accent/40") : "border-border/50 hover:bg-accent/40")}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-semibold">{p.name}</span>
                    {p.usable
                      ? <span className="rounded bg-emerald-500/15 px-1 py-px text-[9px] text-emerald-300">密钥已配</span>
                      : <span className="rounded bg-slate-500/15 px-1 py-px text-[9px] text-slate-400">{p.blockedReason}</span>}
                    {p.langs === "en" && <span className="rounded bg-amber-500/15 px-1 py-px text-[9px] text-amber-300">仅英文</span>}
                  </div>
                  <div className="mt-1 line-clamp-2 text-[10px] leading-4 text-muted-foreground">{p.note}</div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[10px] font-medium text-muted-foreground">
              人工送检（这些平台<b>没有公开接口</b>，导出送检包 + 回填结果）
            </div>
            <div className="grid gap-1.5 md:grid-cols-3">
              {manualProviders.map((p) => (
                <button key={p.id} type="button" onClick={() => { setSelected(p.id); setPkg(null); setFp((f) => ({ ...f, provider: p.id })); }}
                  className={cn("rounded-lg border p-2 text-left transition-colors",
                    selected === p.id ? cn(a.ring, "bg-accent/40") : "border-border/50 hover:bg-accent/40")}>
                  <div className="text-[11px] font-semibold">{p.name}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </PanelCard>

      {/* ── 选中平台的详情 + 动作 ── */}
      {sel && (
        <PanelCard title={sel.name} icon={<Info />}
          actions={sel.consoleUrl ? (
            <a href={sel.consoleUrl} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground">
              打开官网 <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}>
          <p className="text-[11px] leading-5 text-muted-foreground">{sel.note}</p>
          {sel.pricing && <p className="mt-1 text-[10px] text-muted-foreground">计费：{sel.pricing}</p>}

          {sel.mode === "api" ? (
            <>
              {/* 密钥 —— 已配只回显尾 4 位 */}
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <div className="min-w-[200px] flex-1">
                  <label className="mb-1 block text-[10px] text-muted-foreground">
                    {cred ? <>已配置：<span className="font-mono text-foreground">{cred.hint}</span>（{cred.scope === "platform" ? "平台共用" : "我的"}）</> : "API 密钥"}
                  </label>
                  <input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)}
                    placeholder={cred ? "不修改就留空" : "粘贴密钥…"} className={panelInputCls} autoComplete="off" />
                </div>
                {sel.fields.includes("email") && (
                  <div className="min-w-[180px] flex-1">
                    <label className="mb-1 block text-[10px] text-muted-foreground">账号邮箱（{sel.name} 两段式鉴权需要）</label>
                    <input value={emailInput} onChange={(e) => setEmailInput(e.target.value)}
                      placeholder={cred?.email || "you@example.com"} className={panelInputCls} autoComplete="off" />
                  </div>
                )}
                <PanelButton accent={accent} variant="outline" busy={busy === "key"}
                  disabled={!keyInput.trim()} onClick={() => void saveKey()}>
                  <KeyRound className="h-3 w-3" />{cred ? "覆盖" : "保存密钥"}
                </PanelButton>
                {cred && (
                  <PanelButton accent={accent} variant="ghost" busy={busy === "key"} onClick={() => void delKey()}>
                    <Trash2 className="h-3 w-3" />删除
                  </PanelButton>
                )}
              </div>
              <p className="mt-1.5 text-[10px] text-muted-foreground">
                密钥以 AES-256-GCM 加密存储在本机数据库，界面与接口都不会回显明文（只回显后 4 位）。
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
                <PanelButton accent={accent} busy={busy === "scan"} disabled={!cred || !text.trim()} onClick={() => void doScan()}>
                  <Send className="h-3.5 w-3.5" />送检{chars > 0 ? `（${chars} 字）` : ""}
                </PanelButton>
                {!cred && <span className="text-[10px] text-amber-300/90">先配密钥 —— 没有密钥连不上平台</span>}
                {cred && sel.id === "sapling" && /[一-龥]/.test(text) && (
                  <span className="text-[10px] text-amber-300/90">⚠ 当前文本含中文，Sapling 只支持英文，送检会被拒绝</span>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <PanelButton accent={accent} busy={busy === "pkg"} disabled={!text.trim()} onClick={() => void makePackage()}>
                  <Download className="h-3.5 w-3.5" />导出送检包{chars > 0 ? `（${chars} 字）` : ""}
                </PanelButton>
                {!text.trim() && <span className="text-[10px] text-muted-foreground">先在左边粘贴待检文本</span>}
              </div>
              {pkg && (
                <div className="mt-2 rounded-lg border border-border/60 bg-background/40 p-3">
                  <div className="mb-1.5 text-[11px] font-semibold">操作步骤</div>
                  <ol className="space-y-1 text-[10.5px] leading-5 text-muted-foreground">
                    {pkg.guide.map((g, i) => <li key={i}>{g}</li>)}
                  </ol>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <PanelButton accent={accent} size="sm" onClick={downloadPkg}>
                      <Download className="h-3 w-3" />重新下载 {pkg.filename}
                    </PanelButton>
                  </div>
                </div>
              )}
            </>
          )}
        </PanelCard>
      )}

      {/* ── 回填 ── */}
      {(sel?.mode === "manual" || manual.length > 0) && (
        <PanelCard title="人工送检回填" icon={<ClipboardCheck />}>
          <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-400" />
            <p className="text-[10.5px] leading-4 text-amber-300/90">
              填了分数就<b>必须</b>附平台报告原文 —— 期刊/学校认的是那家平台的报告，
              不是我们库里一个数字。只留数字的回填事后无法复核，等同于编造。
            </p>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-[10px] text-muted-foreground">平台</label>
              <select value={fp.provider} onChange={(e) => setFp({ ...fp, provider: e.target.value })} className={panelInputCls}>
                <option value="">— 选择 —</option>
                {manualProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] text-muted-foreground">分数（AI 疑似度 / AI 生成占比，0-100）</label>
              <input value={fp.score} onChange={(e) => setFp({ ...fp, score: e.target.value })}
                placeholder="例如 12.3" inputMode="decimal" className={panelInputCls} />
            </div>
            <div className="md:col-span-2">
              <label className="mb-1 block text-[10px] text-muted-foreground">平台报告原文（照抄，别改写）</label>
              <input value={fp.raw} onChange={(e) => setFp({ ...fp, raw: e.target.value })}
                placeholder="例如：AI 生成疑似度 12.3%" className={panelInputCls} />
            </div>
            <div className="md:col-span-2">
              <label className="mb-1 block text-[10px] text-muted-foreground">批次号 / 报告编号（可选）</label>
              <input value={fp.refNo} onChange={(e) => setFp({ ...fp, refNo: e.target.value })} className={panelInputCls} />
            </div>
          </div>
          <div className="mt-2">
            <PanelButton accent={accent} busy={busy === "manual"} disabled={!fp.provider} onClick={() => void submitManual()}>
              <ClipboardCheck className="h-3.5 w-3.5" />保存回填
            </PanelButton>
          </div>
        </PanelCard>
      )}

      {/* ── 历史 ── */}
      {(scans.length > 0 || manual.length > 0) && (
        <PanelCard title="检测历史" icon={<ShieldCheck />}>
          <div className="space-y-1.5">
            {scans.map((s) => {
              const v = s.verdict ? VERDICT[s.verdict] : null;
              return (
                <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 px-2.5 py-1.5">
                  <span className="rounded bg-accent/60 px-1.5 py-px text-[9px] text-muted-foreground">直连</span>
                  <span className="w-24 shrink-0 truncate text-[11px] font-medium">
                    {providers.find((p) => p.id === s.provider)?.name ?? s.provider}
                  </span>
                  {s.status === "done"
                    ? <>
                        <StatTile accent={accent} value={Math.round(s.score ?? 0)} label="/100" />
                        {v && <span className={cn("text-[10px]", v.cls)}>{v.label}</span>}
                      </>
                    : s.status === "failed"
                      ? <span className="text-[10px] text-red-300 line-clamp-1">{s.error || "失败"}</span>
                      : <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" />送检中
                        </span>}
                  <span className="ml-auto text-[9px] tabular-nums text-muted-foreground">
                    {s.text_chars} 字 · {s.latency_ms}ms · {String(s.created_at).slice(0, 16).replace("T", " ")}
                  </span>
                </div>
              );
            })}
            {manual.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 px-2.5 py-1.5">
                <span className="rounded bg-amber-500/15 px-1.5 py-px text-[9px] text-amber-300">人工</span>
                <span className="w-24 shrink-0 truncate text-[11px] font-medium">
                  {providers.find((p) => p.id === m.provider)?.name ?? m.provider}
                </span>
                {m.score != null && <StatTile accent={accent} value={Math.round(m.score)} label="/100" />}
                <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={m.raw_excerpt}>
                  {m.raw_excerpt}
                </span>
                <span className="text-[9px] tabular-nums text-muted-foreground">
                  {String(m.created_at).slice(0, 10)}
                </span>
                <button type="button" title="删除"
                  onClick={() => void req(`/api/aigc/external/manual/${m.id}`, { method: "DELETE" }).then(reload)}
                  className="text-muted-foreground hover:text-red-300">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </PanelCard>
      )}

      {providers.length === 0 && !err && <PanelEmpty>正在读取可用平台…</PanelEmpty>}
    </div>
  );
}
