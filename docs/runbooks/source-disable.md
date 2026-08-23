# Runbook: disabling a data source

Use this to stop a specific source from being used without deleting its
history (raw records, ingestion runs, and any data already published from
it stay exactly as they are — this only affects future ingestion runs).

## Steps

1. Find the source's ID from `GET /api/v1/data-sources` or:

   ```sql
   SELECT id, name, enabled FROM data_sources ORDER BY name;
   ```

2. Disable it:

   ```sql
   UPDATE data_sources SET enabled = false WHERE id = '<source-id>';
   ```

3. Verify: `GET /data-sources` (the public page) now shows a `DISABLED`
   badge next to that source (`apps/web/app/data-sources/page.tsx` reads
   `enabled` directly).

## What this does and doesn't do

- **Does**: makes the source's disabled state visible on the public
  `/data-sources` page, which is the source of truth an admin or reviewer
  checks.
- **Doesn't automatically stop ingestion**: `services/analytics`'s
  ingestion pipeline (`app/ingestion/pipeline.py`) does not currently read
  `DataSource.enabled` before running — there is only ever one wired-up
  adapter (`DemoFileAdapter`) in this Phase 1 deployment, invoked
  explicitly via `pnpm demo:ingest`, so there is no scheduled/automatic
  ingestion path for this flag to gate yet. When a second real adapter is
  added (see `docs/adr/0006-source-adapter-framework.md`), `run_ingestion`
  should check `enabled` before calling `extract()` — tracked here as a
  known gap, not implemented speculatively ahead of there being a second
  source to gate.

## Re-enabling

```sql
UPDATE data_sources SET enabled = true WHERE id = '<source-id>';
```
