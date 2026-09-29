import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".");

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**", "**/test/e2e/**"],
    /**
     * ⚠ 必须显式给, 不能吃 vitest 的默认值(5000ms)。
     *
     * 2026-09-19: 整跑三次, **每次挂的是不同的测试**, 报错都是
     *   `Error: Test timed out in 5000ms` —— 其中 `v399-integration` 那条
     *   要起 Python 子进程(`scripts/empirical_metaanalysis.py`), **实测跑 8.3 秒**,
     *   单独跑能过、并发一压就超。本仓有 4 个测试文件会起子进程, 且**没有一个设过超时**。
     *
     * 单跑绿 / 整跑随机红, 会被当成"偶发"糊弄过去 —— 实际上它一直在掩盖真问题:
     *   子进程测试本来就该有比纯单测宽得多的预算。
     * 30s 是给子进程(含 Python 冷启动)的余量; 真有更慢的用例请**在用例上单独设**,
     *   别把全局值继续往上抬(那会让真正的死循环也拖 30s 才报)。
     */
    testTimeout: 30000,
    hookTimeout: 30000,
    /**
     * ⚠ `DOTENV_CONFIG_PATH` 必须交给 worker —— 否则**需要真库的测试在整跑里会挂**。
     *
     * 2026-09-29 踩到: worktree 里没有 `.env`(它只在主仓), `dotenv/config` 于是读不到任何东西,
     *   `DATABASE_URL` 落回默认值 `localhost:5432`, 而本机 docker 映射的是 **5540**
     *   ⇒ `test/file-text-service.test.ts` 以 `ECONNREFUSED ::1:5432` 整文件失败, 其余 141 个全绿。
     *   现场看起来像"文档改动搞挂了测试"。
     * 这也是 `npx vitest` 与 `DOTENV_CONFIG_PATH=... npx vitest` **结论不同**的原因
     *   (实测: 前者 1 failed, 后者 13 passed) —— 差的就是这一个变量的传递。
     * 给一个**只在文件真存在时**生效的默认值: 仓库根没有 `.env` 就什么都不做, 行为与之前一致。
     */
    env: (() => {
      const cands = [path.join(ROOT, ".env"), path.join(ROOT, "..", "..", "..", ".env")];
      const hit = cands.find((p) => existsSync(p));
      return hit ? { DOTENV_CONFIG_PATH: hit } : {};
    })(),
  }
});
