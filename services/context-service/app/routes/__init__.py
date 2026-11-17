"""One module per OpenAPI tag: ops, context, decisions, approvals, jobs.

Handlers reach their stores through `audit_store`/`graph_store`, which read what
`create_app` attached in the lifespan. Two reasons it lives here rather than in each router: an
operation that needs the audit store or the graph store fails with the same message
whichever router it is in, and a store that is missing is a wiring bug in
`app.main` — not a 500 a caller can do anything about, so it raises.
"""

from __future__ import annotations

from fastapi import Request

from app.audit import AuditStore
from app.graph.port import GraphStore


def audit_store(request: Request) -> AuditStore:
    """The audit store `create_app` opened for this process."""
    store = getattr(request.app.state, "audit", None)
    if not isinstance(store, AuditStore):
        raise RuntimeError(
            "this process has no audit store; `create_app` attaches one and opens it in the lifespan"
        )
    return store


def graph_store(request: Request) -> GraphStore:
    """The graph store `create_app` opened for this process."""
    store = getattr(request.app.state, "graph", None)
    if store is None:
        raise RuntimeError(
            "this process has no graph store; `create_app` attaches one and opens it in the lifespan"
        )
    return store
