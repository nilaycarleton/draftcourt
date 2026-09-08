import { canonicalize, checksumInput } from "./recommendation";
import { overallPickToPickInRound, overallPickToRound } from "./draft";
import type { Position } from "./enums";

/**
 * Deterministic draft replay (ADR 0016 R1–R2, Phase 3E2 Milestone 1).
 *
 * Pure module: no framework, no database, no network, no wall-clock.
 * Replays the ordered `DraftEvent` log through any valid sequence number and
 * produces the effective board state at that point.
 *
 * Final-state output is intentionally byte-equal to
 * `draft.ts:replayFromEvents` for the same full input (differential-tested);
 * this module adds sequence slicing, validation, typed failures, actor
 * evidence, safe descriptions, and stable checksums — not a second
 * interpretation.
 */

export const REPLAY_VERSION = "1.0.0";

/** Hard bound so a corrupt or hostile log cannot hang the server or client. */
export const MAX_REPLAY_EVENTS = 5000;

export const KNOWN_REPLAY_EVENT_TYPES = [
  "DRAFT_STARTED",
  "PLAYER_DRAFTED",
  "PICK_UNDONE",
  "DRAFT_PAUSED",
  "DRAFT_RESUMED",
  "DRAFT_COMPLETED",
] as const;

export type KnownReplayEventType = (typeof KNOWN_REPLAY_EVENT_TYPES)[number];

export type ReplayActorType = "USER" | "CPU" | "SYSTEM";

export type ReplayErrorCode =
  | "MALFORMED_EVENT"
  | "GAP_IN_SEQUENCE"
  | "DUPLICATE_SEQUENCE"
  | "DUPLICATE_PLAYER"
  | "UNKNOWN_STATE_CHANGING_EVENT"
  | "ILLEGAL_SLOT"
  | "CORRUPT_UNDO_REFERENCE"
  | "EVENT_LIMIT_EXCEEDED"
  | "INVALID_TEAM_COUNT"
  | "INVALID_UPTO_SEQUENCE";

export class ReplayError extends Error {
  readonly code: ReplayErrorCode;
  constructor(code: ReplayErrorCode, message: string) {
    super(message);
    this.name = "ReplayError";
    this.code = code;
  }
}

/** Minimal historical event shape accepted by the replay reducer. Extra
 * database-only fields (UUIDs, timestamps) are ignored for state derivation
 * but preserved by callers for timeline display. */
export interface ReplayInputEvent {
  sequence: number;
  eventType: string;
  eventId: string;
  causationEventId: string | null;
  teamSlot: number | null;
  playerId: string | null;
  slotPosition: string | null;
  isBench: boolean;
  isKeeper: boolean;
  payload?: unknown;
}

export interface ReplaySelection {
  eventId: string;
  sequence: number;
  playerId: string;
  teamSlot: number;
  slotPosition: Position;
  isBench: boolean;
  isKeeper: boolean;
  overallPick: number;
  round: number;
  pickInRound: number;
}

export interface ReplayIntegrity {
  ok: boolean;
  detail: string;
}

export interface ReplayResult {
  selections: ReplaySelection[];
  picksByTeam: Record<number, number[]>;
  currentSequence: number;
  nextOverallPick: number;
  started: boolean;
  completed: boolean;
  paused: boolean;
  eventCount: number;
  checksum: string;
  integrity: ReplayIntegrity;
}

const VALID_SLOTS: ReadonlySet<string> = new Set([
  "PG",
  "SG",
  "SF",
  "PF",
  "C",
  "G",
  "F",
  "UTIL",
  "BENCH",
]);

function isKnownType(value: string): value is KnownReplayEventType {
  return (KNOWN_REPLAY_EVENT_TYPES as readonly string[]).includes(value);
}

function isValidSlot(value: string): value is Position {
  return VALID_SLOTS.has(value);
}

