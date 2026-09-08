import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  MAX_REPLAY_EVENTS,
  REPLAY_VERSION,
  ReplayError,
  actorOf,
  describeReplayEvent,
  replayChecksum,
  replayFull,
  replayToSequence,
  type ReplayInputEvent,
} from "./replay";
import { replayFromEvents, type DraftLogEvent } from "./draft";

function pick(
  sequence: number,
  eventId: string,
  playerId: string,
  teamSlot: number,
  extra: Partial<ReplayInputEvent> = {},
): ReplayInputEvent {
  return {
    sequence,
    eventType: "PLAYER_DRAFTED",
    eventId,
    causationEventId: null,
    teamSlot,
    playerId,
    slotPosition: "UTIL",
    isBench: false,
    isKeeper: false,
    ...extra,
  };
}

function lifecycle(sequence: number, eventId: string, eventType: string): ReplayInputEvent {
  return {
    sequence,
    eventType,
    eventId,
    causationEventId: null,
    teamSlot: null,
    playerId: null,
    slotPosition: null,
    isBench: false,
    isKeeper: false,
  };
}

describe("replay reducer — deterministic history", () => {
  it("exposes version 1.0.0", () => {
    expect(REPLAY_VERSION).toBe("1.0.0");
  });

  it("empty drafts replay to the initial state", () => {
    const result = replayFull([], 12);
    expect(result.selections).toEqual([]);
    expect(result.nextOverallPick).toBe(1);
    expect(result.currentSequence).toBe(0);
    expect(result.started).toBe(false);
    expect(result.completed).toBe(false);
    expect(result.integrity.ok).toBe(true);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replays snake numbering with round/pick evidence", () => {
    const events = [
      lifecycle(1, "start", "DRAFT_STARTED"),
      pick(2, "e1", "p1", 1),
      pick(3, "e2", "p2", 2),
    ];
    const result = replayFull(events, 4);
    expect(result.selections.map((s) => s.overallPick)).toEqual([1, 2]);
    expect(result.selections[0]).toMatchObject({ round: 1, pickInRound: 1, teamSlot: 1 });
    expect(result.selections[1]).toMatchObject({ round: 1, pickInRound: 2, teamSlot: 2 });
    expect(result.nextOverallPick).toBe(3);
  });

  it("every intermediate sequence is deterministic", () => {
    const events = [
      lifecycle(1, "start", "DRAFT_STARTED"),
      pick(2, "e1", "p1", 1),
      pick(3, "e2", "p2", 2),
      pick(4, "e3", "p3", 3),
    ];
    for (const upto of [1, 2, 3, 4]) {
      const a = replayToSequence(events, 4, upto);
      const b = replayToSequence(events, 4, upto);
      expect(a.checksum).toBe(b.checksum);
      expect(a.selections).toEqual(b.selections);
    }
    expect(replayToSequence(events, 4, 2).selections).toHaveLength(1);
    expect(replayToSequence(events, 4, 3).selections).toHaveLength(2);
  });

  it("undo removes only the compensated pick and supports alternate history", () => {
    const events = [
      lifecycle(1, "start", "DRAFT_STARTED"),
      pick(2, "e1", "p1", 1),
      pick(3, "e2", "p2", 2),
      {
        sequence: 4,
        eventType: "PICK_UNDONE",
        eventId: "u1",
        causationEventId: "e2",
        teamSlot: 2,
        playerId: "p2",
        slotPosition: null,
        isBench: false,
        isKeeper: false,
      } satisfies ReplayInputEvent,
    ];
    const undone = replayFull(events, 4);
    expect(undone.selections.map((s) => s.playerId)).toEqual(["p1"]);
    expect(undone.nextOverallPick).toBe(2);

    const alternate = replayFull([...events, pick(5, "e3", "p3", 2)], 4);
    expect(alternate.selections.map((s) => s.playerId).sort()).toEqual(["p1", "p3"]);
    expect(alternate.selections.find((s) => s.playerId === "p3")?.overallPick).toBe(2);
  });

  it("duplicate effective players fail with typed errors (no silent duplication)", () => {
    const events = [
      lifecycle(1, "start", "DRAFT_STARTED"),
      pick(2, "e1", "p1", 1),
      pick(3, "e2", "p1", 2),
    ];
    expect(() => replayFull(events, 4)).toThrow(ReplayError);
    try {
      replayFull(events, 4);
    } catch (error) {
      expect((error as ReplayError).code).toBe("DUPLICATE_PLAYER");
    }
  });

  it("re-drafting an undone player is legal (freed availability)", () => {
    const events: ReplayInputEvent[] = [
      lifecycle(1, "start", "DRAFT_STARTED"),
      pick(2, "e1", "p1", 1),
      {
        sequence: 3,
        eventType: "PICK_UNDONE",
        eventId: "u1",
        causationEventId: "e1",
        teamSlot: 1,
        playerId: "p1",
        slotPosition: null,
        isBench: false,
        isKeeper: false,
      },
      pick(4, "e2", "p1", 2),
    ];
    const result = replayFull(events, 4);
    expect(result.selections).toHaveLength(1);
    expect(result.selections[0]?.teamSlot).toBe(2);
  });

  it("keeper picks are preserved with evidence", () => {
    const events = [
      pick(1, "k1", "keeper1", 2, { isKeeper: true, slotPosition: "PG" }),
      lifecycle(2, "start", "DRAFT_STARTED"),
      pick(3, "e1", "p1", 1),
    ];
    const result = replayFull(events, 4);
    expect(result.selections.find((s) => s.playerId === "keeper1")?.isKeeper).toBe(true);
    expect(result.selections.find((s) => s.playerId === "keeper1")?.slotPosition).toBe("PG");
  });

  it("pause/resume/completion lifecycle is tracked without changing picks", () => {
    const events = [
      lifecycle(1, "start", "DRAFT_STARTED"),
      pick(2, "e1", "p1", 1),
      lifecycle(3, "pause", "DRAFT_PAUSED"),
      lifecycle(4, "resume", "DRAFT_RESUMED"),
      lifecycle(5, "done", "DRAFT_COMPLETED"),
    ];
    const result = replayFull(events, 4);
    expect(result.started).toBe(true);
    expect(result.paused).toBe(false);
    expect(result.completed).toBe(true);
    expect(result.selections).toHaveLength(1);
    expect(replayToSequence(events, 4, 3).paused).toBe(true);
  });

  it("CPU actor evidence is explicit", () => {
    const cpu = pick(2, "e1", "p1", 2, {
      payload: { cpuEvidence: { cpu: true, actorType: "CPU", personalityKey: "balanced" } },
    });
    expect(actorOf(cpu)).toBe("CPU");
    expect(actorOf(lifecycle(1, "s", "DRAFT_STARTED"))).toBe("SYSTEM");
    expect(actorOf(pick(2, "e", "p", 1))).toBe("USER");
  });

  it("safe unknown events are preserved; state-changing unknowns fail", () => {
    const safe: ReplayInputEvent[] = [
      lifecycle(1, "start", "DRAFT_STARTED"),
      { ...lifecycle(2, "x", "FUTURE_MARKER"), eventType: "FUTURE_MARKER" },
    ];
    expect(replayFull(safe, 4).currentSequence).toBe(2);
    const unsafe: ReplayInputEvent[] = [
      lifecycle(1, "start", "DRAFT_STARTED"),
      {
        ...lifecycle(2, "x", "FUTURE_PICK"),
        eventType: "FUTURE_PICK",
        playerId: "p9",
        teamSlot: 1,
      },
    ];
    expect(() => replayFull(unsafe, 4)).toThrow(ReplayError);
  });

  it("malformed histories return typed failures", () => {
    expect(() => replayFull([pick(2, "e", "p", 1)], 4)).toThrow(ReplayError); // gap at start
    expect(() =>
      replayFull([lifecycle(1, "a", "DRAFT_STARTED"), lifecycle(1, "b", "DRAFT_PAUSED")], 4),
    ).toThrow(ReplayError);
    expect(() =>
      replayFull([lifecycle(1, "a", "DRAFT_STARTED"), lifecycle(3, "b", "DRAFT_PAUSED")], 4),
    ).toThrow(ReplayError);
    expect(() =>
      replayFull(
        [lifecycle(1, "a", "DRAFT_STARTED"), pick(2, "e", "p", 1, { slotPosition: "QB" })],
        4,
      ),
    ).toThrow(ReplayError);
    expect(() => replayToSequence([lifecycle(1, "a", "DRAFT_STARTED")], 4, -1)).toThrow(
      ReplayError,
    );
    expect(() => replayFull([lifecycle(1, "a", "DRAFT_STARTED")], 0)).toThrow(ReplayError);
  });

  it("corrupt undo references fail safely", () => {
    const missing: ReplayInputEvent[] = [
      lifecycle(1, "start", "DRAFT_STARTED"),
      {
        sequence: 2,
        eventType: "PICK_UNDONE",
        eventId: "u",
        causationEventId: "nope",
        teamSlot: 1,
        playerId: "p1",
        slotPosition: null,
        isBench: false,
        isKeeper: false,
      },
    ];
    expect(() => replayFull(missing, 4)).toThrow(ReplayError);
  });

  it("large streams stay bounded", () => {
    const events: ReplayInputEvent[] = [lifecycle(1, "s", "DRAFT_STARTED")];
    for (let i = 0; i < 400; i++) {
      events.push(pick(i + 2, `e${String(i)}`, `p${String(i)}`, (i % 4) + 1));
    }
    const result = replayFull(events, 4);
    expect(result.selections).toHaveLength(400);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    const tooMany: ReplayInputEvent[] = Array.from({ length: MAX_REPLAY_EVENTS + 1 }, (_, i) =>
      lifecycle(i + 1, `e${String(i)}`, "DRAFT_PAUSED"),
    );
    expect(() => replayFull(tooMany, 4)).toThrow(ReplayError);
  });

  it("descriptions are safe (no ids beyond sequence markers)", () => {
    const text = describeReplayEvent(pick(2, "secret-id", "secret-player", 1), 4, 1);
    expect(text).toContain("Pick 1");
    expect(text).not.toContain("secret-id");
    expect(text).not.toContain("secret-player");
  });

  it("checksum is stable for identical prefixes and differs across states", () => {
    const events = [lifecycle(1, "s", "DRAFT_STARTED"), pick(2, "e1", "p1", 1)];
    const a = replayFull(events, 4);
    const b = replayFull(events, 4);
    expect(a.checksum).toBe(b.checksum);
    const c = replayFull([...events, pick(3, "e2", "p2", 2)], 4);
    expect(c.checksum).not.toBe(a.checksum);
    expect(
      replayChecksum({ selections: a.selections, nextOverallPick: 2, currentSequence: 2 }),
    ).toBe(a.checksum);
  });

  it("final state matches authoritative replayFromEvents on keeper/undo histories", () => {
    const events: ReplayInputEvent[] = [
      pick(1, "k1", "keeper1", 1, { isKeeper: true, slotPosition: "PG" }),
      lifecycle(2, "s", "DRAFT_STARTED"),
      pick(3, "e1", "p1", 1),
      pick(4, "e2", "p2", 2),
      {
        sequence: 5,
        eventType: "PICK_UNDONE",
        eventId: "u1",
        causationEventId: "e2",
        teamSlot: 2,
        playerId: "p2",
        slotPosition: null,
        isBench: false,
        isKeeper: false,
      },
      pick(6, "e3", "p3", 2),
      lifecycle(7, "done", "DRAFT_COMPLETED"),
    ];
    const ours = replayFull(events, 4);
    const log: DraftLogEvent[] = events.map((e) => ({
      sequence: e.sequence,
      eventType: e.eventType as DraftLogEvent["eventType"],
      eventId: e.eventId,
      causationEventId: e.causationEventId,
      teamSlot: e.teamSlot,
      playerId: e.playerId,
      slotPosition: (e.slotPosition ?? "UTIL") as DraftLogEvent["slotPosition"],
      isBench: e.isBench,
      isKeeper: e.isKeeper,
    }));
    const authoritative = replayFromEvents(log, 4);
    expect(ours.selections).toHaveLength(authoritative.selections.size);
    expect(ours.nextOverallPick).toBe(authoritative.nextOverallPick);
    expect(ours.currentSequence).toBe(authoritative.currentSequence);
  });

  it("no NaN, duplicate players, or illegal slots can appear in output", () => {
    const events = [
      lifecycle(1, "s", "DRAFT_STARTED"),
      pick(2, "e1", "p1", 1, { slotPosition: "PG" }),
      pick(3, "e2", "p2", 2, { slotPosition: "BENCH", isBench: true }),
    ];
    const result = replayFull(events, 4);
    const players = result.selections.map((s) => s.playerId);
    expect(new Set(players).size).toBe(players.length);
    for (const s of result.selections) {
      expect(Number.isFinite(s.overallPick)).toBe(true);
      expect(Number.isFinite(s.round)).toBe(true);
      expect(Number.isFinite(s.pickInRound)).toBe(true);
      expect(Number.isFinite(s.teamSlot)).toBe(true);
    }
  });

  it("property: identical streams always produce identical checksums", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            player: fc.integer({ min: 1, max: 50 }),
            team: fc.integer({ min: 1, max: 4 }),
          }),
          { minLength: 0, maxLength: 12 },
        ),
        (rows) => {
          const events: ReplayInputEvent[] = [lifecycle(1, "s", "DRAFT_STARTED")];
          const seen = new Set<number>();
          let seq = 2;
          for (const [index, row] of rows.entries()) {
            if (seen.has(row.player)) continue;
            seen.add(row.player);
            events.push(pick(seq, `e${String(index)}`, `p${String(row.player)}`, row.team));
            seq += 1;
          }
          const a = replayFull(events, 4);
          const b = replayFull([...events].reverse(), 4);
          expect(a.checksum).toBe(b.checksum);
          expect(a.selections.map((s) => s.playerId)).toEqual(b.selections.map((s) => s.playerId));
        },
      ),
      { numRuns: 50 },
    );
  });
});
