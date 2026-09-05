import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { overallPickToSlot } from "./draft";
import {
  CPU_MAX_TEMPERATURE,
  CPU_MIN_TEMPERATURE,
  checksumCpuPersonalitySnapshot,
  cpuFeatureDimensions,
  cpuPersonalityByKey,
  defaultCpuPersonalityKey,
  toCpuPersonalitySnapshot,
  type CpuFeatureDimension,
  type CpuPersonalityDefinition,
  type CpuPersonalitySnapshot,
  type CpuWeightVector,
} from "./cpu-personalities";
import { selectCpuPick, type CpuDecision, type CpuDecisionInput } from "./cpu-selector";
import type {
  EngineAdpEntry,
  EngineAssignment,
  EnginePlayerMeta,
  EngineProjection,
  EngineScoringRule,
  EngineSettings,
} from "./recommendation";

/**
 * Golden + property tests for the deterministic CPU pick selector (Phase 3C):
 * determinism, typed failures, personality divergence on controlled fixtures,
 * temperature monotonicity, legality (league+team slot inventory), undo
 * stability, numeric bounds under fast-check, seed hygiene, and large-pool
 * bounded work.
 *
 * Divergence tests assert `evidence.topK[0]` — the personality's argmax —
 * which is computed BEFORE the softmax draw and is therefore fully
 * deterministic; the seeded roll itself is covered by the golden, undo,
 * bounds, and seed-hygiene tests.
 */

// ---------------------------------------------------------------------------
// Fixture builders (baseInput pattern)
// ---------------------------------------------------------------------------

function projection(overrides: Partial<EngineProjection> & { playerId: string }): EngineProjection {
  return {
    games: 72,
    minutesPerGame: 32,
    pts: 18,
    reb: 6,
    ast: 5,
    stl: 1,
    blk: 0.6,
    tov: 2,
    fgm: 8,
    fga: 17,
    ftm: 4,
    fta: 4.8,
    threePm: 1.5,
    lower80: { pts: 14 },
    upper80: { pts: 22 },
    injuryRisk: 0.12,
    consistency: 0.7,
    upside: 0.5,
    roleSecurity: 0.8,
    ...overrides,
  };
}

function meta(overrides: Partial<EnginePlayerMeta> & { playerId: string }): EnginePlayerMeta {
  return {
    displayName: overrides.playerId,
    eligiblePositions: ["SG"],
    status: "ACTIVE",
    age: 25,
    ...overrides,
  };
}

interface PlayerSpec {
  id: string;
  positions: string[];
  pts: number;
  reb?: number;
  ast?: number;
  stl?: number;
  blk?: number;
  tov?: number;
  games?: number;
  age?: number | undefined;
  status?: EnginePlayerMeta["status"];
  injuryRisk?: number;
  consistency?: number;
  roleSecurity?: number;
  upperPts?: number;
  lowerPts?: number;
}

const POSITION_CYCLE = [["PG"], ["SG"], ["SF"], ["PF"], ["C"], ["PG", "SG"], ["SF", "PF"], ["C"]];

function buildPlayer(spec: PlayerSpec): { meta: EnginePlayerMeta; projection: EngineProjection } {
  const pts = spec.pts;
  return {
    meta: meta({
      playerId: spec.id,
      displayName: spec.id,
      eligiblePositions: spec.positions,
      status: spec.status ?? "ACTIVE",
      age: spec.age,
    }),
    projection: projection({
      playerId: spec.id,
      pts,
      reb: spec.reb ?? 6,
      ast: spec.ast ?? 5,
      stl: spec.stl ?? 1,
      blk: spec.blk ?? 0.6,
      tov: spec.tov ?? 2,
      games: spec.games ?? 72,
      injuryRisk: spec.injuryRisk ?? 0.12,
      consistency: spec.consistency ?? 0.7,
      roleSecurity: spec.roleSecurity ?? 0.8,
      lower80: { pts: spec.lowerPts ?? Math.max(0, pts - 4) },
      upper80: { pts: spec.upperPts ?? pts + 4 },
    }),
  };
}

