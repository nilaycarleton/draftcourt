import { Prisma } from "@draftcourt/db";
import { prisma } from "@draftcourt/db";
import {
  ENGINE_VERSION,
  overallPickToPickInRound,
  overallPickToRound,
  overallPickToSlot,
  replayFromEvents,
  candidateSlotsForEligibility,
  cpuPersonalityByKey,
  defaultCpuPersonalityKey,
  parseCpuPersonalitySnapshot,
  toCpuPersonalitySnapshot,
  type CpuDecision,
  type CpuPersonalitySnapshot,
  type DraftLogEvent,
} from "@draftcourt/domain";

/** Fail-closed personality read: malformed stored snapshots degrade to null
 * instead of crashing the room view. */
function parseCpuPersonalitySnapshotSafe(json: Prisma.JsonValue): CpuPersonalitySnapshot | null {
  try {
    return parseCpuPersonalitySnapshot(json);
  } catch {
    return null;
  }
}
import { buildSnapshotForStart, readStoredSnapshot } from "./preference-snapshot";

/**
 * Event-sourced draft core (BUILD_SPEC.md sections 4.2, 4.4; Phase 2 scope
 * item 2). Every mutation is ONE database transaction that:
 *
 *   1. locks the draft row (`SELECT … FOR UPDATE`),
 *   2. validates status + optimistic version (`If-Match`),
 *   3. appends the immutable event (unique `(draftId, sequence)` and
 *      `(draftId, idempotencyKey)`),
 *   4. updates the materialized roster read model,
 *   5. advances/reverses the snake cursor,
 *   6. increments the version, and
 *   7. writes a recommendation outbox request.
 *
 * Duplicate deliveries (same `Idempotency-Key`) replay the recorded outcome
 * instead of double-applying. Undo appends a compensating `PICK_UNDONE`
 * referencing the latest effective pick — events are never deleted or
 * rewritten anywhere in this file.
 */

export class DraftError extends Error {}
export class DraftNotFoundError extends DraftError {}
export class DraftStatusError extends DraftError {}
export class DraftIllegalPickError extends DraftError {}
export class DraftVersionConflict extends Error {
  constructor(
    message: string,
    readonly authoritative: AuthoritativeState,
  ) {
    super(message);
  }
}

export interface AuthoritativeState {
  version: number;
  status: string;
  currentSequence: number;
  nextOverallPick: number;
  [key: string]: unknown;
}

interface DraftSettingsSnapshot {
  season: string;
  type: "POINTS" | "CATEGORIES";
  horizon: "REDRAFT" | "KEEPER" | "DYNASTY";
  teamCount: number;
  rounds: number;
  userDraftSlot: number;
  playoffWeeks: number | null;
  scoringRules: {
    stat: string;
    weight: number;
    direction: string;
    enabled: boolean;
    punt: boolean;
  }[];
  rosterSlots: { position: string; count: number; isStarter: boolean }[];
  teams: { slot: number; displayName: string; isUserTeam: boolean }[];
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateDraftInput {
  leagueId: string;
  type?: "REAL" | "MOCK" | "DEMO";
  /** Retained keeper players: explicit pre-draft events (never hidden
   * mutations). Validated against the league's horizon. */
  keepers?: { playerId: string; teamSlot: number }[];
  /** Optional pre-start strategy override (Phase 3B). Must be an owned
   * profile; foreign ids resolve as not-found (no enumeration oracle). The
   * override is consumed once, when the draft starts. */
  overrideProfileId?: string | undefined;
  /** MOCK only: user-visible reproducibility code (ADR 0013). User-supplied
   * or server-generated at creation; immutable afterwards. */
  simulationSeed?: string | undefined;
  /** MOCK only: default CPU personality for every non-user team. Must be a
   * valid personality key. */
  cpuPersonalityKey?: string | undefined;
  /** MOCK only: per-team overrides (slot must be a non-user team slot). */
  teamPersonalities?: { teamSlot: number; personalityKey: string }[] | undefined;
}

const SEED_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function randomSimulationSeed(): string {
  // 12 chars of base36 from crypto randomness — unguessable enough for a
  // reproducibility code while staying copy/paste friendly.
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length] ?? "0";
  return out;
}

/** Resolves and validates the immutable CPU personality snapshot for one
 * non-user team (ADR 0013): unknown keys are rejected, snapshots are frozen
 * copies of the current versioned definition. */
function resolveCpuTeamSnapshot(key: string): {
  cpuStrategy: string;
  cpuPersonalitySnapshot: Prisma.InputJsonValue;
} {
  const definition = cpuPersonalityByKey(key);
  if (definition === undefined) {
    throw new DraftIllegalPickError(`unknown CPU personality "${key}"`);
  }
  if (!definition.supportedModes.includes("MOCK")) {
    throw new DraftIllegalPickError(
      `CPU personality "${key}" does not support authenticated mock drafts`,
    );
  }
  const snapshot = toCpuPersonalitySnapshot(definition);
  return {
    cpuStrategy: snapshot.key,
    cpuPersonalitySnapshot: snapshot as unknown as Prisma.InputJsonValue,
  };
}

