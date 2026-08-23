from datetime import date

from app.ingestion.identity import (
    CANDIDATE_THRESHOLD,
    CONFIRM_THRESHOLD,
    ExistingPlayer,
    normalize_name,
    resolve_by_name_dob,
    resolve_by_provider_id,
)


def test_normalize_name_collapses_whitespace_and_case() -> None:
    assert normalize_name("  Jayson   Tatum ") == "jayson tatum"
    assert normalize_name("JAYSON TATUM") == normalize_name("jayson tatum")


def test_resolve_by_provider_id_none_when_never_seen() -> None:
    assert resolve_by_provider_id(None) is None


def test_resolve_by_provider_id_fast_path_when_previously_confirmed() -> None:
    resolution = resolve_by_provider_id("player-123")
    assert resolution is not None
    assert resolution.status == "CONFIRMED"
    assert resolution.method == "PROVIDER_ID"
    assert resolution.player_id == "player-123"
    assert resolution.confidence == 1.0


def test_resolve_by_name_dob_exact_match_confirms() -> None:
    existing = [ExistingPlayer(player_id="p1", display_name="Jayson Tatum", dob=date(2002, 9, 17))]
    resolution = resolve_by_name_dob("Jayson Tatum", date(2002, 9, 17), existing)
    assert resolution.status == "CONFIRMED"
    assert resolution.method == "NAME_DOB"
    assert resolution.player_id == "p1"


def test_resolve_by_name_dob_no_existing_players_is_new() -> None:
    resolution = resolve_by_name_dob("Brand New Player", date(2000, 1, 1), [])
    assert resolution.player_id is None


def test_resolve_by_name_dob_completely_different_name_is_new() -> None:
    existing = [ExistingPlayer(player_id="p1", display_name="Jayson Tatum", dob=date(2002, 9, 17))]
    resolution = resolve_by_name_dob("Zzyzx Qwerty", date(1990, 1, 1), existing)
    assert resolution.player_id is None


def test_resolve_by_name_dob_ambiguous_similar_name_is_candidate() -> None:
    # A near-duplicate name (extra suffix) without a DOB match should land in
    # the reviewable band, not be silently merged nor silently dropped —
    # this is the "unresolved identity" collision case.
    existing = [ExistingPlayer(player_id="p1", display_name="Cam Johnson", dob=date(1996, 3, 3))]
    resolution = resolve_by_name_dob("Cam Johnson Jr", None, existing)
    assert resolution.status == "CANDIDATE"
    assert resolution.player_id == "p1"
    assert resolution.confidence * 100 >= CANDIDATE_THRESHOLD


def test_resolve_by_name_dob_dob_match_boosts_confidence_above_name_alone() -> None:
    existing = [ExistingPlayer(player_id="p1", display_name="Cam Johnson", dob=date(1996, 3, 3))]
    without_dob = resolve_by_name_dob("Cam Johnson", None, existing)
    with_dob = resolve_by_name_dob("Cam Johnson", date(1996, 3, 3), existing)
    assert with_dob.confidence >= without_dob.confidence


def test_resolve_by_name_dob_picks_best_of_multiple_candidates() -> None:
    existing = [
        ExistingPlayer(player_id="p1", display_name="Cam Johnson", dob=date(1996, 3, 3)),
        ExistingPlayer(player_id="p2", display_name="Cam Thomas", dob=date(2001, 10, 13)),
    ]
    resolution = resolve_by_name_dob("Cam Johnson", date(1996, 3, 3), existing)
    assert resolution.player_id == "p1"


def test_confirm_threshold_higher_than_candidate_threshold() -> None:
    assert CONFIRM_THRESHOLD > CANDIDATE_THRESHOLD
