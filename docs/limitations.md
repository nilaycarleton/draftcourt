# Limitations (honest claims)

Single page of what DraftCourt is not. Every portfolio claim must stay
inside these bounds.

## Synthetic demo data

All statistics are fabricated. Player/team/position names are real
public facts; every stat line, ADP observation, news signal, and
projection is synthetic (`data/attribution/demo-dataset.md`,
`docs/data-sources.md`, `models/baseline-v1/model-card.md` "Data").
The model "has never seen real NBA statistics," and the evaluation is "a
benchmark against DraftCourt's own fabricated demo history, not a
measurement of real-world NBA prediction accuracy"
(`models/baseline-v1/evaluation-report.md:8`).

## Frozen baseline numbers (synthetic-data qualified)

From `models/baseline-v1/evaluation-report.md` (cutoff season held out:
`2025-26`; 204 of 230 players evaluable):

- Fantasy-points MAE (standard scoring, this benchmark only): **3.58**
- Spearman rank correlation: **0.966**
- Games-played MAE: **8.16**
- Heuristic-interval coverage: **46.9% vs the nominal 80%** — the
  `lower80`/`upper80` band is a clearly-labeled heuristic, not a
  calibrated interval, and it under-covers on this fixture. Treat it as
  "plausible range," not a statistical guarantee
  (`models/baseline-v1/model-card.md` "Known limitations" §1).

Rookie and unsigned cohorts have 0 evaluable backtest cases (structural:
the hold-one-out method needs 3 prior NBA seasons); their fallbacks are
unit-tested, not backtested (`evaluation-report.md` "Evaluation
limitations").

## Single-demo ADP

"Consensus" ADP here is agreement between **two synthetic observation
sets from the same file adapter** (`demo-adp-source-a`,
`demo-adp-source-b`), not multi-platform market consensus — which by
BUILD_SPEC §7.2 must not be claimed until at least two valid sources
exist. Engine confidence is LOW when `sourcesCount < 2` (ADR 0010).

## Free tier

Analytics cold starts may delay manual refreshes, scheduled jobs may be
limited, and free databases can suspend or cap usage (BUILD_SPEC §18.3;
`docs/architecture/05-deployment-topology.md`). No capacity, cold-start,
or availability numbers are claimed.

## No guarantee

Never use recommendation outcomes, grades, or simulated standings as a
claim of guaranteed fantasy success (BUILD_SPEC §19). The results UI
carries "This analysis is a projection, not a guarantee" in a `role=note`
near the grade, and simulated standings are labeled "vs
replacement-built opponent" (ADR 0015 D3–D4).

## Licensing and non-endorsement

Do not use NBA/team marks in DraftCourt branding or imply NBA
endorsement; team logos/player photos are contextual data subject to
provider rights with fallbacks; a licensing/trademark review and source
replacement are required before any public/commercial launch
(BUILD_SPEC §20). No third-party model weights or datasets are used
(`models/baseline-v1/model-card.md` "Licensing").

## Sources

- `data/attribution/demo-dataset.md`
- `docs/data-sources.md`
- `models/baseline-v1/model-card.md`
- `models/baseline-v1/evaluation-report.md`
- `docs/adr/0010-phase2-draft-core-and-recommendations.md`
- `docs/adr/0015-draft-analysis-and-history.md`
- `docs/architecture/05-deployment-topology.md`
- `docs/benchmarks/METHODOLOGY.md`
- `BUILD_SPEC.md` §7.2, §18.3, §19, §20
