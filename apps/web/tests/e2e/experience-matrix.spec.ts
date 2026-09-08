import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Phase 3F experience matrix (M2/M5/M6): unauthenticated route coverage for
 * accessibility, responsive, theme, and keyboard behavior.
 *
 * Authenticated surfaces (dashboard, leagues, preferences, draft room,
 * history, results, admin) are covered by their own credential-gated specs
 * (phase2-surfaces, preferences, strategy-selection, mock-draft,
 * authenticated-draft, history-results, replay-sharing, admin-auth).
 * This file closes the public-surface gap: landing, players, profile,
 * compare, demo entry, data-sources, methodology, sign-in gate, 404.
 *
 * Conventions: behavioral checks run on every Playwright project; there are
 * no pixel baselines here (see board-storybook.spec.ts for pixel policy).
 * 640x360 is the 200%-zoom equivalent of 1280x720 per existing repo policy.
 */

const ROUTES: { path: string; name: string; axe: boolean }[] = [
  { path: "/", name: "landing", axe: true },
  { path: "/players", name: "players", axe: true },
  { path: "/players/cade-cunningham", name: "player profile", axe: true },
  { path: "/compare?players=cade-cunningham,lebron-james", name: "compare", axe: true },
  { path: "/demo", name: "demo entry", axe: true },
  { path: "/data-sources", name: "data sources", axe: true },
  { path: "/methodology", name: "methodology", axe: true },
  // Clerk-hosted UI: smoke only (visibility/keyboard/overflow). Axe is
  // excluded — third-party auth chrome is not DraftCourt-authored UI.
  { path: "/sign-in", name: "sign-in gate", axe: false },
  { path: "/no-such-route-xyz-404", name: "not found", axe: true },
];

for (const route of ROUTES) {
  test.describe(`experience matrix: ${route.name} (${route.path})`, () => {
    test("has no serious/critical axe violations", async ({ page }) => {
      test.skip(!route.axe, "third-party hosted UI — smoke only");
      await page.goto(route.path);
      await expect(page.locator("main")).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
      ).toEqual([]);
    });

    test("skip link is first tab stop and moves focus to main", async ({ page }) => {
      await page.goto(route.path);
      await expect(page.locator("main")).toBeVisible();
      // First Tab from the address bar must land on the skip link.
      await page.keyboard.press("Tab");
      const focused = page.locator(".dc-skip-link:focus");
      await expect(focused).toHaveCount(1);
      await page.keyboard.press("Enter");
      const activeTag = await page.evaluate(() => document.activeElement?.tagName);
      expect(activeTag).toBe("MAIN");
    });

    test("has no page-level horizontal overflow at 320px", async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 700 });
      await page.goto(route.path);
      await expect(page.locator("main")).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });

    test("has no page-level horizontal overflow at 200% zoom equivalent", async ({ page }) => {
      await page.setViewportSize({ width: 640, height: 360 });
      await page.goto(route.path);
      await expect(page.locator("main")).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });

    test("renders in both light and dark color schemes", async ({ page }) => {
      await page.goto(route.path);
      await expect(page.locator("main")).toBeVisible();
      await page.emulateMedia({ colorScheme: "dark" });
      const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.emulateMedia({ colorScheme: "light" });
      const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(darkBg.trim().length).toBeGreaterThan(0);
      expect(lightBg.trim().length).toBeGreaterThan(0);
      // Equal-quality themes: the canvas must actually switch.
      expect(darkBg).not.toBe(lightBg);
    });
  });
}
