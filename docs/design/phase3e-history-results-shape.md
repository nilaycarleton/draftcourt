# Phase 3E1 Shape — History & Results (accepted)

Classification: **Operate** mode (PRODUCT.md) — managers review saved drafts and grades; time-critical drafting is not on this surface, but scanability, trust, and failure clarity remain primary.

## Job and audience

- **Signed-in manager (primary):** has 1–50 drafts (REAL/MOCK), wants to find a completed draft, see its grade, understand why, and open the board. Context: post-draft, desktop or mobile, possibly stale data.
- **Guest:** must not see history (401 → sign-in CTA).

## Outcome and proof

- Find a draft in `/history` via filters (type/status/league/date) and cursor pagination, open `/drafts/[id]/results` for its deterministic grade.
- Trust the grade: 0–100 + letter A-F, 5 component bars, round table with `DeltaChip`, strengths/weaknesses, standing `Sparkline`+table, confidence/freshness/assumptions/disclosure.
- Reproducibility: same `analysisVersion 1.0.0` + `inputChecksum` + `simulationSeed` → same `draftScore`/`grade`/`projectedStanding`.

Real evidence: `DraftAnalysis` append-only `@@unique([draftId,analysisVersion,inputChecksum])`, `canonicalize`→`sha256Hex`, `2000`-run synthetic `replacementTeamTotals`, `ownerId` scoping.

## Selected direction

- **Structure:** `/history` server `getCurrentUser` guard + `HistoryWorkspace` (filters `role=group`, `HistoryCard` list `ul[aria-label]`, `Load more` 44px, `skeleton`/`empty`/`error` `role=alert`, no `DEMO`). `/drafts/[id]/results` server `getOrGenerateAnalysisForOwner` + `GradeHero` (large letter `data-grade` → `var(--dc-color-score-*)`, `ScoreBar` 0–100 + disclosure `role=note`) + `GradeBreakdown` 5 `ScoreBar` rows + `RoundValueTable` (`caption`+`scope=col`+`DeltaChip`+`Best/Biggest` glyph+text) + `StrengthWeaknessCards` (`Card` 3px left border) + `StandingDistribution` (`Sparkline` `aria-hidden` + `table` alt + `P50/P90`) + provenance `pre` + `Back to draft room`.
- **Signature:** Court-line accent on `h2` + left border on hero, `55%` arena gradient on hero only, not neon. `ScoreBar`/`DeltaChip` already AA, tabular-nums.
- **Motion:** No animation on results; `prefers-reduced-motion` disables shimmer, `prefers-contrast:more` 2px borders.

## Scope and boundaries

- **Targets:** `apps/web/app/history/page.tsx` (`force-dynamic`), `apps/web/app/drafts/[id]/results/page.tsx`, `features/history/*`, `features/results/*`, `phase3e-results.css`, `packages/ui` 6 components + 2 stories.
- **Untouched:** Replay timeline/UI, share tokens, public share pages (3E2).
- **States:** loading skeleton 3 cards/8 rows, empty first-use CTA `/drafts/new`, populated/dense 16×14, long names ellipsis+title, stale `LOW` banner, degraded `LOW` + warning, error `role=alert`, unauthorized lock `Sign in`, filter-no-results `No drafts match` + Clear, degraded missing `projectionRunId`/`adpSnapshotId`.

## Interaction and layout

- **Hierarchy:** `h1 Draft history` → filters → `h2` empty → list → pagination; `h1 Draft Results` → breadcrumb → `h2 Overall grade` → `h2 Grade breakdown` → `h2 Round-by-round` → `h2 Strengths` → `h2 Projected standing` → `h2 Provenance`.
- **Topology:** Desktop `HistoryWorkspace` filters row `flex-wrap` `gap-3`, cards single column, `ResultsPage` `max-width 72rem` `gap-6` single column; mobile <720px filters stack, <360px `flex 1 1 140px` → column, tables `overflow-x:auto` `min-width:0`.
- **Affordances:** `HistoryCard` entire row `<a>` (not div), `Load more` 44px, `GradeHero` letter `data-grade`, `DeltaChip` signed number, `StandingDistribution` `Sparkline` + table toggle.
- **Feedback:** History `aria-live="polite"` (count/loading/error), results `role=note` disclosure + `role=status` degraded, `focus-visible` ring.

## Constraints

- No `DEMO` in history (`type not DEMO` + `ownerId NOT NULL`), `leagueId` owner-validated 404, cursor stable `updatedAt desc + id asc`, `hasAnalysis` via `include` no N+1, `@@index([ownerId,updatedAt])` covers.
- Analysis `COMPLETED` only 200, else 409, owner 404, anonymous 401, `P2002` single winner, no `SELECT *`, `gradeScore` 0–100 `CHECK`, semver `CHECK`.
- Token-only `--dc-*`, 44px, `h1→h2`, one live region, chart table alt, 320px no page overflow, 200% zoom reflow, dark/light via `ThemeProvider`, no `DEMO` leakage.

## Open decisions

- History `leagueName` is `League ${id.slice(0,8)}` placeholder until `League` join is added (not scored).
- Results `Strengths/weaknesses` string arrays (not per-card quantitative) — quantified cards are 3E1.5.
- No share/replay controls — 3E2.
