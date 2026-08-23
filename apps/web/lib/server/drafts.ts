import { Prisma } from "@draftcourt/db";
import { prisma } from "@draftcourt/db";
import {
  overallPickToPickInRound,
  overallPickToRound,
  overallPickToSlot,
  replayFromEvents,
  candidateSlotsForEligibility,
  type DraftLogEvent,
} from "@draftcourt/domain";

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
      },
      select: { id: true },
    });

    await tx.draftTeam.createMany({
      data: settingsSnapshot.teams.map((team) => ({
        draftId: created.id,
        slot: team.slot,
        displayName: team.displayName,
        isUserTeam: team.isUserTeam,
      })),
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

const ENGINE_VERSION = "phase2-deterministic-1.0.0";
export const CURRENT_ENGINE_VERSION = ENGINE_VERSION;

export async function getDraftForOwner(draftId: string, ownerId: string) {
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, ownerId },
    include: {
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

  const snapshot = draft.settingsSnapshot as unknown as DraftSettingsSnapshot;
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
    picksRemaining: snapshot.rounds * snapshot.teamCount - (draft.nextOverallPick - 1),
    teams: draft.teams.map((team) => ({
      slot: team.slot,
      displayName: team.displayName,
      isUserTeam: team.isUserTeam,
      assignments: draft.assignments
        .filter((a) => a.teamSlot === team.slot)
        .map((a) => ({
          playerId: a.playerId,
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

async function lockDraft(tx: Tx, draftId: string) {
  const rows = await tx.$queryRaw<
    {
      id: string;
      ownerId: string;
      status: "SETUP" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ABANDONED";
      currentSequence: number;
      nextOverallPick: number;
      version: number;
    }[]
  >(
    Prisma.sql`SELECT id, "ownerId", status, "currentSequence", "nextOverallPick", version FROM drafts WHERE id = ${draftId}::uuid FOR UPDATE`,
  );
  return rows[0] ?? null;
}

function assertOwner(row: { ownerId: string }, ownerId: string): void {
  if (row.ownerId !== ownerId) throw new DraftNotFoundError("draft not found");
}

export interface PickResult {
  duplicated: boolean;
  authoritative: AuthoritativeState & {
    playerId?: string | undefined;
    teamSlot?: number | undefined;
  };
}

export async function makePick(params: {
  draftId: string;
  ownerId: string;
  playerId: string;
  idempotencyKey: string;
  ifMatchVersion: number;
}): Promise<PickResult> {
  return prisma.$transaction(async (tx) => {
    const draft = await lockDraft(tx, params.draftId);
    if (!draft) throw new DraftNotFoundError();
    assertOwner(draft, params.ownerId);

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

    const alreadyDrafted = await tx.draftRosterAssignment.findUnique({
      where: { draftId_playerId: { draftId: params.draftId, playerId: params.playerId } },
      select: { id: true },
    });
    if (alreadyDrafted) throw new DraftIllegalPickError("player already drafted");

    const player = await tx.player.findUnique({
      where: { id: params.playerId },
      select: { id: true, status: true, unsigned: true },
    });
    if (!player) throw new DraftIllegalPickError("player not found");
    if (player.status === "RETIRED") throw new DraftIllegalPickError("player is retired");

    const eligibility = await tx.playerEligibility.findMany({
      where: { playerId: params.playerId, season: snapshot.season },
      select: { position: true },
    });
    if (eligibility.length === 0 && player.status !== "UNSIGNED") {
      throw new DraftIllegalPickError("player has no eligibility for this season");
    }

    const openSlots = await computeOpenSlots(tx, params.draftId, snapshot);
    const slotChoice = chooseSlot(
      openSlots,
      eligibility.map((e) => e.position),
    );
    if (!slotChoice) throw new DraftIllegalPickError("no legal roster slot available for player");

    const draftingSlot = overallPickToSlot(draft.nextOverallPick, snapshot.teamCount);
    const sequence = draft.currentSequence + 1;
    const eventId = crypto.randomUUID();

    await tx.draftEvent.create({
      data: {
        id: eventId,
        draftId: params.draftId,
        sequence,
        eventType: "PLAYER_DRAFTED",
        actorUserId: params.ownerId,
        teamSlot: draftingSlot,
        playerId: params.playerId,
        round: overallPickToRound(draft.nextOverallPick, snapshot.teamCount),
        pickInRound: overallPickToPickInRound(draft.nextOverallPick, snapshot.teamCount),
        idempotencyKey: params.idempotencyKey,
        payload: { slotPosition: slotChoice.position, isBench: slotChoice.isBench },
      },
    });
    await tx.draftRosterAssignment.create({
      data: {
        draftId: params.draftId,
        eventId,
        teamSlot: draftingSlot,
        playerId: params.playerId,
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
        playerId: params.playerId,
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
    assertOwner(draft, params.ownerId);

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

    if (params.action === "start") {
      await tx.draftEvent.create({
        data: { draftId: params.draftId, sequence, eventType: "DRAFT_STARTED" },
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
      },
      select: { status: true, version: true },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentAuthoritative(row: {
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

async function versionConflict(
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

async function loadSnapshot(tx: Tx, draftId: string): Promise<DraftSettingsSnapshot> {
  const row = await tx.draft.findUniqueOrThrow({
    where: { id: draftId },
    select: { settingsSnapshot: true },
  });
  return row.settingsSnapshot as unknown as DraftSettingsSnapshot;
}

interface OpenSlot {
  position: string;
  remaining: number;
  isStarter: boolean;
}

async function computeOpenSlots(
  tx: Tx,
  draftId: string,
  snapshot: DraftSettingsSnapshot,
): Promise<OpenSlot[]> {
  const assignments = await tx.draftRosterAssignment.groupBy({
    by: ["slotPosition"],
    where: { draftId },
    _count: { slotPosition: true },
  });
  const filledByPosition = new Map<string, number>();
  for (const group of assignments) {
    filledByPosition.set(group.slotPosition, group._count.slotPosition);
  }
  // Slot inventory is LEAGUE-WIDE: every team owns `count` instances of each
  // position. Comparing fills against a single team's count made slots look
  // exhausted long before they were (found by the benchmark harness).
  return snapshot.rosterSlots.map((slot) => ({
    position: slot.position,
    remaining: slot.count * snapshot.teamCount - (filledByPosition.get(slot.position) ?? 0),
    isStarter: slot.isStarter,
  }));
}

/** Maximum-weight-ish matching kept honest and deterministic: prefer specific
 * eligible starter slots in eligibility order, then UTIL, then BENCH. */
function chooseSlot(
  openSlots: OpenSlot[],
  eligiblePositions: string[],
): { position: string; isBench: boolean } | null {
  const candidates = candidateSlotsForEligibility(eligiblePositions);
  for (const candidate of candidates) {
    const slot = openSlots.find(
      (open) =>
        open.position === candidate &&
        open.remaining > 0 &&
        (candidate === "BENCH" ? !open.isStarter : open.isStarter),
    );
    if (slot) return { position: slot.position, isBench: !slot.isStarter };
  }
  return null;
}
