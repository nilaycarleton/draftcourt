import { describe, expect, it } from "vitest";
import {
  canonicalize,
  categoryUtility,
  checksumInput,
  percentageImpacts,
  defaultWeights,
  ENGINE_VERSION,
  recommend,
  seasonFantasyPoints,
  type EngineInput,
  type EnginePlayerMeta,
  type EngineProjection,
} from "./recommendation";

/**
 * Golden + property tests for the deterministic recommendation engine
 * (BUILD_SPEC.md sections 6 and 16.1): score bounds, formula behavior
 * (points blend, volume-aware percentages, lower-is-better, punts),
 * availability simulation bounds/reproducibility, lookahead cap, labels,
 * explanations, and canonical checksum stability.
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

const RULES = [
  { stat: "PTS", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
  { stat: "REB", weight: 1.2, direction: "HIGHER_BETTER", enabled: true, punt: false },
  { stat: "AST", weight: 1.5, direction: "HIGHER_BETTER", enabled: true, punt: false },
  { stat: "TOV", weight: -1, direction: "LOWER_BETTER", enabled: true, punt: false },
];

const SETTINGS = {
  season: "2026-27",
  type: "POINTS" as const,
  horizon: "REDRAFT" as const,
  teamCount: 12,
  rounds: 13,
  userDraftSlot: 4,
  scoringRules: RULES,
  rosterSlots: [
    { position: "PG", count: 1, isStarter: true },
    { position: "SG", count: 1, isStarter: true },
    { position: "UTIL", count: 1, isStarter: true },
    { position: "BENCH", count: 2, isStarter: false },
  ],
};

const PLAYERS = [
  { playerId: "p-star", pts: 27, reb: 7, ast: 7, tov: 3.5, games: 72 },
  { playerId: "p-solid", pts: 20, reb: 5, ast: 5, tov: 2 },
  { playerId: "p-young", pts: 14, reb: 4, ast: 3, tov: 1.6 },
  { playerId: "p-injury", pts: 22, injuryRisk: 0.7, games: 45 },
  { playerId: "p-vet", pts: 12, age: 36, consistency: 0.9, injuryRisk: 0.08 },
].map((over) => {
  const { playerId, ...rest } = over as Record<string, unknown> & { playerId: string };
  return projection({ playerId, ...rest });
});

const METAS = [
  meta({ playerId: "p-star", displayName: "Star Guard", eligiblePositions: ["PG", "SG"] }),
  meta({ playerId: "p-solid", displayName: "Solid Wing" }),
  meta({ playerId: "p-young", displayName: "Young Prospect", age: 20 }),
  meta({ playerId: "p-injury", displayName: "Injured Star" }),
  meta({ playerId: "p-vet", displayName: "Old Vet" }),
];

function baseInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    settings: SETTINGS,
    projectionRunId: "run-test-1",
    modelVersion: "baseline-weighted-historical@1.0.0",
    projections: PLAYERS,
    players: METAS,
    adp: [
      { playerId: "p-star", adp: 6, rank: 6, sourcesCount: 3 },
      { playerId: "p-solid", adp: 30, rank: 30, sourcesCount: 2 },
      { playerId: "p-injury", adp: 10, rank: 10, sourcesCount: 2 },
      { playerId: "p-vet", adp: 90, rank: 90, sourcesCount: 1 },
    ],
    draftedAssignments: [],
    nextOverallPick: 4,
    picksUntilUserTurn: 3,
    includeUnsigned: false,
    engineSeed: 12345,
    ...overrides,
  };
}

describe("recommendation engine", () => {
  it("is byte-deterministic for the same snapshot and seed", () => {
    const first = JSON.stringify(recommend(baseInput()));
    const second = JSON.stringify(recommend(baseInput()));
    expect(second).toBe(first);
  });

  it("keeps every score within 0–100 and produces exactly three top picks", () => {
    const output = recommend(baseInput());
    expect(output.top3).toHaveLength(3);
    for (const entry of output.pool) {
      expect(entry.draftScore).toBeGreaterThanOrEqual(0);
      expect(entry.draftScore).toBeLessThanOrEqual(100);
      expect(Number.isFinite(entry.draftScore)).toBe(true);
      expect(entry.availabilityNextPick).toBeGreaterThanOrEqual(0);
      expect(entry.availabilityNextPick).toBeLessThanOrEqual(1);
    }
  });

  it("excludes drafted, retired, and unsigned-unless-enabled players", () => {
    const withDrafted = recommend(
      baseInput({
        draftedAssignments: [{ playerId: "p-star", teamSlot: 2, slotPosition: "SG" }],
        players: [
          ...METAS,
          meta({ playerId: "p-retired", status: "RETIRED" }),
          meta({ playerId: "p-unsigned", status: "UNSIGNED" }),
        ],
        projections: [
          ...PLAYERS,
          projection({ playerId: "p-retired" }),
          projection({ playerId: "p-unsigned" }),
        ],
      }),
    );
    const ids = withDrafted.pool.map((entry) => entry.playerId);
    expect(ids).not.toContain("p-star");
    expect(ids).not.toContain("p-retired");
    expect(ids).not.toContain("p-unsigned");

    const unsignedAllowed = recommend(
      baseInput({
        players: [...METAS, meta({ playerId: "p-unsigned", status: "UNSIGNED" })],
        projections: [...PLAYERS, projection({ playerId: "p-unsigned" })],
        includeUnsigned: true,
      }),
    );
    expect(unsignedAllowed.pool.map((e) => e.playerId)).toContain("p-unsigned");
  });

  it("excludes players with no legal roster slot left (league-wide inventory)", () => {
    // Regression test: the engine recommended a center-only player when
    // every C slot AND every BENCH slot in the league was already filled —
    // the pick then correctly failed server-side as illegal. Eligibility
    // must mirror the transactional authority's league-wide inventory
    // (slot.count × teamCount minus fills) and its slot preference order.
    // SETTINGS: SG slots 12, UTIL 12, BENCH 24 league-wide. Fill SG+UTIL+24
    // bench assignments so a C-only player has nowhere legal to go, while a
    // flexible G-eligible player still fits nothing either — only add one
    // open UTIL-capable guard to keep the pool non-empty.
    const assignments = [
      ...Array.from({ length: 12 }, (_, index) => ({
        playerId: `sg-${String(index)}`,
        teamSlot: (index % 12) + 1,
        slotPosition: "SG",
      })),
      ...Array.from({ length: 12 }, (_, index) => ({
        playerId: `util-${String(index)}`,
        teamSlot: (index % 12) + 1,
        slotPosition: "UTIL",
      })),
      ...Array.from({ length: 24 }, (_, index) => ({
        playerId: `bench-${String(index)}`,
        teamSlot: (index % 12) + 1,
        slotPosition: "BENCH",
      })),
    ];
    const extraPlayers = [
      ...assignments.map((a) =>
        meta({ playerId: a.playerId, displayName: a.playerId, eligiblePositions: ["SG"] }),
      ),
      meta({ playerId: "p-center", displayName: "Center Only", eligiblePositions: ["C"] }),
    ];
    const extraProjections = [
      ...assignments.map((a) => projection({ playerId: a.playerId })),
      projection({ playerId: "p-center", pts: 30 }),
    ];
    const result = recommend(
      baseInput({
        draftedAssignments: assignments,
        players: [...METAS, ...extraPlayers],
        projections: [...PLAYERS, ...extraProjections],
      }),
    );
    expect(result.pool.map((entry) => entry.playerId)).not.toContain("p-center");
  });

  it("weights follow reciprocal rank and sum to 1", () => {
    const weights = defaultWeights();
    const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
    expect(weights.production).toBeGreaterThan(weights.scarcity);
    expect(weights.scarcity).toBeGreaterThan(weights.rosterNeed);
  });

  it("points-league fantasy points apply weights including negative turnover weight", () => {
    const line = projection({ playerId: "x", pts: 100, reb: 50, ast: 40, tov: 20 });
    // 100*1 + 50*1.2 + 40*1.5 - 20*1 = 200
    expect(seasonFantasyPoints(line, RULES)).toBeCloseTo(200, 5);
  });

  it("category utility flips sign for LOWER_BETTER and zeroes punts", () => {
    const rules = [
      { stat: "TOV", weight: 1, direction: "LOWER_BETTER", enabled: true, punt: false },
      { stat: "PTS", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
      { stat: "REB", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: true },
    ];
    // Projections carry SEASON TOTALS; 70-game default -> per-game
    // turnovers of 1.0 (A) vs 4.0 (B).
    const lineA = projection({ playerId: "a", tov: 70, pts: 1400, reb: 700 });
    const lineB = projection({ playerId: "b", tov: 280, pts: 1400, reb: 700 });
    const utilA = categoryUtility(lineA, rules);
    const utilB = categoryUtility(lineB, rules);
    // A's lower turnovers add MORE utility (sign flipped), punts contribute 0.
    expect(utilA - utilB).toBeCloseTo(3 * 1 * Math.sqrt(70 / 82), 5);
  });

  it("volume-aware percentage impact punts empty-volume specialists", () => {
    // High FG% on tiny volume must NOT beat a big who attempts real shots:
    // fgImpact = FGM - 0.45 x FGA (per game).
    const big = projection({ playerId: "big", fga: 12, fgm: 7 }); // 58%, +1.6
    const spec = projection({ playerId: "spec", fga: 2, fgm: 1.3 }); // 65%, -0.05... wait
    const bigImpact = percentageImpacts(toStatLine(big)).fgImpact;
    const specImpact = percentageImpacts(toStatLine(spec)).fgImpact;
    expect(bigImpact).toBeGreaterThan(specImpact);
  });

  it("checksum is stable under object-key order changes but sensitive to content", () => {
    const left = canonicalize({ b: 1, a: [3, 1, { y: 2, x: 1 }] });
    const right = canonicalize({ a: [3, 1, { x: 1, y: 2 }], b: 1 });
    expect(checksumInput(left)).toBe(checksumInput(right));
    const changed = canonicalize({ b: 2, a: [3, 1, { y: 2, x: 1 }] });
    expect(checksumInput(changed)).not.toBe(checksumInput(left));
  });

  it("labels the top three and explains using real components", () => {
    const output = recommend(baseInput());
    expect(output.top3.every((entry) => entry.explanation.length > 10)).toBe(true);
    const allLabels = new Set(output.top3.flatMap((entry) => entry.labels));
    expect(allLabels.size).toBeGreaterThan(0);
    for (const label of allLabels) {
      expect(["BEST_OVERALL", "BEST_FIT", "BEST_VALUE", "HIGHEST_UPSIDE", "SAFEST_PICK"]).toContain(
        label,
      );
    }
    expect(output.engineVersion).toBe(ENGINE_VERSION);
    expect(output.inputChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lookahead bonus never exceeds its 10% cap", () => {
    const output = recommend(baseInput());
    for (const entry of output.pool) {
      expect(entry.lookaheadBonus).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("dynasty horizon shifts the age component toward younger players", () => {
    const redraft = recommend(baseInput({ settings: { ...SETTINGS, horizon: "REDRAFT" } }));
    const dynasty = recommend(baseInput({ settings: { ...SETTINGS, horizon: "DYNASTY" } }));
    const youngRedraft = redraft.pool.find((e) => e.playerId === "p-young");
    const youngDynasty = dynasty.pool.find((e) => e.playerId === "p-young");
    expect(youngRedraft && youngDynasty).toBeTruthy();
    if (!youngRedraft || !youngDynasty) throw new Error("pool entries missing");
    const ageRedraft = youngRedraft.components.find((c) => c.key === "age");
    const ageDynasty = youngDynasty.components.find((c) => c.key === "age");
    if (!ageRedraft || !ageDynasty) throw new Error("age components missing");
    expect(ageDynasty.normalized).toBeGreaterThan(ageRedraft.normalized);
  });
});

function toStatLine(p: EngineProjection) {
  const games = Math.max(1, p.games);
  return {
    pts: p.pts / games,
    reb: p.reb / games,
    ast: p.ast / games,
    stl: p.stl / games,
    blk: p.blk / games,
    tov: p.tov / games,
    fgm: p.fgm / games,
    fga: p.fga / games,
    ftm: p.ftm / games,
    fta: p.fta / games,
    threePm: p.threePm / games,
  };
}
