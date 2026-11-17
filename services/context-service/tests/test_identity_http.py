"""Identity on the wire: what a caller sees, in the order it is checked.

`test_identity.py` proves the verifier; this file proves the request edge — the
middleware that requires a token, binds it to the trace, and refuses a request
whose body or headers contradict it. The order matters and is asserted here: a
request that is anonymous *and* malformed is a 401, not a 422, because the
service must not validate a body for a caller it has not identified.
"""

from __future__ import annotations

import time

import jwt

from app.identity import MAX_TOKEN_LIFETIME_SECONDS
from conformance.documents import ContractDocuments
from conformance.harness import ServiceProcess, new_traceparent


def error_of(response) -> dict:  # type: ignore[no-untyped-def]
    body = response.json()
    assert set(body) == {"error"}, body
    return body["error"]


def test_an_anonymous_body_is_a_401_before_it_is_validated(
    service: ServiceProcess, contract: ContractDocuments
) -> None:
    response = service.post("/v1/context/retrieve", json={"not": "a RetrieveRequest"})

    assert response.status_code == 401, response.text
    error = error_of(response)
    assert error["code"] == "unauthenticated"
    assert error["details"]["reason"] == "missing_token"
    contract.require(response.json(), "common.schema.json#/$defs/Error", "401")


def test_an_authenticated_invalid_body_is_still_a_422(service: ServiceProcess, contract: ContractDocuments) -> None:
    """The token is not a substitute for a valid body: both checks run."""
    response = service.post("/v1/context/retrieve", json={"not": "a RetrieveRequest"}, headers=service.authorized())

    assert response.status_code == 422, response.text
    assert error_of(response)["code"] == "validation_failed"


def test_the_same_token_cannot_be_replayed(service: ServiceProcess) -> None:
    """`jti` is single use; a captured header set is not a second call."""
    headers = service.authorized()

    first = service.post("/v1/context/retrieve", json={}, headers=headers)
    second = service.post("/v1/context/retrieve", json={}, headers=headers)

    assert first.status_code != 401, first.text
    assert second.status_code == 401
    assert error_of(second)["details"]["reason"] == "replayed_jti"


def test_an_expired_token_is_refused_on_the_wire(service: ServiceProcess) -> None:
    stale = service.authorized(now=int(time.time()) - MAX_TOKEN_LIFETIME_SECONDS - 3600)

    response = service.post("/v1/context/retrieve", json={}, headers=stale)

    assert response.status_code == 401
    assert error_of(response)["details"]["reason"] == "expired_token"


def test_a_token_minted_for_another_trace_is_a_403(service: ServiceProcess) -> None:
    headers = service.authorized(traceparent_trace_id="a" * 32)

    response = service.post("/v1/context/retrieve", json={}, headers=headers)

    assert response.status_code == 403
    error = error_of(response)
    assert error["code"] == "forbidden"
    assert error["retryable"] is False
    assert error["details"]["reason"] == "trace_mismatch"


def test_a_malformed_traceparent_is_a_400(service: ServiceProcess) -> None:
    """The header is part of the contract, so a broken one is a bad request."""
    headers = {**service.authorized(), "traceparent": "not-a-traceparent"}

    response = service.post("/v1/context/retrieve", json={}, headers=headers)

    assert response.status_code == 400
    assert error_of(response)["details"]["reason"] == "missing_traceparent"


def test_a_plaintext_tenant_header_that_agrees_is_accepted(service: ServiceProcess) -> None:
    """§5.3 keeps the header for compatibility — it must agree, and then it is inert."""
    headers = {**service.authorized(), "X-Tenant-Id": "acme", "X-Actor": "u-42"}

    response = service.get("/v1/approvals", headers=headers)

    assert response.status_code != 403, response.text


def test_an_unknown_route_does_not_become_a_401(service: ServiceProcess, contract: ContractDocuments) -> None:
    """The edge guards contract operations; a 404 stays a 404."""
    response = service.get("/v1/does-not-exist")

    assert response.status_code == 404
    assert error_of(response)["code"] == "not_found"


