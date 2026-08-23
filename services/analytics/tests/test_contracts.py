import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.domain.contracts import (
    LeagueScoringRule,
    ProjectedLine,
    Recommendation,
    ScoreComponent,
)

FIXTURES_DIR = Path(__file__).resolve().parents[3] / "data" / "schemas" / "fixtures"


def load_fixture(name: str) -> dict[str, Any]:
    result: dict[str, Any] = json.loads((FIXTURES_DIR / f"{name}.json").read_text())
    return result


def test_league_scoring_rule_fixture_validates() -> None:
    LeagueScoringRule.model_validate(load_fixture("league-scoring-rule"))


def test_projected_line_fixture_validates() -> None:
    ProjectedLine.model_validate(load_fixture("projected-line"))


def test_score_component_fixture_validates() -> None:
    ScoreComponent.model_validate(load_fixture("score-component"))


def test_recommendation_fixture_validates() -> None:
    Recommendation.model_validate(load_fixture("recommendation"))


def test_recommendation_rejects_out_of_range_draft_score() -> None:
    fixture = load_fixture("recommendation")
    fixture["draftScore"] = 142
    with pytest.raises(ValidationError):
        Recommendation.model_validate(fixture)


def test_score_component_rejects_unknown_key() -> None:
    fixture = load_fixture("score-component")
    fixture["key"] = "not-a-real-key"
    with pytest.raises(ValidationError):
        ScoreComponent.model_validate(fixture)
