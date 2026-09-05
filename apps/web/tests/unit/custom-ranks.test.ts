import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, prisma } from "@draftcourt/db";
import {
  listRanks,
  replaceRanks,
  RankScopeNotFoundError,
  RankValidationError,
} from "@/lib/server/custom-ranks";

/**
 * Database-backed custom-rank tests (real local Postgres): dense-permutation
 * validation, duplicate rejection, retired players, scope isolation between
 * the global board and a league board, ownership scoping for league scopes,
 * and the partial unique indexes that make global uniqueness hold even under
 * raw writes.
 */
describe("custom ranks service", () => {
  let ownerId: string;
  let otherOwnerId: string;
  let leagueId: string;
  const playerIds: string[] = [];
  const createdUserIds: string[] = [];

  async function newUser(): Promise<string> {
    const user = await prisma.user.create({
      data: { clerkUserId: `test-ranks-${crypto.randomUUID()}` },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  async function newPlayer(displayName: string, status: "ACTIVE" | "RETIRED" = "ACTIVE") {
    const player = await prisma.player.create({
      data: {
        slug: `test-rank-${crypto.randomUUID()}`,
        displayName,
        legalName: displayName,
        status,
      },
      select: { id: true },
    });
    playerIds.push(player.id);
    return player.id;
  }

  beforeAll(async () => {
    ownerId = await newUser();
    otherOwnerId = await newUser();
    for (let index = 1; index <= 5; index += 1) {
      await newPlayer(`Rank Player ${String(index)}`);
    }
    await newPlayer("Retired Rank Player", "RETIRED");
    const ownerRow = await prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { clerkUserId: true },
    });
    void ownerRow;
    const suffix = crypto.randomUUID();
    const ownerUser = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    const league = await prisma.league.create({
      data: {
        ownerId: ownerUser.id,
        name: `Ranks League ${suffix}`,
        season: "2026-27",
        type: "POINTS",
        teamCount: 4,
        userDraftSlot: 1,
        rounds: 6,
      },
      select: { id: true },
    });
    leagueId = league.id;
  });

  afterAll(async () => {
    await prisma.customPlayerRank.deleteMany({
      where: { ownerId: { in: [ownerId, otherOwnerId] } },
    });
    await prisma.league.deleteMany({ where: { id: leagueId } });
    await prisma.player.deleteMany({ where: { id: { in: playerIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it("replaces the global board transactionally and reads back ordered", async () => {
    const a = playerIds[0];
    const b = playerIds[1];
    const c = playerIds[2];
    if (a === undefined || b === undefined || c === undefined) throw new Error("players missing");
    const result = await replaceRanks(ownerId, {
      leagueId: null,
      ranks: [
        { playerId: c, rank: 2, tier: null, note: null },
        { playerId: a, rank: 1, tier: 1, note: "cornerstone" },
        { playerId: b, rank: 3, tier: null, note: null },
      ],
    });
    expect(result.count).toBe(3);

    const view = await listRanks(ownerId, { leagueId: null });
    expect(view.map((entry) => entry.playerId)).toEqual([a, c, b]);
    expect(view[0]).toMatchObject({ rank: 1, tier: 1, note: "cornerstone" });
    expect(view[0]?.displayName).toContain("Rank Player");

    // Replacement is full-scope: a smaller payload drops earlier rows.
    await replaceRanks(ownerId, {
      leagueId: null,
      ranks: [{ playerId: a, rank: 1, tier: null, note: null }],
    });
    expect(await listRanks(ownerId, { leagueId: null })).toHaveLength(1);
  });

  it("keeps global and league boards independent", async () => {
    const p1 = playerIds[0];
    const p2 = playerIds[1];
    if (p1 === undefined || p2 === undefined) throw new Error("players missing");
    await replaceRanks(ownerId, {
      leagueId: null,
      ranks: [{ playerId: p1, rank: 1, tier: null, note: null }],
    });
    await replaceRanks(ownerId, {
      leagueId,
      ranks: [{ playerId: p2, rank: 1, tier: null, note: null }],
    });

    expect((await listRanks(ownerId, { leagueId: null })).map((r) => r.playerId)).toEqual([p1]);
    expect((await listRanks(ownerId, { leagueId })).map((r) => r.playerId)).toEqual([p2]);

    // Same player may be ranked globally AND per-league.
    await replaceRanks(ownerId, {
      leagueId,
      ranks: [{ playerId: p1, rank: 1, tier: null, note: null }],
    });
    expect(await listRanks(ownerId, { leagueId })).toHaveLength(1);
  });

  it("rejects duplicate players, duplicate ranks, non-permutations, and bad scopes", async () => {
    const p1 = playerIds[0];
    const p2 = playerIds[1];
    if (p1 === undefined || p2 === undefined) throw new Error("players missing");
    await expect(
      replaceRanks(ownerId, {
        leagueId: null,
        ranks: [
          { playerId: p1, rank: 1, tier: null, note: null },
          { playerId: p1, rank: 2, tier: null, note: null },
        ],
      }),
    ).rejects.toMatchObject({ fieldErrors: { ranks: ["each player may appear only once"] } });

    await expect(
      replaceRanks(ownerId, {
        leagueId: null,
        ranks: [
          { playerId: p1, rank: 1, tier: null, note: null },
          { playerId: p2, rank: 1, tier: null, note: null },
        ],
      }),
    ).rejects.toMatchObject({ fieldErrors: { ranks: [/unique integers 1..N/] } });

    await expect(
      replaceRanks(ownerId, {
        leagueId: null,
        ranks: [{ playerId: p1, rank: 7, tier: null, note: null }],
      }),
    ).rejects.toBeInstanceOf(RankValidationError);

    await expect(
      replaceRanks(ownerId, {
        leagueId: crypto.randomUUID(),
        ranks: [{ playerId: p1, rank: 1, tier: null, note: null }],
      }),
    ).rejects.toBeInstanceOf(RankScopeNotFoundError);

    await expect(replaceRanks(otherOwnerId, { leagueId, ranks: [] })).rejects.toBeInstanceOf(
      RankScopeNotFoundError,
    ); // foreign league → same 404 as missing
  });

  it("rejects retired and unknown players", async () => {
    const retiredId = playerIds[playerIds.length - 1] ?? "";
    if (retiredId === "") throw new Error("missing retired player"); // last created is RETIRED
    await expect(
      replaceRanks(ownerId, {
        leagueId: null,
        ranks: [{ playerId: retiredId, rank: 1, tier: null, note: null }],
      }),
    ).rejects.toMatchObject({ fieldErrors: { ranks: [/retired/] } });

    await expect(
      replaceRanks(ownerId, {
        leagueId: null,
        ranks: [{ playerId: crypto.randomUUID(), rank: 1, tier: null, note: null }],
      }),
    ).rejects.toMatchObject({ fieldErrors: { ranks: ["unknown player"] } });
  });

  it("global uniqueness holds at the DATABASE level even via raw writes", async () => {
    const p1 = playerIds[0];
    if (p1 === undefined) throw new Error("missing player");
    const base = { ownerId, leagueId: null as string | null, playerId: p1 };
    await prisma.customPlayerRank.deleteMany({ where: { ownerId, leagueId: null } });
    await prisma.customPlayerRank.create({ data: { ...base, rank: 1 } });
    // Same player again globally → P2002 from the partial index.
    await expect(
      prisma.customPlayerRank.create({ data: { ...base, rank: 2 } }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    // Different player at an occupied global rank → P2002 from the rank index.
    const p3 = playerIds[2];
    if (p3 === undefined) throw new Error("missing player");
    await expect(
      prisma.customPlayerRank.create({
        data: { ownerId, leagueId: null, playerId: p3, rank: 1 },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    // NOTE: the P2002 → RankConflictError mapping in replaceRanks is
    // defense-in-depth for concurrent writers; it cannot be triggered
    // deterministically here because dense-permutation validation rejects
    // conflicting payloads before any write. The partial indexes above are
    // the authoritative backstop.
  });
});
