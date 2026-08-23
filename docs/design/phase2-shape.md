# Impeccable Shape — League Setup & Live Draft Journey

Accepted design rationale for Phase 2 surfaces (`/leagues/new`,
`/leagues/[id]/settings`, `/drafts/new`, `/drafts/[id]`). Mode: **Operate**.

## Information hierarchy & the primary drafting action

1. **Draft status bar** (always visible): league name, round/pick, picks
   until my turn, save/connection state, pause, undo.
2. **Primary action**: draft the selected player — one high-contrast button,
   guarded against double submission, reachable one-thumb on mobile.
3. Recommendations (top 3) > my roster > board > pool search.
   The court-line motif links the current pick cell to the selected player
   card and to the roster slot it would fill — selection never floats
   unanchored.

## Wizard (/leagues/new)

Steps: Basics → Scoring → Roster → Teams → Review. Progress rail uses court
lines; each step validates inline before advancing; state persists to
localStorage (save-and-resume); Review shows expanded rules in plain language
(points vs categories vs percentages vs lower-is-better vs punts) before POST.
Presets (Points / 8-cat / 9-cat) expand into editable custom rules; punts are
explicit zero-weight toggles with a visible "punt" tag.

## Live room (/drafts/[id]) — desktop

- 60% virtualized snake board (all teams × rounds), drafted cards dimmed with
  "Drafted #N by Team"; sticky current-pick column marker.
- Right 40%: sticky top-3 recommendation cards + always-visible user roster.
- Bottom tab: searchable/filterable full pool; opponent rosters via team header.

## Mobile transformation

Sticky pick/status bar → recommendations-first → explicit tabs
(Board / Players / Roster). Detail sheet is an interruptible bottom sheet;
draft action stays within thumb reach; 320px has no page-level overflow.

## Keyboard & focus

`/` search · arrows navigate results · Enter open · `D` draft (after visible
confirm affordance) · `U` undo confirm · `R` recommendations · `B` board ·
`M` my roster · `?` shortcuts · Escape closes transient layer and restores
focus. Focus returns to the invoking control after pick/undo/sheet close/
conflict reconciliation. No shortcuts fire while typing in inputs.

## States

Loading skeletons (board cells, rec cards) · empty league/draft lists ·
dense board with long names (truncate + title, never wrap-clock drift) ·
stale projections banner with freshness · offline/read-only disables mutations
with explanation · error toasts retry in place · double-submit disabled state ·
version-conflict modal restores authoritative state and names what changed ·
calculating shimmer on recommendations while preserving layout.

## Accessibility & reduced conditions

Semantic table alternative for the board · single polite live region announces
meaningful picks/rec updates · all touch targets ≥44px · light/dark equal ·
reduced-motion cross-fades · reduced-transparency opaque layers ·
high-contrast borders · color-blind-safe drafted/available states (icon+text,
never color alone) · 200% zoom reflow verified.
