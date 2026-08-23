"""FastAPI entrypoint. This service is internal-only (BUILD_SPEC.md section
3.2) — browsers never call it directly; Next.js is the sole public boundary."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.responses import Response

from app.api.health import router as health_router
from app.api.internal import router as internal_router
from app.core.config import get_settings
from app.core.db_engine import dispose_engine
from app.core.logging import configure_logging
from app.core.sentry import init_sentry

configure_logging()
init_sentry(get_settings())


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield
    await dispose_engine()


async def _validation_problem(_: Request, __: RequestValidationError) -> Response:
    """Answer schema-version mismatches and malformed bodies with the same
    RFC 9457 shape the rest of the internal surface uses (field errors are
    safe: they describe the caller's own input, never server internals)."""
    return JSONResponse(
        status_code=422,
        content={
            "type": "/problems/validation-error",
            "title": "Validation Error",
            "status": 422,
            "detail": "request body failed schema validation",
        },
    )


app = FastAPI(
    title="DraftCourt Analytics",
    version="0.0.0",
    docs_url=None if get_settings().app_env == "production" else "/docs",
    openapi_url=None if get_settings().app_env == "production" else "/openapi.json",
    lifespan=lifespan,
)

app.include_router(health_router)
app.include_router(internal_router)
# Starlette's handler protocol narrows `Request` generically; FastAPI's own
# examples use this exact async two-arg shape.
app.add_exception_handler(RequestValidationError, _validation_problem)  # type: ignore[arg-type]
