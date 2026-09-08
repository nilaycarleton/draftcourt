# Runbook: stale projection data

## Detection

`freshnessCheckFunction` (`apps/web/lib/inngest/functions/freshness-check.ts`)
runs hourly and logs a structured `console.warn("[freshness-check]", ...)`
when the current season's published `ProjectionRun` is more than 24 hours
old, or when none has ever been published. It only reads and logs — it
never triggers ingestion or a republish itself (see
`docs/adr/0008-background-jobs-and-caching.md`).

You can also check freshness directly:

```bash
curl -s http://localhost:3100/api/v1/rankings | python3 -c \
  "import json,sys; print(json.load(sys.stdin)['meta'])"
```

`meta.projectionRunId: null` means nothing has ever been published.
`GET /data-sources` also shows each `DataSource`'s
`freshness.lastSuccessfulAt`.

## Fixing it

Stale data in this deployment (demo dataset, no live external source)
almost always means the last `publish` run is old, not that a real
upstream feed went stale. Primary path: the nightly 06:00 UTC
`nightly-source-refresh-and-publish` Inngest function refreshes and
publishes automatically (ADR 0008). If automation missed its window, the
manual fallback is:

```bash
pnpm demo:ingest
```

This re-ingests `data/demo/*.json` (a no-op for already-seen records —
dedup is by checksum) and publishes a fresh `ProjectionRun`. Verify with
the same `curl` check above; `meta.projectionRunId` should now be a new
UUID and `dataCutoff` should be current.

## If a future live source is wired in (see ADR 0006)

The freshness check's 24-hour threshold and its "read-only, log a
warning" behavior are both meant to be replaced, not extended, once live
sources with their own cadences arrive: per-source thresholds and
auto-remediation belong with the source adapter, and this runbook's manual
`pnpm demo:ingest` step stays the fallback for when automation itself
fails, rather than the primary fix.
