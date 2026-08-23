"""Process-wide SQLAlchemy async engine for the FastAPI request path.

The Typer CLIs create one engine per invocation and dispose it before exit;
a long-lived server process instead shares one lazily-created engine (pooled
connections) and disposes it on shutdown via the lifespan hook in
`app/main.py`. Nothing here issues DDL — Prisma remains the sole migration
owner (ADR 0002).
"""

from __future__ import annotations

from functools import lru_cache

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.core.config import get_settings


@lru_cache(maxsize=1)
def get_engine() -> AsyncEngine:
    return create_async_engine(get_settings().asyncpg_database_url)


async def dispose_engine() -> None:
    """Dispose the shared engine (FastAPI shutdown). Safe to call twice."""
    if get_engine.cache_info().currsize:  # pragma: no branch - trivial guard
        await get_engine().dispose()
        get_engine.cache_clear()


__all__: list[str] = ["dispose_engine", "get_engine"]
