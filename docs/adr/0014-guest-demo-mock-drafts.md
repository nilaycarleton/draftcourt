# ADR 0014: Isolated Guest Demo Mock Drafts

- Status: accepted
- Date: 2026-09-04
- Phase: 3D — Guest demo mock drafts

## Context

BUILD_SPEC §1.2 and §9.1 require a public `/demo` flow allowing unauthenticated visitors to run a disposable CPU mock draft with secure resume capability, 24-hour expiration, and full isolation from authenticated data.

Key requirements:

- No Clerk authentication required
- Secure resume tokens (one-way hash, HttpOnly cookie + one-time recovery code)
- Anonymous rate limits (creation, resume, picks, CPU advancement, token failures)
- 24-hour TTL with cleanup job
- Full isolation: cannot access other demos, REAL/MOCK drafts, or any authenticated data
- Reuse Phase 3C CPU selector + `makePick` transaction
- No LLM, no hidden adaptive behavior

## Decision

### D1 — Guest capability model

A `DemoDraftCapability` record is the sole authority for guest access:

- `id` (UUIDv7) — internal identifier, never exposed
- `draftId` (FK to `Draft`, unique) — the demo draft it authorizes
- `tokenHash` (VARCHAR 128) — PBKDF2-HMAC-SHA256 of raw token (100k iterations, 32-byte salt, 32-byte key)
- `rateLimitKey` (VARCHAR 64) — SHA-256 of IP + User-Agent (never raw IP stored)
- `expiresAt` (timestamptz) — 24 hours from creation, immutable
- `revokedAt` (timestamptz, nullable) — explicit invalidation
- `createdAt` (timestamptz) — for cleanup ordering

Raw token is returned **once** at creation as copyable recovery code AND set as secure HttpOnly cookie (`__Secure-demo-capability`; Secure; SameSite=Lax; Max-Age=86400).

### D2 — Draft model changes

`Draft` table already supports `type: DraftType` with `DEMO` value. For guest demos:

