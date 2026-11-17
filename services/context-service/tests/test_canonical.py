"""The one canonical form the audit chain and the idempotency fingerprint hash.

Two places in the service answer "is this the same payload?": the `Idempotency-Key`
middleware fingerprints a request body, and the audit store decides whether a
repeated `decision_id` carries the same Decision. If the two used different
canonical forms, a write could be a replay for one and a conflict for the other —
so the form is defined once here and both import it.

The expected values below are literal strings/hex, not recomputed from the
implementation: a test that hashes the way the code hashes cannot disagree with it.
"""

from __future__ import annotations

import pytest

from app.canonical import canonical_json, sha256_digest


def test_canonical_json_sorts_keys_and_drops_insignificant_whitespace() -> None:
    assert canonical_json({"b": 1, "a": [True, None, "x"]}) == '{"a":[true,null,"x"],"b":1}'


def test_canonical_json_preserves_non_ascii_rather_than_escaping_it() -> None:
    """The digest is over UTF-8 bytes; `\\u00e9` and `é` must not be two payloads."""
    assert canonical_json({"name": "café"}) == '{"name":"café"}'


def test_canonical_json_is_key_order_independent() -> None:
    first = canonical_json({"tenant_id": "acme", "decision_id": "dec_01ARZ3NDEKTSV4RRFFQ69G5FAV"})
    second = canonical_json({"decision_id": "dec_01ARZ3NDEKTSV4RRFFQ69G5FAV", "tenant_id": "acme"})

    assert first == second


def test_canonical_json_refuses_values_json_cannot_carry() -> None:
    """`NaN` is not JSON; a digest over it would depend on the writer's float printer."""
    with pytest.raises(ValueError):
        canonical_json({"score": float("nan")})


def test_sha256_digest_is_the_contract_digest_shape() -> None:
    digest = sha256_digest(canonical_json({"a": 1}))

    assert digest == "sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862"


def test_sha256_digest_hashes_the_concatenation_without_a_separator() -> None:
    """`hash = SHA-256(prev_hash || canonical_json(payload))` — exactly that.

    The literal is `sha256("sha256:genesis" + '{"a":1}')`, computed independently
    with `printf ... | shasum -a 256`.
    """
    assert (
        sha256_digest("sha256:genesis", canonical_json({"a": 1}))
        == "sha256:4e67036a0badd3a6a0a48aa64c633efa45a0f872670ed057c706cc0e052e6e25"
    )
