"""`POST /v1/connectors/{connector_id}/operations`: the Tool's one seam (§3.3, D6).

A Connector-backed Tool (`claims-lookup` in the Acme Solution) reaches the customer's
data source through this endpoint and nowhere else. What the tests pin is exactly what
that arrangement is for: the Tool cannot name a Connector the deployment did not
register, cannot run an operation the Connector does not declare, cannot see a class of
data its `ExecutionContext` holds no scope for, and the answer it does get carries a
digest a Decision can cite.
"""

from __future__ import annotations

import re
import shutil
from collections.abc import Iterator

import pytest
import yaml

from conformance.documents import ContractDocuments
from conformance.harness import REFERENCE_PACKAGE, ServiceProcess

RESPONSE = "connector.schema.json#/$defs/ConnectorOperationResponse"
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")

#: `claims-lookup`'s arguments, as its pinned input schema declares them.
LOOKUP = {"connector_id": "claims-db", "operation": "lookupClaim", "input": {"claimId": "C-1001"}}


@pytest.fixture(scope="module")
def claims_service() -> Iterator[ServiceProcess]:
    with ServiceProcess.start() as process:
        yield process


def call(service: ServiceProcess, body: dict, scopes: tuple[str, ...]) -> dict:
    response = service.post(
        "/v1/connectors/claims-db/operations",
        json=body,
        headers=service.authorized(scopes=("context:retrieve", *scopes)),
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_a_typed_operation_returns_the_shape_the_tool_pinned(
    claims_service: ServiceProcess, contract: ContractDocuments
) -> None:
    response = claims_service.post(
        "/v1/connectors/claims-db/operations",
        json=LOOKUP,
        headers=claims_service.authorized(scopes=["context:retrieve", "claims:read"]),
    )

    assert response.status_code == 200, response.text
    body = response.json()
    contract.require(body, RESPONSE, "connector operation response")
    assert body["connector_id"] == "claims-db"
    assert body["operation"] == "lookupClaim"
    assert body["result"] == {
        "claimId": "C-1001",
        "policyNumber": "P-2001",
        "customerId": "CU-42",
        "amount": 12000,
        "status": "review",
    }
    assert body["classification"] == "confidential"
    assert DIGEST.match(body["output_digest"]), body["output_digest"]


def test_the_result_carries_the_callers_trace_and_a_stable_digest(
    claims_service: ServiceProcess,
) -> None:
    """Two identical calls are one digest: the Tool's outcome can be cited, not re-stored."""
    headers = claims_service.authorized(scopes=["context:retrieve", "claims:read"])
    trace_id = headers["traceparent"].split("-")[1]
    first = claims_service.post("/v1/connectors/claims-db/operations", json=LOOKUP, headers=headers)
    second = claims_service.post(
        "/v1/connectors/claims-db/operations",
        json=LOOKUP,
        headers=claims_service.authorized(scopes=["context:retrieve", "claims:read"]),
    )

    assert first.json()["trace_id"] == trace_id
    assert first.json()["output_digest"] == second.json()["output_digest"]


def test_a_class_the_baseline_does_not_classify_is_restricted_not_the_connectors_claim(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    """§7.1's fail-closed default applies to the Tool seam too: the baseline decides.

    `claims-db` says `lookupClaim` is about a `confidential` class. If the permission
    baseline has no entry for that class, the answer is `restricted`, not the
    Connector's own opinion — otherwise a Tool and a retrieval could disagree about
    the same claim's classification.
    """
    package = tmp_path_factory.mktemp("unclassified-connector") / "package"
    shutil.copytree(REFERENCE_PACKAGE, package)
    permissions_path = package / "permissions.yaml"
    permissions = yaml.safe_load(permissions_path.read_text(encoding="utf-8"))
    permissions["spec"]["classifications"].pop("ic:Claim")
    permissions_path.write_text(yaml.safe_dump(permissions, sort_keys=False), encoding="utf-8")

    with ServiceProcess.start(context_package=package) as process:
        body = call(process, LOOKUP, ("claims:read",))

    assert body["classification"] == "restricted"


def test_a_connector_this_deployment_does_not_serve_is_a_404(claims_service: ServiceProcess) -> None:
    response = claims_service.post(
        "/v1/connectors/warehouse/operations",
        json={**LOOKUP, "connector_id": "warehouse"},
        headers=claims_service.authorized(scopes=["context:retrieve"]),
    )

    assert response.status_code == 404
    error = response.json()["error"]
    assert error["details"]["reason"] == "connector_not_found"
    assert "claims-db" in error["message"], "the refusal says what this deployment does serve"


def test_an_operation_the_connector_never_declared_is_a_404(claims_service: ServiceProcess) -> None:
    response = claims_service.post(
        "/v1/connectors/claims-db/operations",
        json={**LOOKUP, "operation": "dropTable"},
        headers=claims_service.authorized(scopes=["context:retrieve", "claims:read"]),
    )

    assert response.status_code == 404
    assert response.json()["error"]["details"]["reason"] == "operation_not_found"


def test_an_unknown_row_is_not_found_not_an_error(claims_service: ServiceProcess) -> None:
    response = claims_service.post(
        "/v1/connectors/claims-db/operations",
        json={**LOOKUP, "input": {"claimId": "C-9999"}},
        headers=claims_service.authorized(scopes=["context:retrieve", "claims:read"]),
    )

    assert response.status_code == 404
    assert response.json()["error"]["details"]["reason"] == "record_not_found"


def test_arguments_that_do_not_satisfy_the_operation_are_a_validation_failure(
    claims_service: ServiceProcess,
) -> None:
    """The Tool pins an input schema; this is what enforces it, not the model's good manners."""
    response = claims_service.post(
        "/v1/connectors/claims-db/operations",
        json={**LOOKUP, "input": {"claimID": "C-1001"}},
        headers=claims_service.authorized(scopes=["context:retrieve", "claims:read"]),
    )

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_failed"
    assert error["details"]["reason"] == "invalid_arguments"
    assert "claimId" in error["message"]


def test_the_class_scope_the_baseline_names_decides_whether_the_call_is_served(
    claims_service: ServiceProcess,
) -> None:
    """§7: `ic:Claim` requires `claims:read`. A Tool may run; this class of data is withheld."""
    response = claims_service.post(
        "/v1/connectors/claims-db/operations",
        json=LOOKUP,
        headers=claims_service.authorized(scopes=["context:retrieve"]),
    )

    assert response.status_code == 403
    error = response.json()["error"]
    assert error["code"] == "forbidden"
    assert error["details"]["reason"] == "missing_data_scope"
    assert error["details"]["required_scopes"] == ["claims:read"]


def test_the_path_and_the_body_must_name_the_same_connector(claims_service: ServiceProcess) -> None:
    response = claims_service.post(
        "/v1/connectors/sharepoint-claims/operations",
        json=LOOKUP,
        headers=claims_service.authorized(scopes=["context:retrieve", "claims:read"]),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_the_maintenance_issuer_cannot_invoke_a_connector(claims_service: ServiceProcess) -> None:
    response = claims_service.post(
        "/v1/connectors/claims-db/operations",
        json=LOOKUP,
        headers=claims_service.authorized(issuer="fde-jobs", scopes=["context:ingest"], run_id=None),
    )

    assert response.status_code == 403
    assert response.json()["error"]["details"]["reason"] == "issuer_not_allowed"


def test_no_token_is_no_operation(claims_service: ServiceProcess) -> None:
    response = claims_service.post("/v1/connectors/claims-db/operations", json=LOOKUP)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"
