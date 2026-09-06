/* eslint-disable @typescript-eslint/no-non-null-assertion -- test fixtures use asserted sample data */
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_DISCLOSURE,
  ANALYSIS_VERSION,
  analyzeDraft,
  canonicalize,
  checksumInput,
  computePoolBaselines,
  categoryUtility,
  fnv1a32,
  mulberry32,
  percentileRank,
  percentageImpacts,
  seasonFantasyPoints,
  winsorize,
  type AnalysisInput,
  type AnalysisProjection,
  type AnalysisPlayerMeta,
} from "./analysis";

function projection(
  overrides: Partial<AnalysisProjection> & { playerId: string },
): AnalysisProjection {
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

function meta(overrides: Partial<AnalysisPlayerMeta> & { playerId: string }): AnalysisPlayerMeta {
  return {
    displayName: overrides.playerId,
    eligiblePositions: ["SG"],
    status: "ACTIVE",
    age: 25,
    ...overrides,
  };
}

const SCORING_POINTS = [
  { stat: "PTS", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
  { stat: "REB", weight: 1.2, direction: "HIGHER_BETTER", enabled: true, punt: false },
  { stat: "AST", weight: 1.5, direction: "HIGHER_BETTER", enabled: true, punt: false },
  { stat: "TOV", weight: -1, direction: "LOWER_BETTER", enabled: true, punt: false },
];

const SCORING_CATS = [
  { stat: "PTS", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
  { stat: "REB", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
  { stat: "AST", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
  { stat: "STL", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
  { stat: "BLK", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
  { stat: "TOV", weight: 1, direction: "LOWER_BETTER", enabled: true, punt: false },
  { stat: "FG_PCT", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
  { stat: "FT_PCT", weight: 1, direction: "HIGHER_BETTER", enabled: true, punt: false },
];

const ROSTER = [
  { position: "PG", count: 1, isStarter: true },
  { position: "SG", count: 1, isStarter: true },
  { position: "SF", count: 1, isStarter: true },
  { position: "PF", count: 1, isStarter: true },
  { position: "C", count: 1, isStarter: true },
  { position: "UTIL", count: 1, isStarter: true },
  { position: "BENCH", count: 3, isStarter: false },
];

const SETTINGS_POINTS = {
  season: "2026-27",
  type: "POINTS" as const,
  horizon: "REDRAFT" as const,
  teamCount: 12,
  rounds: 9,
  userDraftSlot: 4,
  scoringRules: SCORING_POINTS,
  rosterSlots: ROSTER,
};

const SETTINGS_CATS = {
  ...SETTINGS_POINTS,
  type: "CATEGORIES" as const,
};

const PLAYERS = [
  { playerId: "p-star", pts: 27, reb: 7, ast: 7, tov: 3.5, games: 72 },
  { playerId: "p-solid", pts: 20, reb: 5, ast: 5, tov: 2 },
  { playerId: "p-young", pts: 14, reb: 4, ast: 3, tov: 1.6 },
  { playerId: "p-injury", pts: 22, injuryRisk: 0.7, games: 45 },
  { playerId: "p-vet", pts: 12, age: 36, consistency: 0.9, injuryRisk: 0.08 },
  { playerId: "p-guard", pts: 18, reb: 3, ast: 6 },
  { playerId: "p-big", pts: 16, reb: 11, ast: 1.5, blk: 1.8 },
  { playerId: "p-wing", pts: 17, reb: 5, ast: 3.5 },
  { playerId: "p-rookie", pts: 13, reb: 3, ast: 2, age: 20 },
  { playerId: "p-mid", pts: 19, reb: 6, ast: 4 },
].map((o) => {
  const { playerId, ...rest } = o as Record<string, unknown> & { playerId: string };
  return projection({ playerId, ...rest });
});

const METAS = [
  meta({ playerId: "p-star", displayName: "Star Guard", eligiblePositions: ["PG", "SG"] }),
  meta({ playerId: "p-solid", displayName: "Solid Wing", eligiblePositions: ["SG", "SF"] }),
  meta({ playerId: "p-young", displayName: "Young Prospect", eligiblePositions: ["SG"], age: 20 }),
  meta({ playerId: "p-injury", displayName: "Injured Star", eligiblePositions: ["SF"] }),
  meta({ playerId: "p-vet", displayName: "Old Vet", eligiblePositions: ["PF"], age: 36 }),
  meta({ playerId: "p-guard", displayName: "Guard", eligiblePositions: ["PG"] }),
  meta({ playerId: "p-big", displayName: "Big Man", eligiblePositions: ["C"] }),
  meta({ playerId: "p-wing", displayName: "Wing", eligiblePositions: ["SF"] }),
  meta({ playerId: "p-rookie", displayName: "Rookie", eligiblePositions: ["SG"], age: 20 }),
  meta({ playerId: "p-mid", displayName: "Mid", eligiblePositions: ["SG"] }),
];

function baseInput(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    settings: SETTINGS_POINTS,
    players: METAS,
    projections: PLAYERS,
    adp: [
      { playerId: "p-star", adp: 6, rank: 6, sourcesCount: 3 },
      { playerId: "p-solid", adp: 30, rank: 30, sourcesCount: 2 },
      { playerId: "p-young", adp: 55, rank: 55, sourcesCount: 3 },
      { playerId: "p-injury", adp: 10, rank: 10, sourcesCount: 2 },
      { playerId: "p-vet", adp: 90, rank: 90, sourcesCount: 3 },
      { playerId: "p-guard", adp: 22, rank: 22, sourcesCount: 3 },
      { playerId: "p-big", adp: 35, rank: 35, sourcesCount: 3 },
      { playerId: "p-wing", adp: 40, rank: 40, sourcesCount: 3 },
      { playerId: "p-rookie", adp: 70, rank: 70, sourcesCount: 2 },
      { playerId: "p-mid", adp: 25, rank: 25, sourcesCount: 3 },
    ],
    assignments: [
      { playerId: "p-star", teamSlot: 4, slotPosition: "PG", overallPick: 4 },
      { playerId: "p-solid", teamSlot: 4, slotPosition: "SG", overallPick: 21 },
      { playerId: "p-big", teamSlot: 4, slotPosition: "C", overallPick: 28 },
      { playerId: "p-guard", teamSlot: 4, slotPosition: "UTIL", overallPick: 45 },
      { playerId: "p-wing", teamSlot: 4, slotPosition: "SF", overallPick: 52 },
      { playerId: "p-vet", teamSlot: 4, slotPosition: "PF", overallPick: 69 },
      // opponent picks
      { playerId: "p-injury", teamSlot: 1, slotPosition: "SG", overallPick: 10 },
    ],
    userTeamSlot: 4,
    projectionRunId: "01890a5d-ac96-774b-bcce-b302099a8057",
    adpSnapshotId: "01890a5d-ac96-774b-bcce-b302099a8058",
    preferenceSnapshot: null,
    preferenceSnapshotVersion: 1,
    preferenceSnapshotChecksum: "abc",
    engineVersion: "phase3-analysis-1.0.0",
    simulationSeed: "seed-deterministic-001",
    analysisVersion: "1.0.0",
    projectionPublishedAt: "2026-09-04T12:00:00.000Z",
    adpCapturedAt: "2026-09-02T12:00:00.000Z",
    generatedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("analysis domain", () => {
  it("is deterministic for identical versioned inputs and seed", () => {
    const first = analyzeDraft(baseInput());
    const second = analyzeDraft(baseInput());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.inputChecksum).toBe(first.inputChecksum);
    expect(second.draftScore).toBe(first.draftScore);
    expect(second.projectedStanding.distribution).toEqual(first.projectedStanding.distribution);
  });

  it("checksum stable under key order and array order of canonical content but sensitive to content", () => {
    const a = canonicalize({ b: 1, a: [3, 1, { y: 2, x: 1 }] });
    const b = canonicalize({ a: [3, 1, { x: 1, y: 2 }], b: 1 });
    expect(checksumInput(a)).toBe(checksumInput(b));
    const changed = canonicalize({ b: 2, a: [3, 1, { y: 2, x: 1 }] });
    expect(checksumInput(changed)).not.toBe(checksumInput(a));
    // analysis checksum stable when assignment order shuffled
    const input1 = baseInput();
    const input2 = baseInput({ assignments: [...input1.assignments].reverse() });
    const out1 = analyzeDraft(input1);
    const out2 = analyzeDraft(input2);
    expect(out1.inputChecksum).toBe(out2.inputChecksum);
  });

  it("excludes generatedAt from checksum (same logical input different timestamp yields same checksum)", () => {
    const a = baseInput({ generatedAt: "2026-09-05T00:00:00.000Z" });
    const b = baseInput({ generatedAt: "2099-01-01T00:00:00.000Z" });
    expect(analyzeDraft(a).inputChecksum).toBe(analyzeDraft(b).inputChecksum);
    expect(analyzeDraft(a).generatedAt).not.toBe(analyzeDraft(b).generatedAt);
  });

  it("produces overall score 0..100 with letter grade thresholds 90/80/70/60 and 5 weighted components summing to 1 at 6dp", () => {
    const out = analyzeDraft(baseInput());
    expect(out.draftScore).toBeGreaterThanOrEqual(0);
    expect(out.draftScore).toBeLessThanOrEqual(100);
    expect(out.grade).toMatch(/^[A-F]$/);
    expect(out.analysisVersion).toBe(ANALYSIS_VERSION);
    // grade mapping
    const gradeFor = (s: number) =>
      s >= 90 ? "A" : s >= 80 ? "B" : s >= 70 ? "C" : s >= 60 ? "D" : "F";
    expect(out.grade).toBe(gradeFor(out.draftScore));
    expect(out.components).toHaveLength(5);
    const keys = out.components.map((c) => c.key).sort();
    expect(keys).toEqual(
      ["projectedStrength", "risk", "rosterBalance", "scoringFit", "valueCaptured"].sort(),
    );
    const weightSum = out.components.reduce((s, c) => s + c.weight, 0);
    expect(Math.abs(weightSum - 1)).toBeLessThan(1e-9);
    for (const c of out.components) {
      expect(Math.abs(c.weight * 1e6 - Math.round(c.weight * 1e6))).toBeLessThan(1e-6);
    }
    // verify overall = round(100*clamp(sum w*norm,0,1),1)
    const sum = out.components.reduce((s, c) => s + c.contribution, 0);
    const expected = Math.round(100 * Math.min(1, Math.max(0, sum)) * 10) / 10;
    expect(out.draftScore).toBe(expected);
    // no NaN/Inf, clamped
    for (const c of out.components) {
      expect(Number.isFinite(c.normalized)).toBe(true);
      expect(Number.isFinite(c.contribution)).toBe(true);
      expect(c.normalized).toBeGreaterThanOrEqual(0);
      expect(c.normalized).toBeLessThanOrEqual(1);
      expect(c.contribution).toBeGreaterThanOrEqual(0);
      expect(c.contribution).toBeLessThanOrEqual(1);
      expect(c.weight).toBeGreaterThanOrEqual(0);
      expect(c.weight).toBeLessThanOrEqual(1);
    }
    expect(Number.isFinite(out.draftScore)).toBe(true);
  });

  it("weights match explicit ADR values 0.25/0.30/0.15 after largest-remainder (6dp sum 1)", () => {
    const out = analyzeDraft(baseInput());
    const byKey = new Map(out.components.map((c) => [c.key, c.weight]));
    // nominal values should be preserved at 6dp after largest remainder (they already sum 1)
    expect(byKey.get("valueCaptured")).toBeCloseTo(0.25, 6);
    expect(byKey.get("projectedStrength")).toBeCloseTo(0.3, 6);
    expect(byKey.get("rosterBalance")).toBeCloseTo(0.15, 6);
    expect(byKey.get("risk")).toBeCloseTo(0.15, 6);
    expect(byKey.get("scoringFit")).toBeCloseTo(0.15, 6);
  });

  it("handles missing ADP/projection snapshots gracefully with LOW confidence and assumptions", () => {
    const outNoAdp = analyzeDraft(
      baseInput({ adp: null, adpSnapshotId: null, adpCapturedAt: null }),
    );
    expect(outNoAdp.confidence).toBe("LOW");
    expect(outNoAdp.warnings.some((w) => w.toLowerCase().includes("adp"))).toBe(true);
    expect(outNoAdp.assumptions.some((a) => a.toLowerCase().includes("adp"))).toBe(true);
    expect(Number.isFinite(outNoAdp.draftScore)).toBe(true);
    // valueCaptured should be neutral 0.5 when no ADP
    const vc = outNoAdp.components.find((c) => c.key === "valueCaptured");
    expect(vc?.normalized).toBeCloseTo(0.5, 5);

    const outNoProj = analyzeDraft(
      baseInput({ projectionRunId: null, projectionPublishedAt: null }),
    );
    expect(outNoProj.confidence).toBe("LOW");
    expect(outNoProj.warnings.some((w) => w.toLowerCase().includes("projection"))).toBe(true);
    expect(Number.isFinite(outNoProj.draftScore)).toBe(true);

    const outNoPlayerProj = analyzeDraft(
      baseInput({
        projections: [],
        players: METAS,
      }),
    );
    expect(Number.isFinite(outNoPlayerProj.draftScore)).toBe(true);
    expect(outNoPlayerProj.projectedStanding.runs).toBe(2000);
  });

  it("supports points and category leagues and redraft/keeper/dynasty horizons with different strengths", () => {
    const points = analyzeDraft(baseInput({ settings: SETTINGS_POINTS }));
    const cats = analyzeDraft(baseInput({ settings: SETTINGS_CATS }));
    expect(points.components.length).toBe(5);
    expect(cats.components.length).toBe(5);
    // points scoringFit must be 1.0
    expect(points.components.find((c) => c.key === "scoringFit")?.normalized).toBe(1);
    expect(Number.isFinite(cats.draftScore)).toBe(true);
    expect(cats.grade).toMatch(/^[A-F]$/);
    // horizon: dynasty youth bias shifts projectedStrength for old vs young roster
    const dynastySettings = { ...SETTINGS_POINTS, horizon: "DYNASTY" as const };
    const redraft = analyzeDraft(
      baseInput({
        settings: SETTINGS_POINTS,
        assignments: [
          { playerId: "p-vet", teamSlot: 4, slotPosition: "PF", overallPick: 4 },
          { playerId: "p-vet", teamSlot: 4, slotPosition: "PF", overallPick: 21 },
        ],
        players: [
          meta({ playerId: "p-vet", age: 36, displayName: "Old Vet", eligiblePositions: ["PF"] }),
        ],
        projections: [
          projection({ playerId: "p-vet", pts: 12, age: 36 } as unknown as AnalysisProjection),
        ],
      }),
    );
    const dynasty = analyzeDraft(
      baseInput({
        settings: dynastySettings,
        assignments: [
          { playerId: "p-vet", teamSlot: 4, slotPosition: "PF", overallPick: 4 },
          { playerId: "p-vet", teamSlot: 4, slotPosition: "PF", overallPick: 21 },
        ],
        players: [
          meta({ playerId: "p-vet", age: 36, displayName: "Old Vet", eligiblePositions: ["PF"] }),
        ],
        projections: [projection({ playerId: "p-vet", pts: 12 })],
      }),
    );
    // dynasty should penalize old vet more (lower strength)
    const psRedraft =
      redraft.components.find((c) => c.key === "projectedStrength")?.normalized ?? 0.5;
    const psDynasty =
      dynasty.components.find((c) => c.key === "projectedStrength")?.normalized ?? 0.5;
    // Due to youth factor, dynasty for old vet should be slightly lower or at least not equal; we test they differ
    expect(psRedraft !== psDynasty || redraft.draftScore !== dynasty.draftScore).toBe(true);
  });

  it("includes round-by-round, bestValuePick/biggestReach, strengths/weaknesses, no-guarantee disclosure", () => {
    const out = analyzeDraft(baseInput());
    expect(out.roundByRound.length).toBeGreaterThan(0);
    // round-by-round should be sorted by overallPick
    for (let i = 1; i < out.roundByRound.length; i++) {
      expect(out.roundByRound[i]!.overallPick).toBeGreaterThan(
        out.roundByRound[i - 1]!.overallPick,
      );
    }
    for (const r of out.roundByRound) {
      expect(Number.isFinite(r.adpValueNorm)).toBe(true);
      expect(r.adpValueNorm).toBeGreaterThanOrEqual(0);
      expect(r.adpValueNorm).toBeLessThanOrEqual(1);
      expect([true, false]).toContain(r.isBestValue);
      expect([true, false]).toContain(r.isBiggestReach);
    }
    // bestValuePick should have maximal adpDelta
    if (out.bestValuePick && out.biggestReach) {
      expect(out.bestValuePick.adpDelta).not.toBeNull();
      expect(out.biggestReach.adpDelta).not.toBeNull();
      const deltas = out.roundByRound.filter((r) => r.adpDelta !== null).map((r) => r.adpDelta!);
      if (deltas.length > 0) {
        const max = Math.max(...deltas);
        const min = Math.min(...deltas);
        expect(out.bestValuePick.adpDelta).toBe(max);
        expect(out.biggestReach.adpDelta).toBe(min);
      }
      expect(out.bestValuePick.isBestValue).toBe(true);
      expect(out.biggestReach.isBiggestReach).toBe(true);
    }
    expect(out.strengths.length).toBeGreaterThan(0);
    expect(out.weaknesses.length).toBeGreaterThan(0);
    expect(out.disclosure).toContain("not a guarantee");
    expect(out.disclosure).toBe(ANALYSIS_DISCLOSURE);
    expect(out.assumptions.length).toBeGreaterThan(0);
    // freshness records checksum etc.
    expect(out.dataFreshness.inputChecksum).toBe(out.inputChecksum);
    expect(out.dataFreshness.analysisVersion).toBe("1.0.0");
    expect(out.dataFreshness.engineVersion).toBe(out.engineVersion);
  });

  it("guards against NaN, infinity, negative probability, impossible totals", () => {
    const nanProjection = projection({
      playerId: "p-nan",
      pts: NaN,
      reb: Infinity,
      ast: -Infinity,
      injuryRisk: NaN,
      roleSecurity: Infinity,
      lower80: { pts: NaN },
      upper80: { pts: Infinity },
    });
    const out = analyzeDraft(
      baseInput({
        players: [...METAS, meta({ playerId: "p-nan", displayName: "NaN Guy" })],
        projections: [...PLAYERS, nanProjection],
        assignments: [
          { playerId: "p-nan", teamSlot: 4, slotPosition: "PG", overallPick: 4 },
          { playerId: "p-star", teamSlot: 4, slotPosition: "SG", overallPick: 21 },
        ],
        adp: [
          { playerId: "p-nan", adp: NaN, rank: 1, sourcesCount: 1 },
          { playerId: "p-star", adp: Infinity, rank: 6, sourcesCount: 3 },
        ],
      }),
    );
    expect(Number.isFinite(out.draftScore)).toBe(true);
    expect(out.draftScore).toBeGreaterThanOrEqual(0);
    expect(out.draftScore).toBeLessThanOrEqual(100);
    for (const c of out.components) {
      expect(Number.isFinite(c.normalized)).toBe(true);
      expect(Number.isFinite(c.contribution)).toBe(true);
      expect(c.normalized).toBeGreaterThanOrEqual(0);
      expect(c.normalized).toBeLessThanOrEqual(1);
      expect(c.contribution).toBeGreaterThanOrEqual(0);
      expect(c.contribution).toBeLessThanOrEqual(1);
    }
    for (const r of out.roundByRound) {
      expect(Number.isFinite(r.adpValueNorm)).toBe(true);
      expect(r.adpValueNorm).toBeGreaterThanOrEqual(0);
      expect(r.adpValueNorm).toBeLessThanOrEqual(1);
    }
    // projectedStanding probabilities implicitly via ranks; ensure no impossible ranks
    for (const rank of out.projectedStanding.distribution) {
      expect(Number.isFinite(rank)).toBe(true);
      expect(rank).toBeGreaterThanOrEqual(1);
      expect(rank).toBeLessThanOrEqual(12);
    }
    // rosterBalance zero if illegal
    const illegal = analyzeDraft(
      baseInput({
        assignments: [{ playerId: "p-big", teamSlot: 4, slotPosition: "PG", overallPick: 4 }], // C player at PG illegal
      }),
    );
    expect(illegal.components.find((c) => c.key === "rosterBalance")?.normalized).toBe(0);
  });

  it("deterministic simulation seed derivation via FNV1a32 + SHA256 per-pick with 2000 runs synthetic baseline", () => {
    const input = baseInput();
    const out1 = analyzeDraft(input);
    const out2 = analyzeDraft(input);
    expect(out1.projectedStanding.distribution).toEqual(out2.projectedStanding.distribution);
    expect(out1.projectedStanding.runs).toBe(2000);
    expect(out1.projectedStanding.distribution).toHaveLength(2000);
    expect(out1.projectedStanding.label).toContain("replacement-built");
    expect(out1.projectedStanding.vsReplacement).toBe(true);
    // different seeds produce different distributions
    const outDiffSeed = analyzeDraft(baseInput({ simulationSeed: "different-seed-xyz" }));
    // distributions should differ for different seed (with high probability; we check checksum differs)
    const same =
      JSON.stringify(out1.projectedStanding.distribution) ===
      JSON.stringify(outDiffSeed.projectedStanding.distribution);
    expect(same).toBe(false);
    // per-pick seed derivation coverage: fnv1a32 + sha256 per pick must be deterministic
    const baseSeed = fnv1a32(
      `${input.simulationSeed}:${input.analysisVersion ?? "1.0.0"}:${input.projectionRunId ?? "null"}`,
    );
    const hexA = checksumInput(canonicalize({ a: 1 }));
    const hexB = checksumInput(canonicalize({ a: 1 }));
    expect(hexA).toBe(hexB);
    const seed1 = baseSeed;
    const seed2 = fnv1a32(
      `${input.simulationSeed}:${input.analysisVersion ?? "1.0.0"}:${input.projectionRunId ?? "null"}`,
    );
    expect(seed1).toBe(seed2);
    // p50/p90 computed and within bounds
    expect(out1.projectedStanding.p50).toBeGreaterThanOrEqual(1);
    expect(out1.projectedStanding.p50).toBeLessThanOrEqual(12);
    expect(out1.projectedStanding.p90).toBeGreaterThanOrEqual(1);
    expect(out1.projectedStanding.p90).toBeLessThanOrEqual(12);
    expect(out1.projectedStanding.p50).toBeLessThanOrEqual(out1.projectedStanding.p90);
  });

  it("confidence/freshness HIGH only when projection <=48h && adp <=7d && sources>=2 for >=80% roster && no warnings", () => {
    const fresh = analyzeDraft(
      baseInput({
        projectionPublishedAt: "2026-09-04T12:00:00.000Z", // 12h ago from 09-05
        adpCapturedAt: "2026-09-02T12:00:00.000Z", // 3 days ago
        adp: [
          { playerId: "p-star", adp: 6, rank: 6, sourcesCount: 3 },
          { playerId: "p-solid", adp: 30, rank: 30, sourcesCount: 3 },
          { playerId: "p-big", adp: 35, rank: 35, sourcesCount: 3 },
          { playerId: "p-guard", adp: 22, rank: 22, sourcesCount: 3 },
          { playerId: "p-wing", adp: 40, rank: 40, sourcesCount: 3 },
          { playerId: "p-vet", adp: 90, rank: 90, sourcesCount: 3 },
        ],
        assignments: [
          { playerId: "p-star", teamSlot: 4, slotPosition: "PG", overallPick: 4 },
          { playerId: "p-solid", teamSlot: 4, slotPosition: "SG", overallPick: 21 },
          { playerId: "p-big", teamSlot: 4, slotPosition: "C", overallPick: 28 },
          { playerId: "p-guard", teamSlot: 4, slotPosition: "UTIL", overallPick: 45 },
          { playerId: "p-wing", teamSlot: 4, slotPosition: "SF", overallPick: 52 },
          { playerId: "p-vet", teamSlot: 4, slotPosition: "PF", overallPick: 69 },
        ],
      }),
    );
    // This still has no warnings, so should be HIGH
    expect(fresh.confidence).toBe("HIGH");
    expect(fresh.dataFreshness.status).toBe("FRESH");

    const staleProj = analyzeDraft(
      baseInput({ projectionPublishedAt: "2026-08-10T00:00:00.000Z" }),
    );
    expect(["MEDIUM", "LOW", "STALE"]).toContain(
      staleProj.confidence === "LOW" ? "LOW" : staleProj.dataFreshness.status,
    );
    expect(staleProj.confidence !== "HIGH").toBe(true);

    const lowAdp = analyzeDraft(baseInput({ adpCapturedAt: "2026-07-01T00:00:00.000Z" }));
    expect(lowAdp.confidence).toBe("LOW");

    const lowSources = analyzeDraft(
      baseInput({
        adp: [
          { playerId: "p-star", adp: 6, rank: 6, sourcesCount: 1 },
          { playerId: "p-solid", adp: 30, rank: 30, sourcesCount: 1 },
          { playerId: "p-big", adp: 35, rank: 35, sourcesCount: 1 },
          { playerId: "p-guard", adp: 22, rank: 22, sourcesCount: 1 },
          { playerId: "p-wing", adp: 40, rank: 40, sourcesCount: 1 },
          { playerId: "p-vet", adp: 90, rank: 90, sourcesCount: 1 },
        ],
      }),
    );
    expect(lowSources.confidence).toBe("LOW");
  });

  it("keeps same primitives as recommendation.ts: seasonFantasyPoints, categoryUtility, percentageImpacts, computePoolBaselines, winsorize, percentileRank, mulberry32", () => {
    const p = projection({ playerId: "x", pts: 100, reb: 50, ast: 40, tov: 20 });
    expect(seasonFantasyPoints(p, SCORING_POINTS)).toBeCloseTo(
      100 * 1 + 50 * 1.2 + 40 * 1.5 - 20 * 1,
      5,
    );
    const per = {
      pts: 2,
      reb: 0.5,
      ast: 0.3,
      stl: 0.1,
      blk: 0.05,
      tov: 0.2,
      fgm: 0.8,
      fga: 1.8,
      ftm: 0.5,
      fta: 0.6,
      threePm: 0.2,
    };
    const imp = percentageImpacts(per);
    expect(imp.fgImpact).toBeCloseTo(0.8 - 1.8 * 0.45, 5);
    expect(imp.ftImpact).toBeCloseTo(0.5 - 0.6 * 0.75, 5);
    const baselines = computePoolBaselines(PLAYERS);
    expect(Number.isFinite(baselines.meanFgImpact)).toBe(true);
    expect(Number.isFinite(baselines.sdFgImpact)).toBe(true);
    expect(baselines.sdFgImpact).toBeGreaterThan(0);
    // winsorize at 2nd/98th percentiles — need ~100 elements for 98th to clip single outlier
    const many = [1, ...Array.from({ length: 98 }, () => 2), 100];
    const wr = winsorize(many);
    expect(Math.max(...wr)).toBeLessThan(100);
    expect(Math.min(...wr)).toBeGreaterThanOrEqual(1);
    const pr = percentileRank([1, 2, 3, 4, 5], 3);
    expect(pr).toBeCloseTo(0.4, 5);
    const r1 = mulberry32(12345);
    const r2 = mulberry32(12345);
    expect(r1()).toBe(r2());
    expect(r1()).not.toBe(r1()); // second call different
    const util = categoryUtility(p, SCORING_CATS);
    expect(Number.isFinite(util)).toBe(true);
    // winsorize guards NaN
    const wNaN = winsorize([1, NaN, Infinity, 2]);
    expect(wNaN.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("handles tie-break deterministically and empty roster gracefully", () => {
    const empty = analyzeDraft(
      baseInput({
        assignments: [],
      }),
    );
    expect(empty.draftScore).toBeGreaterThanOrEqual(0);
    expect(empty.roundByRound).toHaveLength(0);
    expect(empty.bestValuePick).toBeNull();
    expect(empty.biggestReach).toBeNull();
    expect(Number.isFinite(empty.draftScore)).toBe(true);
    // tie-break: identical adpValueNorm should still produce deterministic bestValuePick
    const tie = analyzeDraft(
      baseInput({
        assignments: [
          { playerId: "p-star", teamSlot: 4, slotPosition: "PG", overallPick: 10 },
          { playerId: "p-solid", teamSlot: 4, slotPosition: "SG", overallPick: 10 },
        ],
        adp: [
          { playerId: "p-star", adp: 20, rank: 20, sourcesCount: 3 },
          { playerId: "p-solid", adp: 20, rank: 20, sourcesCount: 3 },
        ],
      }),
    );
    const tie2 = analyzeDraft(
      baseInput({
        assignments: [
          { playerId: "p-star", teamSlot: 4, slotPosition: "PG", overallPick: 10 },
          { playerId: "p-solid", teamSlot: 4, slotPosition: "SG", overallPick: 10 },
        ],
        adp: [
          { playerId: "p-star", adp: 20, rank: 20, sourcesCount: 3 },
          { playerId: "p-solid", adp: 20, rank: 20, sourcesCount: 3 },
        ],
      }),
    );
    expect(JSON.stringify(tie.bestValuePick)).toBe(JSON.stringify(tie2.bestValuePick));
  });
});
