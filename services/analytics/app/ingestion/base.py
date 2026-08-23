"""Source adapter interface, per BUILD_SPEC.md section 7.2 and
docs/adr/0006-source-adapter-framework.md. Any permitted source — a live
API, a licensed export, an admin CSV import, or (Phase 1's only wired
instance) a deterministic demo file — implements `SourceAdapter` and is
registered as a `DataSource` row. Nothing downstream of `extract()`
(checksum/dedup, validation, quarantine, normalization, identity
reconciliation, publish) is adapter-specific.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol


@dataclass(frozen=True)
class RawRecord:
    """One extracted record, not yet validated or persisted. `record_type`
    routes it to the matching Pydantic schema in `app.ingestion.schemas`
    (e.g. "team", "player", "season_stat", "adp_observation", "news_signal",
    "projection_override_seed" — see `RAW_RECORD_SCHEMAS`). `external_key`
    is the source's own stable identifier for this entity, used both for
    raw-record identification and, for player/team records, as the
    provider ID identity reconciliation prefers."""

    record_type: str
    external_key: str
    payload: dict[str, Any]
    fetched_at: datetime
    schema_version: str = "1"


@dataclass(frozen=True)
class DataSourceConfig:
    """Registration metadata for a `DataSource` row — every adapter declares
    this once. BUILD_SPEC.md section 20 / section 7.2: every source needs
    documented permitted use, attribution, and a compliance review date
    before it may run."""

    name: str
    adapter_type: str  # "FILE" | "API" — matches the Prisma SourceAdapterType enum
    attribution: str
    permitted_uses: tuple[str, ...]
    terms_url: str | None = None
    rate_limit_per_minute: int | None = None
    last_compliance_review_at: datetime | None = None


class SourceAdapter(Protocol):
    """Implement this against a real endpoint to add a live source later —
    see docs/adr/0006-source-adapter-framework.md for exactly what changes
    (this class and a new `DataSourceConfig`; nothing in
    `app.ingestion.pipeline` changes)."""

    @property
    def config(self) -> DataSourceConfig: ...

    def extract(self) -> Iterator[RawRecord]:
        """Yield every record currently available from this source. Callers
        wrap this in `app.ingestion.retry.call_with_retry` — implementations
        should raise on transient failure rather than swallowing it."""
        ...


@dataclass
class ExtractResult:
    """Bookkeeping `pipeline.py` accumulates while draining `extract()` —
    kept adapter-agnostic so a live adapter's partial-failure behavior slots
    into the same run-counting logic."""

    records: list[RawRecord] = field(default_factory=list)
    extract_errors: list[str] = field(default_factory=list)


__all__: list[str] = [
    "DataSourceConfig",
    "ExtractResult",
    "RawRecord",
    "SourceAdapter",
]
