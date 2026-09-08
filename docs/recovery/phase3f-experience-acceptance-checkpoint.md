# Phase 3F Recovery Checkpoint — Experience Hardening & Acceptance Preparation

**Last updated:** 2026-09-08T00:00:00Z (Gate 0 complete; subagent discovery launching)
**Branch:** `main` — HEAD `3e19027119fee40903daeaa3a8512661575dbf8d` (matches `origin/main`, 0 ahead/behind)
**Remote:** `https://github.com/nilaycarleton/draftcourt.git`
**Phase:** 3F — determinism flake, motion/themes/mobile/a11y/visual-regression, benchmarks, portfolio docs, acceptance matrix
**Owner:** primary agent (this file). No staging/committing/pushing in this session.

## 1. Starting state (verified, not assumed)

- `git branch --show-current` → `main`; `git rev-parse HEAD` and `origin/main` both `3e19027...`; `git rev-list --left-right --count HEAD...origin/main` → `0 0`.
- `git status --porcelain=v1`: only the three protected untracked files (no tracked diff, empty staged diff):
  - `PHASE_3_OPENCODE_PROMPT.md`
  - `apps/web/scripts/repair-demo-eligibilities.ts`
  - `apps/web/tests/e2e/debug-runner.spec.ts`
- Phase 3E2 baseline intact (replay, sharing, migration, security, docs must not regress).
- Graphify local graph pre-refresh: graph queries work (`DraftBoard`, `ThemeProvider`, `motion` nodes verified against source).

## 2. Gate 0 discovery summary (source-verified)

- Read: `AGENTS.md`, `BUILD_SPEC.md` (full, incl. §24 checklist), `README.md`, ADR 0003, recovery checkpoint `phase3e2-replay-sharing-checkpoint.md` (contains the twin-flake residual note), `packages/ui/src/tokens.css`, `apps/web/playwright.config.ts`, `apps/web/tests/e2e/mock-draft.spec.ts` (twin assertion at lines 405–455), `packages/domain/src/cpu-selector.ts` (fully), `packages/domain/src/recommendation.ts` (sort/tie-break/availability/lookahead sections), `apps/web/lib/server/recommendations.ts` + `drafts.ts` (event ordering) fully.
- Routes inventoried (21 `page.tsx`): `/`, `/players`, `/players/[slug]`, `/compare`, `/demo`, `/demo/[id]`, `/sign-in`, `/sign-up`, `/dashboard`, `/leagues/new`, `/leagues/[id]/settings`, `/preferences`, `/drafts/new`, `/drafts/[id]`, `/drafts/[id]/results`, `/history`, `/admin/*` (3), `/data-sources`, `/methodology`, `/share/[token]`, plus `not-found.tsx`.
- Playwright: 3 projects (chromium, chromium-mobile Pixel 7, chromium-light); 17 spec files; visual baselines live in `apps/web/tests/e2e/board-storybook.spec.ts-snapshots/` (9 PNGs: board dark, snakeboard completed/empty/16-team-long-names/12-team-mid-draft + reduced-motion variants).
- Storybook stories (12): Button, Card, Badge, Tokens, DraftBoard, MockControls, PreferenceControls, HistoryCard, ReplayTransport, Tabs, Sheet, GradeCard.
- Benchmarks present: 6 JSONs in `docs/benchmarks/` (cpu-mock, demo-drafts, history-analysis, preferences, recommendations, replay-sharing) + 6 `bench-*.ts` scripts. GAP: no 8/10/12/14/16-team consolidated matrix, no `phase3-acceptance-latest.json`.
- Docs present: `docs/architecture/` has only erd.md, preferences.md, replay-and-sharing.md (GAP: no system context/container/component diagrams, no ERD-as-diagram verification, no data-flow diagrams); `docs/recommendation-engine.md`, `docs/data-sources.md` exist; runbooks: failed-publish-rollback, stale-data, share-revocation-cleanup, source-disable (GAP: rollback, DB backup/restore, secret rotation, auth outage, Redis outage, incident response runbooks missing or unverified).
- BUILD_SPEC §24: Phase 3 has 3 unchecked boxes (motion/themes/mobile/a11y/visual-regression; benchmarks+portfolio docs; phase acceptance). Phase 4 untouched.

