# Baseline projection evaluation report

- Model: `baseline-weighted-historical` @ `1.0.0`
- Cutoff season (held out): `2025-26`
- Generated: 2026-08-21T19:33:52.390182+00:00
- Total players in dataset: 230

> **This is a benchmark against DraftCourt's own fabricated demo season history (see data/attribution/demo-dataset.md), not a measurement of real-world NBA prediction accuracy.** Every statistic below is fabricated; the methodology (time-ordered split, leakage prevention, subgroup breakdown) is real and reused unchanged once real historical data is available.

## Methodology

Players with all 3 demo NBA seasons on record have their oldest two seasons fed to the baseline as training input; the projection is compared against the (synthetic) third season, which the model never sees. This is a rolling time-ordered split, never a random one — see `app/pipelines/evaluation.py` and `app/pipelines/report.py::build_eval_cases`.

## Subgroup results

| Subgroup    |   n | Fantasy pts MAE | Games MAE | Spearman ρ | Interval coverage |
| ----------- | --: | --------------: | --------: | ---------: | ----------------: |
| all         | 204 |            3.58 |      8.16 |      0.966 |             46.9% |
| veteran     | 198 |            3.56 |      7.62 |      0.967 |             47.1% |
| injured     |   6 |            4.41 |     26.17 |      0.943 |             40.9% |
| unsigned    |   0 |            0.00 |      0.00 |        n/a |              0.0% |
| rookie      |   0 |            0.00 |      0.00 |        n/a |              0.0% |
| low_minutes |  19 |            2.54 |      8.63 |      0.946 |             47.4% |

## Minutes-weighted per-stat MAE (all players)

| Stat    | MAE (per game) |
| ------- | -------------: |
| pts     |          1.618 |
| reb     |          1.379 |
| ast     |          1.189 |
| stl     |          0.350 |
| blk     |          0.363 |
| tov     |          0.742 |
| fgm     |          0.809 |
| fga     |          2.010 |
| ftm     |          0.615 |
| fta     |          0.857 |
| threePm |          0.542 |

## Evaluation limitations

- `rookie` and `unsigned` subgroups have `n = 0` / `0` respectively: this backtest methodology requires 3 full prior NBA seasons to hold one out, which rookies and (in this dataset) unsigned players never have by construction. Their fallback paths are unit-tested directly (see `tests/pipelines/test_baseline.py`) but not covered by this held-out-season backtest.
- `interval_coverage` measures whether the _heuristic_ `lower80`/`upper80` band contains the actual value — it is a sanity check, not evidence of true 80% statistical calibration (see `app/pipelines/baseline.py`'s module docstring).
- All figures are computed against synthetic data and must not be read as a claim about real 2026-27 NBA prediction accuracy.
