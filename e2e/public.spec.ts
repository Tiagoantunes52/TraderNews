import { test, expect } from "@playwright/test";

test.describe("Public pages", () => {
  test("sign-in page renders", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page).toHaveURL(/sign-in/);
    // Clerk renders a form with an email/identifier field
    await expect(page.locator("input[name='identifier'], input[type='email']").first()).toBeVisible();
  });

  test("not-invited page renders explanation and sign-out", async ({ page }) => {
    await page.goto("/not-invited");
    await expect(page.getByText(/invitation/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
  });
});
