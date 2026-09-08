import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * Phase 3F curated visual regression (M7) for the DraftCourt design system.
 *
 * Covers the component surfaces the board suite does not: room tabs
 * selected state, roster-sheet dialog chrome, replay transport (dark),
 * history card, and grade-hero extremes. Pixel baselines are authored for
 * default `chromium` project on darwin ONLY (see board-storybook.spec.ts pixel
 * policy); behavioral checks (axe, keyboard, focus, themes) run everywhere.
 *
 * Deliberately NOT pixel-covered here (documented limitation, see
 * docs/acceptance/phase3-acceptance-matrix.md): authenticated route chrome
 * (preferences/history/results/dashboard — Clerk session + fixture +
 * timestamp instability; components covered via these stories, behavior via
 * credential-gated specs), loading skeletons (inherently racy; the
 * reduced-motion kill-switch is CSS-gated and reviewed), and
 * theme x viewport cross-products (behavioral asserts suffice).
 *
 * Skips (with reason) when `packages/ui/storybook-static` has not been
 * built — `pnpm --filter @draftcourt/ui build-storybook` produces it; the
 * root quality gate builds it before e2e.
 */

const storybookDir = fileURLToPath(
  new URL("../../../../packages/ui/storybook-static/", import.meta.url),
);
const enabled = existsSync(join(storybookDir, "index.html"));

let server: Server | null = null;
let port = 0;

async function start(): Promise<void> {
  const mime: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
  };
  server = createServer((request, response) => {
    const url = (request.url ?? "/").split("?")[0] ?? "/";
    let filePath = normalize(join(storybookDir, decodeURIComponent(url)));
    if (!filePath.startsWith(storybookDir)) {
      response.writeHead(403).end();
      return;
    }
    try {
      statSync(filePath).isDirectory();
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        filePath = join(storybookDir, "index.html");
      }
      const body = readFileSync(filePath);
      response.writeHead(200, { "content-type": mime[extname(filePath)] ?? "text/plain" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
}

function storyUrl(id: string): string {
  return `http://127.0.0.1:${String(port)}/iframe.html?id=${id}&viewMode=story`;
}

test.skip(
  !enabled,
  "storybook-static not built — run pnpm --filter @draftcourt/ui build-storybook",
);

test.beforeAll(async () => {
  await start();
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

const PIXEL_BASELINE_PROJECT = "chromium";
// Playwright resolves platform-suffixed (`-darwin`) snapshots, so pixel
// assertions additionally skip on non-darwin hosts (behavioral checks still
// run everywhere).
const PIXEL_BASELINE_PLATFORM = "darwin";

async function runAxe(page: Page) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await new AxeBuilder({ page }).analyze();
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(750);
    }
  }
  throw lastError;
}

async function expectNoSeriousOrCritical(page: Page): Promise<void> {
  const results = await runAxe(page);
  expect(
    results.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
    JSON.stringify(results.violations, null, 2),
  ).toEqual([]);
}

test.describe("design-system pixels + behavior", () => {
  test("tabs selected state (light, desktop)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(storyUrl("draft-roomtabs--four-room-tabs"));
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(4);
    await page.getByRole("tab", { name: "Available players" }).click();
    await expect(page.getByRole("tab", { name: "Available players" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expectNoSeriousOrCritical(page);
    test.skip(
      test.info().project.name !== PIXEL_BASELINE_PROJECT ||
        process.platform !== PIXEL_BASELINE_PLATFORM,
      "pixel baselines are maintained for the chromium project on darwin only",
    );
    await expect(page.getByRole("tablist")).toHaveScreenshot("tabs-selected-light.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("roster sheet open (640x360)", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 360 });
    await page.goto(storyUrl("draft-rostersheet--openable-roster-sheet"));
    await page.getByRole("button", { name: "Show opponent roster" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expectNoSeriousOrCritical(page);
    test.skip(
      test.info().project.name !== PIXEL_BASELINE_PROJECT ||
        process.platform !== PIXEL_BASELINE_PLATFORM,
      "pixel baselines are maintained for the chromium project on darwin only",
    );
    await expect(dialog).toHaveScreenshot("sheet-open-640.png", { maxDiffPixelRatio: 0.02 });
  });

  test("replay transport idle (dark)", async ({ page }) => {
    test.skip(
      test.info().project.name !== PIXEL_BASELINE_PROJECT ||
        process.platform !== PIXEL_BASELINE_PLATFORM,
      "pixel baselines are maintained for the chromium project on darwin only",
    );
    await page.addInitScript(() => {
      window.localStorage.setItem("draftcourt-theme-preference", "dark");
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(storyUrl("draftcourt-replaytransport--final-state"));
    const controls = page.getByRole("group", { name: "Draft replay controls" });
    await expect(controls).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", /dark/);
    await expect(controls).toHaveScreenshot("replay-transport-dark.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("history card populated (light)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(storyUrl("draftcourt-historycard--light-theme"));
    const card = page.locator("article.dc-history-card");
    await expect(card).toBeVisible();
    await expectNoSeriousOrCritical(page);
    test.skip(
      test.info().project.name !== PIXEL_BASELINE_PROJECT ||
        process.platform !== PIXEL_BASELINE_PLATFORM,
      "pixel baselines are maintained for the chromium project on darwin only",
    );
    await expect(card).toHaveScreenshot("history-card-light.png", { maxDiffPixelRatio: 0.02 });
  });

  test("grade hero extremes (light)", async ({ page }) => {
    test.skip(
      test.info().project.name !== PIXEL_BASELINE_PROJECT ||
        process.platform !== PIXEL_BASELINE_PLATFORM,
      "pixel baselines are maintained for the chromium project on darwin only",
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(storyUrl("draftcourt-gradehero--grade-a"));
    const heroA = page.locator("section.dc-grade-hero");
    await expect(heroA).toBeVisible();
    // The generated-at <time> renders in the viewer's timezone (correct
    // product behavior) — mask it so the baseline is TZ-independent.
    const timeMask = [page.locator("section.dc-grade-hero time")];
    await expect(heroA).toHaveScreenshot("grade-hero-a-light.png", {
      maxDiffPixelRatio: 0.02,
      mask: timeMask,
    });
    await page.goto(storyUrl("draftcourt-gradehero--grade-f"));
    const heroF = page.locator("section.dc-grade-hero");
    await expect(heroF).toBeVisible();
    await expect(heroF).toHaveScreenshot("grade-hero-f-light.png", {
      maxDiffPixelRatio: 0.02,
      mask: timeMask,
    });
  });

  test("sheet traps Tab inside the dialog while open", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(storyUrl("draft-rostersheet--openable-roster-sheet"));
    await page.getByRole("button", { name: "Show opponent roster" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Tab cycles within the dialog: after many presses focus never leaves.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
    }
    const outsideFocused = await page.evaluate(() => {
      const dialogEl = document.querySelector('[role="dialog"]');
      const active = document.activeElement;
      return Boolean(dialogEl && active && !dialogEl.contains(active) && active !== document.body);
    });
    expect(outsideFocused).toBe(false);
  });
});
