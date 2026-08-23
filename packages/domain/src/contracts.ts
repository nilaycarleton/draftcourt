import { z } from "zod";
import { directionSchema } from "./enums";

/**
 * Shared contracts exchanged between the TypeScript app layer and the Python
 * analytics service, per BUILD_SPEC.md section 5. Both sides validate the same
 * fixtures in data/schemas/fixtures — see packages/domain/src/contracts.test.ts
 * and services/analytics/tests/test_contracts.py.
 *
 * These are structural contracts only (Phase 0). The recommendation engine,
 * projection pipeline, and persistence that produce/consume real instances of
 * these shapes are built in later phases.
 */

const wellKnownStatKeys = [
  "PTS",
  "REB",
  "AST",
  "STL",
  "BLK",
  "TOV",
  "FG_PCT",
  "FT_PCT",
  "THREE_PM",
] as const;

/** League scoring category or points weight. `stat` accepts the well-known keys above
 * or a league-defined custom category key. */
export const leagueScoringRuleSchema = z.object({
  stat: z.string().min(1).max(64),
  weight: z.number(),
  direction: directionSchema,
  punt: z.boolean(),
});
export type LeagueScoringRule = z.infer<typeof leagueScoringRuleSchema>;
export { wellKnownStatKeys };

const statRecordSchema = z.record(z.string(), z.number());

export const projectedLineSchema = z.object({
  playerId: z.uuid(),
  games: z.number().nonnegative(),
  minutesPerGame: z.number().nonnegative(),
  pts: z.number().nonnegative(),
  reb: z.number().nonnegative(),
  ast: z.number().nonnegative(),
  stl: z.number().nonnegative(),
  blk: z.number().nonnegative(),
  tov: z.number().nonnegative(),
  fgm: z.number().nonnegative(),
  fga: z.number().nonnegative(),
  ftm: z.number().nonnegative(),
  fta: z.number().nonnegative(),
  threePm: z.number().nonnegative(),
  lower80: statRecordSchema,
  upper80: statRecordSchema,
  injuryRisk: z.number().min(0).max(1),
  consistency: z.number().min(0).max(1),
  upside: z.number().min(0).max(1),
  roleSecurity: z.number().min(0).max(1),
});
export type ProjectedLine = z.infer<typeof projectedLineSchema>;

export const scoreComponentKeySchema = z.enum([
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
  "schedule",
]);
export type ScoreComponentKey = z.infer<typeof scoreComponentKeySchema>;

export const scoreComponentSchema = z.object({
  key: scoreComponentKeySchema,
  raw: z.number(),
  normalized: z.number().min(0).max(1),
  weight: z.number().min(0).max(1),
  contribution: z.number(),
  reason: z.string().min(1),
});
export type ScoreComponent = z.infer<typeof scoreComponentSchema>;
// Structural Zod schema mirrors the engine's ScoreComponent interface
// (recommendation.ts) — the engine type remains the implementation source.

export const recommendationLabelSchema = z.enum([
  "BEST_OVERALL",
  "BEST_FIT",
  "BEST_VALUE",
  "HIGHEST_UPSIDE",
  "SAFEST_PICK",
]);
export type RecommendationLabel = z.infer<typeof recommendationLabelSchema>;

export const confidenceSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type Confidence = z.infer<typeof confidenceSchema>;

export const recommendationSchema = z.object({
  playerId: z.uuid(),
  rank: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  draftScore: z.number().min(0).max(100),
  labels: z.array(recommendationLabelSchema).min(1),
  explanation: z.string().min(1),
  availabilityNextPick: z.number().min(0).max(1),
  confidence: confidenceSchema,
  components: z.array(scoreComponentSchema).min(1),
  engineVersion: z.string().min(1),
  projectionRunId: z.uuid(),
  inputChecksum: z.string().min(1),
});
export type Recommendation = z.infer<typeof recommendationSchema>;
