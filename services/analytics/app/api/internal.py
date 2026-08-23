"""`/internal/v1/*` — the service-authenticated HTTP surface ADR 0008's
background jobs were waiting on (BUILD_SPEC.md section 8.4). Browsers never
reach these routes: Next.js is the only intended caller, via
`apps/web/lib/server/analytics-client.ts`, which signs every request with
the shared service secret (`SERVICE_SECRET` here,
`ANALYTICS_SERVICE_SECRET` there).

Guarantees implemented here:

- **Auth**: bearer secret + request-timestamp replay window on every route
  (`app/core/security.py`).
- **Structured job state**: every POST writes one `analytics_jobs` row
  through its lifecycle (PENDING → RUNNING → SUCCEEDED | FAILED | TIMEOUT);
  `GET /internal/v1/jobs/:id` returns that row machine-readably.
- **Idempotency**: a request carrying `Idempotency-Key` maps to exactly one
  job per kind. Duplicate delivery of a SUCCEEDED job replays the recorded
  outcome (`X-Idempotent-Replay: true`) without re-running; FAILED/TIMEOUT
  jobs retry in place (same id/key, fresh attempt); a PENDING/RUNNING job
  whose start is older than two timeout windows is treated as orphaned by a
  restarted process and retried in place as well.
- **Concurrency control**: at most one RUNNING job per kind; a concurrent
  second submission gets an immediate 409 problem rather than silently
  queueing. This is single-instance Postgres-state concurrency control —
  honest about not needing Redis here.
- **Bounded timeouts**: work runs under `asyncio.wait_for`
  (`INTERNAL_JOB_TIMEOUT_SECONDS`, default 900s); expiry marks the job
  TIMEOUT and answers 504.
- **Trace propagation**: inbound `X-Trace-Id` (or a generated hex UUID)
  flows into the job row, structured logs, and every response.
- **Safe errors**: failures answer RFC 9457 problems; exception details and
  tracebacks stay in server-side structured logs, never in responses.

Pipeline work is invoked directly (`run_ingestion`, `publish_baseline_run`)
— never by shelling out to the Typer CLI — so local, CI, and production
behavior are identical. `/internal/v1/models/train` is deliberately absent:
the Phase 1 baseline is deterministic (no training stage exists to trigger;
"training" happens implicitly on each publish) and the trained ensemble is
Phase 4 scope — see ADR 0008 for the documented decision.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.config import Settings, get_settings
from app.core.db_engine import get_engine
from app.core.security import ServiceAuthError, verify_service_request
from app.ingestion import db
from app.ingestion.file_adapter import DemoFileAdapter
from app.ingestion.pipeline import IngestionRunResult, run_ingestion
from app.pipelines.evaluation import EvaluationReport, run_evaluation
from app.pipelines.report import build_eval_cases, write_report
from app.pipelines.run import MODEL_KEY, MODEL_VERSION, RunResult, publish_baseline_run

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/v1")

SUPPORTED_INGESTION_SOURCES = ("demo-file",)
JOB_KIND_INGESTION = "INGESTION"
JOB_KIND_PROJECTION_RUN = "PROJECTION_RUN"
JOB_KIND_MODEL_EVALUATION = "MODEL_EVALUATION"


class InternalJobRequest(BaseModel):
    """Body for internal POST endpoints. Unknown fields are rejected so a
    schema-version mismatch fails loudly instead of being silently ignored."""

    model_config = ConfigDict(extra="forbid")

    schema_version: str = Field(default="1", pattern=r"^\d+$")
    reason: str | None = None


class JobState(BaseModel):
    jobId: str
    kind: str
    status: str
    result: dict[str, Any] | None = None
    errorCode: str | None = None
    traceId: str
    startedAt: str
    finishedAt: str | None = None


# ---------------------------------------------------------------------------
# Problem-details helpers (RFC 9457; mirrors apps/web/lib/api/envelope.ts's
# problem shape — the analytics service has no browser-facing API so it
# answers plain problem JSON rather than the web `{data, error, meta}`
# envelope).
# ---------------------------------------------------------------------------


MAX_TRACE_ID_LENGTH = 128


def _problem(  # noqa: PLR0913, PLR0917 - explicit problem fields read clearer
    status: int,
    title: str,
    detail: str,
    type_slug: str,
    trace_id: str,
    extra_headers: dict[str, str] | None = None,
) -> JSONResponse:
    headers = {"X-Trace-Id": trace_id, **(extra_headers or {})}
    return JSONResponse(
        status_code=status,
        content={
            "type": f"/problems/{type_slug}",
            "title": title,
            "status": status,
            "detail": detail,
            "traceId": trace_id,
        },
        headers=headers,
    )


def _inbound_trace_id(request: Request) -> str:
    candidate = request.headers.get("X-Trace-Id", "").strip()
    if (
        candidate
        and len(candidate) <= MAX_TRACE_ID_LENGTH
        and all(c.isalnum() or c in "-_" for c in candidate)
    ):
        return candidate
    return uuid.uuid4().hex


async def _guard(
    request: Request,
    authorization: str | None,
    x_request_timestamp: str | None,
) -> tuple[str, JSONResponse | None]:
    """Shared auth + trace extraction. Returns `(trace_id, error_response)`;
    `error_response` is set exactly when authentication failed."""
    trace_id = _inbound_trace_id(request)
    try:
        verify_service_request(authorization, x_request_timestamp)
    except ServiceAuthError as error:
        logger.warning(
            "internal auth rejected",
            extra={"traceId": trace_id, "detail": "rejected"},
        )
        return trace_id, _problem(401, "Unauthorized", str(error), "unauthorized", trace_id)
    return trace_id, None


# ---------------------------------------------------------------------------
# Job store (analytics_jobs — table created by Prisma migration
# 20260822215704_add_analytics_jobs; accessed read/write via Core, per
# ADR 0002: Python never creates migrations).
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(UTC)


def _jsonable(value: Any) -> Any:
    """Coerce pipeline results (Decimal/UUID/datetime leaves included) into
    JSON-safe structures for the JSONB `result` column and responses."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


