# Phase 3A Recovery Checkpoint — Preference Profiles Foundation

**Session start:** 2026-08-23 ~19:00 local
**Starting commit:** `5aa63a2` ("chore: untrack analytics coverage artifact")
**Dirty tree at start:** 39 uncommitted paths — the fully accepted Phase 2 slice
(modified: DraftRoom.tsx, drafts.ts, vitest configs, package.json, lockfile,
BUILD_SPEC.md; untracked: board/UI components + tests + snapshots, e2e specs,
helpers, docs/design + docs/recovery, PHASE_3_OPENCODE_PROMPT.md).
**These are preserved exactly. No reset/stash/commit/push at any point.**

## Scope of this session (Phase 3A only)

One bounded vertical slice: preference-profiles foundation.

- M1 domain contracts, reciprocal-rank defaults, locked-slider normalization,
  13 versioned presets (+ tests) — `packages/domain/src/preferences.ts`
- M2 Prisma models/migration (profiles, player/team preferences, custom ranks,
  partial unique indexes for NULL-league/global scopes and single default),
  owner-scoped repositories (+ DB-backed tests)
- M3 APIs: GET/POST `/api/v1/preference-profiles`, GET/PATCH/DELETE `…/:id`,
  GET/PUT `/api/v1/custom-ranks` (auth, ownership/enumeration resistance,
  validation, transactional rank replacement, rate limit, redacted audit)
- M4 authenticated `/preferences` workspace UI (+ a11y/RTL tests, Storybook
  coverage via a new locked-slider primitive, authenticated Playwright spec)
- Docs: ADR 0011 (preference storage/versioning/normalization), architecture
  doc with ERD + methodology, Impeccable shape/critique-audit reports,
  this checkpoint

Explicitly OUT of scope (later slices): recommendation-engine personalization,
immutable active-draft snapshots, league/draft overrides wiring beyond schema
headroom, CPU/demo mocks, history/analysis/replay/sharing, Phase 4.

## Plan / milestone order

1. Discovery & design (this section)
2. Domain contracts & presets
3. Persistence & migration
4. APIs & authorization
5. `/preferences` UI
6. Focused verification per milestone; full gate at the end
7. Documentation, Graphify refresh, final report

## Key conventions discovered (source of truth for this slice)

- Envelope `{data,error:{type,title,status,detail?,errors?},meta:{traceId}}` —
  `apps/web/lib/api/envelope.ts`; add `conflict` problem type there.
- Auth: `getCurrentUser()` (`lib/server/auth.ts`) → user id or null;
  non-owner lookups resolve to same null/404 as missing (no enumeration oracle)
  — pattern from `lib/server/leagues.ts`.
- Rate limiting without Redis: Postgres count-in-window
  (`recommendations.ts::recalculateForOwner`) — reuse for preference mutations.
- Audit: `lib/server/audit-log.ts::writeAuditLog` (redacted before/after).
- Zod at boundaries; server-layer schemas wrap domain schemas
  (`createLeagueSchema` precedent). Domain owns structural validation.
- Prisma: uuid(7) PKs, `@@map` snake_case, Timestamptz, Decimal(10,3) for
  scoring weights, enums mirrored from `packages/domain/src/enums.ts`.
- JSON Schema generation (`contracts:generate`) is for TS↔Python analytics
  contracts only — preference profiles never reach Python in this slice, so
  they stay web-only (documented in ADR 0011).
- Tests: Vitest; DB-backed service tests hit real local Postgres
  (`postgresql://draftcourt:draftcourt@localhost:55432/draftcourt` from
  apps/web/vitest.config.ts); Playwright auth helpers exist from Phase 2
  (`tests/e2e/helpers/clerk-test-env.ts`: resetClerkTestUser +
  signInViaTicket).
- UI: app-local feature components (LeagueWizard precedent), `dc-*` classes in
  `app/globals.css`/`phase2.css`, packages/ui holds primitives w/ Storybook.

## Milestone log

(Updated after every completed milestone — see entries below.)

## Milestone 1 COMPLETE (domain contracts & presets)

- `packages/domain/src/preferences.ts`: versioned settings envelope
  (`PREFERENCE_SCHEMA_VERSION=1`), 11 factor keys tied to engine ComponentKeys,
  reciprocal-rank defaults over BUILD_SPEC §2.2 priority, locked-slider
  normalization (locked pinned at stored precision, unlocked share remainder
  proportionally; largest-remainder rounding to 6 dp; actionable errors),
  punt-consistency validation, 13 presets as data definitions with
  provenance keys/versions, `applyPreset()` producing complete editable
  settings without mutating inputs.
- Bug fixed during development: initial rounding pipeline assumed
  pre-normalized inputs; rewritten to scale proportionally then distribute
  residual by largest remainder (deterministic tie-break by key).
- Tests: `packages/domain/src/preferences.test.ts` — 18 tests including a
  200-run fast-check property (totals exact at unit scale, locked values
  preserved, only impossible locked totals may throw).
- Full domain suite: 36 passed. `fast-check` added as devDependency.

## Milestones 2+3 COMPLETE (persistence, migration, APIs)

