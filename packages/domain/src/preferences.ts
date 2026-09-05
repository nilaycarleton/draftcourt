import { z } from "zod";
import type { ComponentKey } from "./recommendation";

/**
 * Preference-profile domain contracts (BUILD_SPEC.md sections 2.2, 4.2).
 *
 * Versioning: every persisted profile carries `schemaVersion` inside its
 * settings JSON. Version 1 is defined here; a breaking change to the shape
 * bumps PREFERENCE_SCHEMA_VERSION and requires an explicit migration path in
 * the service layer (old payloads are validated against their own version, so
 * unknown future versions fail closed rather than misinterpret). See
 * docs/adr/0011-preference-storage-and-normalization.md.
 *
 * Normalization: factor weights always total exactly 1 at the stored
 * precision (WEIGHT_DECIMALS = 6, largest-remainder rounding) so the engine's
 * weighted sum is reproducible byte-for-byte. Locked factors keep their exact
 * values; unlocked factors share the remainder proportionally to their prior
 * relative shares.
 */

export const PREFERENCE_SCHEMA_VERSION = 1;

/** Stored weights are rounded to this many decimal places; the total is
 * adjusted deterministically so it sums to exactly 1 at this precision. */
export const WEIGHT_DECIMALS = 6;

/** The tunable strategy factors are exactly the engine's score components —
 * user preference weights feed the same keys (Phase 3B integration). */
export const preferenceFactorKeys = [
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
] as const satisfies readonly ComponentKey[];

export type PreferenceFactorKey = (typeof preferenceFactorKeys)[number];

/** Default factor priority from BUILD_SPEC.md section 2.2 (rank order). */
export const defaultFactorPriority: readonly PreferenceFactorKey[] = [
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
];

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const WEIGHT_UNIT_SCALE = 10 ** WEIGHT_DECIMALS;

/** Largest-remainder rounding of non-negative float "unit" values so they
 * total exactly `targetUnits`. Ties break by factor key order for full
 * determinism. Inputs need not sum to targetUnits — the residual is
 * distributed one unit at a time by descending fractional part. */
function largestRemainderUnits(
  floats: Map<PreferenceFactorKey, number>,
  targetUnits: number,
): Map<PreferenceFactorKey, number> {
  const floored = new Map<PreferenceFactorKey, number>();
  const remainders: { key: PreferenceFactorKey; remainder: number }[] = [];
  for (const key of preferenceFactorKeys) {
    const raw = floats.get(key) ?? 0;
    const floor = Math.floor(raw);
    floored.set(key, floor);
    remainders.push({ key, remainder: raw - floor });
  }
  let distributed = [...floored.values()].reduce((a, b) => a + b, 0);
  remainders.sort((a, b) => b.remainder - a.remainder || (a.key < b.key ? -1 : 1));
  let index = 0;
  while (distributed < targetUnits && remainders.length > 0) {
    const pick = remainders[index % remainders.length];
    if (!pick) break;
    floored.set(pick.key, (floored.get(pick.key) ?? 0) + 1);
    distributed += 1;
    index += 1;
  }
  return floored;
}

/** Reciprocal-rank initialization over `order`: raw weight = 1/rank,
 * normalized to sum to exactly one at stored precision. Deterministic. */
export function reciprocalRankWeights(
  order: readonly PreferenceFactorKey[],
): Record<PreferenceFactorKey, number> {
  if (new Set(order).size !== order.length || order.length !== preferenceFactorKeys.length) {
    throw new PreferenceNormalizationError("factor priority must contain each factor exactly once");
  }
  const raw = new Map<PreferenceFactorKey, number>();
  order.forEach((key, index) => raw.set(key, 1 / (index + 1)));
  return roundWeightMap(raw);
}

/** Scales an arbitrary non-negative weight map proportionally so the stored
 * values total exactly 1 at WEIGHT_DECIMALS (largest-remainder rounding). */
