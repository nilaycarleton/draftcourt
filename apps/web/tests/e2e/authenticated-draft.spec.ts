import {
  expect,
  request as newRequestContext,
  test,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  deleteClerkTestUsersByEmail,
  loadTestOnlyClerkCredentials,
  resetClerkTestUser,
  signInViaTicket,
  type TestClerkCredentials,
} from "./helpers/clerk-test-env";

/**
 * Phase 2 authenticated acceptance gate (PHASE_3_OPENCODE_PROMPT.md Gate 0).
 *
 * One serial, rerunnable scenario against the REAL production build
 * (`pnpm start`) with real Clerk development-instance sessions — no auth
 * bypass: sign-in goes through the app's own `/sign-in` surface via Clerk's
 * supported `@clerk/testing` mechanism, and every API call carries those
 * session cookies. The only seeded seam is the `users` mirror row that the
 * signed `user.created` webhook would insert (the local webhook receiver is
 * intentionally unconfigured; see helpers/clerk-test-env.ts).
 *
 * Runs once on the desktop chromium project; visual/mobile/light coverage
 * lives in the existing suites.
 */

test.describe.configure({ mode: "serial" });

const OWNER_EMAIL = "draftcourt-e2e-owner+clerk_test@example.com";
const INTRUDER_EMAIL = "draftcourt-e2e-intruder+clerk_test@example.com";
/** Throwaway credential valid only in the disposable test instance. */
const TEST_PASSWORD = "DraftCourt-E2E-2026!pick";

const TEAM_COUNT = 4; // smallest legal league (schema min 4)
const ROUNDS = 11; // wizard minimum: fixed roster totals 11 slots
const TOTAL_PICKS = TEAM_COUNT * ROUNDS;
/** Overall pick taken authoritatively via API to force a stale-version UI pick. */
const CONFLICT_OVERALL = 8; // also the user's round-2 pick (slot 1)
/** Mid-draft point with real candidates where pause/resume is exercised. */
const PAUSE_AT_OVERALL = 37;

const state: {
  draftId: string | null;
  knownPlayerId: string | null;
  ownerUserId: string | null;
  intruderUserId: string | null;
} = { draftId: null, knownPlayerId: null, ownerUserId: null, intruderUserId: null };

let ownerCredentials: TestClerkCredentials | null = null;

/** Re-establishes a genuine Clerk session (fresh sign-in token through the
 * app's own provider) when the long-running scenario outlives one. */
async function ensureOwnerSession(page: Page): Promise<void> {
  if (state.ownerUserId === null || ownerCredentials === null) {
    throw new Error("cannot restore session — owner user missing");
  }
  await signInViaTicket(page, ownerCredentials, state.ownerUserId);
  await page.goto(`/drafts/${requireDraftId()}`);
}

function roundForOverall(overall: number): number {
  return Math.floor((overall - 1) / TEAM_COUNT) + 1;
}

function slotForOverall(overall: number): number {
  const positionInRound = ((overall - 1) % TEAM_COUNT) + 1;
  const round = roundForOverall(overall);
  return round % 2 === 1 ? positionInRound : TEAM_COUNT + 1 - positionInRound;
}

function requireDraftId(): string {
  if (state.draftId === null) throw new Error("Draft id missing — serial prerequisite failed.");
  return state.draftId;
}

function cellForOverall(page: Page, overall: number): Locator {
  return page.getByTestId(
    `dc-board-cell-r${String(roundForOverall(overall))}c${String(slotForOverall(overall))}`,
  );
}

function recommendationItems(page: Page): Locator {
  return page.locator("#dc-panel-recommendations ol li");
}

function firstRecommendationButton(page: Page): Locator {
  return recommendationItems(page).first().getByRole("button", { name: "Draft", exact: true });
}

interface RecommendationSummary {
  playerId: string;
  displayName: string;
}

async function topRecommendation(page: Page): Promise<RecommendationSummary | null> {
  const response = await page.request.get(`/api/v1/drafts/${requireDraftId()}/recommendations`);
  if (!response.ok()) return null;
  const body = (await response.json()) as {
    data?: { top3?: { playerId: string; displayName: string }[] };
  };
  return body.data?.top3?.[0] ?? null;
}

interface ReadModel {
  status: string;
  version: number;
  nextOverallPick: number;
}

