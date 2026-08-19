// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// FeedbackButtons.tsx — 用户反馈闭环（V375）
// 回答区 👍👎 → POST /api/feedback → OpenViking 长期记忆（强化偏好/纠正约束）
// 点赞: 记录"用户认可的回答风格" 踩: 记录"需改进的点" + 可填备注
import { useState } from "react";
import { ThumbsUp, ThumbsDown, Check } from "lucide-react";
import { cn } from "../lib/utils";

interface FeedbackButtonsProps {
  /** 用户问题 */
  query: string;
  /** 回答内容 */
  answer: string;
  /** 组件标题（可选） */
  label?: string;
}

export function FeedbackButtons({ query, answer, label }: FeedbackButtonsProps) {
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (type: "up" | "down") => {
    setFeedback(type);
    if (type === "down") { setShowNote(true); return; } // 踩先让用户填备注
    setSaving(true);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: type, query, answer: answer.substring(0, 1000) }),
      });
      setDone(true);
    } catch { /* 失败静默 */ }
    setSaving(false);
  };

  const submitWithNote = async () => {
    setSaving(true);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "down", query, answer: answer.substring(0, 1000), note }),
      });
      setShowNote(false);
      setDone(true);
    } catch { /* 失败静默 */ }
    setSaving(false);
  };

  if (done) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-green-600">
        <Check className="h-3 w-3" /> 反馈已记入长期记忆{feedback === "down" && "（下次同类问题将改进）"}
      </div>
    );
  }

  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">{label ?? "这个回答有帮助吗？"}</span>
        <button
          onClick={() => void submit("up")}
          disabled={saving}
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors",
            feedback === "up" ? "bg-green-100 text-green-700" : "text-muted-foreground hover:bg-muted"
          )}
          title="回答有帮助，记住我的偏好"
        >
          <ThumbsUp className="h-3 w-3" /> 有帮助
        </button>
        <button
          onClick={() => void submit("down")}
          disabled={saving}
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors",
            feedback === "down" ? "bg-red-100 text-red-700" : "text-muted-foreground hover:bg-muted"
          )}
          title="回答不满意，改进方向"
        >
          <ThumbsDown className="h-3 w-3" /> 需改进
        </button>
      </div>
      {showNote && (
        <div className="mt-1.5 flex gap-1.5">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="哪里不满意？（可选）如：不够具体 / 引用缺失…"
            className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-[10px]"
            autoFocus
          />
          <button onClick={() => void submitWithNote()} disabled={saving} className="rounded bg-primary px-2 py-1 text-[10px] text-primary-foreground">
            提交
          </button>
          <button onClick={() => { setShowNote(false); setFeedback(null); }} className="rounded border px-2 py-1 text-[10px] text-muted-foreground">
            取消
          </button>
        </div>
      )}
    </div>
  );
}
