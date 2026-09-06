import { prisma } from "@draftcourt/db";
import type { Prisma } from "@draftcourt/db";

export class HistoryNotFoundError extends Error {}
export class HistoryValidationError extends Error {}

export interface HistoryFilters {
  cursor?: string;
  limit?: number;
  type?: "REAL" | "MOCK";
  status?: "SETUP" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ABANDONED";
  leagueId?: string;
  from?: Date;
  to?: Date;
}

export interface HistoryResult {
  drafts: {
    id: string;
    ownerId: string | null;
    leagueId: string | null;
    type: string;
    status: string;
    updatedAt: Date;
    createdAt: Date;
    leagueName?: string | null;
    season?: string | null;
    teamCount?: number | null;
    rounds?: number | null;
    hasAnalysis: boolean;
    grade?: string | null;
    gradeScore?: number | null;
  }[];
  nextCursor: string | null;
}

/**
 * Owner-scoped cursor pagination for /api/v1/me/history (ADR 0015 D6).
 * Stable ordering updatedAt DESC + id ASC, demo/guest excluded.
 */
export async function listHistoryForOwner(
  ownerId: string,
  filters: HistoryFilters = {},
): Promise<HistoryResult> {
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 50);

  if (filters.type && !["REAL", "MOCK"].includes(filters.type)) {
    throw new HistoryValidationError(`invalid type ${filters.type}`);
  }
  if (
    filters.status &&
    !["SETUP", "ACTIVE", "PAUSED", "COMPLETED", "ABANDONED"].includes(filters.status)
  ) {
    throw new HistoryValidationError(`invalid status ${filters.status}`);
  }

  if (filters.leagueId) {
    const league = await prisma.league.findFirst({
      where: { id: filters.leagueId, ownerId },
      select: { id: true },
    });
    if (!league) throw new HistoryNotFoundError("league not found");
  }

  const where = {
    ownerId,
    type: filters.type ?? { not: "DEMO" },
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.leagueId ? { leagueId: filters.leagueId } : {}),
    ...(filters.from || filters.to
      ? {
          updatedAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
  } as Prisma.DraftWhereInput;

  const rows = await prisma.draft.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: limit + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      ownerId: true,
      leagueId: true,
      type: true,
      status: true,
      updatedAt: true,
      createdAt: true,
      settingsSnapshot: true,
      analyses: { take: 1, select: { grade: true, gradeScore: true } },
    },
  });

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    rows.pop();
    nextCursor = rows[rows.length - 1]?.id ?? null;
  }

  return {
    drafts: rows.map((r) => {
      const snap = r.settingsSnapshot as unknown as {
        season?: string;
        teamCount?: number;
        rounds?: number;
      } | null;
      return {
        id: r.id,
        ownerId: r.ownerId,
        leagueId: r.leagueId,
        type: r.type,
        status: r.status,
        updatedAt: r.updatedAt,
        createdAt: r.createdAt,
        season: snap?.season ?? null,
        teamCount: snap?.teamCount ?? null,
        rounds: snap?.rounds ?? null,
        hasAnalysis: r.analyses.length > 0,
        grade: r.analyses[0]?.grade ?? null,
        gradeScore: r.analyses[0]?.gradeScore ?? null,
      };
    }),
    nextCursor,
  };
}