## 3. M1 determinism diagnosis + fix (primary-agent implementation, 2026-09-08)

Root causes confirmed (product, three layers — no test-only fix would suffice):

- **C1 (primary): per-draft-UUID `engineSeed`.** `getRecommendationsForOwner`
  derived `engineSeed` from `seedFromIds(draftId, runId)` (FNV-1a over the
  random draft UUID). Same-seed twins have different UUIDs, so their seeded
  availability (`simulateAvailability`) and lookahead (`applyLookahead`) RNG
  streams differed by construction, shifting the weighted urgency component
  and flipping near-tie `top3[0]` user picks at snake folds. Violates
  BUILD_SPEC rule 4 / §6.1 (UUID is not a listed reproducibility input).
  FIX: `seedFromStableInputs(simulationSeed, settings, runId)` — MOCK drafts
  seed from the shared simulation seed + run; REAL drafts (no simulation
  seed) hash the canonical settings snapshot + run.
- **C2 (amplifier): unordered DB queries.** No `orderBy` on projections /
  players / eligibilities / assignments / nested ADP `take:400` (rank was
  assigned by return index!) in `recommendations.ts`, `cpu-mock.ts`,
  `demo-drafts.ts`, `analysis.ts`, and the in-transaction assignments read in
  `drafts.ts`. Postgres return order is unspecified and varies under parallel
  load. FIX: explicit `orderBy` everywhere engine inputs are loaded
  (ADP nested: `consensusAdp asc, playerId asc`).
- **C3 (amplifier): engine input-order sensitivity.** `canonicalize` claimed
  but did not sort object arrays (checksum itself was order-dependent);
  `normalizeByRank` had no id tie-break (unlike cpu-selector); lookahead
  top-20 sort had no tie-break; `replacementTeamTotals` sampled
  `candidates.slice(0,60)` in input order; softmax walks ran in Set-insertion
  order with a shared sequential RNG. FIX: all five stabilized in
  `packages/domain/src/recommendation.ts` (cpu-selector was already stable and
  is the reference; it is unchanged).

Before/after proof (2026-09-08, domain package, no infra):

- Old engine (`git show HEAD:...` overlay, restored byte-identical after):
  new `recommendation.order-stability.test.ts` → 3 of 4 FAIL (checksum
  `0eff…` vs `af32…` on reversed inputs; tie-pair sign flips -1 vs 1;
  canonicalize order-dependent).
- Fixed engine: 122/122 domain tests pass (118 existing + 4 new).
- Server twin regression test added (`cpu-mock.test.ts`, two started MOCKs,
  same seed, full 12-pick completion via live top3 + CPU, per-sequence
  first-divergence evidence): 10/10 pass in file.
- Seed-sensitivity probe on a 12-player synthetic board found no flip in 289
  seeds (urgency weight is small; the real 239-player pool at 24-pick depth
  under load is the failing configuration) — scratch file deleted. The
  empirical proof therefore comes from repeated Playwright twin runs below.

Changed production files: `packages/domain/src/recommendation.ts`,
`apps/web/lib/server/{recommendations,cpu-mock,demo-drafts,analysis,drafts}.ts`.
Changed tests: `apps/web/tests/e2e/mock-draft.spec.ts` (sequence-sorted
join + first-divergence evidence; assertion itself unchanged),
`apps/web/tests/unit/cpu-mock.test.ts` (new twin test).
New tests: `packages/domain/src/recommendation.order-stability.test.ts`.
Typecheck: 7/7 clean. Infra: local Postgres+Redis via Compose started,
migrations clean, seed + demo:ingest (239 players) done.

## 4. Active agent/file ownership (non-overlapping)

