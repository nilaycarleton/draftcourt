from datetime import date

from app.pipelines.baseline import (
    PROJECTION_AS_OF,
    SEASON_WEIGHTS,
    PlayerContext,
    SeasonStatLine,
    age_curve_multiplier,
    availability_multiplier,
    project_player,
)

PLAYER_ID = "5b1b1a2a-6b1a-4c2e-9c3d-2f7a6a9e1a11"


def _season(
    season: str,
    *,
    games: int = 70,
    minutes: float = 2200.0,
    pts: float = 1500.0,
    reb: float = 400.0,
    ast: float = 300.0,
    fgm: float = 550.0,
    fga: float = 1100.0,
    ftm: float = 200.0,
    fta: float = 240.0,
    three_pm: float = 100.0,
) -> SeasonStatLine:
    return SeasonStatLine(
        season=season,
        scope="NBA",
        games_played=games,
        minutes_total=minutes,
        pts=pts,
        reb=reb,
        ast=ast,
        stl=60.0,
        blk=30.0,
        tov=150.0,
        fgm=fgm,
        fga=fga,
        ftm=ftm,
        fta=fta,
        three_pm=three_pm,
    )


PRIME_CONTEXT = PlayerContext(dob=date(1999, 1, 1), status="ACTIVE", unsigned=False, rookie=False)


class TestAgeCurve:
    def test_unknown_dob_is_neutral(self) -> None:
        assert age_curve_multiplier(None) == 1.0

    def test_prime_age_is_neutral(self) -> None:
        assert age_curve_multiplier(27.0) == 1.0

    def test_young_player_gets_growth_bonus(self) -> None:
        assert age_curve_multiplier(22.0) > 1.0

    def test_very_young_player_below_growth_floor_is_neutral(self) -> None:
        assert age_curve_multiplier(19.0) == 1.0

    def test_veteran_declines(self) -> None:
        assert age_curve_multiplier(34.0) < 1.0

    def test_decline_is_bounded(self) -> None:
        assert age_curve_multiplier(50.0) == age_curve_multiplier(45.0)
        assert age_curve_multiplier(50.0) >= 0.80


class TestAvailability:
    def test_unsigned_gets_low_games_and_elevated_risk(self) -> None:
        games, risk = availability_multiplier([70, 72], "ACTIVE", unsigned=True)
        assert games < 30
        assert risk > 0.4

    def test_injured_status_reduces_projected_games(self) -> None:
        healthy_games, _ = availability_multiplier([75, 78], "ACTIVE", unsigned=False)
        injured_games, injured_risk = availability_multiplier([75, 78], "INJURED", unsigned=False)
        assert injured_games < healthy_games
        assert injured_risk > 0.3

    def test_no_history_returns_moderate_default(self) -> None:
        games, risk = availability_multiplier([], "ACTIVE", unsigned=False)
        assert games > 0
        assert 0.0 <= risk <= 1.0

    def test_heavy_missed_games_history_raises_risk(self) -> None:
        _, low_risk = availability_multiplier([80, 79, 81], "ACTIVE", unsigned=False)
        _, high_risk = availability_multiplier([30, 25, 40], "ACTIVE", unsigned=False)
        assert high_risk > low_risk