async function readModel(page: Page): Promise<ReadModel> {
  // Under full-suite load the Clerk session can rotate mid-scenario; a stale
  // cookie yields one transient non-OK before the refreshed one lands. Retry
  // briefly instead of failing an otherwise-valid acceptance run.
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await page.request.get(`/api/v1/drafts/${requireDraftId()}`);
    if (response.ok()) {
      const body = (await response.json()) as { data?: ReadModel };
      if (body.data === undefined) {
        throw new Error("Draft read model response missing data.");
      }
      return body.data;
    }
    lastStatus = response.status();
    if (lastStatus === 401) {
      await ensureOwnerSession(page);
      continue;
    }
    await page.waitForTimeout(750 * (attempt + 1));
  }
  throw new Error(`Draft read model never responded OK (last status ${String(lastStatus)}).`);
}

/** Makes one UI pick through the recommendation stack and verifies the
 * board cell fills AND the recommendations change afterwards. */
async function pickViaFirstRecommendation(page: Page, overall: number): Promise<string> {
  const current = await topRecommendation(page);
  expect(current).not.toBeNull();

  await firstRecommendationButton(page).click();
  await expect(cellForOverall(page, overall).locator(".dc-board-player")).toContainText(
    current?.displayName ?? "",
    { timeout: 15_000 },
  );
  await expect
    .poll(() => topRecommendation(page).then((rec) => rec?.playerId ?? null), {
      timeout: 15_000,
      message: "recommendations did not update after the pick",
    })
    .not.toBe(current?.playerId ?? null);
  return current?.displayName ?? "";
}

async function poolAvailability(page: Page, displayName: string): Promise<"available" | "drafted"> {
  await page.getByRole("tab", { name: "Available players" }).click();
  const search = page.getByPlaceholder("Press / to search");
  await search.fill(displayName);
  const row = page.locator('ul[aria-label="Search results"] li').filter({ hasText: displayName });
  const buttonText = await row.first().getByRole("button").textContent();
  await search.fill("");
  await page.getByRole("tab", { name: "Board" }).click();
  return buttonText?.trim() === "Drafted" ? "drafted" : "available";
}

