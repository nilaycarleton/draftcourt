import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * Independent accessibility + visual-regression gates for the virtualized
 * visual snake board (Phase 2 acceptance). The live draft room itself is
 * Clerk-authenticated; its board component ships through @draftcourt/ui and
 * is exercised here against the committed Storybook build, so these checks
 * run without credentials while still covering populated/sparse/long-name/
 * completed/read-only states, mobile width, light/dark themes, and reduced
 * motion.
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

const STORIES: [string, string][] = [
  ["draft-snakeboard--twelve-team-mid-draft", "12-team mid-draft"],
  ["draft-snakeboard--empty-first-round", "empty first round"],
  ["draft-snakeboard--completed-draft", "completed draft"],
  ["draft-snakeboard--sixteen-team-long-names", "16-team long names"],
];

/** Runs axe with a bounded retry — Storybook's a11y addon may still be
 * mid-audit when the story first renders, which surfaces as "Axe is already
 * running" from inside the page. */
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

// Pixel baselines are authored — and visually inspected — for the default
// `chromium` project only. The root gate runs every project; behavioral
// checks (axe, overflow, keyboard, zoom, tabs, sheet) run everywhere, while
// toHaveScreenshot tests skip elsewhere instead of generating unchecked
// baseline sets per project/device. Baselines are also platform-specific:
// Playwright resolves `-darwin` snapshots, so pixel assertions additionally
// skip on non-darwin hosts (behavioral checks still run everywhere).
const PIXEL_BASELINE_PROJECT = "chromium";
const PIXEL_BASELINE_PLATFORM = "darwin";

