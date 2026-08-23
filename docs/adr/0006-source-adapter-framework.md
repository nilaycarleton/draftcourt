# ADR 0006: Source adapter framework and identity reconciliation

- Status: accepted
- Date: 2026-08-21
- Phase: 1 — data, projections baseline, player experience

## Context

BUILD_SPEC.md section 7.2 requires a real `extract -> quarantine ->
validate -> normalize -> reconcile identities -> publish` pipeline, but
explicitly permits, when no reliable permitted live NBA source is
verifiable in the development environment: _"implement a production-shaped
file adapter around the deterministic demo dataset... Document exactly
what must change to enable a live source later."_ This session has no way
to verify licensing/terms for any specific live NBA API, so Phase 1
exercises the real pipeline against the committed demo fixture
(`data/demo/*.json`, see ADR-adjacent `data/attribution/demo-dataset.md`)
only.

## Decision

### Adapter interface (`services/analytics/app/ingestion/base.py`)

`SourceAdapter` is a `Protocol` with `config: DataSourceConfig` and
`extract() -> Iterator[RawRecord]`. `RawRecord` carries `record_type`,
`external_key`, `payload`, `fetched_at`, `schema_version` — nothing
adapter-specific leaks past `extract()`. `DemoFileAdapter`
(`file_adapter.py`) is the one instance wired up: it reads the six
`data/demo/*.json` files in a fixed order and yields `RawRecord`s.

**To add a live source later:** implement `SourceAdapter.extract()`
against the real endpoint (with its own auth/pagination/rate-limit
handling internally), construct a `DataSourceConfig` with real terms
URL/attribution/compliance-review date, and register it. Nothing in
`schemas.py` (validation), `identity.py` (reconciliation), `pipeline.py`
(orchestration), or `db.py` (persistence) changes — they are already
adapter-agnostic, verified by the integration tests in
`tests/ingestion/test_pipeline_integration.py` exercising a second,
in-test-only `SourceAdapter` implementation alongside `DemoFileAdapter`.

### Pipeline (`pipeline.py`)

One `IngestionRun` row per invocation. For each extracted record: compute
a canonical-JSON sha256 checksum (`checksum.py`), skip if `(sourceId,
checksum)` already has a `RawSourceRecord` (idempotent — the exact same
payload from the exact same source is never re-validated or re-published);
otherwise validate against the matching Pydantic schema
(`RAW_RECORD_SCHEMAS`), writing status `VALIDATED` or `QUARANTINED` (with
the Pydantic error, JSON-safely rendered — see "Bugs found" below) either
way. Validated records are normalized and published inside the same
run: teams and players first (players go through identity reconciliation
before anything referencing them), then season stats/ADP/news
signals/override seeds, each looked up by the now-resolved player.
Publishing to `RawSourceRecord.status = PUBLISHED` only happens for
records that successfully reach a normalized table — a validated record
whose player identity is still unresolved (`CANDIDATE`) stays at
`VALIDATED`, not `PUBLISHED`, so it is automatically retried on any future
run once an admin resolves the identity (validated-but-unpublished records
are never checksum-skipped on a later run the way already-published ones
are).

### Identity reconciliation (`identity.py` + `pipeline.py`)

Two-stage, per BUILD_SPEC.md section 7.2:

1. **Provider ID** — if `(sourceId, externalId)` was already `CONFIRMED`
   on a prior run, reuse that `playerId` (the idempotency fast path).
2. **Name + DOB** (secondary evidence, only reached for a genuinely new
   `(sourceId, externalId)` pair) — `rapidfuzz.fuzz.token_sort_ratio` on
   normalized names, +5 confidence points on an exact DOB match, against
   two documented thresholds (`CANDIDATE_THRESHOLD = 75`,
   `CONFIRM_THRESHOLD = 92`): below 75, treated as a genuinely new player
   (no plausible match) and published immediately; 75–92, written as a
   `CANDIDATE` `PlayerExternalIdentity` row (`playerId` left null — the
   reviewable unresolved state) and _not_ published this run; 92+,
   auto-linked as `CONFIRMED` via `NAME_DOB`.

