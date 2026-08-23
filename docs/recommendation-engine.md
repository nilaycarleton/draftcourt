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

## Performance

Targets (§6.9): warm p95 < 300 ms, cold p95 < 800 ms on the 12×16×600
fixture. Latest measured results live in
`docs/benchmarks/recommendations-latest.json`.
