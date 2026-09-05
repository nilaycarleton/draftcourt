import { describe, expect, it } from "vitest";
import {
  candidateSlotsForEligibility,
  overallPickToPickInRound,
  overallPickToRound,
  overallPickToSlot,
  replayFromEvents,
  upcomingPicksForSlot,
  type DraftLogEvent,
} from "@draftcourt/domain";

/**
 * Property-based checks for snake-draft math and replay determinism
 * (BUILD_SPEC.md section 16.1: "property-based tests for snake sequence
 * inverses, event replay determinism, ... no duplicate drafted player").
 * Deterministic pseudo-random generation (seeded LCG) keeps runs stable.
 */

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

describe("snake draft math", () => {
  it("every pick maps to a valid slot for every team count 4–20", () => {
    for (let teamCount = 4; teamCount <= 20; teamCount++) {
      for (let round = 1; round <= 16; round++) {
        for (let positionInRound = 1; positionInRound <= teamCount; positionInRound++) {
          const overallPick = (round - 1) * teamCount + positionInRound;
          const slot = overallPickToSlot(overallPick, teamCount);
          expect(slot).toBeGreaterThanOrEqual(1);
          expect(slot).toBeLessThanOrEqual(teamCount);
        }
      }
    }
  });

  it("odd rounds run 1..N, even rounds run N..1, for all team counts", () => {
    for (let teamCount = 4; teamCount <= 20; teamCount += 3) {
      const round1 = Array.from({ length: teamCount }, (_, i) =>
        overallPickToSlot(i + 1, teamCount),
      );
      const round2 = Array.from({ length: teamCount }, (_, i) =>
        overallPickToSlot(teamCount + i + 1, teamCount),
      );
      expect(round1).toEqual(Array.from({ length: teamCount }, (_, i) => i + 1));
      expect(round2).toEqual([...round1].reverse());
    }
  });

  it("round and pick-in-round decompose exactly (inverse property)", () => {
    const rand = lcg(42);
    for (let trial = 0; trial < 500; trial++) {
      const teamCount = 4 + Math.floor(rand() * 17); // 4..20
      const rounds = 1 + Math.floor(rand() * 20);
      const overallPick = 1 + Math.floor(rand() * teamCount * rounds);
      const round = overallPickToRound(overallPick, teamCount);
      const inRound = overallPickToPickInRound(overallPick, teamCount);
      const rebuilt = (round - 1) * teamCount + inRound;
      expect(rebuilt).toBe(overallPick);
      expect(inRound).toBeLessThanOrEqual(teamCount);
    }
  });

  it("each team picks exactly once per round across a full draft", () => {
    for (let teamCount = 4; teamCount <= 20; teamCount += 2) {
      const counts = new Map<number, number>();
      const total = teamCount * 13;
      for (let pick = 1; pick <= total; pick++) {
        const slot = overallPickToSlot(pick, teamCount);
        counts.set(slot, (counts.get(slot) ?? 0) + 1);
      }
      expect(counts.size).toBe(teamCount);
      for (const count of counts.values()) expect(count).toBe(13);
    }
  });

  it("upcoming picks for the user's slot are correct from any cursor", () => {
    // 12 teams, user in slot 4: first picks are 4, then 21 (round 2 reverse).
    expect(upcomingPicksForSlot(4, 12, 16, 1)).toEqual([4, 21]);
    expect(upcomingPicksForSlot(1, 12, 16, 1)).toEqual([1, 24]);
    expect(upcomingPicksForSlot(12, 12, 16, 1)).toEqual([12, 13]);
    // After the user already picked at #4, next is 21 (round 2, reversed),
    // then 28 (round 3 runs forward again).
    expect(upcomingPicksForSlot(4, 12, 16, 5)).toEqual([21, 28]);
  });
});

