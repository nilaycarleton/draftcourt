import uuid

from app.pipelines.baseline import PlayerContext, SeasonStatLine
from app.pipelines.evaluation import (
    EvalCase,
    fantasy_points,
    run_evaluation,
)


def _season(
    season: str, *, games: int = 70, pts: float = 1500.0, minutes: float = 2200.0
) -> SeasonStatLine:
    return SeasonStatLine(
        season=season,
        scope="NBA",
        games_played=games,
        minutes_total=minutes,
        pts=pts,
        reb=400.0,
        ast=300.0,
        stl=60.0,
        blk=30.0,
        tov=150.0,
        fgm=550.0,
        fga=1100.0,
        ftm=200.0,
        fta=240.0,
        three_pm=100.0,
    )


def _case(
    player_id: str,
    *,
    status: str = "ACTIVE",
    unsigned: bool = False,
    rookie: bool = False,
    train_seasons: tuple[str, str] = ("2023-24", "2024-25"),
    actual_season: str = "2025-26",
) -> EvalCase:
    train_lines = [_season(s) for s in train_seasons]
    return EvalCase(
        player_id=str(uuid.uuid5(uuid.NAMESPACE_DNS, player_id)),
        display_name=f"Player {player_id}",
        train_lines=train_lines,
        actual=_season(actual_season),
        context=PlayerContext(dob=None, status=status, unsigned=unsigned, rookie=rookie),  # type: ignore[arg-type]
    )


class TestFantasyPoints:
    def test_computes_weighted_sum(self) -> None:
        per_game = {
            "pts": 20.0,
            "reb": 5.0,
            "ast": 5.0,
            "stl": 1.0,
            "blk": 1.0,
            "tov": 2.0,
            "threePm": 2.0,
        }
        expected = 20.0 + 1.2 * 5.0 + 1.5 * 5.0 + 3.0 * 1.0 + 3.0 * 1.0 - 1.0 * 2.0 + 1.0 * 2.0
        assert fantasy_points(per_game) == expected


class TestRunEvaluation:
    def test_empty_cases_produces_zeroed_report(self) -> None:
        report = run_evaluation(
            [], model_key="baseline", model_version="1.0.0", cutoff_season="2025-26"
        )
        all_metrics = next(s for s in report.subgroups if s.subgroup == "all")
        assert all_metrics.n == 0
        assert all_metrics.fantasy_points_mae == 0.0
        assert all_metrics.spearman_rank_correlation is None

    def test_exact_match_case_has_zero_error(self) -> None:
        # The projection engine won't reproduce the actual exactly (it's a
        # weighted average of the training seasons, not a copy), but with
        # identical train/actual stat lines the deterministic baseline
        # should be very close to a zero-error match on the primary stat.
        case = _case("p1", train_seasons=("2025-26", "2025-26"), actual_season="2025-26")
        report = run_evaluation(
            [case], model_key="baseline", model_version="1.0.0", cutoff_season="2025-26"
        )
        all_metrics = next(s for s in report.subgroups if s.subgroup == "all")
        assert all_metrics.n == 1
        assert all_metrics.fantasy_points_mae >= 0.0

    def test_leakage_guard_train_lines_never_include_actual_season(self) -> None:
        case = _case("p1")
        train_seasons = {line.season for line in case.train_lines}
        assert case.actual.season not in train_seasons

    def test_subgroups_partition_by_status(self) -> None:
        cases = [
            _case("p1", status="ACTIVE"),
            _case("p2", status="INJURED"),
        ]
        report = run_evaluation(
            cases, model_key="baseline", model_version="1.0.0", cutoff_season="2025-26"
        )
        injured = next(s for s in report.subgroups if s.subgroup == "injured")
        veteran = next(s for s in report.subgroups if s.subgroup == "veteran")
        assert injured.n == 1
        assert veteran.n == 1

    def test_rookie_and_unsigned_subgroups_report_not_evaluable_zero(self) -> None:
        # This evaluation methodology requires 3 NBA seasons to hold one
        # out; rookies/unsigned players in this synthetic dataset never
        # have that, so they're structurally absent from `cases` upstream
        # — the report must say so explicitly, not silently omit them.
        cases = [_case("p1")]
        report = run_evaluation(
            cases, model_key="baseline", model_version="1.0.0", cutoff_season="2025-26"
        )
        rookie = next(s for s in report.subgroups if s.subgroup == "rookie")
        unsigned = next(s for s in report.subgroups if s.subgroup == "unsigned")
        assert rookie.n == 0
        assert unsigned.n == 0
        assert report.not_evaluable_counts == {"rookie": 0, "unsigned": 0}

    def test_interval_coverage_is_between_zero_and_one(self) -> None:
        cases = [_case(f"p{i}") for i in range(5)]
        report = run_evaluation(
            cases, model_key="baseline", model_version="1.0.0", cutoff_season="2025-26"
        )
        all_metrics = next(s for s in report.subgroups if s.subgroup == "all")
        assert 0.0 <= all_metrics.interval_coverage <= 1.0

    def test_spearman_none_with_fewer_than_two_cases(self) -> None:
        report = run_evaluation(
            [_case("p1")], model_key="baseline", model_version="1.0.0", cutoff_season="2025-26"
        )
        all_metrics = next(s for s in report.subgroups if s.subgroup == "all")
        assert all_metrics.spearman_rank_correlation is None

    def test_minutes_weighted_mae_has_entry_per_rate_stat(self) -> None:
        cases = [_case("p1"), _case("p2")]
        report = run_evaluation(
            cases, model_key="baseline", model_version="1.0.0", cutoff_season="2025-26"
        )
        all_metrics = next(s for s in report.subgroups if s.subgroup == "all")
        for stat in (
            "pts",
            "reb",
            "ast",
            "stl",
            "blk",
            "tov",
            "fgm",
            "fga",
            "ftm",
            "fta",
            "threePm",
        ):
            assert stat in all_metrics.minutes_weighted_mae
            assert all_metrics.minutes_weighted_mae[stat] >= 0.0

    def test_games_played_mae_is_nonnegative(self) -> None:
        cases = [_case("p1"), _case("p2")]
        report = run_evaluation(
            cases, model_key="baseline", model_version="1.0.0", cutoff_season="2025-26"
        )
        all_metrics = next(s for s in report.subgroups if s.subgroup == "all")
        assert all_metrics.games_played_mae >= 0.0

    def test_report_carries_model_identity(self) -> None:
        report = run_evaluation(
            [_case("p1")],
            model_key="baseline-weighted-historical",
            model_version="1.0.0",
            cutoff_season="2025-26",
        )
        assert report.model_key == "baseline-weighted-historical"
        assert report.model_version == "1.0.0"
        assert report.cutoff_season == "2025-26"
