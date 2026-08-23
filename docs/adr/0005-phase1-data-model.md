# ADR 0005: Phase 1 data model and cross-language write boundary

- Status: accepted
- Date: 2026-08-21
- Phase: 1 — data, projections baseline, player experience

## Context

BUILD_SPEC.md section 4.2 lists the Phase 1 tables (`NbaTeam`, `Player`,
`PlayerEligibility`, `PlayerSeasonStat`, `DataSource`, `IngestionRun`,
`RawSourceRecord`, `PlayerNewsSignal`, `AdpObservation`,
`AdpConsensusSnapshot`, `AdpConsensusPlayer`, `ProjectionModel`,
`ProjectionRun`, `PlayerProjection`, `ProjectionOverride`, `AuditLog`) as
"essential fields," not an exhaustive DDL. ADR 0002 established that
Prisma remains the sole migration owner and that Python accesses Postgres
through SQLAlchemy Core for batch work, never migrations. Phase 0's only
table (`User`) established a naming convention worth carrying forward
faithfully rather than reinventing.

## Decision

### Table/column naming: `@@map` on the table only, columns stay camelCase

Inspecting the actual Phase 0 migration (`20260820215725_init/migration.sql`)
shows `users` (snake_case, via `@@map("users")`) but every column
(`clerkUserId`, `createdAt`, ...) stays camelCase as a quoted Postgres
identifier — Prisma does not snake_case columns automatically, and Phase 0
never added per-field `@map`. Every Phase 1 table follows this exact
pattern: snake_case plural table name via `@@map`, camelCase quoted
columns, no per-field `@map`. This is what lets
`services/analytics/app/ingestion/db.py`'s SQLAlchemy Core `Table`
definitions address the identical physical schema Prisma owns without any
translation layer — the concrete mechanism behind ADR 0002's "Python uses
SQLAlchemy Core... it never creates migrations."

### `timestamptz`, not Phase 0's untyped `DateTime`

BUILD_SPEC.md section 4 requires UTC `timestamptz`. Phase 0's `User` table
used bare `DateTime` (no `@db.Timestamptz`), which Prisma 7.9.1 maps to
`timestamp(3)` — no time zone. That was in scope only for the minimal
Clerk-mirror table and is left alone rather than touched by an unrelated
migration; every Phase 1 `DateTime` column is explicit
`@db.Timestamptz`.

### One table beyond the named list: `PlayerExternalIdentity`

BUILD_SPEC.md section 7.2's identity reconciliation requirements — "avoid
automatic fuzzy merges below a documented confidence threshold," "create a
reviewable unresolved state," "preserve aliases and provider mappings,"
"pass collision and duplicate-name tests" — need a queryable place to hold
a _tentative_ or _rejected_ match, independent of whether a `Player` row
exists yet. `PlayerExternalIdentity` (`sourceId`, `externalId`,
`playerId` nullable, `candidateName`, `candidateDob`, `matchConfidence`,
`matchMethod`, `status: CONFIRMED|CANDIDATE|REJECTED`) is that table:
`playerId` stays null while `status = CANDIDATE` (the reviewable
unresolved state), and `candidateName` preserves the raw source-observed
name as an alias even after a row is later confirmed and linked. Without
this table, "unresolved identity" would have nowhere durable to live.

### Constraints Prisma's schema DSL cannot express

Three things were added by hand-editing the generated
`migration.sql` immediately after `prisma migrate dev` scaffolded it,
rather than via `schema.prisma` syntax (verified against Prisma 7.9.1 —
none of these have first-class schema DSL support yet):

1. **Partial unique index** — `projection_runs_one_current_per_season`
   on `("season") WHERE "isCurrent" = true`. This is the entire
   atomic-publish mechanism (BUILD_SPEC.md §7.2: "Publishing a run is
   atomic"): a transaction that sets a new run's `isCurrent = true` before
   flipping the old run's `isCurrent = false` is rejected by Postgres
   itself if it would create two current rows for the same season, so
   readers can never observe a half-published state.
2. **CHECK constraints** on `projection_overrides`
   (`num_nonnulls("deltaValue", "replacementValue") = 1`, and a non-empty
   `rationale`) and `player_season_stats` (`fgm <= fga`, `ftm <= fta` —
   defense in depth; the ingestion pipeline's Pydantic validation already
   enforces this before any insert, so this is a second, cheap layer, not
   the primary guard).
3. **`pg_trgm` extension + GIN index** on `players.displayName`, per
   BUILD_SPEC.md §4.3's "normalized display name trigram/search index."

These statements were appended to the _same_ migration file the schema
change produced (not a separate migration), applied to the already-running
local dev database via a direct `psql` session (not `prisma migrate
reset`, which Prisma's own CLI refuses to run for an AI agent without
explicit user consent — correctly, since it drops the database), and
independently verified by applying the complete, edited migration file to
a disposable fresh database. Migration files are forward-only per
BUILD_SPEC.md §17; nothing here is ever regenerated.

### `overallRank` on `PlayerProjection`

BUILD_SPEC.md's Phase 1 player API requires filtering/sorting by "internal
rank," but the real recommendation engine (BUILD_SPEC.md §6) is Phase 2+
work and depends on league/roster context Phase 1 players don't have.
`overallRank` is a documented, honestly-labeled interim definition —
players within a publish are ranked by a standard 9-category fantasy
points formula computed at publish time — not a placeholder for the
Phase 2 engine and not presented as one anywhere in the UI/API.

### `Decimal` vs `Float`

Per BUILD_SPEC.md §4 ("Decimal for externally meaningful numeric
weights/percentages"): `Decimal` is used only for ADP values
(`AdpObservation.adp`, `AdpConsensusPlayer.consensusAdp`/`dispersion`) and
override adjustment values (`ProjectionOverride.deltaValue`/
`replacementValue`) — numbers that represent external market/
administrative inputs. Everything else numeric (projected stat totals,
`injuryRisk`/`consistency`/`upside`/`roleSecurity` scores,
`valueConfidence`) is `Float`, matching the existing Phase 0
`packages/domain` `ProjectedLine` Zod contract, which already types these
as plain `z.number()`.

## Consequences

- `PlayerSeasonStat` stores season **totals** only (`gamesPlayed`,
  `minutesTotal`, counting stats, `fgm`/`fga`/`ftm`/`fta`) — never a
  stored shooting-percentage column. Every consumer (baseline projection,
  API, UI) derives per-game and percentage figures at read time, which is
  what makes "never average percentage columns directly" structurally
  true rather than a convention someone can forget.
- Any future live source adapter is a new `DataSource` row plus a new
  `SourceAdapter.extract()` implementation (see ADR 0006) — no schema
  change is implied by swapping the demo file adapter for a real one.
- `docs/architecture/erd.md` is a hand-maintained view of this schema, not
  auto-generated; update it in the same commit as any future schema
  change.
