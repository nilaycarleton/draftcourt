"""Integration tests for the ingestion pipeline against a real Postgres
connection (BUILD_SPEC.md section 16.2: "ingestion quarantine,
deduplication, lineage, and atomic projection publish"). Every test runs
inside a transaction that is rolled back at teardown, so nothing here
touches the persistent demo dataset a real `cli.py demo` run produces.

Requires a reachable Postgres matching `DATABASE_URL` with Phase 1
migrations applied (docker compose's `postgres` service in local dev —
`DATABASE_URL=postgresql://draftcourt:draftcourt@localhost:55432/draftcourt
uv run pytest tests/ingestion/test_pipeline_integration.py`; a dedicated
migrated service container in CI, see `.github/workflows/ci.yml`'s
`analytics` job). `conftest.py`'s default `DATABASE_URL` intentionally
does *not* point here (other tests, e.g. `test_health.py`, rely on the
*default* being unreachable to exercise graceful-degradation behavior) —
so a plain `uv run pytest` with no override skips this file cleanly
instead of erroring, and only actually exercises it when explicitly
pointed at a real, migrated database.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from app.core.config import get_settings
from app.ingestion import db
from app.ingestion.base import DataSourceConfig, RawRecord
from app.ingestion.file_adapter import DemoFileAdapter
from app.ingestion.pipeline import run_ingestion


@pytest_asyncio.fixture
async def conn() -> AsyncIterator[AsyncConnection]:
    engine = create_async_engine(get_settings().asyncpg_database_url)
    try:
        connection = await engine.connect()
    except Exception as error:  # noqa: BLE001 - any connect-time failure means "skip", not "fail"
        await engine.dispose()
        pytest.skip(f"Postgres not reachable at DATABASE_URL for integration tests: {error}")
    try:
        transaction = await connection.begin()
        try:
            yield connection
        finally:
            await transaction.rollback()
    finally:
        await connection.close()
        await engine.dispose()


@dataclass
class _StaticAdapter:
    """A minimal in-test `SourceAdapter` for scenarios the committed demo
    fixture doesn't (and shouldn't) encode — malformed payloads, and
    cross-source name/DOB collisions."""

    name: str
    records: list[RawRecord]

    @property
    def config(self) -> DataSourceConfig:
        return DataSourceConfig(
            name=self.name,
            adapter_type="FILE",
            attribution="Test fixture — not real data.",
            permitted_uses=("test",),
        )

    def extract(self) -> Iterator[RawRecord]:
        return iter(self.records)


def _team_record() -> RawRecord:
    return RawRecord(
        record_type="team",
        external_key="test-team-ZZZ",
        payload={
            "externalKey": "test-team-ZZZ",
            "nbaProviderId": "test-team-ZZZ",
            "abbreviation": "ZZZ",
            "name": "Test Team",
            "city": "Testville",
            "conference": "EAST",
            "division": "ATLANTIC",
            "colorPrimary": "#007A33",
            "colorSecondary": "#BA9653",
        },
        fetched_at=datetime.now(UTC),
    )


def _player_record(
    external_key: str, display_name: str, dob: str, *, team_key: str = "test-team-ZZZ"
) -> RawRecord:
    return RawRecord(
        record_type="player",
        external_key=external_key,
        payload={
            "externalKey": external_key,
            "displayName": display_name,
            "legalName": display_name,
            "dob": dob,
            "teamExternalKey": team_key,
            "positions": ["SF"],
            "status": "ACTIVE",
            "unsigned": False,
            "rookie": False,
            "draftYear": None,
            "archetype": "starter",
            "isSyntheticFiller": False,
        },
        fetched_at=datetime.now(UTC),
    )


class TestFullIngestionRun:
    async def test_demo_adapter_runs_cleanly_end_to_end(self, conn: AsyncConnection) -> None:
        result = await run_ingestion(conn, DemoFileAdapter())

        assert result.status == "SUCCEEDED"
        assert result.records_extracted > 0
        assert result.records_quarantined == 0
        assert result.records_published == result.records_validated
        assert result.unresolved_identities == 0

        published_players = (await conn.execute(select(db.players.c.id))).all()
        assert len(published_players) > 0

    async def test_rerun_is_idempotent(self, conn: AsyncConnection) -> None:
        first = await run_ingestion(conn, DemoFileAdapter())
        second = await run_ingestion(conn, DemoFileAdapter())

        assert second.records_extracted == first.records_extracted
        assert second.records_validated == 0
        assert second.records_published == 0
        assert second.checksum == first.checksum

        raw_count = (await conn.execute(select(db.raw_source_records.c.id))).all()
        assert len(raw_count) == first.records_extracted  # no duplicate raw rows


class TestQuarantine:
    async def test_malformed_record_is_quarantined_not_published(
        self, conn: AsyncConnection
    ) -> None:
        bad_stat = RawRecord(
            record_type="season_stat",
            external_key="test-player-0001:2025-26:NBA",
            payload={
                "playerExternalKey": "test-player-0001",
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
                "fgm": 1200.0,  # deliberately invalid: fgm > fga
                "fga": 1100.0,
                "ftm": 200.0,
                "fta": 250.0,
                "threePm": 100.0,
            },
            fetched_at=datetime.now(UTC),
        )
        adapter = _StaticAdapter(
            name="test-quarantine-source",
            records=[
                _team_record(),
                _player_record("test-player-0001", "Quarantine Test Player", "2000-01-01"),
                bad_stat,
            ],
        )

        result = await run_ingestion(conn, adapter)

        assert result.records_quarantined == 1
        assert result.records_extracted == 3

        raw = (
            await conn.execute(
                select(
                    db.raw_source_records.c.status, db.raw_source_records.c.validationErrors
                ).where(db.raw_source_records.c.externalKey == "test-player-0001:2025-26:NBA")
            )
        ).first()
        assert raw is not None
        assert raw.status == "QUARANTINED"
        assert raw.validationErrors is not None

    async def test_unknown_record_type_is_quarantined(self, conn: AsyncConnection) -> None:
        weird = RawRecord(
            record_type="not_a_real_type",
            external_key="whatever",
            payload={"anything": "goes"},
            fetched_at=datetime.now(UTC),
        )
        adapter = _StaticAdapter(name="test-unknown-type-source", records=[weird])

        result = await run_ingestion(conn, adapter)

        assert result.records_quarantined == 1
        assert result.records_published == 0


class TestDuplicateDetection:
    async def test_identical_payload_extracted_twice_in_one_run_is_deduped(
        self, conn: AsyncConnection
    ) -> None:
        team = _team_record()
        adapter = _StaticAdapter(name="test-dup-source", records=[team, team])

        result = await run_ingestion(conn, adapter)

        assert result.records_extracted == 2
        assert result.records_published == 1  # second copy deduped by checksum

        raw_rows = (
            await conn.execute(
                select(db.raw_source_records.c.id).where(
                    db.raw_source_records.c.externalKey == "test-team-ZZZ"
                )
            )
        ).all()
        assert len(raw_rows) == 1


class TestUnresolvedIdentity:
    async def test_cross_source_similar_name_creates_reviewable_candidate(
        self, conn: AsyncConnection
    ) -> None:
        """Two different sources report what might be the same real person
        under two different external IDs with a similar-but-not-identical
        name: this must never auto-merge, and must never silently drop the
        second report — it lands as a reviewable CANDIDATE identity."""
        first_source = _StaticAdapter(
            name="test-source-a",
            records=[
                _team_record(),
                _player_record("source-a-001", "Zzedrik Quovlaxen", "1996-03-03"),
            ],
        )
        first_result = await run_ingestion(conn, first_source)
        assert first_result.unresolved_identities == 0
        assert first_result.records_published == 2

        second_source = _StaticAdapter(
            name="test-source-b",
            records=[
                RawRecord(
                    record_type="team",
                    external_key="test-team-ZZZ",
                    payload=_team_record().payload,
                    fetched_at=datetime.now(UTC),
                ),
                # Deliberately a different DOB: the name similarity alone
                # (~92%) sits in the CANDIDATE band; a *matching* DOB would
                # add a confidence bonus that pushes this specific pair into
                # the CONFIRM band instead (see test_dob_match_plus_similar_
                # name_confirms_instead_of_flagging below) — both are
                # correct, threshold-driven outcomes.
                _player_record("source-b-001", "Zzedrik Quovlaxen Jr", "1998-11-20"),
            ],
        )
        second_result = await run_ingestion(conn, second_source)

        # The near-duplicate name (with a matching DOB, boosting
        # confidence) must be flagged for review, not silently merged into
        # the source-a player and not silently published as an
        # unrelated new player either.
        assert second_result.unresolved_identities == 1
        assert second_result.records_published == 1  # only the team record

        candidate = (
            await conn.execute(
                select(
                    db.player_external_identities.c.status,
                    db.player_external_identities.c.playerId,
                    db.player_external_identities.c.matchMethod,
                ).where(db.player_external_identities.c.externalId == "source-b-001")
            )
        ).first()
        assert candidate is not None
        assert candidate.status == "CANDIDATE"
        assert candidate.playerId is None
        assert candidate.matchMethod == "NAME_DOB"

    async def test_dob_match_plus_similar_name_confirms_instead_of_flagging(
        self, conn: AsyncConnection
    ) -> None:
        """A matching DOB is a confidence *bonus* (BUILD_SPEC.md section
        7.2's "secondary evidence"), not just a tiebreaker: the same name
        similarity that lands as CANDIDATE without a DOB match (see above)
        auto-confirms once the DOB also matches and the combined score
        clears CONFIRM_THRESHOLD — this is the intended cross-source
        "same real person" reconciliation path, not a false positive."""
        first_source = _StaticAdapter(
            name="test-source-a",
            records=[
                _team_record(),
                _player_record("dobmatch-a-001", "Wexley Thorngale", "1999-04-12"),
            ],
        )
        first_result = await run_ingestion(conn, first_source)
        assert first_result.unresolved_identities == 0
        first_player_id = (
            await conn.execute(
                select(db.player_external_identities.c.playerId).where(
                    db.player_external_identities.c.externalId == "dobmatch-a-001"
                )
            )
        ).scalar_one()

        second_source = _StaticAdapter(
            name="test-source-d",
            records=[
                RawRecord(
                    record_type="team",
                    external_key="test-team-ZZZ",
                    payload=_team_record().payload,
                    fetched_at=datetime.now(UTC),
                ),
                _player_record("dobmatch-d-001", "Wexley Thorngale Jr", "1999-04-12"),
            ],
        )
        second_result = await run_ingestion(conn, second_source)

        assert second_result.unresolved_identities == 0
        identity = (
            await conn.execute(
                select(
                    db.player_external_identities.c.status,
                    db.player_external_identities.c.playerId,
                    db.player_external_identities.c.matchMethod,
                ).where(db.player_external_identities.c.externalId == "dobmatch-d-001")
            )
        ).first()
        assert identity is not None
        assert identity.status == "CONFIRMED"
        assert identity.matchMethod == "NAME_DOB"
        assert identity.playerId == first_player_id  # linked to the same real person

    async def test_completely_different_name_is_published_as_new_player(
        self, conn: AsyncConnection
    ) -> None:
        first_source = _StaticAdapter(
            name="test-source-a",
            records=[
                _team_record(),
                _player_record("source-a-002", "Someone Distinctive", "1990-01-01"),
            ],
        )
        await run_ingestion(conn, first_source)

        second_source = _StaticAdapter(
            name="test-source-c",
            records=[
                RawRecord(
                    record_type="team",
                    external_key="test-team-ZZZ",
                    payload=_team_record().payload,
                    fetched_at=datetime.now(UTC),
                ),
                _player_record("source-c-001", "Totally Different Person", "2003-06-15"),
            ],
        )
        result = await run_ingestion(conn, second_source)

        assert result.unresolved_identities == 0
        assert result.records_published == 2  # the re-submitted team (updated) + the new player
