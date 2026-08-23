from app.ingestion.checksum import canonical_json, checksum_of, checksum_of_many


def test_canonical_json_sorts_keys() -> None:
    assert canonical_json({"b": 1, "a": 2}) == canonical_json({"a": 2, "b": 1})


def test_checksum_of_is_deterministic() -> None:
    payload = {"name": "Test Player", "team": "BOS", "stats": [1, 2, 3]}
    assert checksum_of(payload) == checksum_of(dict(payload))


def test_checksum_of_differs_for_different_payloads() -> None:
    assert checksum_of({"a": 1}) != checksum_of({"a": 2})


def test_checksum_of_key_order_independent() -> None:
    assert checksum_of({"a": 1, "b": 2}) == checksum_of({"b": 2, "a": 1})


def test_checksum_of_many_is_order_independent() -> None:
    values = [{"a": 1}, {"b": 2}, {"c": 3}]
    assert checksum_of_many(values) == checksum_of_many(list(reversed(values)))


def test_checksum_of_many_differs_for_different_sets() -> None:
    assert checksum_of_many([{"a": 1}]) != checksum_of_many([{"a": 1}, {"b": 2}])


def test_checksum_of_many_empty_list() -> None:
    assert checksum_of_many([]) == checksum_of_many([])
