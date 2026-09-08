/* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unnecessary-condition */
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  deleteClerkTestUsersByEmail,
  loadTestOnlyClerkCredentials,
  resetClerkTestUser,
  signInViaTicket,
} from "./helpers/clerk-test-env";

test.describe.configure({ mode: "serial" });

const OWNER_EMAIL = "draftcourt-e2e-replay+clerk_test@example.com";
const TEST_PASSWORD = "DraftCourt-E2E-2026!replay";

const TEAM_COUNT = 4;
const ROUNDS = 6;
const TOTAL_PICKS = TEAM_COUNT * ROUNDS;

let ownerUserId: string | null = null;

async function seedLeagueViaApi(page: Page, name: string): Promise<string> {
  const resp = await page.request.post("/api/v1/leagues", {
    data: {
      name,
      season: "2026-27",
      teamCount: TEAM_COUNT,
      userDraftSlot: 1,
      rounds: ROUNDS,
      config: {
        type: "POINTS",
        horizon: "REDRAFT",
        playoffWeeks: null,
        scoringRules: [
          { stat: "PTS", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
          { stat: "REB", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
        ],
        rosterSlots: [
          { position: "PG", count: 1, starter: true },
          { position: "SG", count: 1, starter: true },
          { position: "UTIL", count: 1, starter: true },
          { position: "BENCH", count: 3, starter: false },
        ],
      },
    },
  });
  expect(resp.status()).toBe(200);
  const body = (await resp.json()) as { data?: { id?: string } };
  const id = body.data?.id ?? "";
  expect(id).toBeTruthy();
  return id;
}

async function readModel(page: Page, draftId: string) {
  const resp = await page.request.get(`/api/v1/drafts/${draftId}`);
  expect(resp.status()).toBe(200);
  const body = (await resp.json()) as {
    data?: { status?: string; nextOverallPick?: number; version?: number };
  };
  return {
    status: body.data?.status ?? "",
    next: body.data?.nextOverallPick ?? 1,
    version: body.data?.version ?? 0,
  };
}

async function cpuPick(page: Page, draftId: string, version: number, key: string) {
  const resp = await page.request.post(`/api/v1/drafts/${draftId}/cpu-pick`, {
    headers: { "If-Match": String(version), "Idempotency-Key": key },
  });
  expect(resp.status()).toBe(200);
}

async function userPick(page: Page, draftId: string, version: number, key: string) {
  const recResp = await page.request.get(`/api/v1/drafts/${draftId}/recommendations`);
  expect(recResp.status()).toBe(200);
  const recBody = (await recResp.json()) as { data?: { top3?: { playerId: string }[] } };
  const target = recBody.data?.top3?.[0]?.playerId;
  expect(target).toBeTruthy();
  const pickResp = await page.request.post(`/api/v1/drafts/${draftId}/picks`, {
    headers: { "If-Match": String(version), "Idempotency-Key": key },
    data: { playerId: target },
  });
  expect(pickResp.status()).toBe(200);
}

/** Completes a 4x4 mock with one undo+repick cycle to exercise alternate history. */
async function createCompletedMockWithUndo(page: Page, leagueId: string): Promise<string> {
  const created = await page.request.post("/api/v1/drafts", {
    data: {
      leagueId,
      type: "MOCK",
      simulationSeed: `replay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    },
  });
  expect(created.status()).toBe(200);
  const { data } = (await created.json()) as { data?: { id?: string } };
  const draftId = data?.id ?? "";
  expect(draftId).toBeTruthy();
  expect((await page.request.post(`/api/v1/drafts/${draftId}/start`)).status()).toBe(200);

  let didUndo = false;
  let guard = 0;
  while (guard < TOTAL_PICKS * 3) {
    guard += 1;
    const model = await readModel(page, draftId);
    if (model.status === "COMPLETED") break;
    if (model.status !== "ACTIVE") break;
    if (model.next > TOTAL_PICKS) {
      const comp = await page.request.post(`/api/v1/drafts/${draftId}/complete`);
      expect([200, 409].includes(comp.status())).toBeTruthy();
      break;
    }
    // One undo+repick cycle once six effective picks exist.
    if (!didUndo && model.next === 7) {
      const undoResp = await page.request.post(`/api/v1/drafts/${draftId}/undo`, {
        headers: {
          "If-Match": String(model.version),
          "Idempotency-Key": `replay-undo-${draftId}`,
        },
      });
      expect(undoResp.status()).toBe(200);
      didUndo = true;
      continue;
    }
    const slotForOverall = (overall: number): number => {
      const pos = ((overall - 1) % TEAM_COUNT) + 1;
      const round = Math.floor((overall - 1) / TEAM_COUNT) + 1;
      return round % 2 === 1 ? pos : TEAM_COUNT + 1 - pos;
    };
    if (slotForOverall(model.next) === 1) {
      // Idempotency keys must be unique per ATTEMPT (not per pick number):
      // after an undo the same overall number is re-picked, and reusing the
      // pre-undo key would replay the undone outcome instead of advancing.
      await userPick(
        page,
        draftId,
        model.version,
        `replay-user-${draftId}-g${String(guard)}-n${String(model.next)}`,
      );
    } else {
      await cpuPick(
        page,
        draftId,
        model.version,
        `replay-cpu-${draftId}-g${String(guard)}-n${String(model.next)}`,
      );
    }
  }
  expect(didUndo).toBe(true);
  const verify = await readModel(page, draftId);
  if (verify.status !== "COMPLETED" && verify.next > TOTAL_PICKS) {
    expect((await page.request.post(`/api/v1/drafts/${draftId}/complete`)).status()).toBe(200);
  }
  expect((await readModel(page, draftId)).status).toBe("COMPLETED");
  return draftId;
}

test.describe("replay and private sharing — owner replay, redacted share, revocation", () => {
  test.beforeAll(async () => {
    loadTestOnlyClerkCredentials();
    ownerUserId = await resetClerkTestUser(OWNER_EMAIL, TEST_PASSWORD, "ReplayOwner");
  });

  test.afterAll(async () => {
    await deleteClerkTestUsersByEmail(OWNER_EMAIL).catch(() => undefined);
  });

  test("completed draft replays deterministically and shares privately end-to-end", async ({
    page,
    browser,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium",
      "heavy authenticated flow runs once on chromium",
    );
    test.setTimeout(8 * 60_000);
    const creds = loadTestOnlyClerkCredentials();
    if (!ownerUserId) throw new Error("owner not seeded");
    await signInViaTicket(page, creds, ownerUserId);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Your leagues" })).toBeVisible({
      timeout: 30_000,
    });

    const leagueId = await seedLeagueViaApi(page, `Replay E2E ${String(Date.now())}`);
    const draftId = await createCompletedMockWithUndo(page, leagueId);
    // 1 started + 25 picks + 1 undo + 1 completed = 28 events.
    const TOTAL_EVENTS = 28;

    // Owner timeline API: cursor shape, validation, integrity, no internals.
    const paged = await page.request.get(`/api/v1/drafts/${draftId}/events?limit=7`);
    expect(paged.status()).toBe(200);
    const pagedBody = (await paged.json()) as {
      data?: {
        events?: { sequence: number; actorType?: string; description?: string }[];
        nextCursor?: number | null;
        integrity?: { ok?: boolean };
      };
    };
    expect(pagedBody.data?.events).toHaveLength(7);
    expect(pagedBody.data?.nextCursor).toBe(7);
    expect(pagedBody.data?.integrity?.ok).toBe(true);
    expect(pagedBody.data?.events?.[0]?.actorType).toBe("SYSTEM");
    const paged2 = await page.request.get(`/api/v1/drafts/${draftId}/events?cursor=7&limit=50`);
    expect(paged2.status()).toBe(200);
    const paged2Body = (await paged2.json()) as {
      data?: { events?: { sequence: number }[]; nextCursor?: number | null };
    };
    expect(paged2Body.data?.events?.map((e) => e.sequence)).toEqual(
      Array.from({ length: TOTAL_EVENTS - 7 }, (_, i) => i + 8),
    );
    expect(paged2Body.data?.nextCursor).toBeNull();
    expect((await page.request.get(`/api/v1/drafts/${draftId}/events?limit=0`)).status()).toBe(422);
    expect((await page.request.get(`/api/v1/drafts/${draftId}/events?limit=101`)).status()).toBe(
      422,
    );
    // Legacy array shape preserved.
    const legacy = await page.request.get(`/api/v1/drafts/${draftId}/events`);
    expect(legacy.status()).toBe(200);
    const legacyBody = (await legacy.json()) as { data?: unknown[] };
    expect(Array.isArray(legacyBody.data)).toBe(true);
    expect(legacyBody.data).toHaveLength(TOTAL_EVENTS);

    const replayCount = (target: Page) => target.locator("output.dc-replay-count").first();
    const countText = async () => replayCount(page).textContent();

    // Results page: analysis + replay at final state.
    await page.goto(`/drafts/${draftId}/results`);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#grade-heading")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#replay-heading")).toBeVisible();
    await expect(page.getByText(/Replay integrity: OK/)).toBeVisible();
    await expect(replayCount(page)).toHaveText(
      `Event ${String(TOTAL_EVENTS)} of ${String(TOTAL_EVENTS)}`,
    );
    await expect(page.getByText(/Pick undone/i).first()).toBeVisible();

    const boardRows = () => page.locator(".dc-replay-board-panel tbody tr").count();
    expect(await boardRows()).toBe(TOTAL_PICKS);

    // First / Previous / Next / Last remain deterministic.
    await page.getByRole("button", { name: "First event" }).click();
    await expect(replayCount(page)).toHaveText(`Event 1 of ${String(TOTAL_EVENTS)}`);
    expect(await boardRows()).toBe(0);
    await page.getByRole("button", { name: "Next event" }).click();
    await expect(replayCount(page)).toHaveText(`Event 2 of ${String(TOTAL_EVENTS)}`);
    expect(await boardRows()).toBe(1);
    await page.getByRole("button", { name: "Last event" }).click();
    await expect(replayCount(page)).toHaveText(
      `Event ${String(TOTAL_EVENTS)} of ${String(TOTAL_EVENTS)}`,
    );
    expect(await boardRows()).toBe(TOTAL_PICKS);
    await page.getByRole("button", { name: "Previous event" }).click();
    await expect(replayCount(page)).toHaveText(
      `Event ${String(TOTAL_EVENTS - 1)} of ${String(TOTAL_EVENTS)}`,
    );

    // Scrub backward and forward.
    await page.locator("#dc-replay-scrub").fill("5");
    await expect(replayCount(page)).toHaveText(`Event 6 of ${String(TOTAL_EVENTS)}`);
    expect(await boardRows()).toBe(5);
    await page.locator("#dc-replay-scrub").fill(String(TOTAL_EVENTS - 1));
    await expect(replayCount(page)).toHaveText(
      `Event ${String(TOTAL_EVENTS)} of ${String(TOTAL_EVENTS)}`,
    );
    expect(await boardRows()).toBe(TOTAL_PICKS);

    // Speed switching while paused never moves position.
    await page.getByRole("button", { name: "Playback speed 2x" }).click();
    expect(
      await page.getByRole("button", { name: "Playback speed 2x" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await expect(replayCount(page)).toHaveText(
      `Event ${String(TOTAL_EVENTS)} of ${String(TOTAL_EVENTS)}`,
    );
    await page.getByRole("button", { name: "Playback speed 1x" }).click();

    // Play advances without arbitrary sleeps; focus stays on the control.
    await page.getByRole("button", { name: "First event" }).click();
    const playButton = page.getByRole("button", { name: "Play replay" });
    await playButton.click();
    await expect
      .poll(countText, { timeout: 10_000 })
      .not.toBe(`Event 1 of ${String(TOTAL_EVENTS)}`);
    const pauseButton = page.getByRole("button", { name: "Pause replay" });
    await expect(pauseButton).toBeFocused();
    await pauseButton.click();
    await expect(page.getByRole("button", { name: "Play replay" })).toBeVisible();

    // Keyboard: Home / End / arrows / Space (from a non-button target).
    await page.locator("#replay-heading").click();
    await page.keyboard.press("End");
    await expect(replayCount(page)).toHaveText(
      `Event ${String(TOTAL_EVENTS)} of ${String(TOTAL_EVENTS)}`,
    );
    await page.keyboard.press("Home");
    await expect(replayCount(page)).toHaveText(`Event 1 of ${String(TOTAL_EVENTS)}`);
    await page.keyboard.press("ArrowRight");
    await expect(replayCount(page)).toHaveText(`Event 2 of ${String(TOTAL_EVENTS)}`);
    await page.keyboard.press("ArrowLeft");
    await expect(replayCount(page)).toHaveText(`Event 1 of ${String(TOTAL_EVENTS)}`);
    await page.keyboard.press(" ");
    await expect(page.getByRole("button", { name: "Pause replay" })).toBeVisible({
      timeout: 5_000,
    });
    await page.keyboard.press(" ");
    await expect(page.getByRole("button", { name: "Play replay" })).toBeVisible({
      timeout: 5_000,
    });
    await page.getByRole("button", { name: "Last event" }).click();

    // Analysis unchanged by replay (checksum/version stable).
    const analysisResp = await page.request.get(`/api/v1/drafts/${draftId}/analysis`);
    expect(analysisResp.status()).toBe(200);
    const analysisBody = (await analysisResp.json()) as {
      data?: { analysisVersion?: string; inputChecksum?: string };
    };
    expect(analysisBody.data?.analysisVersion).toBe("1.0.0");
    expect(analysisBody.data?.inputChecksum).toMatch(/^[0-9a-f]{64}$/);

    // Create a private share link via the UI.
    await expect(page.locator("#share-heading")).toBeVisible();
    await page.getByRole("button", { name: "Create private link" }).click();
    const shareInput = page.locator("#dc-share-url");
    await expect(shareInput).toBeVisible({ timeout: 10_000 });
    const shareUrl = (await shareInput.inputValue()).trim();
    expect(shareUrl).toContain("/share/");
    const token = shareUrl.split("/share/")[1] ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(page.getByText(/Expires/)).toBeVisible();

    // Signed-out isolated context: redacted result, no private data.
    const anonCtx = await browser.newContext();
    const anonPage = await anonCtx.newPage();
    const consoleTexts: string[] = [];
    anonPage.on("console", (message) => consoleTexts.push(message.text()));
    const failedUrls: string[] = [];
    const externalShareRefs: string[] = [];
    anonPage.on("response", (response) => {
      if (response.status() >= 400) failedUrls.push(response.url());
    });
    anonPage.on("request", (request) => {
      const url = request.url();
      try {
        const parsed = new URL(url);
        if (parsed.origin !== new URL(shareUrl).origin && url.includes("/share/")) {
          externalShareRefs.push(url);
        }
      } catch {
        // Non-absolute URL (data:, blob:) — never a referrer leak.
      }
    });
    const shareResp = await anonPage.goto(shareUrl);
    expect(shareResp?.status()).toBe(200);
    expect(shareResp?.headers()["x-robots-tag"]).toContain("noindex");
    expect(shareResp?.headers()["referrer-policy"]).toContain("no-referrer");
    await expect(anonPage.getByRole("heading", { name: /Draft results/ })).toBeVisible({
      timeout: 15_000,
    });
    await expect(anonPage.getByText(/projection, not a guarantee/i).first()).toBeVisible();
    await expect(anonPage.locator("#shared-replay-heading")).toBeVisible();
    await expect(anonPage.getByText(/Replay integrity: OK/)).toBeVisible();
    const sharedContent = await anonPage.content();
    expect(sharedContent).not.toContain(ownerUserId ?? "owner-id-not-leaked");
    expect(sharedContent).not.toContain("clerkUserId");
    expect(sharedContent).not.toContain("ownerId");
    expect(sharedContent).not.toContain("preferenceSnapshot");
    // The raw token is the path the visitor opened, so Next.js router state
    // necessarily carries the segment (address bar + flight data). What must
    // never happen: rendered text, console output, error payloads, or any
    // third-party request carrying it.
    await expect(anonPage.locator("body")).not.toContainText(token);
    expect(externalShareRefs).toEqual([]);
    for (const text of consoleTexts) expect(text).not.toContain(token);
    for (const url of failedUrls) expect(url).not.toContain(token);
    // Shared replay steps.
    await anonPage.getByRole("button", { name: "First event" }).click();
    await expect(replayCount(anonPage)).toHaveText(`Event 1 of ${String(TOTAL_EVENTS)}`);
    await anonPage.getByRole("button", { name: "Last event" }).click();
    await expect(replayCount(anonPage)).toHaveText(
      `Event ${String(TOTAL_EVENTS)} of ${String(TOTAL_EVENTS)}`,
    );
    const shareAxe = await new AxeBuilder({ page: anonPage }).analyze();
    expect(
      shareAxe.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
      `share axe: ${JSON.stringify(shareAxe.violations.map((v) => v.id))}`,
    ).toEqual([]);
    await anonPage.setViewportSize({ width: 320, height: 800 });
    expect(
      await anonPage.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await anonCtx.close();

    // Revoke via the UI: public access fails immediately, owner still works.
    await page.getByRole("button", { name: "Revoke link" }).click();
    await expect(page.getByText(/revoked immediately/i)).toBeVisible({ timeout: 10_000 });
    const revokedCtx = await browser.newContext();
    const revokedPage = await revokedCtx.newPage();
    await revokedPage.goto(shareUrl);
    await expect(revokedPage.getByText(/Page not found/i)).toBeVisible({ timeout: 10_000 });
    await revokedCtx.close();
    await page.goto(`/drafts/${draftId}/results`);
    await expect(page.locator("#grade-heading")).toBeVisible({ timeout: 15_000 });

    // Invalid tokens fail with the same indistinguishable 404.
    const invalidCtx = await browser.newContext();
    const invalidPage = await invalidCtx.newPage();
    await invalidPage.goto(`/share/${"A".repeat(43)}`);
    await expect(invalidPage.getByText(/Page not found/i)).toBeVisible({ timeout: 10_000 });
    await invalidCtx.close();

    // Owner share API guards: incomplete draft 409, foreign draft 404.
    const activeLeague = await seedLeagueViaApi(page, `Replay Active ${String(Date.now())}`);
    const activeDraft = await page.request.post("/api/v1/drafts", {
      data: { leagueId: activeLeague, type: "REAL" },
    });
    expect(activeDraft.status()).toBe(200);
    const activeBody = (await activeDraft.json()) as { data?: { id?: string } };
    const incompleteShare = await page.request.post(
      `/api/v1/drafts/${activeBody.data?.id ?? "missing"}/share`,
    );
    expect(incompleteShare.status()).toBe(409);
    expect((await page.request.post(`/api/v1/drafts/${crypto.randomUUID()}/share`)).status()).toBe(
      404,
    );
    // Idempotent revoke on a draft with no active share.
    const revokeEmpty = await page.request.delete(`/api/v1/drafts/${draftId}/share`);
    expect(revokeEmpty.status()).toBe(200);

    // Axe + responsive on the owner results page.
    const resultsAxe = await new AxeBuilder({ page }).analyze();
    expect(
      resultsAxe.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
      `results axe: ${JSON.stringify(resultsAxe.violations.map((v) => v.id))}`,
    ).toEqual([]);
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("#replay-heading")).toBeVisible();
    await page.emulateMedia({ colorScheme: "light" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator("#replay-heading")).toBeVisible();
    await page.emulateMedia({ reducedMotion: null });
    await page.emulateMedia({ forcedColors: "active" });
    await expect(page.locator("#replay-heading")).toBeVisible();
    await page.emulateMedia({ forcedColors: "none" });
  });
});
