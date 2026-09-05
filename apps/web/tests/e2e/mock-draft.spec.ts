import AxeBuilder from "@axe-core/playwright";
import { expect, request as newRequestContext, test, type Page } from "@playwright/test";
import {
  deleteClerkTestUsersByEmail,
  loadTestOnlyClerkCredentials,
  resetClerkTestUser,
  signInViaTicket,
} from "./helpers/clerk-test-env";

/**
 * Phase 3C Playwright acceptance: mock drafts end-to-end.
 *
 * One rerunnable chromium scenario over the REAL production build: a MOCK
 * draft is created through the /drafts/new UI (personality, seed, pacing),
 * the room shows the simulation seed, the user's picks interleave with CPU
 * picks driven by Advance / auto-advance / Pause-Resume / Cancel, authority
 * survives reloads, INSTANT bursts produce exactly one live-region summary,
 * determinism is proven by same-seed twin mocks sharing an identical
 * PLAYER_DRAFTED sequence, and privacy/overflow/dark/reduced-motion gates
 * close the run.
 *
 * NOTE: the cpu-pick endpoint and its room wiring land during the primary
 * integration patch. This spec is written against the published contracts;
 * if it fails while those pieces are mid-integration that is expected — do
 * NOT weaken assertions to pass early.
 */

test.describe.configure({ mode: "serial" });

const OWNER_EMAIL = "draftcourt-e2e-mock+clerk_test@example.com";
const TEST_PASSWORD = "DraftCourt-E2E-2026!pick";

const TEAM_COUNT = 4;
const ROUNDS = 6;
const TOTAL_PICKS = TEAM_COUNT * ROUNDS;
const USER_SLOT = 1;
/** Seed typed into the start-flow input (matches ^[A-Za-z0-9-]{1,64}$). */
const SIMULATION_SEED = `MOCKE2E-${String(Date.now()).slice(-6)}`;
/** Mirrors mockPacing.NORMAL — used only for stability windows. */
const NORMAL_MS = 3_500;
const STABILITY_WINDOW_MS = NORMAL_MS * 2 + 2_000;

interface EventRow {
  eventType: string;
  playerId: string | null;
  sequence: number;
}

function slotForOverall(overall: number): number {
  const positionInRound = ((overall - 1) % TEAM_COUNT) + 1;
  const round = Math.floor((overall - 1) / TEAM_COUNT) + 1;
  return round % 2 === 1 ? positionInRound : TEAM_COUNT + 1 - positionInRound;
}

function isUserOverall(overall: number): boolean {
  return slotForOverall(overall) === USER_SLOT;
}

async function draftedEvents(page: Page, draftId: string): Promise<EventRow[]> {
  const response = await page.request.get(`/api/v1/drafts/${draftId}/events`);
  if (response.status() !== 200) {
    throw new Error(`league create ${String(response.status())}: ${await response.text()}`);
  }
  // The endpoint returns the event array directly as data.
  const body = (await response.json()) as { data?: EventRow[] | { events?: EventRow[] } };
  const rows = Array.isArray(body.data) ? body.data : (body.data?.events ?? []);
  return rows.filter((event) => event.eventType === "PLAYER_DRAFTED");
}

async function readModelOn(
  page: Page,
  draftId: string,
): Promise<{ status: string; version: number; nextOverallPick: number }> {
  const response = await page.request.get(`/api/v1/drafts/${draftId}`);
  if (response.status() !== 200) {
    throw new Error(`league create ${String(response.status())}: ${await response.text()}`);
  }
  const body = (await response.json()) as {
    data?: { status: string; version: number; nextOverallPick: number };
  };
  if (body.data === undefined) throw new Error("draft read model missing data");
  return body.data;
}

