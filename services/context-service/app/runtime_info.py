"""`GET /v1/runtime-info`: this component's handshake document (§9.2, §10.1).

context-service reports **only itself**: its version, the contract minor it
speaks, the schema versions its stores are built to, its declared capabilities
and the limits a caller can rely on. It never describes the runtime app or its
state store — the aggregate the runtime app serves is the runtime app's to build
(`packages/runtime-generator-mastra/src/runtime-info.ts`, `aggregate`).

Every value is pinned elsewhere:

| Field | Source |
| --- | --- |
| `contract_version` | `contracts/README.md` current minor, via `scripts/generate.py` |
| `service_version` | `platform/toolchain.yaml` `versions.contextService` |
| `graph_schema_version` / `audit_schema_version` | `platform/toolchain.yaml` `spec.schemas` |
| `status` | the same readiness evaluation `/readyz` answers with |
| `capabilities`, `limits` | the platform contract (§4.3, §7.2), declared here |

The document is constructed through the generated `RuntimeInfo` model, so a field
the contract does not define — or a value outside an enum — fails here rather
than on the wire.
"""

from __future__ import annotations

from app.generated.models import ComponentInfo, Limits, RuntimeInfo, RuntimeInfoBackend
from app.generated.versions import (
    AUDIT_SCHEMA_VERSION,
    GRAPH_SCHEMA_VERSION,
    RUNTIME_CONTRACT_VERSION,
    SERVICE_VERSION,
)
from app.readiness import Readiness, ReadinessStatus
from app.settings import Settings

#: What this component offers a caller. The runtime app's A1 fixture uses the
#: same three names (`contract-tests.ts`), so the peer it tests against and the
#: peer it meets in a deployment agree.
CAPABILITIES: tuple[str, ...] = ("shared-graph", "semantic-ingest", "audit-append")

#: §7.2's ceilings and the embedded graph envelope (§4.3): 10k nodes / 50k edges,
#: a 30s context call, a 30-minute Run.
LIMITS: dict[str, int] = {
    "max_nodes": 10_000,
    "max_edges": 50_000,
    "max_request_timeout_ms": 30_000,
    "max_run_deadline_ms": 1_800_000,
}

_COMPONENT_STATUS = {
    "ready": "ready",
    "degraded": "degraded",
    "not_ready": "failed",
}


def component_status(readiness: ReadinessStatus) -> str:
    """The `ComponentInfo.status` this process would report for itself."""
    return _COMPONENT_STATUS[readiness]


def build_runtime_info(*, settings: Settings, readiness: Readiness, started_at: str) -> RuntimeInfo:
    """The document `GET /v1/runtime-info` serves."""
    status = component_status(readiness.evaluate().status)
    return RuntimeInfo(
        contract_version=RUNTIME_CONTRACT_VERSION,
        service="context-service",
        service_version=SERVICE_VERSION,
        graph_schema_version=GRAPH_SCHEMA_VERSION,
        audit_schema_version=AUDIT_SCHEMA_VERSION,
        backend=RuntimeInfoBackend(graph=settings.graph_backend, audit=settings.audit_backend),  # type: ignore[arg-type]
        capabilities=list(CAPABILITIES),
        limits=Limits(**LIMITS),
        components=[
            ComponentInfo(
                name="context-service",
                version=SERVICE_VERSION,
                contract_version=RUNTIME_CONTRACT_VERSION,
                status=status,  # type: ignore[arg-type]
            )
        ],
        started_at=started_at,
    )
