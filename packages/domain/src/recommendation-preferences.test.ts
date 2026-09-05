import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  defaultWeights,
  recommend,
  type EngineInput,
  type EnginePlayerMeta,
  type EngineProjection,
  type PoolEntry,
} from "./recommendation";
import type { EnginePreferences, SnapshotPlayerListType } from "./recommendation-snapshot";
import type { AvoidMode, PreferenceFactorKey } from "./preferences";

/**
 * Phase 3B preference-integration tests for the recommendation engine:
 * legacy byte-determinism gates, canonical checksum behavior, signed
 * preference terms, hard-avoid exclusion/fallback, scalar modulation,
 * advisory warnings, and bounded-score properties under arbitrary valid
 * preference snapshots.
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

const PLAYER_IDS = ["p-star", "p-solid", "p-young", "p-injury", "p-vet"];

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

/** Exact Phase 2 default weights (not the snapshot-rounded variant) so
 * contribution comparisons against the no-preferences run are byte-equal. */
const LEGACY_WEIGHTS: Record<PreferenceFactorKey, number> = (() => {
  const all = defaultWeights();
  return {
    production: all.production,
    scarcity: all.scarcity,
    rosterNeed: all.rosterNeed,
    risk: all.risk,
    consistency: all.consistency,
    age: all.age,
    adpValue: all.adpValue,
    upside: all.upside,
    role: all.role,
    nextPickAvailability: all.nextPickAvailability,
    preference: all.preference,
  };
})();

function basePreferences(): EnginePreferences {
  return {
    snapshotVersion: 1,
    preferenceSchemaVersion: 1,
    factorWeights: { ...LEGACY_WEIGHTS },
    riskTolerance: 0.5,
    upsidePriority: 0.5,
    youthBias: 0,
    roleMinutesPriority: 0.5,
    schedule: { enabled: false, playoffWeeks: null },
    positionPriorities: [],
    categoryPriorities: [],
    puntStats: [],
    avoidMode: "EXCLUDE",
    playerEntries: {},
    teamEntries: {},
    customRanks: {},
  };
}

function prefComponent(entry: PoolEntry): PoolEntry["components"][number] {
  const component = entry.components.find((c) => c.key === "preference");
  if (!component) throw new Error("preference component missing");
  return component;
}

function componentOf(entry: PoolEntry | undefined, key: string): PoolEntry["components"][number] {
  const component = entry?.components.find((c) => c.key === key);
  if (!component) throw new Error(`${key} component missing`);
  return component;
}

