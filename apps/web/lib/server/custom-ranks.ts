import { z } from "zod";
import { Prisma, prisma } from "@draftcourt/db";

/**
 * Custom player ranks service (BUILD_SPEC.md sections 2.2 and 4.2, Phase 3A).
 *
 * Scopes: `leagueId = null` is the owner's GLOBAL board; a league id scopes
 * ranks to one league. Uniqueness of (owner, player) and (owner, rank) per
 * scope is enforced by composite unique indexes for league rows plus PARTIAL
 * unique indexes for global rows (Postgres NULL-distinct semantics — see the
 * Phase 3A migration). Replacement is fully transactional: a duplicate or
 * invalid entry rolls back the whole PUT.
 */

export class RankConflictError extends Error {}
export class RankScopeNotFoundError extends Error {}
export class RankValidationError extends Error {
  constructor(
    message: string,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export const MAX_RANK_ENTRIES = 500;

export const customRankEntrySchema = z.object({
  playerId: z.uuid(),
  /** Dense positive integer; replacement payloads must be a permutation of
   * 1..N so ordering is deterministic (the editor emits exactly this). */
  rank: z.number().int().min(1).max(MAX_RANK_ENTRIES),
  tier: z.number().int().min(1).max(10).nullable().default(null),
  note: z.string().trim().max(280).nullable().default(null),
});

export const replaceRanksSchema = z.object({
  leagueId: z.uuid().nullable(),
  ranks: z.array(customRankEntrySchema).max(MAX_RANK_ENTRIES),
});
export type ReplaceRanksInput = z.infer<typeof replaceRanksSchema>;

export interface CustomRankView {
  playerId: string;
  displayName: string;
  teamAbbreviation: string | null;
  positionEligibility: string[];
  status: string;
  rank: number;
  tier: number | null;
  note: string | null;
  updatedAt: Date;
}

const RANK_SELECT = {
  playerId: true,
  rank: true,
  tier: true,
  note: true,
  updatedAt: true,
  player: {
    select: {
      displayName: true,
      status: true,
      currentTeam: { select: { abbreviation: true } },
      eligibilities: { select: { position: true } },
    },
  },
} satisfies Prisma.CustomPlayerRankSelect;

export async function listRanks(
  ownerId: string,
  scope: { leagueId: string | null },
): Promise<CustomRankView[]> {
  const rows = await prisma.customPlayerRank.findMany({
    where: { ownerId, leagueId: scope.leagueId },
    select: RANK_SELECT,
    orderBy: { rank: "asc" },
  });
  return rows.map((row) => ({
    playerId: row.playerId,
    displayName: row.player.displayName,
    teamAbbreviation: row.player.currentTeam?.abbreviation ?? null,
    positionEligibility: row.player.eligibilities.map((eligibility) => eligibility.position),
    status: row.player.status,
    rank: row.rank,
    tier: row.tier,
    note: row.note,
    updatedAt: row.updatedAt,
  }));
}

/** Transactional full-scope replacement. Ranks must be unique and form the
 * exact set 1..N (deterministic dense ordering); players must exist and not
 * be retired. Any failure rolls back — the previous ranking survives intact. */
export async function replaceRanks(
  ownerId: string,
  payload: ReplaceRanksInput,
): Promise<{ count: number }> {
  if (payload.leagueId !== null) {
    const league = await prisma.league.findFirst({
      where: { id: payload.leagueId, ownerId },
      select: { id: true },
    });
    if (!league) throw new RankScopeNotFoundError();
  }

  const ranks = payload.ranks;
  const playerIds = new Set(ranks.map((entry) => entry.playerId));
  if (playerIds.size !== ranks.length) {
    throw new RankValidationError("duplicate players in ranks", {
      ranks: ["each player may appear only once"],
    });
  }
  // Dense permutation: N distinct integers, each within 1..N.
  const seenRanks = new Set<number>();
  for (const entry of ranks) {
    if (entry.rank < 1 || entry.rank > ranks.length || seenRanks.has(entry.rank)) {
      throw new RankValidationError("ranks must be a permutation of 1..N with no duplicates", {
        ranks: ["ranks must be unique integers 1..N"],
      });
    }
    seenRanks.add(entry.rank);
  }

  if (ranks.length > 0) {
    const rows = await prisma.player.findMany({
      where: { id: { in: [...playerIds] } },
      select: { id: true, status: true, displayName: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const entry of ranks) {
      const player = byId.get(entry.playerId);
      if (!player) {
        throw new RankValidationError("one or more ranked players do not exist", {
          ranks: ["unknown player"],
        });
      }
      if (player.status === "RETIRED") {
        throw new RankValidationError("retired players cannot be ranked", {
          ranks: [`${player.displayName} is retired`],
        });
      }
    }
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.customPlayerRank.deleteMany({
        where: { ownerId, leagueId: payload.leagueId },
      });
      if (ranks.length > 0) {
        await tx.customPlayerRank.createMany({
          data: ranks.map((entry) => ({
            ownerId,
            leagueId: payload.leagueId,
            playerId: entry.playerId,
            rank: entry.rank,
            tier: entry.tier,
            note: entry.note,
          })),
        });
      }
      return { count: ranks.length };
    });
  } catch (error) {
    // Unique violations from concurrent writers surface as P2002.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new RankConflictError(
        "rank conflict — the ranking changed concurrently, reload and retry",
      );
    }
    throw error;
  }
}
