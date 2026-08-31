// E2E 冒烟测试 — 核心页面渲染验证（生产级保障）
// 前置: 4173 服务运行中（npm run dev 或 npx tsx src/index.ts）
// 运行: npx playwright test
import { test, expect } from "@playwright/test";

test.describe("MarxSphere 冒烟测试", () => {
  test("首页可访问且渲染品牌内容", async ({ page }) => {
    await page.goto("/");
    // 页面标题（React 渲染后）
    await expect(page).toHaveTitle(/MarxSphere/);
    // 关键品牌元素
    await expect(page.getByText("MarxSphere", { exact: false }).first()).toBeVisible();
  });

  test("AI 对话页（默认视图）渲染", async ({ page }) => {
    await page.goto("/");
    // 默认视图是 assistant（AI 对话），应有输入框
    const input = page.locator("textarea, [contenteditable=true], input[type=text]").first();
    await expect(input).toBeVisible({ timeout: 10_000 });
  });

  test("Ask 检索页可切换", async ({ page }) => {
    await page.goto("/#ask");
    await page.waitForTimeout(1500);
    // Ask 页面应有检索输入或标题
    await expect(page.locator("body")).toContainText(/Ask|检索/);
  });

  test("健康检查接口正常", async ({ request }) => {
    const res = await request.get("/health");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
