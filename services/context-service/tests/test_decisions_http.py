"""The decision and provenance surface, over real HTTP (§3.5, §6.2–6.4, C4/C13/C14).

Every response in this file is validated against the contract it claims to
satisfy, not against a second Python description of it. The store's own
invariants are `test_audit_store.py`'s; what is asserted here is what a client and
an auditor can observe: one write per `decision_id`, a replay that names the same
entry, and a provenance document with stable IDs and no storage internals.

The restart test spawns its own process because a restart is the assertion: the
session's shared service must stay up for the other tests.
"""

from __future__ import annotations

import json
import secrets
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from app.ids import new_ulid
from conformance.cases import body_and_headers
from conformance.documents import ContractDocuments
from conformance.harness import ServiceProcess

DECISION_RESPONSE = "decision.schema.json#/$defs/DecisionResponse"
PROVENANCE_RESPONSE = "decision.schema.json#/$defs/ProvenanceResponse"


def _checked_at(body: dict[str, Any]) -> datetime:
    """The read's verification time; `datetime.min` when it has none (never `valid`)."""
    raw = (body.get("verification") or {}).get("checked_at")
    if not raw:
        return datetime.min.replace(tzinfo=UTC)
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


def unique_decision(service: ServiceProcess, contract: ContractDocuments) -> tuple[dict[str, Any], dict[str, str], str]:
    """A contract-valid Decision the caller owns, one token, and its trace."""
    decision, headers = body_and_headers(service, contract, "DecisionRequest")
    return decision, headers, headers["traceparent"].split("-")[1]


def written(
    service: ServiceProcess, contract: ContractDocuments, body: dict[str, Any], headers: dict[str, str]
) -> dict[str, Any]:
    response = service.post("/v1/decisions", json=body, headers={**headers, "Idempotency-Key": secrets.token_hex(16)})
    assert response.status_code == 201, response.text
    return response.json()


