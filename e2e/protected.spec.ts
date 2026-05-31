import { test, expect } from "@playwright/test";

test.describe("Protected routes (unauthenticated)", () => {
  test("visiting /dashboard redirects away from dashboard", async ({ page }) => {
    await page.goto("/dashboard");
    // Should end up on sign-in or not-invited — never stay on /dashboard
    await expect(page).not.toHaveURL(/\/dashboard$/);
  });

  test("visiting /dashboard/admin redirects away from dashboard", async ({ page }) => {
    await page.goto("/dashboard/admin");
    await expect(page).not.toHaveURL(/\/dashboard\/admin/);
  });

  test("visiting /dashboard/news redirects away from dashboard", async ({ page }) => {
    await page.goto("/dashboard/news");
    await expect(page).not.toHaveURL(/\/dashboard\/news/);
  });
});
