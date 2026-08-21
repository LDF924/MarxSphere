// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// EduFeedbackFAB.tsx — 教育功能反馈浮标（V397）
// 学生端/教师端工作台右下角悬浮：👍 有帮助 / 👎 没帮助 + 可选备注
// 提交 → /api/education/feedback（脱敏落库）；统计 → /api/education/feedback/stats
import { useState, useEffect } from "react";
import { MessageSquareText, ThumbsUp, ThumbsDown } from "lucide-react";

const API = "/api/education";

export function EduFeedbackFAB({ role, scene, source }: { role: "student" | "teacher"; scene?: string; source?: string }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<null | "ok" | "err">(null);
  const [note, setNote] = useState("");
  const [stats, setStats] = useState<{ summary?: { total: number; likes: number; dislikes: number; likeRate: number } } | null>(null);

  const loadStats = async () => {
    try {
      const r = await fetch(`${API}/feedback/stats`);
      const d = await r.json();
      if (d.ok) setStats(d);
    } catch { /* 忽略 */ }
  };
  useEffect(() => { void loadStats(); }, []);

  const submit = async (fb: 1 | -1) => {
    setSent(null);
    try {
      const r = await fetch(`${API}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, scene: scene || "general", feedback: fb, note: note.trim() || undefined, source }),
      });
      const d = await r.json();
      setSent(d.ok ? "ok" : "err");
      if (d.ok) { setNote(""); setOpen(false); void loadStats(); }
    } catch { setSent("err"); }
  };

  return (
    <div className="fixed bottom-5 right-5 z-40 flex flex-col items-end gap-2">
      {open && (
        <div className="w-64 rounded-xl border bg-card p-3 shadow-lg">
          <div className="mb-1.5 text-xs font-medium text-foreground/80">这个功能对你有帮助吗？</div>
          <div className="flex gap-1.5">
            <button type="button" onClick={() => void submit(1)}
              className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-emerald-300 bg-white py-1.5 text-xs text-emerald-700 hover:bg-emerald-50">
              <ThumbsUp className="h-3.5 w-3.5" /> 有帮助
            </button>
            <button type="button" onClick={() => void submit(-1)}
              className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-red-200 bg-white py-1.5 text-xs text-red-600 hover:bg-red-50">
              <ThumbsDown className="h-3.5 w-3.5" /> 没帮助
            </button>
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="可选：补充说明（脱敏存储）"
            className="mt-2 h-7 w-full rounded border bg-background px-2 text-xs outline-none focus:border-emerald-400"
          />
          {sent === "ok" && <div className="mt-1 text-[10px] text-emerald-600">✓ 反馈已记录（脱敏存储）</div>}
          {sent === "err" && <div className="mt-1 text-[10px] text-red-500">提交失败，请重试</div>}
        </div>
      )}
      <button
        type="button"
        onClick={() => { setOpen((c) => !c); setSent(null); }}
        className="flex items-center gap-1.5 rounded-full border border-emerald-200 bg-white px-3 py-2 text-xs text-emerald-700 shadow-md hover:bg-emerald-50"
        title="教育功能反馈"
      >
        <MessageSquareText className="h-3.5 w-3.5" />
        功能反馈
        {stats?.summary && stats.summary.total > 0 && (
          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] text-emerald-700">
            👍{stats.summary.likes}·{stats.summary.likeRate}%
          </span>
        )}
      </button>
    </div>
  );
}
