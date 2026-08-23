import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe("players list", () => {
  test("renders the demo player pool with the demo-data banner", async ({ page }) => {
    await page.goto("/players");
    await expect(page.getByRole("heading", { name: "Players", exact: true })).toBeVisible();
    await expect(page.getByText("DEMO — SYNTHETIC DATA")).toBeVisible();
    await expect(page.locator(".dc-results-summary").getByText(/\d+ players?/)).toBeVisible();
  });

  test("search filter updates the URL and the result set (works via plain navigation)", async ({
    page,
  }) => {
    await page.goto("/players");
    await page.getByLabel("Search").fill("Cunningham");
    await page.getByRole("button", { name: "Apply filters" }).click();

    await expect(page).toHaveURL(/name=Cunningham/);
    await expect(page.getByRole("link", { name: /Cade Cunningham/ }).first()).toBeVisible();
  });

  test("a shared filtered URL reproduces the same filtered view", async ({ page }) => {
    await page.goto("/players?name=Mobley");
    await expect(page.getByRole("link", { name: /Evan Mobley/ }).first()).toBeVisible();
  });

  test("clicking a player row navigates to their profile", async ({ page }) => {
    await page.goto("/players?name=Cunningham");
    await page
      .getByRole("link", { name: /Cade Cunningham/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/players\/cade-cunningham/);
    await expect(page.getByRole("heading", { name: "Cade Cunningham" })).toBeVisible();
  });

  test("mobile viewport shows the card layout, not the desktop table", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/players");
    await expect(page.locator(".dc-players-cards-mobile")).toBeVisible();
    await expect(page.locator(".dc-players-table-desktop")).toBeHidden();
  });

  test("filter form is fully keyboard-operable", async ({ page }) => {
    await page.goto("/players");
    await page.getByLabel("Search").focus();
    await page.getByLabel("Search").fill("Tatum");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/name=Tatum/);
  });

  test("has no serious or critical accessibility violations", async ({ page }) => {
    await page.goto("/players");
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
  });
});