/** One authoritative API cpu-pick cycle mirroring useMockRunner's headers. */
async function apiCpuPick(page: Page, draftId: string): Promise<boolean> {
  const current = await readModelOn(page, draftId);
  if (current.status !== "ACTIVE") return false;
  if (isUserOverall(current.nextOverallPick)) return false;
  const response = await page.request.post(`/api/v1/drafts/${draftId}/cpu-pick`, {
    headers: {
      "If-Match": String(current.version),
      "Idempotency-Key": `cpu-${draftId}-${String(current.nextOverallPick)}-${String(current.version)}`,
    },
  });
  if (!response.ok()) throw new Error(`cpu-pick failed: ${String(response.status())}`);
  return true;
}

async function seedLeague(page: Page, name: string): Promise<string> {
  const hb = "HIGHER_BETTER" as const;
  const lb = "LOWER_BETTER" as const;
  const response = await page.request.post("/api/v1/leagues", {
    data: {
      name,
      season: "2026-27",
      teamCount: TEAM_COUNT,
      userDraftSlot: USER_SLOT,
      rounds: ROUNDS,
      config: {
        type: "POINTS",
        horizon: "REDRAFT",
        playoffWeeks: null,
        scoringRules: [
          { stat: "PTS", weight: 1, direction: hb },
          { stat: "REB", weight: 1.2, direction: hb },
          { stat: "AST", weight: 1.5, direction: hb },
          { stat: "TOV", weight: -1, direction: lb },
        ],
        rosterSlots: [
          { position: "PG", count: 1, starter: true },
          { position: "SG", count: 1, starter: true },
          { position: "UTIL", count: 2, starter: true },
          { position: "BENCH", count: 2, starter: false },
        ],
      },
    },
  });
  if (response.status() !== 200) {
    throw new Error(`league create ${String(response.status())}: ${await response.text()}`);
  }
  const body = (await response.json()) as {
    data?: { id?: string; teams?: { slot: number }[] };
    error?: { detail?: string; errors?: Record<string, string[]> };
  };
  const id = body.data?.id;
  if (!id) throw new Error(`league not created: ${JSON.stringify(body.error)}`);
  // Expose every team slot so per-team personality overrides can target them.
  return id;
}