function byId(output: { pool: PoolEntry[] }, playerId: string): PoolEntry {
  const entry = output.pool.find((e) => e.playerId === playerId);
  if (!entry) throw new Error(`pool entry missing: ${playerId}`);
  return entry;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe("recommendation preferences — golden/determinism", () => {
  it("legacy path is byte-identical across runs and omission forms", () => {
    const omitted = baseInput();
    const explicitUndefined = baseInput();
    explicitUndefined.preferences = undefined;

    const firstRun = JSON.stringify(recommend(omitted));
    expect(JSON.stringify(recommend(baseInput()))).toBe(firstRun);
    expect(JSON.stringify(recommend(explicitUndefined))).toBe(firstRun);

    expect(recommend(omitted).inputChecksum).toBe(recommend(explicitUndefined).inputChecksum);

    const frozenExpected = deepFreeze(JSON.parse(firstRun));
    expect(JSON.parse(JSON.stringify(recommend(omitted)))).toEqual(frozenExpected);

    for (const entry of recommend(omitted).pool) {
      expect(entry.warnings).toBeUndefined();
    }
  });

  it("same input plus preferences twice produces byte-identical output", () => {
    const prefs = basePreferences();
    prefs.playerEntries["p-star"] = { listType: "FAVORITE", magnitude: 0.8 };
    prefs.positionPriorities = [{ position: "SG", priority: 0.7 }];
    prefs.customRanks = { "p-solid": 1 };

    const input = baseInput({ preferences: prefs });
    const first = JSON.stringify(recommend(input));
    expect(JSON.stringify(recommend(baseInput({ preferences: prefs })))).toBe(first);
  });

  it("checksum reacts to any single meaningful preference change", () => {
    const baselinePrefs = basePreferences();
    baselinePrefs.positionPriorities = [{ position: "PG", priority: 0.5 }];
    baselinePrefs.categoryPriorities = [{ stat: "PTS", weight: 0.8 }];
    const baselineChecksum = recommend(baseInput({ preferences: baselinePrefs })).inputChecksum;

    const weights = basePreferences();
    weights.positionPriorities = [{ position: "PG", priority: 0.5 }];
    weights.categoryPriorities = [{ stat: "PTS", weight: 0.8 }];
    weights.factorWeights = { ...weights.factorWeights, production: 0.26 };
    expect(recommend(baseInput({ preferences: weights })).inputChecksum).not.toBe(baselineChecksum);

    const magnitude = basePreferences();
    magnitude.playerEntries["p-star"] = { listType: "FAVORITE", magnitude: 0.4 };
    expect(recommend(baseInput({ preferences: magnitude })).inputChecksum).not.toBe(
      recommend(baseInput({ preferences: { ...magnitude, playerEntries: {} } })).inputChecksum,
    );

    const rank = basePreferences();
    rank.customRanks = { "p-solid": 2 };
    const rankOther = { ...rank, customRanks: { "p-solid": 3 } };
    expect(recommend(baseInput({ preferences: rank })).inputChecksum).not.toBe(
      recommend(baseInput({ preferences: rankOther })).inputChecksum,
    );

    const severe = basePreferences();
    severe.avoidMode = "SEVERE_PENALTY";
    expect(recommend(baseInput({ preferences: severe })).inputChecksum).not.toBe(
      recommend(baseInput({ preferences: basePreferences() })).inputChecksum,
    );

    const scheduled = basePreferences();
    scheduled.schedule = { enabled: true, playoffWeeks: null };
    expect(recommend(baseInput({ preferences: scheduled })).inputChecksum).not.toBe(
      recommend(baseInput({ preferences: basePreferences() })).inputChecksum,
    );
  });

  it("canonically equivalent reorderings yield identical checksum and output", () => {
    const a = basePreferences();
    a.positionPriorities = [
      { position: "PG", priority: 0.6 },
      { position: "C", priority: 0.9 },
    ];
    a.categoryPriorities = [
      { stat: "PTS", weight: 0.9 },
      { stat: "TOV", weight: 0 },
    ];
    a.puntStats = ["TOV", "BLK"];
    a.playerEntries = {
      "p-star": { listType: "FAVORITE", magnitude: 0.7 },
      "p-vet": { listType: "DISLIKED", magnitude: -0.5 },
    };
    a.teamEntries = {
      t1: { type: "FAVORITE", magnitude: 0.5 },
      t2: { type: "DISLIKED", magnitude: -0.3 },
    };
    a.customRanks = { "p-solid": 1, "p-young": 4 };

    const outA = JSON.stringify(recommend(baseInput({ preferences: a })));
    const b = basePreferences();
    b.positionPriorities = [...a.positionPriorities].reverse();
    b.categoryPriorities = [...a.categoryPriorities].reverse();
    b.puntStats = [...a.puntStats].reverse();
    b.playerEntries = {
      "p-vet": { listType: "DISLIKED", magnitude: -0.5 },
      "p-star": { listType: "FAVORITE", magnitude: 0.7 },
    };
    b.teamEntries = {
      t2: { type: "DISLIKED", magnitude: -0.3 },
      t1: { type: "FAVORITE", magnitude: 0.5 },
    };
    b.customRanks = { "p-young": 4, "p-solid": 1 };

    const outB = JSON.stringify(recommend(baseInput({ preferences: b })));
    expect(outB).toBe(outA);
    expect(recommend(baseInput({ preferences: b })).inputChecksum).toBe(
      recommend(baseInput({ preferences: a })).inputChecksum,
    );
  });
});

describe("recommendation preferences — bounds/properties", () => {
  it("arbitrary valid preference snapshots keep scores finite, bounded, and signed-bounded", () => {
    const double01 = fc.double({ min: 0, max: 1, noNaN: true });
    const signedMagnitude = (listType: SnapshotPlayerListType): fc.Arbitrary<number> =>
      fc
        .double({ min: 0.05, max: 1, noNaN: true })
        .map((m) => (listType === "DISLIKED" || listType === "AVOID" ? -m : m));
    const entryArb = fc
      .constantFrom<SnapshotPlayerListType>("FAVORITE", "DISLIKED", "TARGET", "AVOID")
      .chain((listType) =>
        fc.record({ listType: fc.constant(listType), magnitude: signedMagnitude(listType) }),
      );
    const optionalEntries = fc.tuple(...PLAYER_IDS.map(() => fc.option(entryArb, { nil: null })));

    const prefsArb: fc.Arbitrary<EnginePreferences> = fc.record({
      snapshotVersion: fc.constant(1),
      preferenceSchemaVersion: fc.constant(1),
      factorWeights: fc.record({
        production: double01,
        scarcity: double01,
        rosterNeed: double01,
        risk: double01,
        consistency: double01,
        age: double01,
        adpValue: double01,
        upside: double01,
        role: double01,
        nextPickAvailability: double01,
        preference: double01,
      }),
      riskTolerance: double01,
      upsidePriority: double01,
      youthBias: fc.double({ min: -1, max: 1, noNaN: true }),
      roleMinutesPriority: double01,
      schedule: fc.record({
        enabled: fc.boolean(),
        playoffWeeks: fc.option(fc.integer({ min: 1, max: 14 }), { nil: null }),
      }),
      positionPriorities: fc.array(
        fc.record({
          position: fc.constantFrom("PG", "SG", "SF", "PF", "C"),
          priority: double01,
        }),
        { maxLength: 5 },
      ),
      categoryPriorities: fc.array(
        fc.record({
          stat: fc.constantFrom(
            "PTS",
            "REB",
            "AST",
            "STL",
            "BLK",
            "TOV",
            "THREE_PM",
            "FG_PCT",
            "FT_PCT",
          ),
          weight: double01,
        }),
        { maxLength: 4 },
      ),
      puntStats: fc.constant([]),
      avoidMode: fc.constantFrom<AvoidMode>("EXCLUDE", "SEVERE_PENALTY"),
      playerEntries: optionalEntries.map((slots) => {
        const record: EnginePreferences["playerEntries"] = {};
        slots.forEach((slot, index) => {
          const playerId = PLAYER_IDS[index];
          if (slot !== null && playerId !== undefined) record[playerId] = slot;
        });
        return record;
      }),
      teamEntries: fc.constant({}),
      customRanks: fc.dictionary(fc.constantFrom(...PLAYER_IDS), fc.integer({ min: 1, max: 12 })),
    });

    fc.assert(
      fc.property(prefsArb, (prefs) => {
        const output = recommend(baseInput({ preferences: prefs }));
        expect(output.top3).toHaveLength(3);
        for (const entry of output.pool) {
          expect(Number.isFinite(entry.draftScore)).toBe(true);
          expect(entry.draftScore).toBeGreaterThanOrEqual(0);
          expect(entry.draftScore).toBeLessThanOrEqual(100);
          for (const comp of entry.components) {
            for (const value of [comp.raw, comp.normalized, comp.weight, comp.contribution]) {
              expect(Number.isFinite(value)).toBe(true);
            }
          }
          const pref = prefComponent(entry);
          expect(Math.abs(pref.normalized)).toBeLessThanOrEqual(1 + 1e-12);
          expect(Math.abs(pref.contribution)).toBeLessThanOrEqual(0.1 + 1e-9);
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe("recommendation preferences — regression matrix", () => {
  it("hard avoids exclude the player from the pool under EXCLUDE", () => {
    const prefs = basePreferences();
    prefs.playerEntries["p-star"] = { listType: "AVOID", magnitude: -1 };
    const output = recommend(baseInput({ preferences: prefs }));
    expect(output.pool.map((e) => e.playerId)).not.toContain("p-star");
    expect(output.pool).toHaveLength(4);
  });

  it("severe-penalty avoids keep the player legal with bounded negative impact", () => {
    const prefs = basePreferences();
    prefs.avoidMode = "SEVERE_PENALTY";
    prefs.playerEntries["p-star"] = { listType: "AVOID", magnitude: -1 };
    const output = recommend(baseInput({ preferences: prefs }));
    const star = byId(output, "p-star");
    const pref = prefComponent(star);
    expect(pref.normalized).toBe(-1);
    expect(pref.contribution).toBeLessThan(0);
    expect(pref.contribution).toBeGreaterThanOrEqual(-0.1 - 1e-9);
    expect(star.draftScore).toBeGreaterThanOrEqual(0);
  });

  it("avoiding every pool player under EXCLUDE falls back with warnings on affected entries", () => {
    const prefs = basePreferences();
    for (const id of PLAYER_IDS) {
      prefs.playerEntries[id] = { listType: "AVOID", magnitude: -0.5 };
    }
    const output = recommend(baseInput({ preferences: prefs }));
    expect(output.top3).toHaveLength(3);
    expect(output.pool).toHaveLength(PLAYER_IDS.length);
    for (const entry of output.top3) {
      expect(entry.warnings).toContain(
        "Your avoid list would empty the eligible pool — severe penalties applied instead.",
      );
    }
  });

  it("a TARGET cannot bypass roster legality", () => {
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
    const prefs = basePreferences();
    prefs.playerEntries["p-center"] = { listType: "TARGET", magnitude: 1 };
    const result = recommend(
      baseInput({
        draftedAssignments: assignments,
        players: [...METAS, ...extraPlayers],
        projections: [...PLAYERS, ...extraProjections],
        preferences: prefs,
      }),
    );
    expect(result.pool.map((entry) => entry.playerId)).not.toContain("p-center");
  });

  it("two same-team favorites are scored identically with no stacking penalty", () => {
    const players = METAS.map((m) =>
      m.playerId === "p-star" || m.playerId === "p-solid" ? { ...m, nbaTeamId: "BOS" as const } : m,
    );
    const shared = basePreferences();
    shared.teamEntries = { BOS: { type: "FAVORITE", magnitude: 0.4 } };
    shared.playerEntries = {
      "p-star": { listType: "FAVORITE", magnitude: 0.5 },
      "p-solid": { listType: "FAVORITE", magnitude: 0.5 },
    };
    const isolated = {
      ...shared,
      teamEntries: {},
      playerEntries: { ...shared.playerEntries },
    };

    const withTeam = recommend(baseInput({ players, preferences: shared }));
    const withoutTeam = recommend(baseInput({ players, preferences: isolated }));

    const starWith = prefComponent(byId(withTeam, "p-star")).normalized;
    const solidWith = prefComponent(byId(withTeam, "p-solid")).normalized;
    const starWithout = prefComponent(byId(withoutTeam, "p-star")).normalized;
    const solidWithout = prefComponent(byId(withoutTeam, "p-solid")).normalized;

    expect(starWith).toBe(solidWith);
    expect(starWithout).toBe(solidWithout);
    expect(starWith).toBe(starWithout + 0.4);
    expect(withTeam.top3.some((e) => e.playerId === "p-star")).toBe(true);
    expect(withTeam.top3.some((e) => e.playerId === "p-solid")).toBe(true);
  });

  it("custom-rank delta is strictly monotonic in rank and bounded", () => {
    const runForRank = (rank: number): number => {
      const prefs = basePreferences();
      prefs.customRanks = {
        "p-solid": rank,
        "p-young": rank + 1 <= 5 ? 5 : 4,
      };
      return prefComponent(byId(recommend(baseInput({ preferences: prefs })), "p-solid"))
        .normalized;
    };
    const better = runForRank(1);
    const worse = runForRank(3);
    expect(better).toBeGreaterThan(worse);
    expect(Math.abs(worse)).toBeLessThanOrEqual(1);
  });

  it("uses the resolved customRanks record exactly as provided", () => {
    const prefs = basePreferences();
    prefs.customRanks = { "p-solid": 2 };
    const output = recommend(baseInput({ preferences: prefs }));
    const expectedDelta = Math.min(1, Math.max(-1, ((1 + 1) / 2 - 2) / 24));
    expect(prefComponent(byId(output, "p-solid")).normalized).toBe(expectedDelta);
    const untouched = prefComponent(byId(output, "p-star"));
    expect(untouched.raw).toBe(0);
    expect(untouched.reason).toBe("your preference lists did not move this player");
  });

  it("category priorities and punts affect only the preference component", () => {
    const scoringRulesBefore = JSON.stringify(SETTINGS.scoringRules);
    const prefs = basePreferences();
    prefs.categoryPriorities = [
      { stat: "PTS", weight: 1 },
      { stat: "TOV", weight: 0 },
    ];
    prefs.puntStats = ["TOV"];

    const personalized = recommend(baseInput({ preferences: prefs }));
    const legacy = recommend(baseInput());

    expect(JSON.stringify(SETTINGS.scoringRules)).toBe(scoringRulesBefore);
    for (const entry of personalized.pool) {
      const other = legacy.pool.find((e) => e.playerId === entry.playerId);
      if (!other) throw new Error("pool mismatch");
      for (const key of ["production", "scarcity", "rosterNeed"]) {
        expect(componentOf(entry, key)).toEqual(componentOf(other, key));
      }
    }
    const moved = personalized.pool.some(
      (entry) => Math.abs(prefComponent(entry).normalized) > 1e-9,
    );
    expect(moved).toBe(true);
  });

  it("enabled schedule stays neutral with an honest reason string", () => {
    const disabled = basePreferences();
    const enabled = { ...basePreferences(), schedule: { enabled: true, playoffWeeks: null } };

    const offRun = recommend(baseInput({ preferences: disabled }));
    const onRun = recommend(baseInput({ preferences: enabled }));

    const offSchedule = componentOf(byId(offRun, "p-star"), "schedule");
    const onSchedule = componentOf(byId(onRun, "p-star"), "schedule");
    for (const schedule of [offSchedule, onSchedule]) {
      expect(schedule.normalized).toBe(0);
      expect(schedule.weight).toBe(0);
      expect(schedule.contribution).toBe(0);
    }
    expect(offSchedule.reason).toBe("off by default");
    expect(onSchedule.reason).toBe(
      "schedule enabled — playoff-week game data is not provided to the engine yet",
    );
    expect(onRun.pool.map((e) => e.draftScore)).toEqual(offRun.pool.map((e) => e.draftScore));
  });

  it("an extreme valid profile keeps every score within 0–100", () => {
    const prefs = basePreferences();
    prefs.factorWeights = {
      production: 0,
      scarcity: 0,
      rosterNeed: 0,
      risk: 0,
      consistency: 0,
      age: 0,
      adpValue: 0,
      upside: 0,
      role: 0,
      nextPickAvailability: 0,
      preference: 1,
    };
    prefs.riskTolerance = 1;
    prefs.upsidePriority = 1;
    prefs.youthBias = 1;
    prefs.roleMinutesPriority = 1;
    prefs.avoidMode = "SEVERE_PENALTY";
    prefs.positionPriorities = [
      { position: "PG", priority: 1 },
      { position: "SG", priority: 1 },
      { position: "SF", priority: 1 },
      { position: "PF", priority: 1 },
      { position: "C", priority: 1 },
    ];
    prefs.categoryPriorities = [
      { stat: "PTS", weight: 1 },
      { stat: "FG_PCT", weight: 1 },
      { stat: "MADE_UP", weight: 1 },
    ];
    prefs.customRanks = { "p-star": 1, "p-solid": 2, "p-young": 3, "p-injury": 4, "p-vet": 5 };
    prefs.teamEntries = { BOS: { type: "FAVORITE", magnitude: 1 } };
    prefs.playerEntries = {
      "p-star": { listType: "FAVORITE", magnitude: 1 },
      "p-injury": { listType: "AVOID", magnitude: -1 },
      "p-vet": { listType: "DISLIKED", magnitude: -1 },
    };
    const output = recommend(
      baseInput({
        preferences: prefs,
        players: METAS.map((m) => ({ ...m, nbaTeamId: "BOS" })),
      }),
    );
    for (const entry of output.pool) {
      expect(entry.draftScore).toBeGreaterThanOrEqual(0);
      expect(entry.draftScore).toBeLessThanOrEqual(100);
      expect(Number.isFinite(entry.draftScore)).toBe(true);
      expect(Math.abs(prefComponent(entry).contribution)).toBeLessThanOrEqual(0.1 + 1e-9);
    }
  });

  it("scalar modulation sanity: extremes flatten or amplify per formula; defaults reproduce legacy exactly", () => {
    const dynastySettings = { ...SETTINGS, horizon: "DYNASTY" as const };

    // High tolerance (1) = tolerant of risk = risk differences attenuate to
    // neutral; low tolerance (0) = risk-averse = safety spread amplifies.
    const flat = basePreferences();
    flat.riskTolerance = 1;
    const flatOutput = recommend(baseInput({ settings: dynastySettings, preferences: flat }));
    for (const entry of flatOutput.pool) {
      expect(componentOf(entry, "risk").normalized).toBe(0.5);
    }

    const amplified = basePreferences();
    amplified.riskTolerance = 0;
    const legacyDynasty = recommend(baseInput({ settings: dynastySettings }));
    const amplifiedOutput = recommend(
      baseInput({ settings: dynastySettings, preferences: amplified }),
    );
    const legacySpread = Math.max(
      ...legacyDynasty.pool.map((e) => Math.abs(componentOf(e, "risk").normalized - 0.5)),
    );
    const amplifiedSpread = Math.max(
      ...amplifiedOutput.pool.map((e) => Math.abs(componentOf(e, "risk").normalized - 0.5)),
    );
    expect(amplifiedSpread).toBeGreaterThan(legacySpread);

    const veteranFirst = basePreferences();
    veteranFirst.youthBias = -1;
    const inverted = recommend(baseInput({ settings: dynastySettings, preferences: veteranFirst }));
    const youngAge = componentOf(byId(inverted, "p-young"), "age").normalized;
    const vetAge = componentOf(byId(inverted, "p-vet"), "age").normalized;
    expect(youngAge).toBeLessThan(vetAge);
    const neutral = recommend(baseInput({ settings: dynastySettings }));
    expect(componentOf(byId(neutral, "p-young"), "age").normalized).toBeGreaterThan(
      componentOf(byId(neutral, "p-vet"), "age").normalized,
    );

    const defaults = basePreferences();
    defaults.riskTolerance = 0.5;
    const defaultsOutput = recommend(
      baseInput({ settings: dynastySettings, preferences: defaults }),
    );
    const keys = [
      "production",
      "scarcity",
      "rosterNeed",
      "risk",
      "consistency",
      "age",
      "adpValue",
      "upside",
      "role",
      "nextPickAvailability",
      "preference",
    ] as const;
    for (const entry of defaultsOutput.pool) {
      const other = legacyDynasty.pool.find((e) => e.playerId === entry.playerId);
      if (!other) throw new Error("pool mismatch");
      for (const key of keys) {
        expect(componentOf(entry, key).normalized).toBe(componentOf(other, key).normalized);
      }
    }
  });

  it("flags top-3 favorites whose market ADP is far beyond the current pick", () => {
    const prefs = basePreferences();
    prefs.playerEntries["p-star"] = { listType: "FAVORITE", magnitude: 1 };
    const input = baseInput({
      preferences: prefs,
      adp: [
        { playerId: "p-star", adp: 40, rank: 40, sourcesCount: 3 },
        { playerId: "p-solid", adp: 30, rank: 30, sourcesCount: 2 },
        { playerId: "p-injury", adp: 10, rank: 10, sourcesCount: 2 },
        { playerId: "p-vet", adp: 90, rank: 90, sourcesCount: 1 },
      ],
    });
    const output = recommend(input);
    const star = byId(output, "p-star");
    expect(output.top3.some((e) => e.playerId === "p-star")).toBe(true);
    expect(star.warnings).toContain(
      "Preference reach: market ADP 36 picks beyond your current pick.",
    );
    const control = byId(output, "p-solid");
    expect(control.warnings).toBeUndefined();
    expect(output.engineVersion).toBe("phase3-preferences-1.0.0");
  });
});
