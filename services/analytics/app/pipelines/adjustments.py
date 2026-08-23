"""Applies active `PlayerNewsSignal` and `ProjectionOverride` rows on top
of a computed baseline `ProjectedLine`, per BUILD_SPEC.md section 7.5:
"Every adjustment appears in the projection audit trail" — this module
returns not just the adjusted line but a plain-data record of exactly
which signals/overrides were applied, for the caller to persist alongside
the run (see `app.pipelines.run.publish_baseline_run`).

Signals feed `PlayerContext.active_role_signal_impact` *before* the
baseline is computed (see `app.pipelines.baseline`) — role/starter-change
signals shift the underlying rate. Overrides are applied *after* the
baseline, directly to specific stats, since they represent an explicit
admin correction to the model's output rather than a role-shaped input.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app.domain.contracts import ProjectedLine

ROLE_SIGNAL_TYPES = frozenset({"ROLE_UP", "ROLE_DOWN", "STARTER_CHANGE"})


@dataclass(frozen=True)
class ActiveSignal:
    id: str
    type: str
    impact: float
    confidence: float


@dataclass(frozen=True)
class ActiveOverride:
    id: str
    stat: str
    delta_value: float | None
    replacement_value: float | None
    rationale: str


def is_active(effective_at: datetime, expires_at: datetime | None, *, as_of: datetime) -> bool:
    if effective_at > as_of:
        return False
    return expires_at is None or expires_at > as_of


def role_signal_impact(signals: list[ActiveSignal]) -> float:
    """Confidence-weighted sum of active role-shaping signals, bounded to
    [-1, 1] — fed into `baseline.PlayerContext.active_role_signal_impact`.
    `ROLE_DOWN` is treated as a negative impact regardless of the sign the
    signal itself was recorded with, so admin/source data doesn't need to
    remember a sign convention."""
    total = 0.0
    for signal in signals:
        if signal.type not in ROLE_SIGNAL_TYPES:
            continue
        magnitude = abs(signal.impact) * signal.confidence
        total += -magnitude if signal.type == "ROLE_DOWN" else magnitude
    return max(-1.0, min(1.0, total))


@dataclass(frozen=True)
class AppliedAdjustment:
    override_id: str
    stat: str
    before: float
    after: float
    rationale: str


@dataclass(frozen=True)
class AdjustmentResult:
    line: ProjectedLine
    applied: list[AppliedAdjustment]


_OVERRIDABLE_STATS = frozenset(
    {
        "games",
        "minutesPerGame",
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
    }
)


def apply_overrides(line: ProjectedLine, overrides: list[ActiveOverride]) -> AdjustmentResult:
    """Applies each override's delta or replacement value to the matching
    stat, in the order given (later overrides in the list win on the same
    stat — callers should order by `effectiveAt` ascending so the most
    recent standing override applies last). Unknown stat keys are ignored
    rather than raising, so a validated-but-not-yet-projectable stat name
    can't break an entire run."""
    # by_alias=True: stat keys are the camelCase names used everywhere else
    # a stat is named (overrides, the API, the UI) — ProjectedLine's Python
    # field names are snake_case, which would silently mismatch otherwise.
    values: dict[str, Any] = line.model_dump(by_alias=True)
    applied: list[AppliedAdjustment] = []

    for override in overrides:
        if override.stat not in _OVERRIDABLE_STATS:
            continue
        before = values[override.stat]
        if override.replacement_value is not None:
            after = override.replacement_value
        else:
            assert override.delta_value is not None
            after = max(0.0, before + override.delta_value)
        values[override.stat] = after
        applied.append(
            AppliedAdjustment(
                override_id=override.id,
                stat=override.stat,
                before=before,
                after=after,
                rationale=override.rationale,
            )
        )

    return AdjustmentResult(line=ProjectedLine.model_validate(values), applied=applied)


__all__: list[str] = [
    "ROLE_SIGNAL_TYPES",
    "ActiveOverride",
    "ActiveSignal",
    "AdjustmentResult",
    "AppliedAdjustment",
    "apply_overrides",
    "is_active",
    "role_signal_impact",
]
