import { prisma } from "@draftcourt/db";
import {
  overallPickToSlot,
  parseCpuPersonalitySnapshot,
  selectCpuPick,
  type CpuPersonalitySnapshot,
} from "@draftcourt/domain";
import type {
  EngineAdpEntry,
  EnginePlayerMeta,
  EngineProjection,
  EngineSettings,
} from "@draftcourt/domain";
import { PROJECTION_AS_OF } from "./current-run";
import {
  DraftNotFoundError,
  DraftStatusError,
  DraftVersionConflict,
  makePick,
  type AuthoritativeState,
} from "./drafts";

/** Deterministic 32-bit FNV-1a over a string — derives the uint32 draftSeed
 * from the immutable simulation-seed code (ADR 0013). */
function fnv1a32(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const PROJECTION_AS_OF_YEAR = PROJECTION_AS_OF.getFullYear();

/**
 * CPU mock orchestration (Phase 3C, ADR 0013).
 *
 * One authoritative CPU pick per call. The decision is computed INSIDE the
 * pick transaction via makePick's `cpu` hook — the selector sees exactly the
 * locked state the validator will enforce. A caller-supplied version is used
 * exactly once, so concurrent requests cannot silently advance extra turns.
 */

export class CpuTurnError extends Error {
  constructor(
    message: string,
    readonly authoritative: AuthoritativeState,
  ) {
    super(message);
  }
}
export class CpuRateLimitedError extends Error {}

/** Per-user rolling-minute cap on CPU pick requests (audit-count pattern).
 * Sized above an instant-mode 12-team burst (~130 picks) so legitimate
 * auto-advance is never throttled while abuse stays bounded. */
const CPU_PICKS_PER_MINUTE = 240;

export async function assertCpuPickRate(userId: string): Promise<void> {
  const recent = await prisma.auditLog.count({
    where: {
      actorId: userId,
      action: "draft.cpuPick",
      createdAt: { gte: new Date(Date.now() - 60_000) },
    },
  });
  if (recent >= CPU_PICKS_PER_MINUTE) {
    throw new CpuRateLimitedError("CPU pick rate limit reached");
  }
}

interface LoadedDraft {
  id: string;
  ownerId: string | null;
  type: string;
  status: string;
  version: number;
  currentSequence: number;
  nextOverallPick: number;
  simulationSeed: string | null;
  projectionRunId: string | null;
  adpSnapshotId: string | null;
  settings: EngineSettings;
}

async function loadOwnedDraft(draftId: string, ownerId: string): Promise<LoadedDraft | null> {
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, ownerId },
    select: {
      id: true,
      ownerId: true,
      type: true,
      status: true,
      version: true,
      currentSequence: true,
      nextOverallPick: true,
      simulationSeed: true,
      projectionRunId: true,
      adpSnapshotId: true,
      settingsSnapshot: true,
    },
  });
  if (!draft) return null;
  return { ...draft, settings: draft.settingsSnapshot as unknown as EngineSettings };
}

/** Immutable personality snapshot for the team currently on the clock. */
async function loadTeamPersonality(
  draftId: string,
  teamSlot: number,
): Promise<CpuPersonalitySnapshot> {
  const team = await prisma.draftTeam.findUnique({
    where: { draftId_slot: { draftId, slot: teamSlot } },
    select: { cpuPersonalitySnapshot: true },
  });
  if (team?.cpuPersonalitySnapshot === null || team?.cpuPersonalitySnapshot === undefined) {
    throw new DraftStatusError("no CPU personality is configured for the team on the clock");
  }
  try {
    return parseCpuPersonalitySnapshot(team.cpuPersonalitySnapshot);
  } catch {
    throw new DraftStatusError("stored CPU personality snapshot failed validation");
  }
}

/** Projection/ADP/meta inputs for the decision — same universe rules as the
 * recommendation engine: the published projection run IS the player pool. */
