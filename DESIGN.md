# DESIGN.md — DraftCourt

Source of truth: BUILD_SPEC.md section 10 and docs/adr/0003-ui-and-motion.md.
On any conflict, BUILD_SPEC wins. This document records the accepted world.

## The world

Futuristic NBA analytics, minimalist information density. Deep charcoal/ink
surfaces (dark default, equal-quality light), crisp **court-line geometry** as
the signature navigation/selection motif — restrained illuminated lines that
connect current pick → selected player → roster slot → recommendation detail.
Team colors are contextual accents only; they never encode state alone.

## Tokens (packages/ui/src/tokens.css — semantic, light+dark)

- Canvas/surface/elevated/glass layering; `--dc-color-accent` darkened for AA
  contrast in light mode (`#b24a00`), bright arena orange in dark (`#ff8a3d`)
  with dark on-accent text.
- Text: primary/secondary/muted with documented AA-safe muted value.
- Score bands, chart series, focus ring, motion durations/easing.
- Numeric tables and clocks use **tabular numerals**.
- Typography: licensed athletic/editorial variable sans (system fallbacks);
  optional condensed display face only within performance budget.

## Motion rules

Critically damped springs 0.3–0.4s, no overshoot; transform/opacity only on
the critical path; interruptible everywhere; enter/exit share origin/path.
Reduced-motion = short cross-fades/static updates. No celebration animation
during live drafting (a restrained completion moment is allowed after the
final pick). Motion (library) owns interaction; Anime.js only decorative SVG,
outside live-draft paths.

## Components

Astryx primitives behind `@draftcourt/ui` adapters + DraftCourt tokens.
No second component system. Touch targets ≥ 44×44 CSS px. Board information
always has a semantic table/list alternative. Picks and recommendation updates
announce via one polite live region without flooding.

## States every surface must design

loading · empty · populated/dense · long names · stale data · offline ·
error · double-submit guard · version-conflict reconciliation · read-only ·
calculating recommendations. Light/dark, reduced motion/transparency, high
contrast, 200% zoom, 320px verified per surface.
