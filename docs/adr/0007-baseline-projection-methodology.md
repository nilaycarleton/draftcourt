# ADR 0007: Baseline projection methodology and atomic publish

- Status: accepted
- Date: 2026-08-21
- Phase: 1 — data, projections baseline, player experience

## Context

BUILD_SPEC.md section 7.3 lists a versioned weighted-historical baseline
as the first of four progressively more sophisticated models, and section
0/7.3 explicitly excludes Elastic Net, LightGBM, Optuna, and the trained
ensemble from this phase ("Do not implement... in this phase. Those
belong to Phase 4"). Section 7.2 requires publishing to be atomic and
every run to be reproducible and preserved for later evaluation.

## Decision

### Why a hand-specified formula, not a fit model

The baseline's weights (season-recency weights, age-curve breakpoints,
college-translation factors, interval-width multipliers) are documented
constants, not fit to data — there is no training step. This matches
BUILD_SPEC.md's own framing of the baseline as a benchmark a _real_
trained model must beat (section 7.4), and keeps the model fully
explainable: every number in a projection traces to a formula a human can
read in `app/pipelines/baseline.py`, which matters more in Phase 1 (no
real historical data to fit against yet) than marginal accuracy would.

### Per-game rates, never totals

Every historical stat is converted to a per-game rate
(`total / games_played`) before weighting. A season cut short by injury
would otherwise silently drag a per-game-equivalent average down for
reasons unrelated to the player's actual per-game output — an accuracy
bug, not a style choice.

### `ProjectedLine` reuse

`app.domain.contracts.ProjectedLine` (Phase 0, mirrored TS/Python via the
existing JSON-Schema fixture-testing pipeline) is the baseline's direct
output type — not a parallel shape translated at a boundary. This means
the API layer (Slice E) and the cross-language contract tests already
exercise the exact shape the baseline produces.

### Signals shape the input; overrides correct the output

`ROLE_UP`/`ROLE_DOWN`/`STARTER_CHANGE` signals feed
`PlayerContext.active_role_signal_impact`, which is applied _inside_ the
baseline computation (it scales the weighted rate) — this models a signal
as new information about the player's likely role, same as any other
input. `ProjectionOverride`s are applied _after_ the baseline runs
(`app/pipelines/adjustments.py::apply_overrides`), directly rewriting a
specific stat, because an override represents an explicit admin
correction to the model's conclusion, not new input evidence — the
distinction matters for the audit trail: overrides are individually
recorded (`AppliedAdjustment`, with `before`/`after`/`rationale`) exactly
because they are corrections a human is accountable for, while signal
influence is just part of normal model computation.

**Bug found during verification**: `apply_overrides` originally matched
override `stat` keys (camelCase — `"minutesPerGame"`, `"threePm"`, the
convention used everywhere else a stat is named) against
`ProjectedLine.model_dump()`'s output, which defaults to **snake_case**
Python field names (`minutes_per_game`, `three_pm`). Every single-word
stat (`pts`, `reb`, ...) happened to match by coincidence, masking the bug
until a dedicated regression test
(`test_camel_case_stat_key_is_correctly_matched`) exercised a
multi-word stat. Fixed by dumping `by_alias=True` everywhere a
`ProjectedLine` is converted back to a plain dict for stat-keyed lookup
(`adjustments.py`, `run.py`).

### `overallRank`: an interim definition, not the recommendation engine

BUILD_SPEC.md's player API requires sorting/filtering by "internal rank"
in Phase 1, but the real roster/league-aware recommendation engine
(section 6) is Phase 2+ and needs league/draft context that doesn't exist
yet. `app/pipelines/run.py::_assign_overall_ranks` computes a standard
9-category z-score composite (PTS/REB/AST/STL/BLK/3PM/FG%/FT%/TOV,
percentages volume-aware per section 6.2) across each run's own player
pool — a real, defensible ranking method, but explicitly documented
everywhere it's used as _not_ the Phase 2 engine.

### Atomic publish mechanism

`ProjectionRun.isCurrent` is guarded by a partial unique index
(`projection_runs_one_current_per_season`, added in ADR 0005's migration).
`publish_baseline_run` writes every `PlayerProjection` row, then — inside
the same transaction — unsets the previous current run and sets the new
one. Postgres itself rejects a transaction that would ever leave two
current rows for one season, so "atomic" isn't just a convention here; a
crash mid-publish leaves either the old run current or the new one, never
neither. Verified end-to-end:
`tests/pipelines/test_run_integration.py::TestPublishBaselineRun::
test_second_run_supersedes_first_atomically` (history preserved, exactly
one current run) and `test_reproducible_on_unchanged_data` (identical
projected values across two runs on unchanged data).

### Naive vs. timezone-aware datetimes

**Bug found during verification**: the first working version of
`publish_baseline_run` used `datetime.now()` (naive) as the "as of" time
for signal/override activity checks, compared against `effectiveAt`/
`expiresAt` values read back from Postgres `timestamptz` columns — which
asyncpg returns as timezone-aware. Comparing naive and aware datetimes
raises `TypeError` in Python. Fixed by using `datetime.now(UTC)`.
`app.ingestion.pipeline`'s existing naive `datetime.now()` calls for
insert-only timestamp columns were left as-is (Postgres accepts a naive
value into a `timestamptz` column without error, assuming the session
timezone — verified working in that module's tests); the bug only
surfaces when two Python datetimes are compared directly, which
`app.pipelines.run` newly introduced.

### Evaluation methodology

`app/pipelines/evaluation.py` implements a **time-ordered** backtest
(BUILD_SPEC.md section 16.4: "Never use random temporal splits"): players
with all 3 demo NBA seasons on record have their oldest two seasons train
the projection, compared against the third (held out, never passed to
`project_player`). Rookies and (in this dataset) unsigned players have no
qualifying 3-season history and are excluded from the backtest by
construction — reported as an explicit `not_evaluable_counts`, not
silently dropped. See `models/baseline-v1/evaluation-report.md` for
results and `models/baseline-v1/model-card.md`'s "Known limitations" for
what the numbers do and don't show (notably: the heuristic 80% interval
measured well below 80% coverage on this benchmark, reported honestly
rather than adjusted to look better).

## Consequences

- Phase 4's trained ensemble has a concrete, reproducible number to beat
  (fantasy-points MAE, Spearman correlation) before BUILD_SPEC.md section
  7.4's promotion gate lets it replace this model.
- `overallRank`'s definition must be revisited (and every place that
  labels it "interim" updated) once Phase 2's real recommendation engine
  ships — tracked here so that future work doesn't have to rediscover why
  a z-score composite exists in an analytics-service module that has
  nothing else to do with league scoring.
- The heuristic-interval limitation is a known, documented target for
  Phase 4 calibration work, not a Phase 1 defect to chase further right
  now — BUILD_SPEC.md's own bar for Phase 1 is a clearly labeled
  heuristic, which this is.
