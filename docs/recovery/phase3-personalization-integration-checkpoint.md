# Phase 3B Recovery Checkpoint — Preference Snapshot and Recommendation Integration

**Session start:** 2026-08-24
**Starting commit:** `5aa63a2` ("chore: untrack analytics coverage artifact")
**Dirty tree at start:** 69 uncommitted paths — accepted Phase 2 + complete Phase 3A
work (modified: DraftRoom.tsx, drafts.ts, recommendation engine + tests, schema.prisma,
domain/ui packages, lockfile, BUILD_SPEC.md checklist notes; untracked: preferences
APIs/UI/tests, phase3.css, ADR 0011, preference architecture docs, design reports,
PHASE_3_OPENCODE_PROMPT.md). **Preserved exactly. No reset/stash/commit/push at any point.**

## Scope of this session (Phase 3B only)

Connect Phase 3A preference infrastructure to:

1. Immutable draft preference snapshots (versioned contract + canonical checksum)
2. League-level profile selection and pre-start draft overrides
3. Deterministic engine personalization (bounded, versioned)
4. Recommendation checksum/cache identity including snapshot provenance
5. User-facing strategy evidence in the draft room

Explicitly OUT of scope: CPU personalities, mock/demo drafts, history,
post-draft analysis, replay UI, result sharing, Phase 4.

## Operating model

Max three concurrent subagents; shared working tree; strict per-file ownership.
Subagents may not commit/stage/reset, edit BUILD_SPEC.md or this checkpoint,
edit Prisma schema/migrations, touch manifests/lockfile, refresh Graphify, run
the full gate, spawn agents, or make architectural decisions.

## Primary-agent reading completed

AGENTS.md, BUILD_SPEC.md (§2.2, §4.2, §6, §24–25), PHASE_3_OPENCODE_PROMPT.md,
Phase 3A checkpoint, ADR 0010, ADR 0011, docs/architecture/preferences.md,
docs/recommendation-engine.md, PRODUCT.md, DESIGN.md, apps/web/AGENTS.md
(+ Next.js installed-docs rule acknowledged), plus direct source reads:
`packages/domain/src/recommendation.ts` (all 1367 lines),
`packages/domain/src/preferences.ts`, `packages/domain/src/index.ts`,
`apps/web/lib/server/{recommendations,drafts,preference-profiles,custom-ranks}.ts`,
`packages/db/prisma/schema.prisma`, `DraftRoom.tsx`, start/pick routes.

## Key verified facts (primary-agent confirmed)

- Engine `ENGINE_VERSION = "phase2-deterministic-1.0.0"`; `recommend(input)` is pure;
  `preference` component currently contributes 0 with reason text "personalization
  arrives in Phase 3"; `schedule` component weight 0 "off by default".
- Canonical checksum = SHA-256 over `canonicalize()` (sorted keys; arrays of plain
  objects sorted canonically) of `{adp, draftedAssignments, engineSeed, includeUnsigned,
modelVersion, nextOverallPick, picksUntilUserTurn, players, projectionRunId,
projections, settings}` — preferences NOT yet included.
- Weights: `defaultWeights()` reciprocal-rank over DEFAULT_PRIORITY (11 factors).
- Final score `100 × clamp01(base + 0.10×lookahead)`; ties production→scarcity→adpValue→id.
- Cache: `RecommendationSnapshot` unique `(draftId, sequence, inputChecksum)`;
  early lookup reuses latest snapshot at current sequence when engineVersion matches.
- `transitionStatus(start)` appends DRAFT_STARTED inside the locked transaction —
  this is where snapshot capture must happen atomically.
- Draft carries `settingsSnapshot Json`, `engineVersion`; no preference fields yet.
- League has no profile selection column yet. PreferenceProfile rows exist with
  validated `settingsJson` (schemaVersion 1), preset provenance, single default
  partial index; player/team lists relational with bounded signed magnitudes.
- CustomPlayerRank: global (leagueId NULL) + league scope; league overrides global
  by resolution order (to be implemented in snapshot builder).
