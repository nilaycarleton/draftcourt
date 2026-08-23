from typing import Any, cast

from sentry_sdk.types import Event

from app.core.sentry import scrub_event


def make_event(data: dict[str, Any]) -> Event:
    return cast(Event, data)


def test_redacts_sensitive_request_headers() -> None:
    event = make_event(
        {"request": {"headers": {"Authorization": "Bearer secret-token", "User-Agent": "pytest"}}}
    )
    scrubbed = cast(dict[str, Any], scrub_event(event, {}))
    assert scrubbed["request"]["headers"]["Authorization"] == "[redacted]"
    assert scrubbed["request"]["headers"]["User-Agent"] == "pytest"


def test_redacts_cookies_entirely() -> None:
    event = make_event({"request": {"cookies": {"session": "abc123"}}})
    scrubbed = cast(dict[str, Any], scrub_event(event, {}))
    assert scrubbed["request"]["cookies"] == "[redacted]"


def test_redacts_token_secret_and_prompt_keys_in_request_data() -> None:
    event = make_event(
        {
            "request": {
                "data": {
                    "shareToken": "abc",
                    "analyticsServiceSecret": "def",
                    "aiPrompt": "tell me a secret",
                    "playerName": "Placeholder Player",
                }
            }
        }
    )
    scrubbed = cast(dict[str, Any], scrub_event(event, {}))
    data = scrubbed["request"]["data"]
    assert data["shareToken"] == "[redacted]"
    assert data["analyticsServiceSecret"] == "[redacted]"
    assert data["aiPrompt"] == "[redacted]"
    assert data["playerName"] == "Placeholder Player"


def test_redacts_email_addresses_in_string_values() -> None:
    event = make_event({"extra": {"note": "contact user at nilay@example.com for follow-up"}})
    scrubbed = cast(dict[str, Any], scrub_event(event, {}))
    assert scrubbed["extra"]["note"] == "contact user at [redacted-email] for follow-up"


def test_keeps_user_id_but_redacts_email() -> None:
    event = make_event({"user": {"id": "user_123", "email": "nilay@example.com"}})
    scrubbed = cast(dict[str, Any], scrub_event(event, {}))
    assert scrubbed["user"]["id"] == "user_123"
    assert scrubbed["user"]["email"] == "[redacted]"