export async function createDraft(
  ownerId: string,
  input: CreateDraftInput,
): Promise<{ id: string }> {
  const snapshotData = await prisma.league.findFirst({
    where: { id: input.leagueId, ownerId },
    select: {
      id: true,
      season: true,
      type: true,
      horizon: true,
      teamCount: true,
      rounds: true,
      userDraftSlot: true,
      playoffWeeks: true,
      activeSettingsVersionId: true,
      activeSettingsVersion: {
        select: {
          scoringRules: { orderBy: { statKey: "asc" } },
          rosterSlots: { orderBy: { position: "asc" } },
        },
      },
      teams: {
        orderBy: { slot: "asc" },
        select: { slot: true, displayName: true, isUserTeam: true },
      },
    },
  });
  if (!snapshotData?.activeSettingsVersion || !snapshotData.activeSettingsVersionId) {
    throw new DraftNotFoundError("league not found");
  }

  if (input.overrideProfileId !== undefined) {
    const profile = await prisma.preferenceProfile.findFirst({
      where: { id: input.overrideProfileId, ownerId },
      select: { id: true },
    });
    if (!profile) throw new DraftNotFoundError("override profile not found");
  }

  // Phase 3C mock configuration: validated BEFORE any write so a malformed
  // payload cannot create a half-configured draft.
  const isMock = (input.type ?? "REAL") === "MOCK";
  const mockConfig = (() => {
    if (!isMock) return null;
    const userTeams = snapshotData.teams.filter((team) => team.isUserTeam);
    if (userTeams.length !== 1) {
      throw new DraftIllegalPickError(
        "authenticated mock drafts require exactly one user-controlled team",
      );
    }
    const seed = (() => {
      if (input.simulationSeed === undefined) return randomSimulationSeed();
      if (!SEED_PATTERN.test(input.simulationSeed)) {
        throw new DraftIllegalPickError(
          "simulation seed must be 1-64 characters of letters, digits, or dashes",
        );
      }
      return input.simulationSeed;
    })();
    const defaultKey = input.cpuPersonalityKey ?? defaultCpuPersonalityKey;
    const overrides = new Map<number, string>();
    for (const override of input.teamPersonalities ?? []) {
      if (
        !Number.isInteger(override.teamSlot) ||
        override.teamSlot < 1 ||
        override.teamSlot > snapshotData.teamCount
      ) {
        throw new DraftIllegalPickError(`CPU team slot ${String(override.teamSlot)} out of range`);
      }
      if (overrides.has(override.teamSlot)) {
        throw new DraftIllegalPickError(
          `duplicate personality override for team ${String(override.teamSlot)}`,
        );
      }
      if (userTeams[0]?.slot === override.teamSlot) {
        throw new DraftIllegalPickError(
          "CPU personality metadata cannot be assigned to the user's team",
        );
      }
      overrides.set(override.teamSlot, override.personalityKey);
    }
    return { seed, defaultKey, overrides };
  })();

  // Freeze the data inputs a mock will use for every CPU decision. These
  // columns already existed for draft reproducibility; Phase 3C is the first
  // write path that makes them authoritative instead of repeatedly asking for
  // whatever projection/ADP run happens to be current later.
  const mockDataInputs =
    mockConfig === null
      ? null
      : await Promise.all([
          prisma.projectionRun.findFirst({
            where: { season: snapshotData.season, isCurrent: true },
            select: { id: true },
          }),
          prisma.adpConsensusSnapshot.findFirst({
            where: { season: snapshotData.season },
            orderBy: { capturedAt: "desc" },
            select: { id: true },
          }),
        ]);
  if (mockDataInputs !== null && mockDataInputs[0] === null) {
    throw new DraftStatusError("no published projection run exists for this mock draft season");
  }

  const settingsSnapshot: DraftSettingsSnapshot = {
    season: snapshotData.season,
    type: snapshotData.type,
    horizon: snapshotData.horizon,
    teamCount: snapshotData.teamCount,
    rounds: snapshotData.rounds,
    userDraftSlot: snapshotData.userDraftSlot,
    playoffWeeks: snapshotData.playoffWeeks,
    scoringRules: snapshotData.activeSettingsVersion.scoringRules.map((rule) => ({
      stat: rule.statKey,
      weight: rule.weight.toNumber(),
      direction: rule.direction,
      enabled: rule.enabled,
      punt: rule.punt,
    })),
    rosterSlots: snapshotData.activeSettingsVersion.rosterSlots.map((slot) => ({
      position: slot.position,
      count: slot.count,
      isStarter: slot.isStarter,
    })),
    teams: snapshotData.teams,
  };

  const keepers = input.keepers ?? [];
  validateKeepers(settingsSnapshot, keepers);

  return prisma.$transaction(async (tx) => {
    // Keeper retentions are immutable pre-draft events with real cursor +
    // roster effects, appended at creation before DRAFT_STARTED.
    let sequence = 0;
    const created = await tx.draft.create({
      data: {
        ownerId,
        leagueId: input.leagueId,
        type: input.type ?? "REAL",
        status: "SETUP",
        engineVersion: CURRENT_ENGINE_VERSION,
        settingsSnapshot: settingsSnapshot as unknown as Prisma.InputJsonValue,
        currentSequence: sequence,
        nextOverallPick: 1,
        version: 0,
        ...(input.overrideProfileId !== undefined
          ? { overrideProfileId: input.overrideProfileId }
          : {}),
        ...(mockConfig !== null ? { simulationSeed: mockConfig.seed } : {}),
        ...(mockDataInputs?.[0] !== null && mockDataInputs?.[0] !== undefined
          ? { projectionRunId: mockDataInputs[0].id }
          : {}),
        ...(mockDataInputs?.[1] !== null && mockDataInputs?.[1] !== undefined
          ? { adpSnapshotId: mockDataInputs[1].id }
          : {}),
      },
      select: { id: true },
    });

    await tx.draftTeam.createMany({
      data: settingsSnapshot.teams.map((team) => {
        // Immutable CPU personality snapshots for every non-user team of a
        // MOCK draft (ADR 0013). User teams and real drafts stay NULL.
        const cpu =
          mockConfig !== null && !team.isUserTeam
            ? resolveCpuTeamSnapshot(mockConfig.overrides.get(team.slot) ?? mockConfig.defaultKey)
            : null;
        return {
          draftId: created.id,
          slot: team.slot,
          displayName: team.displayName,
          isUserTeam: team.isUserTeam,
          ...(cpu ?? {}),
        };
      }),
    });

    for (const keeper of sortKeepersBySlot(keepers)) {
      sequence += 1;
      await appendKeeperEvent(tx, created.id, sequence, keeper, settingsSnapshot);
    }

    return { id: created.id };
  });
}