- Envelope `{data,error,meta.traceId}`; owner-scoped services return null→404
  (no enumeration oracle); Postgres-count rate limits; redacted audit logs.
- DraftRoom renders top-3 from `/api/v1/drafts/:id/recommendations`; components are
  available on each PoolEntry but only explanation is displayed today.

## Wave 1 — discovery subagents (read-only)

| Agent | Scope                                | Status                             | Outcome                                                                                                                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Recommendation engine investigator   | returned                           | Full input contract + formula table + checksum analysis + test matrix + risks. Key verified findings adopted (see decisions). Flagged `drafts.ts` duplicated ENGINE_VERSION constant as a merge-blocking lockstep risk; flagged canonicalize() array-order docstring/code mismatch (workaround: sort preference arrays engine-side, use record shapes). |
| B     | UX/design investigator               | returned                           | UI state map for league settings picker, drafts/new start flow, draft room evidence; minimal change plan; ownership proposal; Impeccable findings; test plan; risks (optional strategy prop to avoid fixture churn; keep chips inside existing `<li>`).                                                                                                 |
| C     | Security/persistence/QA investigator | FAILED 3× (provider network_error) | Scope absorbed by primary agent directly: read leagues.ts + leagues/[id]/route.ts + drafts routes + phase3a migration SQL + package scripts + DB test patterns personally. Conclusions folded into decisions below.                                                                                                                                     |

Infrastructure note: local Postgres volume persisted (Phase 3A state, 186 users,
all 8 migrations applied via `docker compose up -d postgres redis` + `pnpm db:migrate`).
Fresh-volume path remains covered by the gate's migrate step.

## Primary synthesis gate — ACCEPTED ARCHITECTURE

### Snapshot schema (versioned, self-contained)

`DraftPreferenceSnapshot` v1 (domain contract in
`packages/domain/src/recommendation-snapshot.ts`, zod-validated):

- `snapshotVersion: 1`
- `source: { kind: "USER_DEFAULT" | "LEAGUE_SELECTION" | "DRAFT_OVERRIDE" | "DRAFTCOURT_DEFAULTS", profileId: string|null (non-binding provenance), profileName: string|null (safe label), presetKey: string|null, presetVersion: number|null }`
- `preferenceSchemaVersion: 1` (= PREFERENCE_SCHEMA_VERSION)
- `settings: PreferenceSettings` (complete normalized settings)
- `playerEntries: {playerId, listType, magnitude}[]` (signed values verbatim from storage)
- `teamEntries: {teamId, type, magnitude}[]`
- `customRanks: { global: {playerId, rank}[], league: {playerId, rank}[] }`
- `capturedAt: string` — server-supplied creation time, EXCLUDED from engine math and checksum

Checksum: `checksumInput(canonicalize(snapshot minus capturedAt))` — domain pure helper.
Canonicalization handles unordered collections (sorted object keys; record-shaped maps;
engine sorts preference arrays before hashing).

Engine-facing projection: `toEnginePreferences(snapshot)` → `EnginePreferences`
(optional field on EngineInput): factorWeights, scalars, positionPriorities,
categoryPriorities+puntStats, avoidMode, playerEntries/teamEntries as records keyed by id
(resolved precedence AVOID > DISLIKED > TARGET > FAVORITE), customRanks merged
league-over-global into one record.

### Override precedence

1. Explicit draft override (`Draft.overrideProfileId`)
2. League selection (`League.preferredProfileId`)
3. User default profile (`isDefault`)
4. Versioned DraftCourt defaults (`defaultPreferenceSettings()`, source kind DRAFTCOURT_DEFAULTS)

Resolution happens ONCE inside the authoritative `transitionStatus("start")`
transaction; result stored on the draft row; never recomputed from mutable tables.

### Persistence

League += `preferredProfileId String? @db.Uuid` FK→PreferenceProfile onDelete SetNull
(deletion auto-clears selection; no dangling ids possible). Draft +=
`overrideProfileId String?` (SetNull), `preferenceSnapshot Json?`,
`preferenceSnapshotVersion Int?`, `preferenceSnapshotChecksum String?`,
`preferenceSourceProfileId String?` (SetNull; provenance only — JSON self-contained).
No backfill. DRAFT_STARTED transaction writes event + snapshot atomically under the
existing FOR UPDATE lock; picks/undo/pause/resume/recalculation never touch these columns.
Phase 2 drafts (no snapshot) keep working unchanged.

