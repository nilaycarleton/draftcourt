/* eslint-disable */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@draftcourt/db";
import {
  listEventsForOwner,
  listTimelineEventsForOwner,
  TimelineValidationError,
  verifyReplayIntegrity,
} from "@/lib/server/drafts";

/**
 * Phase 3E2 timeline API suite against real local Postgres (ADR 0016 R3).
 * Proves:
 * - legacy array shape preserved (backwards compatibility)
 * - cursor/limit validation, bounded pages, stable ascending order
 * - no duplicates or gaps across cursors, cursor idempotency
 * - explicit actor types, safe descriptions, undo linkage evidence
 * - replay-integrity status exposure, no private/internal fields
 * - owner-only access with enumeration-resistant 404 (null)
 */

const userIds: string[] = [];
const leagueIds: string[] = [];
const draftIds: string[] = [];

async function newUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { clerkUserId: `test-timeline-${crypto.randomUUID()}` },
    select: { id: true },
  });
  userIds.push(user.id);
  return user.id;
}

async function newDraftWithEvents(
  ownerId: string,
): Promise<{ draftId: string; playerIds: string[] }> {
  const league = await prisma.league.create({
    data: {
      ownerId,
      name: `Timeline League ${crypto.randomUUID().slice(0, 8)}`,
      season: "2026-27",
      type: "POINTS",
      teamCount: 4,
      userDraftSlot: 1,
      rounds: 4,
      teams: {
        create: Array.from({ length: 4 }, (_, i) => ({
          slot: i + 1,
          displayName: `T${String(i + 1)}`,
          isUserTeam: i === 0,
        })),
      },
    },
    select: { id: true },
  });
  leagueIds.push(league.id);
  const version = await prisma.leagueSettingsVersion.create({
    data: { leagueId: league.id, versionNumber: 1 },
    select: { id: true },
  });
  await prisma.scoringRule.createMany({
    data: [
      {
        settingsVersionId: version.id,
        statKey: "PTS",
        weight: 1,
        direction: "HIGHER_BETTER",
        enabled: true,
        punt: false,
      },
    ],
  });
  await prisma.rosterSlotRule.createMany({
    data: [{ settingsVersionId: version.id, position: "UTIL", count: 4, isStarter: true }],
  });
  await prisma.league.update({
    where: { id: league.id },
    data: { activeSettingsVersionId: version.id },
  });

  const draft = await prisma.draft.create({
    data: {
      ownerId,
      leagueId: league.id,
      type: "REAL",
      status: "ACTIVE",
      engineVersion: "phase3-preferences-1.0.0",
      settingsSnapshot: {
        season: "2026-27",
        type: "POINTS",
        horizon: "REDRAFT",
        teamCount: 4,
        rounds: 4,
        userDraftSlot: 1,
        playoffWeeks: null,
        scoringRules: [
          { stat: "PTS", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
        ],
        rosterSlots: [{ position: "UTIL", count: 4, isStarter: true }],
        teams: Array.from({ length: 4 }, (_, i) => ({
          slot: i + 1,
          displayName: `T${String(i + 1)}`,
          isUserTeam: i === 0,
        })),
      },
      currentSequence: 0,
      nextOverallPick: 1,
      version: 1,
    },
    select: { id: true },
  });
  draftIds.push(draft.id);
  await prisma.draftTeam.createMany({
    data: Array.from({ length: 4 }, (_, i) => ({
      draftId: draft.id,
      slot: i + 1,
      displayName: `T${String(i + 1)}`,
      isUserTeam: i === 0,
    })),
  });

  // 1 STARTED + 6 picks (one CPU) + 1 PAUSED + 1 RESUMED + 1 UNDO + 1 pick = 11 events.
  const pickIds = Array.from({ length: 7 }, () => crypto.randomUUID());
  const playerIds = Array.from({ length: 7 }, () => crypto.randomUUID());
  const rows: {
    sequence: number;
    eventType: any;
    teamSlot?: number | null;
    playerId?: string | null;
    round?: number | null;
    pickInRound?: number | null;
    causationEventId?: string | null;
    payload?: any;
  }[] = [
    { sequence: 1, eventType: "DRAFT_STARTED" },
    {
      sequence: 2,
      eventType: "PLAYER_DRAFTED",
      teamSlot: 1,
      playerId: playerIds[0] ?? null,
      round: 1,
      pickInRound: 1,
      payload: { slotPosition: "UTIL", isBench: false },
    },
    {
      sequence: 3,
      eventType: "PLAYER_DRAFTED",
      teamSlot: 2,
      playerId: playerIds[1] ?? null,
      round: 1,
      pickInRound: 2,
      payload: {
        slotPosition: "UTIL",
        isBench: false,
        cpuEvidence: {
          cpu: true,
          actorType: "CPU",
          personalityKey: "balanced",
          personalityVersion: 1,
          seedStrategyVersion: 1,
          decisionSeed: "ab",
          decisionInputChecksum: "cd",
          decisionChecksum: "ef",
          selectionScore: 0.5,
        },
      },
    },
    {
      sequence: 4,
      eventType: "PLAYER_DRAFTED",
      teamSlot: 3,
      playerId: playerIds[2] ?? null,
      round: 1,
      pickInRound: 3,
      payload: { slotPosition: "UTIL", isBench: false },
    },
    { sequence: 5, eventType: "DRAFT_PAUSED" },
    { sequence: 6, eventType: "DRAFT_RESUMED" },
    {
      sequence: 7,
      eventType: "PLAYER_DRAFTED",
      teamSlot: 4,
      playerId: playerIds[3] ?? null,
      round: 1,
      pickInRound: 4,
      payload: { slotPosition: "UTIL", isBench: false },
    },
    {
      sequence: 8,
      eventType: "PICK_UNDONE",
      teamSlot: 4,
      playerId: playerIds[3] ?? null,
      causationEventId: pickIds[3] ?? null,
    },
    {
      sequence: 9,
      eventType: "PLAYER_DRAFTED",
      teamSlot: 4,
      playerId: playerIds[4] ?? null,
      round: 1,
      pickInRound: 4,
      payload: { slotPosition: "UTIL", isBench: false },
    },
  ];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    await prisma.draftEvent.create({
      data: {
        id:
          row.eventType === "PLAYER_DRAFTED"
            ? (pickIds[
                rows.slice(0, i + 1).filter((r) => r.eventType === "PLAYER_DRAFTED").length - 1
              ] ?? crypto.randomUUID())
            : crypto.randomUUID(),
        draftId: draft.id,
        sequence: row.sequence,
        eventType: row.eventType,
        teamSlot: row.teamSlot ?? null,
        playerId: row.playerId ?? null,
        round: row.round ?? null,
        pickInRound: row.pickInRound ?? null,
        causationEventId:
          row.causationEventId === undefined
            ? null
            : row.eventType === "PICK_UNDONE"
              ? pickIds[3]!
              : row.causationEventId,
        payload: row.payload ?? undefined,
      },
    });
  }
  // Materialized view matches replay: picks 0,1,2,4 effective (pick 3 undone).
  const effective: { pick: number; player: number; slot: number }[] = [
    { pick: 0, player: 0, slot: 1 },
    { pick: 1, player: 1, slot: 2 },
    { pick: 2, player: 2, slot: 3 },
    { pick: 4, player: 4, slot: 4 },
  ];
  for (const row of effective) {
    await prisma.draftRosterAssignment.create({
      data: {
        draftId: draft.id,
        eventId: pickIds[row.pick]!,
        teamSlot: row.slot,
        playerId: playerIds[row.player]!,
        slotPosition: "UTIL",
        isBench: false,
        assignedAt: new Date(),
      },
    });
  }
  await prisma.draft.update({
    where: { id: draft.id },
    data: { currentSequence: 9, nextOverallPick: 5 },
  });
  return { draftId: draft.id, playerIds };
}

