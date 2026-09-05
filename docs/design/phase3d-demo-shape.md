# Phase 3D Shape — Guest Demo Drafts (`/demo`) — Accepted

Classification: **Operate** mode (PRODUCT.md) — time-critical draft task for unauthenticated guests. Scanability, failure-state clarity, keyboard operation, and isolation honesty outrank expression.

## Job and audience

- **Guest evaluator (primary):** anonymous visitor evaluating DraftCourt without an account. Wants to run a disposable CPU mock in under a minute, see realistic recommendations, and understand the product value before signing up.
- Context: single-session, no pre-existing data, desktop or mobile, possibly slow network or cleared cookies.

## Outcome and proof

- Create a demo from a simplified preset (Standard/Categories/Dynasty) with slot, personality, and optional seed.
- Run a 12-team mock: user picks on their turn, CPU opponents advance deterministically (same seed = same draft), with slow/normal/instant pacing and auto-advance.
- Resume after reload via HttpOnly cookie or copy-paste recovery code; understand 24h expiry; see revoked/invalid states clearly.
- Sign-up CTA is honest: “demo drafts are not transferred” — never promises conversion.

Real evidence: deterministic CPU selector vectors, seeded board, 24h `DemoDraftCapability.expiresAt` TTL, hashed capability tokens.

## Selected direction

- **Structure:** `/demo` entry (preset radios → slot → personality select → seed → Create) and `/demo/[id]` draft room that reuses `DraftRoom` board/recommendation panels but with guest-specific status strip and pacing controls outside the tab panels (same placement as Phase 3C mock controls, so both modes share learned position).
- **Signature:** Court-line accent already in `DraftRoom` — demo adds a single warning-toned temporal notice (“Temporary demo — expires in 24 hours”) with clock icon, synthetic-data provenance line, and a recovery-code callout on creation. No new neon.
- **Motion:** No animation on live path; only cross-fades for banners, interruptible and reduced-motion aware.

## Scope and boundaries

- Fidelity: production-ready authenticated mocks’ parity minus persistence: no leagues/preferences/history/sharing/punts/billing surface.
- Targets: `apps/web/app/demo/page.tsx`, `apps/web/app/demo/[id]/page.tsx`, `features/drafts/DemoDraftFlow.tsx`, `features/drafts/DemoDraftControls.tsx`, `features/drafts/useDemoRunner.ts`, `app/phase3d-demo.css`.
- Untouched: authenticated draft creation, real-league wizard, post-draft analysis, premium AI.

## States and ranges

- **Content:** 3 presets × 12 slots × 8 personalities × 64-char seed; typical 12-team / 14–16 rounds; long team names, long personality descriptions.
- **States:** loading (creating), empty (no token → 404), populated (active board), error (create failed, CPU 401/409), conflict (stale `If-Match`), expired (24h), revoked (explicit abandon), completed, abandoned, offline/slow, rate-limited, keyboard-only, 320 px, 200% zoom, light/dark, reduced motion/transparency, high contrast.

## Interaction and layout

- **Hierarchy:** Notice → fieldsets in creation order → Create. Room: status bar (pick/turn) → strategy card → tab bar → mock/demo control strip → shared live region → board/recommendations/players/roster.
- **Topology:** Desktop: reading order follows creation sequence; controls always visible outside tabs. Mobile: tabs explicit (Recommendations first), control strip stays above tabs, speed radios wrap vertically ≤600 px, recovery code wraps at ≤360 px.
- **Affordances:** Radios for preset, number input for slot, select for personality, text input for seed with live format error, primary Create/Continue, secondary Copy, ghost Cancel/Pause.
- **Feedback:** Creation polite region (“Creating…”) + alert on failure; control strip polite status + alert on error; recovery code polite callout with copy confirmation; runner announces only burst settle points via injected `announce`.

## Constraints

- Must not leak capability token in URL, logs, audit, Sentry, snapshots, benchmarks.
- Must fail closed on invalid/expired/revoked without enumeration oracle.
- Must reuse single `makePick` transaction path; CPU picks never bypass legality.
- 44×44 px targets, focus rings tokenized, semantic fieldset/legend, 320 px no overflow.
