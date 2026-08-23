import { z } from "zod";
import { compact } from "@/lib/compact";
import { decodeCursor, RANGE_STAT_FIELDS } from "@/lib/server/players";
import type { PlayerListFilters, PlayerListQuery, PlayerSortField } from "@/lib/server/players";

/**
 * Shared between `GET /api/v1/players` and the `/players` Server Component
 * page — one query-param contract, not two independently maintained ones.
 */

const csv = () => z.string().transform((value) => value.split(",").filter(Boolean));
// `z.coerce.number()` on `""` (an empty numeric `<input>` — every "More
// filters" field is submitted with the form even when left blank, since
// closing a <details> panel doesn't remove its fields from the DOM) would
// otherwise coerce to `0` and be treated as an active "exactly 0" filter,
// zeroing out results on every filter-form submission. Blank means absent.
const numeric = () =>
  z.preprocess((value) => (value === "" ? undefined : value), z.coerce.number().optional());
const boolish = z.enum(["true", "false"]).transform((v) => v === "true");

export const playersQuerySchema = z.object({
  name: z.string().min(1).max(80).optional(),
  team: csv().optional(),
  position: csv().optional(),
  availability: csv().optional(),
  unsigned: boolish.optional(),
  rookie: boolish.optional(),
  ageMin: numeric().optional(),
  ageMax: numeric().optional(),
  adpMin: numeric().optional(),
  adpMax: numeric().optional(),
  rankMin: numeric().optional(),
  rankMax: numeric().optional(),
  gamesMin: numeric().optional(),
  gamesMax: numeric().optional(),
  minutesMin: numeric().optional(),
  minutesMax: numeric().optional(),
  fantasyPointsMin: numeric().optional(),
  fantasyPointsMax: numeric().optional(),
  ptsMin: numeric().optional(),
  ptsMax: numeric().optional(),
  rebMin: numeric().optional(),
  rebMax: numeric().optional(),
  astMin: numeric().optional(),
  astMax: numeric().optional(),
  stlMin: numeric().optional(),
  stlMax: numeric().optional(),
  blkMin: numeric().optional(),
  blkMax: numeric().optional(),
  tovMin: numeric().optional(),
  tovMax: numeric().optional(),
  threePmMin: numeric().optional(),
  threePmMax: numeric().optional(),
  injuryRiskMin: numeric().optional(),
  injuryRiskMax: numeric().optional(),
  consistencyMin: numeric().optional(),
  consistencyMax: numeric().optional(),
  upsideMin: numeric().optional(),
  upsideMax: numeric().optional(),
  roleSecurityMin: numeric().optional(),
  roleSecurityMax: numeric().optional(),
  sort: z
    .enum([...RANGE_STAT_FIELDS, "displayName", "adp"] as [PlayerSortField, ...PlayerSortField[]])
    .default("overallRank"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PlayersQuery = z.infer<typeof playersQuerySchema>;

// Maps `<stat>Min`/`<stat>Max` query params onto `PlayerListFilters.ranges`.
const RANGE_QUERY_MAP: Record<string, string> = {
  rank: "overallRank",
  games: "games",
  minutes: "minutesPerGame",
  fantasyPoints: "fantasyPoints",
  pts: "pts",
  reb: "reb",
  ast: "ast",
  stl: "stl",
  blk: "blk",
  tov: "tov",
  threePm: "threePm",
  injuryRisk: "injuryRisk",
  consistency: "consistency",
  upside: "upside",
  roleSecurity: "roleSecurity",
};

export function zodIssuesToFieldErrors(issues: z.ZodError["issues"]): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.join(".") || "query";
    errors[key] = [...(errors[key] ?? []), issue.message];
  }
  return errors;
}

export function toPlayerListQuery(query: PlayersQuery): PlayerListQuery {
  const ranges: NonNullable<PlayerListFilters["ranges"]> = {};
  for (const [prefix, field] of Object.entries(RANGE_QUERY_MAP)) {
    const min = query[`${prefix}Min` as keyof PlayersQuery] as number | undefined;
    const max = query[`${prefix}Max` as keyof PlayersQuery] as number | undefined;
    if (min !== undefined || max !== undefined) {
      ranges[field as keyof NonNullable<PlayerListFilters["ranges"]>] = compact({ min, max });
    }
  }

  const filters: PlayerListFilters = compact({
    name: query.name,
    team: query.team,
    position: query.position,
    availability: query.availability,
    unsigned: query.unsigned,
    rookie: query.rookie,
    ageMin: query.ageMin,
    ageMax: query.ageMax,
    adpMin: query.adpMin,
    adpMax: query.adpMax,
    ranges,
  });

  const cursor = decodeCursor(query.cursor);
  return {
    filters,
    sort: query.sort,
    direction: query.direction,
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}
