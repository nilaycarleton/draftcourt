"""Sentry scaffolding for the analytics service, mirroring the redaction
rules in apps/web/lib/sentry-redact.ts (BUILD_SPEC.md section 13). Strips
auth headers, cookies, tokens/secrets, prompts, and email/PII before an
event leaves the process. `scrub_event` is a pure function so redaction is
unit-testable without a live DSN — see tests/test_sentry_redact.py."""

import re
from typing import Any, cast

import sentry_sdk
from sentry_sdk.types import Event, Hint

from app.core.config import Settings

SENSITIVE_HEADER_NAMES = {
    "authorization",
    "cookie",
    "set-cookie",
    "x-clerk-auth-token",
    "x-clerk-session-id",
    "x-analytics-service-secret",
}

SENSITIVE_KEY_PATTERN = re.compile(
    r"token|secret|password|prompt|api[-_]?key|share[-_]?token|^email$", re.IGNORECASE
)
EMAIL_PATTERN = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")


def _redact_string(value: str) -> str:
    return EMAIL_PATTERN.sub("[redacted-email]", value)


def _redact_value(value: Any) -> Any:  # noqa: ANN401
    if isinstance(value, str):
        return _redact_string(value)
    if isinstance(value, list):
        return [_redact_value(item) for item in value]
    if isinstance(value, dict):
        return _redact_object(value)
    return value


def _redact_object(data: dict[str, Any]) -> dict[str, Any]:
    redacted: dict[str, Any] = {}
    for key, value in data.items():
        if SENSITIVE_KEY_PATTERN.search(key):
            redacted[key] = "[redacted]"
        else:
            redacted[key] = _redact_value(value)
    return redacted


def _redact_headers(headers: Any) -> Any:  # noqa: ANN401
    if not isinstance(headers, dict):
        return headers
    return {
        key: ("[redacted]" if key.lower() in SENSITIVE_HEADER_NAMES else value)
        for key, value in headers.items()
    }


def scrub_event(event: Event, hint: Hint) -> Event | None:
    """`before_send` hook — see sentry_sdk.init(before_send=...)."""
    del hint
    raw = cast(dict[str, Any], event)

    request = raw.get("request")
    if isinstance(request, dict):
        if "headers" in request:
            request["headers"] = _redact_headers(request["headers"])
        if "cookies" in request:
            request["cookies"] = "[redacted]"
        if "data" in request:
            request["data"] = _redact_value(request["data"])

    user = raw.get("user")
    if isinstance(user, dict):
        user_id = user.get("id")
        raw["user"] = {
            "id": user_id,
            **_redact_object({k: v for k, v in user.items() if k != "id"}),
        }

    if isinstance(raw.get("extra"), dict):
        raw["extra"] = _redact_object(raw["extra"])

    if isinstance(raw.get("contexts"), dict):
        raw["contexts"] = _redact_object(raw["contexts"])

    return event


def init_sentry(settings: Settings) -> None:
    if not settings.sentry_configured:
        return
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.sentry_environment,
        traces_sample_rate=0,
        before_send=scrub_event,
    )


__all__: list[str] = ["scrub_event", "init_sentry"]
