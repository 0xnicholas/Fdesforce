# PROTOTYPE — generated skeleton.
# Source: contracts/schemas/runtime-info.schema.json
from datetime import datetime, timezone

from . import settings

_STARTED_AT = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def runtime_info() -> dict:
    return {
        "contract_version": settings.CONTRACT_VERSION,
        "service": "context-service",
        "service_version": settings.SERVICE_VERSION,
        "graph_schema_version": "1",
        "audit_schema_version": "1",
        "backend": {"graph": settings.BACKEND, "audit": "sqlite"},
        "capabilities": [
            "context.retrieve",
            "decision.write",
            "provenance.read",
            "approval.manage",
            "ingest",
        ],
        "limits": {
            "max_nodes": settings.LIMITS["max_nodes"],
            "max_edges": settings.LIMITS["max_edges"],
            "max_request_timeout_ms": 30_000,
            "max_run_deadline_ms": 300_000,
        },
        "components": [
            {
                "name": "context-service",
                "version": settings.SERVICE_VERSION,
                "contract_version": settings.CONTRACT_VERSION,
                "status": "ready",
                "schema_version": "1",
            }
        ],
        "started_at": _STARTED_AT,
    }
