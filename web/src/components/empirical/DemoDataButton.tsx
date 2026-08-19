// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// DemoDataButton.tsx — 「载入演示数据」按钮（V380+）
// 加载基于《农村经营形态调查问卷(最终打印版).pdf》生成的 50 份全量模拟作答(269列)
// 用法: <DemoDataButton onLoad={(data) => setParsed(data)} />
import { useState } from "react";
import { Wand2, Loader2 } from "lucide-react";
import { apiEmpiricalDemo } from "../../lib/api";

export function DemoDataButton({ onLoad, label, missing, hint }: {
  onLoad: (data: { columnOrder: string[]; rows: (string | number | null)[][] }) => void;
  label?: string; missing?: boolean; hint?: string;
}) {
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      const r = await apiEmpiricalDemo.load(missing);
      if (r.ok && r.data) {
        onLoad(r.data);
      }
    } finally { setBusy(false); }
  };

  return (
    <button
      onClick={() => void load()}
      disabled={busy}
      title={hint ?? (missing ? "载入 50 份含缺失的模拟作答(15%空值/-88拒答/乱答), 供 LLM 插补演示" : "载入 50 份基于真实问卷模板生成的模拟作答(269列, 含多选哑变量/跳转逻辑)")}
      className="flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] hover:bg-accent disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3 text-emerald-600" />}
      {busy ? "载入中…" : (label ?? "载入演示数据")}
    </button>
  );
}
