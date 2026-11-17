"""The stable IDs the service mints (§4.2).

The service mints three of §4.2's ids: `provenance_id` (one audit entry),
`retrieval_id` (one Retrieval Snapshot) and, from #40, `approval_id`. `decision_id`
is the caller's — it is the Decision write's idempotency key — and `run_id` is the
runtime app's. The format is a ULID —
48-bit millisecond timestamp followed by 80 bits of randomness, in Crockford
base32 — because it is a 26-character opaque string the contract can validate
without the service ever handing out a counter.

`time.time_ns()` rather than `time.time()`: a float's millisecond is not exactly
representable for current epochs, and an ID whose timestamp rounds is an ID that
sorts wrong at a boundary.
"""

from __future__ import annotations

import secrets
import time

#: Crockford base32: no `I`, `L`, `O` or `U`, so an id read aloud is unambiguous.
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _encode(value: int, length: int) -> str:
    """`value` as `length` Crockford characters, most significant first."""
    characters: list[str] = []
    for _ in range(length):
        value, remainder = divmod(value, 32)
        characters.append(CROCKFORD[remainder])
    return "".join(reversed(characters))


def new_ulid(prefix: str) -> str:
    """`<prefix><26-char ULID>`, as §4.2 spells every stable runtime id."""
    timestamp_ms = time.time_ns() // 1_000_000
    randomness = int.from_bytes(secrets.token_bytes(10), "big")
    return f"{prefix}{_encode(timestamp_ms, 10)}{_encode(randomness, 16)}"


def new_provenance_id() -> str:
    """The audit entry id the service generates at write time (§6.2)."""
    return new_ulid("prov_")
