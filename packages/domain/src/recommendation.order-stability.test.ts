import { describe, expect, it } from "vitest";
import {
  canonicalize,
  mulberry32,
  recommend,
  type EngineAdpEntry,
  type EngineAssignment,
  type EngineInput,
  type EnginePlayerMeta,
  type EngineProjection,
} from "./recommendation";

/**
 * Phase 3F twin-draft determinism regression tests (lowest layer).
 *
 * The production server loads engine inputs from Postgres, whose row-return
 * order is unspecified and varies under parallel load. The engine must
 * therefore be invariant to input ARRAY ORDER: the same logical snapshot in
 * any permutation must yield the identical recommendation order and the
 * identical input checksum. This is what makes two same-seed twin drafts —
 * which share league config, pool, projections, ADP, preferences, and
 * simulation seed but are loaded by separate queries — produce identical
 * draft-event sequences.
 *
 * Covered mechanisms: canonicalize set-sorting, normalizeByRank id
 * tie-breaks, lookahead top-20 cutoff tie-breaks, replacement-baseline sample
 * order, and sorted softmax walk order.
 */

function projection(overrides: Partial<EngineProjection> & { playerId: string }): EngineProjection {
  return {
    games: 70,
    minutesPerGame: 30,
    pts: 18,
    reb: 6,
    ast: 4,
    stl: 1,
    blk: 0.6,
    tov: 2,
    fgm: 6.5,
    fga: 14,
    ftm: 3.8,
    fta: 4.6,
    threePm: 1.8,
    lower80: { pts: 14 },
    upper80: { pts: 22 },
    injuryRisk: 0.15,
    consistency: 0.6,
    upside: 0.5,
    roleSecurity: 0.75,
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

const SETTINGS: EngineInput["settings"] = {
  season: "2026-27",
  type: "POINTS",
  horizon: "REDRAFT",
  teamCount: 4,
  rounds: 6,
  userDraftSlot: 1,
  scoringRules: [
    { stat: "PTS", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
    { stat: "REB", weight: 1.2, direction: "HIGHER_BETTER", enabled: true, punt: false },
    { stat: "AST", weight: 1.5, direction: "HIGHER_BETTER", enabled: true, punt: false },
    { stat: "TOV", weight: -1, direction: "LOWER_BETTER", enabled: true, punt: false },
  ],
  rosterSlots: [
    { position: "PG", count: 1, isStarter: true },
    { position: "SG", count: 1, isStarter: true },
    { position: "UTIL", count: 2, isStarter: true },
    { position: "BENCH", count: 2, isStarter: false },
  ],
};

// Twelve players: a mix of distinct values plus an exact-tie pair (p-tie-a /
// p-tie-b share every stat) to prove id tie-breaking is order-independent.
const PLAYER_DEFS = [
  { playerId: "p-alpha", pts: 27, reb: 7, ast: 7, tov: 3.5, games: 72, adp: 4 },
  { playerId: "p-bravo", pts: 24, reb: 6, ast: 5, tov: 2.8, games: 74, adp: 9 },
  { playerId: "p-charlie", pts: 22, reb: 8, ast: 3, tov: 2.1, games: 68, adp: 14 },
  { playerId: "p-delta", pts: 20, reb: 5, ast: 5, tov: 2.0, games: 70, adp: 22 },
  { playerId: "p-echo", pts: 19, reb: 9, ast: 2, tov: 1.8, games: 75, adp: 30 },
  { playerId: "p-foxtrot", pts: 18, reb: 6, ast: 4, tov: 2.0, games: 70, adp: 36 },
  { playerId: "p-golf", pts: 17, reb: 5, ast: 6, tov: 2.4, games: 66, adp: 44 },
  { playerId: "p-hotel", pts: 16, reb: 7, ast: 3, tov: 1.5, games: 71, adp: 52 },
  { playerId: "p-india", pts: 15, reb: 4, ast: 5, tov: 1.9, games: 69, adp: 60 },
  { playerId: "p-juliet", pts: 14, reb: 6, ast: 2, tov: 1.2, games: 73, adp: 68 },
  { playerId: "p-tie-a", pts: 21, reb: 6, ast: 4, tov: 2.0, games: 70, adp: 18 },
  { playerId: "p-tie-b", pts: 21, reb: 6, ast: 4, tov: 2.0, games: 70, adp: 18 },
] as const;

const PROJECTIONS: EngineProjection[] = PLAYER_DEFS.map((def) =>
  projection({
    playerId: def.playerId,
    pts: def.pts,
    reb: def.reb,
    ast: def.ast,
    tov: def.tov,
    games: def.games,
  }),
);

const METAS: EnginePlayerMeta[] = PLAYER_DEFS.map((def, index) =>
  meta({
    playerId: def.playerId,
    displayName: `Player ${def.playerId}`,
    eligiblePositions: index % 3 === 0 ? ["PG", "SG"] : ["SG", "SF"],
  }),
);

const ADP: EngineAdpEntry[] = PLAYER_DEFS.map((def, index) => ({
  playerId: def.playerId,
  adp: def.adp,
  rank: index + 1,
  sourcesCount: 3,
}));

const DRAFTED: EngineAssignment[] = [
  { playerId: "p-juliet", teamSlot: 2, slotPosition: "SG" },
  { playerId: "p-india", teamSlot: 3, slotPosition: "UTIL" },
];

function baseInput(): EngineInput {
  return {
    settings: SETTINGS,
    projectionRunId: "run-order-stability",
    modelVersion: "baseline-weighted-historical@1.0.0",
    projections: [...PROJECTIONS],
    players: [...METAS],
    adp: [...ADP],
    draftedAssignments: [...DRAFTED],
    nextOverallPick: 8,
    picksUntilUserTurn: 2,
    includeUnsigned: false,
    engineSeed: 987654321,
  };
}

/** Deterministic Fisher-Yates shuffle driven by a fixed mulberry32 stream. */
function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

function top3Ids(input: EngineInput): string[] {
  return recommend(input).top3.map((entry) => entry.playerId);
}

describe("recommendation input-order stability (Phase 3F)", () => {
  it("produces identical top-3 order for any permutation of input arrays", () => {
    const expected = top3Ids(baseInput());
    expect(expected).toHaveLength(3);
    const permutations: (() => EngineInput)[] = [
      // Exact reversal of every collection.
      () => ({
        ...baseInput(),
        projections: [...PROJECTIONS].reverse(),
        players: [...METAS].reverse(),
        adp: [...ADP].reverse(),
        draftedAssignments: [...DRAFTED].reverse(),
      }),
      // Rotation by a third.
      () => ({
        ...baseInput(),
        projections: [...PROJECTIONS.slice(4), ...PROJECTIONS.slice(0, 4)],
        players: [...METAS.slice(4), ...METAS.slice(0, 4)],
        adp: [...ADP.slice(4), ...ADP.slice(0, 4)],
      }),
      // Three deterministic shuffles with different streams.
      ...[11, 77, 4242].map((seed) => () => {
        const order = shuffled(
          PROJECTIONS.map((p) => p.playerId),
          seed,
        );
        const byId = new Map(order.map((id, index) => [id, index] as const));
        const byRank = (a: { playerId: string }, b: { playerId: string }): number =>
          (byId.get(a.playerId) ?? 0) - (byId.get(b.playerId) ?? 0);
        return {
          ...baseInput(),
          projections: [...PROJECTIONS].sort(byRank),
          players: [...METAS].sort(byRank),
          adp: [...ADP].sort(byRank),
          draftedAssignments: [...DRAFTED].sort(byRank),
        };
      }),
    ];
    for (const build of permutations) {
      expect(top3Ids(build())).toEqual(expected);
    }
  });

  it("keeps the full pool order and input checksum identical across permutations", () => {
    const first = recommend(baseInput());
    const permuted = recommend({
      ...baseInput(),
      projections: [...PROJECTIONS].reverse(),
      players: [...METAS].reverse(),
      adp: [...ADP].reverse(),
      draftedAssignments: [...DRAFTED].reverse(),
    });
    expect(permuted.inputChecksum).toBe(first.inputChecksum);
    expect(permuted.pool.map((entry) => entry.playerId)).toEqual(
      first.pool.map((entry) => entry.playerId),
    );
    expect(JSON.stringify(permuted.top3)).toBe(JSON.stringify(first.top3));
  });

  it("ranks an exact-tie pair identically however the inputs arrive", () => {
    // NOTE: identical-stat players may still receive different lookahead
    // bonuses (the rollout consumes a shared sequential RNG in canonical
    // processing order), so no specific direction is asserted here — only
    // that the relative order is a pure function of the logical snapshot,
    // never of array positions. Test 1 above pins full top-3 equality.
    const forward = recommend(baseInput());
    const poolOrder = forward.pool.map((entry) => entry.playerId);
    const tieA = poolOrder.indexOf("p-tie-a");
    const tieB = poolOrder.indexOf("p-tie-b");
    expect(tieA).toBeGreaterThanOrEqual(0);
    expect(tieB).toBeGreaterThanOrEqual(0);
    const reversed = recommend({
      ...baseInput(),
      projections: [...PROJECTIONS].reverse(),
      players: [...METAS].reverse(),
      adp: [...ADP].reverse(),
    });
    const reversedOrder = reversed.pool.map((entry) => entry.playerId);
    expect(Math.sign(reversedOrder.indexOf("p-tie-a") - reversedOrder.indexOf("p-tie-b"))).toBe(
      Math.sign(tieA - tieB),
    );
  });

  it("canonicalizes arrays of plain objects independent of order", () => {
    const left = canonicalize({ players: [{ id: "b" }, { id: "a" }] });
    const right = canonicalize({ players: [{ id: "a" }, { id: "b" }] });
    expect(right).toBe(left);
    // Arrays of primitives keep positional meaning (e.g. ordered slot lists).
    expect(canonicalize({ slots: ["PG", "SG"] })).not.toBe(canonicalize({ slots: ["SG", "PG"] }));
  });
});
