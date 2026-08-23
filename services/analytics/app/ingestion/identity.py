"""Player identity reconciliation, per BUILD_SPEC.md section 7.2:
"prioritize stable provider IDs; use normalized names and birth dates only
as secondary evidence; avoid automatic fuzzy merges below a documented
confidence threshold; create a reviewable unresolved state; preserve
aliases and provider mappings."

Two-stage resolution:

1. **Provider ID** (`PlayerExternalIdentity(sourceId, externalId)`) — if this
   exact (source, external key) pair was already confirmed on a prior
   ingestion run, it always wins. This is what makes re-running the same
   source idempotent (BUILD_SPEC.md: "idempotent reprocessing").
2. **Name + DOB** (secondary evidence, only reached when step 1 finds
   nothing) — normalized-name similarity via rapidfuzz, with a DOB exact
   match as a confidence bonus. Two documented thresholds:
   - `>= CONFIRM_THRESHOLD`: auto-link to the matched player.
   - `>= CANDIDATE_THRESHOLD` (but below CONFIRM): a plausible match, but
     not confident enough to auto-merge — written as a `CANDIDATE` row
     (BUILD_SPEC.md's "reviewable unresolved state") pointing at the
     best-guess player for an admin to confirm or reject.
   - below `CANDIDATE_THRESHOLD`: treated as a brand-new, previously
     unseen player.

Thresholds are deliberately conservative (see docs/adr/0006) — a false
auto-merge (two different real players collapsed into one) is worse than
an extra row sitting in the reviewable queue.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Literal

from rapidfuzz import fuzz

CONFIRM_THRESHOLD = 92.0
CANDIDATE_THRESHOLD = 75.0
DOB_MATCH_BONUS = 5.0

IdentityStatus = Literal["CONFIRMED", "CANDIDATE"]
IdentityMethod = Literal["PROVIDER_ID", "NAME_DOB"]


def normalize_name(name: str) -> str:
    return " ".join(name.strip().lower().split())


@dataclass(frozen=True, slots=True)
class ExistingPlayer:
    player_id: str
    display_name: str
    dob: date | None


@dataclass(frozen=True, slots=True)
class IdentityResolution:
    status: IdentityStatus
    method: IdentityMethod
    confidence: float
    player_id: str | None
    """None when status == CANDIDATE and no plausible existing player was
    found at all — i.e. this looks like a genuinely new player, not an
    ambiguous match against a known one."""


def resolve_by_provider_id(previously_confirmed_player_id: str | None) -> IdentityResolution | None:
    """Returns a resolution only when a prior CONFIRMED provider-id link
    exists; None means "fall through to name/DOB matching."""
    if previously_confirmed_player_id is None:
        return None
    return IdentityResolution(
        status="CONFIRMED",
        method="PROVIDER_ID",
        confidence=1.0,
        player_id=previously_confirmed_player_id,
    )


def resolve_by_name_dob(
    candidate_name: str,
    candidate_dob: date | None,
    existing_players: list[ExistingPlayer],
) -> IdentityResolution:
    normalized_candidate = normalize_name(candidate_name)
    best_player: ExistingPlayer | None = None
    best_score = 0.0

    for player in existing_players:
        score = float(
            fuzz.token_sort_ratio(normalized_candidate, normalize_name(player.display_name))
        )
        if candidate_dob is not None and player.dob is not None and candidate_dob == player.dob:
            score = min(score + DOB_MATCH_BONUS, 100.0)
        if score > best_score:
            best_score = score
            best_player = player

    confidence = best_score / 100.0

    if best_player is not None and best_score >= CONFIRM_THRESHOLD:
        return IdentityResolution(
            status="CONFIRMED",
            method="NAME_DOB",
            confidence=confidence,
            player_id=best_player.player_id,
        )
    if best_player is not None and best_score >= CANDIDATE_THRESHOLD:
        return IdentityResolution(
            status="CANDIDATE",
            method="NAME_DOB",
            confidence=confidence,
            player_id=best_player.player_id,
        )
    return IdentityResolution(
        status="CANDIDATE", method="NAME_DOB", confidence=confidence, player_id=None
    )


__all__: list[str] = [
    "CONFIRM_THRESHOLD",
    "CANDIDATE_THRESHOLD",
    "ExistingPlayer",
    "IdentityResolution",
    "normalize_name",
    "resolve_by_provider_id",
    "resolve_by_name_dob",
]
