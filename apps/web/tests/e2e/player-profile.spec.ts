import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe("player profile", () => {
  test("renders projection, risk indicators, trend table, and the live-draft-phase disclaimer", async ({
    page,
  }) => {
    await page.goto("/players/cade-cunningham");
    await expect(page.getByRole("heading", { name: "Cade Cunningham" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Baseline projection" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Risk & role indicators" })).toBeVisible();
    await expect(page.getByText(/live-draft phase/).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "methodology" }).first()).toBeVisible();
  });

  test("shows the college-translation fallback for a rookie", async ({ page }) => {
    await page.goto("/players/ace-bailey");
    await expect(page.getByText("ROOKIE", { exact: true })).toBeVisible();
    await expect(page.getByText("COLLEGE", { exact: true })).toBeVisible();
  });

  test("an unknown slug renders a real 404, not a crash", async ({ page }) => {
    const response = await page.goto("/players/not-a-real-player-xyz");
    expect(response?.status()).toBe(404);
    await expect(page.getByText("Page not found")).toBeVisible();
  });

  test("has no serious or critical accessibility violations", async ({ page }) => {
    await page.goto("/players/cade-cunningham");
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
  });
});
