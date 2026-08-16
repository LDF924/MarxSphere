// DataVersionBar.tsx — 数据版本选择（V380+）: 变量白名单唯一真源
import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import { apiEmpiricalWorkshop, type EmpiricalDataVersion } from "../../lib/api";

export function DataVersionBar({
  projectId, value, onChange,
}: { projectId?: string; value?: string | null; onChange: (v: EmpiricalDataVersion | null) => void }) {
  const [versions, setVersions] = useState<EmpiricalDataVersion[]>([]);

  useEffect(() => {
    void apiEmpiricalWorkshop.dataVersions(projectId).then((r) => {
      setVersions(r.versions);
      if (r.versions.length > 0 && !value) onChange(r.versions[0]);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const current = versions.find((v) => v.id === value) ?? null;

  return (
    <div className="flex items-center gap-1.5 rounded-md border bg-card px-2 py-1">
      <Database className="h-3 w-3 text-emerald-600" />
      <span className="text-[10px] font-medium text-muted-foreground">数据版本</span>
      <select
        className="rounded border bg-background px-1.5 py-0.5 text-[10px]"
        value={value ?? ""}
        onChange={(e) => onChange(versions.find((v) => v.id === e.target.value) ?? null)}
      >
        <option value="">(选择数据版本)</option>
        {versions.map((v) => (
          <option key={v.id} value={v.id}>{v.name} ({v.nRows}行×{v.columns.length}列)</option>
        ))}
      </select>
      {current && (
        <span className="text-[9px] text-muted-foreground">
          列: {current.columns.slice(0, 8).join(", ")}{current.columns.length > 8 ? ` +${current.columns.length - 8}` : ""}
        </span>
      )}
    </div>
  );
}
