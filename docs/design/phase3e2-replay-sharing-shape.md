# Phase 3E2 Shape — Replay, Timeline, Private Sharing

Mode: **Operate** (PRODUCT.md). The user reviews a finished draft or opens a
shared link: scanability, keyboard operation, failure clarity, and privacy
outrank expression. No decorative replay animations, no nested-card clutter.

## Information hierarchy

Owner results page (top → bottom): grade hero → breakdown → round value →
strengths/weaknesses → standing → **replay** → **private sharing** →
provenance. Replay sits after the verdict (the grade) and before sharing:
users verify the story, then share it. Shared page mirrors the order minus
all owner chrome: title → grade → board → rosters → replay → provenance.

## Signature move

Court-line restraint continues: replay state is tabular numerals and
sequence markers (`Event 3 of 9`, `R2P4 · Team 3`), not neon scrubbers. Team
colors never encode state; integrity is text + icon (`✓ OK` / `✕ FAIL`),
never color alone.

## Dense-data behavior

- Timeline renders a ±60 window inside a 24rem scroll region with a
  `Showing X of N` note — never a full multi-hundred DOM.
- Board/rosters at a position reuse the semantic table + list pattern from
  Phase 3E1 (caption, `scope=col`, tabular numerals).
- Long player/team names wrap (`overflow-wrap: anywhere`); tables scroll
  horizontally inside `.dc-table-scroll` while the page never overflows.

## Mobile transformation

Single column; transport cluster wraps; scrub row wraps; panels stack below
720px. All targets ≥ 44px. 320px verified via CSS rules + Playwright.

## Keyboard / focus model

Space toggles play/pause (except on buttons, where native activation wins —
no double-toggle), arrows step, Home/End jump. Typing in inputs is never
hijacked. Focus never moves during playback; after share create/revoke,
focus moves once to the announced status (the one intentional move).

## Loading / empty / error states

Replay: loading → final state → (stepping) or actionable corruption error
with FAIL badge. Share: idle → one-time link w/ copy feedback → revoked.
Public: loading → valid / valid-partial / single 404 (invalid = revoked =
expired = ineligible) / analysis-unavailable / integrity-failure /
rate-limited. Every state has copy; none leaks token validity.

## Reduced motion / contrast / zoom

No animated transitions in replay components (stepping is user-initiated
state change, not motion). 200% zoom reflows; high-contrast doubles key
borders; light/dark via existing tokens only.

## Decisions locked

- Page loads at the FINAL state; reload returns to final (documented in UI
  copy and checkpoint).
- Playback stops at the final event; pressing play there restarts from first.
- Speeds 1× (800ms) / 2× only; timing affects pacing, never derived state.
- Screen-reader announcements on stepping only — never per-tick during play.