describe("owner event timeline", () => {
  let owner: string;
  let other: string;
  let draftId: string;
  let knownPlayerIds: string[];

  beforeAll(async () => {
    owner = await newUser();
    other = await newUser();
    const created = await newDraftWithEvents(owner);
    draftId = created.draftId;
    knownPlayerIds = created.playerIds;
  }, 30_000);

  afterAll(async () => {
    await prisma.draftRosterAssignment.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.draftEvent.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.draftTeam.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.draft.deleteMany({ where: { id: { in: draftIds } } });
    await prisma.scoringRule.deleteMany({
      where: { settingsVersion: { leagueId: { in: leagueIds } } },
    });
    await prisma.rosterSlotRule.deleteMany({
      where: { settingsVersion: { leagueId: { in: leagueIds } } },
    });
    await prisma.leagueSettingsVersion.deleteMany({ where: { leagueId: { in: leagueIds } } });
    await prisma.leagueTeam.deleteMany({ where: { leagueId: { in: leagueIds } } });
    await prisma.league.deleteMany({ where: { id: { in: leagueIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("legacy array shape is preserved for existing callers", async () => {
    const legacy = await listEventsForOwner(draftId, owner);
    expect(Array.isArray(legacy?.events)).toBe(true);
    expect(legacy?.events).toHaveLength(9);
    expect(legacy?.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("owner-only: foreigners and missing drafts resolve to null", async () => {
    expect(await listTimelineEventsForOwner(draftId, other)).toBeNull();
    expect(await listTimelineEventsForOwner(crypto.randomUUID(), owner)).toBeNull();
    expect(await listEventsForOwner(draftId, other)).toBeNull();
  });

  it("cursor and limit are strictly validated", async () => {
    await expect(listTimelineEventsForOwner(draftId, owner, { cursor: -1 })).rejects.toBeInstanceOf(
      TimelineValidationError,
    );
    await expect(
      listTimelineEventsForOwner(draftId, owner, { cursor: 1.5 }),
    ).rejects.toBeInstanceOf(TimelineValidationError);
    await expect(listTimelineEventsForOwner(draftId, owner, { limit: 0 })).rejects.toBeInstanceOf(
      TimelineValidationError,
    );
    await expect(listTimelineEventsForOwner(draftId, owner, { limit: 101 })).rejects.toBeInstanceOf(
      TimelineValidationError,
    );
  });

  it("paginates with no gaps or duplicates and stable order", async () => {
    const seen: number[] = [];
    let cursor: number | undefined = undefined;
    for (let page = 0; page < 4; page++) {
      const result = await listTimelineEventsForOwner(draftId, owner, {
        ...(cursor !== undefined ? { cursor } : {}),
        limit: 3,
      });
      expect(result).not.toBeNull();
      const sequences = result!.events.map((e) => e.sequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      for (const seq of sequences) expect(seen).not.toContain(seq);
      seen.push(...sequences);
      if (result!.nextCursor === null) break;
      cursor = result!.nextCursor;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Cursor idempotency: same cursor returns the same page.
    const a = await listTimelineEventsForOwner(draftId, owner, { cursor: 3, limit: 3 });
    const b = await listTimelineEventsForOwner(draftId, owner, { cursor: 3, limit: 3 });
    expect(a?.events.map((e) => e.sequence)).toEqual(b?.events.map((e) => e.sequence));
  });

  it("exposes actor types, descriptions, undo linkage, and integrity", async () => {
    const page = await listTimelineEventsForOwner(draftId, owner, { limit: 50 });
    expect(page?.integrity.ok).toBe(true);
    const bySeq = new Map(page!.events.map((e) => [e.sequence, e]));
    expect(bySeq.get(1)?.actorType).toBe("SYSTEM");
    expect(bySeq.get(2)?.actorType).toBe("USER");
    expect(bySeq.get(3)?.actorType).toBe("CPU");
    expect(bySeq.get(3)?.cpuPersonalityKey).toBe("balanced");
    expect(bySeq.get(2)?.description).toContain("Pick 1");
    expect(bySeq.get(5)?.description).toContain("paused");
    expect(bySeq.get(8)?.eventType).toBe("PICK_UNDONE");
    expect(bySeq.get(8)?.causationLinked).toBe(true);
    expect(bySeq.get(2)?.causationLinked).toBe(false);
    expect(bySeq.get(2)?.overallPick).toBe(1);
    expect(bySeq.get(9)?.overallPick).toBe(4);
  });

  it("exposes no private credentials or internal-only metadata", async () => {
    const page = await listTimelineEventsForOwner(draftId, owner, { limit: 50 });
    const json = JSON.stringify(page);
    expect(json).not.toContain("actorUserId");
    expect(json).not.toContain("causationEventId");
    expect(json).not.toContain("idempotencyKey");
    expect(json).not.toContain("cpuEvidence");
    expect(json).not.toContain("decisionSeed");
    // Every UUID in the payload must be a domain player id the owner already
    // sees in roster/pool responses — never an internal event/causation id.
    const uuids = json.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
    expect(uuids.length).toBeGreaterThan(0);
    for (const uuid of uuids) expect(knownPlayerIds).toContain(uuid);
  });

  it("verifyReplayIntegrity agrees with the materialized view", async () => {
    const integrity = await verifyReplayIntegrity(draftId);
    expect(integrity.ok).toBe(true);
    expect(integrity.detail).toContain("4 effective selections");
  });
});
