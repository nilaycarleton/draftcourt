# ADR 0003: UI libraries and motion responsibilities

- Status: accepted
- Date: 2026-08-20
- Phase: 0 — foundation and contracts

## Context

BUILD_SPEC.md section 10.1 requires Astryx as the accessible primitive
base, pinned and hidden behind a thin `packages/ui` adapter "so beta API
changes do not leak into features"; Motion for interactive animation; and
Anime.js reserved for decorative, non-interactive sequences only (not used
in Phase 0 — no such use case exists yet).

## Decision

### Astryx package identity (a real risk worth documenting)

The bare npm package name **`astryx`** is _not_ Meta's design system — it
is an unrelated, unaffiliated glob-utility library (last published
`0.0.1-alpha.0`, matching neither the description nor the "beta,
150+ components" README on `github.com/facebook/astryx`). The real,
matching package is the scoped **`@astryxdesign/core`** (npm, currently
`0.4.5`, genuinely beta per its own README), plus the peer package
**`@astryxdesign/theme-neutral`** (`0.4.5`, the base theme — a `<Theme>`
provider is required for Astryx components to render with real tokens at
all, not optional) and peer dependency **`@stylexjs/stylex`** (`0.19.0`).
Astryx ships prebuilt CSS (`astryx.css`, `reset.css`) and a small JS runtime
package for the StyleX-authored components — consumers do **not** need a
StyleX Babel/SWC build plugin, matching its own "no build plugin" claim.
Verified directly against the published npm manifests and the package's own
`dist/*.d.ts` before depending on it, rather than trusting the README's
framing at face value.

### Adapter layer (`packages/ui`)

- `src/components/{Button,Card,Badge}.tsx` wrap the matching Astryx
  component behind a smaller, stable prop surface (e.g. our `Button` takes
  `onClick`/`disabled`/`children`; Astryx's own `Button` requires a
  separate `label` accessible-name prop, uses `isDisabled`, and offers both
  sync `onClick` and async `clickAction`). Feature code imports only from
  `@draftcourt/ui`, never `@astryxdesign/core` directly.
- `src/ThemeProvider.tsx` wraps Astryx's own `<Theme theme={neutralTheme}>`
  (which owns applying `data-theme`/`color-scheme` to `<html>`) with
  DraftCourt's persisted light/dark/system preference, read via
  `useSyncExternalStore` against `localStorage` — not an
  effect-plus-`setState` on mount, which both double-renders and is exactly
  the case `eslint-plugin-react-hooks`'s `set-state-in-effect` rule (new in
  v7, shipped with the React Compiler-era plugin) flags. A server snapshot
  of `"dark"` matches the SSR default set on `<html>` in the root layout,
  avoiding a hydration mismatch.
- **Deferred, not silently skipped**: mapping DraftCourt's full color/type/
  motion palette into Astryx's own `defineTheme()` token schema (a
  `defineTheme({ tokens: {...} })` call, distinct from our own CSS-variable
  tokens below) is out of Phase 0 scope. Phase 0 guarantees Astryx
  components render correctly and DraftCourt's own token layer covers all
  DraftCourt-authored surfaces; deeper Astryx token mapping is Phase 1+
  once the beta theme API has had more time to stabilize.

### DraftCourt design tokens (`packages/ui/src/tokens.css`)

Plain CSS custom properties, independent of Astryx's own token system,
covering every category BUILD_SPEC.md section 10.2 lists: canvas/surface/
elevated/glass, text primary/secondary/muted, focus, success/warning/
danger, four draft-score bands, six color-blind-safe chart series, spacing,
radius, shadow/blur, type scale, and motion durations/easing. Keyed off the
same `[data-theme]` attribute Astryx's `<Theme>` sets on `<html>` — one
source of truth for light/dark, not two competing ones. Accessibility hooks
are real media queries, not stubs: `prefers-reduced-transparency` collapses
glass surfaces to opaque, `prefers-contrast: more` swaps in the stronger
border token, `prefers-reduced-motion: reduce` collapses all motion
durations to 1ms.

### Motion

`motion` (npm package `motion`, the current name for what was
Framer Motion) `13.1.1` is the only animation dependency added in Phase 0.
No Anime.js dependency is added yet — BUILD_SPEC.md restricts it to
decorative, non-interactive sequences outside the live-draft critical path,
and no such surface exists until Phase 2+ (post-draft charts). Adding it
now would be exactly the "add Anime.js without an approved decorative use"
the task rules prohibit.

## Consequences

- Component-development environment: Storybook 10.5.10 (`@storybook/
react-vite`), with `@storybook/addon-a11y` wired for accessibility
  checks in the same environment used for visual review. Four stories ship
  covering Button (all variants + loading/disabled), Card, Badge, and a
  live light/dark/system token showcase (`Tokens.stories.tsx`) — `pnpm
--filter @draftcourt/ui build-storybook` verified as part of Phase 0.
- Astryx's own `React` peer requirement (`>=19.0.0`) sets the floor for
  `apps/web`'s React version (19.2.8).
