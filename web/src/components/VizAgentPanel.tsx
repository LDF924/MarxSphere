// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// VizAgentPanel.tsx — SocialSci P0-4: 对话式科研绘图 Agent(在线科研绘图)
// 形态对齐(闭源产品交互语义, 原创实现): NL对话出图 → Agent循环(plan/tool/critique 折叠展示)
//   - 聊天流(工具调用/thinking 折叠) + 画布区(产物版本时间线 + PNG下载/入素材)
//   - 会话列表(可多会话); 版本化产物 png + svg_editable
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BarChart3, Bug, CheckCircle2, ChevronDown, Download, ImageIcon, Loader2,
  MessageSquarePlus, Send, Sparkles, Trash2, Upload, Wand2,
} from "lucide-react";
import { readResume } from "./ResearchHistoryPanel";
import { MarkdownRich } from "./MarkdownRich";

interface Session { id: string; title: string; status: string; created_at: string; updated_at?: string; artifact_count: string; }
interface Artifact { id: string; session_id: string; version: number; prompt: string; png_path: string; svg_editable_path: string; critique: { improve?: string }; status: string; created_at: string; }
interface Msg {
  id: string; role: string; content: string | { text?: string; name?: string; status?: string; error?: string; content?: string; artifact?: { pngRel: string; svgRel: string }; version?: number; title?: string; issues?: unknown[] };
  seq: number; created_at: string;
}

function tokenOf() { return localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""; }
async function j<T = unknown>(url: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...((opts.headers as Record<string, string>) ?? {}) };
  const t = tokenOf(); if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(url, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string })?.error || `请求失败 ${r.status}`);
  return body as T;
}
function cn(...xs: Array<string | false | undefined>) { return xs.filter(Boolean).join(" "); }
function artUrl(p: string): string { return p.startsWith("http") ? p : `/api/viz/files/${p}`; }
// R9(闭源 VizView 图片加载): blob 获取 cache no-store + 4 次重试(仅 401/404/408/425/429/500/502/503/504), 150ms*attempt 退避
const RETRYABLE = new Set([401, 404, 408, 425, 429, 500, 502, 503, 504]);
function useArtBlob(p: string): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!p) return;
    let alive = true;
    const cacheKey = "art:" + p;
    const hit = sessionStorage.getItem(cacheKey);
    if (hit) { setUrl(hit); return; }
    (async () => {
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (!alive) return;
        try {
          const r = await fetch(artUrl(p), { headers: { Authorization: `Bearer ${tokenOf()}` }, cache: "no-store" });
          if (r.ok) {
            const u = URL.createObjectURL(await r.blob());
            try { sessionStorage.setItem(cacheKey, u); } catch { /* 超限忽略 */ }
            if (alive) setUrl(u);
            return;
          }
          lastErr = new Error(`图表文件加载失败 (${r.status})`);
          if (!RETRYABLE.has(r.status)) break;
        } catch (e) { lastErr = e as Error; }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
      if (alive && lastErr) setUrl(artUrl(p)); // 兜底直链(浏览器自带重试)
    })();
    return () => { alive = false; };
  }, [p]);
  return url || artUrl(p);
}
function ArtImg({ path, className, alt }: { path: string; className?: string; alt?: string }) {
  const src = useArtBlob(path);
  return <img src={src} alt={alt ?? "chart"} className={className} />;
}
function msgText(m: Msg): string {
  const c = m.content;
  if (typeof c === "string") return c;
  return c?.text ?? c?.content ?? c?.name ?? "";
}

