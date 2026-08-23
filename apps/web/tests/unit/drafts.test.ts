import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@draftcourt/db";
import {
  createDraft,
  CURRENT_ENGINE_VERSION,
  DraftIllegalPickError,
  DraftNotFoundError,
  DraftStatusError,
  DraftVersionConflict,
  getDraftForOwner,
  listEventsForOwner,
  makePick,
  transitionStatus,
  undoPick,
} from "@/lib/server/drafts";
import { createLeague, deleteLeague, type LeagueSummary } from "@/lib/server/leagues";

/**
 * Event-sourced core integration tests against the real local Postgres
 * (BUILD_SPEC.md section 16.1/16.2): event append/replay/idempotency/undo/
 * status transitions/version conflicts, and replay-vs-read-model integrity.
 */

describe("event-sourced draft core", () => {
  let ownerId: string;
  let otherUserId: string;
  let playerA: string;
  let playerB: string;
  const createdLeagueIds: string[] = [];

  async function cleanup() {
    const drafts = await prisma.draft.findMany({
      where: { leagueId: { in: createdLeagueIds } },
      select: { id: true },
    });
    for (const draft of drafts) {
      await prisma.draftOutbox.deleteMany({ where: { draftId: draft.id } });
      await prisma.draftRosterAssignment.deleteMany({ where: { draftId: draft.id } });
      await prisma.draftEvent.deleteMany({ where: { draftId: draft.id } });
      await prisma.draftTeam.deleteMany({ where: { draftId: draft.id } });
      await prisma.draft.delete({ where: { id: draft.id } });
    }
    for (const leagueId of createdLeagueIds) {
      await prisma.scoringRule.deleteMany({ where: { settingsVersion: { leagueId } } });
      await prisma.rosterSlotRule.deleteMany({ where: { settingsVersion: { leagueId } } });
      await prisma.leagueSettingsVersion.deleteMany({ where: { leagueId } });
      await prisma.leagueTeam.deleteMany({ where: { leagueId } });
      await prisma.league.deleteMany({ where: { id: leagueId } }).catch(() => undefined);
    }
  }

  beforeAll(async () => {
    const suffix = crypto.randomUUID();
    const owner = await prisma.user.create({
      data: { clerkUserId: `test-draft-owner-${suffix}` },
      select: { id: true },
    });
    const other = await prisma.user.create({
      data: { clerkUserId: `test-draft-other-${suffix}` },
      select: { id: true },
    });
    ownerId = owner.id;
    otherUserId = other.id;

    // Reuse two committed demo players for picks.
    const players = await prisma.player.findMany({
      take: 2,
      orderBy: { slug: "asc" },
      select: { id: true },
    });
    if (players.length < 2) throw new Error("demo players must be ingested first");
    playerA = players[0]?.id ?? "";
    playerB = players[1]?.id ?? "";
  });

  afterAll(async () => {
    await cleanup();
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherUserId] } } });
  });

  async function makeLeague(horizon: "REDRAFT" | "KEEPER" | "DYNASTY" = "REDRAFT") {
    const league: LeagueSummary = await createLeague(ownerId, {
      name: "Draft Core League",
      season: "2026-27",
      teamCount: 4,
      userDraftSlot: 1,
      rounds: 6,
      config: {
        type: "POINTS",
        horizon,
        playoffWeeks: null,
        scoringRules: [
          { stat: "PTS", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
          { stat: "REB", weight: 1.2, direction: "HIGHER_BETTER", enabled: true, punt: false },
          { stat: "TOV", weight: -1, direction: "LOWER_BETTER", enabled: true, punt: false },
        ],
        rosterSlots: [
          { position: "PG", count: 1, starter: true },
          { position: "SG", count: 1, starter: true },
          { position: "UTIL", count: 1, starter: true },
          { position: "BENCH", count: 3, starter: false },
        ],
      },
    });
    createdLeagueIds.push(league.id);
    return league;
  }

  it("create -> start -> pick appends events atomically and advances the cursor", async () => {
    const league = await makeLeague();
    const draft = await createDraft(ownerId, { leagueId: league.id });
    expect(draft.id).toBeTruthy();

    await expect(
      makePick({
        draftId: draft.id,
        ownerId,
        playerId: playerA,
        idempotencyKey: "it-pick-before-start",
        ifMatchVersion: 0,
      }),
    ).rejects.toBeInstanceOf(DraftStatusError);

    const started = await transitionStatus({
      draftId: draft.id,
      ownerId,
      action: "start",
    });
    expect(started.status).toBe("ACTIVE");
    expect(started.version).toBe(1);

    const result = await makePick({
      draftId: draft.id,
      ownerId,
      playerId: playerA,
      idempotencyKey: "it-pick-1",
      ifMatchVersion: started.version,
    });
    expect(result.duplicated).toBe(false);
    expect(result.authoritative.nextOverallPick).toBe(2);
    expect(result.authoritative.version).toBe(2);

    const detail = await getDraftForOwner(draft.id, ownerId);
    expect(detail?.teams[0]?.assignments.some((a) => a.playerId === playerA)).toBe(true);
    expect(detail?.currentSequence).toBe(2); // DRAFT_STARTED + pick

    // Outbox request was written in the same transaction.
    const outbox = await prisma.draftOutbox.findMany({ where: { draftId: draft.id } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.kind).toBe("RECOMMENDATION");

    // Replay integrity holds right after the transaction.
    const integrity = await import("@/lib/server/drafts").then((m) =>
      m.verifyReplayIntegrity(draft.id),
    );
    expect(integrity.ok).toBe(true);
  });

  it("duplicate delivery of the same Idempotency-Key does not double-apply", async () => {
    const league = await makeLeague();
    const draft = await createDraft(ownerId, { leagueId: league.id });
    await transitionStatus({ draftId: draft.id, ownerId, action: "start" });

    const first = await makePick({
      draftId: draft.id,
      ownerId,
      playerId: playerA,
      idempotencyKey: "dup-key-abc",
      ifMatchVersion: 1,
    });
    const second = await makePick({
      draftId: draft.id,
      ownerId,
      playerId: playerB, // different body, same key — still a redelivery
      idempotencyKey: "dup-key-abc",
      ifMatchVersion: first.authoritative.version,
    });
    expect(second.duplicated).toBe(true);
    expect(second.authoritative.playerId).toBe(playerA);
    expect(second.authoritative.nextOverallPick).toBe(2);

    const events = await prisma.draftEvent.count({ where: { draftId: draft.id } });
    expect(events).toBe(2); // DRAFT_STARTED + one PLAYER_DRAFTED
  });

  it("stale If-Match gets 409 semantics with authoritative state", async () => {
    const league = await makeLeague();
    const draft = await createDraft(ownerId, { leagueId: league.id });
    await transitionStatus({ draftId: draft.id, ownerId, action: "start" });

    await makePick({
      draftId: draft.id,
      ownerId,
      playerId: playerA,
      idempotencyKey: "conflict-key-1",
      ifMatchVersion: 1,
    });

    await expect(
      makePick({
        draftId: draft.id,
        ownerId,
        playerId: playerB,
        idempotencyKey: "conflict-key-2",
        ifMatchVersion: 1, // stale: version is now 2
      }),
    ).rejects.toBeInstanceOf(DraftVersionConflict);
  });

  it("rejects double-drafting the same player", async () => {
    const league = await makeLeague();
    const draft = await createDraft(ownerId, { leagueId: league.id });
    await transitionStatus({ draftId: draft.id, ownerId, action: "start" });

    await makePick({
      draftId: draft.id,
      ownerId,
      playerId: playerA,
      idempotencyKey: "illegal-first-key",
      ifMatchVersion: 1,
    });
    await expect(
      makePick({
        draftId: draft.id,
        ownerId,
        playerId: playerA,
        idempotencyKey: "illegal-second-key",
        ifMatchVersion: 2,
      }),
    ).rejects.toBeInstanceOf(DraftIllegalPickError);
  });

  it("undo compensates the latest effective pick and reverses the cursor", async () => {
    const league = await makeLeague();
    const draft = await createDraft(ownerId, { leagueId: league.id });
    await transitionStatus({ draftId: draft.id, ownerId, action: "start" });

    await makePick({
      draftId: draft.id,
      ownerId,
      playerId: playerA,
      idempotencyKey: "undo-pick-a",
      ifMatchVersion: 1,
    });
    const undone = await undoPick({
      draftId: draft.id,
      ownerId,
      idempotencyKey: "undo-key-1",
      ifMatchVersion: 2,
    });
    expect(undone.duplicated).toBe(false);
    expect(undone.authoritative.nextOverallPick).toBe(1);

    const detail = await getDraftForOwner(draft.id, ownerId);
    expect(detail?.teams.flatMap((t) => t.assignments)).toHaveLength(0);

    // The event log is append-only: PICK_UNDONE references the original.
    const events = await listEventsForOwner(draft.id, ownerId);
    const undoneEvent = events?.events.find((e) => e.eventType === "PICK_UNDONE");
    expect(undoneEvent?.causationEventId).toBeTruthy();

    const originalStillThere = await prisma.draftEvent.findFirst({
      where: { draftId: draft.id, eventType: "PLAYER_DRAFTED", playerId: playerA },
    });
    expect(originalStillThere).not.toBeNull();

    // A second undo finds no effective pick to compensate.
    await expect(
      undoPick({
        draftId: draft.id,
        ownerId,
        idempotencyKey: "undo-key-2-empty",
        ifMatchVersion: undone.authoritative.version,
      }),
    ).rejects.toBeInstanceOf(DraftStatusError);
  });

  it("pause/resume/complete validate status transitions", async () => {
    const league = await makeLeague();
    const draft = await createDraft(ownerId, { leagueId: league.id });

    await expect(
      transitionStatus({ draftId: draft.id, ownerId, action: "pause" }),
    ).rejects.toBeInstanceOf(DraftStatusError);

    await transitionStatus({ draftId: draft.id, ownerId, action: "start" });
    await transitionStatus({ draftId: draft.id, ownerId, action: "pause" });
    await transitionStatus({ draftId: draft.id, ownerId, action: "resume" });

    // Cannot complete an unfilled board.
    await expect(
      transitionStatus({ draftId: draft.id, ownerId, action: "complete" }),
    ).rejects.toBeInstanceOf(DraftStatusError);

    const abandoned = await transitionStatus({
      draftId: draft.id,
      ownerId,
      action: "abandon",
    });
    expect(abandoned.status).toBe("ABANDONED");
  });

  it("keeper keepers enter as explicit pre-draft events in KEEPER leagues only", async () => {
    const keeperLeague = await makeLeague("KEEPER");
    const draft = await createDraft(ownerId, {
      leagueId: keeperLeague.id,
      keepers: [{ playerId: playerA, teamSlot: 2 }],
    });

    // Keeper exists BEFORE start as a real event + assignment.
    const preStart = await getDraftForOwner(draft.id, ownerId);
    expect(preStart?.status).toBe("SETUP");
    expect(preStart?.nextOverallPick).toBe(2); // cursor advanced by the keeper
    const team2 = preStart?.teams.find((t) => t.slot === 2);
    expect(team2?.assignments.some((a) => a.playerId === playerA && a.isKeeper)).toBe(true);

    const redraftLeague = await makeLeague("REDRAFT");
    await expect(
      createDraft(ownerId, {
        leagueId: redraftLeague.id,
        keepers: [{ playerId: playerB, teamSlot: 1 }],
      }),
    ).rejects.toBeInstanceOf(DraftIllegalPickError);
  });

  it("hides drafts from non-owners", async () => {
    const league = await makeLeague();
    const draft = await createDraft(ownerId, { leagueId: league.id });
    await expect(getDraftForOwner(draft.id, otherUserId)).resolves.toBeNull();

    await expect(
      makePick({
        draftId: draft.id,
        ownerId: otherUserId,
        playerId: playerA,
        idempotencyKey: "other-user-key",
        ifMatchVersion: 0,
      }),
    ).rejects.toBeInstanceOf(DraftNotFoundError);

    void deleteLeague; // covered in leagues.test.ts
    void CURRENT_ENGINE_VERSION;
  });

  it("concurrent duplicate picks are serialized by row lock + unique keys", async () => {
    const league = await makeLeague();
    const draft = await createDraft(ownerId, { leagueId: league.id });
    await transitionStatus({ draftId: draft.id, ownerId, action: "start" });

    // Two racing requests with DIFFERENT idempotency keys but the same player:
    // exactly one may win; the loser hits either version conflict or the
    // already-drafted guard. No state corruption is possible.
    const results = await Promise.allSettled([
      makePick({
        draftId: draft.id,
        ownerId,
        playerId: playerA,
        idempotencyKey: "race-key-aaaaaaaaaa",
        ifMatchVersion: 1,
      }),
      makePick({
        draftId: draft.id,
        ownerId,
        playerId: playerA,
        idempotencyKey: "race-key-bbbbbbbbbb",
        ifMatchVersion: 1,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length + rejected.length).toBe(2);
    expect(rejected.length).toBeLessThanOrEqual(1);

    const assignments = await prisma.draftRosterAssignment.count({
      where: { draftId: draft.id },
    });
    expect(assignments).toBeLessThanOrEqual(1);

    const integrity = await import("@/lib/server/drafts").then((m) =>
      m.verifyReplayIntegrity(draft.id),
    );
    expect(integrity.ok).toBe(true);
  });
});
