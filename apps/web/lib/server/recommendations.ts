import { prisma } from "@draftcourt/db";
import type { Prisma } from "@draftcourt/db";
import {
  recommend,
  type EngineAdpEntry,
  type EngineAssignment,
  type EngineInput,
  type EnginePlayerMeta,
  type EngineProjection,
  type EngineSettings,
  type RecommendationOutput,
} from "@draftcourt/domain";
import { PROJECTION_AS_OF } from "@/lib/server/current-run";

/**
 * Server orchestration for the deterministic engine: loads the immutable
 * input snapshot (settings snapshot JSON on the draft, published projections
 * for the season, eligibility/status/age, demo ADP, effective selections),
 * runs `recommend`, persists a `RecommendationSnapshot` keyed by input
 * checksum + sequence, and marks the pick's outbox request processed.
 *
 * Caching correctness: the snapshot's natural key is
 * `(draftId, sequence, inputChecksum)` — identical inputs return the stored
 * payload byte-for-byte, and no stale cache can ever affect pick legality
 * because legality is enforced in the pick transaction against live tables.
 */

export class DraftNotReadyError extends Error {}

export async function getRecommendationsForOwner(
  draftId: string,
  ownerId: string,
  options: { force?: boolean } = {},
): Promise<{ output: RecommendationOutput; latencyMs: number; cached: boolean } | null> {
  const started = Date.now();
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, ownerId },
    select: {
      id: true,
      currentSequence: true,
      nextOverallPick: true,
      engineVersion: true,
      settingsSnapshot: true,
    },
  });
  if (!draft) return null;

  if (!options.force) {
    // Reuse an already-stored snapshot at this exact sequence.
    const existing = await prisma.recommendationSnapshot.findFirst({
      where: { draftId, sequence: draft.currentSequence },
      orderBy: { requestedAt: "desc" },
      select: { payload: true, inputChecksum: true, engineVersion: true },
    });
    if (existing?.engineVersion === draft.engineVersion) {
      await markOutboxProcessed(draftId, draft.currentSequence);
      return {
        output: existing.payload as unknown as RecommendationOutput,
        latencyMs: 0,
        cached: true,
      };
    }
  }

  const settings = draft.settingsSnapshot as unknown as EngineSettings;
  const season = settings.season;

  const [currentRun, adpEntries, assignments] = await Promise.all([
    prisma.projectionRun.findFirst({
      where: { season, isCurrent: true },
      select: { id: true, model: { select: { modelKey: true, version: true } } },
    }),
    latestAdpEntries(season),
    prisma.draftRosterAssignment.findMany({
      where: { draftId },
      select: { playerId: true, teamSlot: true, slotPosition: true },
    }),
  ]);
  if (!currentRun) throw new DraftNotReadyError("no published projection run for the season");

  // The engine's universe IS the published run — never a wider player table.
  const projections = await prisma.playerProjection.findMany({
    where: { runId: currentRun.id },
    select: {
      playerId: true,
      games: true,
      minutesPerGame: true,
      pts: true,
      reb: true,
      ast: true,
      stl: true,
      blk: true,
      tov: true,
      fgm: true,
      fga: true,
      ftm: true,
      fta: true,
      threePm: true,
      lower80: true,
      upper80: true,
      injuryRisk: true,
      consistency: true,
      upside: true,
      roleSecurity: true,
    },
  });
  const projectedIds = projections.map((line) => line.playerId);
  const [players, eligibilities] = await Promise.all([
    prisma.player.findMany({
      where: { id: { in: projectedIds } },
      select: {
        id: true,
        displayName: true,
        status: true,
        unsigned: true,
        dob: true,
        currentTeamId: true,
      },
    }),
    prisma.playerEligibility.findMany({
      where: { season, playerId: { in: projectedIds } },
      select: { playerId: true, position: true },
    }),
  ]);

  const eligibilityByPlayer = new Map<string, string[]>();
  for (const row of eligibilities) {
    const list = eligibilityByPlayer.get(row.playerId) ?? [];
    list.push(row.position);
    eligibilityByPlayer.set(row.playerId, list);
  }

  const metaByPlayer = new Map<string, EnginePlayerMeta>();
  const projectionLines: EngineProjection[] = [];
  for (const line of projections) {
    projectionLines.push(toEngineProjection(line));
    const playerRow = players.find((p) => p.id === line.playerId);
    if (!playerRow || metaByPlayer.has(line.playerId)) continue;
    metaByPlayer.set(line.playerId, {
      playerId: playerRow.id,
      displayName: playerRow.displayName,
      eligiblePositions: eligibilityByPlayer.get(playerRow.id) ?? [],
      status: playerRow.status,
      nbaTeamId: playerRow.currentTeamId ?? undefined,
      ...(ageAt(playerRow.dob) !== undefined ? { age: ageAt(playerRow.dob) } : {}),
    });
  }
  void players;

  // Only players with BOTH a projection line and metadata form the universe.
  const enginePlayers = [...metaByPlayer.values()];
  const engineProjections = projectionLines.filter((line) => metaByPlayer.has(line.playerId));

  const draftedAssignments: EngineAssignment[] = assignments.map((a) => ({
    playerId: a.playerId,
    teamSlot: a.teamSlot,
    slotPosition: a.slotPosition,
  }));

  const input: EngineInput = {
    settings,
    projectionRunId: currentRun.id,
    modelVersion: `${currentRun.model.modelKey}@${currentRun.model.version}`,
    projections: engineProjections,
    players: enginePlayers,
    adp: adpEntries.length > 0 ? adpEntries : null,
    draftedAssignments,
    nextOverallPick: draft.nextOverallPick,
    picksUntilUserTurn: picksUntilUserTurn(settings, draft.nextOverallPick),
    includeUnsigned: false,
    engineSeed: seedFromIds(draftId, currentRun.id),
  };

  const output = recommend(input);
  const latencyMs = Date.now() - started;

  // Identical inputs map to the SAME snapshot row by unique key — forced
  // recomputation of an unchanged board overwrites in place rather than
  // duplicating (immutable-by-checksum semantics).
  await prisma.recommendationSnapshot.upsert({
    where: {
      draftId_sequence_inputChecksum: {
        draftId,
        sequence: draft.currentSequence,
        inputChecksum: output.inputChecksum,
      },
    },
    update: { latencyMs, requestedAt: new Date() },
    create: {
      draftId,
      sequence: draft.currentSequence,
      userTeamSlot: output.userTeamSlot,
      engineVersion: output.engineVersion,
      inputChecksum: output.inputChecksum,
      latencyMs,
      payload: output as unknown as Prisma.InputJsonValue,
    },
  });
  await markOutboxProcessed(draftId, draft.currentSequence);

  return { output, latencyMs, cached: false };
}

