"""Versioned weighted-historical baseline projection engine, per
BUILD_SPEC.md section 7.1/7.3. Produces `app.domain.contracts.ProjectedLine`
-shaped output from a player's normalized `PlayerSeasonStat` history —
direct reuse of the Phase 0 shared contract, not a parallel shape.

Methodology summary (full detail in models/baseline-v1/model-card.md):

1. Up to 3 prior NBA seasons are combined with fixed exponential weights
   (most recent season weighted highest — this *is* "recency" per section
   7.1; there is no separate recency step).
2. Every counting/shooting stat is weighted as a **per-game rate**
   (season total / games played that season), never as a raw total —
   otherwise a season cut short by injury would silently drag the average
   down for reasons unrelated to per-game production.
3. FG%/FT% are never computed or stored here at all — `fgm`/`fga`/`ftm`/
   `fta` are projected as their own per-game rates and every consumer
   (evaluation, API, UI) derives a percentage from
   `sum(fgm)/sum(fga)` at read time.
4. A bounded age-curve multiplier, a games/availability adjustment from
   real injury history plus `INJURED` status, and a role multiplier from
   active `ROLE_UP`/`ROLE_DOWN`/`STARTER_CHANGE` signals are applied on
   top of the weighted base rate.
5. Zero-NBA-history players (rookies) fall back to a single `COLLEGE`-
   scope stat line run through a documented, conservative translation
   factor, with deliberately widened uncertainty intervals. Unsigned
   players get reduced games/minutes priors and low `roleSecurity`.
6. Intervals (`lower80`/`upper80`) are an explicit **heuristic** band
   (a fixed fraction of the projected value, widened for rookies/unsigned/
   thin history) — not a statistically calibrated interval. Labeled as
   such everywhere it's surfaced; BUILD_SPEC.md section 7.1 permits
   "calibrated or clearly labeled heuristic 80% intervals."
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Literal

from app.domain.contracts import ProjectedLine

PROJECTION_SEASON = "2026-27"
# Nominal season-start date used only for age-curve computation.
PROJECTION_AS_OF = date(2026, 10, 1)

# Oldest -> newest, matching data.demo.generate's NBA_SEASONS order.
SEASON_WEIGHTS: dict[int, tuple[float, ...]] = {
    1: (1.0,),
    2: (0.35, 0.65),
    3: (0.15, 0.30, 0.55),
}

_STAT_KEYS = ("pts", "reb", "ast", "stl", "blk", "tov", "fgm", "fga", "ftm", "fta", "threePm")

# College-to-NBA per-game translation factors (conservative — competition
# level and role both drop for a debuting rookie). Applied only to the
# college fallback path, never to any NBA-scope data.
COLLEGE_TRANSLATION_FACTORS: dict[str, float] = {
    "minutesPerGame": 0.62,
    "pts": 0.55,
    "reb": 0.65,
    "ast": 0.60,
    "stl": 0.70,
    "blk": 0.70,
    "tov": 0.85,  # turnovers translate less favorably (harder to protect vs. NBA defenses)
    "fgm": 0.55,
    "fga": 0.60,
    "ftm": 0.55,
    "fta": 0.58,
    "threePm": 0.50,
}

# Heuristic-interval half-widths, as a fraction of the projected per-game
# value. Not statistically calibrated — see module docstring.
_BASE_INTERVAL_WIDTH = 0.20
_ROOKIE_INTERVAL_MULTIPLIER = 1.8
_UNSIGNED_INTERVAL_MULTIPLIER = 2.0
_THIN_HISTORY_INTERVAL_MULTIPLIER = 1.35  # exactly 1 NBA season on record
_MIN_SEASONS_FOR_CONSISTENCY = 2

# Age-curve breakpoints (years).
_AGE_GROWTH_FLOOR = 21
_AGE_PRIME_START = 24
_AGE_PRIME_END = 29
_AGE_DECLINE_FLOOR_YEAR = 36


@dataclass(frozen=True)
class SeasonStatLine:
    """One normalized `PlayerSeasonStat` row, minimal fields baseline.py
    needs (decoupled from the SQLAlchemy row shape for pure-function
    testability)."""

    season: str
    scope: Literal["NBA", "COLLEGE", "INTERNATIONAL"]
    games_played: int
    minutes_total: float
    pts: float
    reb: float
    ast: float
    stl: float
    blk: float
    tov: float
    fgm: float
    fga: float
    ftm: float
    fta: float
    three_pm: float

    def per_game(self) -> dict[str, float]:
        if self.games_played <= 0:
            return dict.fromkeys((*_STAT_KEYS, "minutesPerGame"), 0.0)
        return {
            "minutesPerGame": self.minutes_total / self.games_played,
            "pts": self.pts / self.games_played,
            "reb": self.reb / self.games_played,
            "ast": self.ast / self.games_played,
            "stl": self.stl / self.games_played,
            "blk": self.blk / self.games_played,
            "tov": self.tov / self.games_played,
            "fgm": self.fgm / self.games_played,
            "fga": self.fga / self.games_played,
            "ftm": self.ftm / self.games_played,
            "fta": self.fta / self.games_played,
            "threePm": self.three_pm / self.games_played,
        }


@dataclass(frozen=True)
class PlayerContext:
    """Non-stat inputs the baseline needs. `active_role_signal_impact` is
    the sum of active ROLE_UP/ROLE_DOWN/STARTER_CHANGE signal impacts
    (already filtered to active/non-expired by the caller — see
    `app.pipelines.adjustments`), bounded to [-1, 1]."""

    dob: date | None
    status: Literal["ACTIVE", "INJURED", "SUSPENDED", "UNSIGNED", "RETIRED"]
    unsigned: bool
    rookie: bool
    active_role_signal_impact: float = 0.0


def _age_at_projection(dob: date | None) -> float | None:
    if dob is None:
        return None
    days = (PROJECTION_AS_OF - dob).days
    return days / 365.25


def age_curve_multiplier(age: float | None) -> float:
    """Bounded, position-agnostic age curve (BUILD_SPEC.md section 6.5:
    "dynasty uses a position-agnostic learned age curve until enough data
    exists for positional curves" — Phase 1's baseline uses the same
    simple curve for redraft context too, since no dynasty-specific
    weighting exists yet). Neutral (1.0) through a plateau, mild
    growth below it, capped decline above it."""
    if age is None:
        return 1.0
    if age < _AGE_GROWTH_FLOOR:
        return 1.0
    if age < _AGE_PRIME_START:
        return 1.0 + 0.015 * (_AGE_PRIME_START - age)  # up to +4.5% growth approaching prime
    if age <= _AGE_PRIME_END:
        return 1.0  # prime plateau
    if age <= _AGE_DECLINE_FLOOR_YEAR:
        return max(0.80, 1.0 - 0.025 * (age - _AGE_PRIME_END))  # gradual decline
    return 0.80  # floor for very advanced age rather than an unbounded slide


def availability_multiplier(
    historical_games: list[int], status: str, *, unsigned: bool
) -> tuple[float, float]:
    """Returns `(projected_games, injury_risk)`. `injury_risk` is a
    bounded-[0,1] "positive risk" score (BUILD_SPEC.md section 6.5:
    convert to a positive safety score before weighting elsewhere — this
    function returns the raw risk; callers invert it where a safety score
    is needed)."""
    if unsigned:
        return 20.0, 0.55  # sparse/uncertain playing time, wide downside
    if not historical_games:
        return 55.0, 0.35  # no history at all (e.g. rookie NBA games) — moderate default risk

    avg_games = sum(historical_games) / len(historical_games)
    missed_ratio = max(0.0, 1.0 - avg_games / 82.0)
    base_risk = min(0.9, 0.10 + missed_ratio * 0.9)

    if status == "INJURED":
        projected_games = max(10.0, avg_games * 0.55)
        risk = min(0.95, base_risk + 0.30)
    else:
        projected_games = min(82.0, avg_games)
        risk = base_risk
    return round(projected_games, 1), round(risk, 3)


def _weighted_per_game(season_lines: list[SeasonStatLine]) -> dict[str, float]:
    """`season_lines` must already be ordered oldest -> newest and contain
    only NBA-scope rows. Weights come from `SEASON_WEIGHTS[len(season_lines)]`."""
    weights = SEASON_WEIGHTS[len(season_lines)]
    accum: dict[str, float] = dict.fromkeys((*_STAT_KEYS, "minutesPerGame"), 0.0)
    for line, weight in zip(season_lines, weights, strict=True):
        per_game = line.per_game()
        for key, value in per_game.items():
            accum[key] += value * weight
    return accum


def _college_fallback_per_game(college_line: SeasonStatLine) -> dict[str, float]:
    per_game = college_line.per_game()
    return {key: value * COLLEGE_TRANSLATION_FACTORS[key] for key, value in per_game.items()}


def _interval_multiplier(*, is_rookie: bool, is_unsigned: bool, season_count: int) -> float:
    if is_unsigned:
        return _UNSIGNED_INTERVAL_MULTIPLIER
    if is_rookie:
        return _ROOKIE_INTERVAL_MULTIPLIER
    if season_count <= 1:
        return _THIN_HISTORY_INTERVAL_MULTIPLIER
    return 1.0


def _consistency_score(season_lines: list[SeasonStatLine]) -> float:
    """Season-to-season stability of per-game scoring as a consistency
    proxy — Phase 1's data model has season totals, not game logs, so a
    true game-level coefficient of variation (BUILD_SPEC.md section 6.5's
    stated ideal) isn't computable; this is a documented, coarser
    substitute. Fewer than 2 NBA seasons on record defaults to a neutral
    0.5 (insufficient evidence either way)."""
    if len(season_lines) < _MIN_SEASONS_FOR_CONSISTENCY:
        return 0.5
    per_game_pts = [line.per_game()["pts"] for line in season_lines]
    mean = sum(per_game_pts) / len(per_game_pts)
    if mean <= 0:
        return 0.5
    variance = sum((value - mean) ** 2 for value in per_game_pts) / len(per_game_pts)
    coefficient_of_variation: float = (variance**0.5) / mean
    return round(max(0.0, min(1.0, 1.0 - coefficient_of_variation)), 3)


def _role_security_score(
    season_lines: list[SeasonStatLine], role_signal_impact: float, *, unsigned: bool
) -> float:
    if unsigned:
        return 0.15
    if not season_lines:
        return 0.35
    latest_minutes = season_lines[-1].per_game()["minutesPerGame"]
    base = min(1.0, latest_minutes / 32.0)  # ~32 mpg treated as a clearly secure role
    adjusted = base + role_signal_impact * 0.25
    return round(max(0.0, min(1.0, adjusted)), 3)


def project_player(
    player_id: str,
    nba_season_lines: list[SeasonStatLine],
    college_line: SeasonStatLine | None,
    context: PlayerContext,
) -> ProjectedLine:
    """Pure function: identical inputs always produce identical output
    (BUILD_SPEC.md section 7.2: reproducibility). `nba_season_lines` must
    be pre-sorted oldest -> newest and contain at most 3 rows (callers
    trim to the most recent 3 seasons before calling)."""
    is_rookie = context.rookie or not nba_season_lines
    age = _age_at_projection(context.dob)
    age_multiplier = age_curve_multiplier(age)

    if is_rookie:
        if college_line is None:
            # Insufficient-history fallback with no data at all: a
            # deliberately conservative, wide-uncertainty replacement-level
            # prior rather than refusing to project.
            base_per_game = dict.fromkeys((*_STAT_KEYS, "minutesPerGame"), 0.0)
            base_per_game.update({"minutesPerGame": 12.0, "pts": 4.0, "reb": 2.0, "ast": 1.0})
            historical_games: list[int] = []
        else:
            base_per_game = _college_fallback_per_game(college_line)
            historical_games = []
    else:
        trimmed = nba_season_lines[-3:]
        base_per_game = _weighted_per_game(trimmed)
        historical_games = [line.games_played for line in trimmed]

    projected_games, injury_risk = availability_multiplier(
        historical_games, context.status, unsigned=context.unsigned
    )

    role_multiplier = 1.0 + context.active_role_signal_impact * 0.20
    adjusted: dict[str, float] = {}
    for key, value in base_per_game.items():
        multiplier = age_multiplier * role_multiplier
        adjusted[key] = max(0.0, round(value * multiplier, 3))

    interval_multiplier = _interval_multiplier(
        is_rookie=is_rookie, is_unsigned=context.unsigned, season_count=len(nba_season_lines)
    )
    lower80: dict[str, float] = {}
    upper80: dict[str, float] = {}
    for key in _STAT_KEYS:
        width = adjusted[key] * _BASE_INTERVAL_WIDTH * interval_multiplier
        lower80[key] = max(0.0, round(adjusted[key] - width, 3))
        upper80[key] = round(adjusted[key] + width, 3)

    consistency = 0.35 if is_rookie else _consistency_score(nba_season_lines[-3:])
    upside = round(
        min(1.0, (upper80["pts"] - adjusted["pts"]) / max(adjusted["pts"], 1.0) / 1.5), 3
    )
    role_security = _role_security_score(
        nba_season_lines[-3:], context.active_role_signal_impact, unsigned=context.unsigned
    )
    safety_injury_risk = round(min(1.0, max(0.0, injury_risk)), 3)

    return ProjectedLine.model_validate(
        {
            "playerId": player_id,
            "games": projected_games,
            "minutesPerGame": adjusted["minutesPerGame"],
            "pts": adjusted["pts"],
            "reb": adjusted["reb"],
            "ast": adjusted["ast"],
            "stl": adjusted["stl"],
            "blk": adjusted["blk"],
            "tov": adjusted["tov"],
            "fgm": adjusted["fgm"],
            "fga": adjusted["fga"],
            "ftm": adjusted["ftm"],
            "fta": adjusted["fta"],
            "threePm": adjusted["threePm"],
            "lower80": lower80,
            "upper80": upper80,
            "injuryRisk": safety_injury_risk,
            "consistency": consistency,
            "upside": upside,
            "roleSecurity": role_security,
        }
    )


__all__: list[str] = [
    "COLLEGE_TRANSLATION_FACTORS",
    "PROJECTION_AS_OF",
    "PROJECTION_SEASON",
    "SEASON_WEIGHTS",
    "PlayerContext",
    "SeasonStatLine",
    "age_curve_multiplier",
    "availability_multiplier",
    "project_player",
]
