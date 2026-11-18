"""The approval resource over HTTP: the contract's statuses and refusals (§8, C8).

Every response is validated against the document it claims to satisfy, and every
refusal is the unified envelope with the code §3.4 gives it. The store's own
invariants — the Decisions, the restart idempotency — are `test_approvals.py`'s;
what is asserted here is what a caller and an approver can observe: the resource,
the 403/409s, and the tenant/Run scoping the token enforces.
"""

from __future__ import annotations

import secrets
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from app.generated.api import OPERATIONS_BY_ID
from conformance.documents import ContractDocuments
from conformance.harness import ServiceProcess

APPROVAL = "approval.schema.json#/$defs/Approval"
APPROVAL_LIST = "approval.schema.json#/$defs/ApprovalList"
DECISION_RESPONSE = "approval.schema.json#/$defs/ApprovalDecisionResponse"
PROVENANCE = "decision.schema.json#/$defs/ProvenanceResponse"

APPROVER_ROLE = "claims-supervisor"
APPROVER = {"type": "user", "id": "u-supervisor"}
#: The harness's default actor: the workflow's requester (a service principal).
REQUESTER = {"type": "user", "id": "u-42"}


def expires_in(days: int = 1) -> str:
    return (datetime.now(UTC) + timedelta(days=days)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def expires_in_seconds(seconds: int) -> str:
    return (datetime.now(UTC) + timedelta(seconds=seconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def create_body(**overrides: Any) -> dict[str, Any]:
    """A contract-valid `ApprovalCreateRequest` for the Acme reference path."""
    body: dict[str, Any] = {
        "run_id": "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "capability_id": "document-triage",
        "proposed_action": {
            "tool": "claim-decision",
            "operation": "recordDecision",
            "input_digest": "sha256:" + "b" * 64,
            "summary": "Mark claim C-1001 as approved.",
        },
        "requested_by": dict(REQUESTER),
        "approver_roles": [APPROVER_ROLE],
        "expires_at": expires_in(),
        "evidence": [{"type": "graph_entity", "entity_id": "fde:acme:Claim:C-1001"}],
        "policy_refs": ["claims-approval-threshold@1.0.0"],
    }
    body.update(overrides)
    return body


def decide_body(*, approved: bool = True) -> dict[str, Any]:
    return {"approved": approved, "rationale": "The claim matches the policy.", "actor": dict(APPROVER)}


def create(
    service: ServiceProcess,
    body: dict[str, Any] | None = None,
    *,
    key: str | None = None,
    **authorized: Any,
) -> Any:
    authorized.setdefault("run_id", body["run_id"] if body else create_body()["run_id"])
    return service.post(
        "/v1/approvals",
        json=body if body is not None else create_body(),
        headers={**service.authorized(**authorized), "Idempotency-Key": key or secrets.token_hex(16)},
    )


def approver_headers(service: ServiceProcess, *, run_id: str | None = None, roles: tuple[str, ...] | None = None,
                     actor: dict[str, str] | None = None) -> dict[str, str]:
    return service.authorized(
        actor=actor or dict(APPROVER),
        roles=roles if roles is not None else (APPROVER_ROLE,),
        run_id=run_id or create_body()["run_id"],
    )


def decide(
    service: ServiceProcess,
    approval_id: str,
    body: dict[str, Any] | None = None,
    *,
    key: str | None = None,
    headers: dict[str, str] | None = None,
) -> Any:
    return service.post(
        f"/v1/approvals/{approval_id}/decisions",
        json=body if body is not None else decide_body(),
        headers={**(headers or approver_headers(service)), "Idempotency-Key": key or secrets.token_hex(16)},
    )


def consume(service: ServiceProcess, approval_id: str, *, headers: dict[str, str] | None = None) -> Any:
    return service.post(
        f"/v1/approvals/{approval_id}/consume",
        headers={**(headers or approver_headers(service)), "Idempotency-Key": secrets.token_hex(16)},
    )


def error_of(response: Any) -> dict[str, Any]:
    body = response.json()
    assert set(body) == {"error"}, body
    return body["error"]


def created_approval(service: ServiceProcess, contract: ContractDocuments, **overrides: Any) -> dict[str, Any]:
    body = create_body(**overrides)
    response = create(service, body)
    assert response.status_code == 201, response.text
    document = response.json()
    contract.require(document, APPROVAL, "the created approval")
    return document


# ---------------------------------------------------------------------------
# create and list
# ---------------------------------------------------------------------------


def test_a_create_answers_a_contract_valid_pending_approval(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    response = create(service, create_body())

    assert response.status_code == 201, response.text
    document = response.json()
    contract.require(document, APPROVAL, "the created approval")
    assert document["status"] == "pending"
    assert document["approval_id"].startswith("appr_")
    assert document["tenant_id"] == "acme"
    assert document["run_id"] == create_body()["run_id"]
    assert document["proposed_action"] == create_body()["proposed_action"]
    assert document["requested_by"] == REQUESTER
    assert document["approver_roles"] == [APPROVER_ROLE]
    assert document["decision_id"].startswith("dec_"), "the request Decision is the pending state's evidence"
    assert document["provenance_id"].startswith("prov_")
    assert "decided_at" not in document


def test_a_create_without_an_idempotency_key_is_a_400(service: ServiceProcess) -> None:
    response = service.post(
        "/v1/approvals",
        json=create_body(),
        headers=service.authorized(run_id=create_body()["run_id"]),
    )

    assert response.status_code == 400
    assert error_of(response)["code"] == "invalid_request"


def test_the_same_key_and_body_replays_the_original_approval(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    body = create_body()
    key = secrets.token_hex(16)

    first = create(service, body, key=key)
    replay = create(service, body, key=key)

    assert first.status_code == 201, first.text
    assert replay.status_code == 200, replay.text
    contract.require(replay.json(), APPROVAL, "the replayed approval")
    assert replay.json()["approval_id"] == first.json()["approval_id"]
    assert replay.json()["decision_id"] == first.json()["decision_id"]


def test_a_reused_key_with_a_different_body_is_the_idempotency_conflict(service: ServiceProcess) -> None:
    key = secrets.token_hex(16)
    create(service, create_body(), key=key)

    conflict = create(service, create_body(capability_id="claims-refund"), key=key)

    assert conflict.status_code == 409
    assert error_of(conflict)["code"] == "idempotency_conflict"


def test_the_list_is_the_tenant_s_approval_queue(service: ServiceProcess, contract: ContractDocuments) -> None:
    created = created_approval(service, contract)

    response = service.get(
        "/v1/approvals",
        params={"run_id": created["run_id"]},
        headers=service.authorized(run_id=None),
    )

    assert response.status_code == 200, response.text
    contract.require(response.json(), APPROVAL_LIST, "the approval page")
    assert created["approval_id"] in [item["approval_id"] for item in response.json()["items"]]

    other_tenant = service.get("/v1/approvals", headers=service.authorized(tenant_id="globex", run_id=None))
    assert other_tenant.status_code == 200
    assert other_tenant.json()["items"] == []


def test_the_list_paginates_with_its_cursor(service: ServiceProcess, contract: ContractDocuments) -> None:
    run_id = "run_01ARZ3NDEKTSV4RRFFQ69G5FC1"
    created = [created_approval(service, contract, run_id=run_id) for _ in range(3)]

    first = service.get(
        "/v1/approvals", params={"run_id": run_id, "limit": 2}, headers=service.authorized(run_id=None)
    )
    assert first.status_code == 200, first.text
    page = first.json()
    contract.require(page, APPROVAL_LIST, "the first page")
    assert len(page["items"]) == 2
    assert page["next_cursor"] == page["items"][-1]["approval_id"]

    second = service.get(
        "/v1/approvals",
        params={"run_id": run_id, "limit": 2, "cursor": page["next_cursor"]},
        headers=service.authorized(run_id=None),
    )
    contract.require(second.json(), APPROVAL_LIST, "the second page")
    seen = {item["approval_id"] for item in page["items"]} | {item["approval_id"] for item in second.json()["items"]}
    assert seen == {item["approval_id"] for item in created}
    assert second.json().get("next_cursor") is None


def test_an_invalid_query_value_is_a_422(service: ServiceProcess) -> None:
    for params in (
        {"status": "maybe"},
        {"limit": 0},
        {"limit": "many"},
        {"run_id": "not-a-run"},
        {"cursor": "x" * 501},
        {"staus": "pending"},
    ):
        response = service.get("/v1/approvals", params=params, headers=service.authorized(run_id=None))
        assert response.status_code == 422, (params, response.text)
        error = error_of(response)
        assert error["code"] == "validation_failed"
        assert error["details"]["reason"] == "invalid_query", (params, error)
        assert error["details"]["errors"], f"{params}: the client cannot tell what to fix"


def test_a_well_formed_cursor_that_names_nothing_is_a_422(service: ServiceProcess) -> None:
    """The cursor is opaque: only the store can say whether it names an approval."""
    response = service.get(
        "/v1/approvals",
        params={"cursor": "appr_01ARZ3NDEKTSV4RRFFQ69G5FAV"},
        headers=service.authorized(run_id=None),
    )

    assert response.status_code == 422, response.text
    assert error_of(response)["details"]["reason"] == "invalid_cursor"


def test_the_list_query_is_declared_by_the_contract() -> None:
    """The handler's parameter names and the OpenAPI's must not drift (one source)."""
    from app.routes.approvals import LIST_QUERY

    operation = OPERATIONS_BY_ID["listApprovals"]
    document = ContractDocuments().openapi()
    declared = {
        parameter["name"]
        for parameter in document["paths"][operation.path]["get"]["parameters"]
        if parameter.get("in") == "query"
    }
    assert set(LIST_QUERY) == declared


# ---------------------------------------------------------------------------
# decide: roles, self-approval, and the one decision an approval gets
# ---------------------------------------------------------------------------


def test_an_approver_decides_and_the_decision_is_provenance_readable(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    approval = created_approval(service, contract)

    response = decide(service, approval["approval_id"])

    assert response.status_code == 200, response.text
    document = response.json()
    contract.require(document, DECISION_RESPONSE, "the approval decision")
    assert document["status"] == "approved"
    assert document["approval_id"] == approval["approval_id"]
    assert document["decision_id"].startswith("dec_")
    assert document["decision_id"] != approval["decision_id"]

    provenance = service.get(f"/v1/provenance/{document['decision_id']}", headers=service.authorized())
    assert provenance.status_code == 200, provenance.text
    contract.require(provenance.json(), PROVENANCE, "the approval Decision's provenance")
    decision = provenance.json()["decision"]
    assert decision["decision_type"] == "approval"
    assert decision["phase"] == "approval"
    assert decision["status"] == "succeeded"
    assert decision["rationale"] == decide_body()["rationale"]
    assert decision["actor"] == APPROVER


def test_a_rejected_approval_is_a_denied_decision(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    approval = created_approval(service, contract)

    response = decide(service, approval["approval_id"], decide_body(approved=False))

    assert response.status_code == 200, response.text
    contract.require(response.json(), DECISION_RESPONSE, "the rejection")
    assert response.json()["status"] == "rejected"
    provenance = service.get(f"/v1/provenance/{response.json()['decision_id']}", headers=service.authorized())
    assert provenance.json()["decision"]["status"] == "denied"


def test_the_requester_cannot_approve_their_own_request(service: ServiceProcess, contract: ContractDocuments) -> None:
    """§8.3 default deny: the requester's own token decides nothing (C8)."""
    approval = created_approval(service, contract)

    response = decide(
        service,
        approval["approval_id"],
        {**decide_body(), "actor": dict(REQUESTER)},
        headers=service.authorized(actor=dict(REQUESTER), roles=(APPROVER_ROLE,), run_id=approval["run_id"]),
    )

    assert response.status_code == 403, response.text
    assert error_of(response)["details"]["reason"] == "self_approval_denied"
    still_pending = service.get(
        "/v1/approvals",
        params={"run_id": approval["run_id"], "status": "pending"},
        headers=service.authorized(run_id=None),
    )
    assert approval["approval_id"] in [item["approval_id"] for item in still_pending.json()["items"]]


def test_an_approver_without_the_business_role_is_forbidden(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    approval = created_approval(service, contract)

    response = decide(service, approval["approval_id"], headers=approver_headers(service, roles=("auditor",)))

    assert response.status_code == 403, response.text
    assert error_of(response)["details"]["reason"] == "approver_role_required"


def test_the_decide_replay_is_the_same_decision(service: ServiceProcess, contract: ContractDocuments) -> None:
    approval = created_approval(service, contract)
    key = secrets.token_hex(16)
    body = decide_body()

    first = decide(service, approval["approval_id"], body, key=key)
    replay = decide(service, approval["approval_id"], body, key=key)

    assert first.status_code == 200, first.text
    assert replay.status_code == 200, replay.text
    contract.require(replay.json(), DECISION_RESPONSE, "the replayed decision")
    assert replay.json()["decision_id"] == first.json()["decision_id"]
    assert replay.json()["provenance_id"] == first.json()["provenance_id"]


def test_a_second_decision_under_a_different_key_is_already_decided(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    approval = created_approval(service, contract)
    decide(service, approval["approval_id"])

    response = decide(service, approval["approval_id"], decide_body(approved=False))

    assert response.status_code == 409, response.text
    assert error_of(response)["code"] == "approval_already_decided"


def test_an_approval_cannot_be_decided_by_another_tenant(service: ServiceProcess, contract: ContractDocuments) -> None:
    approval = created_approval(service, contract)

    response = decide(
        service,
        approval["approval_id"],
        headers=service.authorized(
            tenant_id="globex", actor=dict(APPROVER), roles=(APPROVER_ROLE,), run_id=approval["run_id"]
        ),
    )

    assert response.status_code == 404, response.text


def test_an_approval_cannot_be_decided_from_another_run(service: ServiceProcess, contract: ContractDocuments) -> None:
    approval = created_approval(service, contract)

    response = decide(
        service,
        approval["approval_id"],
        headers=approver_headers(service, run_id="run_01ARZ3NDEKTSV4RRFFQ69G5FC1"),
    )

    assert response.status_code == 404, response.text


def test_an_unknown_approval_is_a_404(service: ServiceProcess) -> None:
    unknown = "appr_01ARZ3NDEKTSV4RRFFQ69G5FAV"

    decided = decide(service, unknown)
    consumed = consume(service, unknown)

    assert decided.status_code == 404, decided.text
    assert consumed.status_code == 404, consumed.text
    assert error_of(decided)["code"] == "not_found"


def test_a_malformed_approval_id_is_a_404_and_not_a_422(service: ServiceProcess) -> None:
    """`consumeApproval` declares no 422: an id that cannot name a resource is absent."""
    response = consume(service, "not-an-approval-id")

    assert response.status_code == 404, response.text


# ---------------------------------------------------------------------------
# consume and expiry
# ---------------------------------------------------------------------------


def test_consume_marks_an_approved_approval_consumed(service: ServiceProcess, contract: ContractDocuments) -> None:
    approval = created_approval(service, contract)
    decide(service, approval["approval_id"])

    response = consume(service, approval["approval_id"])

    assert response.status_code == 200, response.text
    document = response.json()
    contract.require(document, APPROVAL, "the consumed approval")
    assert document["status"] == "consumed"


def test_consume_is_idempotent(service: ServiceProcess, contract: ContractDocuments) -> None:
    """C8: a retried consume answers with the same consumed resource."""
    approval = created_approval(service, contract)
    decide(service, approval["approval_id"])

    first = consume(service, approval["approval_id"])
    second = consume(service, approval["approval_id"])

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["status"] == second.json()["status"] == "consumed"


def test_consume_before_approval_is_a_state_conflict(service: ServiceProcess, contract: ContractDocuments) -> None:
    approval = created_approval(service, contract)

    response = consume(service, approval["approval_id"])

    assert response.status_code == 409, response.text
    assert error_of(response)["code"] == "conflict"
    assert error_of(response)["details"]["reason"] == "approval_not_approved"


def test_an_overdue_approval_reads_expired_and_cannot_be_decided(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    """C8 expiry: the deadline is the state, whether or not the sweeper has run."""
    approval = created_approval(service, contract, expires_at=expires_in_seconds(1))
    time.sleep(1.2)  # the approval above expires one second after it was created

    refused = decide(service, approval["approval_id"])

    assert refused.status_code == 409, refused.text
    assert error_of(refused)["details"]["status"] == "expired"
    expired = service.get(
        "/v1/approvals",
        params={"run_id": approval["run_id"], "status": "expired"},
        headers=service.authorized(run_id=None),
    )
    assert approval["approval_id"] in [item["approval_id"] for item in expired.json()["items"]]
