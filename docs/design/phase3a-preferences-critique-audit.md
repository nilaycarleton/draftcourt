# Phase 3A — `/preferences` Impeccable critique, harden, adapt, clarify, audit, polish (accepted)

Scope: authenticated `/preferences` workspace (profile rail, editor, preset
gallery, factor sliders with locks, advanced controls, player/team lists,
custom big board) plus the new `@draftcourt/ui` primitives
(`FactorSliderRow`, `PresetGallery`, `RankListEditor`). Classification:
Operate mode (PRODUCT.md); shape accepted at
`docs/design/phase3a-preferences-shape.md`.

## Pass results

- **Critique** — hierarchy issues found & fixed: preset gallery originally sat
  below the fold behind advanced controls → promoted directly under the
  header; strategy preview sentence added so weights read as a sentence.
- **Harden** — fixed: normalization now pins the DRAGGED slider (dragging to
  35% previously drifted to 34.4%) with graceful clamping near saturation
  instead of a thrown error; duplicate board adds disabled at source;
  malformed stored settings fail closed on read without blanking the page.
- **Adapt** — verified at 320 px: layout collapses to single column, no
  horizontal page overflow (Playwright assertion), rank rows wrap; touch
  targets ≥44 px via `.dc-mini-button`/`.dc-lock-button`.
- **Clarify** — copy fixes: explicit scope line ("affect future drafts only"),
  preset application announces editability, delete flow uses armed two-step
  confirmation with default-promotion outcome text.
- **Audit** — Playwright axe run over the populated editor: **zero
  serious/critical violations** (region rule disabled — single-page app shell
  has no landmark regions yet; tracked for the next slice). Keyboard-only
  pass completed: profile switch → rename → preset apply → lock → save.
- **Polish** — tokens only (`--dc-color-accent`, line/muted mixes), tabular
  numerals for percentages/ranks, no nested cards, motion limited to existing
  transitions.

## Independent gates

- RTL unit tests: `packages/ui` PreferenceControls (5),
  `apps/web` preferences-workspace (4).
- Authenticated Playwright `tests/e2e/preferences.spec.ts`: creation, preset
  apply/edit, persistence across reloads, player/team preferences, punts,
  locked-slider behavior, custom-rank keyboard reordering + persisted order,
  duplicate/delete/default promotion, unauthenticated boundary, axe,
  dark/light, reduced-motion, 320 px overflow check. Green on chromium.
- Production build + full-repo gate re-run after UI changes.

## Accepted exceptions

1. Clerk-js CSP console errors on client navigations (pre-existing from the
   nonce'd bootstrap of the Account-portal scripts; sign-in itself works).
   Tracked separately — not a Phase 3A regression, no functional impact here.
2. `role="status"` live region duplicates visible banner text by design
   (screen-reader channel + sighted banner), matching the draft-room pattern.