function sortKeepersBySlot(keepers: NonNullable<CreateDraftInput["keepers"]>) {
  return [...keepers].sort((a, b) => a.teamSlot - b.teamSlot);
}

function keeperCountLabel(value: number): string {
  return String(value);
}

function validateKeepers(
  snapshot: DraftSettingsSnapshot,
  keepers: NonNullable<CreateDraftInput["keepers"]>,
): void {
  if (keepers.length === 0) return;
  if (snapshot.horizon === "REDRAFT") {
    throw new DraftIllegalPickError("keeper players require a KEEPER or DYNASTY league");
  }
  const seenPlayers = new Set<string>();
  const perTeam = new Map<number, number>();
  const totalRoster = snapshot.rosterSlots.reduce((sum, s) => sum + s.count, 0);
  for (const keeper of keepers) {
    if (seenPlayers.has(keeper.playerId)) {
      throw new DraftIllegalPickError("duplicate keeper player");
    }
    seenPlayers.add(keeper.playerId);
    if (keeper.teamSlot < 1 || keeper.teamSlot > snapshot.teamCount) {
      throw new DraftIllegalPickError(
        `keeper teamSlot ${keeperCountLabel(keeper.teamSlot)} out of range`,
      );
    }
    const count = (perTeam.get(keeper.teamSlot) ?? 0) + 1;
    perTeam.set(keeper.teamSlot, count);
    if (count > Math.max(2, Math.floor(totalRoster / 3))) {
      throw new DraftIllegalPickError(
        `too many retained keepers for team ${keeperCountLabel(keeper.teamSlot)}`,
      );
    }
  }
}

async function appendKeeperEvent(
  tx: Tx,
  draftId: string,
  sequence: number,
  keeper: { playerId: string; teamSlot: number },
  snapshot: DraftSettingsSnapshot,
): Promise<void> {
  const player = await tx.player.findUnique({
    where: { id: keeper.playerId },
    select: { id: true },
  });
  if (!player) {
    throw new DraftIllegalPickError(`keeper player ${keeper.playerId} not found`);
  }
  const overallPick = sequence;
  const eventId = crypto.randomUUID();
  await tx.draftEvent.create({
    data: {
      id: eventId,
      draftId,
      sequence,
      eventType: "PLAYER_DRAFTED",
      teamSlot: keeper.teamSlot,
      playerId: keeper.playerId,
      round: overallPickToRound(overallPick, snapshot.teamCount),
      pickInRound: overallPickToPickInRound(overallPick, snapshot.teamCount),
      payload: { keeper: true, season: snapshot.season },
    },
  });
  await tx.draftRosterAssignment.create({
    data: {
      draftId,
      eventId,
      teamSlot: keeper.teamSlot,
      playerId: keeper.playerId,
      slotPosition: resolveKeeperSlot(snapshot),
      isBench: false,
      isKeeper: true,
      assignedAt: new Date(),
    },
  });
  await tx.draft.update({
    where: { id: draftId },
    data: { currentSequence: sequence, nextOverallPick: overallPick + 1 },
  });
}

/** Keepers occupy the first configured starter slot, else UTIL. */
function resolveKeeperSlot(snapshot: DraftSettingsSnapshot) {
  const firstStarter = snapshot.rosterSlots.find((slot) => slot.isStarter && slot.count > 0);
  const position = (firstStarter ? firstStarter.position : "UTIL") as never;
  return position;
}

// ---------------------------------------------------------------------------
// Read model + event listing
// ---------------------------------------------------------------------------

// The engine version is imported from @draftcourt/domain so the value stamped
// onto new drafts and the version recorded in recommendation outputs can never
// drift (a mismatch would permanently defeat the warm-cache guard).
export const CURRENT_ENGINE_VERSION = ENGINE_VERSION;

