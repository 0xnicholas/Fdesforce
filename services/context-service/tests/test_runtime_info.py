"""`GET /v1/runtime-info` reports this component and nothing else (§9.1, §10.1).

The runtime app's handshake (`packages/runtime-generator-mastra/src/runtime-info.ts`)
refuses a peer that claims to be the runtime, that speaks another contract major,
or that reports different graph/audit schema versions. This test asserts the
document the real process serves *is* the schema, carries the platform's pins, and
lists only context-service — the peer's half of that comparison.
"""

from __future__ import annotations

from app.generated.api import OPERATIONS_BY_ID
from app.generated.versions import (
    AUDIT_SCHEMA_VERSION,
    GRAPH_SCHEMA_VERSION,
    RUNTIME_CONTRACT_VERSION,
    SERVICE_VERSION,
)
from app.runtime_info import CAPABILITIES, LIMITS
from conformance.documents import ContractDocuments
from conformance.harness import ServiceProcess


def test_runtime_info_is_the_contract_document(service: ServiceProcess, contract: ContractDocuments) -> None:
    operation = OPERATIONS_BY_ID["getRuntimeInfo"]
    assert operation.response_ref is not None

    response = service.get("/v1/runtime-info")

    assert response.status_code == 200
    body = response.json()
    contract.require(body, str(operation.response_ref), "runtime-info response")


def test_runtime_info_reports_only_itself_with_the_platform_pins(service: ServiceProcess) -> None:
    body = service.get("/v1/runtime-info").json()

    assert body["service"] == "context-service"
    assert body["service_version"] == SERVICE_VERSION
    assert body["contract_version"] == RUNTIME_CONTRACT_VERSION
    assert body["graph_schema_version"] == GRAPH_SCHEMA_VERSION
    assert body["audit_schema_version"] == AUDIT_SCHEMA_VERSION
    assert body["backend"] == {"graph": "embedded", "audit": "sqlite"}
    assert body["capabilities"] == list(CAPABILITIES)
    assert body["limits"] == LIMITS

    # `components[]` is this service's own component. The runtime app adds its own
    # entries when it aggregates; a peer that named one would publish it twice.
    assert [component["name"] for component in body["components"]] == ["context-service"]
    assert body["components"][0]["status"] == "ready"
    assert body["components"][0]["contract_version"] == RUNTIME_CONTRACT_VERSION


def test_runtime_info_needs_no_execution_context(service: ServiceProcess) -> None:
    """It is `security: []` in the contract: the handshake happens before a token."""
    response = service.get("/v1/runtime-info")

    assert response.status_code == 200


def test_started_at_is_rfc3339(service: ServiceProcess) -> None:
    body = service.get("/v1/runtime-info").json()

    started_at = body["started_at"]
    assert started_at.endswith("Z")
    assert started_at[4] == "-" and started_at[10] == "T"