def test_a_decision_is_recorded_as_the_contract_response(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    decision, headers, trace_id = unique_decision(service, contract)

    response = service.post(
        "/v1/decisions", json=decision, headers={**headers, "Idempotency-Key": secrets.token_hex(16)}
    )

    assert response.status_code == 201, response.text
    body = response.json()
    contract.require(body, DECISION_RESPONSE, "decision response")
    assert body["decision_id"] == decision["decision_id"]
    assert body["provenance_id"].startswith("prov_")
    assert body["trace_id"] == trace_id
    assert body["idempotent_replay"] is False
    assert body["chain_head"].startswith("sha256:")


def test_the_same_key_and_payload_replays_the_original_result(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    """C4: the retry is the same write, so it names the same audit entry."""
    decision, headers, trace_id = unique_decision(service, contract)
    key = secrets.token_hex(16)

    first = service.post("/v1/decisions", json=decision, headers={**headers, "Idempotency-Key": key})
    retry = service.post(
        "/v1/decisions",
        json=decision,
        headers={**service.authorized(trace_id=trace_id, run_id=decision["run_id"]), "Idempotency-Key": key},
    )

    assert first.status_code == 201, first.text
    assert retry.status_code == 200, retry.text
    original = first.json()
    replay = retry.json()
    contract.require(replay, DECISION_RESPONSE, "replayed decision response")
    assert replay["decision_id"] == original["decision_id"]
    assert replay["provenance_id"] == original["provenance_id"]
    assert replay["created_at"] == original["created_at"]
    # C13: no second entry was appended — the chain head is the same link.
    assert replay["chain_head"] == original["chain_head"]
    assert replay["idempotent_replay"] is True


def test_a_new_key_with_the_same_decision_is_still_a_replay(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    """`decision_id` is the durable idempotency key; the header is only a fast path."""
    decision, headers, trace_id = unique_decision(service, contract)
    first = written(service, contract, decision, headers)

    retry = service.post(
        "/v1/decisions",
        json=decision,
        headers={
            **service.authorized(trace_id=trace_id, run_id=decision["run_id"]),
            "Idempotency-Key": secrets.token_hex(16),
        },
    )

    assert retry.status_code == 200, retry.text
    assert retry.json()["provenance_id"] == first["provenance_id"]
    assert retry.json()["idempotent_replay"] is True


def test_a_used_decision_id_with_a_different_payload_is_a_conflict(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    decision, headers, trace_id = unique_decision(service, contract)
    written(service, contract, decision, headers)

    conflicting = service.post(
        "/v1/decisions",
        json={**decision, "rationale": f"{decision['rationale']} (revised)"},
        headers={
            **service.authorized(trace_id=trace_id, run_id=decision["run_id"]),
            "Idempotency-Key": secrets.token_hex(16),
        },
    )

    assert conflicting.status_code == 409, conflicting.text
    error = conflicting.json()["error"]
    assert error["code"] == "idempotency_conflict"
    assert error["retryable"] is False


def test_provenance_returns_the_original_decision(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    """C14: the Decision itself, its PROV-O lineage, and stable IDs."""
    decision, headers, _ = unique_decision(service, contract)
    recorded = written(service, contract, decision, headers)
    read_trace = secrets.token_hex(16)

    response = service.get(
        f"/v1/provenance/{decision['decision_id']}",
        headers=service.authorized(trace_id=read_trace),
    )

    assert response.status_code == 200, response.text
    body = response.json()
    contract.require(body, PROVENANCE_RESPONSE, "provenance response")
    assert body["decision_id"] == decision["decision_id"]
    assert body["provenance_id"] == recorded["provenance_id"]
    # C6: the read carries the reader's trace, not the trace the Decision was written on.
    assert body["trace_id"] == read_trace
    assert body["decision"] == decision
    assert body["prov_o"]["@context"]["prov"] == "http://www.w3.org/ns/prov#"
    assert body["prov_o"]["@id"] == f"fde:decision/{decision['decision_id']}"
    relationships = {(link["type"], link["relationship"]) for link in body["lineage"]}
    assert ("run", "wasGeneratedBy") in relationships
    assert ("actor", "wasAttributedTo") in relationships
    assert body["verification"]["status"] in ("valid", "pending", "stale", "invalid")


def test_provenance_names_no_backend_internal_id(service: ServiceProcess, contract: ContractDocuments) -> None:
    """C14: an auditor can cite the answer without knowing how the store keeps it."""
    decision, headers, _ = unique_decision(service, contract)
    written(service, contract, decision, headers)

    response = service.get(f"/v1/provenance/{decision['decision_id']}", headers=service.authorized())

    assert response.status_code == 200, response.text
    serialized = json.dumps(response.json())
    for internal in ("sqlite", "rowid", "prev_hash", "payload_digest", '"seq"'):
        assert internal not in serialized, f"the provenance document leaks {internal!r}"


def test_an_unknown_decision_is_a_404_envelope(service: ServiceProcess, contract: ContractDocuments) -> None:
    response = service.get(f"/v1/provenance/{new_ulid('dec_')}", headers=service.authorized())

    assert response.status_code == 404, response.text
    error = response.json()["error"]
    contract.require(response.json(), "error.schema.json", "provenance 404")
    assert error["code"] == "not_found"
    assert error["retryable"] is False


def test_a_malformed_decision_id_is_a_404_not_a_status_the_contract_never_declared(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    """`getProvenance` declares no 422, so a stable id that cannot parse is simply absent."""
    response = service.get("/v1/provenance/not-a-decision-id", headers=service.authorized())

    assert response.status_code == 404, response.text
    assert response.json()["error"]["code"] == "not_found"


def test_provenance_is_scoped_to_the_token_tenant(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    """C3/C14: another tenant's Decision is indistinguishable from an unknown one."""
    decision, headers, _ = unique_decision(service, contract)
    written(service, contract, decision, headers)

    response = service.get(
        f"/v1/provenance/{decision['decision_id']}",
        headers=service.authorized(tenant_id="globex"),
    )

    assert response.status_code == 404, response.text


@contextmanager
def running(data_dir: Path | None = None) -> Iterator[ServiceProcess]:
    process = ServiceProcess.start(data_dir=data_dir)
    try:
        yield process
    finally:
        process.stop()


def test_a_decision_survives_a_restart_and_its_chain_verifies() -> None:
    """C13: the audit volume, not the process, is the evidence's home."""
    contract = ContractDocuments()
    with running() as first_process:
        decision, headers, _ = unique_decision(first_process, contract)
        recorded = written(first_process, contract, decision, headers)
        data_dir = first_process.data_dir

    # The verification record is in the same SQLite file, so `valid` alone could be
    # the pre-restart pass. The restart must date its own pass.
    restart_started = datetime.now(UTC)
    with running(data_dir) as restarted:
        deadline = time.monotonic() + 15
        body: dict[str, Any] | None = None
        response = restarted.get(f"/v1/provenance/{decision['decision_id']}", headers=restarted.authorized())
        while time.monotonic() < deadline:
            response = restarted.get(
                f"/v1/provenance/{decision['decision_id']}", headers=restarted.authorized()
            )
            if response.status_code == 200:
                body = response.json()
                if body["verification"]["status"] == "valid" and _checked_at(body) > restart_started:
                    break
            time.sleep(0.1)

        assert response.status_code == 200, response.text
        assert body is not None
        contract.require(body, PROVENANCE_RESPONSE, "provenance after restart")
        assert body["provenance_id"] == recorded["provenance_id"]
        assert body["decision"] == decision
        assert body["verification"]["status"] == "valid", (
            "the restarted service must verify the chain it inherited, not just read it"
        )
        assert _checked_at(body) > restart_started, (
            "the restarted service reported the pre-restart verification, not a pass of its own"
        )

        # The write's durable identity is on disk too: replaying it after the
        # restart returns the original entry instead of appending a second one.
        replay = restarted.post(
            "/v1/decisions",
            json=decision,
            headers={
                **restarted.authorized(trace_id=decision["trace_id"], run_id=decision["run_id"]),
                "Idempotency-Key": secrets.token_hex(16),
            },
        )
        assert replay.status_code == 200, replay.text
        assert replay.json()["provenance_id"] == recorded["provenance_id"]
        assert replay.json()["chain_head"] == recorded["chain_head"]


def test_a_decision_cannot_smuggle_a_raw_prompt_or_output(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    """§6.5: the audit field is the Decision (digests and references), not the content.

    `DecisionRequest` is a closed object and has no field for a prompt or an output,
    so the only way in is a schema violation — which is a 422 before any audit write.
    """
    decision, headers, _ = unique_decision(service, contract)

    response = service.post(
        "/v1/decisions",
        json={**decision, "prompt": "raw prompt text", "output": "raw model output"},
        headers={**headers, "Idempotency-Key": secrets.token_hex(16)},
    )

    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_failed"


@pytest.mark.parametrize("path", ["/v1/decisions", "/v1/provenance/{decision_id}"])
def test_both_decisions_operations_are_real(path: str, service: ServiceProcess) -> None:
    """A skeleton that answered `not_implemented` for either would fail the cases above."""
    headers = service.authorized()
    if "{decision_id}" in path:
        response = service.get(path.replace("{decision_id}", new_ulid("dec_")), headers=headers)
        assert response.status_code == 404, response.text
        assert response.json()["error"].get("details", {}).get("reason") != "not_implemented"
    else:
        response = service.post(path, json={}, headers={**headers, "Idempotency-Key": secrets.token_hex(16)})
        assert response.status_code == 422, response.text
        assert response.json()["error"].get("details", {}).get("reason") != "not_implemented"
