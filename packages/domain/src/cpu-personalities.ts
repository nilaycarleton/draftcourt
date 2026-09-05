/**
 * CPU draft personalities (DraftCourt Phase 3C).
 *
 * A CPU personality is a named, versioned weight vector over nine feature
 * dimensions plus a softmax sampling temperature. Definitions here are
 * immutable seed data; drafts persist the validated SNAPSHOT form so stored
 * payloads fail closed on unknown versions or malformed weights, mirroring
 * the preference-snapshot contract (recommendation-snapshot.ts).
 *
 * Determinism rules:
 * - `snapshotVersion` is a fail-closed literal: unknown versions reject.
 * - Weights live in [0,1] and total exactly 1 within the same ±(5e-6 + 1e-9)
 *   tolerance used by the preference factor-weight envelope.
 * - Temperature is bounded to [CPU_MIN_TEMPERATURE, CPU_MAX_TEMPERATURE] so a
 *   stray payload can neither degenerate the softmax nor flatten it fully.
 * - Snapshots contain no arrays, so the canonical content form needs no
 *   sorting beyond the generic canonicalizer's key ordering.
 */

import { z } from "zod";
import { canonicalize, checksumInput } from "./recommendation";

/** Bumped only when snapshot SHAPE breaks (read-time migration gate). */
export const CPU_SNAPSHOT_VERSION = 1;
/** Bumped only when a definition's semantics change. */
export const CPU_PERSONALITY_VERSION = 1;
/** Bumped only when the pickSeedHex derivation recipe changes. */
export const CPU_SEED_STRATEGY_VERSION = 1;
/** Stored weight precision (matches preferences.WEIGHT_DECIMALS policy). */
export const CPU_WEIGHT_DECIMALS = 6;
/** Softmax temperature bounds — cold (sharp) to hot (exploratory). */
export const CPU_MIN_TEMPERATURE = 0.4;
export const CPU_MAX_TEMPERATURE = 1.6;
/** Default top-K truncation before the softmax draw. */
export const CPU_TOP_K_DEFAULT = 24;

const CPU_WEIGHT_SUM_TOLERANCE = 5 * 10 ** -CPU_WEIGHT_DECIMALS + 1e-9;

/** Feature dimensions in DECLARED order — the selector computes and sums in
 * exactly this order so float addition is byte-reproducible. */
export const cpuFeatureDimensions = [
  "projection",
  "adpValue",
  "scarcityFit",
  "rosterNeed",
  "upside",
  "safety",
  "consistency",
  "ageCurve",
  "categoryEmphasis",
] as const;

export type CpuFeatureDimension = (typeof cpuFeatureDimensions)[number];
export type CpuWeightVector = Record<CpuFeatureDimension, number>;

export type CpuSupportedMode = "MOCK" | "DEMO";

/** Seed-data form authored in this file (authoring convenience fields). */
export interface CpuPersonalityDefinition {
  key: string;
  version: number;
  displayName: string;
  description: string;
  weights: CpuWeightVector;
  temperature: number;
  seedStrategyVersion: number;
  supportedModes: readonly CpuSupportedMode[];
  horizonNotes: string;
}

/** Stored/consumed form (what drafts persist and the selector reads). */
export interface CpuPersonalitySnapshot {
  snapshotVersion: 1;
  key: string;
  version: number;
  displayLabel: string;
  description: string;
  weights: CpuWeightVector;
  temperature: number;
  seedStrategyVersion: number;
}

// ---------------------------------------------------------------------------
// Validation (fail closed, mirroring recommendation-snapshot.ts style)
// ---------------------------------------------------------------------------

const cpuWeightVectorSchema = z
  .object(
    Object.fromEntries(
      cpuFeatureDimensions.map((dimension) => [dimension, z.number().min(0).max(1)]),
    ) as Record<CpuFeatureDimension, z.ZodNumber>,
  )
  .refine(
    (weights) => {
      const total = cpuFeatureDimensions.reduce((sum, dimension) => sum + weights[dimension], 0);
      return Math.abs(total - 1) <= CPU_WEIGHT_SUM_TOLERANCE;
    },
    { message: "CPU personality weights must total 1 (±5e-6)" },
  );

export const cpuPersonalitySnapshotSchema = z.object({
  snapshotVersion: z.literal(CPU_SNAPSHOT_VERSION),
  key: z.string().min(1).max(64),
  version: z.number().int().min(1),
  displayLabel: z.string().min(1).max(80),
  description: z.string().min(1),
  weights: cpuWeightVectorSchema,
  temperature: z.number().min(CPU_MIN_TEMPERATURE).max(CPU_MAX_TEMPERATURE),
  seedStrategyVersion: z.number().int().min(1),
});

/** Stored snapshots are re-validated on read — unknown versions or malformed
 * payloads throw instead of reaching the selector. */
export function parseCpuPersonalitySnapshot(json: unknown): CpuPersonalitySnapshot {
  return cpuPersonalitySnapshotSchema.parse(json);
}

// ---------------------------------------------------------------------------
// Canonical checksum
// ---------------------------------------------------------------------------

/** Deterministic content form. Snapshots carry no unordered collections, so
 * the generic canonicalizer's recursive key sort is sufficient. */
export function canonicalCpuSnapshotContent(
  snapshot: CpuPersonalitySnapshot,
): Record<string, unknown> {
  return {
    snapshotVersion: snapshot.snapshotVersion,
    key: snapshot.key,
    version: snapshot.version,
    displayLabel: snapshot.displayLabel,
    description: snapshot.description,
    weights: { ...snapshot.weights },
    temperature: snapshot.temperature,
    seedStrategyVersion: snapshot.seedStrategyVersion,
  };
}

