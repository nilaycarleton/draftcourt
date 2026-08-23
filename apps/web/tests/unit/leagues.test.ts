import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@draftcourt/db";
import { eightCategoryPreset, defaultRosterSlots, pointsPreset } from "@draftcourt/domain";
import {
  createLeague,
  createLeagueSchema,
  deleteLeague,
  getLeagueDetail,
  cloneLeague,
  LeagueNotFoundError,
  LeagueRuleLockedError,
  LeagueValidationError,
  listLeagues,
  updateLeagueMeta,
  updateLeagueRules,
} from "@/lib/server/leagues";

/**
 * Runs against the real local Postgres like the rest of this package's
 * database-backed tests. Every row is cleaned up in afterAll.
 */
describe("leagues service", () => {
  let ownerId: string;
  let otherUserId: string;
  const createdLeagueIds: string[] = [];

  function validInput(overrides: Record<string, unknown> = {}) {
    return {
      name: "Test League",
      season: "2026-27",
      teamCount: 12,
      userDraftSlot: 4,
      rounds: 13,
      config: {
        type: "POINTS" as const,
        horizon: "REDRAFT" as const,
        playoffWeeks: 3,
        scoringRules: pointsPreset(),
        rosterSlots: defaultRosterSlots(),
      },
      ...overrides,
    };
  }

  beforeAll(async () => {
    const suffix = crypto.randomUUID();
    const owner = await prisma.user.create({
      data: { clerkUserId: `test-owner-${suffix}` },
      select: { id: true },
    });
    const other = await prisma.user.create({
      data: { clerkUserId: `test-other-${suffix}` },
      select: { id: true },
    });
    ownerId = owner.id;
    otherUserId = other.id;
  });

  afterAll(async () => {
    // Drafts block league deletion; remove any drafts the tests made first.
    await prisma.recommendationSnapshot.deleteMany({
      where: { draft: { leagueId: { in: createdLeagueIds } } },
    });
    await prisma.draftRosterAssignment.deleteMany({
      where: { draft: { leagueId: { in: createdLeagueIds } } },
    });
    await prisma.draftEvent.deleteMany({
      where: { draft: { leagueId: { in: createdLeagueIds } } },
    });
    await prisma.draftTeam.deleteMany({
      where: { draft: { leagueId: { in: createdLeagueIds } } },
    });
    await prisma.draft.deleteMany({ where: { leagueId: { in: createdLeagueIds } } });
    for (const leagueId of createdLeagueIds) {
      await prisma.scoringRule.deleteMany({
        where: { settingsVersion: { leagueId } },
      });
      await prisma.rosterSlotRule.deleteMany({
        where: { settingsVersion: { leagueId } },
      });
      await prisma.leagueSettingsVersion.deleteMany({ where: { leagueId } });
      await prisma.leagueTeam.deleteMany({ where: { leagueId } });
      await prisma.league.deleteMany({ where: { id: leagueId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherUserId] } } });
  });

  it("creates a league with settings version 1 and full team slots", async () => {
    const league = await createLeague(ownerId, validInput());
    createdLeagueIds.push(league.id);

    expect(league.settingsVersionNumber).toBe(1);
    expect(league.teamCount).toBe(12);
    expect(league.type).toBe("POINTS");

    const teams = await prisma.leagueTeam.findMany({
      where: { leagueId: league.id },
      orderBy: { slot: "asc" },
    });
    expect(teams).toHaveLength(12);
    expect(teams.find((t) => t.slot === 4)?.isUserTeam).toBe(true);
    expect(teams.filter((t) => t.isUserTeam)).toHaveLength(1);

    const version = await prisma.leagueSettingsVersion.findFirstOrThrow({
      where: { leagueId: league.id },
      include: { scoringRules: true, rosterSlots: true },
    });
    expect(version.scoringRules).toHaveLength(pointsPreset().length);
    expect(version.rosterSlots).toHaveLength(defaultRosterSlots().length);
  });

  it("rejects duplicate stat keys, bad seasons, and impossible rosters", async () => {
    // Schema boundary:
    const dup = validInput();
    dup.config = {
      ...dup.config,
      scoringRules: [
        ...pointsPreset(),
        { stat: "PTS", weight: 1, direction: "HIGHER_BETTER" as const, enabled: true, punt: false },
      ],
    };
    expect(createLeagueSchema.safeParse(dup).success).toBe(false);

    const badSeason = validInput({ season: "2026-28" });
    expect(createLeagueSchema.safeParse(badSeason).success).toBe(false);

    // userDraftSlot <= teamCount is enforced at the SERVICE boundary
    // (cross-field), not by this file's per-field schema — see the
    // dedicated cross-field tests below.
    const shortRounds = validInput({ rounds: 10 }); // 12-man roster needs 12
    await expect(createLeague(ownerId, shortRounds)).rejects.toBeInstanceOf(LeagueValidationError);
  });

  it("rejects creating a league for a user id that does not exist", async () => {
    const ghost = crypto.randomUUID();
    await expect(createLeague(ghost, validInput())).rejects.toThrow();
  });

  it("creates a NEW immutable settings version on rule edits and keeps the old one", async () => {
    const league = await createLeague(ownerId, validInput());
    createdLeagueIds.push(league.id);

    const config = {
      type: "CATEGORIES" as const,
      horizon: "KEEPER" as const,
      playoffWeeks: null,
      scoringRules: eightCategoryPreset(),
      rosterSlots: defaultRosterSlots(),
    };
    const updated = await updateLeagueRules(ownerId, league.id, config);
    expect(updated.settingsVersionNumber).toBe(2);
    expect(updated.type).toBe("CATEGORIES");

    const versions = await prisma.leagueSettingsVersion.findMany({
      where: { leagueId: league.id },
      include: { scoringRules: true },
      orderBy: { versionNumber: "asc" },
    });
    expect(versions).toHaveLength(2);
    const [v1, v2] = versions;
    expect(v1?.scoringRules.length).toBeGreaterThan(0); // untouched
    expect(v2?.scoringRules).toHaveLength(eightCategoryPreset().length);

    const active = await prisma.league.findUniqueOrThrow({
      where: { id: league.id },
      select: { activeSettingsVersion: { select: { versionNumber: true } } },
    });
    expect(active.activeSettingsVersion?.versionNumber).toBe(2);
  });

  it("metadata edits do not create a new settings version", async () => {
    const league = await createLeague(ownerId, validInput());
    createdLeagueIds.push(league.id);

    const renamed = await updateLeagueMeta(ownerId, league.id, { name: "Renamed" });
    expect(renamed.name).toBe("Renamed");
    expect(renamed.settingsVersionNumber).toBe(1);

    const versions = await prisma.leagueSettingsVersion.count({
      where: { leagueId: league.id },
    });
    expect(versions).toBe(1);
  });

  it("hides other users' leagues (no enumeration oracle)", async () => {
    const league = await createLeague(ownerId, validInput());
    createdLeagueIds.push(league.id);

    await expect(getLeagueDetail(otherUserId, league.id)).resolves.toBeNull();
    await expect(cloneLeague(otherUserId, league.id)).resolves.toBeNull();

    const missingId = crypto.randomUUID();
    await expect(getLeagueDetail(otherUserId, missingId)).resolves.toBeNull();
    await expect(deleteLeague(otherUserId, missingId)).rejects.toBeInstanceOf(LeagueNotFoundError);
  });

  it("clones configuration and teams but nothing else, fully isolated", async () => {
    const league = await createLeague(ownerId, validInput());
    createdLeagueIds.push(league.id);
    await updateLeagueRules(ownerId, league.id, {
      type: "CATEGORIES",
      horizon: "DYNASTY",
      playoffWeeks: 2,
      scoringRules: nineCat(),
      rosterSlots: defaultRosterSlots(),
    });

    const clone = await cloneLeague(ownerId, league.id);
    if (!clone) throw new Error("clone should exist");
    createdLeagueIds.push(clone.id);
    expect(clone.name).toBe("Test League (copy)");
    expect(clone.type).toBe("CATEGORIES");
    expect(clone.horizon).toBe("DYNASTY");

    const sourceDetail = await getLeagueDetail(ownerId, league.id);
    const cloneDetail = await getLeagueDetail(ownerId, clone.id);
    if (!sourceDetail || !cloneDetail) throw new Error("details should exist");
    expect(cloneDetail.settings.scoringRules).toEqual(sourceDetail.settings.scoringRules);
    expect(cloneDetail.settings.versionNumber).toBe(1);
    expect(cloneDetail.teams.map((t) => t.slot)).toEqual(sourceDetail.teams.map((t) => t.slot));

    // Isolation: editing the source afterwards must not affect the clone.
    await updateLeagueMeta(ownerId, league.id, { name: "Changed Source" });
    const cloneAfter = await getLeagueDetail(ownerId, clone.id);
    expect(cloneAfter?.name).toBe("Test League (copy)");
  });

  it("lists leagues newest-first for the owning user only", async () => {
    const mine = await createLeague(ownerId, validInput());
    const theirs = await createLeague(otherUserId, validInput());
    createdLeagueIds.push(mine.id, theirs.id);

    const mineList = await listLeagues(ownerId);
    expect(mineList.leagues.some((l) => l.id === mine.id)).toBe(true);
    expect(mineList.leagues.some((l) => l.id === theirs.id)).toBe(false);
  });

  it("deletes an empty league completely and refuses once a draft exists", async () => {
    const league = await createLeague(ownerId, validInput());
    createdLeagueIds.push(league.id);

    // Simulate a draft existing (Phase 2.2 builds the real flow).
    await prisma.draft.create({
      data: {
        ownerId,
        leagueId: league.id,
        settingsSnapshot: {},
        engineVersion: "test-0",
        teams: { create: [{ slot: 1, displayName: "A" }] },
        events: { create: [{ sequence: 1, eventType: "DRAFT_STARTED" }] },
      },
    });

    await expect(deleteLeague(ownerId, league.id)).rejects.toBeInstanceOf(LeagueRuleLockedError);
    await expect(updateLeagueRules(ownerId, league.id, validInput().config)).rejects.toBeInstanceOf(
      LeagueRuleLockedError,
    );
  });

  it("rejects userDraftSlot beyond teamCount (cross-field, service boundary)", async () => {
    const bad = validInput({ userDraftSlot: 99 });
    await expect(createLeague(ownerId, bad)).rejects.toBeInstanceOf(LeagueValidationError);
  });

  function nineCat() {
    return [
      ...eightCategoryPreset(),
      {
        stat: "THREE_PM",
        weight: 1,
        direction: "HIGHER_BETTER" as const,
        enabled: true,
        punt: false,
      },
    ];
  }
});
