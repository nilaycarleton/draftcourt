import type { Position } from "./enums";

/**
 * Snake-draft math and event-replay reduction (BUILD_SPEC.md sections 2.1,
 * 4.4, Phase 2 scope item 2). Pure functions only — no framework, no
 * database — so they are unit- and property-testable in isolation and can
 * run identically server-side and (later, for previews) client-side.
 */

/** Absolute overall pick number (1-based) -> drafting team slot. */
export function overallPickToSlot(overallPick: number, teamCount: number): number {
  const positionInRound = ((overallPick - 1) % teamCount) + 1;
  const round = Math.ceil(overallPick / teamCount);
  return round % 2 === 1 ? positionInRound : teamCount + 1 - positionInRound;
}

export function overallPickToRound(overallPick: number, teamCount: number): number {
  void teamCount;
  return Math.ceil(overallPick / teamCount);
}

export function overallPickToPickInRound(overallPick: number, teamCount: number): number {
  return ((overallPick - 1) % teamCount) + 1;
}

/** The overall pick numbers at which `userSlot` picks next, in order,
 * starting from `fromOverallPick` (inclusive). */
export function upcomingPicksForSlot(
  userSlot: number,
  teamCount: number,
  rounds: number,
  fromOverallPick: number,
  limit = 2,
): number[] {
  const picks: number[] = [];
  const total = rounds * teamCount;
  for (let pick = Math.max(fromOverallPick, 1); pick <= total && picks.length < limit; pick++) {
    if (overallPickToSlot(pick, teamCount) === userSlot) picks.push(pick);
  }
  return picks;
}

// ---------------------------------------------------------------------------
// Event log shape + deterministic replay reduction
// ---------------------------------------------------------------------------

export interface DraftLogEvent {
  sequence: number;
  eventType:
    | "DRAFT_STARTED"
    | "PLAYER_DRAFTED"
    | "PICK_UNDONE"
    | "DRAFT_PAUSED"
    | "DRAFT_RESUMED"
    | "DRAFT_COMPLETED";
  eventId: string;
  causationEventId: string | null;
  teamSlot: number | null;
  playerId: string | null;
  /** Roster slot chosen for the pick (resolved at append time). */
  slotPosition: Position | null;
  isBench: boolean;
  isKeeper: boolean;
}

export interface EffectiveSelection {
  eventId: string;
  teamSlot: number;
  slotPosition: Position;
  isBench: boolean;
  isKeeper: boolean;
  overallPick: number;
}

export interface ReplayState {
  /** Effective (non-undone) selections keyed by playerId. */
  selections: Map<string, EffectiveSelection>;
  /** Overall pick each team used, keyed by slot (for board rendering). */
  picksByTeam: Map<number, number[]>;
  currentSequence: number;
  nextOverallPick: number;
  started: boolean;
  completed: boolean;
}

/**
 * Deterministically rebuilds the materialized state from the full event log.
 * The database transaction maintains the same state incrementally; replay
 * MUST produce exactly the same result (property-tested), which is what
 * makes reload/restore and the divergence runbook trustworthy.
 *
 * A player is available iff their latest effective selection has not been
 * undone (BUILD_SPEC section 4.4). PICK_UNDONE removes the selection made
 * by its `causationEventId`.
 */
export function replayFromEvents(events: DraftLogEvent[], teamCount: number): ReplayState {
  const undone = new Set<string>(
    events
      .filter((e) => e.eventType === "PICK_UNDONE")
      .map((e) => e.causationEventId)
      .filter((id): id is string => id !== null),
  );

  const selections = new Map<string, EffectiveSelection>();
  const picksByTeam = new Map<number, number[]>();
  let currentSequence = 0;
  let nextOverallPick = 1;
  let started = false;
  let completed = false;

  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    currentSequence = Math.max(currentSequence, event.sequence);

    switch (event.eventType) {
      case "PLAYER_DRAFTED": {
        if (!event.playerId || undone.has(event.eventId)) break;
        const overallPick = nextOverallPick;
        selections.set(event.playerId, {
          eventId: event.eventId,
          teamSlot: event.teamSlot ?? 0,
          slotPosition: event.slotPosition ?? "UTIL",
          isBench: event.isBench,
          isKeeper: event.isKeeper,
          overallPick,
        });
        const list = picksByTeam.get(event.teamSlot ?? 0) ?? [];
        list.push(overallPick);
        picksByTeam.set(event.teamSlot ?? 0, list);
        nextOverallPick += 1;
        break;
      }
      case "PICK_UNDONE": {
        // The causation PLAYER_DRAFTED event was skipped via the `undone`
        // set above, so the cursor is already correct — nothing to reverse
        // here. (Phase 2 restricts undo to the LATEST effective pick;
        // append-time validation enforces that.)
        break;
      }
      case "DRAFT_STARTED":
        started = true;
        break;
      case "DRAFT_COMPLETED":
        completed = true;
        break;
      case "DRAFT_PAUSED":
      case "DRAFT_RESUMED":
        break;
    }
  }

  void teamCount;
  return { selections, picksByTeam, currentSequence, nextOverallPick, started, completed };
}

/**
 * Multi-position eligibility: given a player's eligible real positions and
 * the league's slot inventory, returns candidate slot positions ordered by
 * preference (specific > G/F hybrid > UTIL > BENCH). The caller resolves the
 * final choice against currently-open slots.
 */
export function candidateSlotsForEligibility(eligible: string[]): Position[] {
  const candidates: Position[] = [];
  for (const position of ["PG", "SG", "SF", "PF", "C", "G", "F"] as const) {
    if (eligible.includes(position)) candidates.push(position);
  }
  // UTIL accepts any player; BENCH is the final fallback.
  candidates.push("UTIL", "BENCH");
  return candidates;
}
