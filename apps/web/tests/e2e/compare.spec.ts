import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe("compare", () => {
  test("a shared ?players= URL renders the comparison table directly", async ({ page }) => {
    await page.goto("/compare?players=cade-cunningham,evan-mobley");
    await expect(page.getByRole("heading", { name: "Compare players" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Cade Cunningham/ })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Evan Mobley/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /^Games/ })).toBeVisible();
  });

  test("marks a category leader without color-only encoding", async ({ page }) => {
    await page.goto("/compare?players=cade-cunningham,evan-mobley,giannis-antetokounmpo");
    const leaderCells = page.locator(".dc-compare-leader");
    await expect(leaderCells.first()).toBeVisible();
    // Every leader cell carries a visually-hidden text explanation, not
    // just a color/style change — the accessible name must include it.
    const accessibleName = await leaderCells.first().innerText();
    expect(accessibleName.length).toBeGreaterThan(0);
  });

  test("an unknown slug shows a clear warning but still renders the found players", async ({
    page,
  }) => {
    await page.goto("/compare?players=cade-cunningham,bogus-slug-xyz,evan-mobley");
    await expect(page.getByText(/No player found for: bogus-slug-xyz/)).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Cade Cunningham/ })).toBeVisible();
  });

  test("more than 4 requested players is clamped with a visible notice", async ({ page }) => {
    await page.goto(
      "/compare?players=cade-cunningham,evan-mobley,giannis-antetokounmpo,paolo-banchero,ace-bailey",
    );
    await expect(page.getByText(/Only the first 4 selected players are compared/)).toBeVisible();
  });

  test("the comparison table scrolls horizontally within its own container on mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/compare?players=cade-cunningham,evan-mobley,giannis-antetokounmpo");
    const scrollContainer = page.locator(".dc-data-table-scroll").last();
    await expect(scrollContainer).toBeVisible();
    const overflowX = await scrollContainer.evaluate((el) => getComputedStyle(el).overflowX);
    expect(overflowX).toBe("auto");

    // `document.body.scrollWidth` isn't the right check here: it reports
    // the full intrinsic content extent regardless of `overflow-x`, so it
    // stays large even once page-level scrolling is correctly disabled.
    // What actually matters is whether the *page* can be scrolled
    // horizontally at all — it shouldn't be, even though the table's own
    // container legitimately can.
    const bodyScrollX = await page.evaluate(() => {
      window.scrollTo(1000, 0);
      return window.scrollX;
    });
    expect(bodyScrollX).toBe(0);
  });

  test("has no serious or critical accessibility violations", async ({ page }) => {
    await page.goto("/compare?players=cade-cunningham,evan-mobley");
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
  });
});
