# Phase 3F Product Experience Shape — Experience Hardening (not a redesign)

**Status:** accepted · **Date:** 2026-09-08 · **Mode:** Operate (all surfaces)
**Context:** Impeccable `context` (PRODUCT.md / DESIGN.md loaded) → `shape` →
implementation → `critique` (dual-agent A+B) → `audit`/`harden`/`adapt` fixes →
this brief + `phase3f-product-experience-critique-audit.md`.

## 1. Job and audience

Harden the integrated Phase 0–3E2 product so every major route/state meets the
BUILD_SPEC §10/§16 bar (motion tokens, equal light/dark, mobile + 200% zoom,
keyboard + screen-reader operation, zero serious/critical axe findings, curated
visual regression) **without a visual redesign**: the court-line design language
(charcoal/ink surfaces, restrained arena-light accents, tabular numerals, team
colors as contextual accents only) is preserved. Audience: guest evaluators,
signed-in managers mid-draft (5-second pick clock), admins, and portfolio
reviewers reading the acceptance matrix.

## 2. Outcome and proof

- Same-seed twin drafts produce identical event sequences (M1, proven 10+10).
- No route has unresolved mobile overflow, axe serious/critical findings, or
  unreviewed visual baselines (M2/M5/M6/M7).
- Motion communicates hierarchy/state only; reduced-motion removes
  nonessential animation; replay stays user-controlled (M3).
- Benchmarks + portfolio docs make only evidence-backed claims (M9/M10).

Proof: Playwright matrix (all projects), axe gates, 19 inspected PNG baselines,
token/contrast unit tests, consolidated benchmark JSON, acceptance matrix.

## 3. Selected direction

**Refinement preserves.** No new visual world, no new component system, no new
motion library usage. Work is integrity repair inside the incumbent world:

1. Determinism first (engine + orchestration + driver hardening).
2. Accessibility defects fixed at the shared-component layer (naming, focus,
   scroll regions, landmarks, forced-colors stylesheet, transparency token).
3. Token drift eliminated (undefined `var()` references mapped to defined
   tokens; co-location of button primitives + replay styles into
   `@draftcourt/ui` so Storybook renders components truthfully).
4. Coverage added as bounded behavioral gates + 10 curated pixels
   (chromium-only per repo policy), never a combinatorial explosion.
5. Motion completed as a documented token-driven CSS system (ADR 0017) with
   `MotionConfig reducedMotion="user"` as the integration point; springs
   deferred with a re-adoption trigger.

## 4. Scope and boundaries

- In scope: all 21 routes + not-found/empty/loading/degraded/expired/revoked/
  error states; 12 existing + 10 new stories; forced-colors, reduced-motion,
  reduced-transparency (CSS-verified where Playwright cannot emulate),
  200% zoom, 320px layouts, keyboard + SR contracts.
- Untouched: DraftCourt tokens' values (except additive forced-colors block),
  board virtualization, transaction/concurrency semantics, Phase 4+ features.
- Anti-goals: visual redesign, separate mobile features, decorative motion,
  blind global baseline updates, weakening any assertion.

## 5. States and ranges

Populated / empty / loading / error / expired / revoked / degraded /
not-found; light / dark / system; 320 / 375 / 768 / 1280 / 1440 widths;
200% zoom equivalent; 4–20 team boards; 239-player demo pool; long names.

## 6. Interaction and layout

Desktop: board + top-3 + roster co-visible; mobile: recommendations-first tabs

- bottom sheet; one polite live region per surface; focus preserved across
  picks/undo; Escape closes transient layers with focus restoration; skip link
  targets each route's own `<main>`; scroll regions are keyboard-focusable
  regions; replay is user-driven (First/Prev/Play/Pause/Next/Last, 1×/2×,
  scrub, Space/arrows/Home/End).

## 7. Constraints and open decisions

- Pixel baselines: chromium project only; authenticated route chrome deferred
  (Clerk + fixture + timestamp instability — components covered via story
  pixels, behavior via credential-gated specs).
- `motion` package stays a MotionConfig-only integration (ADR 0017).
- Detector `side-tab` warnings are the accepted court-line pattern, not a
  defect; score-bar `width` transition is token-collapsed under RM.
- Bare `aria-label` on natively-named elements (button/input/nav/form) is
  valid; only role-less generic elements were fixed.