### Historical compatibility / cache correctness (verified against source)

- Engine input gains exactly one canonical key `preferences` which serializes to
  nothing when absent (`canonicalize` filters undefined) ⇒ Phase 2 inputs reproduce
  Phase 2 checksums byte-for-bit.
- Old ACTIVE drafts: early lookup compares stored row engineVersion === draft.engineVersion;
  both remain "phase2-deterministic-1.0.0"; upsert update branch only touches
  latencyMs/requestedAt ⇒ old payloads stay byte-stable forever.
- LOCKSTEP REQUIREMENT (merge blocker): new-draft stamping must import ENGINE_VERSION
  from @draftcourt/domain instead of the duplicated private constant in drafts.ts, so
  new drafts' rows match new outputs and warm cache hits continue.
- Every post-bump-started draft captures a snapshot (even defaults-only), so its
  checksum differs from any legacy rows; different snapshots ⇒ different checksums ⇒
  distinct cached rows; identical inputs stay idempotent via the unique
  (draftId, sequence, inputChecksum) upsert.

### Engine formulas and bounds (Subagent A design, primary-amended)

Gate pattern: when `preferences` absent, every legacy code path runs VERBATIM
(bit-equality guarantee, not float-identity argument).

| Point             | Formula (prefs present)                                                                                                                        | Bounds / default identity                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| weights           | prefs.factorWeights replace defaultWeights()                                                                                                   | Σ=1±1e-6                                                                   |
| risk              | clamp01(0.5+(raw−0.5)·2r), r=riskTolerance                                                                                                     | [0,1]; r=.5 identity                                                       |
| upside            | clamp01(0.5+(raw−0.5)·2u)                                                                                                                      | [0,1]; u=.5 identity                                                       |
| age               | clamp01(0.5+(raw−0.5)·(1+2y)), y=youthBias∈[−1,1]                                                                                              | y=0 identity; y=−1 inverts (veterans); redraft raw≡.5 stays neutral        |
| role              | clamp01(wSec·sec+(1−wSec)·min(1,mpg/36)), wSec=.4+.6m                                                                                          | m=.5 ⇒ wSec=.7 legacy mix (gate keeps bits)                                |
| position term     | max priority among eligible listed positions else 0                                                                                            | [0,1]; empty list ⇒ inert                                                  |
| category term     | rankNormalize(Σ weight·perGameStat; FG/FT use clamp01((z+4)/8))                                                                                | [0,1]; empty ⇒ inert; league scoring rules untouched; punts never inferred |
| FAVORITE          | +abs(m)                                                                                                                                        | ≤1                                                                         |
| TARGET            | +0.75·abs(m)                                                                                                                                   | ≤0.75                                                                      |
| DISLIKED          | −abs(m)                                                                                                                                        | ≥−1                                                                        |
| AVOID severe      | −max(0.5, abs(m))                                                                                                                              | ∈[−1,−0.5]                                                                 |
| team pref         | ±abs(m) via meta.nbaTeamId                                                                                                                     | [−1,1]                                                                     |
| custom rank       | clamp(((n+1)/2 − rank)/24, −1, 1); n=list size                                                                                                 | monotone ↓ in rank; arithmetic-only (no tanh)                              |
| normalization     | normalized = clamp(total, −1, 1)                                                                                                               | spec §6.5                                                                  |
| HARD CAP          | contribution = clamp(normalized×weight, −0.10, +0.10) applied after multiply before base sum                                                   | ±10 score points max                                                       |
| avoid EXCLUDE     | eligibility filter drop; if eligible pool <3 ⇒ fall back to severe penalties for those players + warning on affected entries                   | never silently empty/actionable output                                     |
| schedule          | component stays zero; honest reason strings ("off by default" / "enabled — no playoff-week data provided to the engine"); no fabricated signal | neutral                                                                    |
| ADP reach warning | top3 entry, positive TARGET/FAVORITE term, adp−nextPick > 24, preferenceContribution > 0.02 ⇒ warnings entry                                   | deterministic strings                                                      |
| PoolEntry         | += optional `warnings?: string[]` omitted when empty                                                                                           | Phase 2 payloads byte-stable                                               |
| version           | ENGINE_VERSION = "phase3-preferences-1.0.0"; old payloads self-describe old version                                                            | historical stability                                                       |

