# Phase 3E2 Critique / Harden / Adapt / Clarify / Audit / Polish — Accepted Report

Scope: `ReplayTransport`, `ReplayTimeline` (`@draftcourt/ui`), `ReplaySection`,
`SharedReplay`, `ShareControls`, `/share/[token]`, results-page integration,
`phase3e-results.css` additions. Mode: Operate.

## Critique findings (all resolved)

1. **Space double-toggle on focused buttons** (critical). Global Space handler
   - native button activation fired twice. Fixed: handler ignores Space from
     `BUTTON` targets; arrows/Home/End stay global. Covered by unit test.
2. **Scrub row overflow at 320px.** Label + slider + count squeezed. Fixed:
   `flex-wrap` on `.dc-replay-scrub-row`.
3. **Timeline `playerId` in owner API flagged as leak.** Reviewed: owner
   timeline needs domain player ids (owners already receive them in every
   roster/pool response); internal _event/causation_ ids stay server-side
   (boolean link only). Test asserts every UUID equals a known player id.
4. **Shared `dataFreshness`/round rows carried internal UUIDs.** Fixed with
   `redactFreshness` (status/dates only) and `redactRoundRows` (display names
   - numbers, no `playerId`).
5. **`causationEventId: "linked"` string hack.** Replaced with explicit
   `causationLinked: boolean` + `undoneAtSequence` for redacted replay.
6. **O(n²) per-index replay in timeline descriptions.** Replaced with a single
   sequential cursor sweep (`overallPickByIndex`).

## Harden findings (resolved)

- Empty drafts: transport disabled with `No events` text; sections render
  hints, not blank space.
- Corrupt histories: FAIL badge + actionable error; final results (authoritative)
  stay visible above.
- Copy-to-clipboard failure: manual-select fallback message.
- Reload: documented final-state behavior in UI copy.
- Alternate histories reusing pick numbers: shared replay matches the LAST
  entry ≤ cutoff (tested with undo + replacement).
- Rate-limited public page renders its own state (not 404).

## Adapt findings (resolved)

- Panels stack < 720px; transport/scrub wrap; tables scroll internally; page
  has no horizontal overflow at 320px (CSS rules + Playwright checks).
- Touch: all controls ≥ 44px; timeline rows are full-width buttons.

## Clarify findings (resolved)

- Copy uses "private read-only link", "shown once", "expires 90 days",
  "previous link no longer works" — no "share publicly" language anywhere
  (nothing here is public/discoverable).
- Revoked/expired/invalid share states share one 404 — no validity oracle,
  documented in the runbook.

## Audit (deterministic checks)

- axe: 0 serious/critical on results + share routes (Playwright gate).
- Keyboard-only path: First/Prev/Play/Next/Last/speed/scrub/timeline rows all
  reachable; shortcuts verified in unit + E2E tests.
- Headings: `h1` → `h2` sections → `h3` replay sub-panels on both pages.
- Live regions: one concise `aria-live=polite` (stepping only) + `role=status`
  integrity badge per replay; copy feedback announced.
- Contrast: text badges (OK/FAIL with icons), never color-only; focus ring via
  `--dc-color-focus-ring`.

## Polish

- Presentational replay primitives moved into `@draftcourt/ui`
  (`ReplayTransport`, `ReplayTimeline`) with Storybook stories (final,
  mid-draft, playing-2x, empty, long-name timeline) — same split as the
  mock/personality controls. Feature wrappers keep feature-level names.
- No new component system, no token churn, no decorative animation.

## Unresolved

None. Independent gates (Playwright/axe/visual/Storybook build) run
separately and are recorded in the checkpoint.