export function roundWeightMap(
  raw: Map<PreferenceFactorKey, number>,
): Record<PreferenceFactorKey, number> {
  const total = [...raw.values()].reduce((sum, value) => sum + Math.max(value, 0), 0);
  if (!(total > 0)) {
    // Degenerate input: uniform split (still deterministic).
    const even = new Map<PreferenceFactorKey, number>();
    for (const key of preferenceFactorKeys) even.set(key, 1 / preferenceFactorKeys.length);
    return roundWeightMap(even);
  }
  const floats = new Map<PreferenceFactorKey, number>();
  for (const key of preferenceFactorKeys) {
    floats.set(key, ((raw.get(key) ?? 0) / total) * WEIGHT_UNIT_SCALE);
  }
  const settled = largestRemainderUnits(floats, WEIGHT_UNIT_SCALE);
  const out = {} as Record<PreferenceFactorKey, number>;
  for (const [key, unitValue] of settled) out[key] = unitValue / WEIGHT_UNIT_SCALE;
  return out;
}

export class PreferenceNormalizationError extends Error {}

export interface NormalizeResult {
  weights: Record<PreferenceFactorKey, number>;
}

/**
 * Locked-slider normalization: locked factors keep their exact values;
 * unlocked factors share the remaining mass proportionally to their previous
 * relative shares. Deterministic; result totals exactly 1 at stored precision.
 *
 * Throws {@link PreferenceNormalizationError} when locked factors already
 * exceed 1 (or reach 1 with unlocked factors present and no free mass) — the
 * caller surfaces this as an actionable field error.
 */
export function normalizeFactorWeights(
  weights: Partial<Record<PreferenceFactorKey, number>>,
  locked: readonly PreferenceFactorKey[],
): NormalizeResult {
  const lockedSet = new Set(locked);
  for (const key of preferenceFactorKeys) {
    const value = weights[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new PreferenceNormalizationError(`weight for ${key} must be a finite number in [0,1]`);
    }
  }
  const lockedTotal = [...lockedSet].reduce((sum, key) => sum + (weights[key] ?? 0), 0);
  const unlockedKeys = preferenceFactorKeys.filter((key) => !lockedSet.has(key));

  if (lockedTotal > 1 + Number.EPSILON) {
    throw new PreferenceNormalizationError(
      `locked factors total ${(lockedTotal * 100).toFixed(1)}% — unlock or lower a slider below 100%`,
    );
  }

  if (unlockedKeys.length === 0) {
    if (Math.abs(lockedTotal - 1) > Number.EPSILON) {
      throw new PreferenceNormalizationError("locking every factor requires the total to be 100%");
    }
    const exact = new Map<PreferenceFactorKey, number>();
    for (const key of preferenceFactorKeys) {
      const value = weights[key];
      if (value === undefined) throw new PreferenceNormalizationError(`missing weight ${key}`);
      exact.set(key, value);
    }
    return { weights: roundWeightMap(exact) };
  }

  const remaining = 1 - lockedTotal;
  if (remaining < -Number.EPSILON) {
    throw new PreferenceNormalizationError("locked factors exceed 100%");
  }

  // Proportional-to-prior-share redistribution among unlocked factors.
  const priorUnlockedTotal = unlockedKeys.reduce(
    (sum, key) => sum + Math.max(weights[key] ?? 0, 0),
    0,
  );
  const redistributed = new Map<PreferenceFactorKey, number>();
  for (const key of lockedSet) redistributed.set(key, weights[key] ?? 0);
  if (priorUnlockedTotal <= 0) {
    // No usable prior shares (all zero): split the remainder evenly.
    const evenShare = remaining / unlockedKeys.length;
    for (const key of unlockedKeys) redistributed.set(key, evenShare);
  } else {
    for (const key of unlockedKeys) {
      redistributed.set(key, (remaining * Math.max(weights[key] ?? 0, 0)) / priorUnlockedTotal);
    }
  }

  // Locked values are pinned exactly at stored precision; the unlocked set
  // absorbs ALL rounding residual so locked sliders never drift.
  const lockedUnits = new Map<PreferenceFactorKey, number>();
  let lockedUnitSum = 0;
  for (const key of lockedSet) {
    const units = Math.round((weights[key] ?? 0) * WEIGHT_UNIT_SCALE);
    lockedUnits.set(key, units);
    lockedUnitSum += units;
  }
  const unlockedTargetUnits = WEIGHT_UNIT_SCALE - lockedUnitSum;
  const unlockedFloats = new Map<PreferenceFactorKey, number>();
  for (const key of unlockedKeys) {
    const share = redistributed.get(key);
    if (share === undefined) throw new PreferenceNormalizationError(`missing share ${key}`);
    unlockedFloats.set(key, share * WEIGHT_UNIT_SCALE);
  }

  const settledUnlocked = largestRemainderUnits(unlockedFloats, unlockedTargetUnits);
  const merged = new Map<PreferenceFactorKey, number>(settledUnlocked);
  for (const [key, units] of lockedUnits) merged.set(key, units);

  const out = {} as Record<PreferenceFactorKey, number>;
  for (const [key, unitValue] of merged) out[key] = unitValue / WEIGHT_UNIT_SCALE;
  return { weights: out };
}