async def _find_job_by_idempotency_key(
    conn: AsyncConnection, kind: str, idempotency_key: str
) -> dict[str, Any] | None:
    row = await conn.execute(
        select(db.analytics_jobs).where(
            db.analytics_jobs.c.kind == kind,
            db.analytics_jobs.c.idempotencyKey == idempotency_key,
        )
    )
    found = row.mappings().first()
    return dict(found) if found else None


async def _running_job_exists(conn: AsyncConnection, kind: str) -> bool:
    row = await conn.execute(
        select(db.analytics_jobs.c.id).where(
            db.analytics_jobs.c.kind == kind,
            db.analytics_jobs.c.status == "RUNNING",
        )
    )
    return row.first() is not None


async def _insert_job(
    conn: AsyncConnection,
    *,
    kind: str,
    idempotency_key: str | None,
    request_summary: dict[str, Any],
    trace_id: str,
) -> str:
    job_id = str(uuid.uuid4())
    await conn.execute(
        db.analytics_jobs.insert().values(
            id=job_id,
            kind=kind,
            status="RUNNING",
            idempotencyKey=idempotency_key,
            request=_jsonable(request_summary),
            traceId=trace_id,
            startedAt=_now(),
        )
    )
    return job_id


async def _reset_job_for_retry(conn: AsyncConnection, job_id: str) -> None:
    await conn.execute(
        update(db.analytics_jobs)
        .where(db.analytics_jobs.c.id == job_id)
        .values(status="RUNNING", result=None, errorCode=None, startedAt=_now(), finishedAt=None)
    )