class TestProjectPlayerVeteran:
    def test_three_season_veteran_produces_valid_projected_line(self) -> None:
        lines = [_season("2023-24"), _season("2024-25"), _season("2025-26")]
        result = project_player(PLAYER_ID, lines, None, PRIME_CONTEXT)

        assert str(result.player_id) == PLAYER_ID
        assert result.games > 0
        assert result.minutes_per_game > 0
        assert result.pts > 0

    def test_reproducibility_identical_inputs_identical_output(self) -> None:
        lines = [_season("2023-24"), _season("2024-25"), _season("2025-26")]
        first = project_player(PLAYER_ID, lines, None, PRIME_CONTEXT)
        second = project_player(PLAYER_ID, lines, None, PRIME_CONTEXT)
        assert first.model_dump() == second.model_dump()

    def test_makes_never_exceed_attempts_after_adjustment(self) -> None:
        lines = [_season("2023-24"), _season("2024-25"), _season("2025-26")]
        young_context = PlayerContext(
            dob=date(2005, 1, 1), status="ACTIVE", unsigned=False, rookie=False
        )
        result = project_player(PLAYER_ID, lines, None, young_context)
        assert result.fgm <= result.fga
        assert result.ftm <= result.fta
        assert result.three_pm <= result.fgm

    def test_recent_season_weighted_more_than_older(self) -> None:
        # A player whose scoring jumped sharply in the most recent season
        # should project closer to the recent rate than a naive average.
        lines = [
            _season("2023-24", pts=700.0, games=70),  # 10 ppg
            _season("2024-25", pts=700.0, games=70),  # 10 ppg
            _season("2025-26", pts=2100.0, games=70),  # 30 ppg
        ]
        result = project_player(PLAYER_ID, lines, None, PRIME_CONTEXT)
        naive_average = (10.0 + 10.0 + 30.0) / 3  # ~16.7
        assert result.pts > naive_average

    def test_two_season_veteran_uses_two_season_weights(self) -> None:
        lines = [_season("2024-25"), _season("2025-26")]
        result = project_player(PLAYER_ID, lines, None, PRIME_CONTEXT)
        assert result.games > 0
        assert SEASON_WEIGHTS[2] == (0.35, 0.65)

    def test_only_uses_most_recent_three_seasons_when_more_are_passed(self) -> None:
        # project_player itself only weights len(nba_season_lines[-3:]); a
        # 4-season history should behave identically to the same trailing 3.
        four_seasons = [
            _season("2022-23", pts=100.0, games=70),
            _season("2023-24"),
            _season("2024-25"),
            _season("2025-26"),
        ]
        three_seasons = four_seasons[-3:]
        result_four = project_player(PLAYER_ID, four_seasons, None, PRIME_CONTEXT)
        result_three = project_player(PLAYER_ID, three_seasons, None, PRIME_CONTEXT)
        assert result_four.model_dump() == result_three.model_dump()


class TestConfidenceIntervals:
    def test_lower80_at_or_below_projection_at_or_below_upper80(self) -> None:
        lines = [_season("2023-24"), _season("2024-25"), _season("2025-26")]
        result = project_player(PLAYER_ID, lines, None, PRIME_CONTEXT)
        for key in ("pts", "reb", "ast", "stl", "blk", "tov", "fgm", "fga", "ftm", "fta"):
            assert result.lower80[key] <= getattr(result, key) <= result.upper80[key]

    def test_lower80_never_negative(self) -> None:
        lines = [_season("2023-24"), _season("2024-25"), _season("2025-26")]
        result = project_player(PLAYER_ID, lines, None, PRIME_CONTEXT)
        assert all(value >= 0 for value in result.lower80.values())

    def test_rookie_interval_wider_than_veteran(self) -> None:
        veteran_lines = [_season("2023-24"), _season("2024-25"), _season("2025-26")]
        veteran = project_player(PLAYER_ID, veteran_lines, None, PRIME_CONTEXT)
        veteran_width = veteran.upper80["pts"] - veteran.lower80["pts"]

        college = _season("college-2024-25")  # `scope` doesn't affect per_game() math
        rookie_context = PlayerContext(
            dob=date(2006, 1, 1), status="ACTIVE", unsigned=False, rookie=True
        )
        rookie = project_player(PLAYER_ID, [], college, rookie_context)
        rookie_width = rookie.upper80["pts"] - rookie.lower80["pts"]

        # Compare relative width (width / projection) since absolute scale differs.
        veteran_relative = veteran_width / max(veteran.pts, 1.0)
        rookie_relative = rookie_width / max(rookie.pts, 1.0)
        assert rookie_relative > veteran_relative