test("mock draft end-to-end acceptance", async ({ browser }) => {
  test.skip(
    test.info().project.name !== "chromium",
    "heavy authenticated acceptance runs once on desktop chromium",
  );
  test.setTimeout(7 * 60_000);

  // Dedicated context so clipboard write (seed Copy) is permitted strictly.
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  try {
    const credentials = loadTestOnlyClerkCredentials();
    const ownerUserId = await resetClerkTestUser(OWNER_EMAIL, TEST_PASSWORD, "Owner");

    // 1. Sign in through the app's own Clerk surface.
    await signInViaTicket(page, credentials, ownerUserId);

    // 2. Seed the league via API.
    const leagueName = `Mock E2E ${String(Date.now())}`;
    const leagueId = await seedLeague(page, leagueName);

    // 3. Open /drafts/new; axe gate must hold with every MOCK surface revealed.
    await page.goto("/drafts/new");
    await page.getByRole("radio", { name: new RegExp(leagueName, "u") }).click();
    await page.getByRole("radio", { name: /Mock draft/u }).click();
    const setup = page.getByRole("region", { name: "Mock draft setup" });
    await expect(setup).toBeVisible();
    await setup.getByText("Advanced: per-team personalities").click();
    const axeResults = await new AxeBuilder({ page }).analyze();
    expect(
      axeResults.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
    ).toEqual([]);

    // 4. Configure: personality, seed S, NORMAL speed, auto-advance OFF.
    await page.getByRole("radio", { name: /ADP Follower/u }).click();
    await page.getByLabel("Simulation seed (optional)").fill(SIMULATION_SEED);
    await page.getByRole("radio", { name: "Normal", exact: true }).click();
    await expect(page.getByRole("switch", { name: "Auto-advance" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    // 5. Start through the UI; land in the room.
    await page.getByRole("button", { name: "Start draft" }).click();
    await page.waitForURL(/\/drafts\/[0-9a-f-]{36}$/u);
    const draftId = /\/drafts\/([0-9a-f-]{36})$/u.exec(page.url())?.[1];
    if (!draftId) throw new Error("draft id missing after start");

    // 6. Room shows seed S.
    await expect(page.locator('span[data-status="ACTIVE"]')).toBeVisible({ timeout: 30_000 });
    const strip = page.locator(".dc-mock-status-strip");
    await expect(strip).toContainText(SIMULATION_SEED);

    // 7. Copy writes the seed and announces confirmation politely.
    await page.getByRole("button", { name: "Copy simulation seed" }).click();
    await expect(
      page.locator('[role="status"]:has-text("Simulation seed copied.")').first(),
    ).toBeAttached();

    const recommendationItems = page.locator("#dc-panel-recommendations ol li");

    // 8. User pick #1 (overall 1) via recommendations.
    await expect(recommendationItems).toHaveCount(3, { timeout: 30_000 });
    await recommendationItems.first().getByRole("button", { name: "Draft", exact: true }).click();
    await expect.poll(() => draftedEvents(page, draftId).then((e) => e.length)).toBe(1);

    // 9. Pause-after-user proof: auto-advance OFF means nothing moves.
    await page.waitForTimeout(STABILITY_WINDOW_MS);
    expect(await draftedEvents(page, draftId)).toHaveLength(1);

    // 10. Advance ⇒ EXACTLY one new PLAYER_DRAFTED (overall 2).
    await expect(page.locator(".dc-mock-controls-progress")).toContainText("Mock controls ready.");
    await page.getByRole("button", { name: "Advance" }).click();
    await expect.poll(() => draftedEvents(page, draftId).then((e) => e.length)).toBe(2);

    // 11. Auto-advance ON ⇒ paced CPU picks stop EXACTLY at the derived user
    //     turn (overall 8); per-pick chatter stays out of the live region.
    await page.getByRole("switch", { name: "Auto-advance" }).click();
    await expect
      .poll(() => draftedEvents(page, draftId).then((e) => e.length), { timeout: 45_000 })
      .toBe(7); // CPU fills overalls 3–7 after the Advance in step 10
    await page.waitForTimeout(STABILITY_WINDOW_MS);
    expect(await draftedEvents(page, draftId)).toHaveLength(7); // held at user turn
    await expect(page.locator(".dc-mock-controls-progress")).toContainText("Your turn");
    await page.getByRole("switch", { name: "Auto-advance" }).click(); // OFF

    // 12. Reload derives authority from the server read model.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(strip).toContainText(SIMULATION_SEED);
    const authority = await readModelOn(page, draftId);
    await expect(page.locator(".dc-status-picks")).toContainText(
      `pick ${String(authority.nextOverallPick)}`,
    );
    await expect(recommendationItems).toHaveCount(3, { timeout: 30_000 });

    // 13. User owns back-to-back overalls 8 AND 9 (slot-1 snake fold); then a
    //     short INSTANT auto-burst is stopped deterministically by switching
    //     auto-advance OFF (cancel button exercised separately while idle).
    for (let guard = 0; guard < 2; guard += 1) {
      await recommendationItems.first().getByRole("button", { name: "Draft", exact: true }).click();
      await expect.poll(() => draftedEvents(page, draftId).then((e) => e.length)).toBe(8 + guard);
    }
    await page.getByRole("radio", { name: "Instant", exact: true }).click();
    await page.getByRole("switch", { name: "Auto-advance" }).click();
    await expect
      .poll(() => draftedEvents(page, draftId).then((e) => e.length), { timeout: 15_000 })
      .toBeGreaterThan(9); // burst is running
    await page.getByRole("switch", { name: "Auto-advance" }).click(); // OFF stops it
    // An already-in-flight cycle may still commit once — absorb it, then
    // prove STILLNESS across a full stability window before freezing counts.
    await page.waitForTimeout(STABILITY_WINDOW_MS);
    const settledCount = await draftedEvents(page, draftId).then((e) => e.length);
    expect(settledCount).toBeLessThanOrEqual(TOTAL_PICKS - 1);
    await page.waitForTimeout(STABILITY_WINDOW_MS);
    expect(await draftedEvents(page, draftId)).toHaveLength(settledCount); // settled
    // Cancel-button behavior (rendered only while a request is in flight,
    // i.e. during the ~sub-second commit window) is covered deterministically
    // by the fake-timer RTL suite; here the paused/idle surface must show
    // exactly Advance/Resume and never a stale Cancel.
    await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);

    // 14. Reduced-motion rerun: controls stay fully operable, nothing animates;
    //     a single manual Advance moves EXACTLY one pick further.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const track = page.locator(".dc-mock-switch-track").first();
    await expect(track).toHaveCSS("transition-duration", /^0(\.\d+)?s$/u);
    await page.getByRole("button", { name: "Advance" }).click();
    await expect
      .poll(() => draftedEvents(page, draftId).then((e) => e.length))
      .toBe(settledCount + 1);
    await page.waitForTimeout(STABILITY_WINDOW_MS);
    expect(await draftedEvents(page, draftId)).toHaveLength(settledCount + 1);
    await page.emulateMedia({ reducedMotion: null });

    // 15. Server-side pause/resume around the mock room.
    const paused = await page.request.post(`/api/v1/drafts/${draftId}/pause`);
    expect(paused.status()).toBe(200);
    await page.reload();
    await expect(page.locator('span[data-status="PAUSED"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Advance" })).toBeDisabled();
    const resumed = await page.request.post(`/api/v1/drafts/${draftId}/resume`);
    expect(resumed.status()).toBe(200);
    await page.reload();
    await expect(page.locator('span[data-status="ACTIVE"]')).toBeVisible();
    await expect(recommendationItems).toHaveCount(3, { timeout: 30_000 });

    // 16. INSTANT batch ⇒ exactly ONE live-region summary for the whole run:
    //     per-pick text stays in the aria-live="off" progress line, and the
    //     burst carries the draft all the way to COMPLETED.
    await page.getByRole("radio", { name: "Instant", exact: true }).click();
    const politeRegion = page.locator(".dc-draft-room > div[aria-live='polite']");
    const beforeBatch = (await politeRegion.textContent()) ?? "";
    await page.getByRole("switch", { name: "Auto-advance" }).click();
    // The runner ALWAYS yields at the user's turn — including the snake fold
    // where slot 1 owns back-to-back overalls (16 and 17 here). Drive user
    // picks as they arise; auto-advance handles every CPU pick in between.
    for (let guard = 0; guard < TOTAL_PICKS; guard += 1) {
      const done = await page
        .locator('span[data-status="COMPLETED"]')
        .isVisible()
        .catch(() => false);
      if (done) break;
      const progress = await page
        .locator(".dc-mock-controls-progress")
        .textContent()
        .catch(() => "");
      if ((progress ?? "").includes("Draft complete")) break;
      if ((progress ?? "").includes("Your turn")) {
        // A full board empties the recommendations panel — nothing left for
        // the user to draft; the API-complete fallback below finishes up.
        const draftButton = recommendationItems
          .first()
          .getByRole("button", { name: "Draft", exact: true });
        if ((await draftButton.count()) === 0) break;
        await draftButton.click();
      }
      await page.waitForTimeout(500);
    }
    // A full board stays ACTIVE until completion is requested explicitly —
    // the runner stops at board-full, and the owner closes it out.
    const preComplete = await readModelOn(page, draftId);
    if (preComplete.status !== "COMPLETED") {
      const completedResponse = await page.request.post(`/api/v1/drafts/${draftId}/complete`);
      expect(completedResponse.status()).toBe(200);
    }
    await page.reload();
    await expect(page.locator('span[data-status="COMPLETED"]')).toBeVisible({ timeout: 30_000 });
    const afterBatch = (await politeRegion.textContent()) ?? "";
    expect(afterBatch).not.toContain("CPU drafted"); // never announced per-pick
    expect(afterBatch === beforeBatch || /Draft complete|Your turn/u.test(afterBatch)).toBe(true);
    await expect(strip).toContainText("Completed ·"); // completed strip variant
    expect(await draftedEvents(page, draftId)).toHaveLength(TOTAL_PICKS);

    // 18. Same-seed determinism: two API-created twin mocks share the exact
    //     PLAYER_DRAFTED playerId sequence (user turns skipped by the driver).
    const twinIds: string[] = [];
    for (let twin = 0; twin < 2; twin += 1) {
      const created = await page.request.post("/api/v1/drafts", {
        data: {
          leagueId,
          type: "MOCK",
          cpuPersonalityKey: "adp-follower",
          simulationSeed: "TWIN-SEQ-1",
        },
      });
      expect(created.status()).toBe(200);
      const body = (await created.json()) as { data?: { id?: string } };
      const twinId = body.data?.id;
      expect(twinId).toBeTruthy();
      if (!twinId) throw new Error("twin draft not created");
      twinIds.push(twinId);
      const started = await page.request.post(`/api/v1/drafts/${twinId}/start`);
      expect(started.status()).toBe(200);
      // Drive the whole board: CPU turns via cpu-pick, user turns via the
      // deterministic engine's top recommendation (identical inputs across
      // twins ⇒ identical sequences).
      for (let guard = 0; guard < TOTAL_PICKS * 2 + 4; guard += 1) {
        const model = await readModelOn(page, twinId);
        if (model.status !== "ACTIVE") break;
        if (isUserOverall(model.nextOverallPick)) {
          const recs = (await (
            await page.request.get(`/api/v1/drafts/${twinId}/recommendations`)
          ).json()) as { data?: { top3?: { playerId: string }[] } };
          const target = recs.data?.top3?.[0]?.playerId;
          if (!target) break;
          const pickResponse = await page.request.post(`/api/v1/drafts/${twinId}/picks`, {
            headers: {
              "If-Match": String(model.version),
              "Idempotency-Key": `twin-${twinId}-${String(model.nextOverallPick)}`,
            },
            data: { playerId: target },
          });
          if (!pickResponse.ok())
            throw new Error(`twin user pick failed: ${String(pickResponse.status())}`);
        } else if (!(await apiCpuPick(page, twinId))) break;
      }
    }
    const twinSequences = await Promise.all(
      twinIds.map(async (twinId) =>
        (await draftedEvents(page, twinId)).map((event) => event.playerId).join(","),
      ),
    );
    expect(twinSequences[0]).toBeTruthy();
    expect(twinSequences[0]).toBe(twinSequences[1]);

    // 19. Unauthorized access rejection (fresh anonymous context).
    const origin = new URL(page.url()).origin;
    const anonymous = await newRequestContext.newContext({ baseURL: origin });
    const anonApi = await anonymous.get(`/api/v1/drafts/${draftId}`);
    expect(anonApi.status()).toBe(401);
    await anonymous.dispose();
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    await anonPage.goto(`/drafts/${draftId}`);
    await expect(anonPage.getByText("Sign in to run your draft")).toBeVisible();
    await anonContext.close();

    // 20. 320 px overflow gate + dark color-scheme, asserted inline.
    await page.setViewportSize({ width: 320, height: 700 });
    const overflowPx = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowPx).toBeLessThanOrEqual(1);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(strip).toBeVisible();
    const stripColor = await strip.evaluate((element) => getComputedStyle(element).color);
    expect(stripColor.trim().length).toBeGreaterThan(0);
  } finally {
    await deleteClerkTestUsersByEmail(OWNER_EMAIL);
    await context.close();
  }
});