export function checksumCpuPersonalitySnapshot(snapshot: CpuPersonalitySnapshot): string {
  return checksumInput(canonicalize(canonicalCpuSnapshotContent(snapshot)));
}

// ---------------------------------------------------------------------------
// Definition -> snapshot projection
// ---------------------------------------------------------------------------

export function toCpuPersonalitySnapshot(
  definition: CpuPersonalityDefinition,
): CpuPersonalitySnapshot {
  return {
    snapshotVersion: CPU_SNAPSHOT_VERSION,
    key: definition.key,
    version: definition.version,
    displayLabel: definition.displayName,
    description: definition.description,
    weights: { ...definition.weights },
    temperature: definition.temperature,
    seedStrategyVersion: definition.seedStrategyVersion,
  };
}

// ---------------------------------------------------------------------------
// Seed definitions
// ---------------------------------------------------------------------------

/** Builds a weight vector in DECLARED dimension order and fails fast at
 * module load if a seed vector is malformed (configuration bug, not runtime). */
function weightsInDeclaredOrder(units: readonly number[]): CpuWeightVector {
  if (units.length !== cpuFeatureDimensions.length) {
    throw new Error(
      `CPU personality weights must cover exactly ${String(cpuFeatureDimensions.length)} dimensions`,
    );
  }
  const weights = {} as CpuWeightVector;
  cpuFeatureDimensions.forEach((dimension, index) => {
    const value = units[index];
    if (value === undefined || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`CPU personality weight for ${dimension} must be a finite number in [0,1]`);
    }
    weights[dimension] = value;
  });
  const total = cpuFeatureDimensions.reduce((sum, dimension) => sum + weights[dimension], 0);
  if (Math.abs(total - 1) > CPU_WEIGHT_SUM_TOLERANCE) {
    throw new Error(`CPU personality weights must total 1 (got ${total.toFixed(6)})`);
  }
  return weights;
}

function definition(
  key: string,
  displayName: string,
  description: string,
  temperature: number,
  units: readonly number[],
  horizonNotes: string,
): CpuPersonalityDefinition {
  return {
    key,
    version: CPU_PERSONALITY_VERSION,
    displayName,
    description,
    weights: weightsInDeclaredOrder(units),
    temperature,
    seedStrategyVersion: CPU_SEED_STRATEGY_VERSION,
    supportedModes: ["MOCK", "DEMO"],
    horizonNotes,
  };
}

/**
 * The eight launch personalities. Dimension order:
 * projection | adpValue | scarcityFit | rosterNeed | upside | safety |
 * consistency | ageCurve | categoryEmphasis
 */
export const cpuPersonalities: readonly CpuPersonalityDefinition[] = [
  definition(
    "adp-follower",
    "ADP Follower",
    "Tracks consensus market value; rarely reaches, rarely fades the board.",
    0.9,
    [0.2, 0.45, 0.08, 0.05, 0.05, 0.07, 0.05, 0.02, 0.03],
    "ADP tracking applies identically in every horizon.",
  ),
  definition(
    "projection-purist",
    "Projection Purist",
    "Ignores buzz and ADP; takes whatever the projections rank highest.",
    0.8,
    [0.55, 0.05, 0.1, 0.05, 0.08, 0.07, 0.06, 0.01, 0.03],
    "Pure projection ranking in every horizon.",
  ),
  definition(
    "balanced",
    "Balanced",
    "The default blend of production, fit, market value, and safety.",
    1.0,
    [0.32, 0.1, 0.12, 0.12, 0.08, 0.09, 0.07, 0.05, 0.05],
    "Neutral blend across horizons and scoring types.",
  ),
  definition(
    "positional-drafter",
    "Positional Drafter",
    "Attacks its own open starter slots and scarce positions first.",
    0.9,
    [0.18, 0.06, 0.22, 0.3, 0.05, 0.07, 0.06, 0.02, 0.04],
    "Roster-need urgency applies in every horizon.",
  ),
  definition(
    "upside-hunter",
    "Upside Hunter",
    "Chases breakout ceilings and tolerates volatility.",
    1.4,
    [0.16, 0.08, 0.08, 0.05, 0.42, 0.03, 0.03, 0.1, 0.05],
    "Ceiling chase applies in every horizon; volatility tolerated.",
  ),
  definition(
    "safe-veteran",
    "Safe Veteran",
    "Durable, consistent floors over rookie uncertainty.",
    0.7,
    [0.16, 0.08, 0.06, 0.05, 0.02, 0.3, 0.24, 0.04, 0.05],
    "Floor-first applies in every horizon.",
  ),
  definition(
    "dynasty-youth",
    "Dynasty Youth",
    "Young runway picks; age matters most in keeper and dynasty.",
    1.1,
    [0.14, 0.06, 0.08, 0.05, 0.24, 0.04, 0.03, 0.3, 0.06],
    "Age curve applies in KEEPER/DYNASTY; neutral in redraft.",
  ),
  definition(
    "category-specialist",
    "Category Specialist",
    "Targets single-category elites; strongest in category leagues.",
    0.9,
    [0.18, 0.06, 0.12, 0.08, 0.08, 0.05, 0.05, 0.04, 0.34],
    "Category emphasis applies under CATEGORIES scoring; muted in points leagues.",
  ),
];

const cpuPersonalitiesByKey = new Map(cpuPersonalities.map((entry) => [entry.key, entry]));

export function cpuPersonalityByKey(key: string): CpuPersonalityDefinition | undefined {
  return cpuPersonalitiesByKey.get(key);
}

export const defaultCpuPersonalityKey = "balanced";
