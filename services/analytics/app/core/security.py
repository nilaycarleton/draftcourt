"""Service-to-service request authentication for `/internal/v1/*` (BUILD_SPEC.md
section 8.4: "Require a rotating service token or signed request, private
network where available, request timestamp, replay window, and schema
version").

Every internal request must present:

- `Authorization: Bearer <SERVICE_SECRET>` — the shared service secret,
  compared with `hmac.compare_digest` so timing side channels can't recover
  it. Rotation = redeploying both services with a new value; no per-request
  signing scheme exists yet, which ADR 0008 documents honestly.
- `X-Request-Timestamp: <unix seconds>` — rejected when older/newer than
  `SERVICE_AUTH_TIMESTAMP_WINDOW_SECONDS` (default 300s). Combined with the
  idempotency-key deduplication in `app/api/internal.py`, this bounds the
  practical replay window: a captured request replayed after the window is
  always rejected outright, and within the window a duplicate delivery of an
  idempotent job returns its recorded outcome instead of re-executing.

Failures raise `ServiceAuthError`, mapped to a 401 problem by the handler in
`app/api/internal.py`. The error detail never echoes which factor failed for
an unauthenticated caller beyond "invalid or expired" — an attacker learns
nothing about whether the secret itself matched.
"""

from __future__ import annotations

import hmac
import time

from app.core.config import get_settings


class ServiceAuthError(Exception):
    """Raised when a request fails internal service authentication."""


def verify_service_secret(presented: str | None) -> None:
    settings = get_settings()
    if not presented:
        raise ServiceAuthError("missing Authorization header")
    scheme, _, credential = presented.partition(" ")
    if scheme.lower() != "bearer" or not credential:
        raise ServiceAuthError("Authorization header must use the Bearer scheme")
    if not hmac.compare_digest(credential.encode("utf-8"), settings.service_secret.encode("utf-8")):
        raise ServiceAuthError("invalid or expired service credentials")


def verify_request_timestamp(raw: str | None) -> None:
    settings = get_settings()
    if raw is None:
        raise ServiceAuthError("missing X-Request-Timestamp header")
    try:
        presented_at = int(raw)
    except ValueError as error:
        raise ServiceAuthError("X-Request-Timestamp must be integer unix seconds") from error
    skew = abs(time.time() - presented_at)
    if skew > settings.service_auth_timestamp_window_seconds:
        raise ServiceAuthError(
            "request timestamp outside the allowed replay window — check clock sync "
            "and retry with a fresh timestamp"
        )


def verify_service_request(authorization: str | None, x_request_timestamp: str | None) -> None:
    """Verify both factors; raises `ServiceAuthError` on the first failure."""
    verify_service_secret(authorization)
    verify_request_timestamp(x_request_timestamp)


__all__: list[str] = ["ServiceAuthError", "verify_service_request"]
