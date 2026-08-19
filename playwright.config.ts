import { defineConfig } from "@playwright/test";

/**
 * E2E 冒烟测试配置
 * 前置：4173 服务已运行（本地: npm run dev 或 npx tsx src/index.ts）
 * 运行: npx playwright test
 */
export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:4173",
    headless: true,
  },
  projects: [{ name: "chromium" }],
});
