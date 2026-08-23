from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app

client = TestClient(app)


def test_live_returns_ok() -> None:
    response = client.get("/health/live")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "analytics"


def test_ready_reports_ok_with_reachable_database() -> None:
    """Environment-adaptive: when the gate/CI points DATABASE_URL at a real,
    migrated Postgres, readiness reports ok; without one it must degrade to
    503 rather than crash. The forced-unavailable path is covered by
    test_ready_reports_database_unavailable."""
    response = client.get("/health/ready")
    body = response.json()
    if "unavailable" in body["checks"]["database"]:
        assert response.status_code == 503
        assert body["status"] == "degraded"
    else:
        assert response.status_code == 200
        assert body["status"] == "ok"
        assert body["checks"]["database"] == "ok"


def test_ready_reports_database_unavailable() -> None:
    """Force an unreachable database regardless of environment so the
    graceful-degrade path (503 + explicit check detail) is always exercised,
    via FastAPI's supported dependency-override mechanism."""
    broken = SimpleNamespace(
        database_url="postgresql://draftcourt:draftcourt@localhost:9/unreachable"
    )
    app.dependency_overrides[get_settings] = lambda: broken
    try:
        response = client.get("/health/ready")
    finally:
        app.dependency_overrides.pop(get_settings, None)

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert "unavailable" in body["checks"]["database"]
