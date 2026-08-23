# Model card: `baseline-weighted-historical` v1.0.0

Status: Phase 1 baseline. This is DraftCourt's first projection model —
an exponentially weighted historical average with bounded adjustments,
explicitly **not** the trained Elastic Net/LightGBM/ensemble that
BUILD_SPEC.md section 7.3 reserves for Phase 4. Its purpose in Phase 1 is
to prove the complete data → projection → publish → serve pipeline
end-to-end with a transparent, fully-explainable method, and to give
Phase 4's trained ensemble a real benchmark it must beat before it can
replace this model (BUILD_SPEC.md section 7.4: "Select the ensemble only
if it beats the weighted baseline... Otherwise publish the simpler
model").

## Intended use

Season-long fantasy basketball draft/roster decision support for the
2026-27 NBA season, using **entirely synthetic demo data** in this
deployment (see "Data" below) — not a real production forecasting
service. Every consumer (API, UI) is required to label output with the
model version, run ID, and a demo-data flag.

## Methodology

Implementation: `services/analytics/app/pipelines/baseline.py`. Full
architectural rationale: `docs/adr/0007-baseline-projection-methodology.md`.

1. **Inputs**: up to the 3 most recent `PlayerSeasonStat` rows (NBA
   scope) per player, the player's date of birth, availability status,
   unsigned flag, and rookie flag, plus active `PlayerNewsSignal`
   (`ROLE_UP`/`ROLE_DOWN`/`STARTER_CHANGE`) and `ProjectionOverride` rows.
2. **Weighting**: fixed exponential weights by season count —
   `SEASON_WEIGHTS = {1: (1.0,), 2: (0.35, 0.65), 3: (0.15, 0.30, 0.55)}`
   (oldest to newest) — applied to each stat's **per-game rate**
   (`season total / games played that season`), never to raw totals.
3. **Age curve**: a bounded, position-agnostic multiplier — neutral
   21–29, a small growth bonus below that, a capped gradual decline
   above 29 (floor 0.80×). Exact breakpoints/formula in `baseline.py`.
4. **Availability**: projected games and an `injuryRisk` score come from
   the player's historical games-missed ratio, with a further reduction
   and risk increase when `status == INJURED`, and a much larger
   reduction for `UNSIGNED` players.
5. **Role adjustment**: the confidence-weighted sum of active
   `ROLE_UP`/`ROLE_DOWN`/`STARTER_CHANGE` signal impacts
   (`app/pipelines/adjustments.py::role_signal_impact`, bounded to
   [-1, 1]) scales the weighted base rate by up to ±20%.
6. **Admin overrides**: applied _after_ the baseline, as an explicit,
   audited final layer (`app/pipelines/adjustments.py::apply_overrides`)
   — never silently blended into the model's own weighting.
7. **Percentages**: FG%/FT% are **never** computed, stored, or averaged
   here — every consumer derives them from `sum(fgm)/sum(fga)` and
   `sum(ftm)/sum(fta)` at read time.
8. **Rookie/insufficient-history fallback**: zero-NBA-history players use
   a single `COLLEGE`-scope stat line run through documented, conservative
   per-stat translation factors (`COLLEGE_TRANSLATION_FACTORS`, e.g.
   0.55× for scoring rate); a player with no data at all gets a fixed,
   deliberately modest replacement-level prior rather than a crash or a
   null projection.
9. **Uncertainty**: `lower80`/`upper80` are a **heuristic** band — a
   fixed fraction of the projected value, widened ~1.35–2× for thin
   history/rookies/unsigned players. This is explicitly _not_ a
   statistically calibrated interval (BUILD_SPEC.md section 7.1 permits
   "calibrated **or clearly labeled heuristic** 80% intervals" — this
   model uses the latter). See "Known limitations" for the measured
   coverage.
10. **`consistency`**: season-to-season scoring stability (coefficient of
    variation across available NBA seasons) — a coarser proxy than a true
    game-level consistency score, since Phase 1's data model stores season
    totals, not individual game logs.
11. **`roleSecurity`**: derived from the most recent season's minutes per
    game plus the active role-signal impact.
12. **`overallRank`**: a standard-9-category z-score composite computed
    across the current run's own player pool (`app/pipelines/run.py`) —
    an interim Phase 1 substitute for the real roster/league-aware
    recommendation engine (Phase 2+), documented as such everywhere it
    appears.

## Determinism and publishing

`project_player` is a pure function: identical `(player history, context,
active signals/overrides)` always produces identical output — verified by
`tests/pipelines/test_baseline.py::TestProjectPlayerVeteran::
test_reproducibility_identical_inputs_identical_output` and, end-to-end
against a real database, `tests/pipelines/test_run_integration.py::
TestPublishBaselineRun::test_reproducible_on_unchanged_data`. Publishing a
run is atomic: `ProjectionRun.isCurrent` is guarded by a partial unique
index (`projection_runs_one_current_per_season`), flipped inside the same
transaction that writes every `PlayerProjection` row, so a reader never
observes a partially-published run (verified by
`test_second_run_supersedes_first_atomically`). Every published run is
retained — never deleted or overwritten — for later evaluation.

## Data

**Training/evaluation data is 100% synthetic.** `data/demo/*.json`
(generator: `data/demo/generate.py`) pairs real, public NBA player/team/
position facts with entirely fabricated statistics — see
`data/attribution/demo-dataset.md` for the full disclosure, including why
no real player is ever assigned `SUSPENDED`/`UNSIGNED` status. This model
has never seen real NBA statistics.

- Training window (as recorded on `ProjectionModel`): seasons `2023-24`
  through `2025-26`.
- Data cutoff for a given run: that run's `ProjectionRun.dataCutoff`
  (the wall-clock time the run started).
- Feature/schema checksum: `ProjectionModel.featureSchemaChecksum`, a
  sha256 of the model key/version/algorithm triple — changes whenever the
  methodology changes, giving every published run a verifiable link back
  to the exact code that produced it.

## Evaluation

Full results: `models/baseline-v1/evaluation-report.md` and
`metrics.json`, generated by `uv run python -m app.pipelines.cli
evaluate`. Summary from the most recent run against the demo dataset (204
of 230 players evaluable — see limitations):

- Fantasy-points MAE (standard scoring, this benchmark only): **3.58**
- Spearman rank correlation: **0.966**
- Games-played MAE: **8.16**
- Heuristic-interval coverage: **46.9%** (see limitations below)

**This is a benchmark against DraftCourt's own fabricated demo history,
not a measurement of real-world NBA prediction accuracy**, and must never
be cited as one.

## Known limitations

1. **Heuristic intervals under-cover on this benchmark.** The `lower80`/
   `upper80` band was designed as a simple, clearly-labeled heuristic
   (BUILD_SPEC.md explicitly permits this in Phase 1), not fit to any
   held-out data. Measured coverage (46.9%) is well below the nominal
   80% target. This is reported transparently rather than adjusted to
   look better on this specific fixture — genuine calibration is Phase 4+
   work once a trained model with real predictive-distribution estimates
   exists. Treat the current interval as "plausible range," not a
   statistical guarantee.
2. **Rookies and unsigned players are not covered by the held-out-season
   backtest** (0 evaluable cases each) — the backtest methodology
   requires 3 prior NBA seasons to hold one out, which these cohorts
   structurally never have. Their fallback code paths are covered by
   direct unit tests (`tests/pipelines/test_baseline.py::TestFallbacks`)
   instead.
3. **`consistency` is a season-level, not game-level, proxy** — Phase 1's
   data model stores season totals rather than individual game logs.
4. **No positional or league context.** `overallRank` is a single
   context-free ranking; it is not the real roster-aware, league-scoring-
   aware recommendation engine (Phase 2+ per BUILD_SPEC.md section 6).
5. **Entirely synthetic training/evaluation data** (see "Data" above) —
   every number in the evaluation report is fabricated.

## Rollback

To roll back to a prior published run: set the target `ProjectionModel`
row's `status` to `ARCHIVED` if retiring the model entirely, and update
whichever prior `ProjectionRun` should become current by re-running the
same atomic-publish transaction pattern (flip the current run's
`isCurrent` to `false`, the target historical run's to `true`) — never by
deleting a run. See `docs/runbooks/failed-publish-rollback.md`.

## Licensing

Model code: same license as the rest of the DraftCourt repository. No
third-party model weights or datasets are used — this model is trained
(in the sense of "its fixed weights are hand-specified," not
gradient-fit) entirely from the formulas documented above.