Explanations: preference component gets points-based reason text (not percentile);
labels unchanged (closed enum preserved). contracts.ts scoreComponentSchema gets a
narrow superRefine carve-out allowing `normalized ≥ −1` iff key==="preference";
data/schemas regenerated + contracts:verify run.

### API surface (smallest coherent)

- PATCH /api/v1/leagues/:id meta += `preferredProfileId: uuid|null` (owner-validated;
  foreign id → 404 indistinguishable from missing)
- GET /api/v1/leagues/:id detail += strategySelection view
- GET /api/v1/leagues/:id/strategy-preview[?overrideProfileId=] resolved preview (no persist)
- POST /api/v1/drafts create += optional `overrideProfileId` (owner-validated)
- GET /api/v1/drafts/:id += strategy evidence view (source/name/provenance/schema/engine
  versions/checksum/capturedAt/settings summary; invalid stored JSON → explicit
  degraded status, never a crash)
- start flow unchanged HTTP-wise; capture happens inside transitionStatus("start")

## File ownership map (exactly one writer per file)

Primary: schema.prisma, new migration, packages/domain/src/recommendation-snapshot.ts
(new), preferences.ts (EnginePreferences additions only), index.ts, contracts.ts +
data/schemas regen, lib/server/{preference-snapshot.ts(new), leagues.ts, drafts.ts,
recommendations.ts}, app/api/v1/leagues/** , app/api/v1/drafts/route.ts,
integration tests, benchmarks script, docs/ADRs/checkpoint, final gates.

Subagent A: packages/domain/src/recommendation.ts,
recommendation.test.ts, recommendation-preferences.test.ts (new). NOTHING else.
Shared-export needs reported back to primary.

Subagent B: features/leagues/StrategyProfilePicker.tsx(new),
features/drafts/{StartDraftFlow,StrategyEvidenceCard,PreferenceContributionChips}.tsx(new),
features/preferences/strategyPreview.ts(new) + PreferencesWorkspace.tsx(import tweak only),
app/leagues/[id]/settings/page.tsx, app/drafts/new/page.tsx, app/drafts/[id]/page.tsx,
features/drafts/DraftRoom.tsx, app/phase2.css + app/phase3.css (append-only),
tests/unit/{strategy-profile-picker,start-draft-flow,strategy-evidence-card}.test.tsx(new),
tests/unit/draft-room.test.tsx, tests/e2e/strategy-selection.spec.ts(new).

## Milestone log

(Updated after every integration milestone.)

### M1 COMPLETE — immutable snapshot contract (primary)

`packages/domain/src/recommendation-snapshot.ts`: versioned
`DraftPreferenceSnapshot` (zod `draftPreferenceSnapshotSchema`, fail-closed
re-parse on read), content checksum excluding capturedAt/provenance labels,
canonical array sorting, `toEnginePreferences` projection (severity precedence
AVOID>DISLIKED>TARGET>FAVORITE; league-over-global rank merge).
`EngineInput.preferences?: EnginePreferences` published in recommendation.ts.
Tests: recommendation-snapshot.test.ts (6). Domain suite 42 green.

### M2 COMPLETE — persistence + atomic capture (primary)

Migration `20260824150726_phase3b_preference_snapshots` applied to the REAL
Phase 3A database (upgrade path): leagues.preferredProfileId, drafts.{override
ProfileId, preferenceSnapshot JSONB, snapshotVersion, snapshotChecksum, source
ProfileId}, all FKs ON DELETE SET NULL. Client regenerated.
`transitionStatus("start")` resolves precedence inside the locked transaction,
captures the snapshot atomically with DRAFT_STARTED (event payload records
snapshotVersion/checksum/source), and heals draft.engineVersion at start.

### M3 (API half) COMPLETE — selection + preview endpoints (primary)

PATCH /api/v1/leagues/[id] meta += preferredProfileId (owner-validated; foreign
id → 404 indistinguishable from missing; null clears). GET league detail +=
strategySelection view. NEW GET /api/v1/leagues/[id]/strategy-preview
(?overrideProfileId=) resolved preview without persisting. POST /api/v1/drafts
create += optional overrideProfileId (owner-validated → 404). Start maps
PreferenceSnapshotValidationError → 422 /problems/invalid-strategy (fail closed
BEFORE DRAFT_STARTED).

### M5 COMPLETE — orchestration + cache identity (primary)

recommendations.ts reads ONLY the stored snapshot via readStoredSnapshot
(fail-closed: malformed payload ⇒ recommendations unavailable, never recomputed
against wrong strategy); projects EnginePreferences into EngineInput. Cache
proof documented in-code: preferences participate in inputChecksum ⇒ different
snapshots can't share rows; early lookup guarded by row engineVersion ===
draft.engineVersion with drafts.ts now importing ENGINE_VERSION from domain
(duplicated constant removed — lockstep guaranteed); legacy phase2 drafts keep
serving stored payloads byte-stably (upsert update branch touches only
latency/requestedAt).

### M4 COMPLETE — engine personalization (Subagent A + primary correction)

Subagent A implemented all accepted formulas behind the prefs-gate in
recommendation.ts (+336 lines): ENGINE_VERSION "phase3-preferences-1.0.0",
weights swap, scalar modulations with neutral short-circuits, position/category/
player/team/rank terms, ±0.10 contribution hard cap, EXCLUDE avoids + <3-pool
fallback warning, honest schedule reason, warnings[] on PoolEntry (omitted when
empty), reach warnings, points-based preference reason text, canonical sorting
of preference arrays before hashing. Handoff verified: no out-of-bounds edits;
focused suite 59 green; tsc clean.
PRIMARY CORRECTION at integration: riskTolerance direction was semantically
inverted — fixed to modulateCentered(safety, 1 − riskTolerance) so low
tolerance (risk-averse presets like low-risk@0.15) amplifies safety spread and
high tolerance attenuates toward neutral; test updated and re-run (59 green).

### Shared-contract note

contracts.ts scoreComponentSchema: structural normalized bound widened to
[-1,1] with per-key superRefine (non-preference keys stay ≥0);
data/schemas regenerated; contracts:verify green (Python side unaffected).

### M6 COMPLETE — UI evidence wave (Subagent B + primary integration fixes)

Subagent B delivered all owned files (handoff verified: no out-of-bounds edits;
43 focused tests green; tsc/eslint clean; its Playwright spec passed). Primary
integration corrections after handoff:

1. Chips nested `<ul><li>` inside recommendation rows → broke the serial
   acceptance selector and list semantics; converted to span/p elements.
2. B's spec reused preferences.spec's fixed Clerk test email → parallel workers
   reset each other's user; gave it a distinct fixed identity.

### Testing COMPLETE

- Domain: 59 tests (incl. golden byte-equality, bounds property, 12-case
  regression matrix) + 6 snapshot tests. tsc clean.
- Web unit/DB-backed: 192 tests incl. NEW preference-snapshot.test.ts
  (9 integration/security cases: precedence chain, foreign-id fall-through,
  fail-closed malformed settings, concurrent-start single capture, immutability
  across pick/undo/pause/resume, edit-after-start vs new-draft, deletion
  survival + SetNull, owner isolation, preview, legacy null-strategy).
- Playwright full suite: 170 passed / 0 failed / 24 skipped (documented
  pixel-snapshot + chromium-only policies); serial authenticated acceptance
  passes ON TOP of the new engine; axe zero serious/critical on new surfaces.
- Production build: clean.

### Environment incident (documented)

Local DB volume had lost player_eligibilities rows (dedup-by-checksum ingest
skips per-player republish; fresh volumes are unaffected). Repaired via
scripts/repair-demo-eligibilities.ts (one-off local tool, deterministic demo
dataset through reconciled identities). Serial gate then passed.

### Benchmarks COMPLETE

docs/benchmarks/preferences-latest.json — 4 scenarios × cold/warm × 7 samples:
defaults cold p95 178 ms / warm 10 ms; balanced 127/11; extreme-valid 158/34;
large-lists 127/7. All within §6.9 budgets (cold <800, warm <300).
recommendations-latest.json refreshed at engine phase3-preferences-1.0.0
(cold p95 166 ms / warm 11 ms, n=21).

### Documentation COMPLETE

ADR 0012; docs/recommendation-engine.md § Personalization;
docs/architecture/preferences.md Phase 3B sections (+security notes);
docs/architecture/erd.md § snapshot columns; design report
docs/design/phase3b-strategy-evidence-critique-audit.md; README "Implemented
so far"; BUILD_SPEC Phase 3 item 1 checked with evidence summary.

## PHASE 3B STATUS: COMPLETE (implementation integrated and verified)

### Final verification battery (sequential, primary agent)

1. `pnpm format` → clean (after Prettier pass over all touched files)
2. `pnpm lint` → 7/7 packages clean (ESLint + Ruff)
3. `pnpm typecheck` → 7/7 strict TypeScript (+ mypy within test:all)
4. Domain tests 65 (59 engine/preferences incl. golden byte-equality +
   fast-check bounds property + 12-case regression matrix; 6 snapshot
   contract tests); tsc clean
5. Migration `20260824150726_phase3b_preference_snapshots` applied to the real
   Phase 3A database; fresh-volume path re-proven by the gate's migrate step
6. API integration/security: preference-snapshot.test.ts (9 DB-backed cases)
   plus existing suites — web unit total 192 passed / 29 files
7. Recommendation orchestration/cache: covered by engine determinism tests,
   integration cache-identity assertions, and benchmarks
8. UI tests: 43 focused RTL (3 new suites + draft-room additive) inside the
   192; Storybook untouched primitives (no new ui-package components)
9. Authenticated Playwright: full suite **170 passed / 0 failed / 24 skipped**
   (documented pixel-snapshot + chromium-only policies); axe zero serious/
   critical on league settings, drafts/new, draft room; serial acceptance gate
   passes on top of the new engine
10. Visual regression: board-storybook snapshot suite green (packages/ui
    untouched by 3B)
11. Benchmarks: docs/benchmarks/{preferences-latest,recommendations-latest}.json
    (all scenarios within §6.9 budgets)
12. Next.js production build: clean
13. `git diff --check`: clean
14. **`pnpm test:all` → "All quality gates passed."**

### Graphify refresh (post-completion)

Incremental update + cluster-only: **6,281 nodes / 13,300 edges / 519
communities**. Verified EXTRACTED relationships:

- `buildSnapshotForStart()` in lib/server/preference-snapshot.ts ← used by
  drafts.ts start transaction; → EngineInput via recommendations.ts
- `readStoredSnapshot()` ← called by `getRecommendationsForOwner()` AND
  `getDraftForOwner()`; → checksumPreferenceSnapshot()/toEnginePreferences()
- `StrategyEvidenceCard()` ← DraftRoom.tsx imports → RecommendationOutput →
  recommend()
- transitionStatus() ↔ recommendation orchestration connected through the
  outbox/recommendations read path
  (checksum→cache identity is a data-flow proven by tests, not a code call edge.)

### Notes for Phase 3C

- CPU personalities should reuse `transitionStatus`/`makePick` exactly as the
  e2e does; actor metadata goes on DraftEvent rows.
- The engine-version heal at start means any pre-3B SETUP drafts started later
  stay cache-coherent automatically.
- repair-demo-eligibilities.ts documents the dedup-vs-eligibility drift class;
  consider folding eligibility refresh into ingest dedup handling if it recurs.
- Nothing staged/committed/pushed. Working tree intentionally carries Phase 2
  - 3A + 3B uncommitted work (103 paths).
