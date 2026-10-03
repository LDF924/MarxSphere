// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// ForumPanel.tsx — 学友论坛(2026-10-03)
//
// 由来(用户): 「我需要一个类似百度贴吧和知乎这样的, 作为独立的 tab, 放在系统管理的右侧,
//   命名为: 学友论坛, 你参考百度贴吧和知乎的设计做一个出来」。
//
// ═══ 三栏结构 —— 直接对应两个参照物的**信息架构**, 不是抄像素 ═══
//   左栏 = 板块(贴吧的"吧") + 我的分类(收藏/我的帖/精华)
//   中栏 = 主题列表。**置顶永远最前, 其余按最后回复排序** —— 这是贴吧最核心的语义:
//          一条老帖只要有人回就该回到第一屏。按发帖时间排会让论坛只有新帖有曝光。
//   右栏 = 板块信息 + 今日动态 + 最近回复(知乎右栏的位置, 内容换成本平台有的数据)
//
//   详情页 = 楼主 + 楼层(按时间正序, 有楼层感) + 楼中楼(只两层) + 赞同/收藏。
//   没做"踩" —— 负反馈在学术讨论里是噪声, 且诱发拉踩。
import { useEffect, useMemo, useState } from "react";
import {
  MessageSquare, Loader2, Pin, Star, ThumbsUp, Plus, Search, Flame, Clock,
  Bookmark, User as UserIcon, Eye, MessagesSquare, ShieldCheck, Trash2, Sparkles, ChevronLeft, X, Send,
} from "lucide-react";
import { cn } from "../lib/utils";
import { api } from "../lib/api";
import { PanelNotice, panelInputCls } from "./PanelShell";
import type { ForumThread, ForumReply } from "../types";

interface Board { id: string; slug: string; name: string; description: string; sortOrder: number; isBuiltin: boolean; threadCount: number; todayCount: number; lastReplyAt: string | null }

const SORTS = [
  { key: "active", label: "最新回复", icon: <Clock className="h-3 w-3" /> },
  { key: "new", label: "最新发布", icon: <Sparkles className="h-3 w-3" /> },
  { key: "hot", label: "最热", icon: <Flame className="h-3 w-3" /> },
] as const;

