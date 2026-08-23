import { z } from "zod";
import { directionSchema, leagueHorizonSchema, leagueTypeSchema, positionSchema } from "./enums";

/**
 * League configuration contracts (BUILD_SPEC.md sections 2.1, 4.2, 5).
 * These schemas are the single validation vocabulary shared by the wizard
 * UI, the API boundary (`lib/server/leagues.ts`), and — via generated JSON
 * Schema — cross-service consumers. Structural validation lives here;
 * cross-field business rules that need database context (keeper validity,
 * season-vs-player mismatch at draft time) live in the service layer.
 */

/** Full supported stat-key vocabulary (superset of contracts.ts's
 * wellKnownStatKeys, which predates Phase 2). */
export const supportedStatKeys = [
  "PTS",
  "REB",
  "AST",
  "STL",
  "BLK",
  "TOV",
  "FGM",
  "FGA",
  "FG_PCT",
  "FTM",
  "FTA",
  "FT_PCT",
  "THREE_PM",
  "GAMES",
  "MINUTES",
] as const;

/** Stats whose league-relative value flips sign under LOWER_BETTER. */
export const percentageStatKeys = ["FG_PCT", "FT_PCT"] as const;
export const negativeStatKeys = ["TOV"] as const;

const statKeySchema = z.string().min(1).max(64);

export const scoringRuleInputSchema = z
  .object({
    stat: statKeySchema,
    /** Points value per unit (POINTS) or category weight multiplier
     * (CATEGORIES). Negative weights are legitimate in points leagues
     * (e.g. TOV = -1); punts are expressed as exactly 0 with punt=true. */
    weight: z.number().min(-1000).max(1000),
    direction: directionSchema,
    enabled: z.boolean().default(true),
    punt: z.boolean().default(false),
  })
  .superRefine((rule, ctx) => {
    if (!puntConsistent(rule)) {
      ctx.addIssue({
        code: "custom",
        path: ["weight"],
        message: "a punt requires weight 0; a non-punt rule needs a nonzero weight",
      });
    }
    if (
      (percentageStatKeys as readonly string[]).includes(rule.stat) &&
      rule.direction !== "HIGHER_BETTER"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["direction"],
        message: `${rule.stat} is a percentage — only HIGHER_BETTER is meaningful`,
      });
    }
  });

function puntConsistent(rule: { weight: number; punt: boolean }): boolean {
  return rule.punt ? rule.weight === 0 : rule.weight !== 0;
}

export const rosterSlotInputSchema = z
  .object({
    position: positionSchema,
    count: z.number().int().min(0).max(10),
    /** BENCH must be starter=false; every other slot is a starting slot. */
    starter: z.boolean().default(true),
  })
  .superRefine((slot, ctx) => {
    if (slot.position === "BENCH" && slot.starter) {
      ctx.addIssue({
        code: "custom",
        path: ["starter"],
        message: "BENCH slots are not starting slots",
      });
    }
    if (slot.position !== "BENCH" && !slot.starter && slot.count > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["starter"],
        message: `only BENCH can be a non-starter slot (${slot.position})`,
      });
    }
  });

