import { prisma } from "@draftcourt/db";
import { ageAt, CURRENT_SEASON, getCurrentAdpSnapshot, getCurrentRun } from "./current-run";
import { serializeTeam } from "./players";
import type { PublicPlayerSummary } from "./players";

export interface HistoricalSeasonLine {
  season: string;
  scope: string;
  gamesPlayed: number;
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
}

export interface PublicPlayerProfile extends PublicPlayerSummary {
  imageUrl: null;
  draftYear: number | null;
  historicalSeasons: HistoricalSeasonLine[];
  strengths: string[];
  weaknesses: string[];
  projectionRun: { runId: string; modelVersion: string; dataCutoff: string } | null;
  demoData: true;
}

const Z_SCORE_STATS = ["pts", "reb", "ast", "stl", "blk", "threePm"] as const;
const STRENGTH_THRESHOLD = 0.75;
const WEAKNESS_THRESHOLD = -0.75;

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function stdev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance = mean(values.map((v) => (v - avg) ** 2));
  return Math.sqrt(variance);
}

/** Heuristic strengths/weaknesses: which standard categories this player
 * is notably above/below the current pool's average in — a Phase 1
 * stand-in, not the real roster/league-aware recommendation engine
 * (Phase 2+). Computed against the whole current-run pool each call;
 * fine at Phase 1's ~230-player demo scale. */
async function computeStrengthsWeaknesses(
  runId: string,
  playerId: string,
): Promise<{ strengths: string[]; weaknesses: string[] }> {
  const pool = await prisma.playerProjection.findMany({
    where: { runId },
    select: {
      playerId: true,
      pts: true,
      reb: true,
      ast: true,
      stl: true,
      blk: true,
      threePm: true,
    },
  });
  const target = pool.find((row) => row.playerId === playerId);
  if (!target) return { strengths: [], weaknesses: [] };

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  for (const stat of Z_SCORE_STATS) {
    const values = pool.map((row) => row[stat]);
    const avg = mean(values);
    const sd = stdev(values, avg);
    if (sd === 0) continue;
    const z = (target[stat] - avg) / sd;
    if (z >= STRENGTH_THRESHOLD) strengths.push(stat);
    else if (z <= WEAKNESS_THRESHOLD) weaknesses.push(stat);
  }
  return { strengths, weaknesses };
}

function pct(makes: number, attempts: number): number | null {
  return attempts > 0 ? makes / attempts : null;
}

export async function getPlayerProfile(slug: string): Promise<PublicPlayerProfile | null> {
  const [run, adpSnapshot] = await Promise.all([getCurrentRun(), getCurrentAdpSnapshot()]);

  const player = await prisma.player.findUnique({
    where: { slug },
    include: {
      currentTeam: true,
      eligibilities: { where: { season: CURRENT_SEASON } },
      seasonStats: { orderBy: { season: "asc" } },
      adpConsensusEntries: adpSnapshot ? { where: { snapshotId: adpSnapshot.snapshotId } } : false,
      projections: run ? { where: { runId: run.runId } } : false,
    },
  });
  if (!player) return null;

  const projection = player.projections[0] ?? null;
  const adpEntry = player.adpConsensusEntries[0] ?? null;
  const adp = adpEntry
    ? {
        consensusAdp: Number(adpEntry.consensusAdp),
        dispersion: Number(adpEntry.dispersion),
        sourcesCount: adpEntry.sourcesCount,
        valueConfidence: adpEntry.valueConfidence,
      }
    : null;

  const { strengths, weaknesses } =
    run && projection
      ? await computeStrengthsWeaknesses(run.runId, player.id)
      : { strengths: [], weaknesses: [] };

  return {
    id: player.id,
    slug: player.slug,
    displayName: player.displayName,
    age: ageAt(player.dob),
    status: player.status,
    unsigned: player.unsigned,
    rookie: player.rookie,
    draftYear: player.draftYear,
    imageUrl: null,
    positions: player.eligibilities.map((e) => e.position),
    team: serializeTeam(player.currentTeam),
    projection: projection
      ? {
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
        }
      : {
          games: 0,
          minutesPerGame: 0,
          pts: 0,
          reb: 0,
          ast: 0,
          stl: 0,
          blk: 0,
          tov: 0,
          fgPct: null,
          ftPct: null,
          threePm: 0,
          fantasyPoints: 0,
          overallRank: 0,
          injuryRisk: 0,
          consistency: 0,
          upside: 0,
          roleSecurity: 0,
          lower80: {},
          upper80: {},
        },
    adp,
    adpDelta: adp && projection ? projection.overallRank - Math.round(adp.consensusAdp) : null,
    historicalSeasons: player.seasonStats.map((row) => ({
      season: row.season,
      scope: row.scope,
      gamesPlayed: row.gamesPlayed,
      minutesPerGame: row.gamesPlayed > 0 ? row.minutesTotal / row.gamesPlayed : 0,
      pts: row.gamesPlayed > 0 ? row.pts / row.gamesPlayed : 0,
      reb: row.gamesPlayed > 0 ? row.reb / row.gamesPlayed : 0,
      ast: row.gamesPlayed > 0 ? row.ast / row.gamesPlayed : 0,
      stl: row.gamesPlayed > 0 ? row.stl / row.gamesPlayed : 0,
      blk: row.gamesPlayed > 0 ? row.blk / row.gamesPlayed : 0,
      tov: row.gamesPlayed > 0 ? row.tov / row.gamesPlayed : 0,
      fgPct: pct(row.fgm, row.fga),
      ftPct: pct(row.ftm, row.fta),
      threePm: row.gamesPlayed > 0 ? row.threePm / row.gamesPlayed : 0,
    })),
    strengths,
    weaknesses,
    projectionRun: run
      ? {
          runId: run.runId,
          modelVersion: run.modelVersion,
          dataCutoff: run.dataCutoff.toISOString(),
        }
      : null,
    demoData: true,
  };
}

export async function comparePlayers(slugs: string[]): Promise<PublicPlayerProfile[]> {
  const profiles = await Promise.all(slugs.map((slug) => getPlayerProfile(slug)));
  return profiles.filter((p): p is PublicPlayerProfile => p !== null);
}
