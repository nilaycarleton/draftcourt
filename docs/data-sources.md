# Data sources register

This is the developer-facing register of every `DataSource` row this
Phase 1 deployment ships with. The public, live-from-the-database view of
the same information (plus current freshness) is `/data-sources` in the
app, backed by `GET /api/v1/data-sources`
(`apps/web/lib/server/data-sources.ts`) — this document is the static
reference for people reading the repo, not a second source of truth to
keep manually in sync with row contents.

| Name                | Adapter | What it provides                                                      | Real vs. synthetic                                                                                                       |
| ------------------- | ------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `demo-file-adapter` | `FILE`  | Teams, players, positions, season stats, news signals, override seeds | Player/team/position names are real public facts; every statistic is fabricated. See `data/attribution/demo-dataset.md`. |
| `demo-adp-source-a` | `FILE`  | One of two demo ADP observation sets                                  | Entirely synthetic.                                                                                                      |
| `demo-adp-source-b` | `FILE`  | The second demo ADP observation set                                   | Entirely synthetic.                                                                                                      |

## Why only demo sources exist

BUILD_SPEC.md section 7.2 pre-authorizes this fallback: if no reliable,
permitted live NBA source can be verified as licensable in the
development environment, implement a production-shaped file adapter
around a deterministic demo dataset instead. That's what
`DemoFileAdapter` (`services/analytics/app/ingestion/file_adapter.py`) is
— it runs through the exact same `extract → checksum/dedup → validate →
quarantine → normalize → reconcile → publish` pipeline
(`docs/adr/0006-source-adapter-framework.md`) a real source would.

## Adding a real source later

Per ADR 0006: implement `SourceAdapter.extract()` against the real
endpoint (its own auth/pagination/rate-limiting lives inside that method),
construct a `DataSourceConfig` with the real terms URL, attribution text,
and compliance-review date, and register a new `DataSource` row. Nothing
in `schemas.py` (validation), `identity.py` (reconciliation),
`pipeline.py` (orchestration), or `db.py` (persistence) needs to change —
verified by the integration tests exercising a second, in-test-only
`SourceAdapter` implementation alongside `DemoFileAdapter`.

Two things were true when this was written and have since changed (ADR 0008,
2026-08-22) — kept here so the history reads honestly:

1. ~~An internal HTTP endpoint … CLI-only~~ — **shipped**: the analytics
   service now exposes service-authenticated `/internal/v1/*` (ingestion,
   projections, evaluate, jobs) and real Inngest functions
   (`nightly-source-refresh-and-publish` cron 06:00 UTC,
   `projection-publish-on-demand`) call them — see
   `docs/adr/0008-background-jobs-and-caching.md`.
2. `DataSource.enabled` being read by `run_ingestion` before calling
   `extract()` — see `docs/runbooks/source-disable.md`. With only one
   source wired up, there's nothing yet to gate.

## Refresh policy

Demo sources refresh via the nightly 06:00 UTC Inngest cron (or on-demand
publish); `pnpm demo:ingest` remains the manual fallback and the CI path —
see `docs/adr/0008-background-jobs-and-caching.md`. See
`docs/runbooks/stale-data.md` for what "stale" means here and how to fix
it.
