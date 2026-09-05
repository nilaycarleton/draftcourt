# Recommendation engine — Phase 2 implementation

Formulas follow `BUILD_SPEC.md` sections 6.1–6.9 exactly; the canonical
implementation is `packages/domain/src/recommendation.ts` (pure, no
framework/database/LLM) with the server wrapper in
`apps/web/lib/server/recommendations.ts`. Golden tests:
`packages/domain/src/recommendation.test.ts`.

## Reproducibility

Canonical JSON (recursively sorted object keys; arrays order-stable) →
synchronous SHA-256 → hex `inputChecksum`, stored on every
`RecommendationSnapshot` with engine + model versions. Simulation seeds derive
from the checksum plus an explicit per-draft seed — never wall-clock time.
The same snapshot and seed produce byte-identical output on every Node
platform (property-tested).

## Worked example — points league

League rules: PTS ×1, REB ×1.2, AST ×1.5, TOV ×−1.

Player X projects 100 GP-adjusted totals of 1800 pts / 700 reb / 400 ast /
160 tov over 70 games:

```
seasonFantasyPoints = 1800×1 + 700×1.2 + 400×1.5 − 160×1 = 3140
perGame             = 3140 / 70 ≈ 44.9
production          = 0.65 × percentile(perGameFP) + 0.35 × percentile(seasonFP)
```

Percentiles are taken within the current eligible pool after winsorizing at
the 2nd/98th percentiles.

## Worked example — category leagues

Counting categories: per-game value × reliability √(games/82), sign-flipped
for LOWER_BETTER (TOV). Punts contribute exactly zero.

Percentage categories are volume-aware and never averaged:

```
fgImpact = FGM/game − poolBaselineFG% × FGA/game
ftImpact = FTM/game − poolBaselineFT% × FTA/game
z        = (impact − mean(impact_pool)) / sd(impact_pool)
```

A 65% shooter on 2 attempts/game contributes LESS than a 58% big on
12 attempts — by construction.

Roster need simulates adding the candidate: required-slot coverage gain plus,
for categories, a logistic win-probability against a replacement-built
baseline with diminishing returns decaying toward the 0.85 ceiling.

## Availability & urgency

250 seeded Monte Carlo runs (live path; 2,000 offline) simulate every
intervening pick as a softmax over ADP attractiveness, projected utility and a
versioned tendency vector updated from observed real picks in this draft.
`availabilityNextPick` = fraction of runs where the player survives to the
user's next selection; urgency `1 − availability` acts as the sub-one-point
tie-breaker. The top-20 candidates get a shallow two-user-pick lookahead whose
contribution is capped at 10% of the final score.

## Final score, labels, explanations

```
base      = Σ weight_i × normalizedComponent_i     (reciprocal-rank weights)
rawScore  = 100 × clamp(base + 0.10 × lookaheadBonus, 0, 1)
draftScore= round(rawScore, 1)
```

Ties: production → scarcity → adpValue → stable player ID. Labels are pool-
relative: Best Overall (production), Best Fit (scarcity+need), Best Value
(positive ADP gap), Highest Upside, Safest Pick (safety+consistency).
Explanations use deterministic templates citing the two largest positive
contributions and the largest material caveat — never generated prose.

## Personalization (Phase 3B — immutable preference snapshots)

Engine version `phase3-preferences-1.0.0`. Every started draft carries a
self-contained `DraftPreferenceSnapshot` (ADR 0012) captured atomically in the
start transaction; recommendations read ONLY that snapshot. Its projection
enters the canonical input as one optional `preferences` key — absent for
pre-3B drafts, so Phase 2 checksums and payloads stay byte-identical; present
snapshots change the checksum, which is exactly what separates cache entries.

When preferences exist (every modulation short-circuits at its neutral value
so defaults reproduce the legacy arithmetic):

| Input                     | Formula                                                                                                                                            | Bounds                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| factor weights            | snapshot weights replace reciprocal-rank defaults                                                                                                  | Σ = 1 ± 1e-6               |
| riskTolerance r           | risk' = clamp01(0.5 + (risk−0.5)·2(1−r)) — low tolerance amplifies safety differences                                                              | [0,1]; r=0.5 identity      |
| upsidePriority u          | upside' = clamp01(0.5+(upside−0.5)·2u)                                                                                                             | [0,1]; u=0.5 identity      |
| youthBias y               | age' = clamp01(0.5+(age−0.5)(1+2y)); y<0 favors veterans; redraft stays neutral                                                                    | [0,1]                      |
| roleMinutesPriority m     | role' = wSec·roleSec + (1−wSec)·min(1,mpg/36), wSec = 0.4+0.6m                                                                                     | m=0.5 ⇒ legacy 0.7/0.3 mix |
| position priorities       | max priority among eligible positions                                                                                                              | [0,1] term                 |
| category priorities       | rankNormalize(Σ weight·perGameStat); FG%/FT% via volume-aware z-map; league scoring rules never altered; punts contribute 0 and are never inferred | [0,1] term                 |
| FAVORITE / TARGET         | +                                                                                                                                                  | m                          | / +0.75                   | m      |     | ≤ 1  |
| DISLIKED / AVOID (severe) | −                                                                                                                                                  | m                          | / −max(0.5,               | m      | )   | ≥ −1 |
| team preferences          | ±                                                                                                                                                  | m                          | via the player's NBA team | [−1,1] |
| custom ranks              | clamp(((n+1)/2 − rank)/24, −1, 1), n = ranked players; league scope overrides global upstream                                                      | monotone in rank           |

The signed total clamps to [-1, 1]; its weighted contribution is HARD-CAPPED
at ±10 score points even with the preference slider at 100%. Hard avoids
(EXCLUDE mode) remove players like any eligibility rule; if that would leave
fewer than three legal candidates the engine falls back to severe penalties
and labels affected entries with an actionable warning — an avoid list can
never silently empty the board. Targets/favorites cannot bypass legality.
Schedule stays a zero-weight component until playoff-week game data exists;
enabling it today yields an honestly-labeled neutral signal.

Warnings (`warnings[]`, omitted when empty): top-3 entries boosted by
targets/favorites sitting >24 picks beyond market ADP with material positive
contribution get a reach warning; avoid-fallback entries get the fallback
warning. The preference component's explanation reports actual points added or
subtracted rather than a percentile. Same-team stacking remains unpenalized by
construction.

## Performance

Targets (§6.9): warm p95 < 300 ms, cold p95 < 800 ms on the 12×16×600
fixture. Latest measured results live in
`docs/benchmarks/recommendations-latest.json`; preference-scenario results
(defaults/balanced/extreme/large-lists) in `docs/benchmarks/preferences-latest.json`.