// ---------------------------------------------------------------------------
// Settings schema (versioned envelope persisted as JSON)
// ---------------------------------------------------------------------------

const factorWeightMapSchema = z
  .object(
    Object.fromEntries(
      preferenceFactorKeys.map((key) => [key, z.number().min(0).max(1)]),
    ) as Record<PreferenceFactorKey, z.ZodNumber>,
  )
  .refine(
    (weights) => {
      const total = preferenceFactorKeys.reduce((sum, key) => sum + weights[key], 0);
      return Math.abs(total - 1) <= 5 * 10 ** -WEIGHT_DECIMALS + 1e-9;
    },
    { message: "factor weights must total 1 (±1e-6)" },
  );

export const avoidModeSchema = z.enum(["EXCLUDE", "SEVERE_PENALTY"]);
export type AvoidMode = z.infer<typeof avoidModeSchema>;

/** Base positions that can be prioritized (not roster-slot concepts). */
export const preferencePositionKeys = ["PG", "SG", "SF", "PF", "C"] as const;
export type PreferencePositionKey = (typeof preferencePositionKeys)[number];

const positionPrioritiesSchema = z
  .array(
    z.object({
      position: z.enum(preferencePositionKeys),
      priority: z.number().min(0).max(1),
    }),
  )
  .max(preferencePositionKeys.length)
  .refine((entries) => new Set(entries.map((entry) => entry.position)).size === entries.length, {
    message: "position priorities must not repeat a position",
  });

const categoryPrioritiesSchema = z
  .array(
    z.object({
      stat: z.string().min(1).max(64),
      /** Relative category emphasis; exactly 0 marks a punted category (must
       * also be listed in `puntStats` so the choice is always explicit). */
      weight: z.number().min(0).max(1),
    }),
  )
  .max(32)
  .refine((entries) => new Set(entries.map((entry) => entry.stat)).size === entries.length, {
    message: "category priorities must not repeat a stat",
  });

/** Punted categories: explicit user choice only, never inferred (spec §2.2). */
const puntStatsSchema = z.array(z.string().min(1).max(64)).max(16);

export const preferenceSettingsSchema = z.object({
  schemaVersion: z.literal(PREFERENCE_SCHEMA_VERSION),
  factorWeights: factorWeightMapSchema,
  lockedFactors: z.array(z.enum(preferenceFactorKeys)).max(preferenceFactorKeys.length),
  riskTolerance: z.number().min(0).max(1),
  upsidePriority: z.number().min(0).max(1),
  /** Negative = favor veterans, positive = favor youth (dynasty age curve). */
  youthBias: z.number().min(-1).max(1),
  roleMinutesPriority: z.number().min(0).max(1),
  schedule: z.object({
    enabled: z.boolean(),
    playoffWeeks: z.number().int().min(1).max(14).nullable(),
  }),
  positionPriorities: positionPrioritiesSchema,
  categoryPriorities: categoryPrioritiesSchema,
  puntStats: puntStatsSchema,
  avoidMode: avoidModeSchema,
});

