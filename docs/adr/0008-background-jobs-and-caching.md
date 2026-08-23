# ADR 0008: Background jobs and caching/resilience

- Status: accepted (supersedes the 2026-08-21 revision)
- Date: 2026-08-22
- Phase: 1 — data, projections baseline, player experience (gate completion)

## Context

BUILD_SPEC.md section 7.2 requires background workflow foundations
("callable in local/test environments without requiring paid
infrastructure") and a Redis-optional cache layer with graceful
degradation. The original plan sketched Inngest functions for scheduled
source refresh, normalization/quarantine processing, baseline projection
generation, atomic publish, a freshness check, and a stale-data alert — all
as thin wrappers around the analytics service.

The previous revision of this ADR documented a load-bearing gap: the
analytics service (`services/analytics`) exposed its ingestion and
projection pipelines only as a Typer CLI (`app/ingestion/cli.py`,
`app/pipelines/cli.py`); there was no `/internal/v1/*` HTTP surface for the
Next.js app to call into, so scheduled refresh/publish could not exist
without either shelling out (impossible on serverless, and different from
production behavior) or logging fabricated success (prohibited). That gap
is now closed; this revision records how.

## Decision

### Internal HTTP API (`services/analytics/app/api/internal.py`)

`/internal/v1/*` implements BUILD_SPEC section 8.4:

| Route                                  | Behavior                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /internal/v1/ingestion/{source}` | runs `run_ingestion` directly (only `demo-file` exists)                                                                                      |
| `POST /internal/v1/projections/run`    | atomic baseline publish via `publish_baseline_run`                                                                                           |
| `POST /internal/v1/models/evaluate`    | time-ordered backtest + report write                                                                                                         |
| `GET /internal/v1/jobs/{id}`           | machine-readable job state                                                                                                                   |
| `POST /internal/v1/models/train`       | **deliberately absent** — the Phase 1 baseline is deterministic (no training stage exists to trigger); the trained ensemble is Phase 4 scope |

Guarantees:

- **Service auth** (`app/core/security.py`): bearer secret
  (`SERVICE_SECRET`, compared constant-time) plus `X-Request-Timestamp`
  within `SERVICE_AUTH_TIMESTAMP_WINDOW_SECONDS` (default ±300s). Rotation
  is redeploying both services with a new shared value; per-request signing
  is deferred until a real deployment topology needs it.
- **Structured job state**: every POST writes one `analytics_jobs` row
  through PENDING→RUNNING→SUCCEEDED/FAILED/TIMEOUT (Prisma-owned table,
  migration `20260822215704_add_analytics_jobs`; accessed from Python via
  SQLAlchemy Core per ADR 0002).
- **Idempotency**: `Idempotency-Key` maps to one job per kind; duplicate
  delivery replays the recorded outcome (`X-Idempotent-Replay: true`)
  without re-running; FAILED/TIMEOUT jobs retry in place; orphaned
  in-flight jobs (dead process) retry after 2× timeout.
- **Concurrency control**: at most one RUNNING job per kind; concurrent
  submissions get an immediate 409 problem. Postgres state, not Redis —
  honest about single-instance scope.
- **Bounded timeouts**: work runs under `asyncio.wait_for`
  (`INTERNAL_JOB_TIMEOUT_SECONDS`, default 900s); expiry marks TIMEOUT and
  answers 504 with an `X-Job-Id` header.
- **Trace propagation**: inbound `X-Trace-Id` flows into job rows, logs,
  and responses.
- **Safe errors**: RFC 9457 problems; exception text stays server-side.
- Pipeline work is invoked directly — never by shelling out to the CLI —
  so local, CI, and production behavior are identical. The CLIs remain for
  human/operator use.

### Circuit breaker wiring (`apps/web/lib/server/analytics-client.ts`)

The previously-unwired `CircuitBreaker` now guards the first real
web→analytics calls: `AnalyticsClient.postJob/getJob` sign every request
(secret + fresh timestamp + trace/idempotency headers), enforce client-side
timeouts via `AbortSignal.timeout`, map problem responses onto a typed
result union (`unavailable | rejected | conflict | timeout`), count only
health-relevant failures toward opening, and short-circuit to
"unavailable" while open. Deterministic rejections (401/404/422) do not
trip the breaker. `CircuitBreaker` gained explicit
`recordSuccess()/recordFailure()` methods for callers whose failure signal
is a result union rather than an exception; existing `exec()` behavior is
unchanged.

### Inngest functions (`apps/web/lib/inngest/functions/`)

- `nightly-source-refresh-and-publish` (cron `0 6 * * *`,
  retries 3, concurrency 1): step 1 ingests the demo source, step 2
  publishes projections; a failed step throws to trigger Inngest's
  exponential backoff, and each attempt carries a deterministic daily
  `Idempotency-Key`.
- `projection-publish-on-demand` (event `analytics/projection-publish.requested`):
  audited manual republish path for future admin-side recompute flows.
- `projection-freshness-check` (hourly): unchanged from the previous
  revision.
- Local/test invocation needs no paid infrastructure: with no keys the
  client runs against the local Inngest Dev Server (`npx inngest-cli@latest dev`),
  and each function's core logic is a plain exported function unit-tested
  without the runtime.

Source-mode honesty: the nightly cron refreshes exactly the `demo-file`
source because it is the only adapter that exists. Permitted live adapters
(Phase 4) will register their own sources/schedules rather than silently
reusing this demo path.

### Clerk webhook user mirror

The other half of the Phase 1 gate: `POST /api/v1/webhooks/clerk`
(`apps/web/app/api/v1/webhooks/clerk/route.ts`) verifies Clerk's svix
signature against the raw body (`CLERK_WEBHOOK_SIGNING_SECRET`) and mirrors
the minimum profile into `users` (`lib/server/clerk-sync.ts`). Role comes
only from `publicMetadata.draftcourtRole` — writable exclusively via
Clerk's Backend API, never by browser clients; `unsafeMetadata` is ignored.
Audit entries are redacted to `{ clerkUserId, role }`. Deletion events are
audited but intentionally retain the row (ownership/audit references;
account deletion is a documented product flow). This closes the seam ADR
0009 recorded where `getCurrentUser()` could never resolve.

## Consequences

- Scheduled refresh/publish are real end-to-end: verified live (authed
  publish produced projection run `73d4ef8b…` with 230 players; duplicate
  delivery replayed; stale timestamps rejected; demo ingestion ran through
  HTTP).
- Stale-while-revalidate remains scoped exactly as before (public rankings
  route only).
- The admin UI still does not auto-recompute after override changes; the
  `projection-publish-on-demand` event now provides the missing trigger
  mechanism for whoever wires that UX.
- `/internal/v1/models/train` absence is documented, not stubbed.