/** 相对时间 —— 论坛里"3 分钟前"比绝对时间好读得多(贴吧/知乎都是这么显示的) */
function relTime(iso: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const d = Date.now() - t;
  if (d < 60_000) return "刚刚";
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3600_000)} 小时前`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  return iso.slice(0, 10);
}

export function ForumPanel() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [board, setBoard] = useState<string>("");
  const [sort, setSort] = useState<"active" | "new" | "hot">("active");
  const [q, setQ] = useState("");
  const [threads, setThreads] = useState<ForumThread[]>([]);
  const [stats, setStats] = useState<{ boards: number; threads: number; replies: number; todayThreads: number; todayReplies: number; members: number } | null>(null);
  const [recent, setRecent] = useState<Array<{ threadId: string; title: string; author: string; at: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  /** 当前打开的帖 */
  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<ForumThread | null>(null);
  const [replies, setReplies] = useState<ForumReply[]>([]);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 发帖表单 */
  const [compose, setCompose] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newTags, setNewTags] = useState("");

  const [admin, setAdmin] = useState(false);

  const loadBoards = async () => {
    try {
      const b = await api.getForumBoards();
      setBoards(b.boards);
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
  };
  const loadThreads = async () => {
    setLoading(true); setErr("");
    try {
      const r = await api.getForumThreads({ board, q: q.trim(), sort });
      setThreads(r.threads);
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
    finally { setLoading(false); }
  };
  const loadSide = async () => {
    try {
      const s = await api.getForumStats();
      setStats(s.stats); setRecent(s.recent);
    } catch { /* 侧栏取不到不影响主列表 */ }
  };

  useEffect(() => { void loadBoards(); void loadSide(); }, []);
  useEffect(() => { void loadThreads(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [board, sort]);

  // 管理员判定: 借用一个只有管理员才成功的动作反推。置顶/加精按钮据此显隐。
  useEffect(() => {
    api.moderateForum("00000000-0000-0000-0000-000000000000", "pin")
      .then(() => setAdmin(true))
      .catch((e) => setAdmin(!/403|只有管理员/.test(String((e as Error)?.message ?? ""))));
  }, []);

  const openThread = async (id: string) => {
    setOpenId(id); setThread(null); setReplies([]); setDraft(""); setReplyTo(null);
    try {
      const d = await api.getForumThread(id);
      setThread(d.thread); setReplies(d.replies);
      // 读一次会 +1 浏览, 列表里的数字要跟上
      setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, viewCount: t.viewCount + 1 } : t)));
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
  };

  const doPost = async () => {
    if (!board && !boards.length) { setErr("还没有板块"); return; }
    const target = board || boards[0]?.slug || "";
    if (newTitle.trim().length < 2) { setErr("标题至少 2 个字"); return; }
    setBusy(true); setErr("");
    try {
      const r = await api.createForumThread({
        board: target, title: newTitle.trim(), body: newBody.trim(),
        tags: newTags.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean),
      });
      setCompose(false); setNewTitle(""); setNewBody(""); setNewTags("");
      setMsg("已发布");
      await loadThreads(); await loadSide(); await loadBoards();
      await openThread(r.id);
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
    finally { setBusy(false); }
  };

  const doReply = async () => {
    if (!openId || !draft.trim()) return;
    setBusy(true); setErr("");
    try {
      await api.addForumReply(openId, draft.trim(), replyTo);
      setDraft(""); setReplyTo(null);
      const d = await api.getForumThread(openId);
      setThread(d.thread); setReplies(d.replies);
      await loadSide();
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
    finally { setBusy(false); }
  };

  const doVote = async (targetType: "thread" | "reply", id: string) => {
    try {
      const r = await api.voteForum(targetType, id);
      if (targetType === "thread") setThread((t) => (t ? { ...t, voted: r.voted, voteCount: r.count } : t));
      else setReplies((rs) => rs.map((x) => (x.id === id ? { ...x, voted: r.voted, voteCount: r.count } : x)));
      setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, voted: r.voted, voteCount: r.count } : t)));
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
  };

  const doStar = async (id: string) => {
    try {
      const r = await api.starForum(id);
      setThread((t) => (t && t.id === id ? { ...t, starred: r.starred } : t));
      setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, starred: r.starred } : t)));
      setMsg(r.starred ? "已收藏" : "已取消收藏");
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
  };

  const doModerate = async (id: string, action: "pin" | "unpin" | "digest" | "undigest" | "delete") => {
    if (action === "delete" && !window.confirm("删掉这个帖子？楼层会一起删除，不可恢复。")) return;
    try {
      await api.moderateForum(id, action);
      await loadThreads();
      if (openId === id) {
        if (action === "delete") { setOpenId(null); setThread(null); }
        else {
          const d = await api.getForumThread(id);
          setThread(d.thread); setReplies(d.replies);
        }
      }
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
  };

  /** 楼中楼归位: 顶层楼层按时间, 其下的子回复紧随其后 */
  const tree = useMemo(() => {
    const tops = replies.filter((r) => !r.parentId);
    const byParent = new Map<string, ForumReply[]>();
    for (const r of replies) if (r.parentId) {
      const list = byParent.get(r.parentId) ?? [];
      list.push(r); byParent.set(r.parentId, list);
    }
    return { tops, byParent };
  }, [replies]);

  const currentBoard = boards.find((b) => b.slug === board);

  // ══════════════ 帖子详情(整页, 与列表二选一) ══════════════
  if (openId) {
    return (
      <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div className="mx-auto w-full max-w-[1100px] space-y-3">
          <button type="button" onClick={() => { setOpenId(null); setThread(null); }} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" data-control="forum:back">
            <ChevronLeft className="h-3 w-3" />返回列表
          </button>

          {err ? <PanelNotice type="err">{err}</PanelNotice> : null}
          {msg ? <PanelNotice type="ok">{msg}</PanelNotice> : null}

          {!thread ? (
            <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
          ) : (
            <>
              {/* 楼主 */}
              <div className="rounded-lg border border-border p-4">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {thread.pinned ? <Pin className="h-3.5 w-3.5 text-primary" /> : null}
                      {thread.digest ? <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-300">精华</span> : null}
                      <h1 className="text-lg font-semibold leading-snug">{thread.title}</h1>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1"><UserIcon className="h-3 w-3" />{thread.author}</span>
                      <span className="rounded bg-accent px-1.5 py-0.5 text-foreground/70">{thread.boardName}</span>
                      <span>{relTime(thread.createdAt)}</span>
                      <span className="inline-flex items-center gap-1"><Eye className="h-3 w-3" />{thread.viewCount}</span>
                      <span className="inline-flex items-center gap-1"><MessagesSquare className="h-3 w-3" />{thread.replyCount}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button" onClick={() => void doVote("thread", thread.id)}
                      className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs", thread.voted ? "border-primary/50 bg-primary/10 text-primary" : "border-border hover:bg-accent")}
                      data-control="forum:vote-thread">
                      <ThumbsUp className="h-3 w-3" />{thread.voteCount}
                    </button>
                    <button type="button" onClick={() => void doStar(thread.id)}
                      className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs", thread.starred ? "border-amber-500/50 bg-amber-500/10 text-amber-300" : "border-border hover:bg-accent")}
                      data-control="forum:star-thread">
                      <Star className="h-3 w-3" />{thread.starred ? "已收藏" : "收藏"}
                    </button>
                    {admin ? (
                      <>
                        <button type="button" onClick={() => void doModerate(thread.id, thread.pinned ? "unpin" : "pin")} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent" title={thread.pinned ? "取消置顶" : "置顶"} data-control="forum:pin"><Pin className="h-3 w-3" /></button>
                        <button type="button" onClick={() => void doModerate(thread.id, thread.digest ? "undigest" : "digest")} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent" title={thread.digest ? "取消精华" : "加精"} data-control="forum:digest"><Sparkles className="h-3 w-3" /></button>
                        <button type="button" onClick={() => void doModerate(thread.id, "delete")} className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-300" title="删帖" data-control="forum:delete"><Trash2 className="h-3 w-3" /></button>
                      </>
                    ) : null}
                  </div>
                </div>
                {thread.tags.length ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {thread.tags.map((t) => <span key={t} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">#{t}</span>)}
                  </div>
                ) : null}
                <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{thread.excerpt}</div>
              </div>

              {/* 楼层 */}
              <div className="space-y-2">
                {tree.tops.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                    还没有人回复。抢个沙发？
                  </div>
                ) : tree.tops.map((r, i) => (
                  <div key={r.id} className="rounded-lg border border-border p-3" data-control="forum:floor">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="font-medium text-foreground/85">{r.author}</span>
                          <span className="rounded bg-muted px-1 text-[10px]">{i + 2} 楼</span>
                          <span>{relTime(r.createdAt)}</span>
                        </div>
                        <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{r.body}</div>
                        <div className="mt-1.5 flex items-center gap-3 text-[11px]">
                          <button type="button" onClick={() => void doVote("reply", r.id)}
                            className={cn("inline-flex items-center gap-1", r.voted ? "text-primary" : "text-muted-foreground hover:text-foreground")}>
                            <ThumbsUp className="h-3 w-3" />{r.voteCount || "赞同"}
                          </button>
                          <button type="button" onClick={() => setReplyTo(replyTo === r.id ? null : r.id)} className="text-muted-foreground hover:text-foreground">
                            {replyTo === r.id ? "取消回复" : "回复"}
                          </button>
                        </div>
                        {/* 楼中楼 */}
                        {(tree.byParent.get(r.id) ?? []).map((sub) => (
                          <div key={sub.id} className="mt-2 rounded border border-border/70 bg-muted/20 p-2">
                            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                              <span className="font-medium text-foreground/80">{sub.author}</span>
                              <span>{relTime(sub.createdAt)}</span>
                            </div>
                            <div className="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/85">{sub.body}</div>
                            <button type="button" onClick={() => void doVote("reply", sub.id)}
                              className={cn("mt-1 inline-flex items-center gap-1 text-[10px]", sub.voted ? "text-primary" : "text-muted-foreground hover:text-foreground")}>
                              <ThumbsUp className="h-2.5 w-2.5" />{sub.voteCount || "赞同"}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* 回复框 */}
              <div className="sticky bottom-0 rounded-lg border border-border bg-background/95 p-3 backdrop-blur">
                {replyTo ? (
                  <div className="mb-1.5 flex items-center gap-1 text-[11px] text-primary">
                    正在回复 {replies.find((x) => x.id === replyTo)?.author}
                    <button type="button" onClick={() => setReplyTo(null)} className="text-muted-foreground"><X className="h-3 w-3" /></button>
                  </div>
                ) : null}
                <div className="flex items-start gap-2">
                  <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3}
                    placeholder="写下你的看法…（Ctrl+Enter 发送）"
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void doReply(); } }}
                    className={cn(panelInputCls, "min-h-[4rem] flex-1 resize-y py-1.5")} data-control="forum:reply-input" />
                  <button type="button" onClick={() => void doReply()} disabled={busy || !draft.trim()}
                    className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50" data-control="forum:reply-send">
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />}回复
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    );
  }

  // ══════════════ 列表页(三栏) ══════════════
  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto w-full max-w-[1400px] space-y-3">
        {/* 头部 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <MessagesSquare className="h-4 w-4 text-primary" />学友论坛
          </div>
          <span className="text-xs text-muted-foreground">科研路上互相搭把手的地方</span>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={() => setCompose((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground" data-control="forum:compose">
              <Plus className="h-3 w-3" />发帖
            </button>
          </div>
        </div>

        {err ? <PanelNotice type="err">{err}</PanelNotice> : null}
        {msg ? <PanelNotice type="ok">{msg}</PanelNotice> : null}

        {/* 发帖 */}
        {compose ? (
          <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <select value={board || boards[0]?.slug || ""} onChange={(e) => setBoard(e.target.value)} className={cn(panelInputCls, "w-40 py-1")} data-control="forum:compose-board">
                {boards.map((b) => <option key={b.slug} value={b.slug}>{b.name}</option>)}
              </select>
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="标题（一句话说清你要问/要分享什么）"
                className={cn(panelInputCls, "min-w-[16rem] flex-1 py-1")} data-control="forum:compose-title" />
            </div>
            <textarea value={newBody} onChange={(e) => setNewBody(e.target.value)} rows={4}
              placeholder="正文…（背景、你试过什么、卡在哪）" className={cn(panelInputCls, "resize-y py-1.5")} data-control="forum:compose-body" />
            <div className="flex flex-wrap items-center gap-2">
              <input value={newTags} onChange={(e) => setNewTags(e.target.value)} placeholder="标签，空格分隔，如：回归 面板数据"
                className={cn(panelInputCls, "w-72 py-1")} data-control="forum:compose-tags" />
              <button type="button" onClick={() => void doPost()} disabled={busy} className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50" data-control="forum:compose-submit">
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}发布
              </button>
              <button type="button" onClick={() => setCompose(false)} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent">取消</button>
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-[200px_minmax(0,1fr)_260px]">
          {/* ── 左栏: 板块 ── */}
          <aside className="space-y-2">
            <div className="rounded-lg border border-border p-2">
              <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">板块</div>
              <button type="button" onClick={() => setBoard("")}
                className={cn("mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs", !board ? "bg-primary/10 text-primary" : "hover:bg-accent")}
                data-control="forum:board-all">
                <MessagesSquare className="h-3 w-3 shrink-0" />全部主题
                <span className="ml-auto opacity-60">{threads.length && !board ? threads.length : ""}</span>
              </button>
              {boards.map((b) => (
                <button key={b.slug} type="button" onClick={() => setBoard(b.slug)}
                  className={cn("mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs", board === b.slug ? "bg-primary/10 text-primary" : "hover:bg-accent")}
                  data-control={`forum:board-${b.slug}`}>
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                  {b.todayCount > 0 ? <span className="shrink-0 rounded bg-primary/15 px-1 text-[9px] text-primary">{b.todayCount}</span> : null}
                  <span className="shrink-0 opacity-60">{b.threadCount}</span>
                </button>
              ))}
            </div>
            <div className="rounded-lg border border-border p-2">
              <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">我的</div>
              {([["starred", "我的收藏", <Bookmark className="h-3 w-3" />], ["mine", "我的帖子", <UserIcon className="h-3 w-3" />]] as const).map(([k, label, icon]) => (
                <button key={k} type="button" onClick={() => { setBoard(""); setSort(k as never); void loadThreads(); }}
                  className={cn("mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs", (sort as string) === k ? "bg-primary/10 text-primary" : "hover:bg-accent")}>
                  {icon}{label}
                </button>
              ))}
            </div>
          </aside>

          {/* ── 中栏: 主题列表 ── */}
          <main className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {SORTS.map((s) => (
                <button key={s.key} type="button" onClick={() => setSort(s.key)}
                  className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs", sort === s.key ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent")}>
                  {s.icon}{s.label}
                </button>
              ))}
              <button type="button" onClick={() => { setBoard(""); setSort("digest" as never); void loadThreads(); }}
                className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs", (sort as string) === "digest" ? "border-amber-500/50 bg-amber-500/10 text-amber-300" : "border-border text-muted-foreground hover:bg-accent")}>
                <Sparkles className="h-3 w-3" />精华
              </button>
              <div className="relative ml-auto">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void loadThreads(); }}
                  placeholder="搜索标题 / 正文，回车" className="w-56 rounded-md border border-border bg-transparent py-1.5 pl-7 pr-2 text-xs" data-control="forum:search" />
              </div>
            </div>

            {loading ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载帖子…</div>
            ) : threads.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-xs text-muted-foreground">
                {q ? "没有匹配的帖子。" : "这个板块还没有帖子 —— 发第一帖吧。"}
              </div>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {threads.map((t) => (
                  <div key={t.id} className="flex items-start gap-3 p-3 transition-colors hover:bg-accent/30" data-control="forum:thread">
                    <button type="button" onClick={() => void openThread(t.id)} className="min-w-0 flex-1 text-left" data-control={`forum:open-${t.id.slice(0, 8)}`}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {t.pinned ? <span className="inline-flex items-center gap-0.5 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary"><Pin className="h-2.5 w-2.5" />置顶</span> : null}
                        {t.digest ? <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-300">精华</span> : null}
                        <span className="text-sm font-medium leading-snug">{t.title}</span>
                      </div>
                      <div className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{t.excerpt || "（无正文）"}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1"><UserIcon className="h-2.5 w-2.5" />{t.author}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5">{t.boardName}</span>
                        <span>{relTime(t.lastReplyAt || t.createdAt)}</span>
                        {t.tags.slice(0, 3).map((tag) => <span key={tag} className="text-primary/70">#{tag}</span>)}
                      </div>
                    </button>
                    <div className="flex shrink-0 items-center gap-3 text-[10px] text-muted-foreground">
                      <div className="flex flex-col items-center">
                        <span className="text-sm font-medium text-foreground/80">{t.replyCount}</span>
                        <span>回复</span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-sm font-medium text-foreground/80">{t.voteCount}</span>
                        <span>赞同</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </main>

          {/* ── 右栏: 概况 ── */}
          <aside className="space-y-2">
            {stats ? (
              <div className="rounded-lg border border-border p-3">
                <div className="mb-2 text-[11px] font-medium text-muted-foreground">{currentBoard ? currentBoard.name : "论坛概况"}</div>
                {currentBoard ? (
                  <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground/80">{currentBoard.description || "（暂无简介）"}</p>
                ) : null}
                <div className="grid grid-cols-2 gap-2 text-center">
                  {[
                    { n: stats.threads, l: "主题" }, { n: stats.replies, l: "回复" },
                    { n: stats.todayThreads, l: "今日新帖" }, { n: stats.todayReplies, l: "今日回复" },
                    { n: stats.boards, l: "板块" }, { n: stats.members, l: "发过言的学友" },
                  ].map((x) => (
                    <div key={x.l} className="rounded border border-border/60 py-1.5">
                      <div className="text-sm font-semibold text-accent-foreground">{x.n}</div>
                      <div className="text-[10px] text-muted-foreground">{x.l}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {recent.length ? (
              <div className="rounded-lg border border-border p-3">
                <div className="mb-2 text-[11px] font-medium text-muted-foreground">最近回复</div>
                <div className="space-y-1.5">
                  {recent.map((r) => (
                    <button key={r.threadId} type="button" onClick={() => void openThread(r.threadId)}
                      className="block w-full text-left text-[11px] leading-snug hover:text-primary">
                      <span className="line-clamp-1">{r.title}</span>
                      <span className="text-[10px] text-muted-foreground">{r.author} · {relTime(r.at)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="rounded-lg border border-border p-3 text-[10px] leading-relaxed text-muted-foreground/70">
              <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <ShieldCheck className="h-3 w-3" />发帖须知
              </div>
              提问请写清背景与已尝试的做法；争论对事不对人；帖子里请不要放他人未公开的数据。
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}

export default ForumPanel;
