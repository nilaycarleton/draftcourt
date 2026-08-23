"""Verifies data/demo/generate.py's output: determinism, referential
integrity, and the SUSPENDED/UNSIGNED-never-on-a-real-player safety policy
documented in data/attribution/demo-dataset.md."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_GENERATE_PATH = _REPO_ROOT / "data" / "demo" / "generate.py"


def _load_generate_module() -> Any:
    spec = importlib.util.spec_from_file_location("demo_generate", _GENERATE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["demo_generate"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def generate_module() -> Any:
    return _load_generate_module()


@pytest.fixture(scope="module")
def dataset(generate_module: Any) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = generate_module.build_dataset()
    return result


def test_generation_is_deterministic(generate_module: Any) -> None:
    assert generate_module.verify_determinism() is True


def test_dataset_has_all_30_teams(dataset: dict[str, list[dict[str, Any]]]) -> None:
    assert len(dataset["teams"]) == 30
    assert len({t["abbreviation"] for t in dataset["teams"]}) == 30


def test_no_real_player_is_suspended_or_unsigned(dataset: dict[str, list[dict[str, Any]]]) -> None:
    for player in dataset["players"]:
        if player["status"] in ("SUSPENDED", "UNSIGNED"):
            assert player["isSyntheticFiller"] is True, (
                f"{player['displayName']!r} has status {player['status']} but is not a "
                "synthetic filler player — see data/attribution/demo-dataset.md policy"
            )


def test_dataset_covers_required_archetypes(dataset: dict[str, list[dict[str, Any]]]) -> None:
    players = dataset["players"]
    assert any(p["status"] == "ACTIVE" for p in players)
    assert any(p["status"] == "INJURED" for p in players)
    assert any(p["status"] == "SUSPENDED" for p in players)
    assert any(p["status"] == "UNSIGNED" for p in players)
    assert any(p["rookie"] for p in players)
    assert any(not p["rookie"] and not p["isSyntheticFiller"] for p in players)  # veterans
    assert any(p["archetype"] == "breakout" for p in players)
    assert any(len(p["positions"]) == 2 for p in players)  # multi-position eligibility


def test_referential_integrity(dataset: dict[str, list[dict[str, Any]]]) -> None:
    team_keys = {t["externalKey"] for t in dataset["teams"]}
    player_keys = {p["externalKey"] for p in dataset["players"]}

    for player in dataset["players"]:
        if player["teamExternalKey"] is not None:
            assert player["teamExternalKey"] in team_keys

    for stat in dataset["player_season_stats"]:
        assert stat["playerExternalKey"] in player_keys
    for obs in dataset["adp_observations"]:
        assert obs["playerExternalKey"] in player_keys
    for signal in dataset["news_signals"]:
        assert signal["playerExternalKey"] in player_keys
    for override in dataset["projection_overrides_seed"]:
        assert override["playerExternalKey"] in player_keys


def test_season_stat_invariants(dataset: dict[str, list[dict[str, Any]]]) -> None:
    for stat in dataset["player_season_stats"]:
        assert stat["fgm"] <= stat["fga"], stat
        assert stat["ftm"] <= stat["fta"], stat
        assert stat["threePm"] <= stat["fgm"], stat
        assert stat["gamesPlayed"] >= 0
        assert stat["minutesTotal"] >= 0


def test_rookies_have_exactly_one_college_stat_row_and_no_nba_rows(
    dataset: dict[str, list[dict[str, Any]]],
) -> None:
    rookie_keys = {p["externalKey"] for p in dataset["players"] if p["rookie"]}
    by_player: dict[str, list[dict[str, Any]]] = {}
    for stat in dataset["player_season_stats"]:
        by_player.setdefault(stat["playerExternalKey"], []).append(stat)

    for key in rookie_keys:
        rows = by_player[key]
        assert len(rows) == 1
        assert rows[0]["scope"] == "COLLEGE"


def test_veterans_have_three_nba_season_rows(dataset: dict[str, list[dict[str, Any]]]) -> None:
    by_player: dict[str, list[dict[str, Any]]] = {}
    for stat in dataset["player_season_stats"]:
        by_player.setdefault(stat["playerExternalKey"], []).append(stat)

    veterans = [
        p
        for p in dataset["players"]
        if not p["rookie"] and not p["isSyntheticFiller"] and p["status"] != "UNSIGNED"
    ]
    for player in veterans:
        rows = by_player[player["externalKey"]]
        assert len(rows) == 3
        assert {row["season"] for row in rows} == {"2023-24", "2024-25", "2025-26"}


def test_adp_has_exactly_two_sources(dataset: dict[str, list[dict[str, Any]]]) -> None:
    sources = {obs["sourceExternalKey"] for obs in dataset["adp_observations"]}
    assert sources == {"demo-adp-source-a", "demo-adp-source-b"}
