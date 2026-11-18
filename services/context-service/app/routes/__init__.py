"""One module per OpenAPI tag: ops, context, connectors, decisions, approvals, jobs.

Handlers reach their collaborators through `audit_store`/`graph_store`/
`frozen_package`/`connector_registry`/`ingest_status`/`approval_store`, which read what
`create_app` attached.
Two reasons it lives here rather than in each router: an operation that needs one of
them fails with the same message whichever router it is in, and a collaborator that is
missing is a wiring bug in `app.main` — not a 500 a caller can do anything about, so it
raises.
"""

from __future__ import annotations

from fastapi import Request

from app.approvals import ApprovalStore
from app.audit import AuditStore
from app.connectors import ConnectorRegistry
from app.context_package import ContextPackage
from app.graph.port import GraphStore
from app.ingest_ledger import IngestStatus


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


def frozen_package(request: Request) -> ContextPackage:
    """The frozen Context Package this process serves (`create_app` attaches it)."""
    package = getattr(request.app.state, "context_package", None)
    if not isinstance(package, ContextPackage):
        raise RuntimeError(
            "this process has no Context Package; `create_app` loads one at startup and a service "
            "without it has no recipe to execute"
        )
    return package


def connector_registry(request: Request) -> ConnectorRegistry:
    """The Connectors this deployment registered (`create_app` attaches the registry)."""
    registry = getattr(request.app.state, "connectors", None)
    if not isinstance(registry, ConnectorRegistry):
        raise RuntimeError("this process has no Connector registry; `create_app` builds one at startup")
    return registry


def ingest_status(request: Request) -> IngestStatus:
    """The ledger's answer for `/readyz` and for `retrieve` (§9.2)."""
    status = getattr(request.app.state, "ingest_status", None)
    if not isinstance(status, IngestStatus):
        raise RuntimeError("this process has no ingest ledger; `create_app` opens one at startup")
    return status


def approval_store(request: Request) -> ApprovalStore:
    """The approval state machine `create_app` attached (over the audit store)."""
    store = getattr(request.app.state, "approvals", None)
    if not isinstance(store, ApprovalStore):
        raise RuntimeError(
            "this process has no approval store; `create_app` attaches one over the audit store "
            "it opens in the lifespan"
        )
    return store
