"""Every non-2xx response is the unified envelope (§3.4, C10).

The seam is a spawned process (`conformance.harness`): the envelope has to be
what the wire carries, not what a handler returns. The body of each failure is
validated against `contracts/schemas/error.schema.json`, because "looks like an
envelope" is not the claim — "is the envelope the contract defines" is.
"""

from __future__ import annotations

import asyncio

import httpx

from app.main import create_app
from app.readiness import ProbeResult, Readiness
from conformance.documents import ContractDocuments
from conformance.harness import ServiceProcess, new_traceparent

ERROR_SCHEMA = "common.schema.json#/$defs/Error"


def assert_envelope(contract: ContractDocuments, response_json: dict, *, code: str, retryable: bool) -> dict:
    contract.require(response_json, ERROR_SCHEMA, "error response")
    error = response_json["error"]
    assert error["code"] == code
    assert error["retryable"] is retryable
    assert isinstance(error["message"], str) and error["message"]
    # `trace_id` is required by the schema; the regex below is C6's business, but
    # a malformed trace id is never useful.
    assert len(error["trace_id"]) == 32
    return error


def test_unknown_route_is_an_envelope_not_fastapi_default(service: ServiceProcess, contract: ContractDocuments) -> None:
    response = service.get("/v1/does-not-exist")

    assert response.status_code == 404
    body = response.json()
    assert "detail" not in body, "FastAPI's default shape leaked"
    assert_envelope(contract, body, code="not_found", retryable=False)


def test_wrong_method_is_an_envelope(service: ServiceProcess, contract: ContractDocuments) -> None:
    response = service.post("/healthz")

    assert response.status_code == 405
    assert_envelope(contract, response.json(), code="invalid_request", retryable=False)


def test_malformed_json_is_invalid_request_400(service: ServiceProcess, contract: ContractDocuments) -> None:
    response = service.post(
        "/v1/context/retrieve",
        content=b'{"recipe_id":',
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 400, response.text
    error = assert_envelope(contract, response.json(), code="invalid_request", retryable=False)
    assert "line" in error["details"]


def test_empty_body_is_invalid_request_400(service: ServiceProcess, contract: ContractDocuments) -> None:
    response = service.post("/v1/context/retrieve", content=b"", headers={"content-type": "application/json"})

    assert response.status_code == 400, response.text
    assert_envelope(contract, response.json(), code="invalid_request", retryable=False)


def test_error_trace_id_is_the_traceparent_trace(service: ServiceProcess, contract: ContractDocuments) -> None:
    trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"

    response = service.get("/v1/does-not-exist", headers={"traceparent": new_traceparent(trace_id)})

    error = assert_envelope(contract, response.json(), code="not_found", retryable=False)
    assert error["trace_id"] == trace_id


def test_absent_traceparent_still_produces_a_trace_id(service: ServiceProcess, contract: ContractDocuments) -> None:
    first = service.get("/v1/does-not-exist")
    second = service.get("/v1/does-not-exist")

    first_error = assert_envelope(contract, first.json(), code="not_found", retryable=False)
    second_error = assert_envelope(contract, second.json(), code="not_found", retryable=False)
    # A fresh trace, not a constant: the point is to correlate *this* failure.
    assert first_error["trace_id"] != second_error["trace_id"]


def test_unexpected_exception_is_an_internal_envelope_without_a_traceback() -> None:
    """The catch-all, driven in-process: no contract route may raise on demand."""

    class Exploding:
        name = "exploding"

        def probe(self) -> ProbeResult:
            raise RuntimeError("the secret is hunter2 and this must not reach the client")

    app = create_app(readiness=Readiness([Exploding()]))

    async def call() -> httpx.Response:
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.get("/readyz")

    response = asyncio.run(call())

    assert response.status_code == 500
    body = response.json()
    assert set(body) == {"error"}
    assert body["error"]["code"] == "internal"
    assert body["error"]["retryable"] is False
    assert "hunter2" not in response.text
    assert "RuntimeError" not in response.text