def test_the_public_surface_needs_no_token(service: ServiceProcess) -> None:
    for path in ("/healthz", "/readyz", "/v1/runtime-info"):
        assert service.get(path).status_code == 200, path


def test_identity_runs_before_idempotency(service: ServiceProcess) -> None:
    """An anonymous write is refused for being anonymous, not for its missing key."""
    response = service.post("/v1/decisions", json={})

    assert response.status_code == 401
    assert error_of(response)["details"]["reason"] == "missing_token"


def test_a_jobs_token_cannot_reach_the_runtime_surface(service: ServiceProcess) -> None:
    headers = service.authorized(issuer="fde-jobs")

    response = service.get("/v1/approvals", headers=headers)

    assert response.status_code == 403
    assert error_of(response)["details"]["reason"] == "issuer_not_allowed"


def test_a_runtime_token_cannot_reach_the_jobs_surface(service: ServiceProcess) -> None:
    headers = service.authorized()

    response = service.post("/internal/v1/jobs/ingest", json={}, headers=headers)

    assert response.status_code == 403
    assert error_of(response)["details"]["reason"] == "issuer_not_allowed"


def test_the_two_issuers_are_not_interchangeable_on_the_wire(service: ServiceProcess) -> None:
    """The same request, two tokens: only the issuer the contract names is admitted."""
    jobs = service.authorized(issuer="fde-jobs")
    admitted = service.post("/internal/v1/jobs/ingest", json={}, headers=jobs)
    refused = service.post("/internal/v1/jobs/ingest", json={}, headers=service.authorized())

    assert admitted.status_code != 403, admitted.text
    assert refused.status_code == 403


def test_a_missing_scope_is_a_403_naming_the_scope(service: ServiceProcess) -> None:
    headers = service.authorized(scopes=("context:retrieve",))

    response = service.get("/v1/approvals", headers=headers)

    assert response.status_code == 403
    error = error_of(response)
    assert error["details"]["reason"] == "missing_scope"
    assert error["details"]["required_scope"] == "approval:read"


def test_the_envelope_of_a_refusal_carries_the_callers_trace(service: ServiceProcess) -> None:
    """A refusal is still a response: an operator correlates it by trace (C6)."""
    trace_id = new_traceparent().split("-")[1]
    headers = service.authorized(traceparent_trace_id="b" * 32, trace_id=trace_id)
    headers["traceparent"] = new_traceparent(trace_id)

    response = service.get("/v1/approvals", headers={**headers, "X-Tenant-Id": "globex"})

    assert response.status_code == 403
    assert error_of(response)["trace_id"] == trace_id


def test_a_token_with_a_foreign_signature_is_an_envelope(service: ServiceProcess) -> None:
    """A structurally valid JWT that nothing signed is still just a string."""
    from conformance.identity import generate_issuers

    stranger = generate_issuers("dep_01ARZ3NDEKTSV4RRFFQ69G5FAV")["mastra-app"]
    forged = jwt.encode(
        {
            "iss": "fde://dep_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "aud": "context-service",
            "sub": "user-42",
            "actor": {"type": "user", "id": "u-42"},
            "tenant_id": "acme",
            "deployment_id": "dep_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "solution_id": "claims-triage",
            "trace_id": new_traceparent().split("-")[1],
            "roles": ["service"],
            "scopes": ["context:retrieve"],
            "iat": int(time.time()),
            "exp": int(time.time()) + 60,
            "jti": "f" * 32,
            "kid": stranger.kid,
        },
        stranger.private_pem,
        algorithm="ES256",
        headers={"kid": stranger.kid},
    )

    response = service.post(
        "/v1/context/retrieve",
        json={},
        headers={"authorization": f"Bearer {forged}"},
    )

    assert response.status_code == 401
    assert error_of(response)["details"]["reason"] == "unknown_kid"
