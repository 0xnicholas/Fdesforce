"""The one clock the service reads, in the one format the contract writes.

`Timestamp` in `contracts/schemas/common.schema.json` is RFC 3339; `started_at`
lands in `runtime-info`, so the format is part of the wire surface rather than a
logging convention.
"""

from __future__ import annotations

from datetime import UTC, datetime


def utc_now() -> datetime:
    return datetime.now(UTC)


def isoformat_z(moment: datetime) -> str:
    """`2026-01-01T00:00:00.000Z` — UTC, `Z` suffix, no `+00:00`."""
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_timestamp(value: str) -> datetime:
    """An RFC 3339 `Timestamp` as the aware `datetime` the service compares.

    The wire keeps the caller's spelling — a normalised value would change a digest
    computed over it — so anything that *compares* two timestamps (an `expires_at`
    against the clock) parses first: `2026-01-07T12:00:00Z` and
    `2026-01-07T13:00:00+01:00` are the same moment and not the same string.
    """
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
