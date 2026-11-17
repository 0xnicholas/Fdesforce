"""The background `verify_chain` pass (§6.4, C13).

§6.4 is explicit about where verification runs: *not* on the read path. Walking a
hash chain is linear — the spike measured ~1s for 6.1k entries — so a provenance
read that verified would make the audit trail slower the more of it there is.

This task runs one pass at startup and then periodically. It records the result
in the store, which is the only thing the read path consults. Startup is
deliberate: a process that restarted onto an audit volume should say whether it
inherits a valid chain as soon as it can answer, and a chain that shrank while
the service was down must not read `valid` until someone looks.

A failed *pass* (an I/O error rather than a broken chain) leaves the previous
record alone and logs; marking the chain `invalid` because the disk was busy
would be a false accusation, and the next pass will try again.
"""

from __future__ import annotations

import asyncio
import logging

from app.audit import AuditStore

logger = logging.getLogger("fde.context_service.audit")

#: How often the chain is re-verified. Small enough that evidence is never long
#: unverified, large enough that the pass is not a busy loop; the cost is linear
#: in entries, so this is an operational knob, not a per-request one.
VERIFY_INTERVAL_SECONDS = 300.0


class ChainVerifier:
    """`AuditStore.verify_chain` on a timer, started and stopped with the process."""

    def __init__(self, store: AuditStore, *, interval_seconds: float = VERIFY_INTERVAL_SECONDS) -> None:
        self.store = store
        self.interval_seconds = interval_seconds
        self._stopped = asyncio.Event()

    async def run(self) -> None:
        """Verify now, then every `interval_seconds` until `stop()`."""
        while not self._stopped.is_set():
            try:
                await asyncio.to_thread(self.store.verify_chain)
            except Exception:  # noqa: BLE001 - a transient pass failure is not a verdict
                logger.exception("audit chain verification pass failed; the previous result stands")
            try:
                await asyncio.wait_for(self._stopped.wait(), timeout=self.interval_seconds)
            except TimeoutError:
                continue

    async def stop(self) -> None:
        """Ask `run()` to finish after the pass in flight."""
        self._stopped.set()
