# Runbook: rolling back a bad projection run

Referenced from `models/baseline-v1/model-card.md`. Use this when a
published `ProjectionRun` is producing visibly wrong output (a bad
override, a bug in `baseline.py`, bad input data) and you need the
previous run to be current again.

## Background

`PlayerProjection` rows are never deleted, and every `ProjectionRun` is
retained permanently — publishing never overwrites history, it only adds a
new run and flips a pointer. `ProjectionRun.isCurrent` is guarded by a
partial unique index (`projection_runs_one_current_per_season` — see
`docs/adr/0005-phase1-data-model.md`), so at most one run per season can be
current, and the flip happens inside one transaction. Rolling back means
flipping that pointer back to a known-good prior run — not deleting
anything.

## Steps

1. **Identify the two run IDs.** The bad run's ID is visible in `GET
/api/v1/players` or `/api/v1/rankings`'s `meta.projectionRunId`, or via:

   ```sql
   SELECT id, "isCurrent", "publishedAt", "dataCutoff"
   FROM projection_runs
   WHERE season = '2026-27'
   ORDER BY "publishedAt" DESC;
   ```

   Pick the target (good) run's ID from this list.

2. **Flip the pointer in one transaction** (do this via `psql` or a short
   script — there is no admin UI button for this, deliberately, since it's
   a rare, high-consequence action):

   ```sql
   BEGIN;
   UPDATE projection_runs SET "isCurrent" = false WHERE id = '<bad-run-id>';
   UPDATE projection_runs SET "isCurrent" = true  WHERE id = '<good-run-id>';
   COMMIT;
   ```

   The partial unique index rejects the transaction if both ends up
   `true` at once, so a mistake here fails loudly rather than silently
   producing two "current" runs.

3. **Verify**: `GET /api/v1/rankings` should now report the target run's
   ID in `meta.projectionRunId`. `/players` and `/players/[slug]` read the
   same pointer, so they update immediately — no cache purge needed beyond
   what `docs/adr/0008-background-jobs-and-caching.md`'s
   `getOrRevalidate` already handles (the cache key includes the run ID,
   so a rollback is itself a cache-key change).

4. **If the bad run was caused by a bad override**: also revoke it via
   `PATCH /api/v1/admin/projection-overrides/:id` (`{"action":"revoke"}`)
   so the _next_ `publish` doesn't reproduce the same bad output — rolling
   back the pointer alone doesn't stop the override from applying again on
   the next real publish.

5. **If retiring the model version entirely** (not just this one run): set
   `ProjectionModel.status = 'ARCHIVED'` for the bad model version so
   future publishes don't accidentally target it.

## What this runbook does not cover

Restoring from a Postgres backup — this procedure only ever repoints
existing, already-durable rows; it assumes the bad run's data is still
present (which it always is, since nothing gets deleted).