for (const [id, name] of STORIES) {
  test(`board has no serious/critical axe violations: ${name}`, async ({ page }) => {
    await page.goto(storyUrl(id));
    await expect(page.getByRole("grid")).toBeVisible();
    const results = await runAxe(page);
    const serious = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
  });

  test(`visual snapshot: ${name} (desktop)`, async ({ page }) => {
    test.skip(
      test.info().project.name !== PIXEL_BASELINE_PROJECT ||
        process.platform !== PIXEL_BASELINE_PLATFORM,
      "pixel baselines are maintained for the chromium project on darwin only",
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(storyUrl(id));
    await expect(page.getByRole("grid")).toBeVisible();
    await expect(page.getByRole("grid")).toHaveScreenshot(`${id}-desktop.png`, {
      maxDiffPixelRatio: 0.02,
    });
  });

  test(`visual snapshot: ${name} (320px, no horizontal overflow)`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(storyUrl(id));
    await expect(page.getByRole("grid")).toBeVisible();
    // The board scrolls internally; the page itself must never overflow.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test(`visual snapshot: ${name} (reduced motion)`, async ({ page }) => {
    test.skip(
      test.info().project.name !== PIXEL_BASELINE_PROJECT ||
        process.platform !== PIXEL_BASELINE_PLATFORM,
      "pixel baselines are maintained for the chromium project on darwin only",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(storyUrl(id));
    await expect(page.getByRole("grid")).toBeVisible();
    await expect(page.getByRole("grid")).toHaveScreenshot(`${id}-reduced-motion.png`, {
      maxDiffPixelRatio: 0.02,
    });
  });
}

test("dark theme renders an equal-quality board", async ({ page }) => {
  test.skip(
    test.info().project.name !== PIXEL_BASELINE_PROJECT ||
      process.platform !== PIXEL_BASELINE_PLATFORM,
    "pixel baselines are maintained for the chromium project on darwin only",
  );
  await page.addInitScript(() => {
    window.localStorage.setItem("draftcourt-theme-preference", "dark");
  });
  await page.goto(storyUrl("draft-snakeboard--twelve-team-mid-draft"));
  await expect(page.getByRole("grid")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", /dark/);
  await expect(page.getByRole("grid")).toHaveScreenshot("board-dark.png", {
    maxDiffPixelRatio: 0.02,
  });
});

test("keyboard cursor navigates the virtualized grid without stranding focus", async ({ page }) => {
  await page.goto(storyUrl("draft-snakeboard--sixteen-team-long-names"));
  const grid = page.getByRole("grid");
  await expect(grid).toBeVisible();
  await grid.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  const descendant = await grid.getAttribute("aria-activedescendant");
  if (!descendant) throw new Error("no aria-activedescendant after arrow keys");
  expect(descendant).toMatch(/^dc-board-cell-\d+-\d+$/);
  // The cursor cell must actually be rendered (windowing followed focus).
  const rendered = await page.evaluate(
    (cellId) => Boolean(document.getElementById(cellId)),
    descendant,
  );
  expect(rendered).toBe(true);
});

const ROOM_TABS_ID = "draft-roomtabs--four-room-tabs";
const ROSTER_SHEET_ID = "draft-rostersheet--openable-roster-sheet";

test.describe("room tabs (Storybook)", () => {
  for (const [width, height, label] of [
    [1280, 720, "desktop"],
    [640, 360, "mobile-width"],
  ] as const) {
    test(`activating a tab does not shift sibling tabs (${label})`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(storyUrl(ROOM_TABS_ID));
      const tabs = page.getByRole("tab");
      await expect(tabs).toHaveCount(4);
      const before = await Promise.all((await tabs.all()).map((tab) => tab.boundingBox()));
      await page.getByRole("tab", { name: "Available players" }).click();
      await expect(page.getByRole("tab", { name: "Available players" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      const after = await Promise.all((await tabs.all()).map((tab) => tab.boundingBox()));
      // Selected-state emphasis must not change glyph metrics: every tab box
      // is identical before/after activation (Impeccable polish finding 1).
      expect(after).toEqual(before);
    });
  }

  test("keyboard activates tabs and selected state stays visible", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 360 });
    await page.goto(storyUrl(ROOM_TABS_ID));
    await page.getByRole("tab", { name: "Recommendations" }).focus();
    await page.keyboard.press("ArrowRight");
    const board = page.getByRole("tab", { name: "Board" });
    await expect(board).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(board).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("roster sheet (Storybook)", () => {
  test("opens, fits the viewport, and dismisses with Escape", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 360 });
    await page.goto(storyUrl(ROSTER_SHEET_ID));
    await page.getByRole("button", { name: "Show opponent roster" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    if (!box) throw new Error("dialog has no bounding box");
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("no viewport");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});

test.describe("200% browser zoom (640x360 CSS viewport @2x DPR)", () => {
  test("board stays page-overflow-free and keyboard-navigable", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 640, height: 360 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(storyUrl("draft-snakeboard--twelve-team-mid-draft"));
    const grid = page.getByRole("grid");
    await expect(grid).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await grid.focus();
    await page.keyboard.press("ArrowDown");
    const descendant = await grid.getAttribute("aria-activedescendant");
    if (!descendant) throw new Error("no aria-activedescendant at 200% zoom");
    const rendered = await page.evaluate(
      (cellId) => Boolean(document.getElementById(cellId)),
      descendant,
    );
    expect(rendered).toBe(true);
    await context.close();
  });

  test("room tabs remain visible, uncropped, and operable", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 640, height: 360 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(storyUrl(ROOM_TABS_ID));
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(4);
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("no viewport");
    for (const tab of await tabs.all()) {
      const box = await tab.boundingBox();
      if (!box) throw new Error("tab has no bounding box");
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }
    await page.getByRole("tab", { name: "My roster" }).click();
    await expect(page.getByRole("tab", { name: "My roster" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await context.close();
  });

  test("opponent-roster sheet fits the viewport and dismisses", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 640, height: 360 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(storyUrl(ROSTER_SHEET_ID));
    await page.getByRole("button", { name: "Show opponent roster" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) throw new Error("dialog/viewport missing");
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await context.close();
  });
});
