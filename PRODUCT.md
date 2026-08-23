# PRODUCT.md — DraftCourt

## What this is

DraftCourt is a **product analytics dashboard/tool**: an NBA fantasy live-draft
assistant. During a live snake draft it answers one question — _who are my best
three choices right now?_ — with deterministic, explainable 0–100 scores.

Impeccable classification: **Operate** mode on every Phase 2 surface. The user
is completing a time-critical task (drafting in seconds). Scanability, density,
speed, keyboard operation, and failure-state clarity outrank expression. Brand
lives in precise details (court-line geometry, tabular numerals, restrained
arena-light accents), never in decoration that competes with the pick clock.

## Who uses it

- **Signed-in manager (primary):** creates leagues via the wizard, conducts
  real drafts, needs recommendations, rosters, and the board at a glance.
- **Guest (later phase):** browses players and runs disposable demo mocks.

Phase 2 surfaces: `/leagues/new` (multi-step wizard), `/leagues/[id]/settings`
(editor/clone), `/drafts/new` (choose league + start), `/drafts/[id]` (live room).

## Success criteria

1. A pick can be made in under 5 seconds from any state (search → draft).
2. Every recommendation score decomposes into visible, honest components.
3. Reload/replay never loses or corrupts draft state; conflicts self-explain.
4. WCAG 2.2 AA on all core routes; keyboard-only drafting is fully possible.

## Non-goals (this phase)

Marketing surfaces, CPU mock personalities, post-draft grades/sharing,
premium AI. No celebration animations during live drafting.
