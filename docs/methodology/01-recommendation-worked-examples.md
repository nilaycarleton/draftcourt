# Recommendation worked examples: scarcity, ADP value, preference cap, schedule

Companion to `docs/recommendation-engine.md`, which holds the
points-league and category-league production walkthroughs — those are
linked, not duplicated (see §5). Every number below is an
**illustrative fixture** crafted to show the arithmetic, not output from
a real run. Implementation: `packages/domain/src/recommendation.ts`
(engine `phase3-preferences-1.0.0`).

## 1. Scarcity (marginal value above positional replacement)

Rule (ADR 0010): each candidate's scarcity is its best marginal utility
above the replacement level across its eligible assignments; UTIL/BENCH
assignments carry a ×0.7 multiplier; bench/UTIL capacity counts but
cannot fully erase starter scarcity.

Illustrative fixture — 10-team league, candidate G-7 eligible at PG/SG,
utility scale 0–1:

```
replacement PG (last starter filled) utility: 0.61
replacement SG (last starter filled) utility: 0.55
G-7 projected utility as PG: 0.74 → marginal 0.74 − 0.61 = 0.13
G-7 projected utility as SG: 0.70 → marginal 0.70 − 0.55 = 0.15
best eligible starter assignment: SG → scarcity_raw = 0.15
same player considered for UTIL only: 0.15 × 0.7 = 0.105
scarcity component: percentile(scarcity_raw) within eligible pool
```

A center with only a +0.04 marginal over a deep replacement pool scores
lower than a guard with +0.15 over a thin one, even if the center's raw
production is higher — that is the intended positional-scarcity effect.

## 2. ADP-consensus value (bounded gap percentile)

Rule (ADR 0010): `adpValue` is a bounded gap percentile, with LOW
confidence when the consensus rests on fewer than 2 sources.

Illustrative fixture:

```
C-12 consensus ADP: 48.0 (sourcesCount = 2, dispersion 3.1)
current overall pick: 60
gap = 48 − 60 = −12  (player available 12 picks past market)
adpValue = percentile-bounded f(gap) → high positive, confidence MEDIUM-or-better
contrast: same gap with sourcesCount = 1 → same direction, confidence LOW
```

No multi-platform consensus is claimed: the only observation sets are
the two synthetic demo sources (`demo-adp-source-a/b`), so any
"consensus" here is consensus between two fabricated feeds
(`docs/data-sources.md`; `docs/limitations.md`).

## 3. Preference cap (±10 score points, hard)

Rule (`docs/recommendation-engine.md` § Personalization; ADR 0012):
signed list/team/rank terms sum into the single `preference` component
clamped to [−1, 1], and its weighted contribution is hard-capped at ±10
final score points even with the preference weight at 100%.

Illustrative fixture:

```
favorite magnitude m = +0.8, target +0.75, team +0.3 → signed total +1.85
clamp to [+1.0] → preference component = 1.0
preference factor weight = 1.00 (slider at max)
uncapped contribution would be: 1.0 × 100 = +100 points
capped contribution: +10.0 points (hard cap binds)
```

Hard avoids (`EXCLUDE`) remove players like any eligibility rule; if
exclusion would leave fewer than three legal candidates the engine falls
back to severe penalties and labels affected entries with an actionable
warning — an avoid list can never silently empty the board.

## 4. Schedule (honestly neutral until data exists)

Rule: schedule is a zero-weight component until playoff-week game data
exists; enabling it today yields an honestly-labeled neutral signal
(`docs/recommendation-engine.md` § Personalization).

Illustrative fixture:

```
schedule.enabled = true, playoffWeeks = [22, 23, 24]
playoff game-count data: absent
schedule component = 0.0 for every candidate, labeled neutral
effect on ranking: none (contribution 0 × any weight = 0)
```

Do not present schedule as influencing any current recommendation.

## 5. Points / category production examples (linked, not duplicated)

- Points-league blend (`0.65 × percentile(perGameFP) + 0.35 ×
percentile(seasonFP)`, Player X fixture): `docs/recommendation-engine.md`
  § "Worked example — points league".
- Category reliability (`√(games/82)`), sign flips, volume-aware
  `fgImpact`/`ftImpact` z-scores, logistic roster-need with the 0.85
  ceiling: `docs/recommendation-engine.md` § "Worked example — category
  leagues" and § "Availability & urgency".

## Sources

- `docs/recommendation-engine.md`
- `docs/adr/0010-phase2-draft-core-and-recommendations.md`
- `docs/adr/0012-immutable-preference-snapshots.md`
- `packages/domain/src/recommendation.ts`
- `packages/domain/src/recommendation.test.ts`
- `packages/domain/src/recommendation-preferences.test.ts`
- `docs/data-sources.md`
- `docs/limitations.md`
