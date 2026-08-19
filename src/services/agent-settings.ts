// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-settings.ts — 借鉴 DSH settings 包: Agent 设置持久化
// 预设/自主级别 等运行时设置落库（重启保持）; 环境变量优先级高于 DB（启动时 DB 覆盖）
import { pool } from "../db/pool.js";

export type SettingKey = "preset" | "autonomy" | "sandbox_profile" | "tool_whitelist";

/** 读设置（DB; 不存在返回 null） */
export async function getAgentSetting(key: SettingKey): Promise<unknown | null> {
  try {
    const r = await pool.query("select value from agent_settings where key = $1", [key]);
    return r.rows[0]?.value ?? null;
  } catch { return null; }
}

/** 写设置（upsert） */
export async function setAgentSetting(key: SettingKey, value: unknown): Promise<boolean> {
  try {
    await pool.query(
      `insert into agent_settings (key, value, updated_at) values ($1, $2::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
    return true;
  } catch { return false; }
}

/** 启动恢复: 从 DB 加载持久化设置（预设/自主级别/沙箱级别）— 在 index.ts 启动钩子调用 */
export async function restoreAgentSettings(): Promise<{ restored: string[] }> {
  const restored: string[] = [];
  try {
    const preset = await getAgentSetting("preset");
    if (typeof preset === "string") {
      const { setActivePreset } = await import("./agent-presets.js");
      if (setActivePreset(preset as any)) restored.push(`preset=${preset}`);
    }
    const autonomy = await getAgentSetting("autonomy");
    if (typeof autonomy === "string") {
      const { setAutonomyLevel } = await import("./agent-autonomy.js");
      if (setAutonomyLevel(autonomy as any)) restored.push(`autonomy=${autonomy}`);
    }
    const sandbox = await getAgentSetting("sandbox_profile");
    if (typeof sandbox === "string") {
      // 沙箱级别通过环境变量透传（DB 值写入 env 供 defaultSandboxProfile 读取）
      process.env.AGENT_SANDBOX_PROFILE = sandbox;
      restored.push(`sandbox=${sandbox}`);
    }
    if (restored.length > 0) {
      console.log(`[agent] 差距P③ 设置恢复: ${restored.join(", ")}`);
    }
  } catch (e: any) {
    console.error("[agent] 设置恢复失败:", String(e?.message || e).slice(0, 100));
  }
  return { restored };
}

export const agentSettingsService = { getAgentSetting, setAgentSetting, restoreAgentSettings };
