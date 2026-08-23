"""Standard 9-category points-league scoring, shared by
`app.pipelines.run` (stored on `PlayerProjection.fantasyPoints`, so the
API can filter/sort by it directly) and `app.pipelines.evaluation`
(fantasy-points MAE) — one formula, so the two never silently drift
apart. Not any specific real league's actual settings; a documented
benchmark figure, same status as `overallRank`.
"""

from __future__ import annotations

FANTASY_POINT_WEIGHTS: dict[str, float] = {
    "pts": 1.0,
    "reb": 1.2,
    "ast": 1.5,
    "stl": 3.0,
    "blk": 3.0,
    "tov": -1.0,
    "threePm": 1.0,
}


def fantasy_points(per_game: dict[str, float]) -> float:
    return sum(FANTASY_POINT_WEIGHTS[stat] * per_game[stat] for stat in FANTASY_POINT_WEIGHTS)


__all__: list[str] = ["FANTASY_POINT_WEIGHTS", "fantasy_points"]