export type PreferenceSettings = z.infer<typeof preferenceSettingsSchema>;

/** Punt consistency is bidirectional: a zero-weight category priority must be
 * an explicit punt, and every explicit punt must have exactly one zero-weight
 * entry (spec §2.2: punts are zero/reduced weights, expressed by the user,
 * never inferred). Returns the first problem found, or null. */
export function validatePuntConsistency(settings: PreferenceSettings): string | null {
  for (const entry of settings.categoryPriorities) {
    if (entry.weight === 0 && !settings.puntStats.includes(entry.stat)) {
      return `${entry.stat} has weight 0 but is not selected in puntStats`;
    }
  }
  for (const stat of settings.puntStats) {
    const entry = settings.categoryPriorities.find((candidate) => candidate.stat === stat);
    if (!entry) return `${stat} is punted but has no category priority entry`;
    if (entry.weight !== 0) return `punted ${stat} must have weight 0`;
  }
  return null;
}

export function defaultPreferenceSettings(): PreferenceSettings {
  return {
    schemaVersion: PREFERENCE_SCHEMA_VERSION,
    factorWeights: reciprocalRankWeights(defaultFactorPriority),
    lockedFactors: [],
    riskTolerance: 0.5,
    upsidePriority: 0.5,
    youthBias: 0,
    roleMinutesPriority: 0.5,
    schedule: { enabled: false, playoffWeeks: null },
    positionPriorities: [],
    categoryPriorities: [],
    puntStats: [],
    avoidMode: "EXCLUDE",
  };
}

// ---------------------------------------------------------------------------
// Presets (versioned data definitions — never UI conditionals)
// ---------------------------------------------------------------------------

export interface PreferencePresetDefinition {
  /** Stable machine key persisted as provenance (`presetKey`). */
  key: string;
  version: number;
  title: string;
  /** One plain-language sentence shown in the gallery. */
  explanation: string;
  /** Factor priority used for reciprocal-rank weights (must be complete). */
  factorPriority?: readonly PreferenceFactorKey[];
  /** Explicit weight overrides applied AFTER rank normalization. */
  weightOverrides?: Partial<Record<PreferenceFactorKey, number>>;
  /** Factors the preset suggests locking (user may unlock). */
  lockFactors?: readonly PreferenceFactorKey[];
  scalars?: Partial<
    Pick<
      PreferenceSettings,
      "riskTolerance" | "upsidePriority" | "youthBias" | "roleMinutesPriority"
    >
  >;
  schedule?: PreferenceSettings["schedule"];
  positionPriorities?: PreferenceSettings["positionPriorities"];
  categoryPriorities?: PreferenceSettings["categoryPriorities"];
  puntStats?: readonly string[];
  avoidMode?: AvoidMode;
}

