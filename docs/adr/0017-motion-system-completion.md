# ADR 0017: Motion system completion (token-driven CSS + MotionConfig)

- Status: accepted
- Date: 2026-09-08
- Phase: 3F — experience hardening and acceptance preparation

## Context

BUILD_SPEC §10.3 and ADR 0003 name Motion as the default React interaction
library (board movement, layout transitions, sheets, press feedback,
interruptible springs) with Anime.js reserved for decorative sequences. The
`motion@13.1.1` package is pinned, but the shipped product animates only via
token-driven CSS transitions (score-bar width, hover backgrounds, skeleton
shimmer, switch track) — zero `motion` imports. Phase 3F must reconcile this
without an unnecessary redesign or critical-path risk.

Evidence (deterministic): repo-wide import scan finds no `motion` usage;
`detect.mjs` reports exactly one layout-property animation (score-bar
`width`, token-collapsed under reduced motion); the app-CSS transition audit
finds zero declarations that are both ungated and uncovered (every raw
duration has an explicit `prefers-reduced-motion` override; every token
duration collapses via `--dc-motion-duration-*`).

## Decision

1. **Motion tokens are canonical** (`packages/ui/src/tokens.css`):
   `fast 120ms / default 320ms / slow 480ms`, standard easing, spring
   response/damping constants; `prefers-reduced-motion` collapses all three
   to 1ms; `prefers-reduced-transparency` collapses glass blur; skeleton
   shimmer is killed under reduced motion in both stylesheets that define it.
2. **Motion stays a MotionConfig-only integration**: `<MotionConfig
reducedMotion="user">` wraps the app in `providers.tsx`, so any current
   or future Motion-driven animation honors the user preference
   automatically. No springs ship in Phase 3 — there is nothing that needs
   interrupt-testing, and the board deliberately scrolls instantly
   (`scrollTop` assignment) to avoid reflow storms in virtualized rows.
3. **No decorative constant motion**: the skeleton shimmer is the only
   infinite animation and exists solely as a loading affordance with an
   RM kill-switch. No autoplay, no scroll hijacking, no celebration
   animation during live drafting (a restrained completion moment remains
   allowed but unbuilt — not required).
4. **Contracts are tested behaviorally**: token-collapse unit/e2e checks,
   computed transition-duration assertions, focus stability through animated
   state changes (existing room/replay specs), and the curated visual
   baselines (which pin the at-rest states animations resolve to).

## Re-adoption trigger

Adopt Motion springs only when a surface genuinely needs interruptible
physics (e.g. draggable sheets, spring board-card movement): add the usage
behind `MotionConfig`, extend the reduced-motion e2e to interrupt it, and
record the surface here. Do not adopt Motion for transitions tokens already
express.

## Consequences

- BUILD_SPEC §10.3's spring language is satisfied by tokens + integration
  point rather than by shipped springs; this ADR is the documented
  reconciliation Phase 3F requires.
- `detect.mjs` `side-tab`/`layout-transition` warnings on motion-adjacent
  rules are accepted with the rationale above, not suppressed.
- Bundle impact: Motion ships as a dependency but contributes no runtime
  animation code paths beyond MotionConfig context.
