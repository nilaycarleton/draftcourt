# Phase 3B strategy surfaces — focused Impeccable critique/audit report

Scope: league-settings StrategyProfilePicker, /drafts/new StartDraftFlow,
draft-room StrategyEvidenceCard + PreferenceContributionChips, extracted
strategyPreview helper. Workflow: shape (inherited from the Phase 2 accepted
shape and PRODUCT.md Operate mode) → critique → harden → adapt → clarify →
audit → polish. Status: ACCEPTED with two documented exceptions.

## Findings and resolutions

| #   | Pass     | Finding                                                                                                        | Resolution                                                                                                                                                                                                                        |
| --- | -------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Shape    | Strategy evidence must never compete with the pick clock                                                       | Card renders below status bar/banner, muted tokens, single line on mobile; recommendations remain the primary action surface                                                                                                      |
| 2   | Critique | Three badge types could compete (provenance / reach warning / labels)                                          | Order established: actionable warnings first (chips + announce), provenance context second, engine metadata drawer-only except tiny version text                                                                                  |
| 3   | Harden   | Nested `<ul>/<li>` inside recommendation rows broke descendant-list selectors and screen-reader list semantics | Chips/warnings converted to span/p elements (integration fix by primary)                                                                                                                                                          |
| 4   | Harden   | Shared fixed Clerk test email across parallel authenticated specs caused mutual user resets                    | strategy-selection.spec now owns a distinct fixed identity                                                                                                                                                                        |
| 5   | Harden   | Mid-draft `/preferences` link could imply live editing                                                         | Link lives only inside the Details sheet labelled "Edit for future drafts", next to the sentence "This draft's strategy cannot be edited." No mutation controls exist anywhere in the strip (unit-asserted)                       |
| 6   | Adapt    | 320 px overflow / multi-row wrap risk                                                                          | Flex-wrap chips, ellipsis+title names; Playwright asserts no horizontal overflow at 320 px on settings + room                                                                                                                     |
| 7   | Audit    | Keyboard/focus                                                                                                 | Sheet focus trap + restore to invoker (same pattern as roster sheet); all controls tab-reachable; no new global shortcuts (R/B/M/D/U/? namespace untouched); warnings announced once per player via the shared polite live region |
| 8   | Audit    | axe                                                                                                            | Zero serious/critical violations on league settings, drafts/new, draft room (Playwright AxeBuilder gates)                                                                                                                         |
| 9   | Audit    | Reduced motion / themes                                                                                        | No new animation introduced; token-only colors verified in light+dark via colorScheme emulation                                                                                                                                   |
| 10  | Polish   | Tabular numerals for weights/points/checksums                                                                  | dc-factor-value/dc-contrib-chip use font-variant-numeric: tabular-nums                                                                                                                                                            |

## Accepted exceptions

1. Clerk JS CSP console noise on some client navigations (pre-existing,
   accepted in the Phase 3A report; no functional impact).
2. Chip pill min-height 32 px (<44 px): chips are non-interactive status
   labels, not touch targets; adjacent Draft buttons meet the 44 px target.

## Independent gates run

RTL unit suites (43 tests), full web vitest suite (192), full Playwright
(170 passed / 0 failed / 24 skipped by documented policy), production build,
axe, 320 px, 200 % zoom, reduced-motion, dark/light assertions inside the
authenticated specs.
