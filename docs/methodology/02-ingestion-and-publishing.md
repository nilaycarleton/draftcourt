# Ingestion and publishing methodology

Pipeline: `extract → checksum/dedup → validate → quarantine → normalize
→ reconcile identities → publish`, then the separate atomic baseline
publish. Implementation in `services/analytics/app/ingestion/` and
`services/analytics/app/pipelines/`; decisions in ADR 0006 (adapter
framework) and ADR 0005 (publish mechanics).

## Stage diagram

See `docs/architecture/04-data-flows.md` §3 for the flowchart. Stage
details:

1. **Extract.** `SourceAdapter.extract()` yields `RawRecord`s
   (`record_type`, `external_key`, `payload`, `fetched_at`,
   `schema_version`). Only `DemoFileAdapter` exists (reads the six
   `data/demo/*.json` files in fixed order). Adding a live source means a
   new `extract()` plus a `DataSource` row — validation, identity, and
   orchestration code do not change (ADR 0006).
2. **Checksum/dedup.** Canonical-JSON sha256 per record
   (`checksum.py`); an identical payload from the same source
   (`(sourceId, checksum)` already stored) is never re-validated or
   re-published. Re-runs are fully idempotent but still write a new
   `IngestionRun` row recording the no-op attempt (ADR 0006).
3. **Validate.** Pydantic schemas per record type
   (`RAW_RECORD_SCHEMAS`); failures become `QUARANTINED` rows with
   JSON-safe rendered errors (round-tripped through Pydantic's own
   `error.json()` so unserializable validator context can't crash the
   asyncpg bind — ADR 0006 "Second bug").
4. **Normalize.** Teams and players first, then season stats / ADP / news
   signals / override seeds, each looked up by the now-resolved player.
5. **Reconcile identities.** Provider-ID fast path for seen
   `(sourceId, externalId)` pairs; otherwise name+DOB scoring
   (`rapidfuzz` token-sort ratio + 5 points for exact DOB) against
   thresholds `CANDIDATE_THRESHOLD = 75`, `CONFIRM_THRESHOLD = 92`:
   below 75 = new player, 75–92 = `CANDIDATE` row with `playerId` NULL
   (reviewable unresolved state, stays `VALIDATED`-not-`PUBLISHED` and is
   retried on later runs), 92+ = auto-`CONFIRMED`. Players created earlier
   in the same run are excluded from the candidate pool (same-source keys
   are already unique — the Jokić/Jović fix). (ADR 0006)
6. **Publish (data).** Validated records whose identity resolved reach
   normalized tables; their `RawSourceRecord.status` flips to `PUBLISHED`.
7. **Publish (baseline projections).** `publish_baseline_run` writes all
   `PlayerProjection` rows and flips `ProjectionRun.isCurrent` inside one
   transaction guarded by the partial unique index
   `projection_runs_one_current_per_season` — readers never observe a
   half-published run; rollback is repointing, never deletion
   (`docs/runbooks/failed-publish-rollback.md`).

## Quarantine policy

Invalid rows never silently coerce: they persist as `QUARANTINED` with
their validation errors, traceable via
`RawSourceRecord → IngestionRun → DataSource` lineage (checksums and
trace IDs at every step). Quarantine is observable, not blocking: the
demo dataset publishes cleanly end-to-end (230 players, 0 quarantined, 0
unresolved after the collision fix — ADR 0006).

## Freshness thresholds

| Signal                                                                                             | Threshold                                                                                                                  | Source                                                                             |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Projection run age (hourly check)                                                                  | warn when current-season run > 24 h old or never published                                                                 | `docs/runbooks/stale-data.md`; `apps/web/lib/inngest/functions/freshness-check.ts` |
| Nightly refresh cadence                                                                            | cron `0 6 * * *` (ingest demo source, then publish)                                                                        | ADR 0008                                                                           |
| Intended live-source cadences (stats nightly, injuries 60 m in-season, ADP daily pre-season, etc.) | BUILD_SPEC §7.2 refresh policy — **specified, not implemented** (no live adapter exists)                                   | BUILD_SPEC §7.2; `docs/data-sources.md`                                            |
| Analysis confidence inputs                                                                         | projection `publishedAt` > 7 d preseason / > 1 d in-season → `STALE`; ADP `capturedAt` > 7 d or `sourcesCount < 2` → `LOW` | ADR 0015 D4                                                                        |

The 24-hour freshness-check threshold is acknowledged as a placeholder to
be replaced (not extended) once a real scheduled refresh owns the fix
(`docs/runbooks/stale-data.md`).

## Sources

- `docs/adr/0005-phase1-data-model.md`
- `docs/adr/0006-source-adapter-framework.md`
- `docs/adr/0008-background-jobs-and-caching.md`
- `docs/adr/0015-draft-analysis-and-history.md`
- `docs/architecture/04-data-flows.md`
- `docs/data-sources.md`
- `docs/runbooks/stale-data.md`
- `docs/runbooks/failed-publish-rollback.md`
- `services/analytics/app/ingestion/base.py`
- `services/analytics/app/ingestion/pipeline.py`
- `services/analytics/app/ingestion/identity.py`
- `services/analytics/app/ingestion/db.py`
- `services/analytics/app/ingestion/file_adapter.py`
- `services/analytics/app/pipelines/run.py`
- `services/analytics/app/pipelines/baseline.py`
- `BUILD_SPEC.md` §7.2
