"""The one wired `SourceAdapter` for Phase 1 — reads the committed,
deterministic demo dataset (`data/demo/*.json`) instead of a live external
endpoint.

BUILD_SPEC.md section 7.2 explicitly authorizes this: "If a reliable
permitted external NBA source cannot be used in the development
environment, implement a production-shaped file adapter around the
deterministic demo dataset." See docs/adr/0006-source-adapter-framework.md
for the full rationale and exactly what changes to add a live source later
— nothing in `app.ingestion.pipeline`, `schemas`, `identity`, or `db` is
adapter-specific; only a new `SourceAdapter` implementation and a new
`DataSource` registry row would be needed.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

from app.ingestion.base import DataSourceConfig, RawRecord

SCHEMA_VERSION = "1"


def _default_data_dir() -> Path:
    """Locate the demo dataset directory without assuming a checkout depth.

    In the monorepo, `services/analytics/app/ingestion/file_adapter.py` sits
    4 parents below the repo root. Inside the analytics container only
    `app/` is copied to `/app`, so `parents[4]` does not exist — indexing it
    raised IndexError at import and crashed the containerized service before
    its health check could ever pass (found by running the full gate's
    Docker step). Walking upward from this file finds `data/demo` in a real
    checkout and degrades to an explicit "dataset not found" error on use —
    never an import-time crash. Set DEMO_DATA_DIR to point elsewhere.
    """
    configured = os.getenv("DEMO_DATA_DIR")
    if configured:
        return Path(configured)
    probe = Path(__file__).resolve().parent
    while probe != probe.parent:
        candidate = probe / "data" / "demo"
        if candidate.is_dir():
            return candidate
        probe = probe.parent
    # No dataset anywhere up the tree (container): return the path relative
    # to this module's rootmost parent; using the adapter then fails loudly.
    return probe / "data" / "demo"


DEFAULT_DATA_DIR = _default_data_dir()

_FILES_BY_RECORD_TYPE: dict[str, str] = {
    "team": "teams.json",
    "player": "players.json",
    "season_stat": "player_season_stats.json",
    "adp_observation": "adp_observations.json",
    "news_signal": "news_signals.json",
    "projection_override_seed": "projection_overrides_seed.json",
}

# Fixed extraction order: teams and players first so downstream normalization
# can resolve a season-stat/adp/signal/override row's player/team reference
# in a single forward pass, and so extraction order (and therefore the
# ingestion run's aggregate checksum) is deterministic run to run.
_EXTRACTION_ORDER: tuple[str, ...] = (
    "team",
    "player",
    "season_stat",
    "adp_observation",
    "news_signal",
    "projection_override_seed",
)


def _external_key(record_type: str, row: dict[str, object]) -> str:
    """A stable, human-readable key per record — used for
    `RawSourceRecord.externalKey` and, for team/player rows, as the
    provider ID identity reconciliation prefers. Non-entity record types
    (stats/adp/signals/overrides) compose a key from their natural
    uniqueness so re-extracting the same fixture never looks like a new
    external entity."""
    if record_type in ("team", "player"):
        return str(row["externalKey"])
    if record_type == "season_stat":
        return f"{row['playerExternalKey']}:{row['season']}:{row['scope']}"
    if record_type == "adp_observation":
        return f"{row['playerExternalKey']}:{row['sourceExternalKey']}:{row['season']}"
    if record_type == "news_signal":
        return f"{row['playerExternalKey']}:{row['type']}:{row['effectiveAt']}"
    if record_type == "projection_override_seed":
        return f"{row['playerExternalKey']}:{row['stat']}:{row['effectiveAt']}"
    raise ValueError(f"unknown record_type: {record_type}")  # pragma: no cover - exhaustive above


class DemoFileAdapter:
    """Implements `app.ingestion.base.SourceAdapter`."""

    def __init__(self, data_dir: Path = DEFAULT_DATA_DIR) -> None:
        self.data_dir = data_dir

    @property
    def config(self) -> DataSourceConfig:
        return DataSourceConfig(
            name="demo-file-adapter",
            adapter_type="FILE",
            attribution=(
                "DraftCourt demo dataset — real NBA player/team/position facts "
                "paired with entirely fabricated statistics; see "
                "data/attribution/demo-dataset.md."
            ),
            permitted_uses=("demo", "development", "portfolio-review"),
            terms_url=None,
            rate_limit_per_minute=None,
            last_compliance_review_at=None,
        )

    def extract(self) -> Iterator[RawRecord]:
        fetched_at = datetime.now(UTC)
        for record_type in _EXTRACTION_ORDER:
            path = self.data_dir / _FILES_BY_RECORD_TYPE[record_type]
            rows = json.loads(path.read_text(encoding="utf-8"))
            for row in rows:
                yield RawRecord(
                    record_type=record_type,
                    external_key=_external_key(record_type, row),
                    payload=row,
                    fetched_at=fetched_at,
                    schema_version=SCHEMA_VERSION,
                )


__all__: list[str] = ["DEFAULT_DATA_DIR", "SCHEMA_VERSION", "DemoFileAdapter"]
