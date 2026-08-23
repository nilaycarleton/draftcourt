import { prisma } from "@draftcourt/db";
import type { Prisma } from "@draftcourt/db";
import {
  ageAt,
  ageRangeToDobRange,
  CURRENT_SEASON,
  getCurrentAdpSnapshot,
  getCurrentRun,
} from "./current-run";

/** Numeric projection stats every player-list filter/sort field maps to a
 * `{ gte, lte }` Prisma range on `PlayerProjection`. `overallRank` is
 * "lower is better" but the range semantics (min/max bound the value)
 * are identical either way. */
export const RANGE_STAT_FIELDS = [
  "overallRank",
  "fantasyPoints",
  "games",
  "minutesPerGame",
  "pts",
  "reb",
  "ast",
  "stl",
  "blk",
  "tov",
  "fgm",
  "fga",
  "ftm",
  "fta",
  "threePm",
  "injuryRisk",
  "consistency",
  "upside",
  "roleSecurity",
] as const;
export type RangeStatField = (typeof RANGE_STAT_FIELDS)[number];

export type PlayerSortField = RangeStatField | "displayName" | "adp";

export interface PlayerListFilters {
  name?: string;
  team?: string[];
  position?: string[];
  availability?: string[];
  unsigned?: boolean;
  rookie?: boolean;
  ageMin?: number;
  ageMax?: number;
  adpMin?: number;
  adpMax?: number;
  ranges?: Partial<Record<RangeStatField, { min?: number; max?: number }>>;
}

export interface PlayerListQuery {
  filters: PlayerListFilters;
  sort: PlayerSortField;
  direction: "asc" | "desc";
  cursor?: number;
  limit: number;
}

export interface PublicPlayerSummary {
  id: string;
  slug: string;
  displayName: string;
  age: number | null;
  status: string;
  unsigned: boolean;
  rookie: boolean;
  positions: string[];
  team: PublicTeam | null;
  projection: {
    games: number;
    minutesPerGame: number;
    pts: number;
    reb: number;
    ast: number;
    stl: number;
    blk: number;
    tov: number;
    fgPct: number | null;
    ftPct: number | null;
    threePm: number;
    fantasyPoints: number;
    overallRank: number;
    injuryRisk: number;
    consistency: number;
    upside: number;
    roleSecurity: number;
    lower80: Record<string, number>;
    upper80: Record<string, number>;
  };
  adp: {
    consensusAdp: number;
    dispersion: number;
    sourcesCount: number;
    valueConfidence: number;
  } | null;
  adpDelta: number | null;
}

function pct(makes: number, attempts: number): number | null {
  return attempts > 0 ? makes / attempts : null;
}

export interface PublicTeam {
  abbreviation: string;
  name: string;
  colorPrimary: string;
  colorSecondary: string;
}

/** Explicitly picks the safe public fields off a full `NbaTeam` row —
 * never pass a Prisma model through directly. `nbaProviderId` (a source-
 * lineage identifier) and row housekeeping (`id`/`createdAt`/`updatedAt`)
 * must never reach a public API response. */
export function serializeTeam(
  team: { abbreviation: string; name: string; colorPrimary: string; colorSecondary: string } | null,
): PublicTeam | null {
  if (!team) return null;
  return {
    abbreviation: team.abbreviation,
    name: team.name,
    colorPrimary: team.colorPrimary,
    colorSecondary: team.colorSecondary,
  };
}

