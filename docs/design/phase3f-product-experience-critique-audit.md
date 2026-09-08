# Phase 3F Product Experience Critique + Audit (integrated product)

**Method:** dual-agent (A: design review, isolated · B: detector + static
evidence, isolated) · **Date:** 2026-09-08 · **Mode:** Operate
**Inputs:** 12 inspected baseline PNGs, PRODUCT.md, DESIGN.md, BUILD_SPEC §10,
ADR 0003, prior accepted reports (phase2-board, phase3e2-replay-sharing).
**Questions skipped:** autonomous Phase 3F session — findings flow into the
acceptance matrix and the fixes below, not an interactive loop.

## Design health: 27/40 (Good)

| #         | Heuristic                      | Score     | Key issue                                                                  |
| --------- | ------------------------------ | --------- | -------------------------------------------------------------------------- |
| 1         | Visibility of system status    | 2         | In-room recalculating/empty copy weak under a 5s clock                     |
| 2         | Match real world               | 3         | Demo placeholder truncation (fixed: wider seed input)                      |
| 3         | User control and freedom       | 3         | Undo two-step excellent; demo clipboard-failure path has no retry          |
| 4         | Consistency and standards      | 2         | Room buttons unstyled; pool selection invisible (both fixed)               |
| 5         | Error prevention               | 2         | D double-press arming good; field validation only on submit                |
| 6         | Recognition rather than recall | 2         | Pool cursor had zero CSS (fixed with court-line inset)                     |
| 7         | Flexibility and efficiency     | 3         | Shortcuts correct; no visible legend except `?`                            |
| 8         | Aesthetic and minimalist       | 2         | Players density; replay strip cramped in Storybook (fixed via co-location) |
| 9         | Error recovery                 | 3         | Conflict alert + restore clear; demo legend clipping hid fields (fixed)    |
| 10        | Help and documentation         | 3         | Disclosures strong; home copy stale (fixed)                                |
| **Total** |                                | **27/40** | **Good — address weak areas, solid foundation**                            |

Cognitive load: 3/7 checklist failures at audit time (invisible selection —
fixed; 44px checkboxes — fixed via label hit areas; empty-copy reassurance —
accepted residual, tracked below). Design specificity: authored where it
counts (tokens, board engineering, honest copy); interchangeable on
landing/players/demo shells — accepted for Operate, no redesign in 3F.

## Dispositions (every finding verified against code or render)

### Fixed in Phase 3F (with evidence)

1. **[P0] Demo entry form broken** — legends clipped, placeholders truncated,
   ~20 undefined tokens in `phase3d-demo.css`. Fixed: legends offset,
   seed input `min(100%,320px)`, all undefined `var()` mapped to defined
   tokens (`warning-surface`, `font-size-*`, `text-primary`,
   `color-mix` accent tints, `success/danger-surface`). Verified: repo-wide
   undefined-token scan now reports only benign fallbacks
   (`dc-font-mono → monospace`, `dc-color-line → color-mix`, comments);
   accepted `route-demo-light/dark` baselines show the repaired form.
2. **[P1] Room primary action unstyled + selection invisible** — rec/pool
   buttons now `dc-button-primary`, Undo/Dismiss `dc-button-ghost`;
   `.dc-pool-results li[data-selected]` court-line inset;
   `.dc-status-bar.dc-on-clock` accent inset. No new language — reuse only.
3. **[P1] Undefined `dc-button-secondary`** — referenced by 4 consumers,
   defined nowhere. Defined in `@draftcourt/ui` styles alongside moved
   primary/ghost primitives (Storybook fidelity fix included).
4. **Replay transport chrome missing** — component-owned
   `.dc-replay-*/.dc-timeline-*` rules moved app → `packages/ui`
   `replay-components.css`; accepted `replay-transport-dark` baseline proves
   44px targets, gaps, speed group, scrub row.
5. **Bare `aria-label` on role-less generics** — GradeHero (role img +
   label; confidence/checksum labels removed), HistoryCard grade + markers,
   RoundValueTable markers, StrengthWeakness badge, DraftBoard keeper badge.
   Verified: `Avatar.a11y` + `GradeHero.naming` + `ScoreBar.tone` unit tests
   green (11 tests).