export const leagueConfigSchema = z
  .object({
    type: leagueTypeSchema,
    horizon: leagueHorizonSchema,
    scoringRules: z.array(scoringRuleInputSchema).min(1).max(15),
    rosterSlots: z.array(rosterSlotInputSchema).min(4).max(9),
    /** Fantasy playoff weeks the user's league plays (informational for the
     * schedule component; null = user didn't configure it). */
    playoffWeeks: z.number().int().min(1).max(14).nullable().default(null),
  })
  .superRefine((config, ctx) => {
    const seenStats = new Set<string>();
    for (const [index, rule] of config.scoringRules.entries()) {
      if (seenStats.has(rule.stat)) {
        ctx.addIssue({
          code: "custom",
          path: ["scoringRules", index, "stat"],
          message: `duplicate stat key ${rule.stat}`,
        });
      }
      seenStats.add(rule.stat);
    }

    const seenPositions = new Set<string>();
    for (const [index, slot] of config.rosterSlots.entries()) {
      if (seenPositions.has(slot.position)) {
        ctx.addIssue({
          code: "custom",
          path: ["rosterSlots", index, "position"],
          message: `duplicate roster position ${slot.position}`,
        });
      }
      seenPositions.add(slot.position);
    }

    if (!seenStats.has("PTS") && config.type === "POINTS") {
      ctx.addIssue({
        code: "custom",
        path: ["scoringRules"],
        message: "points leagues must include a PTS rule",
      });
    }

    const total = config.rosterSlots.reduce((sum, s) => sum + s.count, 0);
    const starters = config.rosterSlots.reduce((sum, s) => sum + (s.starter ? s.count : 0), 0);
    if (total < 6 || total > 20) {
      const totalLabel = String(total);
      ctx.addIssue({
        code: "custom",
        path: ["rosterSlots"],
        message: `total roster size must be 6–20 (got ${totalLabel})`,
      });
    }
    if (starters < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["rosterSlots"],
        message: "at least one starting slot is required",
      });
    }
    if (starters >= total) {
      ctx.addIssue({
        code: "custom",
        path: ["rosterSlots"],
        message: "at least one bench slot is required beyond the starters",
      });
    }
  });

export type LeagueConfig = z.infer<typeof leagueConfigSchema>;
export type ScoringRuleInput = z.infer<typeof scoringRuleInputSchema>;
export type RosterSlotInput = z.infer<typeof rosterSlotInputSchema>;

/** Season string form used everywhere ("2026-27"). The second half is the
 * ending year mod 100 of the first half + 1. */
export const seasonSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "season must look like 2026-27")
  .refine((value) => {
    const [startRaw, endRaw] = value.split("-");
    const end = Number(endRaw);
    return end === (Number(startRaw) + 1) % 100;
  }, "season halves must be consecutive years");

// ---------------------------------------------------------------------------
// Full creation payload shared by the wizard client and the API boundary
// ---------------------------------------------------------------------------

export const leagueCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  season: seasonSchema,
  teamCount: z.number().int().min(4).max(20),
  userDraftSlot: z.number().int().min(1),
  rounds: z.number().int().min(1).max(30),
  config: leagueConfigSchema,
});
export type LeagueCreateInput = z.infer<typeof leagueCreateSchema>;

// ---------------------------------------------------------------------------
// Presets — expanded into persisted custom rules on save (BUILD_SPEC section
// 2.1: "persist the expanded custom configuration").
// ---------------------------------------------------------------------------

const hb = "HIGHER_BETTER" as const;
const lb = "LOWER_BETTER" as const;

function cat(
  stat: string,
  weight = 1,
  direction: "HIGHER_BETTER" | "LOWER_BETTER" = hb,
): ScoringRuleInput {
  return { stat, weight, direction, enabled: true, punt: false };
}

export function pointsPreset(): ScoringRuleInput[] {
  return [
    cat("PTS", 1),
    cat("REB", 1.2),
    cat("AST", 1.5),
    cat("STL", 3),
    cat("BLK", 3),
    cat("TOV", -1, lb),
    cat("FGM", 2),
    cat("FTM", 1),
    cat("THREE_PM", 1),
  ];
}

export function eightCategoryPreset(): ScoringRuleInput[] {
  return [
    cat("PTS"),
    cat("REB"),
    cat("AST"),
    cat("STL"),
    cat("BLK"),
    { stat: "TOV", weight: 1, direction: lb, enabled: true, punt: false },
    cat("FG_PCT"),
    cat("FT_PCT"),
  ];
}

export function nineCategoryPreset(): ScoringRuleInput[] {
  return [...eightCategoryPreset(), cat("THREE_PM")];
}

export function defaultRosterSlots(): RosterSlotInput[] {
  return [
    { position: "PG", count: 1, starter: true },
    { position: "SG", count: 1, starter: true },
    { position: "SF", count: 1, starter: true },
    { position: "PF", count: 1, starter: true },
    { position: "C", count: 1, starter: true },
    { position: "G", count: 1, starter: true },
    { position: "F", count: 1, starter: true },
    { position: "UTIL", count: 1, starter: true },
    { position: "BENCH", count: 3, starter: false },
  ];
}
