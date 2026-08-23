import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Phase 2 surface smoke tests. Without Clerk keys configured locally these
 * authenticated surfaces must render their explanatory locked states rather
 * than crashing or leaking data (same policy as admin-auth.spec.ts).
 */

test.describe("league wizard", () => {
  test("renders the five-step wizard with plain-language review", async ({ page }) => {
    await page.goto("/leagues/new");
    await expect(page.getByRole("heading", { name: "Create a league" })).toBeVisible();
    await expect(page.getByText("Basics", { exact: true }).first()).toBeVisible();
    // Step through with keyboard-operable controls.
    await page.getByLabel("League name").fill("E2E League");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Scoring rules")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Roster slots", { exact: true })).toBeVisible();
  });

  test("requires a league name before advancing (inline validation)", async ({ page }) => {
    await page.goto("/leagues/new");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator("p.dc-form-error")).toContainText("name");
  });
});

test.describe("league wizard accessibility", () => {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 360, height: 800 },
  ]) {
    test(
      ["no serious/critical violations at", String(viewport.width), "px"].join(""),
      async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto("/leagues/new");
        const results = await new AxeBuilder({ page }).analyze();
        const serious = results.violations.filter(
          (violation) => violation.impact === "serious" || violation.impact === "critical",
        );
        expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
      },
    );
  }
});

test.describe("draft surfaces", () => {
  test("drafts/new shows its sign-in-required state without a session", async ({ page }) => {
    await page.goto("/drafts/new");
    await expect(page.getByRole("heading", { name: "Start a draft" })).toBeVisible();
    await expect(page.getByText("Sign in first")).toBeVisible();
  });

  test("/drafts/[id] hides content from anonymous visitors", async ({ page }) => {
    await page.goto("/drafts/00000000-0000-0000-0000-000000000000");
    await expect(page.getByRole("heading", { name: "Live draft" })).toBeVisible();
    await expect(page.getByText("authenticated")).toBeVisible();
  });

  test("dashboard explains its auth state instead of erroring", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });
});