test("full authenticated short-draft acceptance", async ({ page, browser }) => {
  test.skip(
    test.info().project.name !== "chromium",
    "heavy authenticated acceptance runs once on desktop chromium",
  );
  test.setTimeout(12 * 60_000);
  test.info().annotations.push({
    type: "note",
    description:
      "Serial acceptance scenario; runs once on desktop chromium (skips on mobile/light projects).",
  });

  // ---- Test-only environment guard + deterministic Clerk users -------------
  // (Inside the test so the reset inherits the long timeout — hooks would be
  // bound to the 30 s default and can exceed it under load.)
  const credentials: TestClerkCredentials = loadTestOnlyClerkCredentials();
  ownerCredentials = credentials;
  state.ownerUserId = await resetClerkTestUser(OWNER_EMAIL, TEST_PASSWORD, "Owner");
  state.intruderUserId = await resetClerkTestUser(INTRUDER_EMAIL, TEST_PASSWORD, "Intruder");

  // 1. Sign in through the app's own Clerk surface ----------------------------
  await signInViaTicket(page, credentials, state.ownerUserId);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Your leagues" })).toBeVisible();

  // 2. Create the smallest valid league through the wizard -------------------
  // (Fresh browser context per run ⇒ no stale wizard resume-state.)
  await page.goto("/leagues/new");
  const leagueName = `E2E acceptance ${String(Date.now())}`;
  await page.getByLabel("League name").fill(leagueName);
  await expect(page.getByLabel("League name")).toHaveValue(leagueName);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Scoring rules")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Roster slots")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Teams in league").fill(String(TEAM_COUNT));
  await page.getByLabel("Your draft slot").fill("1");
  await page.getByLabel("Draft rounds").fill(String(ROUNDS));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Create league" }).click();
  const settingsUrl = /\/leagues\/([0-9a-f-]{36})\/settings$/u;
  await page.waitForURL(settingsUrl);
  const leagueId = settingsUrl.exec(page.url())?.[1];
  expect(leagueId).toBeTruthy();

  // 3. Create + start a short REAL snake draft --------------------------------
  const created = await page.request.post("/api/v1/drafts", {
    data: { leagueId, type: "REAL" },
  });
  expect(created.status()).toBe(200);
  const createdBody = (await created.json()) as { data?: { id?: string } };
  expect(createdBody.data?.id).toBeTruthy();
  state.draftId = createdBody.data?.id ?? null;

  const started = await page.request.post(`/api/v1/drafts/${requireDraftId()}/start`);
  expect(started.status()).toBe(200);
  expect(((await started.json()) as { data?: { status?: string } }).data?.status).toBe("ACTIVE");

  // 4. Enter the private live draft room --------------------------------------
  await page.goto(`/drafts/${requireDraftId()}`);
  await expect(page.locator('span[data-status="ACTIVE"]')).toBeVisible();
  await expect(recommendationItems(page)).toHaveCount(3, { timeout: 30_000 });

  // 5–10. Picks with recommendation updates; controlled conflict; armed undo --
  const rosterItems = page.locator("#dc-panel-roster ul li");
  let overall = 1;

  while (overall <= TOTAL_PICKS) {
    if (overall === CONFLICT_OVERALL) {
      // 8. Controlled version conflict: an authoritative concurrent pick
      // advances the server; the room's stale If-Match must 409 + recover.
      const stale = await readModel(page);
      const apiPick = await topRecommendation(page);
      expect(apiPick).not.toBeNull();
      const apiResponse = await page.request.post(`/api/v1/drafts/${requireDraftId()}/picks`, {
        headers: {
          "If-Match": String(stale.version),
          "Idempotency-Key": `e2e-conflict-pick-${String(stale.version)}`,
        },
        data: { playerId: apiPick?.playerId },
      });
      expect(apiResponse.status()).toBe(200);
      state.knownPlayerId = apiPick?.playerId ?? null;

      const uiAttempt = await topRecommendation(page);
      expect(uiAttempt).not.toBeNull();
      await firstRecommendationButton(page).click(); // stale If-Match → 409

      const banner = page.locator("div.dc-freshness-banner[role=alert]");
      await expect(banner).toBeVisible();
      await expect(cellForOverall(page, CONFLICT_OVERALL)).toContainText(
        apiPick?.displayName ?? "",
      ); // authoritative state reconciled into the board
      await banner.getByRole("button", { name: "Dismiss" }).click();
      await expect(banner).toBeHidden();
      expect(await poolAvailability(page, uiAttempt?.displayName ?? "")).toBe("available");

      // 9–10. Arm-and-confirm Undo of the latest effective pick, verify state.
      await page.getByRole("tab", { name: "My roster" }).click();
      await expect(rosterItems).toHaveCount(2); // overall 1 + conflicted overall 8
      await page.getByRole("tab", { name: "Board" }).click();

      const undoName = (
        await cellForOverall(page, CONFLICT_OVERALL).locator(".dc-board-player").textContent()
      )?.trim();
      expect(undoName).toBeTruthy();

      const undoButton = page.getByRole("button", { name: "Undo", exact: true });
      await undoButton.click();
      const armedUndo = page.getByRole("button", { name: "Confirm undo", exact: true });
      await expect(armedUndo).toHaveAttribute("data-armed", "true");
      await armedUndo.click();

      await expect(cellForOverall(page, CONFLICT_OVERALL)).toContainText(String(CONFLICT_OVERALL)); // open pick number restored
      await page.getByRole("tab", { name: "My roster" }).click();
      await expect(rosterItems).toHaveCount(1);
      const afterUndo = await readModel(page);
      expect(afterUndo.nextOverallPick).toBe(CONFLICT_OVERALL);
      expect(afterUndo.version).toBeGreaterThan(stale.version + 1);
      expect(await poolAvailability(page, undoName ?? "")).toBe("available");

      // Re-fill the undone slot so the board can complete later.
      await page.getByRole("tab", { name: "Board" }).click();
      await pickViaFirstRecommendation(page, CONFLICT_OVERALL);
      await page.getByRole("tab", { name: "My roster" }).click();
      await expect(rosterItems).toHaveCount(2);
      await page.getByRole("tab", { name: "Board" }).click();

      overall = CONFLICT_OVERALL + 1;
      continue;
    }

    if (overall === PAUSE_AT_OVERALL) {
      // 11–12. Pause and resume mid-draft (real candidates still on the
      // board). Every status transition bumps the optimistic version
      // (drafts.ts transitionStatus); a rejected pick must change nothing.
      const prePause = await readModel(page);
      const paused = await page.request.post(`/api/v1/drafts/${requireDraftId()}/pause`);
      expect(paused.status()).toBe(200);
      await page.reload();
      await expect(page.locator('span[data-status="PAUSED"]')).toBeVisible();
      expect(await readModel(page)).toMatchObject({
        status: "PAUSED",
        version: prePause.version + 1,
        nextOverallPick: prePause.nextOverallPick,
      });

      await firstRecommendationButton(page).click(); // must be rejected while paused
      await expect(page.locator(".dc-room-note")).toContainText(/active/i);
      expect(await readModel(page)).toMatchObject({
        version: prePause.version + 1,
        nextOverallPick: prePause.nextOverallPick,
      }); // pause accepted nothing

      const resumed = await page.request.post(`/api/v1/drafts/${requireDraftId()}/resume`);
      expect(resumed.status()).toBe(200);
      await page.reload();
      await expect(page.locator('span[data-status="ACTIVE"]')).toBeVisible();
      expect(await readModel(page)).toMatchObject({ version: prePause.version + 2 });
    }

    await pickViaFirstRecommendation(page, overall);
    overall += 1;
  }

  const finished = await readModel(page);
  expect(finished.nextOverallPick).toBe(TOTAL_PICKS + 1);
  expect(finished.status).toBe("ACTIVE");

  // 16. Finish the draft; completed status, rosters, pick history --------------
  const completed = await page.request.post(`/api/v1/drafts/${requireDraftId()}/complete`);
  expect(completed.status()).toBe(200);
  expect(((await completed.json()) as { data?: { status?: string } }).data?.status).toBe(
    "COMPLETED",
  );
  await page.reload();
  await expect(page.locator('span[data-status="COMPLETED"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  // readOnly removes the recommendation Draft actions entirely; remaining
  // pool buttons stay visible but disabled.
  await expect(page.locator("#dc-panel-recommendations button")).toHaveCount(0);
  const poolDraftButtons = page.getByRole("button", { name: "Draft", exact: true });
  const poolDraftCount = await poolDraftButtons.count();
  for (let index = 0; index < poolDraftCount; index += 1) {
    await expect(poolDraftButtons.nth(index)).toBeDisabled();
  }

  await page.getByText("Board data table").click();
  const historyRows = page.locator(".dc-board-table tbody tr");
  await expect(historyRows).toHaveCount(TOTAL_PICKS);
  await expect(historyRows.first()).toContainText("(you)");

  await page.getByRole("tab", { name: "My roster" }).click();
  await expect(rosterItems).toHaveCount(ROUNDS);
  await page.getByRole("tab", { name: "Board" }).click();

  // 17. Unauthenticated requests are rejected ----------------------------------
  const origin = new URL(page.url()).origin;
  const anonymous = await newRequestContext.newContext({ baseURL: origin });
  const anonApi = await anonymous.get(`/api/v1/drafts/${requireDraftId()}`);
  expect(anonApi.status()).toBe(401);
  expect(((await anonApi.json()) as { data: unknown }).data).toBeNull();
  await anonymous.dispose();

  const anonContext = await browser.newContext();
  const anonPage = await anonContext.newPage();
  await anonPage.goto(`/drafts/${requireDraftId()}`);
  await expect(anonPage.getByText("Sign in to run your draft")).toBeVisible();
  await anonContext.close();

  // 18. Another signed-in user cannot access the private draft -----------------
  const intruderContext = await browser.newContext();
  const intruderPage = await intruderContext.newPage();
  await signInViaTicket(intruderPage, credentials, state.intruderUserId);
  const intruderApi = await intruderPage.request.get(`/api/v1/drafts/${requireDraftId()}`);
  expect(intruderApi.status()).toBe(404); // ownership scoping hides foreign drafts
  const intruderPick = await intruderPage.request.post(`/api/v1/drafts/${requireDraftId()}/picks`, {
    headers: { "If-Match": "0", "Idempotency-Key": "e2e-intruder-pick" },
    data: { playerId: state.knownPlayerId },
  });
  expect(intruderPick.status()).toBe(404);
  await intruderPage.goto(`/drafts/${requireDraftId()}`);
  await expect(intruderPage.getByText("Draft not found")).toBeVisible();
  await intruderContext.close();

  // Best-effort test-instance hygiene; never fails the run.
  await deleteClerkTestUsersByEmail(OWNER_EMAIL);
  await deleteClerkTestUsersByEmail(INTRUDER_EMAIL);
});