- **Primary:** synthesis, shared tokens/CSS/layouts, Playwright+CI config, shared exports, production orchestration fixes (`lib/server/recommendations.ts`, `lib/server/cpu-mock.ts` if needed, `packages/domain/src/recommendation.ts` engine stability), README, BUILD_SPEC, integration, full verification, Graphify refresh, final report.
- **Subagent A (visual/motion/a11y):** audit matrix first (read-only); then may own NEW isolated stories/test files only (e.g. `packages/ui/src/stories/*`, `apps/web/tests/e2e/*new*`). No shared files without approval.
- **Subagent B (determinism/perf):** independent reproduction + classification; then may own isolated stress tests + benchmark scripts only (`apps/web/scripts/bench-*.ts` new, `*.test.ts` new/isolated). No shared transaction/orchestration files.
- **Subagent C (portfolio docs):** gap matrix first; then may own NEW isolated docs (`docs/architecture/*new*`, `docs/benchmarks/*`, methodology/data-source/API/security/runbook/model-card updates as new files where possible). No README/BUILD_SPEC edits.
- Protected (never touch): `PHASE_3_OPENCODE_PROMPT.md`, `apps/web/scripts/repair-demo-eligibilities.ts`, `apps/web/tests/e2e/debug-runner.spec.ts`, everything under `sources/`, `.env.local`, `.next/`, `node_modules/`, `graphify-out/`, coverage, reports, secrets.

## 5. Checks run and results

- Git baseline verification: PASS (§1).
- Source reads + Graphify spot-queries: PASS, findings match source.
- M1: domain 122/122 PASS; typecheck 7/7 PASS; migrate/seed/demo:ingest PASS;
  production web build PASS; server twin test in-file PASS.
- M1 reliability: 10/10 serial `mock-draft.spec.ts` (chromium, ~1.4 min
  each); 10/10 parallel 4-file batches (all projects, 12 passed + 6
  documented skips each, 0 failed). Zero sequence/assignment drift, zero
  state leakage, source frozen throughout (see §9).
- M2–M8: experience-matrix 132 passed/3 documented skips (all projects);
  forced-colors 11/11; design-system + visual-routes 10/10 pixels green;
  contrast unit 9/9; ui unit 51/51; A-impl contract tests 4/4 post-fix;
  ScoreBar tone 4/4; full e2e 363 passed/51 skipped/0 failed; web unit
  311 passed/1 skipped; domain 122/122.
- M9: team-matrix 8/10/12/14/16 all thresholds pass; 6 suites re-run;
  acceptance JSON 20/20 gates green.
- M11: disposable-DB bootstrap (migrate 15/15, seed, ingest 1380/0,
  publish 230) + restart persistence + analytics health + install/template
  checks PASS.
- Final: root `pnpm test:all` → **"All quality gates passed"** (format,
  lint, typecheck, migrate, seed, ingest, JS/TS units, pytest, contracts,
  production builds, full Playwright, analytics image).
- `git diff --check`: clean. Secret scan: 0 hits (tight patterns; test-key
  scan clean; benchmark JSONs carry checksums only).
- CI (observed via gh, not run in-session): red at HEAD `3e19027` for
  action-resolution only (setup-uv@v10 + trivy@0.28.0 + dep-review@v4
  refs) — FIXED in worktree (v10.0.1 / 0.36.0 / v4.9.0, all refs verified
  via API, YAML re-validated). In-session CI re-run impossible without
  pushing (forbidden) — release audit must confirm green.

## 6. Visual baselines added or changed

- Existing 9 board PNGs: unchanged, still passing.
- NEW (generated → visually inspected → accepted, chromium-only per policy):
  `tabs-selected-light`, `sheet-open-640`, `replay-transport-dark` (accepted
  twice: initial, then re-accepted after the button-chrome/co-location fix),
  `history-card-light`, `grade-hero-a-light`, `grade-hero-f-light`
  (re-accepted after the letter-band fix), `route-players-light/dark`
  (freshness masked), `route-demo-light/dark`.
- Acceptance rationale per baseline is recorded in the session report;
  rejections: none. TZ-unstable regions masked (grade `<time>`, players
  freshness); history-card date fixture noted stable except UTC+13/14.
- Incidental defect fixed via baselines: Tabs story dangling
  `aria-controls` (critical axe) — story now renders matching tabpanels.

## 7. Current blocker

- None for implementation. Overall Phase 3 acceptance awaits the
  independent release audit (CI re-run on pushed contents + staged review).

## 8. Exact next action

- Release audit (separate session): review staged diff, push, confirm CI
  green (esp. the 3 fixed action pins), then mark the final Phase 3 box.

## 9. M1 reliability proof (2026-09-08, source frozen during runs)

