import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  loadTestOnlyClerkCredentials,
  resetClerkTestUser,
  signInViaTicket,
} from "./helpers/clerk-test-env";

/**
 * Phase 3A Playwright coverage for /preferences — authenticated via the same
 * Clerk-supported mechanism as the draft acceptance gate. Chromium-only by
 * policy (mobile/light visual behavior is covered by the shared suites plus
 * a dedicated 320px check here).
 */

/** Reload then wait until the client has settled (effects/fetches drained). */
async function reloadAndSettle(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
}

const OWNER_EMAIL = "draftcourt-e2e-owner+clerk_test@example.com";
const TEST_PASSWORD = "DraftCourt-E2E-2026!pick";

test("preference profiles foundation", async ({ page }) => {
  test.skip(
    test.info().project.name !== "chromium",
    "authenticated preferences run once on desktop chromium",
  );
  test.setTimeout(8 * 60_000);

  const credentials = loadTestOnlyClerkCredentials();
  const ownerUserId = await resetClerkTestUser(OWNER_EMAIL, TEST_PASSWORD, "Owner");
  await signInViaTicket(page, credentials, ownerUserId);

  // Unauthenticated boundary first (separate context).
  const browserRef = page.context().browser();
  if (browserRef === null) throw new Error("browser unavailable");
  const anonContext = await browserRef.newContext();
  const anonPage = await anonContext.newPage();
  await anonPage.goto("/preferences");
  await expect(anonPage.getByText(/Sign in to manage your strategy profiles/i)).toBeVisible();
  await anonContext.close();

  await page.goto("/preferences");

  // Empty state → create.
  await expect(page.getByText(/No profile selected|Loading your profiles/).first()).toBeVisible();

  // If earlier runs left profiles, start from a fresh one regardless.
  await page.getByRole("button", { name: "New profile" }).click();
  await page.getByLabel("Profile name").fill("E2E Strategy");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText(/created/i).first()).toBeVisible({ timeout: 15_000 });

  // Preset application populates editable values (provenance shown).
  await page.getByRole("button", { name: /^Win Now / }).click();
  await expect(page.getByText(/Win Now preset applied/).first()).toBeVisible();

  // Slider change keeps normalization visible; lock toggles.
  const productionSlider = page.getByRole("slider", { name: "Projected production" });
  await productionSlider.fill("0.35");
  await expect(page.getByText("35%").first()).toBeVisible();
  const riskLock = page.getByRole("button", { name: "Lock Injury risk safety" });
  await riskLock.click();
  await expect(page.getByRole("button", { name: "Unlock Injury risk safety" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("slider", { name: "Injury risk safety" })).toBeDisabled();

  // Save persists; reload proves it.
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText(/Preferences saved/i).first()).toBeVisible({ timeout: 15_000 });
  await reloadAndSettle(page);
  await expect(page.getByRole("button", { name: /E2E Strategy/ })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Projected production" })).toHaveValue("0.35");

  // Player preference via real dataset search.
  await page.getByLabel("Find players").fill("Jayson");
  const tatumAdd = page.getByRole("button", { name: /Add Jayson Tatum to target/ });
  await expect(tatumAdd).toBeVisible({ timeout: 15_000 });
  await tatumAdd.click();
  await expect(page.getByText(/added to target list/i).first()).toBeVisible();

  // Team favorite.
  await page.getByLabel("Find teams").fill("Bos");
  await page.getByRole("button", { name: "Favorite Boston Celtics" }).first().click();

  // Punt selection through advanced controls.
  await page.getByText("Advanced controls").click();
  await page.getByRole("checkbox", { name: "TOV" }).check();
  await page.getByRole("checkbox", { name: "Punt TOV" }).check();

  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText(/Preferences saved/i).first()).toBeVisible({ timeout: 15_000 });
  await reloadAndSettle(page);
  await page.getByText("Advanced controls").click(); // <details> re-closes on reload
  await expect(page.getByRole("checkbox", { name: "Punt TOV" })).toBeChecked();

  // Custom big board: add two players, reorder down/up, save, reload.
  await page.getByLabel("Add player to board").fill("Jayson");
  await page.getByRole("button", { name: "Add Jayson Tatum to board" }).click();
  await expect(page.getByRole("button", { name: /Move Jayson Tatum down/ })).toBeVisible();
  await page.getByLabel("Add player to board").fill("Luka");
  await page.getByRole("button", { name: /Add Luka Doncic to board/ }).click();
  await page.getByRole("button", { name: /Move Luka Doncic up to position 1/ }).click();
  await page.getByRole("button", { name: "Save board order" }).click();
  await expect(page.getByText(/Board saved/i).first()).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => document.readyState === "complete");
  // Luka was saved as #1: his Move-up renders disabled at position 0.
  await expect(
    page.getByRole("button", { name: "Move Luka Doncic up to position 0" }),
  ).toBeDisabled({ timeout: 20_000 });
  await expect(
    page.getByRole("button", { name: /Move Jayson Tatum up to position 1/ }),
  ).toBeEnabled();

  // Duplicate flow.
  await page.getByRole("button", { name: "Duplicate profile" }).click();
  await expect(page.getByText(/Duplicated as/i).first()).toBeVisible();

  // Delete flow with armed confirmation + default promotion messaging.
  await page.getByRole("button", { name: "Delete profile…" }).click();
  await page.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.getByText(/Deleted/i).first()).toBeVisible({ timeout: 15_000 });

  // Reduced motion: preset application still announces correctly.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: /^Balanced / }).click();
  await expect(page.getByText(/Balanced preset applied/i).first()).toBeVisible();

  // Axe: zero serious/critical violations on the populated editor.
  const axeResults = await new AxeBuilder({ page }).disableRules("region").analyze();
  const serious = axeResults.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(serious).toEqual([]);

  // 200% zoom support.
  await page.setViewportSize({ width: 640, height: 720 });
  await page.keyboard.press("Control+Minus");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.waitForTimeout(300);
  expect(await page.locator("h1").first().isVisible()).toBe(true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });

  // 320px must not overflow horizontally.
  await page.setViewportSize({ width: 320, height: 720 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // Dark theme renders the editor.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await reloadAndSettle(page);
  await expect(page.getByRole("heading", { name: "Preferences", level: 1 })).toBeVisible();
  const presetGroup = page.getByRole("group", { name: "Strategy presets" });
  await expect(presetGroup).toBeVisible({ timeout: 20_000 });

  // Light theme renders the editor.
  await page.emulateMedia({ colorScheme: "light" });
  await expect(presetGroup).toBeVisible();
});
