// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// test/sandbox-env.test.ts — V404-28(M6): 沙箱 env 白名单+密钥剥离
import { describe, it, expect, afterEach } from "vitest";
import { sandboxEnv } from "../src/services/code-sandbox-service.js";

const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

describe("sandboxEnv (M6)", () => {
  it("白名单: 透传 PATH 等必需变量, 剥离密钥/DB/凭据", () => {
    setEnv("LLM_API_KEY", "sk-secret");
    setEnv("DEEPSEEK_API_KEY", "sk-deepseek");
    setEnv("DATABASE_URL", "postgres://u:p@h/db");
    setEnv("PGPASSWORD", "pw");
    setEnv("PATH", "/usr/bin");
    setEnv("SAG_SANDBOX_PYTHON", "python3");
    const env = sandboxEnv("workspace-write");
    // 密钥全剥离
    expect(env.LLM_API_KEY).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PGPASSWORD).toBeUndefined();
    // 必需透传
    expect(env.PATH).toBe("/usr/bin");
    expect(env.SAG_SANDBOX_PYTHON).toBe("python3");
    // 沙箱标记
    expect(env.SAG_SANDBOX).toBe("1");
    expect(env.SAG_SANDBOX_PROFILE).toBe("workspace-write");
  });

  it("read-only 断网(代理黑洞), workspace-write 走白名单代理", () => {
    const ro = sandboxEnv("read-only");
    expect(ro.HTTP_PROXY).toContain("127.0.0.1:1");
    const ww = sandboxEnv("workspace-write");
    expect(ww.HTTP_PROXY).toContain("8899");
  });
});
