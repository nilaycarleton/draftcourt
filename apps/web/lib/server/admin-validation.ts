import { z } from "zod";
import { OVERRIDABLE_STATS, SIGNAL_TYPES } from "@/lib/shared/admin-constants";

/** Mirrors the DB-level CHECK constraints added by hand to
 * `projection_overrides_value_xor_check` / `projection_overrides_rationale_check`
 * (packages/db/prisma/migrations/20260821004305_.../migration.sql) — this
 * schema is a friendlier 422 in front of the same rule, not a replacement
 * for it; the DB constraint remains the source of truth. */
export const createOverrideSchema = z
  .object({
    playerId: z.uuid(),
    season: z.string().min(1),
    stat: z.enum(OVERRIDABLE_STATS),
    deltaValue: z.number().optional(),
    replacementValue: z.number().min(0).optional(),
    rationale: z.string().trim().min(1, "A rationale is required."),
    effectiveAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().optional(),
    supersedesId: z.uuid().optional(),
  })
  .refine((v) => (v.deltaValue !== undefined) !== (v.replacementValue !== undefined), {
    message: "Provide exactly one of deltaValue or replacementValue.",
    path: ["deltaValue"],
  });

export const createSignalSchema = z.object({
  playerId: z.uuid(),
  type: z.enum(SIGNAL_TYPES),
  impact: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).optional(),
  effectiveAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().optional(),
});