async function loadSelectionInputs(
  settings: EngineSettings,
  projectionRunId: string,
  adpSnapshotId: string | null,
): Promise<{
  projections: EngineProjection[];
  players: EnginePlayerMeta[];
  adp: EngineAdpEntry[] | null;
  projectionRunId: string;
  modelVersion: string;
}> {
  const season = settings.season;
  const [currentRun, adpEntries] = await Promise.all([
    prisma.projectionRun.findFirst({
      where: { id: projectionRunId, season },
      select: { id: true, model: { select: { modelKey: true, version: true } } },
    }),
    adpSnapshotId === null ? Promise.resolve([]) : adpEntriesForSnapshot(adpSnapshotId),
  ]);
  if (!currentRun) throw new DraftStatusError("no published projection run for the season");

  const projections = await prisma.playerProjection.findMany({
    where: { runId: currentRun.id },
    // Explicit order (Phase 3F twin-draft determinism): engine inputs must
    // not depend on unspecified Postgres row-return order.
    orderBy: { playerId: "asc" },
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
      orderBy: { id: "asc" },
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
      orderBy: [{ playerId: "asc" }, { position: "asc" }],
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
      status: playerRow.unsigned ? "UNSIGNED" : playerRow.status,
      nbaTeamId: playerRow.currentTeamId ?? undefined,
      ...(ageAt(playerRow.dob) !== undefined ? { age: ageAt(playerRow.dob) } : {}),
    });
  }

  return {
    projections: projectionLines.filter((line) => metaByPlayer.has(line.playerId)),
    players: [...metaByPlayer.values()],
    adp: adpEntries.length > 0 ? adpEntries : null,
    projectionRunId: currentRun.id,
    modelVersion: `${currentRun.model.modelKey}@${currentRun.model.version}`,
  };
}

export interface CpuPickResult {
  pick: {
    playerId: string;
    displayName: string;
    slotPosition: string;
    isBench: boolean;
    sequence: number;
    duplicated: boolean;
  };
  evidence: {
    personalityKey: string;
    personalityVersion: number;
    decisionChecksum: string;
    decisionInputChecksum: string;
    selectionScore: number;
    decisionSeedHex: string;
  };
  authoritative: {
    version: number;
    status: string;
    currentSequence: number;
    nextOverallPick: number;
  };
}

/**
 * Executes ONE authoritative CPU pick through the shared transaction.
 * Throws (typed) when the draft does not qualify; races surface as the
 * standard conflict errors after bounded retries.
 */
export async function makeCpuPickForOwner(
  draftId: string,
  ownerId: string,
  idempotencyKey: string,
  ifMatchVersion: number,
): Promise<CpuPickResult> {
  const draft = await loadOwnedDraft(draftId, ownerId);
  if (!draft) throw new DraftNotFoundError();

  // Idempotent replay wins over status/turn/version checks after ownership is
  // established. A retry of the CPU pick that handed control to the user must
  // still return the recorded outcome instead of becoming a cpu-turn 409.
  const replay = await readCommittedCpuPick(draft, idempotencyKey, true);
  if (replay !== null) return replay;

  if (draft.type !== "MOCK") {
    throw new DraftStatusError("CPU picks are available only for MOCK drafts");
  }
  if (draft.simulationSeed === null || draft.projectionRunId === null) {
    throw new DraftStatusError("mock draft is missing immutable simulation inputs");
  }
  const simulationSeed = draft.simulationSeed;
  if (draft.status !== "ACTIVE") {
    throw new DraftStatusError(`CPU picks require an ACTIVE draft (is ${draft.status})`);
  }
  if (draft.version !== ifMatchVersion) {
    throw new DraftVersionConflict(
      "draft was modified concurrently — reconcile with the authoritative state below",
      authoritativeFromLoaded(draft),
    );
  }
  // Server-DERIVED picking team — the API accepts no team or player input.
  const pickingSlot = overallPickToSlot(draft.nextOverallPick, draft.settings.teamCount);
  if (pickingSlot === draft.settings.userDraftSlot) {
    throw new CpuTurnError(
      "it is the user's turn — CPU picks are not allowed now",
      authoritativeFromLoaded(draft),
    );
  }
  const personality = await loadTeamPersonality(draftId, pickingSlot);
  const inputs = await loadSelectionInputs(
    draft.settings,
    draft.projectionRunId,
    draft.adpSnapshotId,
  );

  const pickResult = await makePick({
    draftId,
    ownerId,
    idempotencyKey,
    ifMatchVersion,
    cpu: {
      personality,
      decide: (context) =>
        selectCpuPick({
          settings: {
            season: context.snapshot.season,
            type: context.snapshot.type,
            horizon: context.snapshot.horizon,
            teamCount: context.snapshot.teamCount,
            rounds: context.snapshot.rounds,
            userDraftSlot: context.snapshot.userDraftSlot,
            scoringRules: context.snapshot.scoringRules,
            rosterSlots: context.snapshot.rosterSlots,
          },
          projectionRunId: inputs.projectionRunId,
          modelVersion: inputs.modelVersion,
          projections: inputs.projections,
          players: inputs.players,
          adp: inputs.adp,
          assignments: context.assignments,
          currentTeamSlot: overallPickToSlot(context.nextOverallPick, context.snapshot.teamCount),
          nextOverallPick: context.nextOverallPick,
          personality,
          draftSeed: fnv1a32(simulationSeed),
          includeUnsigned: false,
        }),
    },
  });
  const committed = await loadOwnedDraft(draftId, ownerId);
  if (!committed) throw new DraftNotFoundError();
  const result = await readCommittedCpuPick(committed, idempotencyKey, pickResult.duplicated);
  if (result === null) throw new DraftStatusError("CPU pick committed without auditable evidence");
  return result;
}