export async function getDraftForOwner(draftId: string, ownerId: string) {
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, ownerId },
    select: {
      id: true,
      leagueId: true,
      type: true,
      status: true,
      version: true,
      currentSequence: true,
      nextOverallPick: true,
      engineVersion: true,
      settingsSnapshot: true,
      overrideProfileId: true,
      preferenceSnapshot: true,
      preferenceSnapshotVersion: true,
      preferenceSnapshotChecksum: true,
      preferenceSourceProfileId: true,
      simulationSeed: true,
      teams: { orderBy: { slot: "asc" } },
      assignments: {
        include: {
          event: { select: { sequence: true, round: true, pickInRound: true } },
        },
        orderBy: [{ teamSlot: "asc" }],
      },
    },
  });
  if (!draft) return null;

  // Display names for every drafted player in one query — the visual board
  // and roster panels need them; bare ids are meaningless to humans.
  const playerIds = [...new Set(draft.assignments.map((a) => a.playerId))];
  const players = playerIds.length
    ? await prisma.player.findMany({
        where: { id: { in: playerIds } },
        select: { id: true, displayName: true },
      })
    : [];
  const playerNameById = new Map(players.map((p) => [p.id, p.displayName]));

  const snapshot = draft.settingsSnapshot as unknown as DraftSettingsSnapshot;

  // Strategy evidence (Phase 3B): parsed from the immutable stored snapshot.
  // "invalid" marks a tampered/legacy-incompatible payload honestly instead of
  // crashing the room; "none" covers drafts started before Phase 3B.
  let strategy: DraftStrategyEvidenceView | null = null;
  if (draft.preferenceSnapshot != null) {
    try {
      const evidence = readStoredSnapshot(draft.preferenceSnapshot);
      if (evidence) {
        strategy = {
          status: "OK",
          source: {
            kind: evidence.snapshot.source.kind,
            profileId: evidence.snapshot.source.profileId,
            profileName: evidence.snapshot.source.profileName,
            presetKey: evidence.snapshot.source.presetKey,
            presetVersion: evidence.snapshot.source.presetVersion,
          },
          snapshotVersion: evidence.snapshot.snapshotVersion,
          preferenceSchemaVersion: evidence.snapshot.preferenceSchemaVersion,
          checksum: draft.preferenceSnapshotChecksum ?? evidence.checksum,
          capturedAt: evidence.snapshot.capturedAt,
          engineVersion: draft.engineVersion,
          settingsSummary: {
            topFactors: Object.entries(evidence.snapshot.settings.factorWeights)
              .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
              .slice(0, 4)
              .map(([key, weight]) => ({ key, weight })),
            punts: [...evidence.snapshot.settings.puntStats].sort(),
            avoidMode: evidence.snapshot.settings.avoidMode,
            scheduleEnabled: evidence.snapshot.settings.schedule.enabled,
            favoritePlayers: evidence.snapshot.playerEntries.filter(
              (entry) => entry.listType === "FAVORITE",
            ).length,
            dislikedPlayers: evidence.snapshot.playerEntries.filter(
              (entry) => entry.listType === "DISLIKED",
            ).length,
            targetPlayers: evidence.snapshot.playerEntries.filter(
              (entry) => entry.listType === "TARGET",
            ).length,
            avoidedPlayers: evidence.snapshot.playerEntries.filter(
              (entry) => entry.listType === "AVOID",
            ).length,
            teamPreferences: evidence.snapshot.teamEntries.length,
            customRanks:
              evidence.snapshot.customRanks.league.length +
              evidence.snapshot.customRanks.global.length,
          },
        };
      }
    } catch {
      strategy = {
        status: "INVALID",
        source: {
          kind: "DRAFTCOURT_DEFAULTS",
          profileId: null,
          profileName: null,
          presetKey: null,
          presetVersion: null,
        },
        snapshotVersion: null,
        preferenceSchemaVersion: null,
        checksum: null,
        capturedAt: null,
        engineVersion: draft.engineVersion,
        settingsSummary: null,
      };
    }
  }

  return {
    id: draft.id,
    leagueId: draft.leagueId,
    type: draft.type,
    status: draft.status,
    version: draft.version,
    currentSequence: draft.currentSequence,
    nextOverallPick: draft.nextOverallPick,
    engineVersion: draft.engineVersion,
    settingsSnapshot: snapshot,
    overrideProfileId: draft.overrideProfileId,
    // Phase 3C mock view: present ONLY for MOCK drafts. Personality keys are
    // read from the immutable snapshots (fail-closed parse; a malformed
    // snapshot degrades to null rather than crashing the room).
    mock:
      draft.type !== "MOCK"
        ? null
        : {
            simSeed: draft.simulationSeed,
            teams: draft.teams.map((team) => {
              let personalityKey: string | null = null;
              if (team.cpuPersonalitySnapshot !== null) {
                const parsed = parseCpuPersonalitySnapshotSafe(team.cpuPersonalitySnapshot);
                personalityKey = parsed?.key ?? null;
              }
              return {
                slot: team.slot,
                displayName: team.displayName,
                isUserTeam: team.isUserTeam,
                personalityKey,
              };
            }),
          },
    strategy,
    picksRemaining: snapshot.rounds * snapshot.teamCount - (draft.nextOverallPick - 1),
    teams: draft.teams.map((team) => ({
      slot: team.slot,
      displayName: team.displayName,
      isUserTeam: team.isUserTeam,
      assignments: draft.assignments
        .filter((a) => a.teamSlot === team.slot)
        .map((a) => ({
          playerId: a.playerId,
          playerName: playerNameById.get(a.playerId) ?? "Unknown player",
          slotPosition: a.slotPosition,
          isBench: a.isBench,
          isKeeper: a.isKeeper,
          sequence: a.event.sequence,
          round: a.event.round,
          pickInRound: a.event.pickInRound,
        })),
    })),
    boardSize: snapshot.rounds * snapshot.teamCount,
  };
}

export interface DraftStrategyEvidenceView {
  status: "OK" | "INVALID";
  source: {
    kind: string;
    profileId: string | null;
    profileName: string | null;
    presetKey: string | null;
    presetVersion: number | null;
  };
  snapshotVersion: number | null;
  preferenceSchemaVersion: number | null;
  checksum: string | null;
  capturedAt: string | null;
  engineVersion: string;
  settingsSummary: {
    topFactors: { key: string; weight: number }[];
    punts: string[];
    avoidMode: "EXCLUDE" | "SEVERE_PENALTY";
    scheduleEnabled: boolean;
    favoritePlayers: number;
    dislikedPlayers: number;
    targetPlayers: number;
    avoidedPlayers: number;
    teamPreferences: number;
    customRanks: number;
  } | null;
}

