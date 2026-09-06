# ADR 0015: Deterministic Post-Draft Analysis and Saved History

- Status: accepted
- Date: 2026-09-05
- Phase: 3E1 — Saved history and deterministic analysis (replay/share deferred to 3E2)

## Context

BUILD_SPEC §9.4 and Phase 3 prompt require saved authenticated-user draft history, deterministic versioned post-draft grading, and results UI. The combined checklist item also includes replay and private sharing, which are deferred. Analysis must be reproducible from immutable draft evidence and not use an LLM.

Key questions: immutable input composition, canonical checksum, versioning and idempotency, grade components, baselines, confidence/freshness, generation lifecycle, owner isolation, and UI disclosure.

## Decision

### Analysis input and checksum (D1)

Canonical input is built solely from immutable evidence at `DRAFT_COMPLETED`:

- `Draft.settingsSnapshot` (season, type, horizon, teamCount, rounds, userDraftSlot, scoringRules, rosterSlots, teams)
- Effective `DraftEvent` log after undo resolution (`replayFromEvents` order, `PICK_UNDONE` excluded, keepers included)
- `DraftRosterAssignment` materialized view (authoritative per-team rosters)
- Pinned `Draft.projectionRunId` / `Draft.adpSnapshotId` (or current run if null, with provenance recorded; never silently substitute)
- `Draft.preferenceSnapshot` + `preferenceSnapshotVersion/checksum` (or defaults)
- `Draft.engineVersion`, `Draft.simulationSeed`, `Draft.type`, horizon, analysis formula version `1.0.0`
- Player universe (`Player`, `PlayerEligibility`, `EnginePlayerMeta` with age at `PROJECTION_AS_OF`)
- Active `PlayerNewsSignal`/`ProjectionOverride` at `dataCutoff` (admin-approved only)

Stable serialization via `canonicalize` (sorted keys, `null` for `undefined`, stable array order) → `sha256Hex` (same primitives as `packages/domain/src/recommendation.ts:184-301`). `generatedAt` excluded. Regression-tested.

### Versioning and idempotency (D2)

`DraftAnalysis` is append-only, versioned `1.0.0`. DB-enforced:

- `@@unique([draftId, analysisVersion, inputChecksum])` — same draft+version+checksum returns cached row (like `RecommendationSnapshot`)
- `@@unique([draftId, analysisVersion])` with `analysisVersionInt` for ordering — new version creates new row, never overwrites

`generatedAt` may differ but `inputChecksum` and payload are identical for identical inputs. Failed generations store `status`/`error` metadata but do not block retry.

### Grade methodology (D3 — 5 components, 0–100, letter A-F)

Weights sum 1 via `largest-remainder` at 6dp (parity `preferences.ts:110-128`):

- `valueCaptured` 0.25 — mean `adpValueNorm = 0.5+clamp(adp-overallPick,-24..24)/48` percentile vs pool
- `projectedStrength` 0.30 — POINTS: `Σ seasonFantasyPoints`; CATEGORIES: mean category `winProb` vs `replacementTeamTotals` (median 60 per stat × starters, `scale=max(50,|opp|*0.25)`, `pWin=1/(1+exp(-margin/scale))`)
- `rosterBalance` 0.15 — `1 - 0.5*Gini(posCounts) - 0.2*benchWaste/total`, 0 if illegal picks
- `risk` 0.15 — `mean(safety)` where `safety=1-(0.6*injuryRisk+0.25*width+0.15*(1-roleSecurity))`, banded LOW/MEDIUM/HIGH
- `scoringFit` 0.15 — `puntLeak` + `categoryEmphasis` MAX, points leagues 1.0

Overall `draftScore = round(100*clamp(Σ w*norm, 0,1),1)`, letter `A≥90, B≥80, C≥70, D≥60, F<60`. All contributions clamped 0–100, NaN/Inf/-probability guarded via `clamp01`, `Number.isFinite`, `winsorize`, `standardDeviation` floors. Points vs categories use same weights but different strength source; cross-format comparison labeled invalid. Redraft neutralizes age; dynasty uses youth bias.

Simulated standing: `2000` seeded runs (offline eval count per BUILD_SPEC 11:6, vs 250 live) using FNV1a32(`simulationSeed:analysisVersion:projectionRunId`) → SHA256 per-pick seed → `mulberry32` softmax over ADP/projection/tendency (temperature 1.2, like `simulateAvailability`). Baseline is `replacementTeamTotals` synthetic league (median starters × 11 opponents), not fabricated full rosters; labeled “vs replacement-built opponent”.

### Confidence and freshness (D4)

- Projection `publishedAt` >7d preseason / >1d in-season → `STALE`
- ADP `capturedAt` >7d (8 weeks pre-season daily else weekly) or `sourcesCount<2` → `LOW`
- Overall `HIGH` only if `projection ≤48h && adp ≤7d && sources≥2 for ≥80% roster && no warnings`; else `MEDIUM`/`LOW`
- `dataFreshness` records `projectionRunId/publishedAt`, `adpSnapshotId/capturedAt`, `generatedAt`, `engineVersion`, `analysisVersion`, `inputChecksum` (truncated display, full in details)
- Disclosure: “This analysis is a projection, not a guarantee” in `role=note` near grade — never claim user percentile without real population

