// BackupPanel.tsx — 知识库备份/恢复面板(P1: .sagbak)
// 功能: 创建备份(异步任务+轮询) / 列表(大小/时间/校验) / 校验 / 恢复(二次确认) / 删除
import { useCallback, useEffect, useState } from "react";

// 本地 fetch 封装(api.ts 的 request 未导出)
async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((data as any)?.error?.message ?? `请求失败: ${response.status}`);
  }
  return data as T;
}
const apiGet = <T,>(url: string) => req<T>(url);
const apiPost = <T,>(url: string, body: unknown) => req<T>(url, { method: "POST", body: JSON.stringify(body ?? {}) });
const apiDelete = <T,>(url: string) => req<T>(url, { method: "DELETE" });

interface BackupEntry {
  id: string;
  name: string;
  size: number;
  createdAt: string;
  restoredAt: string | null;
  status: string;
  manifest: {
    counts: Record<string, number>;
    parts: Record<string, { sha256: string; size: number; nodes?: number; relationships?: number; skipped?: boolean }>;
    warnings: string[];
  } | null;
}

interface JobStatus {
  id: string;
  status: string;
  result?: unknown;
  error?: string;
}

function fmtSize(bytes: number): string {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

export function BackupPanel() {
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [creating, setCreating] = useState(false);
  const [activeJob, setActiveJob] = useState<JobStatus | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = (await apiGet("/api/backup")) as { backups: BackupEntry[] };
      setBackups(data.backups ?? []);
    } catch (e) {
      setMessage({ kind: "err", text: `加载失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 任务轮询(5s)
  useEffect(() => {
    if (!activeJob) return;
    const timer = setInterval(async () => {
      try {
        const jobs = (await apiGet("/api/jobs")) as { jobs?: JobStatus[] };
        const found = (jobs.jobs ?? []).find((j) => j.id === activeJob.id);
        if (!found) return;
        setActiveJob(found);
        if (found.status === "completed" || found.status === "failed" || found.status === "dead" || found.status === "cancelled") {
          clearInterval(timer);
          setCreating(false);
          setBusyId(null);
          if (found.status === "completed") {
            setMessage({ kind: "ok", text: "任务完成" });
            void load();
          } else {
            setMessage({ kind: "err", text: `任务失败: ${found.error ?? found.status}` });
          }
        }
      } catch {
        // 轮询失败静默, 下轮重试
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [activeJob, load]);

  const createBackup = async () => {
    setCreating(true);
    setMessage(null);
    try {
      const data = (await apiPost("/api/backup", {})) as { job: JobStatus };
      setActiveJob(data.job);
    } catch (e) {
      setCreating(false);
      setMessage({ kind: "err", text: `创建失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const verifyBackup = async (id: string) => {
    setBusyId(id);
    try {
      const data = (await apiGet(`/api/backup/${id}/verify`)) as { ok: boolean; mismatches: string[] };
      setMessage(data.ok
        ? { kind: "ok", text: "校验通过: 所有部件 sha256 一致" }
        : { kind: "err", text: `校验失败: ${data.mismatches.join(", ")}` });
    } catch (e) {
      setMessage({ kind: "err", text: `校验出错: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusyId(null);
    }
  };

  const restoreBackup = async (id: string) => {
    setBusyId(id);
    setConfirmRestoreId(null);
    setMessage(null);
    try {
      const data = (await apiPost(`/api/backup/${id}/restore`, {})) as { job: JobStatus };
      setActiveJob(data.job);
      setMessage({ kind: "ok", text: "恢复任务已提交(全量替换, 完成后请刷新页面)" });
    } catch (e) {
      setBusyId(null);
      setMessage({ kind: "err", text: `恢复提交失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const deleteBackup = async (id: string) => {
    if (!window.confirm("确认删除该备份? 不可恢复!")) return;
    try {
      await apiDelete(`/api/backup/${id}`);
      setMessage({ kind: "ok", text: "已删除" });
      void load();
    } catch (e) {
      setMessage({ kind: "err", text: `删除失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  return (
    <div style={{ padding: 20, maxWidth: 960 }}>
      <h2 style={{ marginBottom: 8 }}>知识库备份 / 恢复</h2>
      <p style={{ opacity: 0.7, marginBottom: 16, fontSize: 13 }}>
        .sagbak 轻量格式: PG 数据 + Graphiti/Cognee 图谱 + 清单校验(sha256)。
        与 E 盘每日 pg_dump 并存;LanceDB 位于仓库外,不在范围内。
      </p>

      {message && (
        <div style={{
          padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13,
          background: message.kind === "ok" ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)",
          color: message.kind === "ok" ? "#4ade80" : "#f87171",
        }}>
          {message.text}
        </div>
      )}

      <button
        onClick={createBackup}
        disabled={creating}
        style={{
          padding: "8px 20px", borderRadius: 6, border: "none", cursor: creating ? "wait" : "pointer",
          background: "hsl(214 60% 55%)", color: "#fff", fontWeight: 600,
        }}
      >
        {creating ? "创建中(后台任务)…" : "创建备份"}
      </button>
      {activeJob && (activeJob.status === "waiting" || activeJob.status === "active") && (
        <span style={{ marginLeft: 12, opacity: 0.7, fontSize: 13 }}>
          任务 {activeJob.status === "waiting" ? "排队中" : "执行中"}…(备份 18 万行 + 图谱 30 万关系约需数分钟)
        </span>
      )}

      <table style={{ marginTop: 20, width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", opacity: 0.6 }}>
            <th style={{ padding: "6px 8px" }}>名称</th>
            <th>时间</th>
            <th>大小</th>
            <th>数据统计</th>
            <th>图谱</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {backups.length === 0 && (
            <tr><td colSpan={7} style={{ padding: 20, textAlign: "center", opacity: 0.5 }}>暂无备份</td></tr>
          )}
          {backups.map((b) => {
            const counts = b.manifest?.counts ?? {};
            const graphiti = b.manifest?.parts?.["neo4j_graphiti.json"];
            const cognee = b.manifest?.parts?.["neo4j_cognee.json"];
            const graphSummary = graphiti?.skipped && cognee?.skipped
              ? "跳过"
              : `${graphiti?.nodes ?? "-"}/${graphiti?.relationships ?? "-"} · ${cognee?.nodes ?? "-"}/${cognee?.relationships ?? "-"}`;
            return (
              <tr key={b.id} style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                <td style={{ padding: "8px" }}>{b.name}</td>
                <td>{fmtTime(b.createdAt)}</td>
                <td>{fmtSize(b.size)}</td>
                <td style={{ opacity: 0.75 }}>
                  doc {counts.documents ?? 0} · ev {counts.events ?? 0} · ent {counts.entities ?? 0} · ee {counts.event_entities ?? 0}
                </td>
                <td style={{ opacity: 0.75, fontSize: 12 }}>{graphSummary}</td>
                <td style={{ opacity: 0.75 }}>{b.restoredAt ? `已恢复 ${fmtTime(b.restoredAt)}` : b.status}</td>
                <td>
                  <button onClick={() => void verifyBackup(b.id)} disabled={busyId === b.id} style={btnStyle}>校验</button>
                  {confirmRestoreId === b.id ? (
                    <span>
                      <button onClick={() => void restoreBackup(b.id)} style={{ ...btnStyle, background: "#ef4444" }}>确认恢复</button>
                      <button onClick={() => setConfirmRestoreId(null)} style={btnStyle}>取消</button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmRestoreId(b.id)} style={btnStyle}>恢复</button>
                  )}
                  <button onClick={() => void deleteBackup(b.id)} style={{ ...btnStyle, opacity: 0.6 }}>删除</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {confirmRestoreId && (
        <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 6, fontSize: 13, background: "rgba(239,68,68,0.15)" }}>
          ⚠ 恢复将<b>全量替换</b>当前知识库(PG + 图谱),请确认已了解风险后再点"确认恢复"。
        </div>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "3px 10px", marginRight: 6, borderRadius: 4, border: "none",
  cursor: "pointer", background: "rgba(255,255,255,0.1)", color: "inherit", fontSize: 12,
};
