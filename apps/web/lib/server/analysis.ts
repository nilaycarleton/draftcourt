/* eslint-disable @typescript-eslint/no-unnecessary-condition -- guarded filters, status checks, and finite guards */
import { prisma, type Prisma } from "@draftcourt/db";
import { replayFromEvents } from "@draftcourt/domain";
import {
  ANALYSIS_VERSION,
  canonicalize,
  checksumInput,
  analyzeDraft,
  type AnalysisInput,
  type AnalysisPlayerMeta,
  type AnalysisProjection,
  type AnalysisAdpEntry,
} from "@draftcourt/domain";
import { PROJECTION_AS_OF } from "./current-run";

export class AnalysisNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisNotReadyError";
  }
}
export class AnalysisNotFoundError extends Error {
  constructor(message = "draft not found") {
    super(message);
    this.name = "AnalysisNotFoundError";
  }
}

function ageAt(dob: Date | null, asOf: Date): number | undefined {
  if (!dob) return undefined;
  let age = asOf.getFullYear() - dob.getFullYear();
  const m = asOf.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && asOf.getDate() < dob.getDate())) age -= 1;
  return age > 0 && age < 60 ? age : undefined;
}

export async function getOrGenerateAnalysisForOwner(
  draftId: string,
  ownerId: string,
): Promise<{ analysis: unknown; cached: boolean }> {
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, ownerId },
    select: {
      id: true,
      ownerId: true,
      leagueId: true,
      type: true,
      status: true,
      version: true,
      currentSequence: true,
      nextOverallPick: true,
      engineVersion: true,
      settingsSnapshot: true,
      simulationSeed: true,
      projectionRunId: true,
      adpSnapshotId: true,
      preferenceSnapshot: true,
      preferenceSnapshotChecksum: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!draft) throw new AnalysisNotFoundError();
  if (draft.status !== "COMPLETED") {
    throw new AnalysisNotReadyError(`draft must be COMPLETED (is ${draft.status})`);
  }

  // Build deterministic input
  const snapshot = draft.settingsSnapshot as unknown as {
    season: string;
    type: string;
    horizon: string;
    teamCount: number;
    rounds: number;
    userDraftSlot: number;
    scoringRules: {
      stat: string;
      weight: number;
      direction: string;
      enabled: boolean;
      punt: boolean;
    }[];
    rosterSlots: { position: string; count: number; isStarter: boolean }[];
    teams: { slot: number; displayName: string; isUserTeam: boolean }[];
  };
  const totalPicks = snapshot.teamCount * snapshot.rounds;
  // Verify board full via authoritative check (nextOverallPick should be total+1)
  // If not full, still allow but mark degraded? Spec says incomplete drafts return not-ready.
  if (draft.nextOverallPick <= totalPicks) {
    throw new AnalysisNotReadyError("draft board not full");
  }

  // Load effective events and assignments
  const events = await prisma.draftEvent.findMany({
    where: { draftId },
    orderBy: { sequence: "asc" },
    select: {
      id: true,
      sequence: true,
      eventType: true,
      teamSlot: true,
      playerId: true,
      round: true,
      pickInRound: true,
      causationEventId: true,
      payload: true,
      createdAt: true,
    },
  });
  const log = events.map((e) => ({
    sequence: e.sequence,
    eventType: e.eventType,
    eventId: e.id,
    causationEventId: e.causationEventId,
    teamSlot: e.teamSlot,
    playerId: e.playerId,
    slotPosition: null as string | null,
    isBench: false,
    isKeeper: Boolean((e.payload as { keeper?: boolean } | null)?.keeper),
  }));
  // Validate replay integrity (without blocking generation)
  void replayFromEvents(log as never, snapshot.teamCount);
  // Build assignments with overallPick
  const assignmentsRaw = await prisma.draftRosterAssignment.findMany({
    where: { draftId },
    select: {
      playerId: true,
      teamSlot: true,
      slotPosition: true,
      isBench: true,
      isKeeper: true,
      eventId: true,
    },
  });
  // Map eventId -> overallPick via events
  const eventById = new Map(events.map((e) => [e.id, e]));
  const assignments: AnalysisInput["assignments"] = assignmentsRaw
    .map((a) => {
      const ev = eventById.get(a.eventId);
      // Derive overallPick from round/pickInRound if available
      const round = ev?.round ?? 1;
      const pickInRound = ev?.pickInRound ?? 1;
      const op = (round - 1) * snapshot.teamCount + pickInRound;
      return {
        playerId: a.playerId,
        teamSlot: a.teamSlot,
        slotPosition: a.slotPosition,
        overallPick: op,
        isBench: a.isBench,
        isKeeper: a.isKeeper,
      };
    })
    .sort((a, b) => a.overallPick - b.overallPick);

  // Load projections
  const projectionRunId = draft.projectionRunId;
  let projectionRun: {
    id: string;
    publishedAt: Date | null;
    modelKey: string;
    version: string;
  } | null = null;
  const projections: AnalysisProjection[] = [];
  const playersMeta: AnalysisPlayerMeta[] = [];
  let adp: AnalysisAdpEntry[] | null = null;

  if (projectionRunId) {
    const run = await prisma.projectionRun.findUnique({
      where: { id: projectionRunId },
      select: { id: true, publishedAt: true, model: { select: { modelKey: true, version: true } } },
    });
    if (run) {
      projectionRun = {
        id: run.id,
        publishedAt: run.publishedAt,
        modelKey: run.model.modelKey,
        version: run.model.version,
      };
      const projRows = await prisma.playerProjection.findMany({
        where: { runId: run.id },
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
      const playerIds = projRows.map((r) => r.playerId);
      const playerRows = await prisma.player.findMany({
        where: { id: { in: playerIds } },
        select: {
          id: true,
          displayName: true,
          status: true,
          unsigned: true,
          dob: true,
          currentTeamId: true,
        },
      });
      const eligibilities = await prisma.playerEligibility.findMany({
        where: { season: snapshot.season, playerId: { in: playerIds } },
        select: { playerId: true, position: true },
      });
      const eligByPlayer = new Map<string, string[]>();
      for (const e of eligibilities) {
        const arr = eligByPlayer.get(e.playerId) ?? [];
        arr.push(e.position);
        eligByPlayer.set(e.playerId, arr);
      }
      const playerById = new Map(playerRows.map((p) => [p.id, p]));
      for (const row of projRows) {
        const meta = playerById.get(row.playerId);
        if (!meta) continue;
        projections.push({
          playerId: row.playerId,
          games: row.games,
          minutesPerGame: row.minutesPerGame,
          pts: row.pts,
          reb: row.reb,
          ast: row.ast,
          stl: row.stl,
          blk: row.blk,
          tov: row.tov,
          fgm: row.fgm,
          fga: row.fga,
          ftm: row.ftm,
          fta: row.fta,
          threePm: row.threePm,
          lower80: (row.lower80 ?? {}) as Record<string, number>,
          upper80: (row.upper80 ?? {}) as Record<string, number>,
          injuryRisk: row.injuryRisk,
          consistency: row.consistency,
          upside: row.upside,
          roleSecurity: row.roleSecurity,
        });
        const age = ageAt(meta.dob, PROJECTION_AS_OF);
        playersMeta.push({
          playerId: meta.id,
          displayName: meta.displayName,
          eligiblePositions: eligByPlayer.get(meta.id) ?? [],
          status: meta.unsigned ? "UNSIGNED" : meta.status,
          nbaTeamId: meta.currentTeamId ?? undefined,
          ...(age !== undefined ? { age } : {}),
        });
      }
    }
  } else {
    // Fallback to current run if pinned missing (degraded, but still allow analysis with warning)
    const cur = await prisma.projectionRun.findFirst({
      where: { season: snapshot.season, isCurrent: true },
      select: { id: true, publishedAt: true, model: { select: { modelKey: true, version: true } } },
    });
    if (cur) {
      projectionRun = {
        id: cur.id,
        publishedAt: cur.publishedAt,
        modelKey: cur.model.modelKey,
        version: cur.model.version,
      };
    }
  }

  // ADP
  if (draft.adpSnapshotId) {
    const snap = await prisma.adpConsensusSnapshot.findUnique({
      where: { id: draft.adpSnapshotId },
      select: {
        id: true,
        capturedAt: true,
        players: { take: 500, select: { playerId: true, consensusAdp: true, sourcesCount: true } },
      },
    });
    if (snap) {
      adp = snap.players.map((p, idx) => ({
        playerId: p.playerId,
        adp: p.consensusAdp.toNumber(),
        rank: idx + 1,
        sourcesCount: p.sourcesCount,
      }));
    }
  }

  // Preference snapshot
  const prefSnap = draft.preferenceSnapshot as unknown as Record<string, unknown> | null;
  const prefChecksum = draft.preferenceSnapshotChecksum ?? null;

  // Check for existing cached analysis
  // Build input for checksum (exclude generatedAt)
  const simulationSeed = draft.simulationSeed ?? "analysis-default-seed";
  const inputForChecksum: Record<string, unknown> = {
    analysisVersion: ANALYSIS_VERSION,
    engineVersion: draft.engineVersion,
    settingsSnapshot: snapshot,
    assignments,
    projectionRunId: projectionRun?.id ?? null,
    adpSnapshotId: draft.adpSnapshotId ?? null,
    preferenceSnapshot: prefSnap,
    preferenceSnapshotChecksum: prefChecksum,
    simulationSeed,
    horizon: snapshot.horizon,
    type: snapshot.type,
  };
  const canonical = canonicalize(inputForChecksum);
  const inputChecksum = checksumInput(canonical);

  const existing = await prisma.draftAnalysis.findFirst({
    where: { draftId, analysisVersion: ANALYSIS_VERSION, inputChecksum },
    orderBy: { generatedAt: "desc" },
  });
  if (existing) {
    return { analysis: existing, cached: true };
  }

  // Build full AnalysisInput for engine
  const fullInput: AnalysisInput = {
    settings: {
      season: snapshot.season,
      type: snapshot.type as "POINTS" | "CATEGORIES",
      horizon: snapshot.horizon as "REDRAFT" | "KEEPER" | "DYNASTY",
      teamCount: snapshot.teamCount,
      rounds: snapshot.rounds,
      userDraftSlot: snapshot.userDraftSlot,
      scoringRules: snapshot.scoringRules,
      rosterSlots: snapshot.rosterSlots,
    },
    assignments,
    projections,
    players: playersMeta,
    adp,
    projectionRunId: projectionRun?.id ?? null,
    adpSnapshotId: draft.adpSnapshotId ?? null,
    preferenceSnapshot: prefSnap,
    engineVersion: draft.engineVersion,
    simulationSeed,
    analysisVersion: ANALYSIS_VERSION,
    userTeamSlot: snapshot.userDraftSlot,
  };

  // Run deterministic analysis (outside transaction for performance, then upsert)
  const result = analyzeDraft(fullInput) as unknown as Record<string, unknown>;
  const grade = (result.grade as string) ?? "F";
  const gradeScore =
    (result.gradeScore as number | undefined) ?? (result.draftScore as number | undefined) ?? 0;
  const gradeComponents = result.gradeComponents ?? result.components ?? [];
  const categoryStrengths = result.categoryStrengths ?? result.strengths ?? [];
  const positionStrengths = result.positionStrengths ?? result.weaknesses ?? [];
  const roundByRound = result.roundByRound ?? [];
  const bestValuePick = result.bestValuePick ?? null;
  const biggestReach = result.biggestReach ?? null;
  const projectedStanding = result.projectedStanding ?? { p50: 12, p90: 16, runs: 2000 };
  const categoryWinProbs = result.categoryWinProbs ?? null;
  const dataFreshness = result.dataFreshness ?? {
    projectionRunId: projectionRun?.id ?? null,
    adpSnapshotId: draft.adpSnapshotId ?? null,
    generatedAt: new Date().toISOString(),
    engineVersion: draft.engineVersion,
    analysisVersion: ANALYSIS_VERSION,
    inputChecksum,
    status: "LOW",
  };
  const assumptions = result.assumptions ?? [];

  // Persist with uniqueness guard
  try {
    const created = await prisma.draftAnalysis.create({
      data: {
        draftId,
        analysisVersion: ANALYSIS_VERSION,
        analysisVersionInt: 1,
        inputChecksum,
        engineVersion: draft.engineVersion,
        projectionRunId: projectionRun?.id ?? null,
        adpSnapshotId: draft.adpSnapshotId ?? null,
        preferenceSnapshotChecksum: prefChecksum,
        simulationSeed,
        grade,
        gradeScore: Number.isFinite(gradeScore) ? gradeScore : 0,
        gradeComponents: gradeComponents,
        assumptions: assumptions,
        categoryStrengths: categoryStrengths,
        positionStrengths: positionStrengths,
        roundByRound: roundByRound,
        bestValuePick: (bestValuePick ?? null) as unknown as Prisma.InputJsonValue,
        biggestReach: (biggestReach ?? null) as unknown as Prisma.InputJsonValue,
        projectedStanding: projectedStanding,
        categoryWinProbs: (categoryWinProbs ?? null) as unknown as Prisma.InputJsonValue,
        dataFreshness: dataFreshness,
      },
    });
    return { analysis: created, cached: false };
  } catch (e) {
    // Unique violation (P2002) -> concurrent winner, re-select
    if (e instanceof Error && (e as { code?: string }).code === "P2002") {
      const winner = await prisma.draftAnalysis.findFirst({
        where: { draftId, analysisVersion: ANALYSIS_VERSION, inputChecksum },
        orderBy: { generatedAt: "desc" },
      });
      if (winner) return { analysis: winner, cached: true };
    }
    throw e;
  }
}

// Helpers for history/analysis routes
export function canonicalizeAnalysisInput(input: Record<string, unknown>): string {
  return canonicalize(input);
}
