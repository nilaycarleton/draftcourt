"""Integration tests for the baseline projection publish pipeline against
a real Postgres connection. Every test runs inside a transaction rolled
back at teardown — same pattern and same reason as
tests/ingestion/test_pipeline_integration.py (see that file's docstring
for how to run these explicitly; a plain `uv run pytest` skips them).
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest
import pytest_asyncio
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from app.core.config import get_settings
from app.ingestion import db
from app.ingestion.file_adapter import DemoFileAdapter
from app.ingestion.pipeline import run_ingestion
from app.pipelines.run import publish_baseline_run


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


@pytest_asyncio.fixture
async def seeded_conn(conn: AsyncConnection) -> AsyncConnection:
    """A connection with the demo dataset already ingested (season stats
    are required for a meaningful projection run)."""
    result = await run_ingestion(conn, DemoFileAdapter())
    assert result.records_quarantined == 0
    assert result.unresolved_identities == 0
    return conn


class TestPublishBaselineRun:
    async def test_publishes_a_projection_for_every_player(
        self, seeded_conn: AsyncConnection
    ) -> None:
        result = await publish_baseline_run(seeded_conn, reason="test run")

        player_count = (await seeded_conn.execute(select(db.players.c.id))).all()
        projection_count = (
            await seeded_conn.execute(
                select(db.player_projections.c.id).where(
                    db.player_projections.c.runId == result.run_id
                )
            )
        ).all()
        assert len(projection_count) == len(player_count) == result.player_count

    async def test_run_is_marked_current_and_succeeded(self, seeded_conn: AsyncConnection) -> None:
        result = await publish_baseline_run(seeded_conn, reason="test run")
        row = (
            await seeded_conn.execute(
                select(db.projection_runs.c.status, db.projection_runs.c.isCurrent).where(
                    db.projection_runs.c.id == result.run_id
                )
            )
        ).first()
        assert row is not None
        assert row.status == "SUCCEEDED"
        assert row.isCurrent is True

    async def test_overall_ranks_are_unique_and_contiguous(
        self, seeded_conn: AsyncConnection
    ) -> None:
        result = await publish_baseline_run(seeded_conn, reason="test run")
        ranks = [
            row.overallRank
            for row in (
                await seeded_conn.execute(
                    select(db.player_projections.c.overallRank).where(
                        db.player_projections.c.runId == result.run_id
                    )
                )
            ).all()
        ]
        assert sorted(ranks) == list(range(1, result.player_count + 1))

    async def test_second_run_supersedes_first_atomically(
        self, seeded_conn: AsyncConnection
    ) -> None:
        first = await publish_baseline_run(seeded_conn, reason="first")
        second = await publish_baseline_run(seeded_conn, reason="second")

        current_runs = (
            await seeded_conn.execute(
                select(db.projection_runs.c.id).where(
                    db.projection_runs.c.season == "2026-27",
                    db.projection_runs.c.isCurrent.is_(True),
                )
            )
        ).all()
        assert len(current_runs) == 1
        assert str(current_runs[0].id) == second.run_id

        first_status = (
            await seeded_conn.execute(
                select(db.projection_runs.c.status, db.projection_runs.c.isCurrent).where(
                    db.projection_runs.c.id == first.run_id
                )
            )
        ).first()
        assert first_status is not None
        assert first_status.status == "SUCCEEDED"  # preserved, not deleted/overwritten
        assert first_status.isCurrent is False

    async def test_reproducible_on_unchanged_data(self, seeded_conn: AsyncConnection) -> None:
        first = await publish_baseline_run(seeded_conn, reason="first")
        second = await publish_baseline_run(seeded_conn, reason="second")
        assert first.input_checksum == second.input_checksum

        mismatches = (
            await seeded_conn.execute(
                select(db.player_projections.c.playerId)
                .where(db.player_projections.c.runId == first.run_id)
                .except_(
                    select(db.player_projections.c.playerId).where(
                        db.player_projections.c.runId == second.run_id
                    )
                )
            )
        ).all()
        # Every player present in both runs; spot-check pts equality directly.
        first_pts = {
            str(row.playerId): row.pts
            for row in (
                await seeded_conn.execute(
                    select(db.player_projections.c.playerId, db.player_projections.c.pts).where(
                        db.player_projections.c.runId == first.run_id
                    )
                )
            ).all()
        }
        second_pts = {
            str(row.playerId): row.pts
            for row in (
                await seeded_conn.execute(
                    select(db.player_projections.c.playerId, db.player_projections.c.pts).where(
                        db.player_projections.c.runId == second.run_id
                    )
                )
            ).all()
        }
        assert first_pts == second_pts
        assert mismatches == []


class TestOverridesAppliedInRun:
    async def test_active_override_shifts_published_projection(
        self, seeded_conn: AsyncConnection
    ) -> None:
        admin_id = (await seeded_conn.execute(select(db.users.c.id).limit(1))).scalar_one_or_none()
        if admin_id is None:
            # Fresh database (e.g. CI): the python users mirror is
            # read-only (id/clerkUserId/role), so the fallback admin row is
            # inserted with explicit SQL including the NOT NULL timestamps.
            # Locally this branch never runs because seeded/dev users exist.
            admin_id = str(uuid.uuid4())
            await seeded_conn.execute(
                text(
                    'INSERT INTO users (id, "clerkUserId", role, "createdAt", "updatedAt")'
                    " VALUES (:id, :clerk_user_id, :role, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                ),
                {"id": admin_id, "clerk_user_id": "test-admin-run", "role": "ADMIN"},
            )

        player_id = (await seeded_conn.execute(select(db.players.c.id).limit(1))).scalar_one()
        now = datetime.now(UTC)
        await seeded_conn.execute(
            db.projection_overrides.insert().values(
                id=str(uuid.uuid4()),
                projectionRunId=None,
                adminId=admin_id,
                playerId=player_id,
                season="2026-27",
                stat="pts",
                deltaValue=50.0,
                replacementValue=None,
                rationale="Integration test override.",
                status="ACTIVE",
                supersedesId=None,
                effectiveAt=now.replace(year=now.year - 1),
                expiresAt=None,
                createdAt=now,
                updatedAt=now,
            )
        )

        result = await publish_baseline_run(seeded_conn, reason="override test")

        pts = (
            await seeded_conn.execute(
                select(db.player_projections.c.pts).where(
                    db.player_projections.c.runId == result.run_id,
                    db.player_projections.c.playerId == player_id,
                )
            )
        ).scalar_one()
        # +50 delta on a per-game pts stat should push it well above any
        # plausible baseline projection.
        assert pts > 50.0
