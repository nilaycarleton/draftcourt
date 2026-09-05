import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  loadTestOnlyClerkCredentials,
  resetClerkTestUser,
  signInViaTicket,
} from "./helpers/clerk-test-env";

/**
 * Phase 3B Playwright coverage: strategy selection across surfaces.
 *
 * One rerunnable chromium scenario (unique-suffix data, deterministic reset
 * user): two materially different profiles are seeded via the API, league
 * settings select + persistence is exercised through the REAL UI, the
 * selected profile is deleted and the fall-through verified, then /drafts/new
 * previews the resolved profile, applies a pre-start override, starts the
 * draft through the UI, and the live room shows the locked provenance.
 */

// Distinct fixed email from the other authenticated specs so parallel
// workers never reset each other's Clerk user mid-run.
const OWNER_EMAIL = "draftcourt-e2e-strategy+clerk_test@example.com";
const TEST_PASSWORD = "DraftCourt-E2E-2026!pick";

/** Reload then wait until the client has settled (effects/fetches drained). */
async function reloadAndSettle(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
}

async function seedProfile(
  page: Page,
  name: string,
  presetKey: string,
  isDefault = false,
): Promise<string> {
  const response = await page.request.post("/api/v1/preference-profiles", {
    data: { name, isDefault, preset: { key: presetKey } },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { data?: { id?: string } };
  const id = body.data?.id;
  if (!id) throw new Error(`profile ${name} not created`);
  return id;
}

async function seedLeague(page: Page, name: string): Promise<string> {
  const hb = "HIGHER_BETTER" as const;
  const lb = "LOWER_BETTER" as const;
  const response = await page.request.post("/api/v1/leagues", {
    data: {
      name,
      season: "2026-27",
      teamCount: 4,
      userDraftSlot: 1,
      rounds: 11,
      config: {
        type: "POINTS",
        horizon: "REDRAFT",
        playoffWeeks: null,
        scoringRules: [
          { stat: "PTS", weight: 1, direction: hb },
          { stat: "REB", weight: 1.2, direction: hb },
          { stat: "AST", weight: 1.5, direction: hb },
          { stat: "STL", weight: 3, direction: hb },
          { stat: "BLK", weight: 3, direction: hb },
          { stat: "TOV", weight: -1, direction: lb },
          { stat: "FGM", weight: 2, direction: hb },
          { stat: "FTM", weight: 1, direction: hb },
          { stat: "THREE_PM", weight: 1, direction: hb },
        ],
        rosterSlots: [
          { position: "PG", count: 1, starter: true },
          { position: "SG", count: 1, starter: true },
          { position: "SF", count: 1, starter: true },
          { position: "PF", count: 1, starter: true },
          { position: "C", count: 1, starter: true },
          { position: "G", count: 1, starter: true },
          { position: "F", count: 1, starter: true },
          { position: "UTIL", count: 1, starter: true },
          { position: "BENCH", count: 3, starter: false },
        ],
      },
    },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { data?: { id?: string } };
  const id = body.data?.id;
  if (!id) throw new Error("league not created");
  return id;
}

test("strategy selection persists, falls back, overrides, and locks at start", async ({ page }) => {
  test.skip(
    test.info().project.name !== "chromium",
    "authenticated strategy run once on desktop chromium",
  );
  test.setTimeout(10 * 60_000);

  const credentials = loadTestOnlyClerkCredentials();
  const ownerUserId = await resetClerkTestUser(OWNER_EMAIL, TEST_PASSWORD, "Owner");
  await signInViaTicket(page, credentials, ownerUserId);

  // Unique suffixes keep reruns independent of earlier runs' leftovers.
  const suffix = String(Date.now());
  const profileA = `Balanced A ${suffix}`;
  const profileB = `Win Now B ${suffix}`;
  const profileC = `BPA C ${suffix}`;
  const leagueName = `Strategy E2E ${suffix}`;

  // Two materially different profiles (A default) + a third for override.
  await seedProfile(page, profileA, "balanced", true);
  await seedProfile(page, profileB, "win-now");
  const profileCId = await seedProfile(page, profileC, "bpa");
  const leagueId = await seedLeague(page, leagueName);

  // ---- League settings: select B, save, persist across reload -------------
  await page.goto(`/leagues/${leagueId}/settings`);
  const strategySection = page.getByRole("region", { name: "Draft strategy" });
  await expect(strategySection).toBeVisible();
  await expect(strategySection.getByText(/Applies to drafts started after you save/)).toBeVisible();

  await strategySection.getByRole("radio", { name: new RegExp(profileB) }).check();
  await strategySection.getByRole("button", { name: "Save strategy" }).click();
  await expect(strategySection.getByText(/Strategy saved/).first()).toBeVisible({
    timeout: 15_000,
  });

  await reloadAndSettle(page);
  const reloadedSection = page.getByRole("region", { name: "Draft strategy" });
  await expect(reloadedSection.getByRole("radio", { name: new RegExp(profileB) })).toBeChecked();

  // Axe gate on the settings surface (same policy as preferences.spec).
  const settingsAxe = await new AxeBuilder({ page }).disableRules("region").analyze();
  expect(
    settingsAxe.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);

  // 320px must not overflow horizontally on settings.
  await page.setViewportSize({ width: 320, height: 720 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 800 });

  // ---- Delete B → selection cleared, fallback shown ------------------------
  await page.goto("/preferences");
  await page.getByRole("button", { name: new RegExp(profileB) }).click();
  await page.getByRole("button", { name: "Delete profile…" }).click();
  await page.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.getByText(/Deleted/i).first()).toBeVisible({ timeout: 15_000 });

  await page.goto(`/leagues/${leagueId}/settings`);
  const afterDelete = page.getByRole("region", { name: "Draft strategy" });
  await expect(
    afterDelete.getByRole("radio", { name: /Use my default profile at draft time/ }),
  ).toBeChecked();
  await expect(afterDelete.getByText(new RegExp(profileA)).first()).toBeVisible(); // default name hint

  // ---- /drafts/new: preview resolves, override flows, UI start -------------
  await page.goto("/drafts/new");
  await page.getByRole("radio", { name: new RegExp(leagueName) }).check();
  const sentence = page.locator(".dc-preview-sentence");
  await expect(sentence).toContainText(new RegExp(profileA), { timeout: 15_000 });
  await expect(sentence).toContainText(/This profile weighs/);

  await page.getByRole("radio", { name: /Pick a different profile/ }).check();
  await page.getByLabel("Override profile").selectOption(profileCId);
  await expect(page.locator(".dc-preview-sentence")).toContainText(new RegExp(profileC), {
    timeout: 15_000,
  });
  await expect(page.locator(".dc-preview-sentence")).toContainText(/Draft override/);

  await page.getByRole("button", { name: "Start draft" }).click();
  await page.waitForURL(/\/drafts\/[0-9a-f-]{36}$/u, { timeout: 30_000 });
  await expect(page.locator('span[data-status="ACTIVE"]')).toBeVisible();

  // Room shows locked provenance + engine version inside the evidence sheet.
  const evidenceCard = page.locator(".dc-evidence-card");
  await expect(evidenceCard.getByText("Draft override")).toBeVisible();
  await evidenceCard.getByRole("button", { name: "Details" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/phase3-preferences-/u)).toBeVisible();
  await expect(dialog.getByText(/This draft.s strategy cannot be edited\./u)).toBeVisible();

  // Axe gate on the touched /drafts/new route (room itself is covered by the
  // Phase 2 acceptance suite; keep this cheap and focused).
  await page.goto("/drafts/new");
  await page.waitForLoadState("networkidle");
  const draftsNewAxe = await new AxeBuilder({ page }).disableRules("region").analyze();
  expect(
    draftsNewAxe.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);

  // Reduced-motion: preview flow still announces and renders (no animation
  // dependence anywhere in this path).
  await page.emulateMedia({ reducedMotion: "reduce" });
  await reloadAndSettle(page);
  await page.getByRole("radio", { name: new RegExp(leagueName) }).check();
  await expect(page.locator(".dc-preview-sentence")).toContainText(/This profile weighs/, {
    timeout: 15_000,
  });

  // Dark scheme renders the picker surface.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/leagues/${leagueId}/settings`);
  await reloadAndSettle(page);
  await expect(page.getByRole("region", { name: "Draft strategy" })).toBeVisible();

  // Light again for hygiene.
  await page.emulateMedia({ colorScheme: "light" });
});
