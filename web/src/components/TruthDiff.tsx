// TruthDiff.tsx — Compiled Truth 重写 diff 对比（GBrain Synthesize 适配）
// 行级对比：删除行红底、新增行绿底、修改行黄底（简化 Myers diff）
import { useMemo } from "react";
import { cn } from "../lib/utils";

function lineDiff(oldText: string, newText: string) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  // 简化 diff：按行 LCS 标记 added/removed/common
  const matrix: number[][] = Array.from({ length: oldLines.length + 1 }, () =>
    Array(newLines.length + 1).fill(0)
  );
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      matrix[i][j] = oldLines[i] === newLines[j]
        ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }
  const ops: Array<{ type: "same" | "removed" | "added"; text: string }> = [];
  let i = 0, j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "same", text: oldLines[i] });
      i++; j++;
    } else if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      ops.push({ type: "removed", text: oldLines[i] });
      i++;
    } else {
      ops.push({ type: "added", text: newLines[j] });
      j++;
    }
  }
  while (i < oldLines.length) ops.push({ type: "removed", text: oldLines[i++] });
  while (j < newLines.length) ops.push({ type: "added", text: newLines[j++] });
  return ops;
}

export function TruthDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const ops = useMemo(() => lineDiff(oldText, newText), [oldText, newText]);
  const added = ops.filter((o) => o.type === "added").length;
  const removed = ops.filter((o) => o.type === "removed").length;

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground">
        <span className="font-medium">Diff 预览</span>
        <span className="text-green-600">+{added} 新增</span>
        <span className="text-red-600">-{removed} 删除</span>
      </div>
      <div className="max-h-48 overflow-auto p-2 text-xs leading-5">
        {ops.map((op, index) => (
          <div
            key={index}
            className={cn(
              "whitespace-pre-wrap rounded px-1",
              op.type === "removed" && "bg-red-50 text-red-700 line-through decoration-red-300",
              op.type === "added" && "bg-green-50 text-green-700",
              op.type === "same" && "text-foreground/80"
            )}
          >
            {op.type === "removed" ? "- " : op.type === "added" ? "+ " : ""}{op.text || " "}
          </div>
        ))}
      </div>
    </div>
  );
}