function authoritativeFromLoaded(draft: LoadedDraft): AuthoritativeState {
  return {
    version: draft.version,
    status: draft.status,
    currentSequence: draft.currentSequence,
    nextOverallPick: draft.nextOverallPick,
  };
}

async function readCommittedCpuPick(
  draft: LoadedDraft,
  idempotencyKey: string,
  duplicated: boolean,
): Promise<CpuPickResult | null> {
  const event = await prisma.draftEvent.findUnique({
    where: { draftId_idempotencyKey: { draftId: draft.id, idempotencyKey } },
    select: { payload: true, sequence: true, playerId: true },
  });
  const payload = (event?.payload ?? {}) as {
    slotPosition?: string;
    isBench?: boolean;
    cpuEvidence?: {
      actorType?: string;
      personalityKey?: string;
      personalityVersion?: number;
      decisionInputChecksum?: string;
      decisionChecksum?: string;
      selectionScore?: number;
      decisionSeed?: string;
    };
  };
  if (
    event?.playerId === null ||
    event?.playerId === undefined ||
    payload.cpuEvidence?.actorType !== "CPU"
  ) {
    return null;
  }
  const displayName = await prisma.player
    .findUnique({ where: { id: event.playerId }, select: { displayName: true } })
    .then((row) => row?.displayName ?? "Unknown player");
  return {
    pick: {
      playerId: event.playerId,
      displayName,
      slotPosition: payload.slotPosition ?? "UTIL",
      isBench: payload.isBench ?? false,
      sequence: event.sequence,
      duplicated,
    },
    evidence: {
      personalityKey: payload.cpuEvidence.personalityKey ?? "unknown",
      personalityVersion: payload.cpuEvidence.personalityVersion ?? 0,
      decisionInputChecksum: payload.cpuEvidence.decisionInputChecksum ?? "",
      decisionChecksum: payload.cpuEvidence.decisionChecksum ?? "",
      selectionScore: payload.cpuEvidence.selectionScore ?? 0,
      decisionSeedHex: payload.cpuEvidence.decisionSeed ?? "",
    },
    authoritative: authoritativeFromLoaded(draft),
  };
}

// --- shared input helpers (mirrors recommendations.ts loading rules) --------

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
  const years = PROJECTION_AS_OF_YEAR - dob.getFullYear();
  return years > 0 && years < 60 ? years : undefined;
}

async function adpEntriesForSnapshot(snapshotId: string): Promise<EngineAdpEntry[]> {
  const snapshot = await prisma.adpConsensusSnapshot.findUnique({
    where: { id: snapshotId },
    select: {
      id: true,
      // Rank is assigned by position: return consensus-ADP order explicitly.
      players: {
        orderBy: [{ consensusAdp: "asc" }, { playerId: "asc" }],
        take: 400,
        select: { playerId: true, consensusAdp: true, sourcesCount: true },
      },
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
