# Phase 3C mock controls — focused Impeccable critique/audit report

Scope: packages/ui MockPersonalityPicker, /drafts/new MOCK branch
(StartDraftFlow), draft-room MockDraftControls + MockStatusStrip +
useMockRunner + mockPacing, Storybook MockControls states. Workflow: shape
(inherited from the accepted Phase 3B shape and PRODUCT.md Operate mode) →
critique → harden → adapt → clarify → audit → polish. Status: ACCEPTED with
three documented exceptions.

## Findings and resolutions

| #   | Pass     | Finding                                                                                       | Resolution                                                                                                                                                                                                                                                                           |
| --- | -------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Shape    | CPU picks must never fight the user's clock or spam screen readers                            | Runner announces ONLY at burst settle points (user turn / complete / conflict / cancel); per-pick text lives in an `aria-live="off"` progress line; the room's existing polite region stays the single announcement channel (injected `announce` callback)                           |
| 2   | Critique | Ownership derived from stale UI state would double-pick or skip turns                         | `useMockRunner` derives turn ownership ONLY from a fresh GET /api/v1/drafts/:id each cycle via the injected `isUserTurn` callback; no cached authority anywhere; 409s trigger an explicit resync read                                                                                |
| 3   | Harden   | Cancel/restart during an in-flight POST could commit orphan picks or wedge the advancing flag | Generation-token ref bumped by cancel/manual-advance/unmount drops stale results before any state write; in-flight flags always clear in `finally`; single-flight ref guarantees at most one outstanding cpu-pick (unit-asserted with fake timers)                                   |
| 4   | Harden   | Retry storms after conflicts would replay distinct outcomes                                   | Deterministic Idempotency-Key `cpu-{draftId}-{nextOverallPick}-{version}` derived from the SAME fresh read that produced If-Match; identical retries replay the recorded outcome per contract                                                                                        |
| 5   | Harden   | Shared Clerk test email across parallel authenticated specs resets users mid-run              | mock-draft.spec owns the distinct fixed identity `draftcourt-e2e-mock+clerk_test@example.com`; clipboard permissions granted on a dedicated context so the seed Copy assertion is strict                                                                                             |
| 6   | Adapt    | Long seeds/team names/progress text overflow at 320 px                                        | Flex-wrap strip, ellipsis + `title` for seed and summaries, tabular numerals on mono seed/key, wrap rules at ≤360 px; Playwright asserts zero horizontal overflow at 320 px on the completed room                                                                                    |
| 7   | Adapt    | Pacing chosen at start must reach the room without re-asking                                  | Speed + auto-advance persist through `mockPacing` helpers under localStorage key `dc.mock.pacing`, SSR-safe reads defaulting to NORMAL/OFF; StartDraftFlow writes on change; the room hook consumes `speedMs` from the same source at integration time                               |
| 8   | Audit    | Keyboard/focus                                                                                | Native radios everywhere (arrow-key roving focus unit-tested); auto-advance is a `role="switch"` button with visible label; every interactive target ≥44×44 CSS px; visible focus ring tokenized; no new global shortcuts (R/B/M/D/U/? namespace untouched)                          |
| 9   | Audit    | axe                                                                                           | Zero serious/critical violations asserted on /drafts/new WITH the mock section expanded (Playwright AxeBuilder gate inside the scenario); fieldset/legend naming for picker, speed group and control cluster verified in RTL                                                         |
| 10  | Audit    | Reduced motion / themes                                                                       | No animation introduced anywhere (switch uses `transition: none` explicitly and asserts `transition-duration: 0s` under emulation); tokens-only colors (`var(--dc-*)`) verified light+dark via colorScheme emulation inline                                                          |
| 11  | Polish   | Honesty about degraded pre-wiring states                                                      | Empty personality catalog renders an explicit "unavailable — league default" sentence instead of hiding the section; empty team list says overrides are unavailable; Follow-default maps to `null` end-to-end so no magic string reaches the create body                             |
| 12  | Polish   | Same seed should mean the same CPU draft                                                      | Seed validated against the published `^[A-Za-z0-9-]{1,64}$` inline (submit blocked, error cleared on edit), sent only when entered, displayed mono/tabular with Copy + polite confirmation; determinism proven by API-driven same-seed twin mocks comparing PLAYER_DRAFTED sequences |

## Accepted exceptions

1. **Storybook control-state mirrors**: packages/ui's tsconfig `rootDir`
   forbids importing app code AND rolldown cannot resolve cross-package CSS
   (verified via an actual `storybook build` failure), so the control-state
   stories render an in-file mirror of MockDraftControls' markup/classes with
   a minimal scoped `<style>` subset of the dc-mock-* rules injected per
   story; picker stories use the real component with the same subset.
   Canonical styles remain solely in apps/web/app/phase3c-mock.css; primary
   may consolidate once index.ts ownership allows exporting web controls.
2. **StartDraftFlow imports the picker via deep relative path**
   (`packages/ui/src/components/MockPersonalityPicker`) because index.ts is
   primary-owned; flagged as required primary follow-up.
3. **Clerk JS CSP console noise** on some client navigations (pre-existing,
   accepted since the Phase 3A report; no functional impact).

## Independent gates run

Focused RTL suites (mock-personality-picker, mock-draft-controls incl.
fake-timer runner driving, start-draft-flow-mock, draft-room additive,
start-draft-flow regression), focused tsc --noEmit + eslint on touched files,
packages/ui vitest suites + tsc. Full Playwright NOT executed here:
cpu-pick endpoint + room wiring land during primary integration — the spec
is written to full assertion strength and must be run unchanged at that gate.
