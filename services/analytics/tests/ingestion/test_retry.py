import random

import pytest

from app.ingestion.retry import RetryExhaustedError, RetryPolicy, call_with_retry


def test_succeeds_on_first_attempt_without_sleeping() -> None:
    calls = []

    def fn() -> str:
        calls.append(1)
        return "ok"

    sleeps: list[float] = []
    result = call_with_retry(fn, sleep=sleeps.append)

    assert result == "ok"
    assert len(calls) == 1
    assert sleeps == []


def test_retries_then_succeeds() -> None:
    attempts = {"count": 0}

    def fn() -> str:
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise ConnectionError("transient")
        return "recovered"

    sleeps: list[float] = []
    result = call_with_retry(
        fn,
        policy=RetryPolicy(max_attempts=5),
        sleep=sleeps.append,
        rng=random.Random(1),
    )

    assert result == "recovered"
    assert attempts["count"] == 3
    assert len(sleeps) == 2  # slept before attempt 2 and 3, not after final success


def test_raises_retry_exhausted_after_max_attempts() -> None:
    def fn() -> None:
        raise ConnectionError("always fails")

    with pytest.raises(RetryExhaustedError) as exc_info:
        call_with_retry(
            fn,
            policy=RetryPolicy(max_attempts=3),
            sleep=lambda _seconds: None,
            rng=random.Random(1),
        )

    assert exc_info.value.attempts == 3
    assert isinstance(exc_info.value.last_error, ConnectionError)


def test_non_retryable_exception_propagates_immediately() -> None:
    calls = {"count": 0}

    def fn() -> None:
        calls["count"] += 1
        raise ValueError("not retryable")

    with pytest.raises(ValueError, match="not retryable"):
        call_with_retry(
            fn,
            retryable=(ConnectionError,),
            sleep=lambda _seconds: None,
        )

    assert calls["count"] == 1


def test_delay_for_attempt_is_bounded_and_nonnegative() -> None:
    policy = RetryPolicy(base_delay_seconds=1.0, max_delay_seconds=4.0, jitter_ratio=0.5)
    rng = random.Random(42)
    for attempt in range(1, 10):
        delay = policy.delay_for_attempt(attempt, rng)
        assert delay >= 0.0
        assert delay <= policy.max_delay_seconds * (1 + policy.jitter_ratio)


def test_delay_grows_exponentially_before_hitting_cap() -> None:
    policy = RetryPolicy(base_delay_seconds=1.0, max_delay_seconds=100.0, jitter_ratio=0.0)
    rng = random.Random(1)
    assert policy.delay_for_attempt(1, rng) == pytest.approx(1.0)
    assert policy.delay_for_attempt(2, rng) == pytest.approx(2.0)
    assert policy.delay_for_attempt(3, rng) == pytest.approx(4.0)
