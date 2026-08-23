"""Canonical-JSON checksums, per BUILD_SPEC.md section 6.1: "Canonically
sort JSON keys/arrays, hash the input, and store the checksum." Used both
for raw-record dedup (BUILD_SPEC.md section 7.2: "Raw records are immutable
and checksum-addressed") and for projection input/reproducibility checksums.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json(value: Any) -> str:
    """Deterministic JSON serialization: sorted object keys, no extra
    whitespace. Array order is preserved as-is (arrays are already ordered
    data, not sets) — callers that need array-order independence must sort
    the array themselves before calling this."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str)


def checksum_of(value: Any) -> str:
    """sha256 hex digest of `value`'s canonical JSON form."""
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def checksum_of_many(values: list[Any]) -> str:
    """Order-independent aggregate checksum (e.g. every raw record checksum
    produced by one ingestion run) — sorts the individual digests first so
    the result doesn't depend on extraction order."""
    digests = sorted(checksum_of(value) for value in values)
    return hashlib.sha256("".join(digests).encode("utf-8")).hexdigest()


__all__: list[str] = ["canonical_json", "checksum_of", "checksum_of_many"]
