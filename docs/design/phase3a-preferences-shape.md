# Phase 3A Shape — `/preferences` (accepted)

Classification: **Operate** mode (PRODUCT.md) — a focused settings surface, not
a dashboard. The user arrives with one job: tune how future drafts are scored,
apply a preset as a starting point, mark players/teams they love or hate, and
maintain a personal big board.

## Information hierarchy

1. **Profile rail (left / top on mobile):** every profile as a row — name,
   default star, updated time. Primary action "New profile" pinned at top.
2. **Editor (main):**
   - Header: profile name (inline editable), default toggle, duplicate/delete.
   - Preset gallery: 13 cards in a wrap grid; applying fills EDITABLE values
     and records provenance; never an opaque mode.
   - Strategy preview sentence (plain language, derived from weights).
   - Factor sliders: 11 rows ordered by BUILD_SPEC §2.2 priority; each shows
     %, supports lock. Locked = exact; others renormalize live.
   - Advanced (progressive `<details>`): scalar controls (risk/upside/youth/
     role), schedule + playoff weeks, position priorities, category emphasis +
     explicit punts, avoid-mode radio (Exclude | Severe penalty).
   - Players & teams lists: search-to-add via existing endpoints; four player
     lists (favorite/disliked/target/avoid) + two team lists; magnitude set on
     add with sensible defaults, adjustable after.
   - Custom ranks: scope switcher (Global board / per-league), dense ranks
     1..N with accessible move-up/move-down buttons, remove, tier/note editing,
     separate Save (PUT replacement).
3. **Sticky save bar** appears only when dirty: Save / Discard, plus a polite
   live-region announcement of the last outcome.

## States

loading (skeleton rows) · empty (no profiles yet → guided create) · populated ·
saving (buttons disabled + spinner text) · saved/success announcement · error
(banner with retry) · conflict (409 → "reload to continue" banner) ·
unauthorized (server-rendered lock copy like dashboard) · long names (ellipsis
with title tooltips; rank rows wrap) · unsaved-changes guard (two-step inline
panel on profile switch/discard — no blocking browser dialogs).

## Signature & motion

Court-line accent: selected profile row and section headings carry the
existing `dc-*` accent underline motif; no neon. Motion limited to opacity/
transform fades ≤300 ms via existing tokens; fully interruptible; reduced-motion
collapses to instant states.

## A11y contract

Every slider is a native range input with programmatic label + `%` value text;
lock buttons use `aria-pressed`; preset apply announces by name; rank reorder
buttons announce resulting position; all interactive targets ≥44×44 CSS px;
320 px must not overflow; keyboard-only completable end-to-end (rail uses
roving tab order = plain DOM order).

## Honest scope line

Saved preferences affect FUTURE drafts only — the page states this explicitly;
active-draft snapshots arrive in Phase 3B.
