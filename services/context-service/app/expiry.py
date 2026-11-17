"""Records that forget themselves, once.

Two things in this service remember a short-lived fact and must stop: the `jti` a
token has already used (until the token expires) and the `Idempotency-Key` a write
has claimed (for a day). Both need the same two behaviours, and they are easy to
confuse:

- **lookup is authoritative**: a record past its expiry is gone the moment it is
  asked for, because "retained for 24 hours" is a promise about meaning;
- **the sweep is for memory**: expired records are dropped periodically so a
  process that runs for weeks does not accumulate them.

Keeping the sweep as the *only* expiry check would silently extend every TTL to
the next sweep, which is why this type does both.
"""

from __future__ import annotations

import time
from collections.abc import Callable


class ExpiringRecords[K, V]:
    """A map whose entries carry an expiry, checked on read and swept in bulk."""

    #: How often expired entries are swept away, in seconds of this object's clock.
    SWEEP_INTERVAL_SECONDS = 60.0

    def __init__(self, *, now: Callable[[], float] | None = None) -> None:
        self._now = now if now is not None else time.time
        self._entries: dict[K, tuple[float, V]] = {}
        self._next_sweep = 0.0

    @property
    def now(self) -> float:
        """The clock this map reads, so a caller can stamp an entry consistently."""
        return self._now()

    def get(self, key: K) -> V | None:
        """The live entry for `key`, or `None` — an expired one is already gone."""
        entry = self._entries.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if expires_at < self._now():
            del self._entries[key]
            return None
        return value

    def put(self, key: K, value: V, *, expires_at: float) -> None:
        self._sweep_if_due()
        self._entries[key] = (expires_at, value)

    def _sweep_if_due(self) -> None:
        now = self._now()
        if now < self._next_sweep:
            return
        self._entries = {key: entry for key, entry in self._entries.items() if entry[0] >= now}
        self._next_sweep = now + self.SWEEP_INTERVAL_SECONDS

    def __len__(self) -> int:
        return len(self._entries)