- Schema: PreferenceProfile / PreferencePlayer / PreferenceTeam /
  CustomPlayerRank (+ PreferenceListType, TeamPreferenceType enums), back-links
  on User/League/Player/NbaTeam. Migration
  `20260824033036_phase3a_preferences` applied to the Phase 2 database AND
  includes three hand-appended PARTIAL unique indexes (single default per
  owner; global-scope rank uniqueness on player and on rank value) because
  Postgres treats NULLs as distinct in composites. Fresh-DB deploy re-verified
  at final gate (`test:all` runs migrate against a clean volume).
- Repos: `lib/server/preference-profiles.ts` (CRUD, resolveSettings from
  preset|explicit|default, transactional list replacement, safe delete with
  createdAt-desc default promotion, internal zod re-validation,
  Postgres-count rate limit ≤30/min/user, redacted audit snapshots) and
  `lib/server/custom-ranks.ts` (dense-permutation PUT replacement, retired/
  unknown player rejection, foreign-league 404, P2002→409 mapping).
- Routes: GET/POST `/api/v1/preference-profiles`, GET/PATCH/DELETE `…/:id`,
  GET/PUT `/api/v1/custom-ranks`; `problems.conflict` added to envelope.
- Tests: `tests/unit/preference-profiles.test.ts` (9) +
  `tests/unit/custom-ranks.test.ts` (5) — 14 DB-backed tests green, including
  raw-write proof that the partial indexes enforce global uniqueness.

## Milestone 4 COMPLETE (/preferences UI + tests)

- `features/preferences/PreferencesWorkspace.tsx` + `app/preferences/page.tsx`
  (server auth gate like dashboard); dashboard header links to it.
- New ui primitives: FactorSliderRow / PresetGallery / RankListEditor with
  Storybook stories (build verified) and 5 RTL tests; workspace covered by 4
  mocked-fetch RTL tests.
- Authenticated Playwright `tests/e2e/preferences.spec.ts` GREEN (~10 s):
  unauth boundary, create, preset apply, slider pin+lock, save/reload
  persistence, player/team preferences, punt selection, custom-rank keyboard
  reorder + persisted order, duplicate/delete/default promotion, axe zero
  serious/critical, dark/light, reduced-motion, 320px no-overflow.
- Defects fixed en route: dragged-slider drift (now pins changed factor w/
  clamping), ambiguous board "Add" buttons (aria-labels + disabled state),
  missing no-store on private GETs (browser heuristic cache served stale
  empty rank lists after reload), wrong spec selector assumptions.
- Docs shipped: ADR 0011, docs/architecture/preferences.md, ERD section,
  docs/design/phase3a-preferences-shape.md + phase3a-preferences-critique-audit.md.

## Milestone 5+6 COMPLETE — final verification & docs (session end)

### Full verification battery (final green state)

1. `pnpm format` → all files Prettier-clean
2. `pnpm lint` → 7/7 packages clean (ESLint + Ruff)
3. `pnpm typecheck` → 7/7 (strict TS; mypy covered inside test:all)
4. Domain tests: **36 passed** (18 preference incl. 200-run property)
5. Web unit suite: **156 passed / 25 files** (incl. 14 DB-backed preference/
   rank service tests, 4 workspace RTL, 5 ui-primitive RTL, 52 focused
   auth/CSP/draft tests from Phase 2 still green)
6. Migration applied forward on the Phase 2 database (`prisma migrate dev`);
   fresh-DB deploy re-verified by the gate's migrate step against a clean
   volume; partial unique indexes confirmed via psql `\di`
7. API integration/security: covered by the DB-backed service tests above
   (ownership/enumeration, constraints, rollback semantics) + Playwright 401
   boundary
8. UI tests: see 4–5
9. Storybook build: success with new Preference Controls stories
10. Playwright full suite (3 projects): **192 total — 169 passed / 22 skipped
    / 0 failed** (with retries=1 absorbing one transient server hiccup under
    4-worker load); axe zero serious/critical on /preferences
11. Next production build: clean (all routes dynamic; new /preferences,
    /api/v1/{preference-profiles,custom-ranks,teams} present)
12. `git diff --check`: clean
13. **`pnpm test:all` → "All quality gates passed."** (twice-consecutive at
    session end)

### Graphify refresh (post-completion)

Incremental `--update --code-only` + `cluster-only`: **5,237 nodes /
11,874 edges / 293 communities**. Verified EXTRACTED relationships:

- `createProfile()` ← route.ts imports; → resolveSettings() calls;
  ← preference-profiles.test.ts imports
- `PreferencesWorkspace()` --calls--> getPreset() (domain presets into UI)
- PATCH route → updateProfile()
  (Ambiguous INFERRED path hops through generic helper names are name-aliasing
  noise; direct EXTRACTED edges above are authoritative.)

### Notes for Phase 3B

- Recommendation integration point: profile settings JSON is validated &
  normalized; Phase 3B should snapshot `{profileId, schemaVersion, settings}`
  onto drafts at start and feed factorWeights/scalars/lists into engine input.
- League-scoped custom ranks already exist for per-league overrides.
- Known pre-existing cosmetic issue: clerk-js CSP console errors on some
  client navigations (no functional impact; sign-in unaffected). Tracked in
  phase3a critique report as accepted exception #1.

## PHASE 3A STATUS: COMPLETE (infrastructure)

Phase 3 main checklist item remains conservatively UNCHECKED in BUILD_SPEC.md
(league/draft overrides wiring, immutable snapshots, recommendation
integration = Phase 3B). Nothing staged/committed/pushed.
