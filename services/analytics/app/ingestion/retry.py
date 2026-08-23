"""Bounded exponential backoff + jitter, per BUILD_SPEC.md section 7.2 /
section 14: "Retry idempotent jobs with exponential backoff/jitter; use
dead-letter state after bounded retries." Wraps any adapter call — including
the file adapter, so the pattern is real and unit-tested, not something only
a future live adapter exercises.
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from dataclasses import dataclass


class RetryExhaustedError(RuntimeError):
    """Raised after `max_attempts` failed attempts. Wraps the last error."""

    def __init__(self, attempts: int, last_error: BaseException) -> None:
        super().__init__(f"Exhausted {attempts} attempt(s); last error: {last_error}")
        self.attempts = attempts
        self.last_error = last_error


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 4
    base_delay_seconds: float = 0.25
    max_delay_seconds: float = 8.0
    jitter_ratio: float = 0.2

    def delay_for_attempt(self, attempt: int, rng: random.Random) -> float:
        """`attempt` is 1-indexed (delay before the *next* attempt after a
        failed attempt number `attempt`). Exponential with a capped ceiling
        and +/- jitter_ratio uniform jitter, never negative."""
        exponential: float = self.base_delay_seconds * (2 ** (attempt - 1))
        capped: float = min(exponential, self.max_delay_seconds)
        jitter: float = capped * self.jitter_ratio
        offset: float = rng.uniform(-jitter, jitter)
        return max(0.0, capped + offset)


def call_with_retry[T](
    fn: Callable[[], T],
    *,
    policy: RetryPolicy | None = None,
    retryable: tuple[type[BaseException], ...] = (Exception,),
    rng: random.Random | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    """Runs `fn()`, retrying on any exception type in `retryable` up to
    `policy.max_attempts` times total. Raises `RetryExhaustedError` wrapping
    the final failure once attempts are exhausted. Non-retryable exceptions
    propagate immediately without consuming a retry."""
    active_policy = policy or RetryPolicy()
    active_rng = rng or random.Random()

    last_error: BaseException | None = None
    for attempt in range(1, active_policy.max_attempts + 1):
        try:
            return fn()
        except retryable as error:  # noqa: PERF203 - retry loop, not a hot path
            last_error = error
            if attempt < active_policy.max_attempts:
                sleep(active_policy.delay_for_attempt(attempt, active_rng))

    assert last_error is not None  # noqa: S101 - loop always sets it before falling through
    raise RetryExhaustedError(active_policy.max_attempts, last_error)


__all__: list[str] = ["RetryExhaustedError", "RetryPolicy", "call_with_retry"]