### Generation lifecycle (D5)

- Trigger: `GET /api/v1/drafts/:id/analysis` idempotent recovery generation when `COMPLETED` has no current `DraftAnalysis` (preferred over outbox for 3E1; no new `DraftOutbox` kind needed). Also usable via explicit `POST /api/v1/drafts/:id/analysis/recalculate` (rate-limited later).
- Transaction: `prisma.$transaction` with `lockDraft SELECT ... FOR UPDATE` → owner check → status `COMPLETED` else 409 → checksum → `findFirst` cached → if missing, compute deterministically from replayed events + snapshots (no wall-clock) → `create` with `@@unique` guard; `P2002` → re-select winner (single winner, like `custom-ranks.ts:166`).
- Never hold transaction during simulation — compute payload outside transaction, then insert; or compute inside but without long holds (simulation 2000 runs <100ms per bench). No Redis lock for correctness (BUILD_SPEC 14: Postgres transaction is authoritative).
- Historical drafts lacking `projectionRunId`/`preferenceSnapshot` use `isCurrent` with warning and `LOW` confidence; never fabricate.

### History and analysis APIs (D6)

- `GET /api/v1/me/history?cursor=&limit=1..50&type=REAL|MOCK&status=&leagueId=&from=&to=` — Clerk `getCurrentUser`, cursor `skip:1 take limit+1 nextCursor last.id`, stable `orderBy [{updatedAt:desc},{id:asc}]`, owner-scoped `where ownerId=currentUser.id, type!=DEMO, ownerId NOT NULL`, leagueId owner-validated (404 if foreign), date range on `updatedAt`, `type/status` enums, `hasAnalysis` via `include analyses take:1`. Demo/guest excluded. `@@index([ownerId, updatedAt])` covers.
- `GET /api/v1/drafts/:id/analysis` — `requireUserId`, `findFirst {id, ownerId}` → 404 if missing/not-owned (no oracle), status `COMPLETED` else 409 `/problems/draft-not-ready`, cached reuse else idempotent generate, `traceId`, `cached` flag, redacted (no email/Clerk ID/private notes, no raw tokens).

### UI (D7 — history/results, no replay/share)

- `/history` (server `getCurrentUser` guard, `force-dynamic`): filters (type/status/league/date), count live region, `HistoryCard` list (league, status, grade badge, date tabular-nums), cursor pagination, empty/loading/error/skeleton, demo excluded. Reuses `Card`, `Badge`, `ScoreBar`, `DeltaChip` design-system tokens only.
- `/drafts/[id]/results` (owner guard, 404 if foreign): grade hero `A+..F` + 0–100, 5 component `ScoreBar` rows, round-by-round table (`Round|Pick|Player|ValueAboveReplacement|Reach` + best/reach markers, `scope=col`, `caption`, `DeltaChip`), strengths/weaknesses by position/category (chips + bars, color+label never color alone), standing distribution `Sparkline` + `<table>` alt + `P50/P90` text, freshness/assumptions/disclosure `role=note`, `analysisVersion`/`inputChecksum` truncated. All charts have table alt. 320px no overflow (`overflow-x:auto`, `min-width:0`, `flex-wrap`), 200% zoom reflow, dark/light via `ThemeProvider`, `prefers-reduced-motion` disables chart reveal, high-contrast borders, 44px targets, `h1` + `h2` sequence, one `aria-live="polite"` per page, focus visible.

### Excluded from 3E1 (D8)

Replay timeline/UI, private result-sharing tokens, revocation, public/shared pages are 3E2. No share/replay controls in 3E1. Later versions never rewrite historical rows.

## Consequences

- Operators can reproduce any analysis from `{settingsSnapshot, effective events, projectionRunId, adpSnapshotId, preferenceSnapshot, simulationSeed, analysisVersion}` alone.
- New analysis versions create new auditable rows; history can show multiple versions per draft if needed (latest is default).
- Guest demos never appear in history; cross-user enumeration returns uniform 404.
- Synthetic baseline is explicit and reproducible, not a claim of real opponent rosters.

## Verification

- Domain pure `analysis.ts` golden/property (determinism, bounds, NaN, horizon, tie-break), checksum stability, simulation seed coverage
- DB-backed integration (uniqueness/versioning, concurrent generation single-winner, owner isolation, cursor pagination, incomplete/missing-snapshot behavior, fresh+upgrade migration)
- UI unit (history/results states, grade/components, strengths, chart alt, long text, keyboard, theme/motion)
- Playwright authenticated flow (create completed mock → history → results → deterministic reload → cross-user 401 → guest exclusion)
- Benchmarks (generation, cached retrieval, history pages, 16-team)
- Impeccable shape/critique/harden/adapt/clarify/audit/polish + Graphify refresh