6. **Landmarks/regions** — skip link in root layout (first-Tab-tested on 9
   routes × 3 projects); `demo/[id]` wrapped in `<main>`; scroll regions
   keyboard-focusable (RoundValue, Standing, Replay×2, Share board;
   Player/Compare/Profile already conformed); DraftBoard fallback grid name
   (gutter stays `aria-hidden`, so `aria-colcount = teamCount` is correct).
7. **Forced colors** — system-color block (focus, switch, tabs, board
   states, badges, disabled) + `Avatar forced-color-adjust: none`
   (contrast-computed pair must stay together; fixed the FC axe failure on
   gold-on-remapped-white). `forced-colors.spec.ts` 11/11 incl. the
   outline-override proof.
8. **Grade F band mismatch** — `ScoreBar tone` prop; GradeHero maps letter →
   band (A elite, B strong, C/D solid, F risky); accepted F baseline shows
   the red bar; unit-locked.
9. **Home stale copy** — Phase 3 badge + accurate scope + demo/dashboard
   links (clarify, no redesign).
10. **Tabs story dangling `aria-controls`** (critical axe) — story harness
    now renders matching tabpanels (production DraftRoom already had them).
11. **Checkbox 44px hit areas** — label-row targets (visual 20px box kept).

### Rebutted with evidence (not defects)

- **DemoDual `role="status"`** — the two regions are in mutually exclusive
  branches (early return vs active/completed); only one ever renders.
- **DraftBoard `aria-colcount`** — gutter + round cells are `aria-hidden`,
  so the semantic columns are exactly the team columns; `teamCount` correct.
- **Detector `side-tab` ×8** — the court-line accent pattern itself
  (3px semantic borders); accepted by design, not slop.
- **Detector `layout-transition` (score-bar `width`)** — token-collapsed to
  1ms under reduced motion; transform-only would complicate the bar scale.
  Accepted with rationale.
- **Bare `aria-label` on button/input/nav/form/article/section-with-name** —
  valid via implicit semantics / landmark naming; only role-less generics
  were changed.
- **CSS hex hits** — all `var(--token, #fallback)` fallbacks that never
  resolve (tokens defined) or test/story fixtures; no new hard-coded UI
  colors added in 3F.
- **Replay-transport PNG glyphs** — headless emoji rendering; stable per
  machine, noted.

### Accepted residuals (tracked, not hidden)

- R1: Authenticated route pixels deferred (Clerk + fixture + timestamp
  instability); components covered via story pixels, behavior via
  credential-gated specs + experience matrix.
- R2: `motion` package is MotionConfig-only (ADR 0017); no springs exist,
  so there is nothing to interrupt-test. Re-adoption trigger documented.
- R3: Empty-state reassurance copy (`No recommendations yet.`) stays terse;
  next-action copy is a clarify pass, not a 3F gate.
- R4: Demo clipboard-failure path has no retry UI (empty `catch`);
  low-severity, tracked for a harden pass.
- R5: HistoryCard date fixture renders per-viewer-timezone (stable except
  UTC+13/14); grade/players timestamps masked in baselines.
- R6: Detector scope `layout,type` run clean (0 findings).

## Audit gates (deterministic)

- axe: zero serious/critical on all 9 public routes × 3 projects, FC mode
  routes, story axe (tabs/sheet/history/grade), pre-existing credential-gated
  suites (re-run in final gates).
- Overflow: 320px + 640×360 clean on matrix routes; board internal scroll
  preserved.
- Keyboard: skip-link first-stop on all matrix routes; sheet Tab-trap;
  tabs arrows/Enter; board cursor; replay keys (pre-existing).
- Themes: light/dark canvas switch asserted per route; contrast unit tests
  9/9 both themes; FC emulation proof.
- Baselines: 19 PNGs (9 existing + 10 new), each generated → visually
  inspected → accepted with rationale in the Phase 3F checkpoint/reports;
  TZ-unstable regions masked; chromium-only per policy.
