// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// DataVersionBar.tsx — 数据版本选择（V380+）: 变量白名单唯一真源
// V399-2 P2 补齐: 数据哈希(内容级判重/溯源) + 登记时自动画像(列类型/缺失率)展示
import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import { apiEmpiricalWorkshop, type EmpiricalDataVersion } from "../../lib/api";

/** V399-2 P2: 数据画像摘要 — 同内容哈希的版本标"重复内容", 画像显示列类型/缺失率 */
function ProfileSummary({ v }: { v: EmpiricalDataVersion }) {
  const profile = (v.meta?.profile ?? {}) as Record<string, { type?: string; missing_rate?: number }>;
  const cols = Object.entries(profile);
  if (cols.length === 0) return null;
  const numeric = cols.filter(([, p]) => p.type === "numeric").length;
  const categorical = cols.filter(([, p]) => p.type === "categorical").length;
  const missing = cols.filter(([, p]) => (p.missing_rate ?? 0) > 0).length;
  return (
    <span className="text-[9px] text-muted-foreground" title={`列画像: ${cols.map(([c, p]) => `${c}=${p.type}${p.missing_rate ? `(缺失${(p.missing_rate * 100).toFixed(0)}%)` : ""}`).join(", ")}`}>
      画像: {numeric}数值/{categorical}分类{missing > 0 ? `/${missing}列有缺失` : ""}
    </span>
  );
}

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
  // V399-2 P2: 同内容哈希重复的版本（同数据换了名字重新登记）→ 提示
  const hashCounts = new Map<string, number>();
  for (const v of versions) if (v.contentHash) hashCounts.set(v.contentHash, (hashCounts.get(v.contentHash) ?? 0) + 1);

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
          <option key={v.id} value={v.id}>
            {v.name} ({v.nRows}行×{v.columns.length}列)
            {v.contentHash && (hashCounts.get(v.contentHash) ?? 0) > 1 ? " (重复内容)" : ""}
          </option>
        ))}
      </select>
      {current && (
        <span className="text-[9px] text-muted-foreground">
          列: {current.columns.slice(0, 8).join(", ")}{current.columns.length > 8 ? ` +${current.columns.length - 8}` : ""}
        </span>
      )}
      {current && <ProfileSummary v={current} />}
      {current?.contentHash && (
        <span className="text-[9px] text-muted-foreground" title={`数据哈希: ${current.contentHash}`}>
          哈希: {current.contentHash.substring(0, 8)}…
        </span>
      )}
    </div>
  );
}
