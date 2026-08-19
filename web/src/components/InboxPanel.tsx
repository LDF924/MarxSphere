// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// InboxPanel.tsx — Inbox 待办事项（GBrain /inbox 适配）
// 简单待办列表 + localStorage 持久化 + 完成/删除
import { useEffect, useState } from "react";
import { Inbox as InboxIcon, Plus, Trash2, CheckCircle2, Circle } from "lucide-react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

const STORAGE_KEY = "sag:inbox:v1";

function loadTodos(): TodoItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TodoItem[]) : [];
  } catch {
    return [];
  }
}

export function InboxPanel() {
  const [todos, setTodos] = useState<TodoItem[]>(() => loadTodos());
  const [newText, setNewText] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
    } catch { /* 忽略 */ }
  }, [todos]);

  const addTodo = () => {
    if (!newText.trim()) return;
    setTodos((prev) => [
      { id: `todo-${Date.now()}`, text: newText.trim(), done: false, createdAt: new Date().toISOString() },
      ...prev
    ]);
    setNewText("");
  };

  const toggleTodo = (id: string) => {
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  };

  const removeTodo = (id: string) => {
    setTodos((prev) => prev.filter((t) => t.id !== id));
  };

  const doneCount = todos.filter((t) => t.done).length;

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto w-full max-w-[1100px] space-y-4">
        <div className="flex items-center gap-2">
          <InboxIcon className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Inbox 待办</h2>
          <span className="text-xs text-muted-foreground">{doneCount}/{todos.length} 完成</span>
        </div>

        <div className="flex gap-2">
          <input
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) addTodo(); }}
            placeholder="记录待办事项（如：图谱数据入库方案待选）…"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <Button size="sm" onClick={addTodo} disabled={!newText.trim()}>
            <Plus className="mr-1 h-3.5 w-3.5" /> 添加
          </Button>
        </div>

        <Card className="p-3">
          {todos.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">暂无待办。记录你的研究待办事项。</div>
          ) : (
            <div className="space-y-1.5">
              {todos.map((todo) => (
                <div key={todo.id} className="group flex items-center gap-2 rounded border border-border/60 px-3 py-2">
                  <button type="button" onClick={() => toggleTodo(todo.id)} className="shrink-0 text-muted-foreground hover:text-primary">
                    {todo.done ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <Circle className="h-4 w-4" />}
                  </button>
                  <span className={cn("min-w-0 flex-1 text-sm", todo.done && "text-muted-foreground line-through")}>{todo.text}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{new Date(todo.createdAt).toLocaleDateString("zh-CN")}</span>
                  <button
                    type="button"
                    onClick={() => removeTodo(todo.id)}
                    className="relative z-10 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-red-50 hover:text-red-600"
                    title="删除这条待办"
                    aria-label={`删除待办 ${todo.text}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </section>
  );
}