/** Actor evidence: CPU comes from explicit payload evidence, never from a
 * missing user id alone. Lifecycle markers are SYSTEM. */
export function actorOf(event: Pick<ReplayInputEvent, "eventType" | "payload">): ReplayActorType {
  const payload = event.payload as { cpuEvidence?: { cpu?: boolean }; cpu?: boolean } | null;
  if (payload !== null && typeof payload === "object") {
    const evidence = (payload as { cpuEvidence?: unknown }).cpuEvidence as
      { cpu?: unknown; actorType?: unknown } | null | undefined;
    if (typeof evidence === "object" && evidence !== null) {
      if (evidence.cpu === true || evidence.actorType === "CPU") return "CPU";
    }
    if ((payload as { cpu?: unknown }).cpu === true) return "CPU";
  }
  if (
    event.eventType === "DRAFT_STARTED" ||
    event.eventType === "DRAFT_PAUSED" ||
    event.eventType === "DRAFT_RESUMED" ||
    event.eventType === "DRAFT_COMPLETED"
  ) {
    return "SYSTEM";
  }
  return "USER";
}

/** Safe human-readable one-line description. Never includes PII, credentials,
 * or internal UUIDs — timeline UIs render names from a separate player map. */
export function describeReplayEvent(
  event: ReplayInputEvent,
  teamCount: number,
  overallPickForEvent?: number,
): string {
  const seq = `seq ${String(event.sequence)}`;
  switch (event.eventType) {
    case "DRAFT_STARTED":
      return `Draft started (${seq})`;
    case "DRAFT_PAUSED":
      return `Draft paused (${seq})`;
    case "DRAFT_RESUMED":
      return `Draft resumed (${seq})`;
    case "DRAFT_COMPLETED":
      return `Draft completed (${seq})`;
    case "PLAYER_DRAFTED": {
      const pick = overallPickForEvent ?? event.sequence;
      const round = overallPickToRound(pick, teamCount);
      const pickInRound = overallPickToPickInRound(pick, teamCount);
      const team = event.teamSlot ?? 0;
      const slot = event.slotPosition ?? "UTIL";
      const keeper = event.isKeeper ? " · keeper" : "";
      const actor = actorOf(event) === "CPU" ? " · CPU" : "";
      return `Pick ${String(pick)} (R${String(round)}P${String(pickInRound)}) · Team ${String(team)} · ${slot}${keeper}${actor} (${seq})`;
    }
    case "PICK_UNDONE":
      return `Pick undone (Team ${String(event.teamSlot ?? 0)}) (${seq})`;
    default:
      return `${event.eventType} (${seq})`;
  }
}

function validateInputs(
  events: readonly ReplayInputEvent[],
  teamCount: number,
  uptoSequence: number,
): void {
  if (!Number.isInteger(teamCount) || teamCount < 1 || teamCount > 30) {
    throw new ReplayError("INVALID_TEAM_COUNT", `invalid teamCount ${String(teamCount)}`);
  }
  if (!Number.isInteger(uptoSequence) || uptoSequence < 0) {
    throw new ReplayError("INVALID_UPTO_SEQUENCE", `invalid uptoSequence ${String(uptoSequence)}`);
  }
  if (events.length > MAX_REPLAY_EVENTS) {
    throw new ReplayError(
      "EVENT_LIMIT_EXCEEDED",
      `event log of ${String(events.length)} exceeds bound ${String(MAX_REPLAY_EVENTS)}`,
    );
  }
}

function coerceSlot(raw: string | null, eventId: string): Position {
  if (raw === null) return "UTIL";
  if (!isValidSlot(raw)) {
    throw new ReplayError("ILLEGAL_SLOT", `event ${eventId} has illegal slot ${raw}`);
  }
  return raw;
}

/**
 * Replays ordered events through `uptoSequence` (inclusive). Events with
 * higher sequences are ignored. Throws a typed `ReplayError` for malformed
 * or irreconcilable histories. Never mutates its input.
 */
