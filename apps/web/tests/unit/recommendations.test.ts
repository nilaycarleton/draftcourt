import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@draftcourt/db";
import { createDraft, getDraftForOwner, makePick, transitionStatus } from "@/lib/server/drafts";
import { createLeague } from "@/lib/server/leagues";
import type { LeagueSummary } from "@/lib/server/leagues";
import { DraftNotReadyError, getRecommendationsForOwner } from "@/lib/server/recommendations";

/**
 * Full server-side engine path against the REAL ingested demo dataset:
 * published projection run + players + eligibility + materialized roster.
 * Proves the Phase 1 data pipeline feeds the Phase 2 engine end to end.
 */
describe("recommendations over real demo data", () => {
  let ownerId: string;
  let leagueId: string;
  let draftId: string;
  const createdLeagueIdsForCleanup: string[] = [];
  const createdDraftIdsForCleanup: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { clerkUserId: `test-rec-${crypto.randomUUID()}` },
      select: { id: true },
    });
    ownerId = user.id;

    const league = await createLeague(ownerId, {
      name: "Rec Test League",
      season: "2026-27",
      teamCount: 12,
      userDraftSlot: 1,
      rounds: 13,
      config: {
        type: "CATEGORIES",
        horizon: "REDRAFT",
        playoffWeeks: null,
        scoringRules: [
          { stat: "PTS", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
          { stat: "REB", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
          { stat: "AST", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
          { stat: "STL", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
          { stat: "BLK", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
          { stat: "TOV", weight: 1, direction: "LOWER_BETTER", enabled: true, punt: false },
          { stat: "FG_PCT", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
          { stat: "FT_PCT", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
        ],
        rosterSlots: [
          { position: "PG", count: 1, starter: true },
          { position: "SG", count: 1, starter: true },
          { position: "UTIL", count: 2, starter: true },
          { position: "BENCH", count: 2, starter: false },
        ],
      },
    });
    leagueId = league.id;
    const draft = await createDraft(ownerId, { leagueId });
    draftId = draft.id;
  });

  afterAll(async () => {
    const allDraftIds = [...new Set([draftId, ...createdDraftIdsForCleanup])];
    const allLeagueIds = [...new Set([leagueId, ...createdLeagueIdsForCleanup])];
    for (const d of allDraftIds) {
      await prisma.draftOutbox.deleteMany({ where: { draftId: d } }).catch(() => undefined);
      await prisma.recommendationSnapshot
        .deleteMany({ where: { draftId: d } })
        .catch(() => undefined);
      await prisma.draftRosterAssignment
        .deleteMany({ where: { draftId: d } })
        .catch(() => undefined);
      await prisma.draftEvent.deleteMany({ where: { draftId: d } }).catch(() => undefined);
      await prisma.draftTeam.deleteMany({ where: { draftId: d } }).catch(() => undefined);
      await prisma.draft.deleteMany({ where: { id: d } }).catch(() => undefined);
    }
    void allLeagueIds; // leagues below are removed by their own ids
    await prisma.draftOutbox.deleteMany({ where: { draftId } });
    await prisma.recommendationSnapshot.deleteMany({ where: { draftId } });
    await prisma.draftRosterAssignment.deleteMany({ where: { draftId } });
    await prisma.draftEvent.deleteMany({ where: { draftId } });
    await prisma.draftTeam.deleteMany({ where: { draftId } });
    await prisma.draft.deleteMany({ where: { id: draftId } }).catch(() => undefined);
    await prisma.scoringRule.deleteMany({ where: { settingsVersion: { leagueId } } });
    await prisma.rosterSlotRule.deleteMany({ where: { settingsVersion: { leagueId } } });
    await prisma.leagueSettingsVersion.deleteMany({ where: { leagueId } });
    await prisma.leagueTeam.deleteMany({ where: { leagueId } });
    await prisma.league.deleteMany({ where: { id: leagueId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => undefined);
  });

  it("computes recommendations from the published run and caches by sequence", async () => {
    const first = await getRecommendationsForOwner(draftId, ownerId);
    if (!first) throw new Error("recommendations should compute");
    const output = first.output;
    expect(output.pool.length).toBeGreaterThan(50); // 230-player demo dataset
    expect(output.top3).toHaveLength(3);
    expect(output.inputChecksum).toMatch(/^[0-9a-f]{64}$/);

    // Second read at the same sequence is served from the stored snapshot
    // (JSONB storage normalizes key order, so compare structurally).
    const second = await getRecommendationsForOwner(draftId, ownerId);
    expect(second?.cached).toBe(true);
    expect(second?.output).toEqual(output);

    // Determinism: recomputing from scratch yields an identical structure
    // (byte-equality is proven at the engine level; JSONB storage normalizes
    // object key order, so the round-trip compares structurally).
    const forced = await getRecommendationsForOwner(draftId, ownerId, { force: true });
    expect(forced?.output).toEqual(output);
  });

  it("updates recommendations after a pick and marks outbox processed", async () => {
    const before = await getRecommendationsForOwner(draftId, ownerId);
    const topPick = before?.output.top3[0];
    if (!topPick) throw new Error("no top pick");

    await transitionStatus({ draftId, ownerId, action: "start" });
    const detail = await getDraftForOwner(draftId, ownerId);
    if (!detail) throw new Error("draft missing");

    const afterPick = await makePick({
      draftId,
      ownerId,
      playerId: topPick.playerId,
      idempotencyKey: "rec-pick-key-1",
      ifMatchVersion: detail.version,
    });
    void afterPick;

    const after = await getRecommendationsForOwner(draftId, ownerId);
    if (!after) throw new Error("post-pick recommendations should compute");
    expect(after.cached).toBe(false);
    expect(after.output.inputChecksum).not.toBe(before.output.inputChecksum);
    expect(after.output.pool.some((entry) => entry.playerId === topPick.playerId)).toBe(false);
    expect(afterPick.authoritative.nextOverallPick).toBe(2);

    const pendingOutbox = await prisma.draftOutbox.count({
      where: { draftId, processedAt: null },
    });
    expect(pendingOutbox).toBe(0);
  });

  it("refuses drafts in leagues without a published run rather than guessing", async () => {
    // A season with no published run must surface a clean not-ready problem.
    const ghostLeague: LeagueSummary = await createLeague(ownerId, {
      name: "No Run League",
      season: "1999-00",
      teamCount: 8,
      userDraftSlot: 1,
      rounds: 10,
      config: {
        type: "POINTS",
        horizon: "REDRAFT",
        playoffWeeks: null,
        scoringRules: [
          { stat: "PTS", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
        ],
        rosterSlots: [
          { position: "PG", count: 1, starter: true },
          { position: "SG", count: 1, starter: true },
          { position: "UTIL", count: 2, starter: true },
          { position: "BENCH", count: 2, starter: false },
        ],
      },
    });
    const draft = await createDraft(ownerId, { leagueId: ghostLeague.id });
    createdLeagueIdsForCleanup.push(ghostLeague.id);
    createdDraftIdsForCleanup.push(draft.id);
    await expect(getRecommendationsForOwner(draft.id, ownerId)).rejects.toBeInstanceOf(
      DraftNotReadyError,
    );
  });
});
