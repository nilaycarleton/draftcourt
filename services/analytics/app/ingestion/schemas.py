"""Pydantic validation for every raw record type the ingestion pipeline
accepts, per BUILD_SPEC.md section 7.2 / section 4's validation
requirements: required fields/ids, valid stat ranges, makes <= attempts,
valid seasons/dates, schema-version checks, partial-record detection.
Failing validation quarantines the record (`RawSourceRecord.status =
QUARANTINED`, `validationErrors` populated) — it is never silently
coerced or published. Mirrors the field names in the exact demo-fixture
contract (`data/demo/*.json`) that `app.ingestion.file_adapter` reads, and
is the same shape any future live adapter's raw payloads must match.

These are internal ingestion-boundary contracts, not part of the shared
TS<->Python contract system in packages/domain / data/schemas (those cover
API-facing shapes; nothing here is ever sent to the browser).
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from app.domain.enums import EligiblePosition, SignalType, StatScope

SUPPORTED_SCHEMA_VERSIONS = frozenset({"1"})

_SEASON_RE = re.compile(r"^\d{4}-\d{2}$")
_COLLEGE_SEASON_RE = re.compile(r"^college-\d{4}-\d{2}$")


class _CamelModel(BaseModel):
    """Base for every raw record schema: the committed demo fixtures (and
    any future live adapter payload normalized to this contract) use
    camelCase keys, matching the TypeScript/JSON side of the house; Python
    attribute access stays snake_case. `extra="forbid"` is what makes an
    unexpected/renamed field a validation failure (quarantine) rather than
    a silently-dropped one."""

    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


class RawTeamRecord(_CamelModel):
    external_key: str = Field(min_length=1)
    nba_provider_id: str = Field(min_length=1)
    abbreviation: str = Field(min_length=2, max_length=4)
    name: str = Field(min_length=1)
    city: str = Field(min_length=1)
    conference: Literal["EAST", "WEST"]
    division: str = Field(min_length=1)
    color_primary: str = Field(pattern=r"^#[0-9A-Fa-f]{6}$")
    color_secondary: str = Field(pattern=r"^#[0-9A-Fa-f]{6}$")


class RawPlayerRecord(_CamelModel):
    external_key: str = Field(min_length=1)
    display_name: str = Field(min_length=1)
    legal_name: str = Field(min_length=1)
    dob: str
    team_external_key: str | None = None
    positions: list[EligiblePosition] = Field(min_length=1, max_length=2)
    status: Literal["ACTIVE", "INJURED", "UNSIGNED", "SUSPENDED"]
    unsigned: bool
    rookie: bool
    draft_year: int | None = None
    archetype: Literal["star", "starter", "rotation", "breakout", "decline", "rookie", "filler"]
    is_synthetic_filler: bool = False

    @field_validator("dob")
    @classmethod
    def _dob_is_date(cls, value: str) -> str:
        datetime.strptime(value, "%Y-%m-%d")  # noqa: DTZ007 - date-only field, no timezone expected
        return value

    @model_validator(mode="after")
    def _check_relationships(self) -> RawPlayerRecord:
        if self.unsigned != (self.status == "UNSIGNED"):
            raise ValueError("unsigned flag must match status == 'UNSIGNED'")
        if self.status == "UNSIGNED" and self.team_external_key is not None:
            raise ValueError("unsigned players must not have a team_external_key")
        if self.status != "UNSIGNED" and self.team_external_key is None:
            raise ValueError("non-unsigned players must have a team_external_key")
        if self.rookie and self.draft_year is None:
            raise ValueError("rookie players must have a draft_year")
        if self.status == "SUSPENDED" and not self.is_synthetic_filler:
            # Product-safety rule (docs/adr/0006), not merely a data-shape
            # rule: SUSPENDED is reputationally loaded, so this dataset never
            # attaches it to a real, named player — filler entries only.
            raise ValueError("SUSPENDED status is only permitted on synthetic filler players")
        return self


class RawSeasonStatRecord(_CamelModel):
    player_external_key: str = Field(min_length=1)
    season: str
    scope: StatScope
    games_played: int = Field(ge=0, le=82)
    minutes_total: float = Field(ge=0)
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
    three_pm: float = Field(ge=0)

    @model_validator(mode="after")
    def _valid_ranges(self) -> RawSeasonStatRecord:
        if self.scope == StatScope.NBA and not _SEASON_RE.match(self.season):
            raise ValueError(f"NBA-scope season must look like 'YYYY-YY', got {self.season!r}")
        if self.scope == StatScope.COLLEGE and not _COLLEGE_SEASON_RE.match(self.season):
            raise ValueError(
                f"COLLEGE-scope season must look like 'college-YYYY-YY', got {self.season!r}"
            )
        if self.fgm > self.fga:
            raise ValueError(f"fgm ({self.fgm}) exceeds fga ({self.fga})")
        if self.ftm > self.fta:
            raise ValueError(f"ftm ({self.ftm}) exceeds fta ({self.fta})")
        if self.three_pm > self.fgm:
            raise ValueError(f"three_pm ({self.three_pm}) exceeds fgm ({self.fgm})")
        return self


class RawAdpObservationRecord(_CamelModel):
    player_external_key: str = Field(min_length=1)
    source_external_key: str = Field(min_length=1)
    format: str = Field(min_length=1)
    season: str
    sample_size: int = Field(ge=1)
    adp: float = Field(gt=0, le=250)
    rank: int = Field(ge=1)
    captured_at: datetime

    @field_validator("season")
    @classmethod
    def _season_shape(cls, value: str) -> str:
        if not _SEASON_RE.match(value):
            raise ValueError(f"season must look like 'YYYY-YY', got {value!r}")
        return value


class RawNewsSignalRecord(_CamelModel):
    player_external_key: str = Field(min_length=1)
    type: SignalType
    impact: float = Field(ge=-1, le=1)
    confidence: float = Field(ge=0, le=1)
    rationale: str = Field(min_length=1)
    effective_at: datetime
    expires_at: datetime | None = None

    @model_validator(mode="after")
    def _expiry_after_effective(self) -> RawNewsSignalRecord:
        if self.expires_at is not None and self.expires_at <= self.effective_at:
            raise ValueError("expires_at must be after effective_at")
        return self


class RawProjectionOverrideSeedRecord(_CamelModel):
    player_external_key: str = Field(min_length=1)
    season: str
    stat: str = Field(min_length=1)
    delta_value: float | None = None
    replacement_value: float | None = None
    rationale: str = Field(min_length=1)
    effective_at: datetime
    expires_at: datetime | None = None

    @model_validator(mode="after")
    def _exactly_one_value(self) -> RawProjectionOverrideSeedRecord:
        set_count = sum(v is not None for v in (self.delta_value, self.replacement_value))
        if set_count != 1:
            raise ValueError("exactly one of delta_value/replacement_value must be set")
        if self.expires_at is not None and self.expires_at <= self.effective_at:
            raise ValueError("expires_at must be after effective_at")
        return self


RAW_RECORD_SCHEMAS: dict[str, type[BaseModel]] = {
    "team": RawTeamRecord,
    "player": RawPlayerRecord,
    "season_stat": RawSeasonStatRecord,
    "adp_observation": RawAdpObservationRecord,
    "news_signal": RawNewsSignalRecord,
    "projection_override_seed": RawProjectionOverrideSeedRecord,
}


__all__: list[str] = [
    "RAW_RECORD_SCHEMAS",
    "SUPPORTED_SCHEMA_VERSIONS",
    "RawAdpObservationRecord",
    "RawNewsSignalRecord",
    "RawPlayerRecord",
    "RawProjectionOverrideSeedRecord",
    "RawSeasonStatRecord",
    "RawTeamRecord",
]