async def _mark_job(
    conn: AsyncConnection,
    job_id: str,
    *,
    status: str,
    result: dict[str, Any] | None,
    error_code: str | None,
) -> None:
    await conn.execute(
        update(db.analytics_jobs)
        .where(db.analytics_jobs.c.id == job_id)
        .values(
            status=status,
            result=_jsonable(result) if result is not None else None,
            errorCode=error_code,
            finishedAt=_now(),
        )
    )


async def _get_job_row(job_id: str) -> dict[str, Any] | None:
    async with get_engine().connect() as conn:
        found = (
            (await conn.execute(select(db.analytics_jobs).where(db.analytics_jobs.c.id == job_id)))
            .mappings()
            .first()
        )
    return dict(found) if found else None


# ---------------------------------------------------------------------------
# Work runners — the mapping is module state so tests can exercise
# orchestration (idempotency, timeout, failure paths) against the real
# database with injected stub runners; production always resolves the real
# functions below because tests restore what they replace.
# ---------------------------------------------------------------------------

WorkRunner = Callable[[AsyncConnection, InternalJobRequest], Awaitable[dict[str, Any]]]


async def _run_ingestion_work(_: AsyncConnection, __: InternalJobRequest) -> dict[str, Any]:
    engine = get_engine()
    async with engine.begin() as conn:
        raw: IngestionRunResult = await run_ingestion(conn, DemoFileAdapter())
    return {
        "runId": raw.run_id,
        "traceId": raw.trace_id,
        "status": raw.status,
        "recordsExtracted": raw.records_extracted,
        "recordsValidated": raw.records_validated,
        "recordsQuarantined": raw.records_quarantined,
        "recordsPublished": raw.records_published,
        "unresolvedIdentities": raw.unresolved_identities,
        "checksum": raw.checksum,
    }


async def _run_projection_publish_work(
    conn: AsyncConnection, body: InternalJobRequest
) -> dict[str, Any]:
    result: RunResult = await publish_baseline_run(
        conn, reason=body.reason or "scheduled baseline refresh"
    )
    return {
        "runId": result.run_id,
        "modelId": result.model_id,
        "season": result.season,
        "playerCount": result.player_count,
        "inputChecksum": result.input_checksum,
    }


async def _run_model_evaluation_work(
    conn: AsyncConnection, _: InternalJobRequest
) -> dict[str, Any]:
    cases = await build_eval_cases(conn)
    total_players = len((await conn.execute(select(db.players.c.id))).all())
    report: EvaluationReport = run_evaluation(
        cases, model_key=MODEL_KEY, model_version=MODEL_VERSION, cutoff_season="2025-26"
    )
    write_report(report, total_players=total_players)
    all_metrics = next(s for s in report.subgroups if s.subgroup == "all")
    evaluable = total_players - sum(report.not_evaluable_counts.values())
    return {
        "evaluablePlayers": evaluable,
        "totalPlayers": total_players,
        "fantasyPointsMae": all_metrics.fantasy_points_mae,
        "spearman": all_metrics.spearman_rank_correlation,
        "gamesMae": all_metrics.games_played_mae,
    }


WORK_RUNNERS: dict[str, WorkRunner] = {
    JOB_KIND_INGESTION: _run_ingestion_work,
    JOB_KIND_PROJECTION_RUN: _run_projection_publish_work,
    JOB_KIND_MODEL_EVALUATION: _run_model_evaluation_work,
}


# ---------------------------------------------------------------------------
# Submission orchestration shared by the POST endpoints.
# ---------------------------------------------------------------------------


def _job_state_response(row: dict[str, Any], *, replayed: bool) -> JSONResponse:
    payload = JobState(
        jobId=str(row["id"]),
        kind=str(row["kind"]),
        status=str(row["status"]),
        result=row["result"],
        errorCode=row["errorCode"],
        traceId=str(row["traceId"]),
        startedAt=_iso(row["startedAt"]),
        finishedAt=_iso(row["finishedAt"]),
    ).model_dump(mode="json")
    response = JSONResponse(status_code=200, content=payload)
    response.headers["X-Trace-Id"] = str(row["traceId"])
    if replayed:
        response.headers["X-Idempotent-Replay"] = "true"
    return response


