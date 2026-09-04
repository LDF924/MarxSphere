// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// LiteraturePanel.tsx — MarxSphere 本地文献库筛选界面
// 复刻 Sciverse 的 meta-catalog + meta-search 模式：
// 左=筛选器（主题/作者/年份动态生成），右=文献列表
import { useState, useEffect, useRef, type FC, type ReactNode } from "react";
import { Library, Loader2, Search, FileText, RefreshCw, BookOpen, X, ChevronDown, ChevronUp, BookOpenCheck } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { LiteratureMatrixPanel } from "./LiteratureMatrixPanel";
import { PrismaPanel } from "./PrismaPanel";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { DragHandle } from "../components/ui/DragHandle";
import { PdfReader } from "./PdfReader";
import { ReaderAiCard } from "./ReaderAiCard";
import type { LiteratureDetailRecord, PdfRecord } from "../types";

interface LiteratureRecord {
  id: string;
  title: string;
  paperTitle: string;
  authors: string[];
  topic: string;
  year: string;
  path: string;
  hasSummary: boolean;
  hasQa: boolean;
  hasTerms: boolean;
}

interface LiteratureCatalog {
  topics: string[];
  authors: string[];
  years: string[];
  total: number;
}

export function LiteraturePanel() {
  const [catalog, setCatalog] = useState<LiteratureCatalog | null>(null);
  const [items, setItems] = useState<LiteratureRecord[]>([]);
  const [pdfItems, setPdfItems] = useState<PdfRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 模式：md=已入库文献, pdf=全库 PDF
  const [mode, setMode] = useState<"md" | "pdf">("md");
  // 筛选条件
  const [topic, setTopic] = useState("");
  const [author, setAuthor] = useState("");
  const [year, setYear] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [authorInput, setAuthorInput] = useState("");
  // 左列宽度（可拖拽）
  const [filterWidth, setFilterWidth] = useState(() => {
    const stored = localStorage.getItem("literature-filter-width");
    const n = stored ? Number(stored) : 280;
    return n >= 160 && n <= 480 ? n : 280;
  });
  const filterDragRef = useRef(false);

  const startFilterDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    filterDragRef.current = true;
    const startX = e.clientX;
    const startW = filterWidth;
    const onMove = (ev: PointerEvent) => {
      if (!filterDragRef.current) return;
      setFilterWidth(Math.min(480, Math.max(160, startW + (ev.clientX - startX))));
    };
    const onUp = () => {
      filterDragRef.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      localStorage.setItem("literature-filter-width", String(filterWidth));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
  };

  // 详情
  const [detail, setDetail] = useState<LiteratureDetailRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showQa, setShowQa] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [showIndexMeta, setShowIndexMeta] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  // PDF 深度阅读（PdfReader）
  const [readerPdf, setReaderPdf] = useState<{ url: string; name: string } | null>(null);
  // 详情容器 ref(划词 AI 卡片监听)
  const detailRef = useRef<HTMLDivElement | null>(null);

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    setShowQa(false);
    setShowTerms(false);
    setShowIndexMeta(false);
    setShowOriginal(false);
    try {
      const data = await api.getLiteratureDetail(id);
      setDetail(data.detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetailLoading(false);
    }
  };

  // Esc 键关闭详情
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const loadCatalog = async () => {
    try {
      const data = await api.getLiteratureCatalog();
      setCatalog(data.catalog);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadItems = async (pageNum = page, modeOverride?: "md" | "pdf") => {
    const effectiveMode = modeOverride ?? mode;
    setLoading(true);
    try {
      if (effectiveMode === "pdf") {
        const data = await api.searchPdfs({
          topic: topic || undefined,
          keyword: keyword || undefined,
          page: pageNum
        });
        setPdfItems(data.items);
        setTotal(data.total);
      } else {
        const data = await api.getLiterature({
          topic: topic || undefined,
          author: author || authorInput || undefined,
          year: year || undefined,
          keyword: keyword || undefined,
          page: pageNum
        });
        setItems(data.items);
        setTotal(data.total);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (next: "md" | "pdf") => {
    if (next === mode) return;
    setMode(next);
    setPage(1);
    setDetail(null);
    setReaderPdf(null);
    void loadItems(1, next);
  };

  useEffect(() => {
    void loadCatalog();
    void loadItems(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilters = (resetPage = true) => {
    const p = resetPage ? 1 : page;
    setPage(p);
    void loadItems(p);
  };

  const resetFilters = () => {
    setTopic(""); setAuthor(""); setYear(""); setKeyword(""); setAuthorInput(""); setPage(1);
    void loadItems(1);
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="flex w-full flex-col space-y-3">
        <div className="flex items-center gap-2">
          <Library className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">文献库</h2>
          <span className="text-xs text-muted-foreground">
            {mode === "pdf" ? `全库 ${total} 篇 PDF` : catalog ? `${catalog.total} 篇深度文献` : "加载中…"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex rounded-full border border-border p-0.5">
              <button
                type="button"
                onClick={() => switchMode("md")}
                className={cn("rounded-full px-3 py-1 text-xs transition-colors", mode === "md" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent")}
              >
                已入库
              </button>
              <button
                type="button"
                onClick={() => switchMode("pdf")}
                className={cn("rounded-full px-3 py-1 text-xs transition-colors", mode === "pdf" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent")}
              >
                全库 PDF
              </button>
            </div>
            <ButtonSmall onClick={() => { void loadCatalog(); void loadItems(); }}>
              <RefreshCw className="h-3.5 w-3.5" /> 刷新
            </ButtonSmall>
          </div>
        </div>

        {/* 常开工作面板: PRISMA 综述 + 文献提取矩阵(置顶, 不折叠) */}
        {mode === "md" ? (
          <div className="space-y-2">
            <PrismaPanel />
            <LiteratureMatrixPanel papers={items.map((r) => ({ id: String(r.id), title: String(r.title ?? r.paperTitle ?? "") }))} />
          </div>
        ) : (
          <div className="rounded border border-border/50 bg-background/20 px-3 py-2 text-[11px] text-muted-foreground/60">
            切换到「已入库」模式可使用 PRISMA 综述与文献提取矩阵
          </div>
        )}

        {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}

        <div className="relative flex min-h-0 flex-1 flex-col">
        <DragHandle leftVar="--filter-w" defaultWidth={280} storageKey="literature-filter-width" />
        <div className="grid h-[135vh] w-full grid-cols-1 grid-rows-[minmax(0,1fr)] gap-3 lg:grid-cols-[var(--filter-w,280px)_minmax(0,1fr)]" style={{ "--filter-w": `${filterWidth}px` } as React.CSSProperties}>
          {/* 左：筛选器（meta-catalog 动态生成） */}
          <Card className="flex min-h-0 flex-col overflow-y-auto p-3">
            <div className="mb-2 text-sm font-medium">筛选条件</div>

            {/* 关键词 */}
            <div className="mb-2 flex gap-1">
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") applyFilters(); }}
                placeholder="标题/关键词…"
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              />
              <Button size="sm" variant="outline" onClick={() => applyFilters()}>
                <Search className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* 主题筛选 */}
            <div className="mb-3">
              <div className="mb-1 text-xs text-muted-foreground">主题</div>
              <div className="space-y-1">
                <FilterChip active={!topic} label="全部主题" onClick={() => { setTopic(""); applyFilters(); }} />
                {catalog?.topics.map((t) => (
                  <FilterChip
                    key={t}
                    active={topic === t}
                    label={t}
                    onClick={() => { setTopic(t === topic ? "" : t); applyFilters(); }}
                  />
                ))}
              </div>
            </div>

            {/* 年份 */}
            {catalog && catalog.years.length > 0 && (
              <div className="mb-3">
                <div className="mb-1 text-xs text-muted-foreground">起始年份</div>
                <select
                  value={year}
                  onChange={(event) => { setYear(event.target.value); applyFilters(); }}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                >
                  <option value="">全部</option>
                  {catalog.years.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            )}

            {/* 作者筛选 */}
            <div className="mb-3">
              <div className="mb-1 text-xs text-muted-foreground">作者</div>
              <input
                value={authorInput}
                onChange={(event) => setAuthorInput(event.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") applyFilters(); }}
                placeholder="输入作者名搜索…"
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              />
            </div>

            <Button variant="outline" size="sm" onClick={resetFilters} className="mt-auto">
              重置筛选
            </Button>
          </Card>

          {/* 右：文献列表 + 详情（列表/详情可左右拉伸） */}
          <div className="relative min-h-0 flex-1">
            <DragHandle leftVar="--list-w" defaultWidth={480} minWidth={280} maxWidth={900} storageKey="literature-list-width" offset={-9} />
            <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)] gap-3 xl:grid-cols-[var(--list-w,minmax(0,1fr))_minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col gap-3">
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
                {loading ? (
                  <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />加载文献…
                  </div>
                ) : mode === "pdf" ? (
                  pdfItems.length === 0 ? (
                    <div className="p-4 text-sm text-muted-foreground">无匹配 PDF</div>
                  ) : (
                    pdfItems.map((pdf) => (
                      <Card
                        key={pdf.path}
                        className={cn(
                          "flex items-start gap-3 p-3",
                          readerPdf?.name === pdf.fileName && "border-primary"
                        )}
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
                          <FileText className="h-4 w-4 text-primary" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium leading-snug">{pdf.title}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {pdf.author ? `作者: ${pdf.author}` : "作者未提取"}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
                            <span className="rounded bg-accent/60 px-1.5 py-0.5 text-muted-foreground">{pdf.topic}</span>
                            {pdf.indexed
                              ? <span className="rounded bg-green-50 px-1.5 py-0.5 text-green-700">已入库</span>
                              : <span className="rounded bg-yellow-50 px-1.5 py-0.5 text-yellow-700">仅 PDF</span>}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setReaderPdf({ url: api.pdfFileUrl({ path: pdf.path }), name: pdf.fileName })}
                          className={cn(
                            "shrink-0 rounded-md border border-border px-2 py-1 text-[11px] transition-colors hover:bg-primary hover:text-primary-foreground",
                            readerPdf?.name === pdf.fileName && "bg-primary text-primary-foreground"
                          )}
                          title="用 PdfReader 深度阅读（页码/缩放/划词翻译）"
                        >
                          <BookOpenCheck className="mr-1 inline h-3 w-3" />
                          深度阅读
                        </button>
                      </Card>
                    ))
                  )
                ) : items.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">无匹配文献</div>
                ) : (
                  items.map((record) => (
                    <Card
                      key={record.id}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 p-3 transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent/40 hover:shadow-md",
                        detail?.id === record.id && "border-primary"
                      )}
                      onClick={() => void openDetail(record.id)}
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
                        <FileText className="h-4 w-4 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium leading-snug">{record.title}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {record.authors.join("、") || "佚名"}
                          {record.year ? ` · ${record.year}年` : ""}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
                          <span className="rounded bg-accent/60 px-1.5 py-0.5 text-muted-foreground">{record.topic}</span>
                          {record.hasSummary && <span className="rounded bg-green-50 px-1.5 py-0.5 text-green-700">有摘要</span>}
                          {record.hasQa && <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">有问答</span>}
                          {record.hasTerms && <span className="rounded bg-purple-50 px-1.5 py-0.5 text-purple-700">有术语表</span>}
                        </div>
                      </div>
                      <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                    </Card>
                  ))
                )}
              </div>
              {/* 页脚：篇数 + 分页（列表下方） */}
              <div className="flex shrink-0 items-center justify-between border-t border-border px-1 pb-0.5 pt-2 text-sm text-muted-foreground">
                <span>{total} 篇文献</span>
                {total > 20 && (
                  <span className="flex items-center gap-2">
                    <button onClick={() => { setPage(Math.max(1, page - 1)); void loadItems(page - 1); }} disabled={page <= 1} className="rounded-md border border-border bg-muted/30 px-2 py-0.5 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40">‹</button>
                    <span>第 {page} / {Math.ceil(total / 20)} 页</span>
                    <button onClick={() => { setPage(page + 1); void loadItems(page + 1); }} disabled={page * 20 >= total} className="rounded-md border border-border bg-muted/30 px-2 py-0.5 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40">›</button>
                  </span>
                )}
              </div>
            </div>

            {/* 详情面板 / PDF 深度阅读
                xl+: 填满 grid 固定行高(minmax(0,1fr))
                窄屏(<xl): grid 第二行隐式 auto 被内容压塌(Viewport height:100% 循环解析 → 20px), 给固定高度 */}
            <div className={cn("min-h-0", readerPdf ? "h-[60vh] overflow-visible xl:h-full" : "h-full overflow-y-auto")}>
              {readerPdf ? (
                <div className="flex h-full min-h-0 flex-col">
                  <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
                    <div className="truncate text-sm font-medium">
                      <BookOpenCheck className="mr-1.5 inline h-4 w-4 text-emerald-600" />
                      深度阅读：{readerPdf.name}
                    </div>
                    <button
                      type="button"
                      onClick={() => setReaderPdf(null)}
                      className="shrink-0 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600"
                    >
                      <X className="mr-1 inline h-3 w-3" />关闭
                    </button>
                  </div>
                  <div className="min-h-0 flex-1">
                    <PdfReader source={readerPdf.url} fileName={readerPdf.name} />
                  </div>
                </div>
              ) : detailLoading ? (
                <Card className="flex items-center justify-center p-8 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />加载详情…
                </Card>
              ) : detail ? (
                <div ref={detailRef} className="min-h-0 flex-1">
                <Card className="flex min-h-0 flex-col space-y-3 overflow-y-auto p-4">
                  <DetailSelectionWatcher containerRef={detailRef} />
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-base font-semibold leading-snug">{detail.title}</h3>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {detail.authors.join("、") || "佚名"}
                        {detail.year ? ` · ${detail.year}年` : ""}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">{detail.topic}</div>
                      {detail.category && <div className="mt-1 text-xs text-muted-foreground">中图分类号：{detail.category}</div>}
                      {detail.sourcePdf && <div className="mt-1 text-xs text-muted-foreground">源文件：{detail.sourcePdf}</div>}
                      {/* 2026-08-29 Agentero 对照: arXiv / alphaXiv 快速跳转 */}
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        <a href={`https://arxiv.org/abs/${detail.title}`} target="_blank" rel="noreferrer"
                          className="hidden rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700 hover:bg-red-100" title="arXiv 搜索该标题">
                          arXiv ↗
                        </a>
                        <a href={`https://www.alphaxiv.org/search?q=${encodeURIComponent(detail.title.slice(0, 80))}`} target="_blank" rel="noreferrer"
                          className="rounded border border-purple-200 bg-purple-50 px-1.5 py-0.5 text-[10px] text-purple-700 hover:bg-purple-100" title="alphaXiv 搜索该标题">
                          alphaXiv ↗
                        </a>
                        <a href={`https://www.semanticscholar.org/search?q=${encodeURIComponent(detail.title.slice(0, 100))}`} target="_blank" rel="noreferrer"
                          className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700 hover:bg-blue-100" title="Semantic Scholar 搜索">
                          Semantic Scholar ↗
                        </a>
                      </div>
                      {detail.keywords && detail.keywords.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {detail.keywords.slice(0, 8).map((kw) => (
                            <span key={kw} className="rounded bg-accent/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">{kw}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setDetail(null)}
                      className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600"
                      title="关闭详情（Esc）"
                      aria-label="关闭详情"
                    >
                      <X className="h-3.5 w-3.5" />
                      关闭
                    </button>
                  </div>

                  {/* 摘要 */}
                  {detail.summary && (
                    <div>
                      <div className="mb-1 text-xs font-medium text-muted-foreground">摘要</div>
                      <div className="space-y-1 text-sm">{detail.summary.split("\n").filter(Boolean).slice(0, 12).map((line, i) => (
                        <p key={i}>{line}</p>
                      ))}</div>
                    </div>
                  )}

                  {/* 问答 / 术语表 折叠 */}
                  {detail.qa && (
                    <div>
                      <button onClick={() => setShowQa((v) => !v)} className="flex w-full items-center justify-between rounded border border-border px-3 py-2 text-sm font-medium">
                        问答（{detail.qa.split("##").length - 1} 节）
                        {showQa ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </button>
                      {showQa && <div className="mt-2 max-h-72 space-y-2 overflow-y-auto text-sm"><DetailMarkdown text={detail.qa} /></div>}
                    </div>
                  )}

                  {detail.terms && (
                    <div>
                      <button onClick={() => setShowTerms((v) => !v)} className="flex w-full items-center justify-between rounded border border-border px-3 py-2 text-sm font-medium">
                        术语表
                        {showTerms ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </button>
                      {showTerms && <div className="mt-2 max-h-48 overflow-y-auto text-sm"><DetailMarkdown text={detail.terms} /></div>}
                    </div>
                  )}

                  {/* index.md 元数据表 */}
                  {detail.indexMeta && (
                    <div>
                      <button onClick={() => setShowIndexMeta((v) => !v)} className="flex w-full items-center justify-between rounded border border-border px-3 py-2 text-sm font-medium">
                        元数据表（index.md）
                        {showIndexMeta ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </button>
                      {showIndexMeta && <div className="mt-2 max-h-64 overflow-y-auto text-sm"><DetailMarkdown text={detail.indexMeta} /></div>}
                    </div>
                  )}

                  {/* original.md 原文 */}
                  {detail.originalText && (
                    <div>
                      <button onClick={() => setShowOriginal((v) => !v)} className="flex w-full items-center justify-between rounded border border-border px-3 py-2 text-sm font-medium">
                        原始全文（original.md）
                        {showOriginal ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </button>
                      {showOriginal && <div className="mt-2 max-h-96 overflow-y-auto text-sm"><DetailMarkdown text={detail.originalText.slice(0, 8000)} /></div>}
                    </div>
                  )}
                </Card>
                </div>
              ) : (
                <Card className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
                  {mode === "pdf" ? "点击左侧「深度阅读」在右侧阅读 PDF（页码/缩放/划词翻译）" : "点击左侧文献查看摘要/问答/术语表"}
                </Card>
              )}
              </div>
            </div>
          </div>
          </div>
        </div>
        </div>


    </section>
  );
}

function DetailMarkdown({ text }: { text: string }) {
  return (
    <div className="space-y-1">
      {text.split("\n").filter(Boolean).map((line, i) => {
        if (line.startsWith("#")) return <p key={i} className="mt-2 font-medium">{line.replace(/^#+\s*/, "")}</p>;
        if (line.startsWith("|")) return <p key={i} className="text-xs text-muted-foreground">{line}</p>;
        return <p key={i}>{line}</p>;
      })}
    </div>
  );
}

/** 文献库详情划词 → AI 卡片(2026-08-29, 与 MD 划词阅读器一致)
 *  监听详情容器内划选, 弹 ReaderAiCard(解释/总结/翻译/追问) */
function DetailSelectionWatcher({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  const [selection, setSelection] = useState<{ snippet: string; anchor: { x: number; y: number } } | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onMouseUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return;
      const text = sel.toString().replace(/\s+/g, " ").trim();
      if (text.length < 2 || text.length > 3000) return;
      const rect = range.getBoundingClientRect();
      setSelection({ snippet: text, anchor: { x: rect.left + rect.width / 2, y: rect.top } });
    };
    el.addEventListener("mouseup", onMouseUp);
    return () => el.removeEventListener("mouseup", onMouseUp);
  }, [containerRef]);
  return (
    <>
      {selection && (
        <ReaderAiCard
          key={selection.snippet.slice(0, 40)}
          snippet={selection.snippet}
          anchor={selection.anchor}
          onClose={() => setSelection(null)}
        />
      )}
    </>
  );
}

function FilterChip(props: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "block w-full truncate rounded px-2 py-1 text-left text-sm transition-colors",
        props.active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
      )}
    >
      {props.label}
    </button>
  );
}

function ButtonSmall(props: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
    >
      {props.children}
    </button>
  );
}