- Fixture: local Docker Postgres + Redis, migrations clean, deterministic
  seed + `demo:ingest` (239 players, ingest inputChecksum `dd8396de…`, date
  2026-09-08, darwin). Production `web` build; Clerk `sk_test_`/`pk_test_`
  credentials present in git-ignored `apps/web/.env.local` (prefixes only
  verified, values never printed).
- Serial: 10 consecutive `mock-draft.spec.ts` (chromium) passes, ~1.4 min
  each, 10 pass / 0 fail. Each run includes the step-18 twin assertion with
  new first-divergence evidence — never triggered (zero event-sequence
  drift, zero assignment drift).
- Parallel/load: 10 consecutive 4-file batches (`mock-draft`,
  `replay-sharing`, `history-results`, `demo-draft`, all Playwright projects,
  shared server/DB/Redis): every batch 12 passed / 6 skipped / 0 failed
  (skips are the documented chromium-only + pixel-baseline policies).
- Zero test-state leakage across all 20 runs (sibling specs green every
  batch). `git status` after runs shows only the M1 file set — source was
  unchanged throughout.
- M1 CLOSED. Blocker: none.

## 10. Implementation lanes (post-M1, non-overlapping ownership)

- Primary (shared/production): a11y shared fixes (GradeHero role, Avatar
  aria-hidden, DraftBoard label/colcount, scroll-region keyboard access,
  demo single live region, save-bar transparency var, skip link,
  forced-colors CSS, MotionConfig + ADR 0017), token/contrast unit test,
  experience-matrix + forced-colors e2e specs, visual baselines
  (generate→inspect→accept), Impeccable shape/critique docs, consolidated
  benchmarks (`bench-team-matrix.ts` + `phase3-acceptance-latest.json`),
  README/BUILD_SPEC updates, bootstrap verification, acceptance matrix,
  full gates, Graphify refresh, final report.
- Subagent A-impl: NEW `packages/ui/src/stories/*.stories.tsx` (10 missing:
  Avatar, ScoreBar, DeltaChip, GradeHero, GradeBreakdown,
  StandingDistribution, RoundValueTable, StrengthWeaknessCards,
  MockPersonalityPicker, Sparkline) + NEW component unit tests
  (Avatar-decorative, GradeHero-naming) against the contracts in §11. No
  shared-file edits. No e2e specs (primary writes those after shared fixes).
- Subagent C-docs: NEW docs only per its proposed structure
  (`docs/architecture/01–06`, `docs/api/01–03`, `docs/methodology/01–03`,
  `docs/security/01-threat-model`, `docs/operations/01–05`,
  `docs/benchmarks/METHODOLOGY`, `docs/limitations`). No README/BUILD_SPEC/
  existing-doc edits. Evidence-flagged claims stay out until primary
  supplies benchmark outputs.
- Subagent B: stood down after audit (stress design delivered; primary owns
  shared fixes; benchmark scripts primary-owned in M9).

## 11. Shared-fix contracts (primary implements; A-impl tests target these)

1. Avatar `decorative` → `aria-hidden="true"` on the initials node (keeping
   `role="presentation"`), no accessible name.
2. GradeHero grade container → `role="img"` preserving its accessible name
   (contains grade letter); confidence text exposed via the same name or
   `aria-describedby` (no bare `aria-label` on role-less elements).
3. DraftBoard grid → fallback accessible name when `labelId` is unset;
   `aria-colcount` counts the gutter column too.
4. Scroll containers (`.dc-round-value-scroll`, `.dc-data-table-scroll`,
   `.dc-table-scroll` replay panels, sparkline wrapper) → keyboard-focusable
   region pattern (`tabindex=0 role=region` + label), mirroring CompareTable.
5. DemoDraftControls → exactly one `role="status"` polite region.
6. `.dc-save-bar` → `backdrop-filter: blur(var(--dc-blur-glass))` so
   reduced-transparency collapses it (token already collapses to 0px).
7. Root layout → skip-to-content link targeting the main landmark.
8. Forced-colors stylesheet block → focus rings, switch knob, selected-tab
   indicator, and state badges remain perceivable under
   `forced-colors: active` (system colors only, no `forced-color-adjust:none`
   on meaningful content).
9. Providers → `<MotionConfig reducedMotion="user">` (motion package already
   pinned); ADR 0017 records the token-driven CSS motion system + deferral
   rationale with re-adoption trigger.
