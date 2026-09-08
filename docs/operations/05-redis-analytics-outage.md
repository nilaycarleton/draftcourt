# Redis / analytics outage (degraded-mode playbooks)

Expected degraded behaviors come from BUILD_SPEC §14 and ADR 0008; each
play below names the code that implements it. Nothing here promises
latency or availability numbers — those are unverified.

## Detection

- Redis: cache client falls back silently by contract; confirm via
  elevated Postgres `audit_log` rate-limit writes or Redis connection
  errors in web logs.
- Analytics: circuit breaker short-circuits to `unavailable`
  (`apps/web/lib/server/circuit-breaker.ts`,
  `apps/web/lib/server/analytics-client.ts:28-30,66,216-220`);
  internal POSTs answer 401/404/422 (deterministic, no trip) vs 409/504
  typed results; Inngest nightly run fails and retries with backoff
  (retries 3, concurrency 1 — ADR 0008).

## Containment

- Redis down: do nothing to traffic — rate limits continue via the
  Postgres `audit_log` fallback with identical windows
  (`apps/web/lib/server/demo-rate-limit.ts:55-93`;
  `apps/web/lib/server/share-rate-limit.ts:46-88`); public-rankings
  cache recomputes instead of serving stale (stale-while-revalidate
  applies to public rankings only — ADR 0008).
- Analytics down: stop expecting fresh publishes; the nightly job's
  exponential backoff handles retries. Do not hand-run partial pipeline
  steps outside the job state machine.

## Recovery

1. **Analytics unavailable → serve last published run + freshness.**
   Rankings/players/analysis read the current `isCurrent` run and label
   it: freshness check warns past 24 h; analysis marks `STALE`/`LOW`
   confidence with `dataFreshness` provenance (ADR 0015 D4). When the
   service returns, the next scheduled (or on-demand
   `analytics/projection-publish.requested`) run republishes; duplicate
   deliveries replay via `Idempotency-Key`
   (`services/analytics/app/api/internal.py:383-415`).
2. **Redis fails → recompute.** No cache purge ceremony: cache keys
   include the projection run ID, so a republish is itself a key change
   (`docs/runbooks/failed-publish-rollback.md` step 3). Restart Redis
   (Compose: `docker compose up -d redis`) and let counters rebuild.
3. **Postgres unavailable → disable mutations, show read-only.**
   Per BUILD_SPEC §14: mutations off with a clear read-only state; reads
   degrade to whatever the cache holds. Postgres has no fallback — this
   is the one hard-down case.

## Verification

- Rankings `meta.projectionRunId` + `dataCutoff` current after recovery;
  freshness warning cleared in logs.
- Rate-limit behavior spot-checked (one allowed + one throttled probe
  with `Retry-After`).
- Circuit breaker observed closed (successful internal call transits
  `recordSuccess`).

## Rollback

Degraded mode needs no rollback: it is the absence of fresh data, not a
state change. If a bad publish landed during the outage, use
`docs/runbooks/failed-publish-rollback.md` (repoint, never delete).

## Escalation

If analytics stays down past the 15-minute job-delay upgrade trigger
(BUILD_SPEC §18.3) or Postgres is hard-down: freeze writes, follow
`02-database-backup-restore.md` for the database case, and treat the
analytics host (Render, once provisioned) as the failing unit — restart,
then roll back the analytics deploy before investigating data.

## Sources

- `BUILD_SPEC.md` §14, §18.3
- `docs/adr/0008-background-jobs-and-caching.md`
- `docs/adr/0015-draft-analysis-and-history.md`
- `docs/runbooks/stale-data.md`
- `docs/runbooks/failed-publish-rollback.md`
- `apps/web/lib/server/analytics-client.ts`
- `apps/web/lib/server/circuit-breaker.ts`
- `apps/web/lib/server/demo-rate-limit.ts`
- `apps/web/lib/server/share-rate-limit.ts`
- `apps/web/lib/server/share-cleanup.ts`
- `apps/web/lib/server/demo-cleanup.ts`
- `services/analytics/app/api/internal.py`
- `docs/operations/01-runbook-template.md`
