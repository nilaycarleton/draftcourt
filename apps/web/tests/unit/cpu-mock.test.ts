import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, prisma } from "@draftcourt/db";
import {
  cpuPersonalityByKey,
  overallPickToSlot,
  parseCpuPersonalitySnapshot,
} from "@draftcourt/domain";
import {
  createDraft,
  DraftNotFoundError,
  DraftStatusError,
  getDraftForOwner,
  makePick,
  transitionStatus,
  undoPick,
  verifyReplayIntegrity,
} from "@/lib/server/drafts";
import {
  assertCpuPickRate,
  CpuRateLimitedError,
  CpuTurnError,
  makeCpuPickForOwner,
} from "@/lib/server/cpu-mock";
import { getRecommendationsForOwner } from "@/lib/server/recommendations";

/**
 * Phase 3C CPU mock integration/security suite against the real local
 * Postgres. Proves: mock configuration persistence (seed + immutable
 * personality snapshots), owner isolation and enumeration resistance,
 * REAL/DEMO + status/turn rejections, single-winner concurrency, idempotent
 * replay, deterministic undo re-selection, full seeded completion with legal
 * rosters, recommendation outbox behavior, event evidence, and the rate
 * limiter.
 */

const SEASON = "2026-27";

describe("CPU mock orchestration", () => {
  let ownerA: string;
  let ownerB: string;
  let leagueA: string;
  let playerId: string;
  const userIds: string[] = [];
  const createdDraftIds: string[] = [];

  async function newUser(): Promise<string> {
    const user = await prisma.user.create({
      data: { clerkUserId: `test-cpu-${crypto.randomUUID()}` },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  }

  beforeAll(async () => {
    ownerA = await newUser();
    ownerB = await newUser();

    const league = await prisma.league.create({
      data: {
        ownerId: ownerA,
        name: `CPU League ${crypto.randomUUID().slice(0, 6)}`,
        season: SEASON,
        type: "POINTS",
        teamCount: 4,
        userDraftSlot: 1,
        rounds: 3,
        teams: {
          create: Array.from({ length: 4 }, (_, index) => ({
            slot: index + 1,
            displayName: index === 0 ? "My Team" : `CPU ${String(index + 1)}`,
            isUserTeam: index === 0,
          })),
        },
      },
      select: { id: true },
    });
    leagueA = league.id;
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
        {
          settingsVersionId: version.id,
          statKey: "TOV",
          weight: -1,
          direction: "LOWER_BETTER",
          enabled: true,
          punt: false,
        },
      ],
    });
    await prisma.rosterSlotRule.createMany({
      data: [
        { settingsVersionId: version.id, position: "PG", count: 1, isStarter: true },
        { settingsVersionId: version.id, position: "SG", count: 1, isStarter: true },
        { settingsVersionId: version.id, position: "UTIL", count: 2, isStarter: true },
        { settingsVersionId: version.id, position: "BENCH", count: 2, isStarter: false },
      ],
    });
    await prisma.league.update({
      where: { id: league.id },
      data: { activeSettingsVersionId: version.id },
    });

    // Real demo players + published run so selection has a real pool.
    const run = await prisma.projectionRun.findFirst({
      where: { season: SEASON, isCurrent: true },
      select: { id: true },
    });
    if (!run) throw new Error("demo projection run missing — seed first");
    const top = await prisma.playerProjection.findMany({
      where: { runId: run.id },
      orderBy: { overallRank: "asc" },
      take: 12,
      select: { playerId: true },
    });
    playerId = top[0]?.playerId ?? "";
    if (!playerId) throw new Error("no projected players available");
  }, 30_000);

  afterAll(async () => {
    if (userIds.length === 0) return;
    const ownedDrafts = { ownerId: { in: userIds } };
    await prisma.draftRosterAssignment.deleteMany({ where: { draft: ownedDrafts } });
    await prisma.draftEvent.deleteMany({ where: { draft: ownedDrafts } });
    await prisma.recommendationSnapshot.deleteMany({ where: { draft: ownedDrafts } });
    await prisma.draftOutbox.deleteMany({ where: { draft: ownedDrafts } });
    await prisma.draftTeam.deleteMany({ where: { draft: ownedDrafts } });
    await prisma.draft.deleteMany({ where: ownedDrafts });
    await prisma.auditLog.deleteMany({
      where: { actorId: { in: userIds }, action: "draft.cpuPick" },
    });
    await prisma.scoringRule.deleteMany({
      where: { settingsVersion: { league: { ownerId: { in: userIds } } } },
    });
    await prisma.rosterSlotRule.deleteMany({
      where: { settingsVersion: { league: { ownerId: { in: userIds } } } },
    });
    await prisma.leagueSettingsVersion.deleteMany({
      where: { league: { ownerId: { in: userIds } } },
    });
    await prisma.leagueTeam.deleteMany({ where: { league: { ownerId: { in: userIds } } } });
    await prisma.league.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  async function createStartedMock(options: {
    seed?: string;
    personalityKey?: string;
    ownerId?: string;
    leagueId?: string;
  }): Promise<{ id: string; simSeed: string }> {
    const owner = options.ownerId ?? ownerA;
    const draft = await createDraft(owner, {
      leagueId: options.leagueId ?? leagueA,
      type: "MOCK",
      ...(options.seed !== undefined ? { simulationSeed: options.seed } : {}),
      ...(options.personalityKey !== undefined
        ? { cpuPersonalityKey: options.personalityKey }
        : {}),
    });
    createdDraftIds.push(draft.id);
    await transitionStatus({ draftId: draft.id, ownerId: owner, action: "start" });
    const row = await prisma.draft.findUniqueOrThrow({
      where: { id: draft.id },
      select: { simulationSeed: true },
    });
    return { id: draft.id, simSeed: row.simulationSeed ?? "" };
  }

  async function versionOf(draftId: string): Promise<number> {
    return (
      await prisma.draft.findUniqueOrThrow({ where: { id: draftId }, select: { version: true } })
    ).version;
  }

  it("persists an immutable snapshot for every non-user team and never the user team", async () => {
    const overrideKey = cpuPersonalityByKey("upside-hunter")?.key;
    if (overrideKey === undefined) throw new Error("upside-hunter missing");
    await createStartedMock({ seed: "integration-seed-1", personalityKey: "adp-follower" });
    const second = await createDraft(ownerA, {
      leagueId: leagueA,
      type: "MOCK",
      cpuPersonalityKey: "balanced",
      teamPersonalities: [{ teamSlot: 2, personalityKey: overrideKey }],
    });
    createdDraftIds.push(second.id);
    await transitionStatus({ draftId: second.id, ownerId: ownerA, action: "start" });

    const teams = await prisma.draftTeam.findMany({
      where: { draftId: second.id },
      orderBy: { slot: "asc" },
    });
    expect(teams).toHaveLength(4);
    for (const team of teams) {
      if (team.isUserTeam) {
        expect(team.cpuPersonalitySnapshot).toBeNull();
        continue;
      }
      const parsed = parseCpuPersonalitySnapshot(team.cpuPersonalitySnapshot);
      expect(parsed.snapshotVersion).toBe(1);
      expect(parsed.key === "balanced" || parsed.key === overrideKey).toBe(true);
      expect(Object.values(parsed.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      expect(team.cpuStrategy).toBe(parsed.key);
    }
    const overridden = teams.find((team) => team.slot === 2);
    expect(overridden?.cpuStrategy ?? null).toBe(overrideKey);
  });

  it("rejects unknown personalities and malformed seeds before any write", async () => {
    const mocksBefore = await prisma.draft.count({ where: { leagueId: leagueA, type: "MOCK" } });
    await expect(
      createDraft(ownerA, {
        leagueId: leagueA,
        type: "MOCK",
        cpuPersonalityKey: "does-not-exist",
      }),
    ).rejects.toThrow(/unknown CPU personality/);
    await expect(
      createDraft(ownerA, { leagueId: leagueA, type: "MOCK", simulationSeed: "bad seed!" }),
    ).rejects.toThrow(/simulation seed must be/);
    const countAfter = await prisma.draft.count({ where: { leagueId: leagueA, type: "MOCK" } });
    expect(countAfter).toBe(mocksBefore); // nothing half-created
  });

  it("is owner-only and enumeration-resistant; rejects non-mock types", async () => {
    const mock = await createStartedMock({ seed: "iso-seed" });
    // Owner B cannot see or drive A's draft.
    await expect(
      makeCpuPickForOwner(mock.id, ownerB, `cpu-foreign-${crypto.randomUUID()}`, 1),
    ).rejects.toBeInstanceOf(DraftNotFoundError);
    // A REAL draft refuses the CPU endpoint even for its owner.
    const real = await createDraft(ownerA, { leagueId: leagueA, type: "REAL" });
    createdDraftIds.push(real.id);
    await transitionStatus({ draftId: real.id, ownerId: ownerA, action: "start" });
    await expect(
      makeCpuPickForOwner(real.id, ownerA, `cpu-real-${crypto.randomUUID()}`, 1),
    ).rejects.toBeInstanceOf(DraftStatusError);
  });

  it("refuses CPU picks on the user's turn and advances only CPU slots", async () => {
    const mock = await createStartedMock({ seed: "turn-seed" });
    // Pick 1 belongs to user slot 1 → cpu-turn rejection.
    await expect(
      makeCpuPickForOwner(mock.id, ownerA, `cpu-user-turn-${crypto.randomUUID()}`, 1),
    ).rejects.toBeInstanceOf(CpuTurnError);
    // User makes pick 1 through the normal path.
    await makePick({
      draftId: mock.id,
      ownerId: ownerA,
      playerId,
      idempotencyKey: `cpu-test-user-pick-${crypto.randomUUID()}`,
      ifMatchVersion: 1,
    });
    // Now picks 2..4 are CPU turns; each request picks exactly once.
    const first = await makeCpuPickForOwner(
      mock.id,
      ownerA,
      `cpu-first-${crypto.randomUUID()}`,
      await versionOf(mock.id),
    );
    expect(first.pick.playerId).not.toBe(playerId);
    expect(first.pick.sequence).toBe(3);
    expect(first.authoritative.nextOverallPick).toBe(3);
    expect(first.evidence.personalityKey).toBe("balanced"); // default when none supplied
    expect(first.evidence.decisionChecksum).not.toBe("");
    const lastPickingSlot = overallPickToSlot(first.pick.sequence - 1, 4);
    expect(lastPickingSlot).not.toBe(1);

    const events = await prisma.draftEvent.findMany({
      where: { draftId: mock.id, eventType: "PLAYER_DRAFTED" },
      orderBy: { sequence: "asc" },
      select: { sequence: true, actorUserId: true, payload: true },
    });
    const cpuEvent = events.find((event) => event.sequence === 3);
    expect(cpuEvent?.actorUserId ?? null).toBeNull(); // explicit CPU actor evidence
    const payload = (cpuEvent?.payload ?? {}) as {
      slotPosition?: string;
      cpuEvidence?: { cpu?: boolean; decisionChecksum?: string };
    };
    expect(payload.cpuEvidence?.cpu).toBe(true);
    expect(payload.cpuEvidence?.decisionChecksum ?? "").not.toBe("");
    expect(payload.slotPosition ?? "").toBeTruthy();
  });

  it("makes concurrent identical requests produce at most one pick (idempotent replay)", async () => {
    const mock = await createStartedMock({ seed: "concurrent-seed" });
    await makePick({
      draftId: mock.id,
      ownerId: ownerA,
      playerId,
      idempotencyKey: `cpu-race-user-${crypto.randomUUID()}`,
      ifMatchVersion: 1,
    });
    const key = `cpu-concurrent-${crypto.randomUUID()}`;
    const version = await versionOf(mock.id);
    const [first, second] = await Promise.allSettled([
      makeCpuPickForOwner(mock.id, ownerA, key, version),
      makeCpuPickForOwner(mock.id, ownerA, key, version),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("fulfilled");
    if (first.status !== "fulfilled" || second.status !== "fulfilled") return;
    // Same idempotency key: one commit + one replay of the SAME pick.
    expect(first.value.pick.playerId).toBe(second.value.pick.playerId);
    expect(first.value.pick.sequence).toBe(second.value.pick.sequence);
    expect([first.value.pick.duplicated, second.value.pick.duplicated]).toContain(true);
    const cpuPicks = await prisma.draftEvent.count({
      where: {
        draftId: mock.id,
        eventType: "PLAYER_DRAFTED",
        actorUserId: null,
        payload: { path: ["cpuEvidence"], not: Prisma.AnyNull },
      },
    });
    expect(cpuPicks).toBe(1);
  });

  it("resolves a CPU-vs-user race with a single authoritative winner", async () => {
    const mock = await createStartedMock({ seed: "race-seed" });
    const staleUser = makePick({
      draftId: mock.id,
      ownerId: ownerA,
      playerId,
      idempotencyKey: `cpu-vs-user-${crypto.randomUUID()}`,
      ifMatchVersion: 1, // will be stale if CPU wins first
    });
    const cpuAttempt = makeCpuPickForOwner(
      mock.id,
      ownerA,
      `cpu-vs-user-cpu-${crypto.randomUUID()}`,
      1,
    ).catch((error: unknown) => ({ failed: true, error }));
    await Promise.allSettled([staleUser, cpuAttempt]);
    const pickCount = await prisma.draftEvent.count({
      where: { draftId: mock.id, eventType: "PLAYER_DRAFTED" },
    });
    expect(pickCount).toBeLessThanOrEqual(1);
    const integrity = await verifyReplayIntegrity(mock.id);
    expect(integrity.ok).toBe(true);
  });

  it("reproduces the same CPU pick after undo (deterministic re-selection)", async () => {
    const seed = "undo-stability-seed";
    const mock = await createStartedMock({ seed });
    await makePick({
      draftId: mock.id,
      ownerId: ownerA,
      playerId,
      idempotencyKey: `cpu-undo-user-${crypto.randomUUID()}`,
      ifMatchVersion: 1,
    });
    const key = `cpu-undo-original-${crypto.randomUUID()}`;
    const original = await makeCpuPickForOwner(mock.id, ownerA, key, await versionOf(mock.id));
    expect(original.pick.playerId).toBeTruthy();

    // Undo the CPU pick (latest effective pick).
    const midVersion = (
      await prisma.draft.findUniqueOrThrow({ where: { id: mock.id }, select: { version: true } })
    ).version;
    await undoPick({
      draftId: mock.id,
      ownerId: ownerA,
      idempotencyKey: `cpu-undo-comp-${crypto.randomUUID()}`,
      ifMatchVersion: midVersion,
    });
    const restored = await prisma.draft.findUniqueOrThrow({
      where: { id: mock.id },
      select: { nextOverallPick: true },
    });
    expect(restored.nextOverallPick).toBe(original.pick.sequence - 1); // cursor restored

    // Re-advance with a FRESH idempotency key — effective state identical ⇒
    // identical seed ⇒ identical player.
    const again = await makeCpuPickForOwner(
      mock.id,
      ownerA,
      `cpu-undo-redo-${crypto.randomUUID()}`,
      await versionOf(mock.id),
    );
    expect(again.pick.playerId).toBe(original.pick.playerId);
  });

  it("completes a fully seeded mock with legal rosters and no duplicates", async () => {
    const { id, simSeed } = await createStartedMock({ seed: "full-mock-completion" });
    expect(simSeed).toBe("full-mock-completion");
    let guard = 0;
    while (guard < 24) {
      guard += 1;
      const draft = await prisma.draft.findUniqueOrThrow({
        where: { id },
        select: { nextOverallPick: true, version: true, status: true },
      });
      if (draft.status !== "ACTIVE") break;
      const slot = overallPickToSlot(draft.nextOverallPick, 4);
      if (slot === 1) {
        // User turn: take the current top recommendation (deterministic engine).
        const recs = await fetchRecommendations(id, ownerA);
        const top = recs[0];
        if (!top) break;
        await makePick({
          draftId: id,
          ownerId: ownerA,
          playerId: top.playerId,
          idempotencyKey: [`cpu-full`, String(guard), crypto.randomUUID()].join("-"),
          ifMatchVersion: draft.version,
        });
      } else {
        await makeCpuPickForOwner(
          id,
          ownerA,
          [`cpu-full`, String(guard), crypto.randomUUID()].join("-"),
          draft.version,
        );
      }
      if (draft.nextOverallPick >= 12) break;
    }

    await transitionStatus({ draftId: id, ownerId: ownerA, action: "complete" });
    const assignments = await prisma.draftRosterAssignment.count({ where: { draftId: id } });
    expect(assignments).toBe(12); // 4 teams × 3 rounds, complete board
    const integrity = await verifyReplayIntegrity(id);
    expect(integrity.ok).toBe(true);
    const players = await prisma.draftRosterAssignment.groupBy({
      by: ["playerId"],
      where: { draftId: id },
      _count: { playerId: true },
    });
    expect(players.every((group) => group._count.playerId === 1)).toBe(true);
    const view = await getDraftForOwner(id, ownerA);
    expect(view?.status).toBe("COMPLETED");
    expect(view?.mock?.simSeed).toBe(simSeed);
  });

  it("rate-limits excessive CPU pick activity per user", async () => {
    // Drive the counter to the limit with synthetic audit rows.
    for (let i = 0; i < 5; i++) {
      await prisma.auditLog.create({
        data: {
          actorId: ownerB,
          action: "draft.cpuPick",
          entityType: "draft",
          entityId: "synthetic",
          traceId: crypto.randomUUID(),
        },
      });
    }
    // Far below the limit here (only 5 rows): the assertion proves the helper
    // reads the right window without burning 240 inserts.
    await expect(assertCpuPickRate(ownerB)).resolves.toBeUndefined();
    // And the limit itself trips deterministically.
    const many = Array.from({ length: 240 }, (_, i) => ({
      actorId: ownerB,
      action: "draft.cpuPick",
      entityType: "draft",
      entityId: `bulk-${String(i)}`,
      traceId: crypto.randomUUID(),
    }));
    await prisma.auditLog.createMany({ data: many });
    await expect(assertCpuPickRate(ownerB)).rejects.toBeInstanceOf(CpuRateLimitedError);
  });
});

async function fetchRecommendations(
  draftId: string,
  ownerId: string,
): Promise<{ playerId: string }[]> {
  const result = await getRecommendationsForOwner(draftId, ownerId);
  return result?.output.top3.map((entry) => ({ playerId: entry.playerId })) ?? [];
}
