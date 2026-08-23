"""Mirrors packages/domain/src/contracts.ts. Both are validated against the
same fixtures in data/schemas/fixtures (see tests/test_contracts.py and
packages/domain/src/contracts.test.ts) so drift is caught by CI."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.domain.enums import Direction


class LeagueScoringRule(BaseModel):
    stat: str = Field(min_length=1, max_length=64)
    weight: float
    direction: Direction
    punt: bool


class ProjectedLine(BaseModel):
    player_id: UUID = Field(alias="playerId")
    games: float = Field(ge=0)
    minutes_per_game: float = Field(ge=0, alias="minutesPerGame")
    pts: float = Field(ge=0)
    reb: float = Field(ge=0)
    ast: float = Field(ge=0)
    stl: float = Field(ge=0)
    blk: float = Field(ge=0)
    tov: float = Field(ge=0)
    fgm: float = Field(ge=0)
    fga: float = Field(ge=0)
    ftm: float = Field(ge=0)
    fta: float = Field(ge=0)
    three_pm: float = Field(ge=0, alias="threePm")
    lower80: dict[str, float]
    upper80: dict[str, float]
    injury_risk: float = Field(ge=0, le=1, alias="injuryRisk")
    consistency: float = Field(ge=0, le=1)
    upside: float = Field(ge=0, le=1)
    role_security: float = Field(ge=0, le=1, alias="roleSecurity")

    model_config = {"populate_by_name": True}


ScoreComponentKey = Literal[
    "production",
    "scarcity",
    "rosterNeed",
    "risk",
    "consistency",
    "age",
    "adpValue",
    "upside",
    "role",
    "nextPickAvailability",
    "preference",
    "schedule",
]


class ScoreComponent(BaseModel):
    key: ScoreComponentKey
    raw: float
    normalized: float = Field(ge=0, le=1)
    weight: float = Field(ge=0, le=1)
    contribution: float
    reason: str = Field(min_length=1)


RecommendationLabel = Literal[
    "BEST_OVERALL", "BEST_FIT", "BEST_VALUE", "HIGHEST_UPSIDE", "SAFEST_PICK"
]
Confidence = Literal["LOW", "MEDIUM", "HIGH"]


class Recommendation(BaseModel):
    player_id: UUID = Field(alias="playerId")
    rank: Literal[1, 2, 3]
    draft_score: float = Field(ge=0, le=100, alias="draftScore")
    labels: list[RecommendationLabel] = Field(min_length=1)
    explanation: str = Field(min_length=1)
    availability_next_pick: float = Field(ge=0, le=1, alias="availabilityNextPick")
    confidence: Confidence
    components: list[ScoreComponent] = Field(min_length=1)
    engine_version: str = Field(min_length=1, alias="engineVersion")
    projection_run_id: UUID = Field(alias="projectionRunId")
    input_checksum: str = Field(min_length=1, alias="inputChecksum")

    model_config = {"populate_by_name": True}


__all__: list[str] = [
    "LeagueScoringRule",
    "ProjectedLine",
    "ScoreComponent",
    "ScoreComponentKey",
    "Recommendation",
    "RecommendationLabel",
    "Confidence",
]
