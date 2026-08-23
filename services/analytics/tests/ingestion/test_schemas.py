import pytest
from pydantic import ValidationError

from app.ingestion.schemas import (
    RawAdpObservationRecord,
    RawNewsSignalRecord,
    RawPlayerRecord,
    RawProjectionOverrideSeedRecord,
    RawSeasonStatRecord,
    RawTeamRecord,
)

VALID_TEAM = {
    "externalKey": "demo-team-BOS",
    "nbaProviderId": "demo-team-BOS",
    "abbreviation": "BOS",
    "name": "Boston Celtics",
    "city": "Boston",
    "conference": "EAST",
    "division": "ATLANTIC",
    "colorPrimary": "#007A33",
    "colorSecondary": "#BA9653",
}

VALID_PLAYER = {
    "externalKey": "demo-player-0001",
    "displayName": "Test Player",
    "legalName": "Test Player",
    "dob": "2000-01-01",
    "teamExternalKey": "demo-team-BOS",
    "positions": ["SF", "PF"],
    "status": "ACTIVE",
    "unsigned": False,
    "rookie": False,
    "draftYear": None,
    "archetype": "starter",
    "isSyntheticFiller": False,
}

VALID_STAT = {
    "playerExternalKey": "demo-player-0001",
    "season": "2025-26",
    "scope": "NBA",
    "gamesPlayed": 70,
    "minutesTotal": 2000.0,
    "pts": 1500.0,
    "reb": 400.0,
    "ast": 300.0,
    "stl": 60.0,
    "blk": 30.0,
    "tov": 150.0,
    "fgm": 550.0,
    "fga": 1100.0,
    "ftm": 200.0,
    "fta": 250.0,
    "threePm": 100.0,
}


class TestRawTeamRecord:
    def test_accepts_valid_team(self) -> None:
        RawTeamRecord.model_validate(VALID_TEAM)

    def test_rejects_missing_required_field(self) -> None:
        payload = {k: v for k, v in VALID_TEAM.items() if k != "abbreviation"}
        with pytest.raises(ValidationError):
            RawTeamRecord.model_validate(payload)

    def test_rejects_bad_color_format(self) -> None:
        payload = {**VALID_TEAM, "colorPrimary": "green"}
        with pytest.raises(ValidationError):
            RawTeamRecord.model_validate(payload)

    def test_rejects_unexpected_field(self) -> None:
        payload = {**VALID_TEAM, "unexpectedField": "oops"}
        with pytest.raises(ValidationError):
            RawTeamRecord.model_validate(payload)


class TestRawPlayerRecord:
    def test_accepts_valid_player(self) -> None:
        RawPlayerRecord.model_validate(VALID_PLAYER)

    def test_rejects_unsigned_flag_mismatch(self) -> None:
        payload = {**VALID_PLAYER, "unsigned": True}  # status is still ACTIVE
        with pytest.raises(ValidationError, match="unsigned flag must match"):
            RawPlayerRecord.model_validate(payload)

    def test_unsigned_player_must_not_have_team(self) -> None:
        payload = {
            **VALID_PLAYER,
            "status": "UNSIGNED",
            "unsigned": True,
            "teamExternalKey": "demo-team-BOS",
        }
        with pytest.raises(ValidationError, match="must not have a team_external_key"):
            RawPlayerRecord.model_validate(payload)

    def test_signed_player_must_have_team(self) -> None:
        payload = {**VALID_PLAYER, "teamExternalKey": None}
        with pytest.raises(ValidationError, match="must have a team_external_key"):
            RawPlayerRecord.model_validate(payload)

    def test_rookie_must_have_draft_year(self) -> None:
        payload = {**VALID_PLAYER, "rookie": True, "draftYear": None, "archetype": "rookie"}
        with pytest.raises(ValidationError, match="must have a draft_year"):
            RawPlayerRecord.model_validate(payload)

    def test_suspended_real_player_is_rejected(self) -> None:
        payload = {**VALID_PLAYER, "status": "SUSPENDED", "isSyntheticFiller": False}
        with pytest.raises(ValidationError, match="SUSPENDED status is only permitted"):
            RawPlayerRecord.model_validate(payload)

    def test_suspended_synthetic_filler_is_accepted(self) -> None:
        payload = {**VALID_PLAYER, "status": "SUSPENDED", "isSyntheticFiller": True}
        RawPlayerRecord.model_validate(payload)

    def test_rejects_malformed_dob(self) -> None:
        payload = {**VALID_PLAYER, "dob": "not-a-date"}
        with pytest.raises(ValidationError):
            RawPlayerRecord.model_validate(payload)

    def test_rejects_too_many_positions(self) -> None:
        payload = {**VALID_PLAYER, "positions": ["PG", "SG", "SF"]}
        with pytest.raises(ValidationError):
            RawPlayerRecord.model_validate(payload)

    def test_partial_record_missing_status_is_rejected(self) -> None:
        payload = {k: v for k, v in VALID_PLAYER.items() if k != "status"}
        with pytest.raises(ValidationError):
            RawPlayerRecord.model_validate(payload)