export function VizAgentPanel() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [curSession, setCurSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [live, setLive] = useState<Array<{ kind: string; text: string }>>([]); // 实时 SSE 事件流
  const [csvName, setCsvName] = useState("");
  const csvRef = useRef<{ csv: string; cols: string[] } | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  // 期刊规范预设(闭源 VizView journal spec 对齐)
  const [specPreset, setSpecPreset] = useState("journal-double");
  // 图表类型九宫格(闭源 VizView chartType 对齐): 点击把意图填入输入框
  const CHART_TYPE_PROMPTS: Array<{ k: string; label: string; tpl: string }> = [
    { k: "line", label: "折线图", tpl: "画折线图: 用 x 列做横轴、y 列做纵轴, 趋势清晰、带数据点" },
    { k: "bar", label: "柱状图", tpl: "画柱状图: 对比各组数值, 柱顶标数值" },
    { k: "scatter", label: "散点图", tpl: "画散点图: 观察两变量相关关系, 加趋势线" },
    { k: "box", label: "箱线图", tpl: "画箱线图: 分组展示分布(中位数/四分位/离群点)" },
    { k: "violin", label: "小提琴图", tpl: "画小提琴图: 分组密度分布对比" },
    { k: "heatmap", label: "热力图", tpl: "画热力图: 数值矩阵/相关性可视化" },
    { k: "hist", label: "直方图", tpl: "画直方图: 展示单变量频数分布" },
    { k: "pie", label: "饼图", tpl: "画饼图: 占比构成" },
    { k: "custom", label: "自定义", tpl: "" },
  ];
  const SPEC_PRESETS: Record<string, { label: string; spec: Record<string, unknown> }> = {
    "journal-double": { label: "期刊·双栏(183mm)", spec: { widthMm: 183, heightMm: 120, dpi: 300, fontSize: 9, fontFamily: "Arial", lineWidth: 1 } },
    "journal-single": { label: "期刊·单栏(89mm)", spec: { widthMm: 89, heightMm: 62.3, dpi: 600, fontSize: 7, fontFamily: "Arial", lineWidth: 0.8 } },
    nature: { label: "Nature 风格", spec: { widthMm: 89, heightMm: 62.3, dpi: 600, fontSize: 7, fontFamily: "Arial", lineWidth: 0.8 } },
    "slide-wide": { label: "汇报宽图(240mm)", spec: { widthMm: 240, heightMm: 135, dpi: 150, fontSize: 11, fontFamily: "Microsoft YaHei", lineWidth: 1.2 } },
    loose: { label: "演示通用(183mm@130)", spec: { widthMm: 183, heightMm: 120, dpi: 130, fontSize: 10, fontFamily: "SimHei", lineWidth: 1 } },
  };

  const loadSessions = useCallback(async () => {
    try { const r = await j<{ sessions: Session[] }>("/api/viz/sessions"); setSessions(r.sessions ?? []); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void loadSessions(); }, [loadSessions]);

  // 历史中心 deep-resume: 从历史记录 viz 区卡点击跳入 → 自动打开对应绘图会话
  // D6(闭源 viz_save_<uid>_<taskId>): 无 resume 时恢复 localStorage 最后会话
  useEffect(() => {
    const r = readResume("viz");
    if (r?.id) { void loadSession(String(r.id)); return; }
    const last = (() => { try { return localStorage.getItem("viz_save_active"); } catch { return null; } })();
    if (last) void loadSession(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSession = async (sid: string) => {
    setCurSession(sid); setMessages([]); setArtifacts([]); setErr("");
    // B5(审查): 切会话清 CSV 引用(防上一会话数据带入新会话)
    csvRef.current = null; setCsvName("");
    try {
      // D6(闭源 viz_save_<uid>_<taskId>): 会话双写 localStorage, 供刷新/重进恢复
      try { localStorage.setItem("viz_save_active", sid); } catch { /* 忽略 */ }
      const [m, a] = await Promise.all([
        j<{ messages: Msg[] }>(`/api/viz/sessions/${sid}/messages`),
        j<{ artifacts: Artifact[] }>(`/api/viz/sessions/${sid}/artifacts`),
      ]);
      setMessages(m.messages ?? []);
      setArtifacts(a.artifacts ?? []);
    } catch (e) { setErr((e as Error).message); }
  };

  const newSession = async () => {
    setBusy(true); setErr("");
    try {
      const r = await j<{ id: string }>("/api/viz/sessions", { method: "POST", body: JSON.stringify({ title: "未命名绘图会话" }) });
      await loadSessions();
      await loadSession(r.id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // CSV 上传(前端解析列名, 送服务端做真实计算)
  const onCsv = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) return;
      const cols = lines[0].split(",").map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
      csvRef.current = { csv: text, cols };
      setCsvName(f.name);
    };
    reader.readAsText(f);
  };

  // D4(闭源 viz job): 观察 job SSE — 事件驱动 live 更新
  // 审查 S3: stream 无限挂起, EOF 不一定是终态 → 结束后查 job 状态, 未终态则自动重连
  // 重连语义: 服务端重放全事件(after=0, 事件源幂等), 每次连接重建 liveBuf 防重复堆积
  const observeJob = async (jobId: string, _after = 0): Promise<void> => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const liveBuf: Array<{ kind: string; text: string }> = [];
      const handle = (ev: string, obj: Record<string, unknown>) => {
        liveBuf.push({ kind: ev, text: typeof obj?.content === "string" ? String(obj.content).slice(0, 300) : "" });
        setLive([...liveBuf]);
        if (ev === "viz.completed" && curSession) {
          void j<{ artifacts: Artifact[] }>(`/api/viz/sessions/${curSession}/artifacts`).then((a) => setArtifacts(a.artifacts ?? [])).catch(() => {});
        }
        if (ev === "error") setErr((obj as { userMessage?: string }).userMessage || "绘图失败");
      };
      setLive([]);
      const r = await fetch(`/api/viz/jobs/${jobId}/stream?after=0`, {
        headers: { Authorization: `Bearer ${tokenOf()}`, Accept: "text/event-stream" },
      });
      if (!r.ok || !r.body) throw new Error(`观察连接失败 ${r.status}`);
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
      let sawTerminal = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
        for (const p of parts) {
          const ev = p.match(/event: (\S+)/)?.[1];
          const data = p.match(/data: (.*)/s)?.[1];
          if (!data || !ev) continue;
          const obj = JSON.parse(data);
          if (ev === "viz.completed" || ev === "cancelled" || ev === "viz_failed") sawTerminal = true;
          if (ev === "error") { handle("error", obj); continue; }
          handle(ev, obj);
        }
      }
      if (sawTerminal) return;
      // 流结束未达终态 → 查 DB 状态决定重连还是放弃
      const st = await j<{ job: { status: string } }>(`/api/viz/jobs/${jobId}`).catch(() => null);
      const status = st?.job?.status;
      if (status === "done" || status === "failed" || status === "cancelled" || !status) {
        if (status === "done") { handle("viz.completed", {}); }
        return;
      }
      // 仍 running(连接被服务端重置) → 等 1.5s 后重连重放
      await new Promise((r) => setTimeout(r, 1500));
    }
  };

  const send = async () => {
    if (busy) return; // B6(审查): Enter 双发守卫
    const msg = input.trim();
    if (!msg || !curSession) return;
    setInput(""); setBusy(true); setErr(""); setLive([]);
    // 本地上屏
    setMessages((ms) => [...ms, { id: `local-${Date.now()}`, role: "user", content: { text: msg }, seq: ms.length + 1, created_at: new Date().toISOString() }]);
    try {
      // D4: 建 job(后台执行, 断线不中断) → 存 activeJobId → SSE 观察
      const r = await j<{ job_id: string }>("/api/viz/jobs", {
        method: "POST",
        body: JSON.stringify({
          sessionId: curSession,
          message: msg,
          csv: csvRef.current?.csv,
          columnOrder: csvRef.current?.cols ?? [],
          spec: SPEC_PRESETS[specPreset]?.spec ?? SPEC_PRESETS["journal-double"].spec,
        }),
      });
      try { localStorage.setItem("viz_active_job", r.job_id); } catch { /* 忽略 */ }
      await observeJob(r.job_id);
      // 结束后刷消息+产物
      const [m, a] = await Promise.all([
        j<{ messages: Msg[] }>(`/api/viz/sessions/${curSession}/messages`),
        j<{ artifacts: Artifact[] }>(`/api/viz/sessions/${curSession}/artifacts`),
      ]);
      setMessages(m.messages ?? []);
      setArtifacts(a.artifacts ?? []);
      await loadSessions();
    } catch (e) { setErr((e as Error).message); } finally {
      setBusy(false); setLive([]);
      try { localStorage.removeItem("viz_active_job"); } catch { /* 忽略 */ }
    }
  };

  // D4: 挂载断线恢复 — 上次会话有 activeJob 未完成 → 重连观察(重放事件)
  useEffect(() => {
    const activeJob = (() => { try { return localStorage.getItem("viz_active_job"); } catch { return null; } })();
    if (activeJob) {
      void (async () => {
        try {
          const jr = await j<{ job: { status: string } }>(`/api/viz/jobs/${activeJob}`);
          if (jr.job && (jr.job.status === "queued" || jr.job.status === "running")) {
            setBusy(true);
            await observeJob(activeJob, 0);
          }
        } catch { /* job 不存在/过期忽略 */ } finally {
          setBusy(false); setLive([]);
          try { localStorage.removeItem("viz_active_job"); } catch { /* 忽略 */ }
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 入素材库
  const toMaterials = async (art: Artifact) => {
    setErr("");
    const pid = window.prompt("目标项目 ID (research 项目, 留空跳过):");
    if (!pid) return;
    try {
      await j(`/api/viz/artifacts/${art.id}/to-materials`, { method: "POST", body: JSON.stringify({ projectId: pid }) });
      setErr("已导入素材库");
    } catch (e) { setErr((e as Error).message); }
  };

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, live, artifacts]);

  const latest = artifacts[0];
  const liveLabel = (k: string) =>
    k === "thinking" ? "思考" : k === "tool" ? "工具执行" : k === "plan" ? "规划" : k === "critique" ? "自审" : k === "critique_fix" ? "修订" : k === "chart" ? "出图" : k;

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-pink-400" />
          <h2 className="text-base font-bold text-slate-100">科研绘图</h2>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">SocialSci 对齐</span>
        </div>
        <button onClick={newSession} className="flex items-center gap-1.5 rounded-lg bg-pink-600 px-3 py-1.5 text-xs text-white hover:bg-pink-500">
          <MessageSquarePlus className="h-3.5 w-3.5" /> 新建绘图会话
        </button>
      </div>

      {err && <div className="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">{err}</div>}

      <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr_300px] gap-3">
        {/* 会话列表 */}
        <div className="flex min-h-0 flex-col overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-900/50 p-2">
          <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase text-slate-500">绘图会话</p>
          {sessions.length === 0 && <p className="px-1 text-[11px] text-slate-600">暂无会话, 点右上新建</p>}
          {sessions.map((s) => (
            <button key={s.id} onClick={() => loadSession(s.id)}
              className={cn("mb-1 rounded-lg px-2 py-1.5 text-left", curSession === s.id ? "bg-pink-600/20 text-pink-200" : "hover:bg-slate-800 text-slate-300")}>
              <p className="flex items-center gap-1 truncate text-[11px] font-medium">
                {s.title || "未命名"}
                {/* W10(闭源 viz 任务视图): 失败徽标 */}
                {s.status === "failed" && <span className="shrink-0 rounded-full bg-rose-500/20 px-1.5 py-px text-[8px] font-semibold text-rose-300">失败</span>}
              </p>
              <p className="text-[9px] text-slate-500">{s.artifact_count} 图 · {new Date(s.updated_at ?? s.created_at).toLocaleDateString()}</p>
              {s.status === "failed" && (
                <p className="mt-0.5 text-[8px] leading-snug text-rose-300/70">模型未完成出图 — 打开后点"重新生成"从此任务重试</p>
              )}
            </button>
          ))}
        </div>

        {/* 对话主区 */}
        <div className="flex min-h-0 flex-col rounded-xl border border-slate-700/60 bg-slate-900/50">
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {!curSession && <div className="mt-16 text-center text-slate-600"><Sparkles className="mx-auto h-8 w-8" /><p className="mt-2 text-xs">用自然语言描述图表, Agent 自动完成数据计算→出图→自审修订</p><p className="mt-1 text-[10px]">例: "画个折线图对比 2019-2023 的 GDP 增长趋势"</p></div>}
            {messages.map((m) => {
              const c = m.content as Record<string, unknown>;
              const isUser = m.role === "user";
              if (isUser) {
                return (
                  <div key={m.id} className="flex justify-end">
                    <div className="max-w-[80%] rounded-xl rounded-tr-sm bg-cyan-600/30 px-3 py-1.5 text-xs text-cyan-50">{msgText(m)}</div>
                  </div>
                );
              }
              if (m.role === "chart" && (c.artifact as { pngRel?: string })) {
                const a = c.artifact as { pngRel: string };
                return (
                  <div key={m.id} className="rounded-lg border border-slate-700/50 bg-slate-800/50 p-2">
                    <p className="mb-1 flex items-center gap-1 text-[10px] text-slate-400"><ImageIcon className="h-3 w-3 text-pink-400" /> 产物 v{(c as { version?: unknown }).version as number} {c.title ? `· ${String(c.title).slice(0, 30)}` : ""}</p>
                    <ArtImg path={a.pngRel} className="max-h-64 max-w-full rounded border border-slate-700/40 bg-white/5" alt="chart" />
                  </div>
                );
              }
              if (m.role === "tool" || m.role === "plan" || m.role === "thinking" || m.role === "critique" || m.role === "critique_fix") {
                return (
                  <div key={m.id} className="flex items-start gap-1.5 rounded-lg bg-slate-800/40 px-2 py-1 text-[10px] text-slate-400">
                    {m.role === "tool" ? <Wand2 className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" /> : m.role === "critique" ? <Bug className="mt-0.5 h-3 w-3 shrink-0 text-rose-400" /> : <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-slate-500" />}
                    <span className="shrink-0 font-semibold">{liveLabel(m.role)}</span>
                    <span className="truncate">{msgText(m).slice(0, 200)}</span>
                  </div>
                );
              }
              // D5(闭源 viz markdown 渲染 + 失败可见性): done.error / assistant 文本消息走 MarkdownRich
              if (m.role === "done") {
                const errMsg = (c as { error?: string }).error;
                if (!errMsg) return null;
                return (
                  <div key={m.id} className="flex justify-start">
                    <div className="max-w-[85%] rounded-xl rounded-tl-sm border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-200">
                      <MarkdownRich content={`⚠️ ${errMsg}`} />
                    </div>
                  </div>
                );
              }
              if (m.role === "assistant" || m.role === "text" || m.role === "agent") {
                const txt = msgText(m);
                if (!txt) return null;
                return (
                  <div key={m.id} className="flex justify-start">
                    <div className="max-w-[85%] rounded-xl rounded-tl-sm bg-slate-800/80 px-3 py-2 text-xs leading-relaxed text-slate-200">
                      <MarkdownRich content={txt} />
                    </div>
                  </div>
                );
              }
              return null;
            })}
            {/* 实时事件流 */}
            {live.map((l, i) => (
              <div key={`live-${i}`} className="flex items-center gap-1.5 rounded-lg bg-slate-800/40 px-2 py-1 text-[10px] text-slate-400">
                {l.kind === "tool" || l.kind === "critique" ? <Loader2 className="h-3 w-3 animate-spin text-amber-400" /> : <ChevronDown className="h-3 w-3 text-slate-500" />}
                <span className="shrink-0 font-semibold">{liveLabel(l.kind)}</span>
                <span className="truncate">{l.text}</span>
              </div>
            ))}
            {busy && <div className="flex items-center gap-1.5 text-[10px] text-slate-500"><Loader2 className="h-3 w-3 animate-spin" /> Agent 执行中...</div>}
            <div ref={endRef} />
          </div>
          {/* 输入区 */}
          <div className="border-t border-slate-700/50 p-2">
            {/* T4-6: 图表类型九宫格(闭源 VizView chartType 对齐): 点击填提示词 */}
            <div className="mb-1.5 flex flex-wrap items-center gap-1">
              <span className="text-[9px] text-slate-500">图表类型</span>
              {CHART_TYPE_PROMPTS.map((c) => (
                <button key={c.k} onClick={() => setInput(c.tpl)}
                  className={cn("rounded-full border px-2 py-0.5 text-[9px] transition", input === c.tpl ? "border-pink-500/60 bg-pink-600/20 text-pink-200" : "border-slate-600/60 bg-slate-800 text-slate-400 hover:border-slate-500 hover:text-slate-200")}>
                  {c.label}
                </button>
              ))}
            </div>
            {/* T4-5: 期刊规范预设(闭源 VizView journal spec 对齐) */}
            <div className="mb-1.5 flex flex-wrap items-center gap-1">
              <span className="text-[9px] text-slate-500">期刊规范</span>
              {Object.entries(SPEC_PRESETS).map(([k, p]) => (
                <button key={k} onClick={() => setSpecPreset(k)}
                  className={cn("rounded-full border px-2 py-0.5 text-[9px]", specPreset === k ? "border-pink-500/60 bg-pink-600/20 text-pink-200" : "border-slate-600/60 bg-slate-800 text-slate-400 hover:text-slate-200")}>
                  {p.label}
                </button>
              ))}
            </div>
            {csvName && (
              <div className="mb-1.5 flex items-center justify-between rounded bg-slate-800 px-2 py-1 text-[10px] text-slate-400">
                <span className="flex items-center gap-1"><Upload className="h-2.5 w-2.5 text-cyan-400" /> {csvName} (真实计算用)</span>
                <button onClick={() => { csvRef.current = null; setCsvName(""); }} className="text-slate-500 hover:text-red-400">移除</button>
              </div>
            )}
            <div className="flex items-end gap-1.5">
              <label className="cursor-pointer rounded-lg bg-slate-800 p-2 text-slate-400 hover:bg-slate-700" title="上传数据(CSV)">
                <Upload className="h-4 w-4" />
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onCsv(f); }} />
              </label>
              <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
                rows={2} placeholder="描述你要画的图…(Enter 发送)"
                className="min-h-0 flex-1 resize-none rounded-lg border border-slate-600/60 bg-slate-800 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500" />
              <button onClick={send} disabled={busy || !input.trim() || !curSession}
                className="rounded-lg bg-pink-600 p-2 text-white hover:bg-pink-500 disabled:opacity-40">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* 版本时间线 */}
        <div className="flex min-h-0 flex-col overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-900/50 p-2">
          <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase text-slate-500">版本时间线 ({artifacts.length})</p>
          {artifacts.length === 0 && <p className="px-1 text-[11px] text-slate-600">产物将出现在这里</p>}
          {artifacts.map((a) => (
            <div key={a.id} className={cn("mb-2 rounded-lg border p-2", a.version === (latest?.version ?? -1) ? "border-pink-500/40 bg-pink-500/5" : "border-slate-700/50 bg-slate-800/40")}>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 text-[11px] font-medium text-slate-200">
                  {a.version === (latest?.version ?? -1) ? <CheckCircle2 className="h-3 w-3 text-pink-400" /> : <ImageIcon className="h-3 w-3 text-slate-500" />}
                  v{a.version}
                </span>
                <span className="flex gap-0.5">
                  <a href={artUrl(a.png_path)} download title="下载 PNG" className="rounded p-0.5 text-slate-400 hover:text-white"><Download className="h-3 w-3" /></a>
                  <button onClick={() => toMaterials(a)} title="导入素材库" className="rounded p-0.5 text-slate-400 hover:text-cyan-300"><Send className="h-3 w-3" /></button>
                </span>
              </div>
              {latest && a.version === latest.version && (
                <ArtImg path={a.png_path} className="mt-1 max-h-36 w-full rounded border border-slate-700/50 object-contain" alt="" />
              )}
              <p className="mt-1 line-clamp-2 text-[9px] text-slate-500">{a.prompt?.slice(0, 80) || "—"}</p>
              {a.critique?.improve && <p className="mt-0.5 line-clamp-1 text-[9px] text-rose-300/60" title={a.critique.improve}>自审: {a.critique.improve.slice(0, 60)}</p>}
              <a href={artUrl(a.svg_editable_path)} target="_blank" rel="noreferrer" className="mt-0.5 inline-block text-[9px] text-cyan-400 hover:underline">SVG 可编辑版 ↗</a>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
