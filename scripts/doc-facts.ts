#!/usr/bin/env npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// scripts/doc-facts.ts — 文档要引用的**运行时真数** (工具/技能/编排能力)
//
// 由来(2026-09-29): `doc-sync.ts` 原先用 `npx tsx -e "..."` 内联取数, 而那个子进程
//   **读不到 .env** —— 后果不是报错, 是**静默少算**: 少加载 2 个工具 → 数出 156,
//   而服务端实际 158, 然后把这个错的数写进文档, 且 docs:check 报绿。比不更新更坏。
//
// 抽成一个真脚本文件的原因很具体: 内联那句话里必须 `import "dotenv/config"`, 而它带引号 ——
//   经 cmd 两次转义后引号被吃掉, 语句变成语法错误(实测: 两种写法都直接崩, 只吐 Node 的报错)。
//   落成文件就没有这层转义问题。
//
// 输出格式固定为 `KEY=value`, 由 doc-sync 用正则读走。
import "dotenv/config";

const out: string[] = [];

try {
  const { buildAgentTools } = await import("../src/services/agent-tool-router.js");
  const tools = await buildAgentTools({});
  const view = tools.filter((t) => t.name.startsWith("view_")).length;
  out.push(`TOOLS=${tools.length}`, `AGENT=${tools.length - view}`, `VIEW=${view}`);
} catch (e) {
  out.push(`TOOLS_ERR=${String((e as Error).message).slice(0, 80)}`);
}

try {
  const { listSkills } = await import("../src/services/skills-service.js");
  out.push(`SKILLS=${listSkills().length}`);
} catch { /* 取不到就让 doc-sync 退回旧值 */ }

try {
  const { listCapabilities } = await import("../src/services/capability-registry.js");
  out.push(`CAPS=${(await listCapabilities({})).length}`);
} catch { /* 同上 */ }

process.stdout.write(out.join(" ") + "\n");