**Bug found and fixed during verification:** the first working version
compared every new player against _every_ existing player, including
ones created moments earlier in the _same run from the same source_.
Since a single source's external keys are already guaranteed-unique
identifiers, this produced spurious `CANDIDATE`s for genuinely distinct
real players who happen to share common name patterns — confirmed at
model card time against the real demo roster: Nikola Jokić vs. Nikola
Jović, Mikal Bridges vs. Miles Bridges, real-life twins Amen and Ausar
Thompson, several different "Jalen ___" players. Fixed by excluding
players created earlier in the _same run_ from the name/DOB candidate
pool (`_publish_players`'s `created_this_run` set, threaded into
`_load_existing_players(exclude_ids=...)`); cross-run and cross-source
matching against those same players still works correctly (see
`test_cross_source_similar_name_creates_reviewable_candidate` and
`test_dob_match_plus_similar_name_confirms_instead_of_flagging`, which
construct exactly that scenario across two separate `run_ingestion` calls
with two different `_StaticAdapter` sources).

**Second bug found and fixed:** `error.errors(include_url=False)` can
embed the original raised `ValueError` instance inside `ctx` for a
`@model_validator`, which is not JSON-serializable — inserting it into
`RawSourceRecord.validationErrors` (`JSONB`) crashed with a `TypeError`
deep inside the asyncpg driver's parameter binding. Fixed by round-
tripping through Pydantic's own `error.json()` (`json.loads(error.json(...))`),
which is guaranteed JSON-safe.

### Cross-language write access

`db.py`'s SQLAlchemy Core tables target Prisma's exact schema (ADR 0005).
`pipeline.py` uses a plain `AsyncConnection` passed in by the caller
(`cli.py` wraps one call in `engine.begin()` for one all-or-nothing
transaction per run) rather than owning its own engine/transaction
lifecycle, which is what lets the integration tests exercise the same
production code path inside a rolled-back transaction.

### Local/CI invocation

`uv run python -m app.ingestion.cli` (Typer collapses to the single
`demo` command when it's the only one registered — this will require the
explicit `demo` subcommand name once Slice D adds a `project` command)
runs the full pipeline against `DemoFileAdapter`, requiring only
`DATABASE_URL`/`SERVICE_SECRET` — no server process, no paid
infrastructure (BUILD_SPEC.md section 13). Verified end-to-end against
local Postgres: fresh run publishes all 230 demo players (0 quarantined,
0 unresolved after the collision fix); re-running is fully idempotent
(same 1380 raw records, same 230 players, a new `IngestionRun` row
recording the no-op attempt for audit history, zero duplication).

### Test-environment wiring

`tests/ingestion/test_pipeline_integration.py` needs a real, migrated
Postgres and is not run by a bare `uv run pytest` locally — the fixture
skips cleanly (`pytest.skip`) on any connection failure, which is the
_default_ local state, because `tests/conftest.py`'s default
`DATABASE_URL` deliberately points somewhere unreachable (`test_health.py`
relies on that to exercise the degraded-`/health/ready` path). Run these
tests explicitly: `DATABASE_URL=postgresql://draftcourt:draftcourt@localhost:55432/draftcourt
uv run pytest tests/ingestion/`. **Follow-up required in Slice J**: the
`analytics` CI job currently has no Postgres service container or
migration step at all (only the `web` job's Postgres service exists,
on port 5432) — these tests silently skip in CI today. Wiring a migrated
Postgres service into the `analytics` job is required before this
coverage is real in CI, not just locally.

## Consequences

- Every Phase 1 raw payload's lineage is traceable: `RawSourceRecord` ->
  `IngestionRun` -> `DataSource`, with a checksum and trace ID at every
  step, satisfying "every externally sourced fact must carry source,
  source record ID, fetched time" for whichever fields flow from this
  pipeline (season stats, ADP, signals).
- The demo dataset publishes cleanly end-to-end on a fresh database; a
  genuine collision/candidate-review scenario is exercised only in tests
  (`test_pipeline_integration.py::TestUnresolvedIdentity`), not baked into
  the committed demo data — it would otherwise mean permanently
  unpublishing real players from the recruiter-facing demo pool for a
  fixture that exists purely to prove the reconciliation code path works.
