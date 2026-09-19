import { defineConfig } from "vitest/config";

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
    hookTimeout: 30000
  }
});
