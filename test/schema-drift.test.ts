// schema 漂移自检的文案与判定
//
// 由来(2026-09-26): `migrate()` 只补"本地有、库里没有"的迁移, **从不检查反方向** ——
// 于是在带新迁移的分支跑过、再切回旧分支时, 旧分支的迁移全都"已应用"被静默跳过,
// 服务带着比代码新的 schema 起来且毫无提示。
//
// 这里只测**纯函数** formatSchemaDrift 的三条分支。checkSchemaDrift 要连库,
// 归门禁/集成测; 而真正容易写错的是"什么情况算漂移"的判定与文案
// (尤其是"已知改名"不能算漂移、但也**不能静默吞掉**)。
import { describe, it, expect } from "vitest";
import { formatSchemaDrift, type SchemaDrift } from "../src/db/migrate.js";

const dir = "C:/repo/migrations";
const drift = (over: Partial<SchemaDrift> = {}): SchemaDrift => ({
  dbOnly: [],
  localOnly: [],
  dbTotal: 159,
  knownRenamed: [],
  ...over,
});

describe("formatSchemaDrift", () => {
  it("无漂移 → ok, 且报出迁移总数", () => {
    const r = formatSchemaDrift(drift(), { migrationsDir: dir });
    expect(r.ok).toBe(true);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("schema 与代码一致");
    expect(r.lines[0]).toContain("159");
  });

  it("库里有、本地没有 → 不 ok, 并逐条列出(这是回退信号)", () => {
    const r = formatSchemaDrift(drift({ dbOnly: ["156_x.sql", "157_y.sql"] }), { migrationsDir: dir });
    expect(r.ok).toBe(false);
    const text = r.lines.join("\n");
    expect(text).toContain("比当前代码**新**");
    expect(text).toContain("156_x.sql");
    expect(text).toContain("157_y.sql");
    // 必须给出可操作的处理方向, 而不只是"出问题了"
    expect(text).toContain("切回带这些迁移的分支");
  });

  it("本地有、库里没有 → 不 ok, 提示可能是 migrationsDir 解析错了", () => {
    const r = formatSchemaDrift(drift({ localOnly: ["158_z.sql"] }), { migrationsDir: dir });
    expect(r.ok).toBe(false);
    const text = r.lines.join("\n");
    expect(text).toContain("没有**应用到库里");
    expect(text).toContain(dir);
    expect(text).toContain("SAG_ROOT");
  });

  it("列表很长时截断, 但仍报出总数 —— 不能只显示前 8 个就让人以为只有 8 个", () => {
    const many = Array.from({ length: 11 }, (_, i) => `m${i}.sql`);
    const r = formatSchemaDrift(drift({ dbOnly: many }), { migrationsDir: dir });
    const text = r.lines.join("\n");
    expect(text).toContain("11 个");
    expect(text).toContain("… 另有 3 个");
  });

  it("已知改名**不算漂移**(仍 ok), 但要在日志里留痕 —— 不静默吞", () => {
    const r = formatSchemaDrift(drift({ knownRenamed: ["009_ingest_jobs.sql"] }), { migrationsDir: dir });
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toContain("已忽略 1 个已知改名");
  });

  it("真有漂移时, 已知改名作为附注一并说明 —— 免得看的人以为检查漏了", () => {
    const r = formatSchemaDrift(
      drift({ dbOnly: ["156_x.sql"], knownRenamed: ["009_ingest_jobs.sql"] }),
      { migrationsDir: dir },
    );
    expect(r.ok).toBe(false);
    const text = r.lines.join("\n");
    expect(text).toContain("156_x.sql");
    expect(text).toContain("另有 1 个已知的历史改名已忽略");
  });
});
