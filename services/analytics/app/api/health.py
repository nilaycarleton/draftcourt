"""Liveness/readiness endpoints, per BUILD_SPEC.md section 8.4. These are the
only analytics endpoints implemented in Phase 0; the internal
projection/ingestion/model endpoints are Phase 1+."""

from datetime import UTC, datetime
from typing import Annotated

import asyncpg
from fastapi import APIRouter, Depends, Response, status

from app.core.config import Settings, get_settings

router = APIRouter(prefix="/health", tags=["health"])


@router.get("/live")
async def live() -> dict[str, str]:
    return {"status": "ok", "service": "analytics"}


@router.get("/ready")
async def ready(
    response: Response,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, object]:
    checks: dict[str, str] = {}

    try:
        connection = await asyncpg.connect(settings.database_url, timeout=2)
        try:
            await connection.execute("SELECT 1")
        finally:
            await connection.close()
        checks["database"] = "ok"
    except (OSError, asyncpg.PostgresError) as error:
        checks["database"] = f"unavailable: {error}"
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    return {
        "status": "ok" if all(v == "ok" for v in checks.values()) else "degraded",
        "checks": checks,
        "timestamp": datetime.now(UTC).isoformat(),
    }


__all__: list[str] = ["router"]