- `ownerId` = NULL (distinguishes from authenticated MOCK)
- `leagueId` = NULL (demo drafts don't require a persistent league; settings snapshot embedded)
- `simulationSeed` populated (user-supplied or server-generated base36)
- `status` flows: SETUP → ACTIVE → COMPLETED/ABANDONED
- `shareTokenHash` stays NULL (guest demos not shareable)
- New columns: `demoCapabilityId` (FK, unique), `demoTokenHash` (denormalized for fast read-path validation)

### D3 — Anonymous rate limits

Redis counters with bounded windows (PostgreSQL fallback via audit_log):

| Endpoint/action       | Window     | Limit | Key derivation        |
| --------------------- | ---------- | ----- | --------------------- |
| Demo creation         | 1 hour     | 3     | hashed IP             |
| Resume/state read     | 1 minute   | 30    | capability token hash |
| Guest user pick       | 30 seconds | 10    | capability token hash |
| Guest CPU advancement | 30 seconds | 10    | capability token hash |
| Token failure         | 5 minutes  | 5     | hashed IP + path      |

Responses use RFC 9457 problem details with `Retry-After`. No enumeration oracle — invalid/expired/missing tokens return identical 401/403.

### D4 — Expiration & cleanup

- Authoritative: `DemoDraftCapability.expiresAt` (PostgreSQL)
- All guest read/write paths enforce `expiresAt > now()`
- Expired returns 401 `/problems/demo-expired`; UI shows banner, stops orchestration
- Cleanup job: hourly, batch size 100, advisory lock
- Deletes `DemoDraftCapability` + associated `Draft` + `DraftTeam` + `DraftEvent` + `DraftRosterAssignment` + `DraftOutbox` + `RecommendationSnapshot`
- Idempotent: `DELETE WHERE expiresAt < now() AND revokedAt IS NULL`
- Never touches authenticated drafts (`ownerId IS NOT NULL` or `type != 'DEMO'`)

### D5 — Guest API routes

All under `/api/v1/demo-drafts`:

| Method | Route                       | Purpose                                                                    |
| ------ | --------------------------- | -------------------------------------------------------------------------- |
| POST   | `/demo-drafts`              | Create demo; returns `{draftId, capabilityToken, expiresAt}` + sets cookie |
| GET    | `/demo-drafts/:id`          | Resume/read state (cookie or `Authorization: Bearer <token>`)              |
| POST   | `/demo-drafts/:id/picks`    | Guest user pick (If-Match, Idempotency-Key, capability)                    |
| POST   | `/demo-drafts/:id/cpu-pick` | Advance CPU turn with decision evidence                                    |
| POST   | `/demo-drafts/:id/undo`     | Undo latest pick                                                           |
| POST   | `/demo-drafts/:id/complete` | Mark completed (armed two-step)                                            |
| POST   | `/demo-drafts/:id/abandon`  | Revoke capability, mark abandoned                                          |

All mutations require `If-Match` + `Idempotency-Key`. CPU endpoint never accepts player input.

### D6 — Client orchestration

Fork of `useMockRunner` → `useDemoRunner`:

- Capability token from cookie or localStorage recovery code
- `demo` mode flag changes API base from `/drafts/:id` to `/demo-drafts/:id`
- Same pacing (slow/normal/instant), auto-advance, pause/cancel, conflict recovery
- Expiration handling: intercept 401 `/problems/demo-expired`, show banner, stop runner
- No Clerk auth state in demo cache keys

### D7 — Guest UI (`/demo` page)

- Create/start flow: league preset, user slot, CPU personality, seed, speed
- Clear "Temporary demo — expires in 24 hours" banner
- Draft room: reuses `DraftRoom` with transformed state
- Expiration banner, invalid/revoked state, completion state
- Sign-up CTA that does NOT claim draft conversion (Phase 5+)
- Accessibility: live regions for CPU picks, stable focus, 320px/200%/reduced motion

## Consequences

- Authenticated drafts unchanged — no new columns required for REAL/MOCK
- Guest demos fully isolated by capability token; cannot enumerate or access other data
- Cleanup job handles TTL without manual intervention
- Reuses Phase 3C CPU selector + `makePick` — no second transaction path
- Operator can reproduce any demo from `{simulationSeed, league settings, projection run, personality snapshots}`

## Verification (final audit 2026-09-05)

- Typecheck: `tsc --noEmit` 0 errors (web 0, domain 0, ui 0, db 0) + `mypy --strict` clean
- Lint: `pnpm lint` 0 errors, `ruff check` 0, `prettier --check` clean, `git diff --check` clean
- Unit: domain 86, UI 34, web 259 +1 skipped (35 files, 18 token +15 demo integration), db 2, cpu-mock 9/9
- Python: 167 passed via `PYTEST_DB_ENV` + `uv run pytest` (15 skipped), 6 contract checks passed
- Migrations: 13 applied including `20260905000000_phase3d_token_hash_length`; fresh + upgrade verified, deterministic seed + ingestion (239 players) green
- Build: Next.js production build success (all `/demo` routes), Storybook 1958 modules, tokenized theming
- Benchmark: `bench-demo-drafts.ts` p50 creation 39ms / verify 9.6ms / resume 15ms / userPick 25ms / cpuPick 66ms / full 12-team 656ms, no PII/leakage, async verification bound
- Playwright: smoke 3, demo-draft 2 (21-step journey incl. recovery, axe 0 serious/critical, keyboard, focus, 320px, 200% zoom, light/dark, reduced-motion), board-storybook 27 (visual, axe, responsive) — all green on chromium after Redis flush; version-conflict 409 authoritative verified
- Security: 256-bit `randomBytes(32)`→43-char base64url, PBKDF2 100k async on public paths, constant-time, SHA256 hashed rate-limit keys, uniform 401, no enumeration, no token/IP in logs/audit/Sentry/snapshots/benchmarks, cleanup demo-only verified
- Impeccable: shape + 7-pass critique/harden/adapt/clarify/audit/polish accepted (`phase3d-demo-shape.md` / `phase3d-demo-critique-audit.md` 16/20 Good) with SLAd patches (label, synthetic disclosure, recovery banner, runner refs, ACTIVE creation, 409 mapping, slot default, reduced-motion/high-contrast)
- Graphify: 6700 nodes / 14293 edges / 534 communities (96% extracted, 555 inferred), paths verified
