import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  PREFERENCE_SCHEMA_VERSION,
  WEIGHT_DECIMALS,
  applyPreset,
  defaultFactorPriority,
  defaultPreferenceSettings,
  getPreset,
  normalizeFactorWeights,
  preferencePresets,
  preferenceSettingsSchema,
  preferenceFactorKeys,
  reciprocalRankWeights,
  validatePuntConsistency,
  PreferenceNormalizationError,
  type PreferenceFactorKey,
  type PreferenceSettings,
} from "./preferences";

const EPSILON = 10 ** -WEIGHT_DECIMALS;

/** Sums weights at integer unit scale — the honest invariant is that the
 * DECIMAL representations total exactly 1; raw float addition of the
 * individual fractions can drift by ~1e-15. */
function total(weights: Record<string, number>): number {
  const units = Object.values(weights).reduce(
    (sum, value) => sum + Math.round(value * 10 ** WEIGHT_DECIMALS),
    0,
  );
  return units / 10 ** WEIGHT_DECIMALS;
}

describe("reciprocalRankWeights", () => {
  it("matches BUILD_SPEC §2.2 default priority with raw = 1/rank normalized", () => {
    const weights = reciprocalRankWeights(defaultFactorPriority);
    // raw values: 1, 1/2, ..., 1/11 → total H_11 ≈ 3.019877…
    const rawTotal = Array.from({ length: 11 }, (_, i) => 1 / (i + 1)).reduce((a, b) => a + b, 0);
    expect(weights.production).toBeCloseTo(1 / rawTotal, 5);
    expect(weights.nextPickAvailability).toBeCloseTo(1 / 10 / rawTotal, 5);
    expect(weights.preference).toBeCloseTo(1 / 11 / rawTotal, 5);
    expect(total(weights)).toBeCloseTo(1, 6);
    expect(total(weights)).toBe(1); // exact at stored precision
  });

  it("is order-sensitive and deterministic", () => {
    const a = reciprocalRankWeights(defaultFactorPriority);
    const b = reciprocalRankWeights(defaultFactorPriority);
    expect(a).toEqual(b);
    const flipped = reciprocalRankWeights([...defaultFactorPriority].reverse());
    expect(flipped.production).toBeLessThan(a.production);
  });

  it("rejects incomplete or duplicated priorities", () => {
    expect(() => reciprocalRankWeights(["production"])).toThrow(PreferenceNormalizationError);
    expect(() =>
      reciprocalRankWeights([...defaultFactorPriority, ...defaultFactorPriority]),
    ).toThrow(PreferenceNormalizationError);
  });
});