class TestFallbacks:
    def test_rookie_with_college_data_uses_translation_factors(self) -> None:
        college = _season("college-2024-25", pts=1050.0, games=35)  # 30 ppg college
        context = PlayerContext(dob=date(2006, 6, 1), status="ACTIVE", unsigned=False, rookie=True)
        result = project_player(PLAYER_ID, [], college, context)
        assert 0 < result.pts < 30.0  # translated down from the raw college rate

    def test_rookie_with_no_data_at_all_gets_conservative_prior(self) -> None:
        context = PlayerContext(dob=date(2006, 6, 1), status="ACTIVE", unsigned=False, rookie=True)
        result = project_player(PLAYER_ID, [], None, context)
        assert result.pts > 0
        assert result.minutes_per_game > 0

    def test_unsigned_player_gets_low_role_security(self) -> None:
        lines = [_season("2023-24"), _season("2024-25"), _season("2025-26")]
        context = PlayerContext(
            dob=date(1999, 1, 1), status="UNSIGNED", unsigned=True, rookie=False
        )
        result = project_player(PLAYER_ID, lines, None, context)
        assert result.role_security < 0.3
        assert result.games < 30

    def test_no_nba_history_and_not_flagged_rookie_still_falls_back(self) -> None:
        # A player who simply has zero NBA-scope rows (missing seasons)
        # must not crash — falls back the same way an explicit rookie does.
        context = PlayerContext(dob=date(2000, 1, 1), status="ACTIVE", unsigned=False, rookie=False)
        result = project_player(PLAYER_ID, [], None, context)
        assert result.games > 0


class TestScoreBounds:
    def test_all_bounded_scores_within_zero_one(self) -> None:
        lines = [_season("2023-24"), _season("2024-25"), _season("2025-26")]
        result = project_player(PLAYER_ID, lines, None, PRIME_CONTEXT)
        for value in (result.injury_risk, result.consistency, result.upside, result.role_security):
            assert 0.0 <= value <= 1.0

    def test_bounded_scores_within_zero_one_for_rookie(self) -> None:
        context = PlayerContext(dob=date(2006, 1, 1), status="ACTIVE", unsigned=False, rookie=True)
        result = project_player(PLAYER_ID, [], None, context)
        for value in (result.injury_risk, result.consistency, result.upside, result.role_security):
            assert 0.0 <= value <= 1.0

    def test_bounded_scores_within_zero_one_for_unsigned(self) -> None:
        lines = [_season("2023-24"), _season("2024-25")]
        context = PlayerContext(
            dob=date(1995, 1, 1), status="UNSIGNED", unsigned=True, rookie=False
        )
        result = project_player(PLAYER_ID, lines, None, context)
        for value in (result.injury_risk, result.consistency, result.upside, result.role_security):
            assert 0.0 <= value <= 1.0


class TestRoleSignals:
    def test_role_up_signal_increases_projection(self) -> None:
        lines = [_season("2023-24"), _season("2024-25"), _season("2025-26")]
        neutral = project_player(PLAYER_ID, lines, None, PRIME_CONTEXT)
        boosted_context = PlayerContext(
            dob=date(1999, 1, 1),
            status="ACTIVE",
            unsigned=False,
            rookie=False,
            active_role_signal_impact=0.8,
        )
        boosted = project_player(PLAYER_ID, lines, None, boosted_context)
        assert boosted.pts > neutral.pts

    def test_role_down_signal_decreases_projection(self) -> None:
        lines = [_season("2023-24"), _season("2024-25"), _season("2025-26")]
        neutral = project_player(PLAYER_ID, lines, None, PRIME_CONTEXT)
        reduced_context = PlayerContext(
            dob=date(1999, 1, 1),
            status="ACTIVE",
            unsigned=False,
            rookie=False,
            active_role_signal_impact=-0.8,
        )
        reduced = project_player(PLAYER_ID, lines, None, reduced_context)
        assert reduced.pts < neutral.pts


def test_projection_as_of_is_a_fixed_constant_not_wall_clock() -> None:
    assert date(2026, 10, 1) == PROJECTION_AS_OF
