# Database backup and restore

Status: **procedure documented; live proof missing.** No backup job,
schedule, or restore test exists in the repo (only the Compose data
volume `draftcourt-postgres` in `docker-compose.yml:63-65` and the
planned pre-deploy backup in BUILD_SPEC §17). Every unverified step is
marked **OPERATOR-EVIDENCE-NEEDED**. Do not cite RTO/RPO numbers — none
have been measured.

## Detection

- Missing/damaged data is noticed via app errors, failed
  `/health/ready` database checks, or the Postgres container failing its
  `pg_isready` healthcheck (`docker-compose.yml:17-21`).
- Backup-health detection (job success/freshness alert) does not exist
  yet — **OPERATOR-EVIDENCE-NEEDED** (BUILD_SPEC §19 has no backup alert;
  add one when backups are provisioned).

## Containment

1. Stop writers before any restore: halt the analytics service and web
   instances (or scale to zero) so no new rows land mid-restore.
2. Snapshot the damaged volume first if it still mounts — a restore must
   never destroy the only copy of the current state.

## Recovery

Local/Compose procedure (illustrative commands; adapt host/port from
`POSTGRES_HOST_PORT`, default `55432`):

```bash
# 1. Backup (logical; run on a schedule once provisioned)
pg_dump "postgresql://draftcourt:draftcourt@localhost:55432/draftcourt" \
  --format=custom --file "draftcourt-$(date -u +%Y%m%dT%H%M%SZ).dump"

# 2. Restore to a scratch database first, never directly over production
createdb "postgresql://draftcourt:draftcourt@localhost:55432/draftcourt_restore"
pg_restore --dbname "postgresql://draftcourt:draftcourt@localhost:55432/draftcourt_restore" \
  "draftcourt-<timestamp>.dump"

# 3. Verify: migrations current, row counts sane, app smoke passes
# 4. Cut over only after verification (provider plan mechanics for
#    Neon/production: follow the provider's point-in-time/restore flow —
#    OPERATOR-EVIDENCE-NEEDED for the exact production path)
```

Production (Neon) backup follows the provider plan per BUILD_SPEC §14
("Back up PostgreSQL according to provider plan"). The exact
Neon-branch/restore flow for this project is **OPERATOR-EVIDENCE-NEEDED**.

## Verification

- `prisma migrate status` (via `pnpm db:migrate` tooling) shows no pending
  drift; spot-check `projection_runs.isCurrent` uniqueness and recent
  `audit_log` rows.
- `GET /api/v1/rankings` `meta.projectionRunId` matches the expected
  current run; one authenticated smoke draft loads.
- Record the restore-test date; BUILD_SPEC §14 requires a tested restore
  **quarterly before public launch**.

## Rollback

Restore is itself the rollback path. If a restore introduces worse
state, re-restore the pre-restore snapshot taken in Containment step 2.
Never run destructive/down migrations automatically in production
(BUILD_SPEC §17); schema changes use expand/migrate/contract, and
application rollback precedes data rollback.

## Escalation

If the backup is missing, corrupt, or older than the business tolerance:
freeze writes, page the data owner, and decide explicitly between
partial recovery (re-ingest demo data via `pnpm demo:ingest` + republish
— reproducible, but loses user drafts) and waiting for provider support.
Bring backup timestamps, restore logs (redacted), and the verification
outputs above.

## Sources

- `BUILD_SPEC.md` §14, §17
- `docker-compose.yml`
- `docs/adr/0002-postgres-and-prisma-ownership.md`
- `docs/runbooks/failed-publish-rollback.md` (repointing, not restore)
- `docs/operations/01-runbook-template.md`
- `.env.example` (`DATABASE_URL`, `DIRECT_DATABASE_URL` names only)
