"""Tests for the `/internal/v1/*` service-authenticated surface (ADR 0008).

Two layers, matching how this repository tests:

- **Orchestration tests** run against the real database but inject stub
  work runners (monkeypatching `app.api.internal.WORK_RUNNERS`) so every
  auth/idempotency/timeout/concurrency/state path is exercised without
  running real pipelines. Rows they create are cleaned up by trace-id
  prefix (`it-`).
- One **real-pipeline integration test** runs the actual demo-file
  ingestion through HTTP — it skips unless a migrated Postgres matching
  `DATABASE_URL` is reachable (same convention as
  `tests/ingestion/test_pipeline_integration.py`; point DATABASE_URL at
  docker-compose's 55432 mapping to include it).

Run: DATABASE_URL=postgresql://draftcourt:draftcourt@localhost:55432/draftcourt \\
  uv run pytest tests/api/
"""

from __future__ import annotations

import asyncio
import contextlib
import threading
import time
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.api.internal import WORK_RUNNERS
from app.core.config import get_settings
from app.main import app

SECRET = get_settings().service_secret


def _run_with_fresh_engine(statement: str) -> None:
    """Execute one statement on a throwaway engine.

    asyncpg connections are event-loop-bound, and each `asyncio.run` here is
    a different loop than the TestClient's — so test-side DB access must
    never share the app's pooled engine (`app.core.db_engine.get_engine`),
    only create/dispose its own.
    """

    async def _run() -> None:
        engine = create_async_engine(get_settings().asyncpg_database_url)
        try:
            async with engine.begin() as conn:
                await conn.execute(text(statement))
        finally:
            await engine.dispose()

    asyncio.run(_run())


async def _fetch_scalar(query: str) -> int:
    engine = create_async_engine(get_settings().asyncpg_database_url)
    try:
        async with engine.connect() as conn:
            return int((await conn.execute(text(query))).scalar_one())
    finally:
        await engine.dispose()


def _auth_headers(trace_id: str | None = None) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {SECRET}",
        "X-Request-Timestamp": str(int(time.time())),
    }
    if trace_id is not None:
        headers["X-Trace-Id"] = trace_id
    return headers


