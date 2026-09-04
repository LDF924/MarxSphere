// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// test/meta-skill-propose.test.ts — V404-10: auto_propose→MetaSkill DAG 衔接(纯函数/状态机)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = path.join(os.tmpdir(), `sag-dagprop-${process.pid}`);
process.env.SAG_DAG_PROPOSALS_DIR = TEST_DIR;

let mod: typeof import("../src/services/meta-skill-propose-service.js");
beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mod = await import("../src/services/meta-skill-propose-service.js");
});
afterAll(() => { rmSync(TEST_DIR, { recursive: true, force: true }); });

function fakeProposal(over: Record<string, unknown> = {}) {
  return {
    id: "dagp-test-1", sourceSkillIds: [1, 2], sourceSkillNames: ["a", "b"],
    triggerGoal: "选题分析", seenCount: 5,
    dag: { id: "dag_test", name: "测试DAG", description: "desc", steps: [{ id: "s1", kind: "llm_chat" }] },
    status: "proposed" as const, createdAt: new Date().toISOString(), ...over,
  };
}

describe("meta-skill-propose (V404-10)", () => {
  it("listDagProposals: 空目录 → []", () => {
    expect(mod!.listDagProposals()).toEqual([]);
  });

  it("rejectDagProposal: 不存在 id → 报错", () => {
    const r = mod!.rejectDagProposal("nope");
    expect(r.ok).toBe(false);
  });

  it("acceptDagProposal: 不存在 id → 报错; 文件缺失也安全", async () => {
    const r = await mod!.acceptDagProposal("nope");
    expect(r.ok).toBe(false);
  });
});
