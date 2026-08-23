"""Environment validation for the analytics service, per BUILD_SPEC.md
section 15. Required variables fail fast at startup; optional integrations
(Sentry, model artifact storage, source base URLs) are allowed to be unset so
local development and CI can run without real secrets — see .env.example."""

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env.local", extra="ignore")

    app_env: Literal["development", "test", "production"] = "development"

    database_url: str
    service_secret: str

    # /internal/v1/* request-timestamp replay window (seconds of allowed clock
    # skew between web and analytics; see app/core/security.py).
    service_auth_timestamp_window_seconds: int = 300
    # Hard wall-clock cap for one internal job (ingestion/publish/evaluation)
    # before it is marked TIMEOUT — the "bounded timeouts" requirement of
    # ADR 0008. Sized above the demo pipeline's observed runtime with headroom.
    internal_job_timeout_seconds: float = 900.0

    sentry_dsn: str = ""
    sentry_environment: str = "development"

    model_artifact_bucket: str = ""
    model_artifact_access_key: str = ""
    model_artifact_secret_key: str = ""

    nba_source_base_url: str = ""
    injury_source_base_url: str = ""

    @property
    def sentry_configured(self) -> bool:
        return bool(self.sentry_dsn)

    @property
    def asyncpg_database_url(self) -> str:
        """`database_url` as a bare `postgresql://` URL (shared with plain
        `asyncpg.connect`, e.g. app/api/health.py) — SQLAlchemy's asyncio
        engine needs the explicit `+asyncpg` DBAPI marker instead."""
        if self.database_url.startswith("postgresql://"):
            return "postgresql+asyncpg://" + self.database_url[len("postgresql://") :]
        return self.database_url


@lru_cache
def get_settings() -> Settings:
    return Settings()


__all__: list[str] = ["Settings", "get_settings"]