describe("normalizeFactorWeights", () => {
  it("keeps locked factors exact and redistributes the remainder proportionally", () => {
    const base = reciprocalRankWeights(defaultFactorPriority);
    const locked: PreferenceSettings["lockedFactors"] = ["production", "risk"];
    const bumped = { ...base, production: 0.5, risk: 0.2 };
    const result = normalizeFactorWeights(bumped, locked);
    expect(result.weights.production).toBe(0.5);
    expect(result.weights.risk).toBe(0.2);
    // Unlocked share the remaining 0.3 proportionally to their prior shares.
    const unlockedKeys = preferenceFactorKeys.filter(
      (key) => key !== "production" && key !== "risk",
    );
    const priorUnlockedTotal = unlockedKeys.reduce((sum, key) => sum + base[key], 0);
    for (const key of unlockedKeys) {
      expect(result.weights[key]).toBeCloseTo((0.3 * base[key]) / priorUnlockedTotal, 5);
    }
    expect(total(result.weights)).toBe(1);
  });

  it("handles all-zero unlocked priors by splitting the remainder evenly", () => {
    const zeroed = Object.fromEntries(preferenceFactorKeys.map((key) => [key, 0])) as Record<
      PreferenceFactorKey,
      number
    >;
    const result = normalizeFactorWeights({ ...zeroed, production: 0.4 }, ["production"]);
    expect(result.weights.production).toBe(0.4);
    for (const key of preferenceFactorKeys) {
      if (key === "production") continue;
      expect(result.weights[key]).toBeCloseTo(0.6 / (preferenceFactorKeys.length - 1), 6);
    }
    expect(total(result.weights)).toBe(1);
  });

  it("throws an actionable error when locked factors exceed 100%", () => {
    const weights = Object.fromEntries(preferenceFactorKeys.map((key) => [key, 0.5])) as Record<
      PreferenceFactorKey,
      number
    >;
    weights.production = 0.6;
    weights.risk = 0.6; // locked total 1.2 > 1
    expect(() => normalizeFactorWeights(weights, ["production", "risk"])).toThrow(
      /unlock or lower a slider/i,
    );
    // Exactly-100% locked totals are legitimate.
    weights.risk = 0.4;
    expect(normalizeFactorWeights(weights, ["production", "risk"]).weights.production).toBe(0.6);
  });

  it("allows locking everything only at exactly 100%", () => {
    const exact = reciprocalRankWeights(defaultFactorPriority);
    const allLocked = [...preferenceFactorKeys];
    expect(normalizeFactorWeights(exact, allLocked).weights).toEqual(exact);
    const bumped = { ...exact, production: Math.min(exact.production + 0.01, 1) };
    expect(() => normalizeFactorWeights(bumped, allLocked)).toThrow(/unlock or lower/i);
  });

  it("rejects NaN/infinite/out-of-range inputs", () => {
    const base = reciprocalRankWeights(defaultFactorPriority);
    expect(() => normalizeFactorWeights({ ...base, production: Number.NaN }, [])).toThrow(
      PreferenceNormalizationError,
    );
    expect(() =>
      normalizeFactorWeights({ ...base, production: Number.POSITIVE_INFINITY }, []),
    ).toThrow(PreferenceNormalizationError);
    expect(() => normalizeFactorWeights({ ...base, production: -0.1 }, [])).toThrow(
      PreferenceNormalizationError,
    );
    expect(() => normalizeFactorWeights({ ...base, production: 1.2 }, [])).toThrow(
      PreferenceNormalizationError,
    );
  });

  it("property: totals exactly 1 and locked values are preserved", () => {
    const weightArb = fc.double({ min: 0, max: 1, noNaN: true });
    fc.assert(
      fc.property(
        fc.array(weightArb, {
          minLength: preferenceFactorKeys.length,
          maxLength: preferenceFactorKeys.length,
        }),
        fc.subarray(preferenceFactorKeys as unknown as PreferenceFactorKey[], {
          minLength: 0,
          maxLength: 3,
        }),
        (rawValues, locked) => {
          const weights = Object.fromEntries(
            preferenceFactorKeys.map((key, index) => [key, rawValues[index]]),
          ) as Record<PreferenceFactorKey, number>;
          let result;
          try {
            result = normalizeFactorWeights(weights, locked);
          } catch (error) {
            // Only acceptable failure is impossible locked totals.
            const lockedTotal = locked.reduce((sum, key) => sum + weights[key], 0);
            expect(lockedTotal).toBeGreaterThan(1 + Number.EPSILON);
            expect(error).toBeInstanceOf(PreferenceNormalizationError);
            return;
          }
          expect(total(result.weights)).toBe(1);
          for (const key of locked) {
            expect(Math.abs(result.weights[key] - weights[key])).toBeLessThan(EPSILON);
          }
          for (const value of Object.values(result.weights)) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(Number.isFinite(value)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

function getWinNow() {
  const preset = getPreset("win-now");
  if (preset === undefined) throw new Error("win-now preset missing");
  return preset;
}
function getLowRisk() {
  const preset = getPreset("low-risk");
  if (preset === undefined) throw new Error("low-risk preset missing");
  return preset;
}
function getBalanced() {
  const preset = getPreset("balanced");
  if (preset === undefined) throw new Error("balanced preset missing");
  return preset;
}

describe("presets", () => {
  it("exposes all 13 required presets with unique stable keys and version", () => {
    const keys = preferencePresets.map((preset) => preset.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining([
        "balanced",
        "bpa",
        "positional-balance",
        "win-now",
        "dynasty-youth",
        "high-upside",
        "low-risk",
        "guard-heavy",
        "big-man-build",
        "threes-and-scoring",
        "defensive-categories",
        "punt-strategy",
        "schedule-optimizer",
      ]),
    );
    for (const preset of preferencePresets) {
      expect(preset.version).toBe(1);
      expect(preset.title.length).toBeGreaterThan(0);
      expect(preset.explanation.length).toBeGreaterThan(0);
    }
  });

  it("every preset applies into valid, complete settings", () => {
    for (const preset of preferencePresets) {
      const applied = applyPreset(preset);
      const parsed = preferenceSettingsSchema.safeParse(applied);
      expect(parsed.success, `${preset.key}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      if (preset.factorPriority !== undefined && preset.weightOverrides === undefined) {
        // Rank-based presets produce the same weights as direct construction.
        expect(applied.factorWeights).toEqual(reciprocalRankWeights(preset.factorPriority));
      }
    }
  });

  it("punt-strategy preset yields consistent punt entries", () => {
    const puntPreset = getPreset("punt-strategy");
    if (puntPreset === undefined) throw new Error("punt-strategy preset missing");
    const applied = applyPreset(puntPreset);
    expect(validatePuntConsistency(applied)).toBeNull();
    expect(applied.puntStats).toEqual(["TOV"]);
    expect(applied.categoryPriorities).toContainEqual({ stat: "TOV", weight: 0 });
  });

  it("applying a preset never mutates the current settings object", () => {
    const current = defaultPreferenceSettings();
    const snapshot = structuredClone(current);
    applyPreset(getWinNow(), current);
    expect(current).toEqual(snapshot);
  });

  it("presets without factorPriority preserve current weights but stay normalized", () => {
    const current = defaultPreferenceSettings();
    const customOnly = applyPreset(
      {
        key: "synthetic",
        version: 1,
        title: "Synthetic",
        explanation: "Test-only preset with no factor priority.",
        scalars: { riskTolerance: 0.9 },
      },
      current,
    );
    expect(customOnly.factorWeights).toEqual(current.factorWeights);
    expect(customOnly.riskTolerance).toBe(0.9);
    expect(total(customOnly.factorWeights)).toBe(1);
  });

  it("low-risk preset suggests locking its risk slider", () => {
    const applied = applyPreset(getLowRisk());
    expect(applied.lockedFactors).toContain("risk");
  });

  it("schema version stamp is present and validated", () => {
    const applied = applyPreset(getBalanced());
    expect(applied.schemaVersion).toBe(PREFERENCE_SCHEMA_VERSION);
    const stale = { ...applied, schemaVersion: 999 } as unknown as PreferenceSettings;
    expect(preferenceSettingsSchema.safeParse(stale).success).toBe(false);
  });

  it("validatePuntConsistency flags punted stats missing a zero-weight entry", () => {
    const settings = defaultPreferenceSettings();
    settings.puntStats = ["BLK"];
    expect(validatePuntConsistency(settings)).toMatch(/BLK/);
    settings.categoryPriorities = [{ stat: "BLK", weight: 0 }];
    expect(validatePuntConsistency(settings)).toBeNull();
    settings.categoryPriorities = [{ stat: "BLK", weight: 0.4 }];
    expect(validatePuntConsistency(settings)).toMatch(/weight 0/);
    // Zero-weight entries must be explicit punts.
    settings.categoryPriorities = [{ stat: "BLK", weight: 0 }];
    settings.puntStats = [];
    expect(validatePuntConsistency(settings)).toMatch(/not selected in puntStats/);
  });
});

describe("defaultPreferenceSettings", () => {
  it("is valid, unnormalized-safe, EXCLUDE-mode, schedule off", () => {
    const settings = defaultPreferenceSettings();
    expect(preferenceSettingsSchema.safeParse(settings).success).toBe(true);
    expect(settings.avoidMode).toBe("EXCLUDE");
    expect(settings.schedule).toEqual({ enabled: false, playoffWeeks: null });
    expect(settings.lockedFactors).toEqual([]);
    expect(total(settings.factorWeights)).toBe(1);
  });
});