export const preferencePresets: readonly PreferencePresetDefinition[] = [
  {
    key: "balanced",
    version: 1,
    title: "Balanced",
    explanation: "The default blend of production, need, risk, and market value.",
    factorPriority: defaultFactorPriority,
  },
  {
    key: "bpa",
    version: 1,
    title: "Best Player Available",
    explanation: "Almost pure projected production and market value — fit barely matters.",
    factorPriority: [
      "production",
      "adpValue",
      "upside",
      "scarcity",
      "consistency",
      "risk",
      "age",
      "role",
      "rosterNeed",
      "preference",
      "nextPickAvailability",
    ],
    scalars: { riskTolerance: 0.6, upsidePriority: 0.7 },
  },
  {
    key: "positional-balance",
    version: 1,
    title: "Positional Balance",
    explanation: "Rewards players who fill your thinnest positions first.",
    factorPriority: [
      "rosterNeed",
      "production",
      "scarcity",
      "risk",
      "adpValue",
      "consistency",
      "upside",
      "role",
      "age",
      "preference",
      "nextPickAvailability",
    ],
    positionPriorities: [
      { position: "PG", priority: 0.8 },
      { position: "SG", priority: 0.8 },
      { position: "SF", priority: 0.8 },
      { position: "PF", priority: 0.8 },
      { position: "C", priority: 0.8 },
    ],
  },
  {
    key: "win-now",
    version: 1,
    title: "Win Now",
    explanation: "Proven minutes and safety today; trades away long-term upside.",
    factorPriority: [
      "production",
      "risk",
      "role",
      "consistency",
      "rosterNeed",
      "scarcity",
      "adpValue",
      "nextPickAvailability",
      "age",
      "upside",
      "preference",
    ],
    scalars: { riskTolerance: 0.25, upsidePriority: 0.2, youthBias: -0.4 },
  },
  {
    key: "dynasty-youth",
    version: 1,
    title: "Dynasty Youth",
    explanation: "Age curve and upside dominate — building for next seasons.",
    factorPriority: [
      "upside",
      "age",
      "production",
      "role",
      "scarcity",
      "rosterNeed",
      "adpValue",
      "consistency",
      "risk",
      "preference",
      "nextPickAvailability",
    ],
    scalars: { youthBias: 0.8, upsidePriority: 0.85, riskTolerance: 0.7 },
  },
  {
    key: "high-upside",
    version: 1,
    title: "High Upside",
    explanation: "Chases breakout ceilings and accepts volatility.",
    factorPriority: [
      "upside",
      "production",
      "scarcity",
      "role",
      "rosterNeed",
      "adpValue",
      "age",
      "risk",
      "consistency",
      "preference",
      "nextPickAvailability",
    ],
    scalars: { upsidePriority: 0.9, riskTolerance: 0.8 },
  },
  {
    key: "low-risk",
    version: 1,
    title: "Low Risk",
    explanation: "Favors durable, consistent veterans with secure roles.",
    factorPriority: [
      "risk",
      "consistency",
      "production",
      "role",
      "rosterNeed",
      "adpValue",
      "scarcity",
      "age",
      "upside",
      "preference",
      "nextPickAvailability",
    ],
    scalars: { riskTolerance: 0.15, upsidePriority: 0.25 },
    lockFactors: ["risk"],
  },
  {
    key: "guard-heavy",
    version: 1,
    title: "Guard Heavy",
    explanation: "Zero-RB-style: stockpile backcourt production first.",
    factorPriority: [
      "production",
      "scarcity",
      "rosterNeed",
      "adpValue",
      "upside",
      "role",
      "consistency",
      "risk",
      "age",
      "preference",
      "nextPickAvailability",
    ],
    positionPriorities: [
      { position: "PG", priority: 1 },
      { position: "SG", priority: 1 },
      { position: "SF", priority: 0.3 },
      { position: "PF", priority: 0.3 },
      { position: "C", priority: 0.2 },
    ],
  },
  {
    key: "big-man-build",
    version: 1,
    title: "Big-Man Build",
    explanation: "Anchors your frontcourt early while rivals chase guards.",
    factorPriority: [
      "production",
      "scarcity",
      "rosterNeed",
      "role",
      "consistency",
      "risk",
      "adpValue",
      "upside",
      "age",
      "preference",
      "nextPickAvailability",
    ],
    positionPriorities: [
      { position: "C", priority: 1 },
      { position: "PF", priority: 0.9 },
      { position: "PG", priority: 0.3 },
      { position: "SG", priority: 0.3 },
      { position: "SF", priority: 0.4 },
    ],
  },
  {
    key: "threes-and-scoring",
    version: 1,
    title: "Threes and Scoring",
    explanation: "Weights points and three-point volume above all else.",
    factorPriority: [
      "production",
      "adpValue",
      "upside",
      "scarcity",
      "role",
      "rosterNeed",
      "consistency",
      "risk",
      "age",
      "preference",
      "nextPickAvailability",
    ],
    categoryPriorities: [
      { stat: "PTS", weight: 1 },
      { stat: "THREE_PM", weight: 0.9 },
    ],
  },
  {
    key: "defensive-categories",
    version: 1,
    title: "Defensive Categories",
    explanation: "Builds around steals, blocks, and rebounds.",
    factorPriority: [
      "production",
      "scarcity",
      "rosterNeed",
      "consistency",
      "risk",
      "role",
      "adpValue",
      "upside",
      "age",
      "preference",
      "nextPickAvailability",
    ],
    categoryPriorities: [
      { stat: "STL", weight: 1 },
      { stat: "BLK", weight: 1 },
      { stat: "REB", weight: 0.8 },
    ],
  },
  {
    key: "punt-strategy",
    version: 1,
    title: "Punt Strategy",
    explanation: "You choose which categories to zero out; the rest compete.",
    factorPriority: [
      "production",
      "scarcity",
      "rosterNeed",
      "adpValue",
      "consistency",
      "risk",
      "upside",
      "role",
      "age",
      "preference",
      "nextPickAvailability",
    ],
    categoryPriorities: [{ stat: "TOV", weight: 0 }],
    puntStats: ["TOV"],
  },
  {
    key: "schedule-optimizer",
    version: 1,
    title: "Schedule Optimizer",
    explanation: "Leans on fantasy-playoff-week games when the schedule matters.",
    factorPriority: [
      "production",
      "nextPickAvailability",
      "rosterNeed",
      "scarcity",
      "adpValue",
      "role",
      "consistency",
      "risk",
      "upside",
      "age",
      "preference",
    ],
    schedule: { enabled: true, playoffWeeks: null },
    scalars: { roleMinutesPriority: 0.7 },
  },
];

