// EducationPanel.tsx — AI+教育 六大能力面板（V382）
// 个性化学习规划 / 专业课课程辅导 / 学情诊断 / 预习与复习 / 教师备课 / 学习陪伴
// V383: 固定 Obsidian 资料库侧栏（目录树 + md/PDF/图片内联预览 + Office 下载）
import { useState, useEffect, useRef, type FC } from "react";
import { Loader2, Play, GraduationCap, BookOpen, Stethoscope, CalendarClock, ClipboardList, HeartHandshake, ChevronDown, ChevronRight, File, FileText, FileImage, Download, X } from "lucide-react";
import { cn } from "../lib/utils";

const API_BASE = "/api/education";

interface VaultTreeNode {
  name: string;
  type: "dir" | "file";
  path: string;
  children?: VaultTreeNode[];
}

const PREVIEWABLE_EXT = new Set([".md", ".markdown", ".txt", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);

function vaultFileIcon(name: string) {
  const ext = name.toLowerCase().split(".").pop() || "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return <FileImage className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  if (["pdf"].includes(ext)) return <FileText className="h-3.5 w-3.5 shrink-0 text-red-400" />;
  return <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

function isPreviewable(name: string) {
  const ext = "." + (name.toLowerCase().split(".").pop() || "");
  return PREVIEWABLE_EXT.has(ext);
}

/** 轻量 Markdown 渲染（标题/粗体/列表/代码块） */
function MarkdownPreview({ content }: { content: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = content.split("\n");
  let codeBlock: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (codeBlock) {
      if (line.trim().startsWith("```")) { blocks.push(<pre key={i} className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">{codeBlock.join("\n")}</pre>); codeBlock = null; }
      else codeBlock.push(line);
      continue;
    }
    if (line.trim().startsWith("```")) { codeBlock = []; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { blocks.push(<div key={i} className={cn("mt-2 break-words font-semibold", h[1].length <= 2 ? "text-base" : "text-sm")}>{h[2]}</div>); continue; }
    if (line.startsWith("- ")) { blocks.push(<div key={i} className="break-words text-[11px] text-muted-foreground">• {line.slice(2)}</div>); continue; }
    if (line.trim()) blocks.push(<div key={i} className="break-words text-[11px] leading-5 text-muted-foreground">{line}</div>);
  }
  // V383: w-full 填满窗格（修复正文区域最大宽度限制导致的右侧留白）
  return <div className="w-full space-y-0.5">{blocks}</div>;
}

function VaultTreeItem({ node, depth, selectedPath, onSelect }: {
  node: VaultTreeNode; depth: number; selectedPath: string; onSelect: (path: string, name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false); // V383: 文件夹全部默认折叠，点击展开
  const isDir = node.type === "dir";
  const isSelected = node.path === selectedPath;
  return (
    <div>
      <button
        type="button"
        className={cn("flex w-full items-center gap-1 rounded px-2 py-1 text-left text-[11px] hover:bg-accent", isSelected && "bg-accent text-foreground")}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        onClick={() => { if (isDir) setExpanded((c) => !c); else onSelect(node.path, node.name); }}
      >
        {isDir ? (expanded ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />) : vaultFileIcon(node.name)}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir && expanded && node.children?.map((child) => (
        <VaultTreeItem key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
      ))}
    </div>
  );
}

/** V383: Obsidian 资料库侧栏（目录树 + 内嵌预览，预览占满侧栏剩余宽度） */
function ObsidianVaultSidebar({ onCollapse }: { onCollapse?: () => void }) {
  const [tree, setTree] = useState<VaultTreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState("");
  const [file, setFile] = useState<{ content: string } | null>(null);
  const [binaryUrl, setBinaryUrl] = useState<string | null>(null);
  const [isOffice, setIsOffice] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/vault/tree");
        const d = await r.json();
        setTree(d.nodes || []);
      } catch { /* 忽略 */ }
      setLoading(false);
    })();
  }, []);

  const selectFile = async (filePath: string, fileName: string) => {
    setSelectedPath(filePath);
    setSelectedName(fileName);
    setFile(null);
    setBinaryUrl(null);
    setIsOffice(false);
    try {
      if (isPreviewable(fileName)) {
        if (fileName.toLowerCase().endsWith(".md") || fileName.toLowerCase().endsWith(".markdown") || fileName.toLowerCase().endsWith(".txt")) {
          const r = await fetch(`/api/vault/file?path=${encodeURIComponent(filePath)}`);
          const d = await r.json();
          setFile(d.file);
        } else {
          // PDF 加 #view=FitH 适配水平宽度
          const isPdf = fileName.toLowerCase().endsWith(".pdf");
          const base = `/api/vault/binary?path=${encodeURIComponent(filePath)}`;
          setBinaryUrl(isPdf ? `${base}#view=FitH` : base);
        }
      } else {
        setIsOffice(true);
      }
    } catch { /* 忽略 */ }
  };

  const closePreview = () => {
    setSelectedPath(null);
    setSelectedName("");
    setFile(null);
    setBinaryUrl(null);
    setIsOffice(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5 text-[10px] font-semibold text-sky-700">
        <BookOpen className="h-3 w-3" /> Obsidian 资料库
        {onCollapse && (
          <button onClick={onCollapse} className="ml-auto rounded px-1 text-[10px] text-muted-foreground hover:bg-accent" title="折叠资料库">
            »
          </button>
        )}
      </div>
      {/* 目录树（可滚动，约 40% 高） */}
      <div className="max-h-[35%] min-h-[100px] overflow-y-auto border-b p-1">
        {loading ? <div className="p-2 text-[10px] text-muted-foreground">加载中…</div>
          : tree.length === 0 ? <div className="p-2 text-[10px] text-muted-foreground">无资料</div>
          : tree.map((node) => (
            <VaultTreeItem key={node.path} node={node} depth={0} selectedPath={selectedPath ?? ""} onSelect={(p, n) => void selectFile(p, n)} />
          ))}
      </div>
      {/* 预览区（占满剩余高度，宽满） */}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {selectedPath ? (
          <>
            <div className="mb-1 flex items-center gap-1 text-[10px] font-medium">
              {vaultFileIcon(selectedName)}
              <span className="truncate">{selectedName}</span>
              <a
                href={`/api/vault/binary?path=${encodeURIComponent(selectedPath)}&download=1`}
                className="ml-auto flex shrink-0 items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-accent"
                title="下载"
              >
                <Download className="h-2.5 w-2.5" /> 下载
              </a>
              <button
                onClick={closePreview}
                className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-accent"
                title="关闭预览"
              >
                <X className="h-2.5 w-2.5" /> 关闭
              </button>
            </div>
            {file ? <MarkdownPreview content={file.content} />
              : binaryUrl ? <iframe src={binaryUrl} title={selectedName} className="w-full rounded border border-border bg-white" style={{ height: "calc(100% - 28px)" }} />
              : isOffice ? <div className="p-2 text-[10px] text-muted-foreground">Office 文档：点击上方「下载」打开</div>
              : null}
          </>
        ) : (
          <div className="p-2 text-[10px] text-muted-foreground">← 选择左侧文件查看内容</div>
        )}
      </div>
    </div>
  );
}

interface ToolDef {
  id: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
  fields: Array<{ key: string; label: string; placeholder: string; type?: "text" | "textarea" | "select"; options?: string[] }>;
  resultKey: string;
  /** V383: Demo 演示数据（一键填入并运行） */
  demo?: Record<string, string>;
  /** V393: 进入工具自动加载默认模式（数据类功能直接呈现） */
  autoLoad?: boolean;
  render: (r: any) => React.ReactNode;
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

// 通用 JSON 渲染（数组/对象/文本递归展示，带深度与循环保护防崩溃）
function renderJson(data: unknown, depth = 0, seen = new Set<unknown>()): React.ReactNode {
  if (depth > 10) return <span className="text-[11px] text-muted-foreground">…（层级过深已截断）</span>;
  if (data === null || data === undefined) return null;
  if (typeof data === "string") return <span className="text-[11px] leading-5 text-muted-foreground">{data}</span>;
  if (typeof data === "number" || typeof data === "boolean") return <span className="text-[11px] text-muted-foreground">{String(data)}</span>;
  if (typeof data === "object") {
    // 循环引用防护
    if (seen.has(data)) return <span className="text-[11px] text-muted-foreground">（循环引用）</span>;
    seen.add(data);
  }
  if (Array.isArray(data)) {
    return (
      <div className="space-y-1">
        {data.map((item, i) => (
          <div key={i} className="rounded border-l-2 border-primary/30 pl-2">
            {item !== null && typeof item === "object" ? renderJson(item, depth + 1, seen) : <span className="text-[11px] text-muted-foreground">• {item === null ? "—" : String(item)}</span>}
          </div>
        ))}
      </div>
    );
  }
  if (typeof data === "object") {
    try {
      return (
        <div className="space-y-2">
          {Object.entries(data as Record<string, unknown>).map(([k, v]) => (
            <div key={k}>
              <div className="text-[11px] font-semibold text-foreground/80">{k}</div>
              <div className="pl-2">{renderJson(v, depth + 1, seen)}</div>
            </div>
          ))}
        </div>
      );
    } catch {
      return <span className="text-[11px] text-muted-foreground">（渲染异常）</span>;
    }
  }
  return null;
}

// ═══════ V390: 专业结果渲染器 — 按数据类型输出产品级 UI ═══════

/** 阶段卡片（学习计划/教案的 stages/classFlow） */
function StageCards({ title, stages }: { title: string; stages: any[] }) {
  if (!Array.isArray(stages) || stages.length === 0) return null;
  return (
    <div>
      <div className="mb-2 text-xs font-semibold text-foreground/90">📋 {title}</div>
      <div className="space-y-2">
        {stages.map((s, i) => (
          <div key={i} className="rounded-lg border border-border bg-card p-2.5">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">{i + 1}</span>
              <span className="text-xs font-medium">{s.phase || s.segment || s.title || `阶段 ${i + 1}`}</span>
              {(s.duration || s.durationMs) && <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">⏱ {s.duration ?? `${Math.round(s.durationMs / 1000)}s`}</span>}
            </div>
            {s.objectives && (
              <div className="mt-1.5 space-y-0.5">
                {s.objectives.map((o: string, j: number) => <div key={j} className="pl-7 text-[11px] text-muted-foreground">▸ {o}</div>)}
              </div>
            )}
            {s.teacherAction && <div className="mt-1 pl-7 text-[11px] text-muted-foreground"><span className="text-foreground/70">师:</span> {s.teacherAction}</div>}
            {s.studentAction && <div className="pl-7 text-[11px] text-muted-foreground"><span className="text-foreground/70">生:</span> {s.studentAction}</div>}
            {s.activity && <div className="mt-1 pl-7 text-[11px] text-muted-foreground">活动: {s.activity}</div>}
            {s.tasks && (
              <div className="mt-1.5 space-y-0.5 border-t border-border/50 pt-1.5">
                {s.tasks.map((t: any, j: number) => (
                  <div key={j} className="flex items-center gap-1.5 pl-7 text-[11px]">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                    <span className="text-muted-foreground">{t.activity}</span>
                    {t.hours != null && <span className="ml-auto text-[9px] text-muted-foreground/70">{t.hours}h</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 统计卡（学情画像/风险/行为分析的 summary/stats） */
function StatCards({ items }: { items: Array<{ label: string; value: string | number; color?: string }> }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((it, i) => (
        <div key={i} className="rounded-lg border border-border bg-card p-2.5 text-center">
          <div className="text-lg font-bold" style={{ color: it.color || "var(--primary)" }}>{it.value}</div>
          <div className="text-[10px] text-muted-foreground">{it.label}</div>
        </div>
      ))}
    </div>
  );
}

// ═══════ V391: 图表化/多模块/标签页 丰富组件 ═══════

/** 环形图（掌握度分布等比例数据）— 纯 SVG 无依赖 */
function DonutChart({ data, centerLabel, centerValue }: { data: Array<{ label: string; value: number; color: string }>; centerLabel?: string; centerValue?: string | number }) {
  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
  if (total <= 0) return null;
  const R = 42, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="flex items-center gap-4">
      <svg width="110" height="110" viewBox="0 0 110 110" className="shrink-0">
        <circle cx="55" cy="55" r={R} fill="none" stroke="var(--muted)" strokeWidth="14" />
        {data.map((d, i) => {
          const frac = Math.max(0, d.value) / total;
          const dash = frac * C;
          const el = (
            <circle key={i} cx="55" cy="55" r={R} fill="none"
              stroke={d.color} strokeWidth="14" strokeDasharray={`${dash} ${C - dash}`}
              strokeDashoffset={-offset} transform="rotate(-90 55 55)" strokeLinecap="butt" />
          );
          offset += dash;
          return el;
        })}
        <text x="55" y="52" textAnchor="middle" className="fill-foreground" fontSize="16" fontWeight="bold">{centerValue ?? total}</text>
        <text x="55" y="68" textAnchor="middle" fontSize="9" fill="var(--muted-foreground)">{centerLabel ?? "总数"}</text>
      </svg>
      <div className="space-y-1">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[10px]">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: d.color }} />
            <span className="text-muted-foreground">{d.label}</span>
            <span className="ml-auto font-medium">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 时间线（答题历史/进度记录） */
function Timeline({ items }: { items: Array<{ time?: string; title: string; detail?: string; color?: string }> }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div className="relative space-y-3 pl-4">
      <div className="absolute bottom-1 left-[5px] top-1 w-px bg-border" />
      {items.map((it, i) => (
        <div key={i} className="relative">
          <span className={`absolute -left-4 top-1 h-2.5 w-2.5 rounded-full border-2 border-background ${it.color || "bg-primary"}`} />
          <div className="rounded-lg border border-border bg-card p-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium">{it.title}</span>
              {it.time && <span className="ml-auto text-[9px] text-muted-foreground">{it.time}</span>}
            </div>
            {it.detail && <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{it.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 掌握度分组进度条（按知识点） */
function MasteryBars({ points }: { points: Array<{ knowledge_point?: string; point?: string; score?: number | string; mastery_level?: string }> }) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const colors: Record<string, string> = { mastered: "#188038", fuzzy: "#e8710a", unlearned: "#c5221f" };
  return (
    <div className="space-y-2">
      {points.map((p, i) => {
        const score = typeof p.score === "number" ? p.score : parseFloat(String(p.score ?? 0));
        const level = p.mastery_level || (score >= 0.7 ? "mastered" : score >= 0.4 ? "fuzzy" : "unlearned");
        const label = { mastered: "已掌握", fuzzy: "模糊", unlearned: "未掌握" }[level] || level;
        return (
          <div key={i} className="rounded-lg border border-border bg-card p-2">
            <div className="mb-1 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{p.knowledge_point || p.point}</span>
              <span className="rounded px-1.5 py-0.5 text-[9px] text-white" style={{ backgroundColor: colors[level] || "#888" }}>{label}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${Math.round(score * 100)}%`, backgroundColor: colors[level] || "#888" }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 行为分析面板（节奏/速度/畏难点/错误类型） */
function BehaviorPanel({ behavior }: { behavior: any }) {
  if (!behavior) return null;
  const { pace, speed, fearPoints, topErrorTypes } = behavior;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="rounded-lg border border-border bg-card p-2.5">
        <div className="mb-1.5 text-[11px] font-semibold text-foreground/80">⏱ 学习节奏</div>
        <div className="grid grid-cols-3 gap-1 text-center">
          <div><div className="text-sm font-bold text-primary">{pace?.days ?? 0}</div><div className="text-[9px] text-muted-foreground">天数</div></div>
          <div><div className="text-sm font-bold text-primary">{pace?.total_minutes ?? 0}</div><div className="text-[9px] text-muted-foreground">总分钟</div></div>
          <div><div className="text-sm font-bold text-primary">{pace?.avg_minutes ?? 0}</div><div className="text-[9px] text-muted-foreground">日均</div></div>
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card p-2.5">
        <div className="mb-1.5 text-[11px] font-semibold text-foreground/80">📝 做题表现</div>
        <div className="grid grid-cols-3 gap-1 text-center">
          <div><div className="text-sm font-bold" style={{ color: "var(--primary)" }}>{speed?.total_answers ?? 0}</div><div className="text-[9px] text-muted-foreground">总题数</div></div>
          <div><div className="text-sm font-bold text-emerald-600">{speed?.correct ?? 0}</div><div className="text-[9px] text-muted-foreground">答对</div></div>
          <div><div className="text-sm font-bold" style={{ color: "var(--primary)" }}>{Math.round((speed?.accuracy ?? 0) * 100)}%</div><div className="text-[9px] text-muted-foreground">正确率</div></div>
        </div>
      </div>
      {fearPoints?.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50/40 p-2.5">
          <div className="mb-1.5 text-[11px] font-semibold text-red-700">😰 畏难点</div>
          <div className="space-y-1">
            {fearPoints.map((f: any, i: number) => (
              <div key={i} className="flex items-center gap-1.5 text-[10px]">
                <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                <span className="text-muted-foreground">{f.knowledge_point}</span>
                <span className="ml-auto text-red-600">{f.attempts} 次未掌握</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {topErrorTypes?.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-2.5">
          <div className="mb-1.5 text-[11px] font-semibold text-amber-700">⚠️ 高频错误</div>
          <div className="flex flex-wrap gap-1.5">
            {topErrorTypes.map((e: any, i: number) => (
              <span key={i} className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-600">{e.mistake_type} ×{e.n}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 标签页容器（复杂结果分区展示） */
function Tabs({ tabs }: { tabs: Array<{ id: string; label: string; content: React.ReactNode }> }) {
  const [active, setActive] = useState(tabs[0]?.id);
  if (!tabs.length) return null;
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1 border-b border-border pb-1.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${active === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div>{tabs.find((t) => t.id === active)?.content}</div>
    </div>
  );
}

/** 进度条（掌握度/进度） */
function ProgressBar({ label, value, color }: { label: string; value: number; color?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 truncate text-[10px] text-muted-foreground">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color || "var(--primary)" }} />
      </div>
      <span className="w-8 shrink-0 text-right text-[10px] font-medium">{pct}%</span>
    </div>
  );
}

/** 标签（薄弱点/易错点/收获/改进） */
function TagList({ title, items, color = "bg-muted text-foreground/80" }: { title?: string; items: any[]; color?: string }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div>
      {title && <div className="mb-1.5 text-xs font-semibold text-foreground/90">{title}</div>}
      <div className="flex flex-wrap gap-1.5">
        {items.map((it, i) => (
          <span key={i} className={`rounded-full px-2 py-0.5 text-[10px] ${color}`}>{typeof it === "string" ? it : (it.point || it.name || it.title || JSON.stringify(it).slice(0, 20))}</span>
        ))}
      </div>
    </div>
  );
}

/** 版本卡片（分层教学 versions） */
function VersionCards({ versions }: { versions: any[] }) {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const levelColors: Record<string, string> = { basic: "bg-emerald-100 text-emerald-700", advanced: "bg-sky-100 text-sky-700", challenge: "bg-violet-100 text-violet-700" };
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {versions.map((v, i) => (
        <div key={i} className="rounded-lg border border-border bg-card p-2.5">
          <span className={`rounded-full px-2 py-0.5 text-[9px] font-medium ${levelColors[v.level] || "bg-muted"}`}>{v.level || "版本"}</span>
          <div className="mt-1.5 text-xs font-semibold">{v.title}</div>
          <div className="mt-1 text-[11px] leading-4 text-muted-foreground">{(v.explanation || "").slice(0, 80)}…</div>
          {v.suitableFor && <div className="mt-1.5 text-[10px] text-foreground/60">适合: {v.suitableFor}</div>}
        </div>
      ))}
    </div>
  );
}

/** 变式题/自测题卡 */
function QuestionCards({ title, questions }: { title: string; questions: any[] }) {
  if (!Array.isArray(questions) || questions.length === 0) return null;
  return (
    <div>
      <div className="mb-2 text-xs font-semibold text-foreground/90">{title}</div>
      <div className="space-y-2">
        {questions.map((q, i) => (
          <div key={i} className="rounded-lg border border-border bg-card p-2.5">
            <div className="flex items-start gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-100 text-[10px] font-bold text-sky-700">{i + 1}</span>
              <div className="min-w-0">
                <div className="text-[11px] leading-4">{q.question || q.variant_question || q.selfCheck || ""}</div>
                {(q.answer || q.variant_answer) && <div className="mt-1 text-[10px] text-muted-foreground">答: {(q.answer || q.variant_answer).slice(0, 60)}</div>}
                {(q.thinkingPoint || q.difficulty) && <div className="mt-0.5 text-[9px] text-muted-foreground/70">{(q.thinkingPoint || q.difficulty)}</div>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 风险/预警卡 */
function RiskCard({ level, signals }: { level: string; signals: any[] }) {
  if (!level || !Array.isArray(signals)) return null;
  const colorMap: Record<string, string> = { high: "bg-red-600", medium: "bg-amber-500", low: "bg-emerald-500", ok: "bg-sky-500" };
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold text-white ${colorMap[level] || "bg-muted"}`}>
          {level === "high" ? "高风险" : level === "medium" ? "中风险" : level === "low" ? "低风险" : "正常"}
        </span>
        <span className="text-[11px] font-medium">学习风险预警</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {signals.map((s, i) => (
          <div key={i} className="flex items-start gap-1.5 text-[11px]">
            <span className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${s.level === "high" ? "bg-red-400" : s.level === "medium" ? "bg-amber-400" : "bg-sky-400"}`} />
            <div>
              <span className="font-medium text-foreground/80">{s.signal}</span>
              <span className="text-muted-foreground"> — {s.intervention}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** V390: 智能结果渲染 — 识别常见结构输出专业 UI，兜底用 renderJson */
function renderResult(r: any): React.ReactNode {
  if (!r) return null;
  if (r.error) return <div className="rounded bg-red-50 p-2 text-xs text-red-700">{r.error}</div>;

  // 学情画像 summary（E7 profile）— V391: 环形图 + 掌握度条 + 统计卡
  if (r.summary && typeof r.summary === "object" && "total" in r.summary) {
    const s = r.summary;
    return (
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="mb-2 text-xs font-semibold text-foreground/90">掌握度分布</div>
            <DonutChart
              centerValue={s.total ?? 0}
              centerLabel="知识点"
              data={[
                { label: "已掌握", value: s.mastered ?? 0, color: "#188038" },
                { label: "模糊", value: s.fuzzy ?? 0, color: "#e8710a" },
                { label: "未掌握", value: s.unlearned ?? 0, color: "#c5221f" },
              ]}
            />
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="mb-2 text-xs font-semibold text-foreground/90">各知识点掌握度</div>
            <MasteryBars points={[...(r.weakPoints || []), ...(r.masteredPoints || [])].slice(0, 8)} />
          </div>
        </div>
        {r.weakPoints?.length > 0 && <TagList title="🔴 待攻克" items={r.weakPoints} color="bg-red-50 text-red-700" />}
        {r.masteredPoints?.length > 0 && <TagList title="🟢 已掌握" items={r.masteredPoints} color="bg-emerald-50 text-emerald-700" />}
        {r.recentAnswers?.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-semibold text-foreground/90">最近作答</div>
            <Timeline items={r.recentAnswers.slice(0, 5).map((a: any) => ({
              time: (a.answered_at || "").slice(11, 16),
              title: a.knowledge_point,
              detail: a.is_correct ? "✓ 回答正确" : "✗ 回答错误",
              color: a.is_correct ? "bg-emerald-500" : "bg-red-500",
            }))} />
          </div>
        )}
      </div>
    );
  }

  // 行为分析（E3 behavior）— V391: BehaviorPanel 四格面板
  if (r.behavior) {
    return (
      <div className="space-y-3">
        <div className="text-xs font-semibold text-foreground/90">📊 学习行为分析</div>
        <BehaviorPanel behavior={r.behavior} />
      </div>
    );
  }

  // 诊断报告（E3 report）— V391: 标签页分区
  if (r.report) {
    const rep = r.report;
    return (
      <div className="space-y-3">
        {rep.overall && <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-3 text-[11px] leading-5 text-sky-900">{rep.overall}</div>}
        <Tabs tabs={[
          { id: "gaps", label: "漏洞", content: <div className="space-y-1.5">{rep.gapSummary?.map((g: any, i: number) => (
            <div key={i} className="rounded-lg border border-border bg-card p-2 text-[11px]">
              <span className="font-medium">{g.type}</span> — {g.points}
              <div className="mt-0.5 text-[10px] text-muted-foreground">💡 {g.suggestion}</div>
            </div>))}</div> },
          { id: "behavior", label: "行为洞察", content: <div className="space-y-1.5">{rep.behaviorInsights?.map((b: any, i: number) => (
            <div key={i} className="rounded-lg border border-border bg-card p-2 text-[11px]">
              <span className="font-medium">{b.aspect}</span>: {b.finding}
              <div className="mt-0.5 text-[10px] text-muted-foreground">影响: {b.implication}</div>
            </div>))}</div> },
          { id: "action", label: "行动计划", content: <div className="space-y-1.5">{rep.actionPlan?.map((a: any, i: number) => (
            <div key={i} className={`rounded-lg border p-2 text-[11px] ${a.priority === "高" ? "border-red-200 bg-red-50/50 text-red-800" : a.priority === "中" ? "border-amber-200 bg-amber-50/50 text-amber-800" : "border-emerald-200 bg-emerald-50/50 text-emerald-800"}`}>
              <span className="font-medium">[{a.priority}]</span> {a.action}
              <div className="mt-0.5 text-[10px] opacity-70">→ {a.expectedOutcome}</div>
            </div>))}</div> },
        ]} />
        {rep.attention && <div className="rounded-lg bg-red-50 p-2.5 text-[11px] text-red-700">⚠️ 最需关注: {rep.attention}</div>}
      </div>
    );
  }

  // 风险预警（E3 risk）
  if (r.riskLevel && r.signals) {
    return (
      <div className="space-y-3">
        <RiskCard level={r.riskLevel} signals={r.signals} />
        {r.summary && <div className="text-[11px] text-muted-foreground">{r.summary}</div>}
      </div>
    );
  }

  // 分层教学 versions（E7 layered）
  if (r.versions?.length > 0) {
    return (
      <div className="space-y-3">
        <VersionCards versions={r.versions} />
        {r.recommendation && <div className="rounded-lg bg-emerald-50 p-2.5 text-[11px] text-emerald-800">💡 {r.recommendation}</div>}
      </div>
    );
  }

  // 学习计划 stages（E1）
  if (r.plan?.stages) {
    return (
      <div className="space-y-3">
        <StageCards title={r.plan?.totalWeeks ? `分阶段学习计划（共 ${r.plan.totalWeeks} 周）` : "分阶段学习计划"} stages={r.plan.stages} />
        {r.plan?.adaptation && <div className="rounded-lg bg-sky-50 p-2.5 text-[11px] text-sky-800">🔄 {r.plan.adaptation}</div>}
        {r.linked && <div className="text-[10px] text-emerald-600">✅ 已关联知识库文献（{r.plan?.knowledgeGap || ""}）</div>}
      </div>
    );
  }

  // 教案 classFlow（E5 lesson）
  if (r.lesson?.classFlow) {
    return (
      <div className="space-y-3">
        <div className="text-sm font-semibold">{r.lesson.lessonTitle}</div>
        {r.lesson.objectives?.length > 0 && <TagList title="教学目标" items={r.lesson.objectives} color="bg-sky-50 text-sky-700" />}
        <StageCards title="课堂流程" stages={r.lesson.classFlow} />
        {r.lesson.pptOutline?.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-semibold">📊 PPT 大纲（{r.lesson.pptOutline.length} 页）</div>
            <div className="flex flex-wrap gap-1.5">
              {r.lesson.pptOutline.map((p: any, i: number) => (
                <span key={i} className="rounded border border-border bg-card px-2 py-1 text-[10px]">{p.title || `第${p.slide}页`}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // 试卷 exam（E5 exam）
  if (r.exam?.sections) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{r.exam.examTitle}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">难度: {r.exam.difficulty}</span>
        </div>
        {r.exam.sections.map((sec: any, si: number) => (
          <div key={si} className="rounded-lg border border-border bg-card p-2.5">
            <div className="mb-1.5 text-[11px] font-semibold text-foreground/80">{sec.type}（{sec.count} 题）</div>
            <div className="space-y-1">
              {sec.questions?.map((q: any, qi: number) => (
                <div key={qi} className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-muted-foreground/60">{q.num}.</span>
                  <span className="min-w-0 flex-1 truncate">{q.question}</span>
                  <span className={`shrink-0 rounded px-1 text-[9px] ${q.difficulty === "hard" ? "bg-red-50 text-red-600" : q.difficulty === "easy" ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"}`}>{q.difficulty}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {r.exam.answers?.length > 0 && <div className="rounded-lg bg-emerald-50 p-2.5 text-[10px] text-emerald-800">✅ 含 {r.exam.answers.length} 条参考答案</div>}
      </div>
    );
  }

  // 变式题（E8 variant）
  if (r.variants?.length > 0) {
    return (
      <div className="space-y-3">
        <div className="text-xs font-semibold">🔁 同类变式题（{r.variants.length} 道巩固）</div>
        <QuestionCards title="" questions={r.variants} />
      </div>
    );
  }

  // 班级汇总（E5 class-summary）
  if (r.commonGaps?.length > 0) {
    return (
      <div className="space-y-3">
        {r.summary?.classProfile && <div className="rounded-lg bg-sky-50 p-2.5 text-[11px] text-sky-800">📊 {r.summary.classProfile}</div>}
        {r.summary?.commonBlindSpots?.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-semibold">🎯 班级共性盲区</div>
            <div className="space-y-1.5">
              {r.summary.commonBlindSpots.map((b: any, i: number) => (
                <div key={i} className="rounded-lg border border-border bg-card p-2 text-[11px]">
                  <span className="font-medium">{b.point}</span>
                  <div className="text-[10px] text-muted-foreground">{b.likelyCause}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {r.summary?.teachingFocus?.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-semibold">📚 授课调整建议</div>
            <div className="space-y-1.5">
              {r.summary.teachingFocus.map((t: any, i: number) => (
                <div key={i} className="rounded-lg bg-amber-50 p-2 text-[11px] text-amber-800">▸ {t.adjustment}</div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // 学习计划（E1 — r.plan 传子对象）
  if (r?.stages) {
    return (
      <div className="space-y-3">
        <StageCards title={r.totalWeeks ? `分阶段学习计划（共 ${r.totalWeeks} 周）` : "分阶段学习计划"} stages={r.stages} />
        {r.adaptation && <div className="rounded-lg bg-sky-50 p-2.5 text-[11px] text-sky-800">🔄 {r.adaptation}</div>}
        {r.knowledgeGap && <div className="rounded-lg bg-amber-50 p-2.5 text-[11px] text-amber-700">📚 {r.knowledgeGap}</div>}
      </div>
    );
  }

  // 课程辅导（E2 — tutoring）
  if (r?.breakdown) {
    return (
      <div className="space-y-3">
        <div className="text-xs font-semibold text-foreground/90">📖 课程辅导</div>
        <div>
          <div className="mb-1.5 text-[11px] font-semibold text-foreground/80">问题拆解</div>
          <div className="space-y-1">
            {r.breakdown.map((b: string, i: number) => (
              <div key={i} className="rounded-lg border border-border bg-card p-2 text-[11px]"><span className="mr-1.5 text-primary font-bold">{i + 1}.</span>{b}</div>
            ))}
          </div>
        </div>
        {r.stepHints?.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold text-foreground/80">💡 分步提示（先自己思考）</div>
            <div className="space-y-1">
              {r.stepHints.map((h: string, i: number) => (
                <div key={i} className="rounded-lg border-l-2 border-emerald-300 bg-emerald-50/40 p-2 text-[11px]">{h}</div>
              ))}
            </div>
          </div>
        )}
        {r.fullExplanation && (
          <details className="rounded-lg border border-border bg-card p-2.5">
            <summary className="cursor-pointer text-[11px] font-medium text-foreground/80">✅ 完整示范（做完再核对）</summary>
            <div className="mt-1.5 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{r.fullExplanation}</div>
          </details>
        )}
        {r.commonMistakes?.length > 0 && <TagList title="常见错误" items={r.commonMistakes} color="bg-amber-50 text-amber-700" />}
        {r.citations?.length > 0 && (
          <div className="rounded-lg bg-muted/40 p-2.5 text-[10px] text-muted-foreground">📎 引用: {r.citations.map((c: any) => c.source).join("、")}</div>
        )}
      </div>
    );
  }

  // 预习/复习（E4 — material）
  if (r?.objectives || r?.framework) {
    const isReview = !!r.framework;
    return (
      <div className="space-y-3">
        <div className="text-xs font-semibold text-foreground/90">{isReview ? "🔁 复习材料" : "📚 预习材料"}</div>
        {r.objectives?.length > 0 && <TagList title="预习目标" items={r.objectives} color="bg-sky-50 text-sky-700" />}
        {r.framework && <div className="rounded-lg border border-border bg-card p-2.5 text-[11px] leading-5">{r.framework}</div>}
        {r.keyPoints?.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold text-foreground/80">要点速记</div>
            <div className="space-y-1">
              {r.keyPoints.map((k: any, i: number) => (
                <div key={i} className="rounded-lg border border-border bg-card p-2 text-[11px]"><span className="font-medium">{k.point}</span> — {k.note}</div>
              ))}
            </div>
          </div>
        )}
        {r.concepts?.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold text-foreground/80">概念预习</div>
            <div className="space-y-1">
              {r.concepts.map((c: any, i: number) => (
                <div key={i} className="rounded-lg border border-border bg-card p-2 text-[11px]">
                  <span className="font-medium">{c.name}</span>
                  <div className="text-[10px] text-muted-foreground">{c.plainExplanation}</div>
                  <div className="text-[10px] text-primary/70">思考: {c.thinkAbout}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {r.pitfalls?.length > 0 && <TagList title="易错点" items={r.pitfalls} color="bg-red-50 text-red-700" />}
        {r.selfCheck?.length > 0 && <QuestionCards title="自测" questions={r.selfCheck} />}
        {r.recommendedReadings?.length > 0 && <TagList title="推荐阅读" items={r.recommendedReadings} color="bg-emerald-50 text-emerald-700" />}
      </div>
    );
  }

  // 自适应推送（E7 push）
  if (r?.weakContent || r?.advancedContent) {
    return (
      <div className="space-y-3">
        <div className="text-xs font-semibold text-foreground/90">🎯 自适应内容推送</div>
        {r.weakContent?.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold text-red-600">薄弱点专项（{r.weakContent.length} 项）</div>
            <div className="space-y-2">
              {r.weakContent.map((w: any, i: number) => (
                <div key={i} className="rounded-lg border border-red-200 bg-red-50/30 p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium">{w.point}</span>
                    <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[9px] text-red-600">{w.materialType}</span>
                    {w.estimatedMinutes != null && <span className="ml-auto text-[9px] text-muted-foreground">⏱ {w.estimatedMinutes} 分钟</span>}
                  </div>
                  <div className="mt-1 text-[10px] text-muted-foreground">{w.material}</div>
                  {w.practiceQuestion && <div className="mt-1 rounded bg-muted/60 p-1.5 text-[10px]">📝 {w.practiceQuestion}</div>}
                </div>
              ))}
            </div>
          </div>
        )}
        {r.advancedContent?.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold text-violet-600">🚀 拔高拓展（学有余力）</div>
            <div className="space-y-1.5">
              {r.advancedContent.map((a: any, i: number) => (
                <div key={i} className="rounded-lg border border-violet-200 bg-violet-50/30 p-2 text-[11px]">
                  <span className="font-medium">{a.point}</span> → {a.advancedTopic}
                  <div className="text-[10px] text-muted-foreground">{a.material}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {r.strategy && <div className="rounded-lg bg-emerald-50 p-2.5 text-[11px] text-emerald-800">🧭 {r.strategy}</div>}
      </div>
    );
  }

  // 作业解析（E8 solve — solution）
  if (r?.analysis) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-2.5 text-[11px] leading-5 text-sky-900">🔍 题目拆解: {r.analysis}</div>
        {r.steps?.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold text-foreground/80">分步思路（不直接给答案）</div>
            <div className="space-y-1.5">
              {r.steps.map((s: any, i: number) => (
                <div key={i} className="rounded-lg border-l-2 border-emerald-300 bg-card p-2 text-[11px]">
                  <span className="font-medium text-primary">Step {i + 1}</span>
                  <div className="mt-0.5">{s.hint}</div>
                  {s.thinking && <div className="mt-0.5 text-[10px] text-muted-foreground">🤔 {s.thinking}</div>}
                </div>
              ))}
            </div>
          </div>
        )}
        {r.keyFormula && <div className="rounded-lg bg-amber-50 p-2.5 font-mono text-[11px] text-amber-800">📐 {r.keyFormula}</div>}
        {r.pitfalls?.length > 0 && <TagList title="易错点" items={r.pitfalls} color="bg-red-50 text-red-700" />}
        {r.finalAnswer && <div className="rounded-lg bg-emerald-50 p-2.5 text-[11px] text-emerald-800">✅ {r.finalAnswer}</div>}
        {r.similarPractice && <div className="rounded-lg border border-border bg-card p-2.5 text-[11px]">📝 同类练习: {r.similarPractice}</div>}
      </div>
    );
  }

  // 作业答疑（E8 qna — guidance）
  if (r?.diagnosis && r?.followUpQuestions) {
    return (
      <div className="space-y-3">
        {r.acknowledge && <div className="rounded-lg bg-emerald-50 p-2.5 text-[11px] text-emerald-800">👍 {r.acknowledge}</div>}
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-2.5 text-[11px] text-amber-800">🔍 卡点诊断: {r.diagnosis}</div>
        <div>
          <div className="mb-1.5 text-[11px] font-semibold text-foreground/80">追问式引导</div>
          <div className="space-y-1.5">
            {r.followUpQuestions.map((q: any, i: number) => (
              <div key={i} className="rounded-lg border border-border bg-card p-2.5 text-[11px]">
                <span className="font-medium text-primary">追问 {i + 1}:</span> {q.question}
                <div className="mt-0.5 text-[10px] text-muted-foreground">💡 思考方向: {q.directionHint}</div>
              </div>
            ))}
          </div>
        </div>
        {r.nextStep && <div className="rounded-lg bg-sky-50 p-2.5 text-[11px] text-sky-800">➡️ 下一步: {r.nextStep}</div>}
      </div>
    );
  }

  // 学习陪伴（E6 — motivation/qa/plan/review 各模式）
  if (r?.empathy) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3 text-[12px] leading-5 text-violet-900">💜 {r.empathy}</div>
        {r.reframe && <div className="rounded-lg border border-border bg-card p-2.5 text-[11px]">🔄 换个视角: {r.reframe}</div>}
        {r.smallAction && <div className="rounded-lg bg-emerald-50 p-2.5 text-[11px] text-emerald-800">👣 现在就能做: {r.smallAction}</div>}
        {r.encouragement && <div className="rounded-lg bg-amber-50 p-2.5 text-[11px] text-amber-800">🔥 {r.encouragement}</div>}
        {r.ifStuck && <div className="text-[10px] text-muted-foreground">如果还是不行: {r.ifStuck}</div>}
      </div>
    );
  }
  if (r?.answer) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-border bg-card p-3 text-[12px] leading-5">{r.answer}</div>
        {r.keyPoint && <div className="rounded-lg bg-primary/5 p-2 text-[11px] text-primary">⭐ 核心: {r.keyPoint}</div>}
        {r.followUp && <div className="rounded-lg bg-muted/40 p-2 text-[10px] text-muted-foreground">🤔 {r.followUp}</div>}
      </div>
    );
  }

  // 兜底
  return renderJson(r);
}

// V383: 联动证据区 — 展示知识库关联/推理轨迹/记忆画像（让「联动整个 Agent」可见）
function LinkageEvidence({ r }: { r: any }) {
  if (!r) return null;
  const badges: Array<{ label: string; ok: boolean }> = [
    { label: "知识库文献", ok: !!r.linked },
    { label: "52步深度推理", ok: !!r.deepReason },
    { label: "记忆画像", ok: !!r.memoryLinked },
  ];
  const active = badges.filter((b) => b.ok);
  if (active.length === 0 && !r.deepReason) return null;
  return (
    <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50/40 p-2">
      <div className="mb-1 text-[10px] font-semibold text-emerald-700">⚡ Agent 联动（不只是单次 LLM）</div>
      <div className="flex flex-wrap gap-1">
        {badges.map((b) => (
          <span key={b.label} className={`rounded px-1.5 py-0.5 text-[9px] ${b.ok ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground line-through"}`}>
            {b.ok ? "✅" : "○"} {b.label}
          </span>
        ))}
      </div>
      {r.deepReason && (
        <div className="mt-1.5 text-[10px] text-emerald-800">
          <span className="font-semibold">深度推理：</span>
          <span className="text-muted-foreground">{(r.deepReason.content || "").slice(0, 200)}…</span>
          {r.deepReason.confidence != null && <span className="ml-1 rounded bg-emerald-100 px-1 text-[9px]">置信度 {(r.deepReason.confidence * 100).toFixed(0)}%</span>}
        </div>
      )}
    </div>
  );
}

// V383: Obsidian 联动工具条 — 查阅资料 + 保存学习记录
function ObsidianTools({ topic, subject }: { topic: string; subject: string }) {
  const [results, setResults] = useState<Array<{ name: string; snippet: string }> | null>(null);
  const [searching, setSearching] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");

  const search = async () => {
    setSearching(true);
    try {
      const r = await fetch(`/api/vault/search?q=${encodeURIComponent(topic)}&limit=5`);
      const d = await r.json();
      setResults(d.results || []);
    } catch { setResults([]); }
    setSearching(false);
  };

  const saveNote = async () => {
    setSaving(true);
    try {
      const r = await fetch("/api/vault/study-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `${topic} 学习记录`, content: note, subject }),
      });
      const d = await r.json();
      setSaved(!!d.ok);
    } catch { setSaved(false); }
    setSaving(false);
  };

  return (
    <div className="mt-3 rounded-md border border-sky-200 bg-sky-50/40 p-2">
      <div className="mb-1.5 text-[10px] font-semibold text-sky-700">📚 Obsidian 资料联动</div>
      <div className="flex items-center gap-2">
        <button onClick={() => void search()} disabled={searching} className="rounded bg-sky-600 px-2 py-1 text-[10px] text-white hover:bg-sky-700 disabled:opacity-50">
          {searching ? "搜索中…" : `🔍 查阅「${topic.slice(0, 12)}」资料`}
        </button>
      </div>
      {results && (
        <div className="mt-1.5 space-y-1">
          {results.length === 0 && <div className="text-[10px] text-muted-foreground">Obsidian 中未找到相关资料</div>}
          {results.map((r) => (
            <div key={r.name} className="rounded bg-muted/60 px-2 py-1">
              <div className="text-[10px] font-medium text-sky-800">📄 {r.name}</div>
              <div className="text-[9px] text-muted-foreground">{r.snippet}</div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-start gap-2">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={`✍️ 记录本次「${topic.slice(0, 12)}」学习笔记（将保存到 Obsidian 课题研究/学习记录/）…`}
          rows={2}
          className="flex-1 rounded border border-border bg-background px-2 py-1 text-[10px] placeholder:text-muted-foreground/50"
        />
        <button onClick={() => void saveNote()} disabled={saving || !note.trim()} className="shrink-0 rounded bg-sky-600 px-2 py-1 text-[10px] text-white hover:bg-sky-700 disabled:opacity-40">
          {saving ? "保存中…" : saved ? "✅ 已保存" : "保存"}
        </button>
      </div>
    </div>
  );
}

const TOOLS: ToolDef[] = [
  {
    id: "E1", title: "个性化学习规划", desc: "按目标/水平/时间生成分阶段学习计划，动态调整路径",
    icon: <GraduationCap className="h-4 w-4" />,
    resultKey: "plan",
    fields: [
      { key: "subject", label: "科目", placeholder: "如：马克思主义基本原理", type: "text" },
      { key: "goal", label: "学习目标", placeholder: "如：期末考 90 分 / 考研政治 75+", type: "text" },
      { key: "currentLevel", label: "当前水平", placeholder: "如：基础薄弱 / 中等", type: "text" },
      { key: "hoursPerWeek", label: "每周小时", placeholder: "4", type: "text" },
      { key: "deadline", label: "目标期限", placeholder: "如：12 月底", type: "text" },
    ],
    demo: {
      subject: "马克思主义基本原理",
      goal: "考研政治 75 分以上",
      currentLevel: "中等（学过一遍但基础不牢）",
      hoursPerWeek: "6",
      deadline: "3 个月后",
    },
    render: (r) => renderResult(r.plan),
  },
  {
    id: "E2", title: "专业课课程辅导", desc: "分步引导式辅导，先提示再示范，不直接给答案",
    icon: <BookOpen className="h-4 w-4" />,
    resultKey: "tutoring",
    fields: [
      { key: "subject", label: "专业", placeholder: "如：政治经济学", type: "text" },
      { key: "topic", label: "问题/知识点", placeholder: "如：剩余价值率的计算方法", type: "textarea" },
      { key: "difficulty", label: "难度", placeholder: "基础/进阶/挑战", type: "select", options: ["基础", "进阶", "挑战"] },
    ],
    demo: {
      subject: "政治经济学",
      topic: "价值规律的基本内容",
      difficulty: "基础",
    },
    render: (r) => renderResult(r.tutoring),
  },
  {
    id: "E3", title: "学情诊断", desc: "作答分析·漏洞定位·行为分析·预测预警（双报告）",
    icon: <Stethoscope className="h-4 w-4" />,
    resultKey: "diagnosis",
    fields: [
      { key: "subject", label: "科目", placeholder: "如：马克思主义政治经济学", type: "text" },
      { key: "action", label: "模式", placeholder: "作答分析/漏洞定位/行为分析/诊断报告/预测预警", type: "select", options: ["basic", "gaps", "behavior", "report", "risk"] },
      { key: "answers", label: "作答记录（作答分析用）", placeholder: "粘贴学生的练习/测试作答内容…", type: "textarea" },
      { key: "knowledgePoints", label: "涉及知识点（可选）", placeholder: "如：商品二因素、价值规律", type: "text" },
      { key: "audience", label: "报告对象", placeholder: "学生版/教师版", type: "select", options: ["student", "teacher"] },
    ],
    demo: {
      subject: "马克思主义基本原理",
      action: "risk",
      answers: "1. 商品的价值由什么决定？答：由商品的使用价值决定。\n2. 货币的本质是什么？答：货币是商品交换的媒介。\n3. 剩余价值来源于哪里？答：来源于资本的流通。",
      knowledgePoints: "商品二因素、货币本质、剩余价值",
      audience: "student",
    },
        autoLoad: true,
    render: (r) => renderResult(r),
  },
  {
    id: "E4", title: "预习与复习", desc: "预习材料（目标/概念/自测）或复习材料（框架/速记/易错点）",
    icon: <CalendarClock className="h-4 w-4" />,
    resultKey: "material",
    fields: [
      { key: "subject", label: "科目", placeholder: "如：中国近现代史纲要", type: "text" },
      { key: "topic", label: "章节/主题", placeholder: "如：新民主主义革命理论", type: "textarea" },
      { key: "mode", label: "模式", placeholder: "预习/复习", type: "select", options: ["preview", "review"] },
    ],
    demo: {
      subject: "中国近现代史纲要",
      topic: "新民主主义革命理论",
      mode: "preview",
    },
    render: (r) => renderResult(r.material),
  },
  {
    id: "E5", title: "教师备课", desc: "教案课件·命题组卷·作业批改·班级学情汇总",
    icon: <ClipboardList className="h-4 w-4" />,
    resultKey: "teach",
    fields: [
      { key: "subject", label: "科目", placeholder: "如：马克思主义基本原理", type: "text" },
      { key: "action", label: "模式", placeholder: "教案课件/命题组卷/作业批改/班级汇总", type: "select", options: ["lesson", "exam", "grade", "class-summary"] },
      { key: "chapter", label: "章节（教案用）", placeholder: "如：剩余价值理论", type: "text" },
      { key: "includePpt", label: "含PPT", placeholder: "是/否", type: "select", options: ["true", "false"] },
      { key: "difficulty", label: "难度（组卷用）", placeholder: "easy/medium/hard", type: "select", options: ["easy", "medium", "hard"] },
      { key: "questionCount", label: "题数（组卷用）", placeholder: "8", type: "text" },
      { key: "knowledgePoints", label: "知识点筛选（组卷用）", placeholder: "如：价值规律,剩余价值", type: "text" },
      { key: "classMinutes", label: "课时长（教案用）", placeholder: "90", type: "text" },
      { key: "studentLevel", label: "学生水平", placeholder: "如：普通本科 / 专科", type: "text" },
    ],
    demo: {
      subject: "马克思主义基本原理",
      action: "lesson",
      chapter: "第三章 资本主义的本质及规律（重点：剩余价值理论）",
      includePpt: "true",
      difficulty: "medium",
      questionCount: "8",
      knowledgePoints: "剩余价值",
      classMinutes: "90",
      studentLevel: "普通本科大二",
    },
    render: (r) => renderResult(r),
  },
  {
    id: "E6", title: "学习陪伴", desc: "日周计划·随时答疑·激励疏导·复盘总结",
    icon: <HeartHandshake className="h-4 w-4" />,
    resultKey: "companion",
    fields: [
      { key: "subject", label: "科目", placeholder: "如：马克思主义基本原理", type: "text" },
      { key: "action", label: "模式", placeholder: "学习计划/答疑对话/激励疏导/复盘总结", type: "select", options: ["plan", "qna", "motivate", "review"] },
      { key: "message", label: "学生的话（陪伴/答疑用）", placeholder: "如：我觉得政治经济学好难，想放弃了…", type: "textarea" },
      { key: "goal", label: "目标（计划用）", placeholder: "如：掌握剩余价值理论", type: "text" },
      { key: "planType", label: "计划类型", placeholder: "日/周", type: "select", options: ["daily", "weekly"] },
      { key: "availableHours", label: "可投入小时", placeholder: "3", type: "text" },
      { key: "situation", label: "情绪/处境（激励用）", placeholder: "如：学了几天感觉没进步，想放弃", type: "text" },
      { key: "todayWhat", label: "今日学习（复盘用）", placeholder: "如：复习了价值规律，做了10道题", type: "textarea" },
      { key: "studentProfile", label: "学生画像", placeholder: "如：大一新生，基础一般", type: "text" },
    ],
    demo: {
      subject: "马克思主义基本原理",
      action: "motivate",
      message: "老师讲剩余价值的时候我没听懂，做题全错，感觉自己不适合学这个专业，好想放弃…",
      goal: "掌握剩余价值理论",
      planType: "daily",
      availableHours: "3",
      situation: "学了几天感觉没进步",
      todayWhat: "复习了价值规律",
      studentProfile: "大一新生，第一次学政治经济学",
    },
    render: (r) => renderResult(r),
  },
  {
    id: "E7", title: "自适应学习", desc: "学情画像·自适应推送·节奏适配·分层教学（V384）",
    icon: <GraduationCap className="h-4 w-4" />,
    resultKey: "adaptive",
    fields: [
      { key: "subject", label: "科目", placeholder: "如：政治经济学", type: "text" },
      { key: "action", label: "操作", placeholder: "查看画像/推送内容/节奏建议/分层教学", type: "select", options: ["profile", "push", "pace", "layered"] },
      { key: "knowledgePoint", label: "知识点（分层教学用）", placeholder: "如：剩余价值", type: "text" },
    ],
    demo: { subject: "政治经济学", action: "profile", knowledgePoint: "剩余价值" },
    autoLoad: true,
    render: (r) => renderResult(r),
  },
  {
    id: "E8", title: "作业辅导", desc: "题目解析·错题本·变式巩固·作业答疑（V385）",
    icon: <BookOpen className="h-4 w-4" />,
    resultKey: "homework",
    fields: [
      { key: "subject", label: "科目", placeholder: "如：政治经济学", type: "text" },
      { key: "action", label: "操作", placeholder: "解析题目/错题本/变式巩固/作业答疑", type: "select", options: ["solve", "wrong-list", "variant", "qna"] },
      { key: "question", label: "题目", placeholder: "输入作业题目（文本/公式/拍照OCR文本/图表描述）", type: "textarea" },
      { key: "hintLevel", label: "提示程度", placeholder: "启发式/引导式/完整解析", type: "select", options: ["hint", "guided", "full"] },
      { key: "knowledgePoint", label: "知识点（变式用）", placeholder: "如：价值规律", type: "text" },
      { key: "stuckAt", label: "卡点（答疑用）", placeholder: "如：不理解利润率为何小于剩余价值率", type: "text" },
    ],
    demo: {
      subject: "政治经济学",
      action: "solve",
      question: "商品的价值量由什么决定？为什么？",
      hintLevel: "hint",
      knowledgePoint: "价值规律",
      stuckAt: "不理解利润率为何小于剩余价值率",
    },
    render: (r) => renderResult(r),
  },
];

export const EducationPanel: FC = () => {
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, any>>({});
  const [inputs, setInputs] = useState<Record<string, Record<string, string>>>({});
  const [activeTool, setActiveTool] = useState<string>("E1");
  // V383: 左右拉伸 — 分隔条控制中间区宽度（向左=中间变窄侧栏变宽，向右=中间变宽侧栏变窄）
  // V383: 侧栏宽度独立可拖（200-1000px），中间区 flex-1 自动补位
  const [obsWidth, setObsWidth] = useState(500);
  const [obsCollapsed, setObsCollapsed] = useState(false);
  const draggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, w: 500 });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      // 侧栏宽度 = 起始宽度 + 位移（向左拉 = 变宽，向右拉 = 变窄）—— 直接且方向正确
      const delta = dragStartRef.current.x - e.clientX;
      const newW = Math.min(1000, Math.max(200, dragStartRef.current.w + delta));
      setObsWidth(newW);
    };
    const onUp = () => { draggingRef.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  const run = async (tool: ToolDef, preset?: Record<string, string>) => {
    setRunning(tool.id);
    setResults((prev) => ({ ...prev, [tool.id]: undefined }));
    // V383: preset（Demo 数据）优先，否则用当前表单
    const body: Record<string, unknown> = { ...(preset || inputs[tool.id] || {}) };
    if (tool.id === "E4" && body.mode === "preview") body.mode = "preview";
    // V384/V385: E7 自适应学习 + E8 作业辅导按 action 分发
    let path: string;
    if (tool.id === "E7") {
      const action = String(body.action || "profile");
      path = `/adaptive/${action === "push" ? "push" : action === "pace" ? "pace" : action === "layered" ? "layered" : "profile"}`;
    } else if (tool.id === "E8") {
      const action = String(body.action || "solve");
      path = `/homework/${action === "wrong-list" ? "wrong-list" : action === "variant" ? "variant" : action === "qna" ? "qna" : "solve"}`;
    } else if (tool.id === "E3") {
      // V386 合并: 学情诊断（basic→诊断, gaps/behavior/report/risk→升级能力）
      const action = String(body.action || "basic");
      if (action === "basic") {
        path = "/diagnosis";
      } else {
        path = `/diagnostic/${action === "gaps" ? "gaps" : action === "behavior" ? "behavior" : action === "report" ? "report" : "risk"}`;
      }
    } else if (tool.id === "E5") {
      // V387 合并: 教师备课（lesson 教案 + exam/grade/class-summary）
      const action = String(body.action || "lesson");
      path = `/teach/${action === "exam" ? "exam" : action === "grade" ? "grade" : action === "class-summary" ? "class-summary" : "lesson"}`;
    } else if (tool.id === "E6") {
      // V388 合并: 学习陪伴（companion 对话 + plan/qna/motivate/review）
      const action = String(body.action || "companion");
      if (action === "companion") {
        path = "/companion";
      } else {
        path = `/companion/${action === "qna" ? "qna" : action === "motivate" ? "motivate" : action === "review" ? "review" : "plan"}`;
      }
    } else {
      path = `/${tool.id === "E1" ? "learning-plan" : tool.id === "E2" ? "tutoring" : tool.id === "E4" ? "preview-review" : "companion"}`;
    }
    const r = await callApi(path, body);
    setResults((prev) => ({ ...prev, [tool.id]: r }));
    setRunning(null);
  };

  const active = TOOLS.find((t) => t.id === activeTool)!;

  // V393: 切换工具时自动加载默认模式（数据类功能直接呈现，无需点 Demo）
  useEffect(() => {
    const auto = (TOOLS.find((t) => t.id === activeTool) as ToolDef & { autoLoad?: boolean });
    if (auto?.autoLoad && !running && !results[auto.id]) {
      void run(auto, auto.demo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <GraduationCap className="h-4 w-4 text-emerald-600" />
        <h2 className="text-sm font-semibold">AI+教育</h2>
        <span className="text-[10px] text-muted-foreground">个性化学习 · 课程辅导 · 学情诊断 · 预习复习 · 教师备课 · 学习陪伴</span>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 左侧工具列表 */}
        <div className="w-[200px] shrink-0 space-y-1 overflow-y-auto border-r p-2">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTool(t.id)}
              className={`w-full rounded-md px-2 py-2 text-left transition-colors ${activeTool === t.id ? "bg-emerald-50 text-emerald-800" : "hover:bg-muted"}`}
            >
              <div className="flex items-center gap-2 text-[12px] font-medium">
                {t.icon} {t.title}
              </div>
              <div className="mt-0.5 pl-6 text-[10px] leading-4 text-muted-foreground">{t.desc}</div>
            </button>
          ))}
        </div>

        {/* 右侧：主区（工具表单 + 结果，flex-1 自适应） */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mb-3 text-[11px] text-muted-foreground">{active.desc}</div>
          <div className="space-y-2">
            {active.fields.map((f) => (
              <div key={f.key}>
                <label className="mb-1 block text-[11px] font-medium text-foreground/80">{f.label}</label>
                {f.type === "select" ? (
                  <select
                    value={inputs[active.id]?.[f.key] || ""}
                    onChange={(e) => setInputs((prev) => ({ ...prev, [active.id]: { ...(prev[active.id] || {}), [f.key]: e.target.value } }))}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                  >
                    <option value="">选择…</option>
                    {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <textarea
                    value={inputs[active.id]?.[f.key] || ""}
                    onChange={(e) => setInputs((prev) => ({ ...prev, [active.id]: { ...(prev[active.id] || {}), [f.key]: e.target.value } }))}
                    placeholder={f.placeholder}
                    rows={f.type === "textarea" ? 3 : 1}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground/50"
                  />
                )}
              </div>
            ))}
            <button
              onClick={() => void run(active)}
              disabled={running === active.id}
              className="flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {running === active.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              {running === active.id ? "生成中…" : "开始"}
            </button>
            {active.demo && (
              <button
                onClick={() => {
                  // V383: Demo 演示 — 一键填入示例数据并自动运行
                  setInputs((prev) => ({ ...prev, [active.id]: { ...active.demo! } }));
                  void run(active, active.demo);
                }}
                disabled={running === active.id}
                className="flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                title="填入示例数据并运行"
              >
                🎬 Demo 演示
              </button>
            )}
          </div>

          <div className="mt-4">
            {results[active.id]?.error && <div className="rounded bg-red-50 p-2 text-xs text-red-700">{results[active.id].error}</div>}
            {results[active.id] && !results[active.id].error && !results[active.id].ok === false && (
              <>
                {/* V383: 联动证据区（知识库/推理/记忆） */}
                <LinkageEvidence r={results[active.id]} />
                <div className="rounded-md border bg-card p-3">{active.render(results[active.id])}</div>
                {/* V383: Obsidian 资料查阅 + 学习记录 */}
                <ObsidianTools
                  topic={inputs[active.id]?.topic || inputs[active.id]?.goal || inputs[active.id]?.chapter || active.title.replace("·", "")}
                  subject={inputs[active.id]?.subject || ""}
                />
              </>
            )}
            {results[active.id] && results[active.id].ok === false && (
              <div className="rounded bg-amber-50 p-2 text-xs text-amber-700">{results[active.id].error || "请求未成功"}</div>
            )}
          </div>
        </div>

        {/* V383: Obsidian 资料库侧栏 — 可拖拽宽度 + 可折叠 */}
        <div
          className="flex w-[6px] shrink-0 cursor-col-resize items-center justify-center border-l border-border bg-muted/40 hover:bg-sky-200"
          title="拖拽调整宽度"
          onMouseDown={(e) => {
            e.preventDefault();
            draggingRef.current = true;
            dragStartRef.current = { x: e.clientX, w: obsWidth };
          }}
        />
        {obsCollapsed ? (
          <button
            onClick={() => setObsCollapsed(false)}
            className="flex w-7 shrink-0 items-center justify-center border-l bg-sky-50 text-[10px] text-sky-600 hover:bg-sky-100"
            title="展开 Obsidian 资料库"
          >
            📚
          </button>
        ) : (
          <div className="flex h-full min-h-0 flex-col" style={{ width: obsWidth }}>
            {/* V383: 侧栏宽度独立可拖（分隔条直接改 obsWidth） */}
            <ObsidianVaultSidebar onCollapse={() => setObsCollapsed(true)} />
          </div>
        )}
      </div>
    </div>
  );
};
