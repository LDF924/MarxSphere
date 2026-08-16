// CodeBlock.tsx — 代码展示/复制/下载/「让 Agent 修复报错」（V380+）
import { useState } from "react";
import { Copy, Download, Wrench, Check, Loader2 } from "lucide-react";

export function CodeBlock({
  code, filename, onDebug, debugBusy,
}: { code: string; filename: string; onDebug?: (errorLog: string) => void; debugBusy?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [errorLog, setErrorLog] = useState("");

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  };

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-1 border-b bg-muted/30 px-2 py-1">
        <span className="font-mono text-[10px] text-muted-foreground">{filename}</span>
        <button className="ml-auto flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] hover:bg-accent" onClick={() => void copy()}>
          {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />} {copied ? "已复制" : "复制"}
        </button>
        <button className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] hover:bg-accent" onClick={download}>
          <Download className="h-3 w-3" /> 下载
        </button>
      </div>
      <pre className="max-h-96 overflow-auto p-2 font-mono text-[10px] leading-relaxed">{code}</pre>
      {onDebug && (
        <div className="border-t p-1.5">
          <div className="flex gap-1.5">
            <input
              className="flex-1 rounded border bg-background px-1.5 py-1 font-mono text-[9px]"
              placeholder="粘贴报错日志(如: command ologit is unrecognized r(199))…"
              value={errorLog}
              onChange={(e) => setErrorLog(e.target.value)}
            />
            <button className="flex items-center gap-1 rounded border px-2 py-1 text-[9px] hover:bg-accent" onClick={() => errorLog && onDebug?.(errorLog)} disabled={debugBusy}>
              {debugBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />} 让 Agent 修复
            </button>
          </div>
          <div className="mt-0.5 text-[8px] text-muted-foreground">⚠️ Agent 只修语法/API/变量名错误, 不做假设检验; 内生性/平行趋势由研究者判断</div>
        </div>
      )}
    </div>
  );
}
