from datetime import UTC, datetime

from app.domain.contracts import ProjectedLine
from app.pipelines.adjustments import (
    ActiveOverride,
    ActiveSignal,
    apply_overrides,
    is_active,
    role_signal_impact,
)

BASE_LINE = ProjectedLine.model_validate(
    {
        "playerId": "5b1b1a2a-6b1a-4c2e-9c3d-2f7a6a9e1a11",
        "games": 70.0,
        "minutesPerGame": 30.0,
        "pts": 20.0,
        "reb": 6.0,
        "ast": 5.0,
        "stl": 1.0,
        "blk": 0.5,
        "tov": 2.5,
        "fgm": 8.0,
        "fga": 16.0,
        "ftm": 4.0,
        "fta": 5.0,
        "threePm": 2.0,
        "lower80": {"pts": 16.0},
        "upper80": {"pts": 24.0},
        "injuryRisk": 0.2,
        "consistency": 0.7,
        "upside": 0.5,
        "roleSecurity": 0.8,
    }
)


class TestIsActive:
    def test_active_when_effective_in_past_and_no_expiry(self) -> None:
        assert is_active(
            datetime(2026, 1, 1, tzinfo=UTC), None, as_of=datetime(2026, 6, 1, tzinfo=UTC)
        )

    def test_inactive_before_effective_date(self) -> None:
        assert not is_active(
            datetime(2026, 12, 1, tzinfo=UTC), None, as_of=datetime(2026, 6, 1, tzinfo=UTC)
        )

    def test_inactive_after_expiry(self) -> None:
        assert not is_active(
            datetime(2026, 1, 1, tzinfo=UTC),
            datetime(2026, 3, 1, tzinfo=UTC),
            as_of=datetime(2026, 6, 1, tzinfo=UTC),
        )

    def test_active_before_expiry(self) -> None:
        assert is_active(
            datetime(2026, 1, 1, tzinfo=UTC),
            datetime(2026, 12, 1, tzinfo=UTC),
            as_of=datetime(2026, 6, 1, tzinfo=UTC),
        )


class TestRoleSignalImpact:
    def test_no_signals_is_zero(self) -> None:
        assert role_signal_impact([]) == 0.0

    def test_non_role_signal_types_ignored(self) -> None:
        signals = [ActiveSignal(id="s1", type="INJURY", impact=0.9, confidence=0.9)]
        assert role_signal_impact(signals) == 0.0

    def test_role_up_is_positive(self) -> None:
        signals = [ActiveSignal(id="s1", type="ROLE_UP", impact=0.5, confidence=1.0)]
        assert role_signal_impact(signals) > 0

    def test_role_down_is_negative_regardless_of_recorded_sign(self) -> None:
        signals = [ActiveSignal(id="s1", type="ROLE_DOWN", impact=0.5, confidence=1.0)]
        assert role_signal_impact(signals) < 0
        # Even if impact was recorded as negative already, ROLE_DOWN stays negative.
        signals_negative_impact = [
            ActiveSignal(id="s2", type="ROLE_DOWN", impact=-0.5, confidence=1.0)
        ]
        assert role_signal_impact(signals_negative_impact) < 0

    def test_bounded_to_unit_interval(self) -> None:
        signals = [
            ActiveSignal(id=f"s{i}", type="ROLE_UP", impact=1.0, confidence=1.0) for i in range(10)
        ]
        assert role_signal_impact(signals) == 1.0

    def test_confidence_scales_magnitude(self) -> None:
        high_confidence = [ActiveSignal(id="s1", type="ROLE_UP", impact=0.5, confidence=1.0)]
        low_confidence = [ActiveSignal(id="s2", type="ROLE_UP", impact=0.5, confidence=0.2)]
        assert role_signal_impact(high_confidence) > role_signal_impact(low_confidence)


class TestApplyOverrides:
    def test_no_overrides_returns_line_unchanged(self) -> None:
        result = apply_overrides(BASE_LINE, [])
        assert result.line.model_dump() == BASE_LINE.model_dump()
        assert result.applied == []

    def test_delta_override_adds_to_existing_value(self) -> None:
        overrides = [
            ActiveOverride(
                id="o1", stat="pts", delta_value=3.0, replacement_value=None, rationale="Test bump."
            )
        ]
        result = apply_overrides(BASE_LINE, overrides)
        assert result.line.pts == BASE_LINE.pts + 3.0
        assert result.applied[0].before == BASE_LINE.pts
        assert result.applied[0].after == BASE_LINE.pts + 3.0

    def test_replacement_override_sets_absolute_value(self) -> None:
        overrides = [
            ActiveOverride(
                id="o1", stat="pts", delta_value=None, replacement_value=99.0, rationale="Test set."
            )
        ]
        result = apply_overrides(BASE_LINE, overrides)
        assert result.line.pts == 99.0

    def test_camel_case_stat_key_is_correctly_matched(self) -> None:
        # Regression guard: ProjectedLine's Python field is `minutes_per_game`,
        # but overrides (and every other caller) use the camelCase API name.
        overrides = [
            ActiveOverride(
                id="o1",
                stat="minutesPerGame",
                delta_value=2.0,
                replacement_value=None,
                rationale="Test minutes bump.",
            )
        ]
        result = apply_overrides(BASE_LINE, overrides)
        assert result.line.minutes_per_game == BASE_LINE.minutes_per_game + 2.0

    def test_three_pm_camel_case_stat_key(self) -> None:
        overrides = [
            ActiveOverride(
                id="o1", stat="threePm", delta_value=1.0, replacement_value=None, rationale="Test."
            )
        ]
        result = apply_overrides(BASE_LINE, overrides)
        assert result.line.three_pm == BASE_LINE.three_pm + 1.0

    def test_delta_override_never_goes_negative(self) -> None:
        overrides = [
            ActiveOverride(
                id="o1",
                stat="blk",
                delta_value=-999.0,
                replacement_value=None,
                rationale="Test floor.",
            )
        ]
        result = apply_overrides(BASE_LINE, overrides)
        assert result.line.blk == 0.0

    def test_unknown_stat_key_is_ignored_not_raised(self) -> None:
        overrides = [
            ActiveOverride(
                id="o1",
                stat="not_a_real_stat",
                delta_value=5.0,
                replacement_value=None,
                rationale="Test.",
            )
        ]
        result = apply_overrides(BASE_LINE, overrides)
        assert result.applied == []
        assert result.line.model_dump() == BASE_LINE.model_dump()

    def test_multiple_overrides_on_same_stat_apply_in_order_last_wins(self) -> None:
        overrides = [
            ActiveOverride(
                id="o1", stat="pts", delta_value=None, replacement_value=10.0, rationale="First."
            ),
            ActiveOverride(
                id="o2",
                stat="pts",
                delta_value=None,
                replacement_value=25.0,
                rationale="Second, supersedes.",
            ),
        ]
        result = apply_overrides(BASE_LINE, overrides)
        assert result.line.pts == 25.0
        assert len(result.applied) == 2

    def test_applied_records_carry_rationale_for_audit_trail(self) -> None:
        overrides = [
            ActiveOverride(
                id="o1",
                stat="ast",
                delta_value=1.5,
                replacement_value=None,
                rationale="Starter promotion expected.",
            )
        ]
        result = apply_overrides(BASE_LINE, overrides)
        assert result.applied[0].rationale == "Starter promotion expected."
        assert result.applied[0].override_id == "o1"