function serializeSummary(projection: {
  games: number;
  minutesPerGame: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
  fgm: number;
  fga: number;
  ftm: number;
  fta: number;
  threePm: number;
  fantasyPoints: number;
  overallRank: number;
  injuryRisk: number;
  consistency: number;
  upside: number;
  roleSecurity: number;
  lower80: Prisma.JsonValue;
  upper80: Prisma.JsonValue;
  player: {
    id: string;
    slug: string;
    displayName: string;
    dob: Date | null;
    status: string;
    unsigned: boolean;
    rookie: boolean;
    currentTeam: {
      abbreviation: string;
      name: string;
      colorPrimary: string;
      colorSecondary: string;
    } | null;
    eligibilities: { position: string }[];
    adpConsensusEntries: {
      consensusAdp: Prisma.Decimal;
      dispersion: Prisma.Decimal;
      sourcesCount: number;
      valueConfidence: number;
    }[];
  };
}): PublicPlayerSummary {
  const { player } = projection;
  const adpEntry = player.adpConsensusEntries[0] ?? null;
  const adp = adpEntry
    ? {
        consensusAdp: Number(adpEntry.consensusAdp),
        dispersion: Number(adpEntry.dispersion),
        sourcesCount: adpEntry.sourcesCount,
        valueConfidence: adpEntry.valueConfidence,
      }
    : null;

  return {
    id: player.id,
    slug: player.slug,
    displayName: player.displayName,
    age: ageAt(player.dob),
    status: player.status,
    unsigned: player.unsigned,
    rookie: player.rookie,
    positions: player.eligibilities.map((e) => e.position),
    team: serializeTeam(player.currentTeam),
    projection: {
      games: projection.games,
      minutesPerGame: projection.minutesPerGame,
      pts: projection.pts,
      reb: projection.reb,
      ast: projection.ast,
      stl: projection.stl,
      blk: projection.blk,
      tov: projection.tov,
      fgPct: pct(projection.fgm, projection.fga),
      ftPct: pct(projection.ftm, projection.fta),
      threePm: projection.threePm,
      fantasyPoints: projection.fantasyPoints,
      overallRank: projection.overallRank,
      injuryRisk: projection.injuryRisk,
      consistency: projection.consistency,
      upside: projection.upside,
      roleSecurity: projection.roleSecurity,
      lower80: projection.lower80 as Record<string, number>,
      upper80: projection.upper80 as Record<string, number>,
    },
    adp,
    adpDelta: adp ? projection.overallRank - Math.round(adp.consensusAdp) : null,
  };
}

function buildPlayerWhere(filters: PlayerListFilters): Prisma.PlayerWhereInput {
  const where: Prisma.PlayerWhereInput = {};
  if (filters.name) {
    where.displayName = { contains: filters.name, mode: "insensitive" };
  }
  if (filters.team?.length) {
    where.currentTeam = { abbreviation: { in: filters.team } };
  }
  if (filters.position?.length) {
    where.eligibilities = {
      some: { season: CURRENT_SEASON, position: { in: filters.position as never[] } },
    };
  }
  if (filters.availability?.length) {
    where.status = { in: filters.availability as never[] };
  }
  if (filters.unsigned !== undefined) {
    where.unsigned = filters.unsigned;
  }
  if (filters.rookie !== undefined) {
    where.rookie = filters.rookie;
  }
  const dobRange = ageRangeToDobRange(filters.ageMin, filters.ageMax);
  if (dobRange.gte || dobRange.lte) {
    where.dob = dobRange;
  }
  return where;
}

function buildProjectionWhere(
  runId: string,
  filters: PlayerListFilters,
): Prisma.PlayerProjectionWhereInput {
  const where: Prisma.PlayerProjectionWhereInput = { runId };
  for (const [field, range] of Object.entries(filters.ranges ?? {})) {
    const condition: Prisma.FloatFilter | Prisma.IntFilter = {};
    if (range.min !== undefined) condition.gte = range.min;
    if (range.max !== undefined) condition.lte = range.max;
    (where as Record<string, unknown>)[field] = condition;
  }
  return where;
}

const PROJECTION_INCLUDE = {
  player: {
    include: {
      currentTeam: true,
      eligibilities: { where: { season: CURRENT_SEASON } },
      adpConsensusEntries: true, // filtered to the current snapshot at the caller level below
    },
  },
} satisfies Prisma.PlayerProjectionInclude;

export interface PlayerListResult {
  players: PublicPlayerSummary[];
  hasMore: boolean;
  nextCursor: number | null;
  totalCount: number;
  meta: {
    runId: string | null;
    modelVersion: string | null;
    dataCutoff: string | null;
    adpSnapshotCapturedAt: string | null;
  };
}

