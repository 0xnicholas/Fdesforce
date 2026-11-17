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
    """`2026-01-01T00:00:00Z` — UTC, `Z` suffix, no `+00:00`."""
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
