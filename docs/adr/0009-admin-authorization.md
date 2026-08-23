# ADR 0009: Admin authorization, projection overrides, and audit logging

- Status: accepted
- Date: 2026-08-21
- Phase: 1 — data, projections baseline, player experience

## Context

BUILD_SPEC.md requires admin-only projection-override and player-signal
management with a required rationale, safe 403s for non-admins, and
redacted audit logging — but explicitly prohibits a raw ingestion-trigger
button and raw error exposure in the admin UI. Phase 0 wired Clerk as an
optional integration (`apps/web/lib/env.ts::isClerkConfigured`) and defined
`User.role: UserRole` (`USER | ADMIN`) in the schema, but never built a
Clerk-to-`User`-row sync mechanism (a webhook), and this session has no
real Clerk keys to configure one against. Phase 1 also never built the
`/internal/v1/projections/*` FastAPI routes the original plan sketched for
Slice D/H — only the Typer CLI entry points (`publish`, `evaluate`) exist
on the analytics service.

## Decision

### Auth seam

`apps/web/lib/server/auth.ts::getCurrentUser()` is the single place that
resolves a Clerk session down to a `User` row: `null` whenever Clerk isn't
configured, there's no session, or the session's Clerk user ID has no
matching `users.clerkUserId` row. `requireAdmin()` layers a role check on
top. Every `/api/v1/admin/*` route calls the shared
`apps/web/lib/api/admin-guard.ts::requireAdminOrProblem()`, which returns
401 (unauthenticated) vs. 403 (authenticated, not admin) — neither response
reveals whether a given Clerk user ID exists in the system. `/admin/*`
pages get the same gate once, in `app/admin/layout.tsx`.

**Known gap (closed 2026-08-22):** the original revision noted that no
Clerk-user-sync webhook existed, so a real Clerk sign-in could never
resolve to a `User` row. `POST /api/v1/webhooks/clerk` now implements the
signed mirror this ADR designed for — see docs/adr/0008-background-jobs-
and-caching.md's "Clerk webhook user mirror" section. Role assignment
remains server-controlled: only Clerk Backend-API-writable
`publicMetadata.draftcourtRole === "ADMIN"` grants ADMIN; client-writable
`unsafeMetadata` is ignored; audit entries are redacted to
`{ clerkUserId, role }`. No route or page changes were needed — the seam
held.
This was verified directly: with `.env.local`'s blank Clerk keys, every
`/api/v1/admin/*` route curls a clean 401, and every `/admin/*` page
renders its "sign-in required" state — the correct behavior for this
deployment's actual current auth state, not a stub.

### Overrides and signals

`lib/server/admin-overrides.ts` / `admin-signals.ts` are the sole write
path — every mutation goes through `writeAuditLog()` in the same call,
recording a safe, pre-serialized before/after snapshot (never a raw Prisma
error or unredacted request body). `createOverrideSchema` /
`createSignalSchema` (`lib/server/admin-validation.ts`) enforce "exactly
one of deltaValue/replacementValue" and a non-blank rationale as a friendly
422 in front of the same two rules already enforced as hand-added Postgres
CHECK constraints (`projection_overrides_value_xor_check`,
`projection_overrides_rationale_check` — ADR 0005); both layers are tested
independently in `tests/unit/admin-overrides.test.ts`, including proving
the DB constraint still holds if the API-layer validation were ever
bypassed.

History is never deleted: **revoke** sets `status = REVOKED` in place;
**supersede** creates a new override row with `supersedesId` pointing at
the prior one and marks the prior row `SUPERSEDED`, both inside one
transaction. A `PENDING`/`ACTIVE` → `EXPIRED` transition on `expiresAt`
passing would require a scheduler, which doesn't exist until Slice H's
background jobs are built — Phase 1's admin UI only supports the immediate,
explicit revoke/expire actions.

### No live preview, no recompute-on-save

The original plan sketched a "preview-before-publish" dry-run endpoint and
an automatic recompute call into the analytics service after every
override. Neither exists: the analytics service has no
`/internal/v1/projections/*` HTTP surface (Slice D/H were never built with
one — only its Typer CLI), and building one is out of scope for admin CRUD
work. Consequently: **creating or revoking an override or signal takes
effect the next time `uv run python -m app.pipelines.cli publish` runs**
(which already reads active overrides/signals — see
`services/analytics/app/pipelines/adjustments.py`), not immediately. The
admin UI states this explicitly rather than implying a live recompute that
doesn't happen. This is a real, documented Phase 1 limitation, not a silent
gap — revisit once Slice H's background-job infrastructure exists.

### No raw ingestion trigger, no raw errors

The admin UI has no button that triggers ingestion or projection runs
directly (those remain CLI-only, per the prohibition). Every admin route
returns the same `{data, error, meta}` envelope as public routes; API
errors surfaced in the admin forms are the `ProblemDetails.detail` string
only, never a raw exception message or stack trace.

## Consequences

- Admin CRUD, validation, supersede/revoke semantics, and audit logging are
  fully real and tested against a live Postgres.
- The admin UI's authenticated "happy path" (an actual admin viewing/using
  the forms) could not be visually verified in this environment — there is
  no way to hold a real Clerk session without real Clerk keys. The gate
  itself (blocking anonymous access) was verified live in a browser; the
  data-layer it protects was verified via `tests/unit/admin-*.test.ts`
  hitting the real database directly.
- Fixed a real, unrelated bug found while writing these tests:
  `apps/web/vitest.config.ts` hardcoded Postgres port `5432`; the actual
  local Postgres (docker-compose.yml) runs on `55432`. Every previous
  Vitest test in this package was a pure function with no DB dependency, so
  this had never been exercised until now.
