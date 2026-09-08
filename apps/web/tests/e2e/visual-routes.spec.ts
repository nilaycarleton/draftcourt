import { expect, test } from "@playwright/test";

/**
 * Phase 3F curated route pixels (M7): guest-accessible high-traffic routes.
 *
 * Pixel baselines are maintained for the `chromium` project on darwin ONLY (see
 * board-storybook.spec.ts pixel policy). Only deterministic guest routes are
 * covered here: `/players` (projection cutoff date masked — it renders via
 * `toLocaleDateString`) and `/demo` (static entry form).
 *
 * Deliberately NOT pixel-covered (documented limitation, see
 * docs/acceptance/phase3-acceptance-matrix.md): authenticated routes
 * (Clerk session + fixture + timestamp instability), loading skeletons
 * (inherently racy), and theme x viewport cross-products.
 */

const PIXEL_BASELINE_PROJECT = "chromium";
// Playwright resolves platform-suffixed (`-darwin`) snapshots, so pixel
// assertions additionally skip on non-darwin hosts.
const PIXEL_BASELINE_PLATFORM = "darwin";

function skipUnlessPixelBaseline(): void {
  test.skip(
    test.info().project.name !== PIXEL_BASELINE_PROJECT ||
      process.platform !== PIXEL_BASELINE_PLATFORM,
    "pixel baselines are maintained for the chromium project on darwin only",
  );
}

test.describe("route pixels (guest, deterministic)", () => {
  test("players list (light)", async ({ page }) => {
    skipUnlessPixelBaseline();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/players");
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("main")).toHaveScreenshot("route-players-light.png", {
      maxDiffPixelRatio: 0.02,
      mask: [page.locator(".dc-freshness-note")],
    });
  });

  test("players list (dark)", async ({ page }) => {
    skipUnlessPixelBaseline();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/players");
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("main")).toHaveScreenshot("route-players-dark.png", {
      maxDiffPixelRatio: 0.02,
      mask: [page.locator(".dc-freshness-note")],
    });
  });

  test("demo entry (light)", async ({ page }) => {
    skipUnlessPixelBaseline();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/demo");
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("main")).toHaveScreenshot("route-demo-light.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("demo entry (dark)", async ({ page }) => {
    skipUnlessPixelBaseline();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/demo");
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("main")).toHaveScreenshot("route-demo-dark.png", {
      maxDiffPixelRatio: 0.02,
    });
  });
});