function scoringRules(type: EngineSettings["type"], puntTov = false): EngineScoringRule[] {
  if (type === "POINTS") {
    return [
      { stat: "PTS", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
      { stat: "REB", weight: 1.2, direction: "HIGHER_BETTER", enabled: true, punt: false },
      { stat: "AST", weight: 1.5, direction: "HIGHER_BETTER", enabled: true, punt: false },
      { stat: "TOV", weight: -1, direction: "LOWER_BETTER", enabled: true, punt: puntTov },
    ];
  }
  return [
    { stat: "PTS", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
    { stat: "REB", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
    { stat: "AST", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
    { stat: "STL", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
    { stat: "BLK", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
    { stat: "TOV", weight: 1, direction: "LOWER_BETTER", enabled: true, punt: puntTov },
  ];
}

function settingsFor(
  type: EngineSettings["type"],
  horizon: EngineSettings["horizon"] = "REDRAFT",
): EngineSettings {
  return {
    season: "2026-27",
    type,
    horizon,
    teamCount: 12,
    rounds: 13,
    userDraftSlot: 1,
    scoringRules: scoringRules(type),
    rosterSlots: [
      { position: "PG", count: 1, isStarter: true },
      { position: "SG", count: 1, isStarter: true },
      { position: "G", count: 1, isStarter: true },
      { position: "F", count: 1, isStarter: true },
      { position: "C", count: 1, isStarter: true },
      { position: "UTIL", count: 2, isStarter: true },
      { position: "BENCH", count: 3, isStarter: false },
    ],
  };
}

/** Small league for slot-inventory gymnastics. */
function smallSettings(teamCount = 4): EngineSettings {
  return {
    season: "2026-27",
    type: "POINTS",
    horizon: "REDRAFT",
    teamCount,
    rounds: 3,
    userDraftSlot: 1,
    scoringRules: scoringRules("POINTS"),
    rosterSlots: [
      { position: "PG", count: 1, isStarter: true },
      { position: "SG", count: 1, isStarter: true },
      { position: "G", count: 2, isStarter: true },
      { position: "C", count: 1, isStarter: true },
      { position: "UTIL", count: 1, isStarter: true },
      { position: "BENCH", count: 1, isStarter: false },
    ],
  };
}

function benchOnlySettings(): EngineSettings {
  return {
    season: "2026-27",
    type: "POINTS",
    horizon: "REDRAFT",
    teamCount: 4,
    rounds: 3,
    userDraftSlot: 1,
    scoringRules: scoringRules("POINTS"),
    rosterSlots: [
      { position: "PG", count: 1, isStarter: true },
      { position: "SG", count: 1, isStarter: true },
      { position: "C", count: 1, isStarter: true },
      { position: "UTIL", count: 1, isStarter: true },
      { position: "BENCH", count: 1, isStarter: false },
    ],
  };
}

function definitionOf(key: string): CpuPersonalityDefinition {
  const definition = cpuPersonalityByKey(key);
  if (!definition) throw new Error(`missing personality ${key}`);
  return definition;
}

function snapshotOf(key: string): CpuPersonalitySnapshot {
  return toCpuPersonalitySnapshot(definitionOf(key));
}

function adpList(pairs: [string, number][]): EngineAdpEntry[] {
  return pairs.map(([playerId, adp]) => ({ playerId, adp, rank: adp, sourcesCount: 3 }));
}

function assignment(playerId: string, teamSlot: number, slotPosition: string): EngineAssignment {
  return { playerId, teamSlot, slotPosition };
}

function cpuInput(
  players: { meta: EnginePlayerMeta; projection: EngineProjection }[],
  overrides: Partial<CpuDecisionInput> = {},
): CpuDecisionInput {
  return {
    settings: settingsFor("POINTS"),
    projectionRunId: "run-cpu-test",
    modelVersion: "baseline@1.0.0",
    projections: players.map((entry) => entry.projection),
    players: players.map((entry) => entry.meta),
    adp: null,
    assignments: [],
    currentTeamSlot: 1,
    nextOverallPick: 1,
    personality: snapshotOf(defaultCpuPersonalityKey),
    draftSeed: 20260824,
    includeUnsigned: false,
    ...overrides,
  };
}

function expectOk(decision: CpuDecision): Extract<CpuDecision, { ok: true }> {
  if (!decision.ok) throw new Error(`expected ok decision, got ${decision.failure.reason}`);
  return decision;
}

function expectFailure(decision: CpuDecision): Extract<CpuDecision, { ok: false }> {
  if (decision.ok) throw new Error("expected a failure decision");
  return decision;
}

function topIds(decision: Extract<CpuDecision, { ok: true }>): string[] {
  return decision.evidence.topK.map((entry) => entry.playerId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cpu selector", () => {
  it("is byte-deterministic for the same immutable input", () => {
    const pool = [
      buildPlayer({ id: "g-1", positions: ["PG"], pts: 30 }),
      buildPlayer({ id: "w-1", positions: ["SF"], pts: 26 }),
      buildPlayer({ id: "c-1", positions: ["C"], pts: 22, age: 21 }),
      buildPlayer({ id: "u-1", positions: ["PF"], pts: 20 }),
    ].map((entry) => entry);
    const input = cpuInput(pool, {
      adp: adpList([
        ["g-1", 5],
        ["w-1", 12],
        ["c-1", 30],
      ]),
    });
    const first = selectCpuPick(input);
    const second = selectCpuPick(input);
    expect(second).toEqual(first);
    if (first.ok && second.ok) {
      expect(second.decisionChecksum).toBe(first.decisionChecksum);
      expect(second.evidence.pickSeedHex).toBe(first.evidence.pickSeedHex);
    }
    expect(first.ok).toBe(true);
  });

  it("produces typed failures for wrong turn and full board with zero rng draws", () => {
    const pool = [buildPlayer({ id: "solo", positions: ["PG"], pts: 20 })];
    const badTurn = expectFailure(selectCpuPick(cpuInput(pool, { currentTeamSlot: 2 })));
    expect(badTurn.failure.reason).toBe("INVALID_TEAM_SLOT");
    expect("evidence" in badTurn).toBe(false);

    const boardFullPick = 13 * 12 + 1; // 157 > rounds*teamCount
    const boardFull = expectFailure(
      selectCpuPick(
        cpuInput(pool, {
          nextOverallPick: boardFullPick,
          currentTeamSlot: overallPickToSlot(boardFullPick, 12),
        }),
      ),
    );
    expect(boardFull.failure.reason).toBe("BOARD_COMPLETE");
    expect("evidence" in boardFull).toBe(false);
  });

  // -- personality divergence -------------------------------------------------

  it("adp-follower targets the best market rank while projection-purist targets the producer", () => {
    const pool = [
      buildPlayer({ id: "cpu-producer", positions: ["PG"], pts: 33, reb: 7, ast: 7, tov: 3.5 }),
      buildPlayer({
        id: "cpu-market-leader",
        positions: ["PG"],
        pts: 24,
        reb: 5,
        ast: 5,
        tov: 2.5,
      }),
      buildPlayer({ id: "cpu-filler", positions: ["PG"], pts: 12 }),
    ];
    const input = cpuInput(pool, {
      adp: adpList([
        ["cpu-producer", 18],
        ["cpu-market-leader", 1],
        ["cpu-filler", 80],
      ]),
    });
    const follower = expectOk(selectCpuPick({ ...input, personality: snapshotOf("adp-follower") }));
    expect(topIds(follower)[0]).toBe("cpu-market-leader");

    const purist = expectOk(
      selectCpuPick({ ...input, personality: snapshotOf("projection-purist") }),
    );
    expect(topIds(purist)[0]).toBe("cpu-producer");
  });

  it("checksums unordered decision inputs canonically and caps requested top-K", () => {
    const pool = [
      buildPlayer({ id: "canon-b", positions: ["SG", "PG"], pts: 25 }),
      buildPlayer({ id: "canon-a", positions: ["SF"], pts: 22 }),
    ];
    const first = expectOk(
      selectCpuPick(
        cpuInput(pool, {
          adp: adpList([
            ["canon-b", 2],
            ["canon-a", 1],
          ]),
          topK: 999,
        }),
      ),
    );
    const reversed = expectOk(
      selectCpuPick(
        cpuInput([...pool].reverse(), {
          players: [...pool].reverse().map((entry) => ({
            ...entry.meta,
            eligiblePositions: [...entry.meta.eligiblePositions].reverse(),
          })),
          projections: [...pool].reverse().map((entry) => entry.projection),
          adp: adpList([
            ["canon-a", 1],
            ["canon-b", 2],
          ]),
          topK: 999,
        }),
      ),
    );
    expect(reversed.playerId).toBe(first.playerId);
    expect(reversed.inputChecksum).toBe(first.inputChecksum);
    expect(first.evidence.topK).toHaveLength(2);
  });

  it("upside-hunter ranks the injured ceiling first while safe-veteran ranks the floor first", () => {
    const pool = [
      buildPlayer({
        id: "cpu-ceiling",
        positions: ["SF"],
        pts: 24,
        ast: 6,
        stl: 1.2,
        blk: 1,
        tov: 3,
        upperPts: 80,
        lowerPts: 10,
        injuryRisk: 0.78,
        roleSecurity: 0.3,
        consistency: 0.2,
        games: 58,
        age: 21,
      }),
      buildPlayer({
        id: "cpu-floor-vet",
        positions: ["SG"],
        pts: 26,
        upperPts: 28,
        lowerPts: 24,
        injuryRisk: 0.02,
        roleSecurity: 0.95,
        consistency: 0.97,
        age: 30,
      }),
      buildPlayer({ id: "cpu-mid", positions: ["PF"], pts: 15 }),
    ];
    const input = cpuInput(pool, {
      adp: adpList([
        ["cpu-ceiling", 40],
        ["cpu-floor-vet", 20],
        ["cpu-mid", 55],
      ]),
    });
    const hunter = expectOk(selectCpuPick({ ...input, personality: snapshotOf("upside-hunter") }));
    expect(topIds(hunter)[0]).toBe("cpu-ceiling");

    const veteran = expectOk(selectCpuPick({ ...input, personality: snapshotOf("safe-veteran") }));
    expect(topIds(veteran)[0]).toBe("cpu-floor-vet");
  });

  it("category-specialist prefers the stocks leader under CATEGORIES but flips under POINTS", () => {
    // Both players lead enabled category norms in either mode (so
    // categoryEmphasis ties at its MAX of 1.0), making the projection
    // component — whose utility switches shape with the scoring type — the
    // discriminator: the stocks forward's STL/BLK only count under CATEGORIES.
    const pool = [
      buildPlayer({
        id: "cat-stocks",
        positions: ["SF"],
        pts: 26,
        reb: 5,
        ast: 4,
        stl: 3,
        blk: 2.6,
        tov: 1.8,
      }),
      buildPlayer({
        id: "cat-scorer",
        positions: ["SF"],
        pts: 30,
        reb: 5,
        ast: 3,
        stl: 0.7,
        blk: 0.4,
        tov: 2.2,
      }),
      buildPlayer({
        id: "cat-wing1",
        positions: ["SF"],
        pts: 20,
        reb: 6,
        ast: 4,
        stl: 1,
        blk: 0.6,
      }),
      buildPlayer({
        id: "cat-wing2",
        positions: ["SF"],
        pts: 14,
        reb: 4,
        ast: 3,
        stl: 0.8,
        blk: 0.4,
      }),
    ];
    const categories = cpuInput(pool, {
      settings: settingsFor("CATEGORIES"),
      adp: adpList([
        ["cat-stocks", 15],
        ["cat-scorer", 10],
        ["cat-wing1", 28],
        ["cat-wing2", 36],
      ]),
    });
    const specialistCategories = expectOk(
      selectCpuPick({ ...categories, personality: snapshotOf("category-specialist") }),
    );
    expect(topIds(specialistCategories)[0]).toBe("cat-stocks");

    const points = cpuInput(pool, {
      settings: settingsFor("POINTS"),
      adp: adpList([
        ["cat-stocks", 15],
        ["cat-scorer", 10],
        ["cat-wing1", 28],
        ["cat-wing2", 36],
      ]),
    });
    const specialistPoints = expectOk(
      selectCpuPick({ ...points, personality: snapshotOf("category-specialist") }),
    );
    expect(topIds(specialistPoints)[0]).toBe("cat-scorer");
  });

  it("dynasty-youth favors the 20-year-old under DYNASTY but reverts under REDRAFT (ageCurve neutral)", () => {
    const pool = [
      buildPlayer({ id: "cpu-prospect", positions: ["PG"], pts: 22, age: 20 }),
      buildPlayer({ id: "cpu-veteran", positions: ["PG"], pts: 28, age: 35 }),
    ];
    const dynasty = cpuInput(pool, {
      settings: settingsFor("POINTS", "DYNASTY"),
      personality: snapshotOf("dynasty-youth"),
    });
    expect(topIds(expectOk(selectCpuPick(dynasty)))[0]).toBe("cpu-prospect");

    const redraft = cpuInput(pool, {
      settings: settingsFor("POINTS", "REDRAFT"),
      personality: snapshotOf("dynasty-youth"),
    });
    expect(topIds(expectOk(selectCpuPick(redraft)))[0]).toBe("cpu-veteran");
  });

  // -- temperature ------------------------------------------------------------

  it("sharpens argmax probability as temperature drops (analytic monotonicity)", () => {
    const pool = [
      buildPlayer({ id: "t-34", positions: ["PG"], pts: 34 }),
      buildPlayer({ id: "t-28", positions: ["SG"], pts: 28 }),
      buildPlayer({ id: "t-22", positions: ["SF"], pts: 22 }),
      buildPlayer({ id: "t-16", positions: ["PF"], pts: 16 }),
      buildPlayer({ id: "t-10", positions: ["C"], pts: 10 }),
    ];
    const coldSnapshot = toCpuPersonalitySnapshot({
      ...definitionOf(defaultCpuPersonalityKey),
      temperature: CPU_MIN_TEMPERATURE,
    });
    const hotSnapshot = toCpuPersonalitySnapshot({
      ...definitionOf(defaultCpuPersonalityKey),
      temperature: CPU_MAX_TEMPERATURE,
    });

    const cold = expectOk(selectCpuPick(cpuInput(pool, { personality: coldSnapshot })));
    const hot = expectOk(selectCpuPick(cpuInput(pool, { personality: hotSnapshot })));

    // Same key/version/seed strategy -> identical seed and roll; only T moves.
    expect(cold.evidence.pickSeedHex).toBe(hot.evidence.pickSeedHex);
    expect(cold.evidence.roll).toBe(hot.evidence.roll);
    expect(topIds(cold)).toEqual(topIds(hot));

    const probArgmax = (decision: typeof cold): number => {
      const scores = decision.evidence.topK.map((entry) => entry.score);
      const t = decision.evidence.temperature;
      const exponentials = scores.map((score) => Math.exp(score / t));
      const total = exponentials.reduce((sum, value) => sum + value, 0);
      return (exponentials[0] ?? 0) / total;
    };
    expect(probArgmax(cold)).toBeGreaterThan(probArgmax(hot));

    for (const decision of [cold, hot]) {
      expect(decision.evidence.temperature).toBeGreaterThanOrEqual(CPU_MIN_TEMPERATURE);
      expect(decision.evidence.temperature).toBeLessThanOrEqual(CPU_MAX_TEMPERATURE);
      expect(decision.evidence.roll).toBeGreaterThanOrEqual(0);
      expect(decision.evidence.roll).toBeLessThan(1);
    }
  });

  // -- legality -----------------------------------------------------------------

  it("never selects drafted, keeper-assigned, or retired players; unsigned only when included", () => {
    // Keepers ride the same assignments list as every other effective
    // selection, so excluding ALL assignment playerIds covers them.
    const pool = [
      buildPlayer({ id: "lg-active", positions: ["PG"], pts: 25 }),
      buildPlayer({ id: "lg-drafted", positions: ["SG"], pts: 30 }),
      buildPlayer({ id: "lg-retired", positions: ["C"], pts: 28, status: "RETIRED" }),
      buildPlayer({ id: "lg-unsigned", positions: ["PF"], pts: 27, status: "UNSIGNED" }),
    ];
    const base = cpuInput(pool, {
      assignments: [assignment("lg-drafted", 3, "SG")],
    });

    const excluded = expectOk(selectCpuPick(base));
    const idsExcluded = topIds(excluded);
    expect(idsExcluded).not.toContain("lg-drafted");
    expect(idsExcluded).not.toContain("lg-retired");
    expect(idsExcluded).not.toContain("lg-unsigned");
    expect(excluded.evidence.consideredCount).toBe(1);

    const included = expectOk(selectCpuPick({ ...base, includeUnsigned: true }));
    const idsIncluded = topIds(included);
    expect(idsIncluded).toContain("lg-unsigned");
    expect(idsIncluded).not.toContain("lg-drafted");
    expect(idsIncluded).not.toContain("lg-retired");
    expect(included.evidence.consideredCount).toBe(2);
  });

  it("honors multi-position combos, team-full slots, and UTIL universality", () => {
    // Roster: PG1 SG1 G2 C1 UTIL1 BENCH1 across 4 teams.
    // Team 1 fills PG+SG: guard-only still eligible via G; forward-only via UTIL.
    const guardsAndForwards = [
      buildPlayer({ id: "combo-guard", positions: ["PG", "SG"], pts: 25 }),
      buildPlayer({ id: "combo-forward", positions: ["SF", "PF"], pts: 20 }),
    ];
    const partial = cpuInput(guardsAndForwards, {
      settings: smallSettings(),
      assignments: [assignment("dummy-pg", 1, "PG"), assignment("dummy-sg", 1, "SG")],
    });
    const partialDecision = expectOk(selectCpuPick(partial));
    expect(topIds(partialDecision)).toContain("combo-guard");
    expect(topIds(partialDecision)).toContain("combo-forward");

    // Team 1 completely full (PG, SG, G, G, C, UTIL, BENCH): guard-only has no
    // candidate slot left -> EMPTY_POOL for THIS team even though other teams
    // have room.
    const teamOneFullAssignments = [
      assignment("dummy-pg", 1, "PG"),
      assignment("dummy-sg", 1, "SG"),
      assignment("dummy-g1", 1, "G"),
      assignment("dummy-g2", 1, "G"),
      assignment("dummy-c", 1, "C"),
      assignment("dummy-util", 1, "UTIL"),
      assignment("dummy-bench", 1, "BENCH"),
    ];
    const fullForTeamOne = cpuInput(guardsAndForwards, {
      settings: smallSettings(),
      assignments: teamOneFullAssignments,
    });
    const emptyHere = expectFailure(selectCpuPick(fullForTeamOne));
    expect(emptyHere.failure.reason).toBe("EMPTY_POOL");

    // Same league state at team slot 2's turn: both players are legal again —
    // league capacity is open, only THIS team was full.
    const sameBoardOtherTeam = cpuInput(guardsAndForwards, {
      settings: smallSettings(),
      assignments: teamOneFullAssignments,
      nextOverallPick: 2,
      currentTeamSlot: overallPickToSlot(2, 4),
    });
    const there = expectOk(selectCpuPick(sameBoardOtherTeam));
    const idsThere = topIds(there);
    expect(idsThere).toContain("combo-guard");
    expect(idsThere).toContain("combo-forward");

    // UTIL accepts anyone: center-only player stays eligible when every
    // league C slot is gone because UTIL slots remain open.
    const centersGone = [
      buildPlayer({ id: "center-only", positions: ["C"], pts: 30 }),
      buildPlayer({ id: "flex", positions: ["PG"], pts: 18 }),
    ];
    const utilCase = cpuInput(centersGone, {
      settings: smallSettings(),
      assignments: [
        assignment("d-c1", 1, "C"),
        assignment("d-c2", 2, "C"),
        assignment("d-c3", 3, "C"),
        assignment("d-c4", 4, "C"),
      ],
    });
    const utilDecision = expectOk(selectCpuPick(utilCase));
    expect(topIds(utilDecision)).toContain("center-only");
  });

  it("falls back to BENCH only when no starter slot works, then empties the pool when bench fills", () => {
    // Every starter slot league-wide is filled (4 teams x PG/SG/C/UTIL);
    // benches are all open, so the free guard is legal ONLY via BENCH.
    const guard = [buildPlayer({ id: "bench-case-guard", positions: ["PG", "SG"], pts: 24 })];
    const leagueFills = [1, 2, 3, 4].flatMap((teamSlot) => [
      assignment(`d-pg-${String(teamSlot)}`, teamSlot, "PG"),
      assignment(`d-sg-${String(teamSlot)}`, teamSlot, "SG"),
      assignment(`d-c-${String(teamSlot)}`, teamSlot, "C"),
      assignment(`d-u-${String(teamSlot)}`, teamSlot, "UTIL"),
    ]);
    const benchOnly = cpuInput(guard, {
      settings: benchOnlySettings(),
      assignments: leagueFills,
    });
    const benchDecision = expectOk(selectCpuPick(benchOnly));
    expect(benchDecision.playerId).toBe("bench-case-guard");
    expect(benchDecision.evidence.proposedSlot).toEqual({ position: "BENCH", isBench: true });

    // Fill THIS team's bench too: the guard now has nowhere legal to go.
    const fullyStuffed = cpuInput(guard, {
      settings: benchOnlySettings(),
      assignments: [...leagueFills, assignment("d-b-1", 1, "BENCH")],
    });
    const emptied = expectFailure(selectCpuPick(fullyStuffed));
    expect(emptied.failure.reason).toBe("EMPTY_POOL");
    expect("evidence" in emptied).toBe(false);
  });

  it("proposes a starter slot first for a fresh roster", () => {
    const pool = [buildPlayer({ id: "fresh-guard", positions: ["PG", "SG"], pts: 25 })];
    const decision = expectOk(selectCpuPick(cpuInput(pool)));
    expect(decision.evidence.proposedSlot.position).toBe("PG");
    expect(decision.evidence.proposedSlot.isBench).toBe(false);
  });

  // -- points vs categories flip + punts -----------------------------------------

  it("flips the specialist choice between POINTS and CATEGORIES and honors explicit punts", () => {
    const pool = [
      // High-production but turnover-prone scorer.
      buildPlayer({ id: "flip-scorer", positions: ["SF"], pts: 30, tov: 3.8, stl: 1, blk: 0.6 }),
      // Slightly lesser production, clean handles, elite stocks.
      buildPlayer({
        id: "flip-two-way",
        positions: ["SF"],
        pts: 26,
        tov: 1,
        stl: 1.9,
        blk: 1.7,
      }),
      // Low-utility filler so the scarcity marginals of the contenders stay
      // close (their category utilities differ by less than the filler's gap).
      buildPlayer({ id: "flip-scrubber", positions: ["SF"], pts: 8, tov: 4, stl: 0.2, blk: 0.1 }),
    ];
    const sharedAdp = adpList([
      ["flip-scorer", 10],
      ["flip-two-way", 14],
      ["flip-scrubber", 40],
    ]);
    const specialist = snapshotOf("category-specialist");

    const pointsDecision = expectOk(
      selectCpuPick({
        ...cpuInput(pool, {
          settings: settingsFor("POINTS"),
          adp: sharedAdp,
          personality: specialist,
        }),
      }),
    );
    const categoriesDecision = expectOk(
      selectCpuPick({
        ...cpuInput(pool, {
          settings: settingsFor("CATEGORIES"),
          adp: sharedAdp,
          personality: specialist,
        }),
      }),
    );
    expect(topIds(pointsDecision)[0]).not.toBe(topIds(categoriesDecision)[0]);
    expect(topIds(pointsDecision)[0]).toBe("flip-scorer");
    expect(topIds(categoriesDecision)[0]).toBe("flip-two-way");

    // Punting TOV removes its influence entirely (utility + emphasis rule)
    // without disabling any other stat: STL/BLK still count, but the two-way
    // forward loses his handle-based edge back to the pure scorer here.
    const punted = cpuInput(pool, {
      settings: {
        ...settingsFor("CATEGORIES"),
        scoringRules: scoringRules("CATEGORIES", true),
      },
      adp: sharedAdp,
      personality: specialist,
    });
    const puntedDecision = expectOk(selectCpuPick(punted));
    expect(topIds(puntedDecision)[0]).toBe("flip-scorer");
  });

  // -- failure paths ---------------------------------------------------------------

  it("returns EMPTY_POOL when nothing is legal and never consumes rng", () => {
    const pool = [
      buildPlayer({ id: "gone-a", positions: ["PG"], pts: 25 }),
      buildPlayer({ id: "gone-b", positions: ["SG"], pts: 22 }),
    ];
    const everythingDrafted = cpuInput(pool, {
      assignments: [assignment("gone-a", 1, "UTIL"), assignment("gone-b", 2, "UTIL")],
    });
    const failure = expectFailure(selectCpuPick(everythingDrafted));
    expect(failure.failure.reason).toBe("EMPTY_POOL");
    expect(failure.failure.message.length).toBeGreaterThan(0);
    expect("evidence" in failure).toBe(false);
    expect("playerId" in failure).toBe(false);
  });

  // -- undo stability ---------------------------------------------------------------

  it("reproduces the identical decision after an undo restores prior state", () => {
    const pool = [
      buildPlayer({ id: "undo-a", positions: ["PG"], pts: 30 }),
      buildPlayer({ id: "undo-b", positions: ["SF"], pts: 26 }),
      buildPlayer({ id: "undo-c", positions: ["C"], pts: 21 }),
    ];
    const before = cpuInput(pool, { draftSeed: 777 });
    const original = expectOk(selectCpuPick(before));

    // Draft the recommendation at pick 1, advancing the cursor...
    const afterPick = selectCpuPick(
      cpuInput(pool, {
        draftSeed: 777,
        assignments: [assignment(original.playerId, 1, original.evidence.proposedSlot.position)],
        nextOverallPick: 2,
        currentTeamSlot: overallPickToSlot(2, 12),
      }),
    );
    expect(afterPick.ok).toBe(true);

    // ...then undo it: state is byte-identical to `before`, so the decision
    // (player AND checksum) must be reproduced exactly.
    const restored = expectOk(selectCpuPick(cpuInput(pool, { draftSeed: 777 })));
    expect(restored.playerId).toBe(original.playerId);
    expect(restored.decisionChecksum).toBe(original.decisionChecksum);
  });

  // -- bounds property ---------------------------------------------------------------

  it("keeps features, score, and roll inside bounds for arbitrary pools and personalities", () => {
    const statsArbitrary = fc.record({
      pts: fc.double({ min: 3, max: 36, noNaN: true }),
      reb: fc.double({ min: 0, max: 16, noNaN: true }),
      ast: fc.double({ min: 0, max: 14, noNaN: true }),
      tov: fc.double({ min: 0.5, max: 5, noNaN: true }),
      games: fc.integer({ min: 1, max: 82 }),
      injuryRisk: fc.double({ min: 0, max: 1, noNaN: true }),
      consistency: fc.double({ min: 0, max: 1, noNaN: true }),
      roleSecurity: fc.double({ min: 0, max: 1, noNaN: true }),
      age: fc.option(fc.integer({ min: 19, max: 40 }), { nil: undefined }),
    });

    // Valid personality snapshots: weights non-negative, exact sum 1 at 6dp,
    // arbitrary temperature inside [CPU_MIN_TEMPERATURE, CPU_MAX_TEMPERATURE].
    const weightsArbitrary = fc
      .array(fc.nat(1000000), { minLength: 9, maxLength: 9 })
      .map((units) => {
        const total = units.reduce((sum, value) => sum + value, 0);
        const scaled =
          total > 0
            ? units.map((value) => Math.round((value / total) * 1000000))
            : units.map(() => Math.round(1000000 / units.length));
        const drift = 1000000 - scaled.reduce((sum, value) => sum + value, 0);
        let largestIndex = 0;
        scaled.forEach((value, index) => {
          if ((scaled[largestIndex] ?? 0) < value) largestIndex = index;
        });
        scaled[largestIndex] = (scaled[largestIndex] ?? 0) + drift;
        const weights = {} as CpuWeightVector;
        cpuFeatureDimensions.forEach((dimension, index) => {
          weights[dimension] = (scaled[index] ?? 0) / 1000000;
        });
        return weights;
      });
    const personalityArbitrary = fc
      .record({
        key: fc.constantFrom(
          ...[...new Set([defaultCpuPersonalityKey, "adp-follower", "upside-hunter"])],
        ),
        temperature: fc.double({ min: CPU_MIN_TEMPERATURE, max: CPU_MAX_TEMPERATURE, noNaN: true }),
        weights: weightsArbitrary,
      })
      .map(({ key, temperature, weights }): CpuPersonalitySnapshot => ({
        snapshotVersion: 1,
        key,
        version: 1,
        displayLabel: key,
        description: "property-test personality",
        weights,
        temperature,
        seedStrategyVersion: 1,
      }));

    fc.assert(
      fc.property(
        fc.array(statsArbitrary, { minLength: 0, maxLength: 60 }),
        fc.nat(2147483647),
        personalityArbitrary,
        (statLines, draftSeed, personality) => {
          const players = statLines.map((stats, index) =>
            buildPlayerFromStats(
              `prop-${String(index)}`,
              stats,
              POSITION_CYCLE[index % POSITION_CYCLE.length] ?? ["PG"],
            ),
          );
          const decision = selectCpuPick({
            ...cpuInput(players, { draftSeed, personality }),
          });
          if (!decision.ok) {
            expect(decision.failure.reason).toBe("EMPTY_POOL");
            expect(statLines).toHaveLength(0);
            return;
          }
          const n = players.length;
          expect(decision.evidence.consideredCount).toBe(n);
          expect(decision.evidence.topK.length).toBe(Math.min(24, n));
          expect(Number.isFinite(decision.score)).toBe(true);
          expect(decision.score).toBeGreaterThanOrEqual(0);
          expect(decision.score).toBeLessThanOrEqual(1);
          expect(decision.evidence.roll).toBeGreaterThanOrEqual(0);
          expect(decision.evidence.roll).toBeLessThan(1);
          expect(decision.evidence.chosenRankInTopK).toBeGreaterThanOrEqual(1);
          expect(decision.evidence.chosenRankInTopK).toBeLessThanOrEqual(
            decision.evidence.topK.length,
          );
          expect(decision.evidence.topK[decision.evidence.chosenRankInTopK - 1]?.playerId).toBe(
            decision.playerId,
          );
          for (const entry of decision.evidence.topK) {
            expect(Number.isFinite(entry.score)).toBe(true);
            for (const dimension of cpuFeatureDimensions as readonly CpuFeatureDimension[]) {
              const value = entry.features[dimension];
              expect(Number.isFinite(value)).toBe(true);
              expect(value).toBeGreaterThanOrEqual(0);
              expect(value).toBeLessThanOrEqual(1);
            }
          }
          for (const dimension of cpuFeatureDimensions as readonly CpuFeatureDimension[]) {
            expect(Number.isFinite(decision.evidence.chosenFeatures[dimension])).toBe(true);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  // -- seed hygiene ---------------------------------------------------------------

  it("changes pickSeedHex exactly when seed-relevant inputs change", () => {
    const pool = [
      buildPlayer({ id: "seed-a", positions: ["PG"], pts: 28 }),
      buildPlayer({ id: "seed-b", positions: ["SG"], pts: 24 }),
      buildPlayer({ id: "seed-c", positions: ["SF"], pts: 20 }),
    ];

    const baseline = expectOk(selectCpuPick(cpuInput(pool, { draftSeed: 5000 })));
    const regenerated = expectOk(selectCpuPick(cpuInput(pool, { draftSeed: 5000 })));
    expect(regenerated.evidence.pickSeedHex).toBe(baseline.evidence.pickSeedHex);

    const changedSeed = expectOk(selectCpuPick(cpuInput(pool, { draftSeed: 5001 })));
    expect(changedSeed.evidence.pickSeedHex).not.toBe(baseline.evidence.pickSeedHex);

    const changedPersonalityKey = expectOk(
      selectCpuPick(cpuInput(pool, { draftSeed: 5000, personality: snapshotOf("upside-hunter") })),
    );
    expect(changedPersonalityKey.evidence.pickSeedHex).not.toBe(baseline.evidence.pickSeedHex);

    const baseSnapshot = snapshotOf(defaultCpuPersonalityKey);
    const bumpedVersion = expectOk(
      selectCpuPick(
        cpuInput(pool, {
          draftSeed: 5000,
          personality: { ...baseSnapshot, version: baseSnapshot.version + 1 },
        }),
      ),
    );
    expect(bumpedVersion.evidence.pickSeedHex).not.toBe(baseline.evidence.pickSeedHex);

    // Pick 5 maps to team slot 5 (round 1 snake), isolating a turn change.
    const changedTurn = expectOk(
      selectCpuPick(
        cpuInput(pool, {
          draftSeed: 5000,
          nextOverallPick: 5,
          currentTeamSlot: overallPickToSlot(5, 12),
        }),
      ),
    );
    expect(changedTurn.evidence.pickSeedHex).not.toBe(baseline.evidence.pickSeedHex);

    const hexes = new Set([
      baseline.evidence.pickSeedHex,
      changedSeed.evidence.pickSeedHex,
      changedPersonalityKey.evidence.pickSeedHex,
      bumpedVersion.evidence.pickSeedHex,
      changedTurn.evidence.pickSeedHex,
    ]);
    expect(hexes.size).toBe(5);

    // The content checksum also regenerates identically for identical inputs.
    expect(checksumCpuPersonalitySnapshot(baseSnapshot)).toBe(
      checksumCpuPersonalitySnapshot(snapshotOf(defaultCpuPersonalityKey)),
    );
  });

  // -- scale ------------------------------------------------------------------------

  it("handles a 400-player board quickly with a truncated top-K", () => {
    const players = Array.from({ length: 400 }, (_, index) =>
      buildPlayer({
        id: `mass-${String(index).padStart(3, "0")}`,
        positions: POSITION_CYCLE[index % POSITION_CYCLE.length] ?? ["PG"],
        pts: 8 + ((index * 7919) % 2600) / 100,
        stl: ((index * 104729) % 250) / 100,
        blk: ((index * 1299709) % 220) / 100,
        tov: 1 + ((index * 3571) % 300) / 100,
        age: 19 + (index % 18),
      }),
    );
    const adps = players.map((player, index) => ({
      playerId: player.meta.playerId,
      adp: index + 1,
      rank: index + 1,
      sourcesCount: 3,
    }));
    const started = performance.now();
    const decision = expectOk(selectCpuPick(cpuInput(players, { adp: adps })));
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(10000);
    expect(decision.evidence.consideredCount).toBe(400);
    expect(decision.evidence.topK).toHaveLength(24);
    expect(decision.evidence.chosenRankInTopK).toBeGreaterThanOrEqual(1);
    expect(decision.evidence.chosenRankInTopK).toBeLessThanOrEqual(24);

    const rerun = expectOk(selectCpuPick(cpuInput(players, { adp: adps })));
    expect(rerun.decisionChecksum).toBe(decision.decisionChecksum);
  });
});

// ---------------------------------------------------------------------------
// Helpers used above
// ---------------------------------------------------------------------------

interface PropStats {
  pts: number;
  reb: number;
  ast: number;
  tov: number;
  games: number;
  injuryRisk: number;
  consistency: number;
  roleSecurity: number;
  age: number | undefined;
}

function buildPlayerFromStats(id: string, stats: PropStats, positions: string[]) {
  return buildPlayer({
    id,
    positions,
    pts: stats.pts,
    reb: stats.reb,
    ast: stats.ast,
    tov: stats.tov,
    games: stats.games,
    injuryRisk: stats.injuryRisk,
    consistency: stats.consistency,
    roleSecurity: stats.roleSecurity,
    age: stats.age,
    upperPts: stats.pts + 5,
    lowerPts: Math.max(0, stats.pts - 5),
  });
}