export async function listPlayers(query: PlayerListQuery): Promise<PlayerListResult> {
  const [run, adpSnapshot] = await Promise.all([getCurrentRun(), getCurrentAdpSnapshot()]);
  if (!run) {
    return {
      players: [],
      hasMore: false,
      nextCursor: null,
      totalCount: 0,
      meta: { runId: null, modelVersion: null, dataCutoff: null, adpSnapshotCapturedAt: null },
    };
  }

  const playerWhere = buildPlayerWhere(query.filters);
  const projectionWhere: Prisma.PlayerProjectionWhereInput = {
    ...buildProjectionWhere(run.runId, query.filters),
    player: playerWhere,
  };
  if (adpSnapshot && (query.filters.adpMin !== undefined || query.filters.adpMax !== undefined)) {
    projectionWhere.player = {
      ...playerWhere,
      adpConsensusEntries: {
        some: {
          snapshotId: adpSnapshot.snapshotId,
          consensusAdp: {
            ...(query.filters.adpMin !== undefined ? { gte: query.filters.adpMin } : {}),
            ...(query.filters.adpMax !== undefined ? { lte: query.filters.adpMax } : {}),
          },
        },
      },
    };
  }

  const offset = query.cursor ?? 0;

  if (query.sort === "adp") {
    // ADP lives on a separate per-snapshot table; Prisma can't order a
    // one-to-many relation by a filtered single value, so this path
    // fetches the (small, Phase-1-demo-scale) matching set, sorts in
    // application code, then pages. Documented tradeoff, not an oversight
    // — see docs/adr/0008-caching-and-background-jobs.md.
    const rows = await prisma.playerProjection.findMany({
      where: projectionWhere,
      include: PROJECTION_INCLUDE,
    });
    const withAdpOrUndefined = rows.map((row) => ({
      row,
      adp: row.player.adpConsensusEntries.find((e) => e.snapshotId === adpSnapshot?.snapshotId),
    }));
    const withAdp = withAdpOrUndefined.filter(
      (entry): entry is { row: (typeof rows)[number]; adp: NonNullable<typeof entry.adp> } =>
        entry.adp !== undefined,
    );
    withAdp.sort((a, b) => {
      const diff = Number(a.adp.consensusAdp) - Number(b.adp.consensusAdp);
      return query.direction === "asc" ? diff : -diff;
    });
    const page = withAdp.slice(offset, offset + query.limit);
    const serialized = page.map(({ row }) =>
      serializeSummary({
        ...row,
        player: {
          ...row.player,
          adpConsensusEntries: row.player.adpConsensusEntries.filter(
            (e) => e.snapshotId === adpSnapshot?.snapshotId,
          ),
        },
      }),
    );
    return {
      players: serialized,
      hasMore: offset + query.limit < withAdp.length,
      nextCursor: offset + query.limit < withAdp.length ? offset + query.limit : null,
      totalCount: withAdp.length,
      meta: {
        runId: run.runId,
        modelVersion: run.modelVersion,
        dataCutoff: run.dataCutoff.toISOString(),
        adpSnapshotCapturedAt: adpSnapshot?.capturedAt.toISOString() ?? null,
      },
    };
  }

  const orderBy: Prisma.PlayerProjectionOrderByWithRelationInput =
    query.sort === "displayName"
      ? { player: { displayName: query.direction } }
      : { [query.sort]: query.direction };

  const [rows, totalCount] = await Promise.all([
    prisma.playerProjection.findMany({
      where: projectionWhere,
      include: PROJECTION_INCLUDE,
      orderBy: [orderBy, { playerId: "asc" }],
      skip: offset,
      take: query.limit + 1,
    }),
    prisma.playerProjection.count({ where: projectionWhere }),
  ]);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const serialized = page.map((row) =>
    serializeSummary({
      ...row,
      player: {
        ...row.player,
        adpConsensusEntries: row.player.adpConsensusEntries.filter(
          (e) => e.snapshotId === adpSnapshot?.snapshotId,
        ),
      },
    }),
  );

  return {
    players: serialized,
    hasMore,
    nextCursor: hasMore ? offset + query.limit : null,
    totalCount,
    meta: {
      runId: run.runId,
      modelVersion: run.modelVersion,
      dataCutoff: run.dataCutoff.toISOString(),
      adpSnapshotCapturedAt: adpSnapshot?.capturedAt.toISOString() ?? null,
    },
  };
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined): number | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "offset" in parsed &&
      typeof parsed.offset === "number"
    ) {
      return parsed.offset;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
