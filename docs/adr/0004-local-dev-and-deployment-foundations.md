# ADR 0004: Local development and deployment foundations

- Status: accepted
- Date: 2026-08-20
- Phase: 0 — foundation and contracts

## Context

BUILD_SPEC.md section 18 requires one documented bootstrap command and one
full quality-gate command that work on macOS/Linux and in CI, plus Docker
Compose for local Postgres/Redis/analytics. Section 15 requires environment
variables to be documented (names only) and validated at startup, with
disabled optional integrations explicitly supported rather than crashing.

## Decision

- **Root commands** (`package.json` scripts, see README.md for the full
  reference): `pnpm bootstrap`, `pnpm dev`, `pnpm test`, `pnpm test:all`,
  `pnpm db:migrate`, `pnpm db:seed` — matching the README's documented
  contract exactly. `bootstrap`/`dev`/`test:all` are thin `bash` scripts
  under `scripts/` that orchestrate both the pnpm/Turborepo side and the
  `uv`-managed Python side, since there is no single tool that spans both
  ecosystems.
- **Env validation, both sides**: `apps/web/lib/env.ts` (Zod) and
  `services/analytics/app/core/config.py` (`pydantic-settings`) each fail
  fast with a readable error on missing _required_ variables
  (`DATABASE_URL`, `ANALYTICS_SERVICE_SECRET`, etc.) but default optional
  integrations (Clerk, Sentry, Inngest, Upstash, OpenAI, model artifact
  storage, news source URLs) to empty/disabled — verified with unit tests
  that construct an environment with every optional variable unset and
  assert no throw. `.env.example` documents every name from BUILD_SPEC.md
  section 15 with no real values; `.env.local` (gitignored) is the local
  working copy.
- **Clerk without credentials**: `middleware.ts` — renamed `proxy.ts`
  during Phase 0 per Next.js 16's file-convention rename (Next 16 emits a
  build-time deprecation warning for `middleware.ts`; `proxy.ts` is a
  drop-in rename, same `export default`/`config` shape) — only wraps
  `clerkMiddleware()` when `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and
  `CLERK_SECRET_KEY` are both set; otherwise it applies only the CSP/nonce
  logic. `app/providers.tsx` mirrors this for `<ClerkProvider>`, and
  `/sign-in`, `/sign-up` render an explanatory message instead of Clerk's
  UI when unconfigured. The whole app builds, runs, and passes its smoke
  test with zero real secrets.
- **Security headers**: static headers (`X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
  `Strict-Transport-Security`) via `next.config.ts`'s `headers()`. CSP is
  generated per-request in `proxy.ts` with a fresh nonce
  (`crypto.getRandomValues`, not `Math.random`), because a static CSP can't
  express a nonce; `script-src` never includes `'unsafe-inline'`. Both are
  pure, unit-tested functions (`lib/security-headers.ts`,
  `lib/content-security-policy.ts`) independent of a running server, plus a
  Playwright assertion against the live response headers.
- **Sentry redaction**: `lib/sentry-redact.ts` (web) and
  `app/core/sentry.py` (analytics) implement matching `beforeSend`/
  `before_send` hooks that strip auth headers, cookies, share/API tokens,
  AI prompts, and email addresses from event payloads — as pure functions
  unit-tested against constructed events, not requiring a live DSN. Both
  SDKs are initialized with an empty/absent DSN in local dev (no-op by
  design) and only activate when `SENTRY_DSN` is set.
- **Local Postgres port**: 55432, not the default 5432 — see ADR 0002 for
  why (a native Postgres was already running on this dev machine; blindly
  using 5432 would have silently targeted the wrong database).
- **FastAPI Docker image**: multi-stage `python:3.12.5-slim` + `uv`
  (`ghcr.io/astral-sh/uv:0.12.5`), `uv sync --frozen --no-dev` at build
  time. `UV_NO_SYNC=1` is set _after_ the build-time sync layers (setting
  it earlier would suppress those layers too) so the container CMD's
  `uv run uvicorn ...` never attempts a network sync at startup — confirmed
  by inspecting container logs before/after the fix; the "before" state
  was silently downloading `mypy`/`ruff` at every container start, which
  is both slow and a production reliability risk (no network in some
  deployment targets).
- **Deployment targets** (Vercel/web, Neon/Postgres, Upstash/Redis,
  Render/analytics) are as specified in BUILD_SPEC.md section 18.3 and not
  provisioned in Phase 0 — no accounts, tokens, or environments exist yet.
  This ADR records the intended shape so Phase 1+ deploy workflows have a
  documented target rather than an implicit assumption.

## Consequences

- `docker compose up -d postgres redis` is enough for `apps/web`'s local
  dev loop (`next dev` runs natively for fast refresh, per section 18.1);
  `docker compose up -d` (all services) is needed to exercise the
  analytics service's `/health/ready` against a real database, as verified
  during Phase 0 (`docker inspect` reported `healthy`, `/health/ready`
  returned `{"checks":{"database":"ok"}}`).
- Free-tier/cold-start honesty (BUILD_SPEC.md section 18.3) is deferred
  content for the actual deployment ADR/runbook once Phase 1+ provisions
  real environments; nothing here should be read as a production
  deployment guarantee.
