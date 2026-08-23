/** Pure constants shared between server-only admin modules (which import
 * Prisma) and client admin form components (which must not) — kept in a
 * dependency-free file so importing it never pulls Prisma into a client
 * bundle. Mirrors `_OVERRIDABLE_STATS` in
 * `services/analytics/app/pipelines/adjustments.py`. */
export const OVERRIDABLE_STATS = [
  "games",
  "minutesPerGame",
  "pts",
  "reb",
  "ast",
  "stl",
  "blk",
  "tov",
  "fgm",
  "fga",
  "ftm",
  "fta",
  "threePm",
] as const;
export type OverridableStat = (typeof OVERRIDABLE_STATS)[number];

export const SIGNAL_TYPES = ["INJURY", "TRADE", "STARTER_CHANGE", "ROLE_UP", "ROLE_DOWN"] as const;
export type SignalTypeValue = (typeof SIGNAL_TYPES)[number];