class TestRawSeasonStatRecord:
    def test_accepts_valid_stat_line(self) -> None:
        RawSeasonStatRecord.model_validate(VALID_STAT)

    def test_rejects_makes_exceeding_attempts_fg(self) -> None:
        payload = {**VALID_STAT, "fgm": 1200.0, "fga": 1100.0}
        with pytest.raises(ValidationError, match="fgm .* exceeds fga"):
            RawSeasonStatRecord.model_validate(payload)

    def test_rejects_makes_exceeding_attempts_ft(self) -> None:
        payload = {**VALID_STAT, "ftm": 300.0, "fta": 250.0}
        with pytest.raises(ValidationError, match="ftm .* exceeds fta"):
            RawSeasonStatRecord.model_validate(payload)

    def test_rejects_three_pm_exceeding_fgm(self) -> None:
        payload = {**VALID_STAT, "threePm": 600.0, "fgm": 550.0}
        with pytest.raises(ValidationError, match="three_pm .* exceeds fgm"):
            RawSeasonStatRecord.model_validate(payload)

    def test_rejects_malformed_nba_season(self) -> None:
        payload = {**VALID_STAT, "season": "2025"}
        with pytest.raises(ValidationError):
            RawSeasonStatRecord.model_validate(payload)

    def test_rejects_college_scope_with_nba_season_format(self) -> None:
        payload = {**VALID_STAT, "scope": "COLLEGE", "season": "2024-25"}
        with pytest.raises(ValidationError, match="COLLEGE-scope season"):
            RawSeasonStatRecord.model_validate(payload)

    def test_accepts_valid_college_season(self) -> None:
        payload = {**VALID_STAT, "scope": "COLLEGE", "season": "college-2024-25"}
        RawSeasonStatRecord.model_validate(payload)

    def test_rejects_negative_stat(self) -> None:
        payload = {**VALID_STAT, "pts": -5.0}
        with pytest.raises(ValidationError):
            RawSeasonStatRecord.model_validate(payload)


class TestRawAdpObservationRecord:
    VALID = {
        "playerExternalKey": "demo-player-0001",
        "sourceExternalKey": "demo-adp-source-a",
        "format": "OVERALL",
        "season": "2026-27",
        "sampleSize": 1000,
        "adp": 12.5,
        "rank": 12,
        "capturedAt": "2026-08-15T00:00:00Z",
    }

    def test_accepts_valid_observation(self) -> None:
        RawAdpObservationRecord.model_validate(self.VALID)

    def test_rejects_adp_out_of_range(self) -> None:
        payload = {**self.VALID, "adp": 999.0}
        with pytest.raises(ValidationError):
            RawAdpObservationRecord.model_validate(payload)

    def test_rejects_zero_sample_size(self) -> None:
        payload = {**self.VALID, "sampleSize": 0}
        with pytest.raises(ValidationError):
            RawAdpObservationRecord.model_validate(payload)


class TestRawNewsSignalRecord:
    VALID = {
        "playerExternalKey": "demo-player-0001",
        "type": "INJURY",
        "impact": -0.3,
        "confidence": 0.8,
        "rationale": "Demo signal.",
        "effectiveAt": "2026-08-10T00:00:00Z",
        "expiresAt": "2026-08-24T00:00:00Z",
    }

    def test_accepts_valid_signal(self) -> None:
        RawNewsSignalRecord.model_validate(self.VALID)

    def test_rejects_expiry_before_effective(self) -> None:
        payload = {**self.VALID, "expiresAt": "2026-08-01T00:00:00Z"}
        with pytest.raises(ValidationError, match="expires_at must be after"):
            RawNewsSignalRecord.model_validate(payload)

    def test_rejects_impact_out_of_bounds(self) -> None:
        payload = {**self.VALID, "impact": 1.5}
        with pytest.raises(ValidationError):
            RawNewsSignalRecord.model_validate(payload)


class TestRawProjectionOverrideSeedRecord:
    VALID = {
        "playerExternalKey": "demo-player-0001",
        "season": "2026-27",
        "stat": "pts",
        "deltaValue": 1.5,
        "replacementValue": None,
        "rationale": "Demo override.",
        "effectiveAt": "2026-08-12T00:00:00Z",
        "expiresAt": None,
    }

    def test_accepts_delta_style_override(self) -> None:
        RawProjectionOverrideSeedRecord.model_validate(self.VALID)

    def test_accepts_replacement_style_override(self) -> None:
        payload = {**self.VALID, "deltaValue": None, "replacementValue": 25.0}
        RawProjectionOverrideSeedRecord.model_validate(payload)

    def test_rejects_both_values_set(self) -> None:
        payload = {**self.VALID, "replacementValue": 25.0}
        with pytest.raises(ValidationError, match="exactly one of"):
            RawProjectionOverrideSeedRecord.model_validate(payload)

    def test_rejects_neither_value_set(self) -> None:
        payload = {**self.VALID, "deltaValue": None}
        with pytest.raises(ValidationError, match="exactly one of"):
            RawProjectionOverrideSeedRecord.model_validate(payload)

    def test_rejects_empty_rationale(self) -> None:
        payload = {**self.VALID, "rationale": ""}
        with pytest.raises(ValidationError):
            RawProjectionOverrideSeedRecord.model_validate(payload)