export function replayToSequence(
  events: readonly ReplayInputEvent[],
  teamCount: number,
  uptoSequence: number,
): ReplayResult {
  validateInputs(events, teamCount, uptoSequence);

  const sliced = events.filter((e) => e.sequence <= uptoSequence).map((e) => ({ ...e }));
  sliced.sort((a, b) => a.sequence - b.sequence);

  // Structural validation: integer positive sequences, no duplicates, no gaps.
  const seen = new Set<number>();
  let expected: number | null = null;
  for (const event of sliced) {
    if (!Number.isInteger(event.sequence) || event.sequence < 1) {
      throw new ReplayError("MALFORMED_EVENT", `event ${event.eventId} has invalid sequence`);
    }
    if (typeof event.eventId !== "string" || event.eventId.length === 0) {
      throw new ReplayError("MALFORMED_EVENT", "event with empty eventId");
    }
    if (seen.has(event.sequence)) {
      throw new ReplayError("DUPLICATE_SEQUENCE", `duplicate sequence ${String(event.sequence)}`);
    }
    seen.add(event.sequence);
    if (expected !== null && event.sequence !== expected) {
      throw new ReplayError(
        "GAP_IN_SEQUENCE",
        `gap in event sequence: expected ${String(expected)} got ${String(event.sequence)}`,
      );
    }
    expected = event.sequence + 1;
    // First sliced event need not be sequence 1 when slicing from zero? No —
    // a full log always starts at 1. A slice starting above 1 is only valid
    // when the caller sliced a contiguous log; missing prefix is corruption.
    if (sliced[0]?.sequence !== undefined && sliced.indexOf(event) === 0 && event.sequence !== 1) {
      // Allow uptoSequence slicing that starts at 1 only; anything else means
      // the caller passed a log with a missing prefix.
      throw new ReplayError(
        "GAP_IN_SEQUENCE",
        `event log starts at sequence ${String(event.sequence)}, expected 1`,
      );
    }
    if (!isKnownType(event.eventType)) {
      const stateChanging =
        event.playerId !== null || event.causationEventId !== null || event.teamSlot !== null;
      if (stateChanging) {
        throw new ReplayError(
          "UNKNOWN_STATE_CHANGING_EVENT",
          `unknown event type ${event.eventType} carries state`,
        );
      }
      // Safe unknown marker: preserved for timeline display, ignored for state.
    }
  }

  // Sequential reduction (order matters: undo frees the player for later picks).
  const byEventId = new Map<string, ReplaySelection>();
  const activeByPlayer = new Map<string, ReplaySelection>();
  const picksByTeam = new Map<number, number[]>();
  let currentSequence = 0;
  let nextOverallPick = 1;
  let started = false;
  let completed = false;
  let paused = false;

  for (const event of sliced) {
    currentSequence = Math.max(currentSequence, event.sequence);
    if (!isKnownType(event.eventType)) continue;

    switch (event.eventType) {
      case "DRAFT_STARTED":
        started = true;
        break;
      case "DRAFT_PAUSED":
        paused = true;
        break;
      case "DRAFT_RESUMED":
        paused = false;
        break;
      case "DRAFT_COMPLETED":
        completed = true;
        paused = false;
        break;
      case "PLAYER_DRAFTED": {
        if (event.playerId === null || event.playerId.length === 0) {
          throw new ReplayError("MALFORMED_EVENT", `pick event ${event.eventId} missing playerId`);
        }
        if (event.teamSlot === null || !Number.isInteger(event.teamSlot) || event.teamSlot < 1) {
          throw new ReplayError("MALFORMED_EVENT", `pick event ${event.eventId} missing teamSlot`);
        }
        if (activeByPlayer.has(event.playerId)) {
          throw new ReplayError("DUPLICATE_PLAYER", `player ${event.playerId} already drafted`);
        }
        const slotPosition = coerceSlot(event.slotPosition, event.eventId);
        // NaN guard: overallPick/round math must stay finite.
        if (!Number.isFinite(nextOverallPick) || nextOverallPick < 1) {
          throw new ReplayError("MALFORMED_EVENT", "non-finite pick cursor");
        }
        const overallPick = nextOverallPick;
        const selection: ReplaySelection = {
          eventId: event.eventId,
          sequence: event.sequence,
          playerId: event.playerId,
          teamSlot: event.teamSlot,
          slotPosition,
          isBench: event.isBench,
          isKeeper: event.isKeeper,
          overallPick,
          round: overallPickToRound(overallPick, teamCount),
          pickInRound: overallPickToPickInRound(overallPick, teamCount),
        };
        activeByPlayer.set(event.playerId, selection);
        byEventId.set(event.eventId, selection);
        const list = picksByTeam.get(event.teamSlot) ?? [];
        list.push(overallPick);
        picksByTeam.set(event.teamSlot, list);
        nextOverallPick += 1;
        break;
      }
      case "PICK_UNDONE": {
        if (event.causationEventId === null || event.causationEventId.length === 0) {
          throw new ReplayError(
            "CORRUPT_UNDO_REFERENCE",
            `undo event ${event.eventId} missing causation reference`,
          );
        }
        const target = byEventId.get(event.causationEventId);
        if (!target) {
          throw new ReplayError(
            "CORRUPT_UNDO_REFERENCE",
            `undo event ${event.eventId} references unknown pick`,
          );
        }
        const active = activeByPlayer.get(target.playerId);
        if (active?.eventId !== target.eventId) {
          throw new ReplayError(
            "CORRUPT_UNDO_REFERENCE",
            `undo event ${event.eventId} references an already-undone pick`,
          );
        }
        activeByPlayer.delete(target.playerId);
        nextOverallPick = Math.max(1, nextOverallPick - 1);
        break;
      }
    }
  }

  const selections = [...activeByPlayer.values()].sort((a, b) => a.overallPick - b.overallPick);
  const picksRecord: Record<number, number[]> = {};
  for (const [slot, picks] of [...picksByTeam.entries()].sort((a, b) => a[0] - b[0])) {
    picksRecord[slot] = [...picks].sort((a, b) => a - b);
  }

  const checksum = replayChecksum({
    selections,
    nextOverallPick,
    currentSequence,
  });

  const count = String(selections.length);
  return {
    selections,
    picksByTeam: picksRecord,
    currentSequence,
    nextOverallPick,
    started,
    completed,
    paused,
    eventCount: sliced.length,
    checksum,
    integrity: { ok: true, detail: `${count} effective selections` },
  };
}

/** Full-log replay (sequence +Infinity equivalent: highest present sequence). */
export function replayFull(events: readonly ReplayInputEvent[], teamCount: number): ReplayResult {
  const max = events.length === 0 ? 0 : Math.max(...events.map((e) => e.sequence));
  return replayToSequence(events, teamCount, max);
}

/** Stable checksum for a replayed prefix. Sorts selections by overallPick,
 * canonicalizes with sorted keys, and hashes with SHA-256. */
export function replayChecksum(input: {
  selections: readonly ReplaySelection[];
  nextOverallPick: number;
  currentSequence: number;
}): string {
  const canonical = canonicalize({
    currentSequence: input.currentSequence,
    nextOverallPick: input.nextOverallPick,
    selections: [...input.selections]
      .sort((a, b) => a.overallPick - b.overallPick)
      .map((s) => ({
        currentSequence: undefined,
        eventId: undefined,
        isBench: s.isBench,
        isKeeper: s.isKeeper,
        overallPick: s.overallPick,
        playerId: s.playerId,
        slotPosition: s.slotPosition,
        teamSlot: s.teamSlot,
      })),
    version: REPLAY_VERSION,
  });
  return checksumInput(canonical);
}
