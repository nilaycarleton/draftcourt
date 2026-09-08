# Incident response

Covers the BUILD_SPEC §19 alert list: failed production deploy,
error-rate spike, database saturation, stale projections/ADP/injuries,
scheduled job failure, recommendation p95 breach, AI budget threshold.
(Anything AI-budget fires only if the premium assistant ever ships —
today it is disabled; treat such an alert as a misconfiguration signal.)

## Detection

| Alert (BUILD_SPEC §19)             | First signal in this repo                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed production deploy           | Deploy workflow failure + Sentry release not cut (pipeline planned, not provisioned — confirm manually until `deploy-production.yml` exists) |
| Error-rate spike                   | Sentry issue volume; route error logs with `traceId`                                                                                         |
| Database saturation                | Postgres connection errors, `/health/ready` database check failing, mutation latency climbing                                                |
| Stale projections / ADP / injuries | Hourly freshness-check warning (run > 24 h old); analysis `dataFreshness: STALE/LOW` markers                                                 |
| Scheduled job failure              | Inngest run failure on `nightly-source-refresh-and-publish`; analytics job row stuck FAILED/TIMEOUT (`GET /internal/v1/jobs/:id`)            |
| Recommendation p95 breach          | Benchmark/observability metrics by engine version (BUILD_SPEC §19); compare against `docs/benchmarks/` baselines                             |
| AI budget threshold                | N/A — no AI spend exists; if it fires, find the caller                                                                                       |

No paging integration is provisioned — alerting is **OPERATOR-EVIDENCE-NEEDED**
beyond Sentry/Inngest dashboards.

## Containment

1. Capture `traceId`s, job IDs, and timestamps first; paste only redacted
   logs (no raw tokens, digests, emails, or Clerk IDs — see
   `docs/security/01-threat-model.md`).
2. Prefer the reversible lever: revoke a share/demo capability, pause the
   Inngest cron, repoint `isCurrent` to the last good run
   (`docs/runbooks/failed-publish-rollback.md`), serve last-published
   data with freshness banners (`05-redis-analytics-outage.md`).
3. Never delete product data to "fix" an incident; cleaners only remove
   expired/long-revoked capability rows.

## Recovery

- Stale data → `docs/runbooks/stale-data.md` (manual `pnpm demo:ingest`
  until the scheduled path owns it).
- Bad publish → `docs/runbooks/failed-publish-rollback.md` (+ revoke the
  bad override so the next publish does not recur).
- Compromised/disabled source → `docs/runbooks/source-disable.md`.
- Share abuse → `docs/runbooks/share-revocation-cleanup.md`.
- DB/secret cases → `02-database-backup-restore.md` /
  `03-secret-rotation.md`.

## Verification

Each recovery runbook names its read-back (`meta.projectionRunId`,
replayed job state, revoked-capability 404-shape). Close the incident
only with the check output recorded, plus the Sentry/Inngest all-clear.

## Rollback

Application first, data second (BUILD_SPEC §17): redeploy the previous
known-good build before touching data; data rollback uses
`02-database-backup-restore.md`, never a destructive migration.

## Escalation

When this page is insufficient: freeze the blast radius (pause cron,
freeze writes), page the service owner, and bring trace IDs, job rows,
freshness outputs, and redacted logs. Production deploys and data
rollbacks require explicit approval once `deploy-production.yml` exists;
until then, no production change ships without a second human and a
recorded backup timestamp.

## Sources

- `BUILD_SPEC.md` §17, §19
- `docs/runbooks/stale-data.md`
- `docs/runbooks/failed-publish-rollback.md`
- `docs/runbooks/share-revocation-cleanup.md`
- `docs/runbooks/source-disable.md`
- `docs/operations/01-runbook-template.md`
- `docs/operations/02-database-backup-restore.md`
- `docs/operations/03-secret-rotation.md`
- `docs/operations/05-redis-analytics-outage.md`
- `docs/security/01-threat-model.md`
- `docs/benchmarks/METHODOLOGY.md`