def _iso(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


async def _submit_job(  # noqa: PLR0917 - mirrors the HTTP signature it serves
    request: Request,
    authorization: str | None,
    x_request_timestamp: str | None,
    idempotency_key: str | None,
    kind: str,
    body: InternalJobRequest,
) -> JSONResponse:
    trace_id, auth_error = await _guard(request, authorization, x_request_timestamp)
    if auth_error is not None:
        return auth_error

    settings: Settings = get_settings()
    request_summary: dict[str, Any] = {"schemaVersion": body.schema_version}
    if body.reason:
        request_summary["reason"] = body.reason[:200]

    engine = get_engine()
    async with engine.begin() as conn:
        existing = (
            await _find_job_by_idempotency_key(conn, kind, idempotency_key)
            if idempotency_key
            else None
        )
        if existing and _job_is_replayable(existing, settings):
            return _job_state_response(existing, replayed=True)

        # Either a fresh submission or an in-place retry of a FAILED/TIMEOUT
        # (or orphaned) job — both require the kind-level concurrency slot.
        if await _running_job_exists(conn, kind):
            return _problem(
                409,
                "Conflict",
                f"a {kind} job is already running; poll GET /internal/v1/jobs instead of queueing",
                "job-already-running",
                trace_id,
            )

        if existing:  # retryable (FAILED/TIMEOUT/orphaned): same id, fresh attempt
            await _reset_job_for_retry(conn, existing["id"])
            job_id = existing["id"]
        else:
            job_id = await _insert_job(
                conn,
                kind=kind,
                idempotency_key=idempotency_key,
                request_summary=request_summary,
                trace_id=trace_id,
            )

    return await _execute_and_respond(job_id, kind, body, trace_id, settings)


def _job_age_seconds(row: dict[str, Any]) -> float:
    started: datetime = row["startedAt"]
    if started.tzinfo is None:  # pragma: no cover - timestamptz is tz-aware
        started = started.replace(tzinfo=UTC)
    age = (datetime.now(UTC) - started).total_seconds()
    return max(0.0, float(age))


def _job_is_replayable(row: dict[str, Any], settings: Settings) -> bool:
    """SUCCEEDED replays forever; an in-flight job replays only while its
    start time is within twice the timeout window (past that it is an
    orphan from a dead process and becomes retryable)."""
    if row["status"] == "SUCCEEDED":
        return True
    if row["status"] in ("PENDING", "RUNNING"):
        return _job_age_seconds(row) <= 2 * settings.internal_job_timeout_seconds
    return False


def _job_is_retryable(row: dict[str, Any], settings: Settings) -> bool:
    if row["status"] in ("FAILED", "TIMEOUT"):
        return True
    # Orphaned in-flight job (process died mid-run): past 2× timeout, retry.
    return (
        row["status"] in ("PENDING", "RUNNING")
        and _job_age_seconds(row) > 2 * settings.internal_job_timeout_seconds
    )


async def _execute_and_respond(
    job_id: str,
    kind: str,
    body: InternalJobRequest,
    trace_id: str,
    settings: Settings,
) -> JSONResponse:
    runner = WORK_RUNNERS[kind]
    logger.info("internal job started", extra={"traceId": trace_id, "jobId": job_id, "kind": kind})
    try:
        async with get_engine().begin() as conn:
            result = await asyncio.wait_for(
                runner(conn, body), timeout=settings.internal_job_timeout_seconds
            )
    except TimeoutError:
        async with get_engine().begin() as conn:
            await _mark_job(conn, job_id, status="TIMEOUT", result=None, error_code="JOB_TIMEOUT")
        logger.error("internal job timed out", extra={"traceId": trace_id, "jobId": job_id})
        return _problem(
            504,
            "Job Timed Out",
            f"the {kind} job exceeded INTERNAL_JOB_TIMEOUT_SECONDS "
            f"({settings.internal_job_timeout_seconds:.0f}s) and was marked TIMEOUT",
            "job-timeout",
            trace_id,
            extra_headers={"X-Job-Id": job_id},
        )
    except Exception as error:  # noqa: BLE001 - converted to a safe problem below
        async with get_engine().begin() as conn:
            await _mark_job(
                conn, job_id, status="FAILED", result=None, error_code=type(error).__name__
            )
        # Full detail goes to server-side structured logs/Sentry only; the
        # response carries a safe summary with no exception text.
        logger.exception("internal job failed", extra={"traceId": trace_id, "jobId": job_id})
        del error
        return _problem(
            500,
            "Job Failed",
            "the pipeline failed; the job row records the state machine outcome",
            "job-failed",
            trace_id,
            extra_headers={"X-Job-Id": job_id},
        )

    async with get_engine().begin() as conn:
        await _mark_job(conn, job_id, status="SUCCEEDED", result=result, error_code=None)
    logger.info("internal job succeeded", extra={"traceId": trace_id, "jobId": job_id})
    row = await _get_job_row(job_id)
    assert row is not None  # written moments above in this process
    return _job_state_response(row, replayed=False)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/ingestion/{source}")
async def run_ingestion_endpoint(  # noqa: PLR0917 - mirrors the HTTP signature it serves
    source: str,
    request: Request,
    body: InternalJobRequest | None = None,
    authorization: str | None = Header(default=None),
    x_request_timestamp: str | None = Header(default=None),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if source not in SUPPORTED_INGESTION_SOURCES:
        trace_id = _inbound_trace_id(request)
        return _problem(
            404,
            "Not Found",
            f"unsupported ingestion source '{source}'; supported: "
            + ", ".join(SUPPORTED_INGESTION_SOURCES),
            "not-found",
            trace_id,
        )
    return await _submit_job(
        request,
        authorization,
        x_request_timestamp,
        idempotency_key,
        JOB_KIND_INGESTION,
        body or InternalJobRequest(),
    )


@router.post("/projections/run")
async def run_projections_endpoint(
    request: Request,
    body: InternalJobRequest | None = None,
    authorization: str | None = Header(default=None),
    x_request_timestamp: str | None = Header(default=None),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    return await _submit_job(
        request,
        authorization,
        x_request_timestamp,
        idempotency_key,
        JOB_KIND_PROJECTION_RUN,
        body or InternalJobRequest(),
    )


@router.post("/models/evaluate")
async def evaluate_models_endpoint(
    request: Request,
    body: InternalJobRequest | None = None,
    authorization: str | None = Header(default=None),
    x_request_timestamp: str | None = Header(default=None),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    return await _submit_job(
        request,
        authorization,
        x_request_timestamp,
        idempotency_key,
        JOB_KIND_MODEL_EVALUATION,
        body or InternalJobRequest(),
    )


@router.get("/jobs/{job_id}")
async def get_job_endpoint(
    job_id: str,
    request: Request,
    authorization: str | None = Header(default=None),
    x_request_timestamp: str | None = Header(default=None),
) -> JSONResponse:
    trace_id, auth_error = await _guard(request, authorization, x_request_timestamp)
    if auth_error is not None:
        return auth_error
    try:
        parsed = uuid.UUID(job_id)
    except ValueError:
        return _problem(404, "Not Found", "no such job", "not-found", trace_id)
    row = await _get_job_row(str(parsed))
    if row is None:
        return _problem(404, "Not Found", "no such job", "not-found", trace_id)
    return _job_state_response(row, replayed=False)


__all__: list[str] = [
    "JOB_KIND_INGESTION",
    "JOB_KIND_MODEL_EVALUATION",
    "JOB_KIND_PROJECTION_RUN",
    "SUPPORTED_INGESTION_SOURCES",
    "InternalJobRequest",
    "JobState",
    "WORK_RUNNERS",
    "router",
]
