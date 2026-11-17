"""What `/readyz` says about the graph (§9.2, §4.3).

The readiness registry (`app.readiness`) aggregates probes; this is the one the
graph owns. Two different questions, deliberately answered differently:

- **Can this process answer at all?** A store that is not loaded (or whose volume
  failed verification) is `failed` → `/readyz` 503 → the topology's healthcheck
  fails and the service is not routed to. There is no partial graph.
- **Is it still inside the promise?** A graph past the embedded ceiling is
  `degraded` → `/readyz` 200 with a reason. The process is correct and slow, and
  §4.3 says to say so rather than to time out; the caller sees the same fact as
  `degraded=true, reason=scale_limit` on the retrieval itself.

Keeping both here rather than in the endpoint is what lets an operator read one
answer that covers liveness, the graph, and (from #39) ingest alike.
"""

from __future__ import annotations

from app.graph.port import GraphStore
from app.limits import EMBEDDED_MAX_EDGES, EMBEDDED_MAX_NODES, over_ceiling
from app.readiness import ProbeResult


class GraphProbe:
    """`/readyz`'s view of the Context Graph volume."""

    name = "graph"

    def __init__(self, store: GraphStore) -> None:
        self._store = store

    def probe(self) -> ProbeResult:
        health = self._store.health()
        if not health.ok:
            return ProbeResult(status="failed", reason=health.reason or "unavailable")

        stats = self._store.stats()
        if over_ceiling(stats.nodes, stats.edges):
            return ProbeResult(
                status="degraded",
                reason=(
                    f"scale_limit ({stats.nodes} nodes / {stats.edges} edges over the embedded ceiling "
                    f"of {EMBEDDED_MAX_NODES}/{EMBEDDED_MAX_EDGES}; retrievals degrade, retries do not help)"
                ),
            )
        return ProbeResult(status="ok")
