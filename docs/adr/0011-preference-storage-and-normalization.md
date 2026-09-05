# ADR 0011: Preference storage, versioning, and normalization

- Status: accepted
- Date: 2026-08-23
- Phase: 3A — preference profiles foundation

## Context

BUILD_SPEC.md sections 2.2 and 4.2 require per-user strategy profiles
(factor weights over the engine's eleven components, scalar controls for
risk/upside/age/role/schedule, position and category priorities, explicit
punts, an avoid mode, favorite/disliked/target/avoid player lists, team
preferences, custom ranks) that Phase 3B will feed into recommendation
snapshots as immutable inputs.

The repository had to decide: relational columns vs a versioned JSON envelope
for the evolvable settings; how to guarantee normalization exactness; and how
to express "one default profile per owner" plus global-scope rank uniqueness
when Postgres treats NULLs as distinct in composite unique indexes.

## Decision

1. **Versioned JSON envelope for profile settings** (`settingsJson`,
   `schemaVersion` = 1) validated at every boundary by
   `packages/domain/src/preferences.ts::preferenceSettingsSchema`, exactly as
   BUILD_SPEC §4.2 sketches ("factor weights JSON validated against schema").
   Rationale: the shape evolves per schema version (new controls are additive)
   and is always read/written atomically as one strategy document. Relational
   tables remain for anything referenced by id (players, teams) or globally
   queryable (custom ranks).
2. **Stored JSON re-validated on read** (`parseStoredSettings`) so a future
   version bump or manual write fails closed instead of feeding malformed
   weights into the engine.
3. **Exact normalization at fixed precision**: weights round to 6 decimal
   places via largest-remainder distribution; the stored decimal values sum to
   exactly 1. Locked sliders pin their values at stored precision while
   unlocked factors share the remainder proportionally to prior shares;
   impossible locked totals (>100%) throw an actionable error. Presets are
   versioned data definitions whose application produces complete editable
   settings through the same normalization (never UI conditionals).
4. **Partial unique indexes** (hand-added SQL inside the Prisma-managed
   migration `20260824033036_phase3a_preferences`):
   - one default profile per owner: `(owner_id) WHERE is_default`;
   - global custom-rank uniqueness on `(owner_id, player_id)` and
     `(owner_id, rank)` `WHERE league_id IS NULL`.
     League-scoped rows use ordinary composite uniques. The service layer also
     validates duplicates before writing; the indexes are the concurrency
     backstop.
5. **Cascade policy**: deleting a profile cascades only its list rows.
   Players, teams, leagues, users, drafts, and audit rows are never deleted by
   preference deletes (player/team FKs restrict). Deleting a league removes
   that league's scoped ranks (they have no meaning without it); global ranks
   survive. Deleting the default profile promotes the most recently _created_
   remaining profile — deterministic even though default-swaps bump
   `updatedAt`.
6. **Web-only contracts**: preference schemas intentionally stay out of
   `data/schemas` JSON-Schema generation — that pipeline exists for the
   TypeScript↔Python analytics contract, and preferences never reach Python in
   this slice.

## Consequences

- Adding new controls in later slices means bumping
  `PREFERENCE_SCHEMA_VERSION`, adding a read-migration in
  `lib/server/preference-profiles.ts`, and extending the Zod schema + tests.
- Recommendation integration (Phase 3B) must snapshot the VALIDATED settings
  JSON (plus profile id/version) into drafts; historical replay therefore never
  depends on mutable profile rows.
- The partial indexes make duplicate writes impossible under concurrency even
  if two clients PUT simultaneously; the API maps the resulting P2002 to 409.

## Verification

Domain unit + property tests (`preferences.test.ts`, 18 cases), DB-backed
service tests (`preference-profiles.test.ts`, `custom-ranks.test.ts`, 14
cases incl. raw-write proof of the partial indexes), authenticated Playwright
coverage (`tests/e2e/preferences.spec.ts`). Full gate: `pnpm test:all`.