export async function listEventsForOwner(draftId: string, ownerId: string) {
  const owned = await prisma.draft.findFirst({
    where: { id: draftId, ownerId },
    select: { id: true },
  });
  if (!owned) return null;
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
  return { events };
}

/** Rebuilds state purely from the event log and compares it to the stored
 * materialized rows — the divergence check behind the replay runbook. */
export async function verifyReplayIntegrity(
  draftId: string,
): Promise<{ ok: boolean; detail: string }> {
  const draft = await prisma.draft.findUniqueOrThrow({
    where: { id: draftId },
    select: { currentSequence: true, nextOverallPick: true },
  });
  const events = await prisma.draftEvent.findMany({
    where: { draftId },
    orderBy: { sequence: "asc" },
    select: {
      id: true,
      sequence: true,
      eventType: true,
      causationEventId: true,
      teamSlot: true,
      playerId: true,
      payload: true,
    },
  });
  const log: DraftLogEvent[] = events.map((e) => ({
    sequence: e.sequence,
    eventType: e.eventType,
    eventId: e.id,
    causationEventId: e.causationEventId,
    teamSlot: e.teamSlot,
    playerId: e.playerId,
    slotPosition: null,
    isBench: false,
    isKeeper: Boolean((e.payload as { keeper?: boolean } | null | undefined)?.keeper),
  }));
  const replayed = replayFromEvents(log, 12); // teamCount only used for metadata here

  const rows = await prisma.draftRosterAssignment.count({ where: { draftId } });
  const replayedCount = replayed.selections.size;
  if (rows !== replayedCount) {
    const rowsLabel = String(rows);
    const replayedLabel = String(replayedCount);
    return { ok: false, detail: `assignment rows ${rowsLabel} != replayed ${replayedLabel}` };
  }
  if (replayed.currentSequence !== draft.currentSequence) {
    return { ok: false, detail: "sequence divergence between events and draft row" };
  }
  const countLabel = String(replayedCount);
  return { ok: true, detail: `${countLabel} effective selections` };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function lockDraft(tx: Tx, draftId: string) {
  const rows = await tx.$queryRaw<
    {
      id: string;
      ownerId: string | null;
      leagueId: string | null;
      overrideProfileId: string | null;
      status: "SETUP" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ABANDONED";
      currentSequence: number;
      nextOverallPick: number;
      version: number;
      type: "REAL" | "MOCK" | "DEMO";
    }[]
  >(
    Prisma.sql`SELECT id, "ownerId", "leagueId", "overrideProfileId", type, status, "currentSequence", "nextOverallPick", version FROM drafts WHERE id = ${draftId}::uuid FOR UPDATE`,
  );
  return rows[0] ?? null;
}

function assertOwner(row: { ownerId: string | null }, ownerId: string): void {
  if (row.ownerId !== ownerId) throw new DraftNotFoundError("draft not found");
}

export interface PickResult {
  duplicated: boolean;
  authoritative: AuthoritativeState & {
    playerId?: string | undefined;
    teamSlot?: number | undefined;
  };
}

/** Optional CPU-decision hook (ADR 0013): when provided, the picking player
 * is resolved INSIDE the locked transaction from authoritative state, so a
 * CPU pick sees exactly what the validator will see. The personality snapshot
 * rides along so event evidence is complete without re-parsing team rows. */
export interface CpuPickContext {
  snapshot: DraftSettingsSnapshot;
  /** ALL effective selections (including keepers), by slot. */
  assignments: { playerId: string; teamSlot: number; slotPosition: string }[];
  nextOverallPick: number;
}

export interface CpuPickParams {
  personality: CpuPersonalitySnapshot;
  decide: (context: CpuPickContext) => CpuDecision;
}

export async function makePick(params: {
  draftId: string;
  ownerId: string;
  playerId?: string | undefined;
  idempotencyKey: string;
  ifMatchVersion: number;
  cpu?: CpuPickParams | undefined;
}): Promise<PickResult> {
  if (params.playerId === undefined && params.cpu === undefined) {
    throw new DraftIllegalPickError("pick requires a player or a CPU decision provider");
  }
  return prisma.$transaction(async (tx) => {
    const draft = await lockDraft(tx, params.draftId);
    if (!draft) throw new DraftNotFoundError();
    // DEMO drafts are capability-authorized (ownerId null); skip owner check for DEMO.
    if (draft.type !== "DEMO") {
      assertOwner(draft, params.ownerId);
    } else if (draft.ownerId !== null) {
      assertOwner(draft, params.ownerId);
    }

    // Duplicate delivery replays the recorded outcome (idempotent).
    const existing = await tx.draftEvent.findUnique({
      where: {
        draftId_idempotencyKey: { draftId: params.draftId, idempotencyKey: params.idempotencyKey },
      },
      select: { playerId: true, teamSlot: true, sequence: true },
    });
    if (existing) {
      return {
        duplicated: true,
        authoritative: {
          playerId: existing.playerId ?? undefined,
          teamSlot: existing.teamSlot ?? undefined,
          ...currentAuthoritative(draft),
        },
      };
    }

    if (draft.status !== "ACTIVE") {
      const statusNow: string = draft.status;
      throw new DraftStatusError(`draft must be ACTIVE to accept picks (is ${statusNow})`);
    }
    if (draft.version !== params.ifMatchVersion) {
      throw await versionConflict(tx, params.draftId, draft.version);
    }

    const snapshot = await loadSnapshot(tx, params.draftId);
    const boardFull = draft.nextOverallPick > snapshot.rounds * snapshot.teamCount;
    if (boardFull) throw new DraftStatusError("draft board is complete");

    // Phase 3C: resolve the CPU decision against the LOCKED state. The
    // decision seed derives from effective state only, so races re-decide
    // correctly and undo restores identical decisions.
    let cpuEvidence: Prisma.InputJsonValue | null = null;
    let resolvedPlayerId = params.playerId;
    if (params.cpu !== undefined) {
      const assignments = await tx.draftRosterAssignment.findMany({
        where: { draftId: params.draftId },
        select: { playerId: true, teamSlot: true, slotPosition: true },
      });
      const decision = params.cpu.decide({
        snapshot,
        assignments,
        nextOverallPick: draft.nextOverallPick,
      });
      if (!decision.ok) {
        throw new DraftStatusError(`CPU selection failed: ${decision.failure.message}`);
      }
      const draftingTeamNow = overallPickToSlot(draft.nextOverallPick, snapshot.teamCount);
      if (draftingTeamNow === snapshot.userDraftSlot) {
        throw new DraftStatusError("CPU cannot pick for the user's team");
      }
      resolvedPlayerId = decision.playerId;
      cpuEvidence = {
        cpu: true,
        actorType: "CPU",
        personalityKey: params.cpu.personality.key,
        personalityVersion: params.cpu.personality.version,
        seedStrategyVersion: params.cpu.personality.seedStrategyVersion,
        decisionSeed: decision.evidence.pickSeedHex,
        decisionInputChecksum: decision.inputChecksum,
        decisionChecksum: decision.decisionChecksum,
        selectionScore: Math.round(decision.score * 10000) / 10000,
      };
    }
    if (resolvedPlayerId === undefined) {
      throw new DraftIllegalPickError("pick requires a player or a CPU decision provider");
    }

    const alreadyDrafted = await tx.draftRosterAssignment.findUnique({
      where: { draftId_playerId: { draftId: params.draftId, playerId: resolvedPlayerId } },
      select: { id: true },
    });
    if (alreadyDrafted) throw new DraftIllegalPickError("player already drafted");

    const player = await tx.player.findUnique({
      where: { id: resolvedPlayerId },
      select: { id: true, status: true, unsigned: true },
    });
    if (!player) throw new DraftIllegalPickError("player not found");
    if (player.status === "RETIRED") throw new DraftIllegalPickError("player is retired");
    if (cpuEvidence !== null && (player.status === "UNSIGNED" || player.unsigned)) {
      throw new DraftIllegalPickError("CPU unsigned-player policy excludes this player");
    }

    const eligibility = await tx.playerEligibility.findMany({
      where: { playerId: resolvedPlayerId, season: snapshot.season },
      select: { position: true },
    });
    if (eligibility.length === 0 && player.status !== "UNSIGNED") {
      throw new DraftIllegalPickError("player has no eligibility for this season");
    }

    const draftingSlot = overallPickToSlot(draft.nextOverallPick, snapshot.teamCount);
    if (draft.type === "MOCK" && cpuEvidence === null && draftingSlot !== snapshot.userDraftSlot) {
      throw new DraftStatusError("the CPU-controlled team is on the clock");
    }
    const openSlots = await computeOpenSlots(tx, params.draftId, draftingSlot, snapshot);
    const slotChoice = chooseSlot(
      openSlots,
      eligibility.map((e) => e.position),
    );
    if (!slotChoice) throw new DraftIllegalPickError("no legal roster slot available for player");

    const sequence = draft.currentSequence + 1;
    const eventId = crypto.randomUUID();

    await tx.draftEvent.create({
      data: {
        id: eventId,
        draftId: params.draftId,
        sequence,
        eventType: "PLAYER_DRAFTED",
        // CPU picks carry explicit payload evidence instead of a user actor —
        // actor status is never inferred from a missing user id alone.
        ...(cpuEvidence !== null ? {} : { actorUserId: params.ownerId }),
        teamSlot: draftingSlot,
        playerId: resolvedPlayerId,
        round: overallPickToRound(draft.nextOverallPick, snapshot.teamCount),
        pickInRound: overallPickToPickInRound(draft.nextOverallPick, snapshot.teamCount),
        idempotencyKey: params.idempotencyKey,
        payload: {
          slotPosition: slotChoice.position,
          isBench: slotChoice.isBench,
          ...(cpuEvidence !== null ? { cpuEvidence } : {}),
        },
      },
    });
    await tx.draftRosterAssignment.create({
      data: {
        draftId: params.draftId,
        eventId,
        teamSlot: draftingSlot,
        playerId: resolvedPlayerId,
        slotPosition: slotChoice.position as never,
        isBench: slotChoice.isBench,
        assignedAt: new Date(),
      },
    });
    await tx.draftOutbox.create({
      data: {
        draftId: params.draftId,
        kind: "RECOMMENDATION",
        sequence,
        payload: { userTeamSlot: snapshot.userDraftSlot },
      },
    });
    const updated = await tx.draft.update({
      where: { id: params.draftId },
      data: {
        currentSequence: sequence,
        nextOverallPick: draft.nextOverallPick + 1,
        version: draft.version + 1,
      },
      select: { status: true, currentSequence: true, nextOverallPick: true, version: true },
    });

    return {
      duplicated: false,
      authoritative: {
        ...updated,
        playerId: resolvedPlayerId,
        teamSlot: draftingSlot,
      },
    };
  });
}

export async function undoPick(params: {
  draftId: string;
  ownerId: string;
  idempotencyKey: string;
  ifMatchVersion: number;
}): Promise<PickResult> {
  return prisma.$transaction(async (tx) => {
    const draft = await lockDraft(tx, params.draftId);
    if (!draft) throw new DraftNotFoundError();
    if (draft.type !== "DEMO") {
      assertOwner(draft, params.ownerId);
    } else if (draft.ownerId !== null) {
      assertOwner(draft, params.ownerId);
    }

    const existing = await tx.draftEvent.findUnique({
      where: {
        draftId_idempotencyKey: { draftId: params.draftId, idempotencyKey: params.idempotencyKey },
      },
      select: { sequence: true, causationEventId: true },
    });
    if (existing) {
      return {
        duplicated: true,
        authoritative: currentAuthoritative(draft),
      };
    }

    if (draft.status !== "ACTIVE" && draft.status !== "PAUSED") {
      throw new DraftStatusError(`undo requires ACTIVE or PAUSED (is ${draft.status})`);
    }
    if (draft.version !== params.ifMatchVersion) {
      throw await versionConflict(tx, params.draftId, draft.version);
    }

    // Latest EFFECTIVE pick: last PLAYER_DRAFTED not referenced by an undo.
    const undoneIds = await tx.draftEvent.findMany({
      where: { draftId: params.draftId, eventType: "PICK_UNDONE" },
      select: { causationEventId: true },
    });
    const undoneSet = new Set(undoneIds.map((u) => u.causationEventId));
    const recentPicks = await tx.draftEvent.findMany({
      where: { draftId: params.draftId, eventType: "PLAYER_DRAFTED" },
      orderBy: { sequence: "desc" },
      take: 10,
      select: { id: true, playerId: true, teamSlot: true, sequence: true, payload: true },
    });
    // Phase 2: only the LATEST EFFECTIVE pick may be undone, and keeper
    // pre-draft events are never undo targets.
    const candidates = recentPicks.filter(
      (c) => !undoneSet.has(c.id) && (c.payload as { keeper?: boolean } | null)?.keeper !== true,
    );
    const target = candidates[0];
    if (!target) throw new DraftStatusError("no effective pick to undo");

    const sequence = draft.currentSequence + 1;
    await tx.draftEvent.create({
      data: {
        draftId: params.draftId,
        sequence,
        eventType: "PICK_UNDONE",
        actorUserId: params.ownerId,
        teamSlot: target.teamSlot,
        playerId: target.playerId,
        causationEventId: target.id,
        idempotencyKey: params.idempotencyKey,
      },
    });
    if (!target.playerId) throw new DraftStatusError("corrupt pick event: missing player");
    await tx.draftRosterAssignment.delete({
      where: { draftId_playerId: { draftId: params.draftId, playerId: target.playerId } },
    });
    await tx.draftOutbox.create({
      data: { draftId: params.draftId, kind: "RECOMMENDATION", sequence },
    });
    const updated = await tx.draft.update({
      where: { id: params.draftId },
      data: {
        currentSequence: sequence,
        nextOverallPick: Math.max(1, draft.nextOverallPick - 1),
        version: draft.version + 1,
      },
      select: { status: true, currentSequence: true, nextOverallPick: true, version: true },
    });
    return { duplicated: false, authoritative: updated };
  });
}

export async function transitionStatus(params: {
  draftId: string;
  ownerId: string;
  action: "start" | "pause" | "resume" | "complete" | "abandon";
}): Promise<{ status: string; version: number }> {
  return prisma.$transaction(async (tx) => {
    const draft = await lockDraft(tx, params.draftId);
    if (!draft) throw new DraftNotFoundError();
    assertOwner(draft, params.ownerId);

    const allowed: Record<string, string[]> = {
      start: ["SETUP"],
      pause: ["ACTIVE"],
      resume: ["PAUSED"],
      complete: ["ACTIVE"],
      abandon: ["SETUP", "ACTIVE", "PAUSED"],
    };
    const permitted = allowed[params.action] ?? [];
    if (!permitted.includes(draft.status)) {
      throw new DraftStatusError(`cannot ${params.action} from status ${draft.status}`);
    }

    const snapshot = await loadSnapshot(tx, params.draftId);
    const sequence = draft.currentSequence + 1;

    // Phase 3B: resolve the effective strategy ONCE, inside the authoritative
    // start transaction (ADR 0012). The snapshot is self-contained — later
    // profile edits can never affect this draft. Malformed stored settings
    // fail closed HERE, before DRAFT_STARTED is appended.
    let captured: {
      preferenceSnapshot: Prisma.InputJsonValue;
      preferenceSnapshotVersion: number;
      preferenceSnapshotChecksum: string;
      preferenceSourceProfileId: string | null;
      engineVersion: string;
    } | null = null;
    if (params.action === "start") {
      if (!draft.leagueId) throw new DraftStatusError("leagueId missing for start");
      const league = await tx.league.findUnique({
        where: { id: draft.leagueId },
        select: { preferredProfileId: true },
      });
      const { snapshot: prefSnapshot, checksum } = await buildSnapshotForStart(tx, {
        ownerId: params.ownerId,
        leagueId: draft.leagueId,
        leaguePreferredProfileId: league?.preferredProfileId ?? null,
        overrideProfileId: draft.overrideProfileId,
      });
      captured = {
        preferenceSnapshot: prefSnapshot as unknown as Prisma.InputJsonValue,
        preferenceSnapshotVersion: prefSnapshot.snapshotVersion,
        preferenceSnapshotChecksum: checksum,
        preferenceSourceProfileId: prefSnapshot.source.profileId,
        // Heal the engine-version stamp at the moment strategy is captured so
        // a draft created before an engine bump but started after it stays
        // cache-coherent (stored rows will carry the current version).
        engineVersion: CURRENT_ENGINE_VERSION,
      };
      await tx.draftEvent.create({
        data: {
          draftId: params.draftId,
          sequence,
          eventType: "DRAFT_STARTED",
          payload: {
            preferenceSnapshotVersion: prefSnapshot.snapshotVersion,
            preferenceSnapshotChecksum: checksum,
            strategySource: prefSnapshot.source.kind,
          },
        },
      });
    } else if (params.action === "pause") {
      await tx.draftEvent.create({
        data: { draftId: params.draftId, sequence, eventType: "DRAFT_PAUSED" },
      });
    } else if (params.action === "resume") {
      await tx.draftEvent.create({
        data: { draftId: params.draftId, sequence, eventType: "DRAFT_RESUMED" },
      });
    } else if (params.action === "complete") {
      const total = snapshot.rounds * snapshot.teamCount;
      const filled = draft.nextOverallPick - 1;
      if (filled < total) {
        const unfilled = String(total - filled);
        throw new DraftStatusError(`cannot complete: board has ${unfilled} unfilled slots`);
      }
      await tx.draftEvent.create({
        data: { draftId: params.draftId, sequence, eventType: "DRAFT_COMPLETED" },
      });
    }

    const nextStatus = (
      {
        start: "ACTIVE",
        pause: "PAUSED",
        resume: "ACTIVE",
        complete: "COMPLETED",
        abandon: "ABANDONED",
      } as const
    )[params.action];

    const updated = await tx.draft.update({
      where: { id: params.draftId },
      data: {
        status: nextStatus,
        currentSequence: sequence,
        version: draft.version + 1,
        ...(captured ?? {}),
      },
      select: { status: true, version: true },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function currentAuthoritative(row: {
  status: string;
  currentSequence: number;
  nextOverallPick: number;
  version: number;
}): AuthoritativeState {
  return {
    status: row.status,
    currentSequence: row.currentSequence,
    nextOverallPick: row.nextOverallPick,
    version: row.version,
  };
}

export async function versionConflict(
  tx: Tx,
  draftId: string,
  _presented: number,
): Promise<DraftVersionConflict> {
  const fresh = await tx.draft.findUniqueOrThrow({
    where: { id: draftId },
    select: { status: true, currentSequence: true, nextOverallPick: true, version: true },
  });
  void _presented;
  return new DraftVersionConflict(
    "draft was modified concurrently — reconcile with the authoritative state below",
    fresh,
  );
}

export async function loadSnapshot(tx: Tx, draftId: string): Promise<DraftSettingsSnapshot> {
  const row = await tx.draft.findUniqueOrThrow({
    where: { id: draftId },
    select: { settingsSnapshot: true },
  });
  return row.settingsSnapshot as unknown as DraftSettingsSnapshot;
}

interface OpenSlot {
  position: string;
  leagueRemaining: number;
  teamRemaining: number;
  isStarter: boolean;
}

export async function computeOpenSlots(
  tx: Tx,
  draftId: string,
  teamSlot: number,
  snapshot: DraftSettingsSnapshot,
): Promise<OpenSlot[]> {
  const assignments = await tx.draftRosterAssignment.groupBy({
    by: ["teamSlot", "slotPosition"],
    where: { draftId },
    _count: { slotPosition: true },
  });
  const leagueFilledByPosition = new Map<string, number>();
  const teamFilledByPosition = new Map<string, number>();
  for (const group of assignments) {
    leagueFilledByPosition.set(
      group.slotPosition,
      (leagueFilledByPosition.get(group.slotPosition) ?? 0) + group._count.slotPosition,
    );
    if (group.teamSlot === teamSlot) {
      teamFilledByPosition.set(group.slotPosition, group._count.slotPosition);
    }
  }
  // Slot inventory is LEAGUE-WIDE: every team owns `count` instances of each
  // position. Comparing fills against a single team's count made slots look
  // exhausted long before they were (found by the benchmark harness).
  return snapshot.rosterSlots.map((slot) => ({
    position: slot.position,
    leagueRemaining:
      slot.count * snapshot.teamCount - (leagueFilledByPosition.get(slot.position) ?? 0),
    teamRemaining: slot.count - (teamFilledByPosition.get(slot.position) ?? 0),
    isStarter: slot.isStarter,
  }));
}

/** Maximum-weight-ish matching kept honest and deterministic: prefer specific
 * eligible starter slots in eligibility order, then UTIL, then BENCH. */
export function chooseSlot(
  openSlots: OpenSlot[],
  eligiblePositions: string[],
): { position: string; isBench: boolean } | null {
  const candidates = candidateSlotsForEligibility(eligiblePositions);
  for (const candidate of candidates) {
    const slot = openSlots.find(
      (open) =>
        open.position === candidate &&
        open.leagueRemaining > 0 &&
        open.teamRemaining > 0 &&
        (candidate === "BENCH" ? !open.isStarter : open.isStarter),
    );
    if (slot) return { position: slot.position, isBench: !slot.isStarter };
  }
  return null;
}