export function getPreset(key: string): PreferencePresetDefinition | undefined {
  return preferencePresets.find((preset) => preset.key === key);
}

/** Applies a preset to produce COMPLETE editable settings: preset values win
 * where defined, current values persist elsewhere, weights are re-normalized
 * (respecting the preset's suggested locks), and provenance records the
 * preset key+version. Never mutates the input. */
export function applyPreset(
  preset: PreferencePresetDefinition,
  current: PreferenceSettings = defaultPreferenceSettings(),
): PreferenceSettings {
  const locks = preset.lockFactors ?? [];
  const baseWeights =
    preset.factorPriority === undefined
      ? current.factorWeights
      : reciprocalRankWeights(preset.factorPriority);
  const mergedWeights = normalizeFactorWeights(
    { ...baseWeights, ...(preset.weightOverrides ?? {}) },
    locks,
  ).weights;

  const categoryPriorities = preset.categoryPriorities ?? [];
  const puntStats = [...(preset.puntStats ?? [])];
  // Punt stats always get explicit zero-weight entries (validatePuntConsistency).
  for (const stat of puntStats) {
    if (!categoryPriorities.some((entry) => entry.stat === stat)) {
      categoryPriorities.push({ stat, weight: 0 });
    }
  }

  return {
    schemaVersion: PREFERENCE_SCHEMA_VERSION,
    factorWeights: mergedWeights,
    lockedFactors: [...locks],
    riskTolerance: preset.scalars?.riskTolerance ?? current.riskTolerance,
    upsidePriority: preset.scalars?.upsidePriority ?? current.upsidePriority,
    youthBias: preset.scalars?.youthBias ?? current.youthBias,
    roleMinutesPriority: preset.scalars?.roleMinutesPriority ?? current.roleMinutesPriority,
    schedule: preset.schedule ? { ...preset.schedule } : { ...current.schedule },
    positionPriorities: preset.positionPriorities
      ? preset.positionPriorities.map((entry) => ({ ...entry }))
      : [],
    categoryPriorities: categoryPriorities.map((entry) => ({ ...entry })),
    puntStats: [...puntStats],
    avoidMode: preset.avoidMode ?? current.avoidMode,
  };
}