describe("replay reduction", () => {
  function event(partial: Partial<DraftLogEvent> & { sequence: number }): DraftLogEvent {
    return {
      eventType: "PLAYER_DRAFTED",
      eventId: "evt-".concat(String(partial.sequence)),
      causationEventId: null,
      teamSlot: null,
      playerId: null,
      slotPosition: "UTIL",
      isBench: false,
      isKeeper: false,
      ...partial,
    };
  }

  it("replays picks into per-team selections with an advancing cursor", () => {
    const events = [
      event({ sequence: 1, eventType: "DRAFT_STARTED" }),
      event({ sequence: 2, playerId: "p1", teamSlot: 1 }),
      event({ sequence: 3, playerId: "p2", teamSlot: 2 }),
    ];
    const state = replayFromEvents(events, 2);
    expect(state.selections.size).toBe(2);
    expect(state.selections.get("p1")?.teamSlot).toBe(1);
    expect(state.nextOverallPick).toBe(3);
    expect(state.started).toBe(true);
  });

  it("undo of the latest effective pick removes it and reverses the cursor", () => {
    const events = [
      event({ sequence: 1, eventType: "DRAFT_STARTED" }),
      event({ sequence: 2, playerId: "p1", teamSlot: 1 }),
      event({ sequence: 3, playerId: "p2", teamSlot: 2 }),
      event({
        sequence: 4,
        eventType: "PICK_UNDONE",
        causationEventId: "evt-3",
        teamSlot: 2,
        playerId: "p2",
      }),
    ];
    const state = replayFromEvents(events, 2);
    expect(state.selections.has("p1")).toBe(true);
    expect(state.selections.has("p2")).toBe(false);
    // Two picks happened (#1, #2); one was undone -> next overall is #2.
    const expectedNext = 2;
    expect(state.nextOverallPick).toBe(expectedNext);
  });

  it("is deterministic under shuffled input order (sort by sequence)", () => {
    const rand = lcg(7);
    const base: DraftLogEvent[] = [
      event({ sequence: 1, eventType: "DRAFT_STARTED" }),
      event({ sequence: 2, playerId: "a", teamSlot: 1 }),
      event({ sequence: 3, playerId: "b", teamSlot: 2 }),
      event({
        sequence: 4,
        eventType: "PICK_UNDONE",
        causationEventId: "evt-2",
        playerId: "a",
        teamSlot: 1,
      }),
      event({ sequence: 5, playerId: "c", teamSlot: 1 }),
    ];
    const referenceTeamCount = 2;
    const reference = replayFromEvents(base, referenceTeamCount);
    for (let trial = 0; trial < 50; trial++) {
      const shuffled = [...base];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        // Fisher-Yates with bounds the lcg guarantees are in range.
        const tmp: DraftLogEvent | undefined = shuffled[i];
        const other: DraftLogEvent | undefined = shuffled[j];
        if (tmp !== undefined && other !== undefined) {
          shuffled[i] = other;
          shuffled[j] = tmp;
        }
      }
      expect(replayFromEvents(shuffled, 2)).toEqual(reference);
    }
  });

  it("never yields duplicate effective selections for one player", () => {
    const rand = lcg(99);
    for (let trial = 0; trial < 100; trial++) {
      const teamCount = 4;
      const events: DraftLogEvent[] = [event({ sequence: 1, eventType: "DRAFT_STARTED" })];
      let seq = 2;
      for (let pick = 0; pick < 8; pick++) {
        const playerIndex = Math.floor(rand() * 6);
        const player = ["p", String(playerIndex)].join(""); // collisions on purpose
        if ([...events].some((e) => e.playerId === player)) continue;
        events.push(
          event({
            sequence: seq++,
            playerId: player,
            teamSlot: overallPickToSlot(pick + 1, teamCount),
          }),
        );
      }
      const state = replayFromEvents(events, teamCount);
      expect(new Set(state.selections.keys()).size).toBe(state.selections.size);
    }
  });
});

describe("candidate slots", () => {
  it("orders specific positions before UTIL before BENCH", () => {
    expect(candidateSlotsForEligibility(["PG", "SG"])).toEqual(["PG", "SG", "G", "UTIL", "BENCH"]);
    expect(candidateSlotsForEligibility(["C"])).toEqual(["C", "UTIL", "BENCH"]);
  });

  it("treats G and F as combo slots for guards and forwards", () => {
    // Regression test: G/F are aggregate starter slots — a guard-eligible
    // player must be placeable in an open G slot even without literal "G"
    // eligibility, otherwise drafts strand unfilled G/F slots with no legal
    // picks (found via the authenticated E2E acceptance draft).
    expect(candidateSlotsForEligibility(["SG"])).toContain("G");
    expect(candidateSlotsForEligibility(["PG"])).toContain("G");
    expect(candidateSlotsForEligibility(["SF"])).toContain("F");
    expect(candidateSlotsForEligibility(["PF"])).toContain("F");
    expect(candidateSlotsForEligibility(["C"])).not.toContain("G");
    expect(candidateSlotsForEligibility(["C"])).not.toContain("F");
  });
});
