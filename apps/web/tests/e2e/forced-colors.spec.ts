import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Phase 3F forced-colors / high-contrast gate (M4/M6).
 *
 * Chromium emulates Windows high-contrast via `forcedColors: "active"`.
 * DraftCourt's `@media (forced-colors: active)` block (packages/ui
 * styles.css) pins focus rings, switch state, selected tabs, and board
 * states to system colors; the UA also remaps remaining author colors.
 *
 * These checks run on every Playwright project (behavioral, no pixels):
 * emulation engages, the forced-colors stylesheet changes computed focus
 * styling, axe stays clean, and pages keep working with keyboard only.
 */

const ROUTES = ["/players", "/compare", "/demo", "/data-sources", "/methodology"];

for (const path of ROUTES) {
  test.describe(`forced colors: ${path}`, () => {
    test("emulation engages and keeps the page operable", async ({ page }) => {
      await page.emulateMedia({ forcedColors: "active" });
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      const engaged = await page.evaluate(() => matchMedia("(forced-colors: active)").matches);
      expect(engaged).toBe(true);
      // Keyboard still reaches content: first Tab lands on the skip link.
      await page.keyboard.press("Tab");
      await expect(page.locator(".dc-skip-link:focus")).toHaveCount(1);
    });

    test("has no serious/critical axe violations in forced colors", async ({ page }) => {
      await page.emulateMedia({ forcedColors: "active" });
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
      ).toEqual([]);
    });
  });
}

test("forced-colors stylesheet overrides the focus ring color", async ({ page }) => {
  // Proves the @media (forced-colors: active) block engages: the same
  // focused skip link computes a different outline color with emulation on
  // (system Highlight) than off (DraftCourt focus-ring token).
  await page.goto("/players");
  await expect(page.locator("main")).toBeVisible();
  await page.keyboard.press("Tab");
  const skipLink = page.locator(".dc-skip-link:focus");
  await expect(skipLink).toHaveCount(1);
  const normalOutline = await skipLink.evaluate(
    (element) => getComputedStyle(element).outlineColor,
  );
  await page.emulateMedia({ forcedColors: "active" });
  const forcedOutline = await skipLink.evaluate(
    (element) => getComputedStyle(element).outlineColor,
  );
  expect(normalOutline.trim().length).toBeGreaterThan(0);
  expect(forcedOutline.trim().length).toBeGreaterThan(0);
  expect(forcedOutline).not.toBe(normalOutline);
});