/** Rate-limited forced recalculation (BUILD_SPEC section 8.2). A per-draft
 * cooldown enforced in Postgres keeps this honest without making anything
 * depend on Redis availability. */
export async function recalculateForOwner(
  draftId: string,
  ownerId: string,
): Promise<{ ok: boolean; retryAfterSeconds?: number }> {
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, ownerId },
    select: { id: true, updatedAt: true },
  });
  if (!draft) throw new DraftNotReadyError("draft not found");

  const recent = await prisma.recommendationSnapshot.count({
    where: {
      draftId,
      requestedAt: { gte: new Date(Date.now() - 30_000) },
    },
  });
  if (recent >= 4) return { ok: false, retryAfterSeconds: 30 };

  await getRecommendationsForOwner(draftId, ownerId, { force: true });
  return { ok: true };
}

async function markOutboxProcessed(draftId: string, sequence: number): Promise<void> {
  await prisma.draftOutbox.updateMany({
    where: { draftId, sequence: { lte: sequence }, processedAt: null },
    data: { processedAt: new Date() },
  });
}

async function latestAdpEntries(season: string): Promise<EngineAdpEntry[]> {
  const snapshot = await prisma.adpConsensusSnapshot.findFirst({
    where: { season },
    orderBy: { capturedAt: "desc" },
    select: {
      id: true,
      players: { take: 400, select: { playerId: true, consensusAdp: true, sourcesCount: true } },
    },
  });
  if (!snapshot) return [];
  return snapshot.players.map((entry, index) => ({
    playerId: entry.playerId,
    adp: entry.consensusAdp.toNumber(),
    rank: index + 1,
    sourcesCount: entry.sourcesCount,
  }));
}

function toEngineProjection(line: {
  playerId: string;
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
  lower80: unknown;
  upper80: unknown;
  injuryRisk: number;
  consistency: number;
  upside: number;
  roleSecurity: number;
}): EngineProjection {
  return {
    playerId: line.playerId,
    games: line.games,
    minutesPerGame: line.minutesPerGame,
    pts: line.pts,
    reb: line.reb,
    ast: line.ast,
    stl: line.stl,
    blk: line.blk,
    tov: line.tov,
    fgm: line.fgm,
    fga: line.fga,
    ftm: line.ftm,
    fta: line.fta,
    threePm: line.threePm,
    lower80: (line.lower80 ?? {}) as EngineProjection["lower80"],
    upper80: (line.upper80 ?? {}) as EngineProjection["upper80"],
    injuryRisk: line.injuryRisk,
    consistency: line.consistency,
    upside: line.upside,
    roleSecurity: line.roleSecurity,
  };
}

function ageAt(dob: Date | null): number | undefined {
  if (!dob) return undefined;
  const years = PROJECTION_AS_OF.getFullYear() - dob.getFullYear();
  return years > 0 && years < 60 ? years : undefined;
}

function picksUntilUserTurn(settings: EngineSettings, nextOverallPick: number): number {
  const total = settings.rounds * settings.teamCount;
  let count = 0;
  for (let pick = Math.max(1, nextOverallPick); pick <= total; pick++) {
    const round = Math.ceil(pick / settings.teamCount);
    const positionInRound = ((pick - 1) % settings.teamCount) + 1;
    const slot = round % 2 === 1 ? positionInRound : settings.teamCount + 1 - positionInRound;
    count += 1;
    if (slot === settings.userDraftSlot) return count;
  }
  return count;
}

function seedFromIds(draftId: string, runId: string): number {
  const combined = `${draftId}:${runId}`;
  let hash = 2166136261;
  for (let i = 0; i < combined.length; i++) {
    hash ^= combined.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