@pytest.fixture(autouse=True)
def _clean_job_rows() -> Iterator[None]:
    yield
    with contextlib.suppress(Exception):  # cleanup is best-effort (DB may be down)
        _run_with_fresh_engine("DELETE FROM analytics_jobs WHERE traceId LIKE 'it-%'")


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def ok_runner(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def _runner(conn: Any, body: Any) -> dict[str, Any]:
        del conn
        calls.append({"reason": body.reason})
        return {"ok": True, "reason": body.reason}

    monkeypatch.setitem(WORK_RUNNERS, "PROJECTION_RUN", _runner)
    return calls


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


class TestInternalAuth:
    def test_missing_authorization_is_401(self, client: TestClient) -> None:
        response = client.post(
            "/internal/v1/projections/run",
            headers={"X-Request-Timestamp": str(int(time.time()))},
            json={},
        )
        assert response.status_code == 401
        problem = response.json()
        assert problem["type"] == "/problems/unauthorized"
        assert problem["status"] == 401

    def test_wrong_secret_is_401(self, client: TestClient) -> None:
        headers = _auth_headers()
        headers["Authorization"] = "Bearer not-the-secret"
        assert (
            client.post("/internal/v1/projections/run", headers=headers, json={}).status_code == 401
        )

    def test_stale_timestamp_outside_replay_window_is_401(self, client: TestClient) -> None:
        stale_epoch = int(time.time()) - get_settings().service_auth_timestamp_window_seconds - 5
        headers = {"Authorization": f"Bearer {SECRET}", "X-Request-Timestamp": str(stale_epoch)}
        response = client.post("/internal/v1/projections/run", headers=headers, json={})
        assert response.status_code == 401
        assert "replay window" in response.json()["detail"]

    def test_future_timestamp_beyond_window_is_401(self, client: TestClient) -> None:
        future_epoch = int(time.time()) + get_settings().service_auth_timestamp_window_seconds + 5
        headers = {"Authorization": f"Bearer {SECRET}", "X-Request-Timestamp": str(future_epoch)}
        assert (
            client.post("/internal/v1/projections/run", headers=headers, json={}).status_code == 401
        )

    def test_non_integer_timestamp_is_401(self, client: TestClient) -> None:
        headers = {"Authorization": f"Bearer {SECRET}", "X-Request-Timestamp": "yesterday"}
        assert (
            client.post("/internal/v1/projections/run", headers=headers, json={}).status_code == 401
        )


# ---------------------------------------------------------------------------
# Job orchestration (stub runners; real analytics_jobs state)
# ---------------------------------------------------------------------------


class TestJobOrchestration:
    def test_success_marks_succeeded_and_returns_result(
        self, client: TestClient, ok_runner: list[dict[str, Any]]
    ) -> None:
        trace = f"it-{uuid.uuid4().hex}"
        response = client.post(
            "/internal/v1/projections/run",
            headers=_auth_headers(trace),
            json={"reason": "unit-test publish"},
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["status"] == "SUCCEEDED"
        assert payload["result"] == {"ok": True, "reason": "unit-test publish"}
        assert payload["traceId"] == trace
        assert ok_runner and ok_runner[0]["reason"] == "unit-test publish"

        fetched = client.get(f"/internal/v1/jobs/{payload['jobId']}", headers=_auth_headers())
        assert fetched.status_code == 200
        assert fetched.json()["status"] == "SUCCEEDED"

    def test_duplicate_delivery_with_same_key_replays_without_rerunning(
        self, client: TestClient, ok_runner: list[dict[str, Any]]
    ) -> None:
        key = f"it-key-{uuid.uuid4().hex}"
        first = client.post(
            "/internal/v1/projections/run",
            headers=_auth_headers() | {"Idempotency-Key": key},
            json={},
        )
        assert first.status_code == 200
        second = client.post(
            "/internal/v1/projections/run",
            headers=_auth_headers() | {"Idempotency-Key": key},
            json={},
        )
        assert second.status_code == 200
        assert second.headers.get("X-Idempotent-Replay") == "true"
        assert second.json()["jobId"] == first.json()["jobId"]
        assert len(ok_runner) == 1, "duplicate delivery must not re-run the job"

    def test_failed_publish_can_be_retried_in_place_with_same_key(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        attempts: list[int] = []

        async def flaky(_: Any, __: Any) -> dict[str, Any]:
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError("boom - simulated failed publish")
            return {"attempt": len(attempts)}

        monkeypatch.setitem(WORK_RUNNERS, "PROJECTION_RUN", flaky)
        key = f"it-key-{uuid.uuid4().hex}"
        headers = _auth_headers() | {"Idempotency-Key": key}

        failed = client.post("/internal/v1/projections/run", headers=headers, json={})
        assert failed.status_code == 500
        problem = failed.json()
        assert problem["type"] == "/problems/job-failed"
        assert "boom" not in problem["detail"], "exception text must not leak into responses"

        job_id = failed.headers["X-Job-Id"]
        failed_state = client.get(f"/internal/v1/jobs/{job_id}", headers=_auth_headers())
        assert failed_state.json()["status"] == "FAILED"
        assert failed_state.json()["errorCode"] == "RuntimeError"

        recovered = client.post("/internal/v1/projections/run", headers=headers, json={})
        assert recovered.status_code == 200
        payload = recovered.json()
        assert payload["status"] == "SUCCEEDED"
        assert payload["result"] == {"attempt": 2}
        assert payload["jobId"] == job_id, "retry reuses the same job row in place"
        assert len(attempts) == 2

    def test_timeout_marks_timeout_and_answers_504(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def slow(_: Any, __: Any) -> dict[str, Any]:
            await asyncio.sleep(5)
            return {}

        monkeypatch.setitem(WORK_RUNNERS, "PROJECTION_RUN", slow)
        monkeypatch.setattr(get_settings(), "internal_job_timeout_seconds", 0.2)
        response = client.post("/internal/v1/projections/run", headers=_auth_headers(), json={})
        assert response.status_code == 504
        assert response.json()["type"] == "/problems/job-timeout"
        assert "boom" not in response.json()["detail"]

        job_id = response.headers["X-Job-Id"]
        state = client.get(f"/internal/v1/jobs/{job_id}", headers=_auth_headers())
        assert state.json()["status"] == "TIMEOUT"
        assert state.json()["errorCode"] == "JOB_TIMEOUT"

    def test_concurrent_second_submission_conflicts_409(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        release = threading.Event()

        async def blocking(_: Any, __: Any) -> dict[str, Any]:
            while not release.is_set():
                await asyncio.sleep(0.05)
            return {}

        monkeypatch.setitem(WORK_RUNNERS, "PROJECTION_RUN", blocking)

        first_done = threading.Event()

        def _first() -> None:
            try:
                client.post("/internal/v1/projections/run", headers=_auth_headers(), json={})
            finally:
                first_done.set()

        thread = threading.Thread(target=_first, daemon=True)
        thread.start()
        try:
            running_seen = False
            for _ in range(50):
                count = asyncio.run(
                    _fetch_scalar(
                        "SELECT COUNT(*) FROM analytics_jobs "
                        "WHERE kind = 'PROJECTION_RUN' AND status = 'RUNNING'"
                    )
                )
                if count >= 1:
                    running_seen = True
                    break
                time.sleep(0.1)
            assert running_seen, "first job never reached RUNNING state"
            second = client.post("/internal/v1/projections/run", headers=_auth_headers(), json={})
            assert second.status_code == 409
            assert second.json()["type"] == "/problems/job-already-running"
        finally:
            release.set()
            thread.join(timeout=15)

    def test_unsupported_ingestion_source_is_404(self, client: TestClient) -> None:
        response = client.post("/internal/v1/ingestion/espn", headers=_auth_headers(), json={})
        assert response.status_code == 404
        assert response.json()["type"] == "/problems/not-found"

    def test_unknown_body_field_is_422_problem(self, client: TestClient) -> None:
        response = client.post(
            "/internal/v1/projections/run",
            headers=_auth_headers(),
            json={"unexpectedField": True},
        )
        assert response.status_code == 422
        assert response.json()["type"] == "/problems/validation-error"

    def test_jobs_endpoint_hides_unknown_ids(self, client: TestClient) -> None:
        missing = client.get(f"/internal/v1/jobs/{uuid.uuid4()}", headers=_auth_headers())
        assert missing.status_code == 404
        garbage = client.get("/internal/v1/jobs/not-a-uuid", headers=_auth_headers())
        assert garbage.status_code == 404

    def test_trace_id_propagates_into_response_and_row(
        self, client: TestClient, ok_runner: list[dict[str, Any]]
    ) -> None:
        trace = f"it-{uuid.uuid4().hex}"
        response = client.post(
            "/internal/v1/projections/run", headers=_auth_headers(trace), json={}
        )
        assert response.headers["X-Trace-Id"] == trace
        assert response.json()["traceId"] == trace
        del ok_runner


def _postgres_reachable() -> bool:
    try:
        _run_with_fresh_engine("SELECT 1")
        return True
    except Exception:  # noqa: BLE001
        return False


@pytest.mark.integration
def test_real_demo_file_ingestion_through_http(client: TestClient) -> None:
    if not _postgres_reachable():
        pytest.skip("Postgres not reachable at DATABASE_URL for integration tests")

    before = asyncio.run(_fetch_scalar("SELECT COUNT(*) FROM ingestion_runs"))
    response = client.post(
        "/internal/v1/ingestion/demo-file",
        headers=_auth_headers(),
        json={"reason": "internal-api integration test"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "SUCCEEDED"
    result = payload["result"]
    # recordsPublished may legitimately be 0 on an idempotent re-run against
    # an already-populated database (checksums dedupe) — extraction always
    # happens, and the ingestion_runs row must exist.
    assert result is not None and result["recordsExtracted"] > 0
    after = asyncio.run(_fetch_scalar("SELECT COUNT(*) FROM ingestion_runs"))
    assert after == before + 1

    duplicate = client.post(
        "/internal/v1/ingestion/demo-file",
        headers=_auth_headers() | {"Idempotency-Key": "it-integration-replay"},
        json={},
    )
    assert duplicate.status_code == 200
    assert duplicate.headers.get("X-Idempotent-Replay") == "true"
    assert asyncio.run(_fetch_scalar("SELECT COUNT(*) FROM ingestion_runs")) == after, (
        "replay must not re-run ingestion"
    )
