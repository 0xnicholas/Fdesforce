"""Write idempotency (§3.5): the store's rules, and the middleware that applies them.

Two seams, deliberately:

- `IdempotencyStore` is tested directly, because retention, the in-flight window
  and the payload fingerprint are decisions about *time and identity*, not about
  HTTP; a test that needed a request to see them would be slow and vague.
- `IdempotencyMiddleware` is tested through a real ASGI request against a
  throwaway app, because the parts that are easy to get wrong — buffering the
  body, capturing the response, replaying it with the flag flipped — only exist on
  the wire. The throwaway app is *not* the service: the service's write handlers
  are #37/#40's, and adding a route to it to test this would put an operation in a
  surface the contract does not describe.

The replay path only has a response to replay once a handler succeeds, so the
end-to-end checks below use a stand-in handler and C5 covers the conflict path
against the shipped surface.
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.generated.api import OPERATIONS_BY_ID
from app.generated.models import ExecutionContext
from app.idempotency import (
    RETENTION_SECONDS,
    IdempotencyMiddleware,
    IdempotencyStore,
    KeyScope,
    RecordedResponse,
    declares_replay_flag,
    fingerprint,
    replay_body,
)
from app.identity import IDENTITY_STATE_KEY, VerifiedIdentity
from conformance.harness import DEPLOYMENT_ID, SOLUTION_ID, TENANT_ID

SCOPE = KeyScope(tenant_id="acme", endpoint="recordDecision", key="k" * 32)
OTHER_TENANT = KeyScope(tenant_id="globex", endpoint="recordDecision", key="k" * 32)
OTHER_ENDPOINT = KeyScope(tenant_id="acme", endpoint="createApproval", key="k" * 32)


class Clock:
    def __init__(self, now: float) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def body(**overrides: Any) -> bytes:
    return json.dumps({**{"decision_id": "dec_01ARZ3NDEKTSV4RRFFQ69G5FAV", "phase": "run"}, **overrides}).encode()


DECISION = b'{"decision_id":"dec_01ARZ3NDEKTSV4RRFFQ69G5FAV"}'


def response(status: int = 201, payload: bytes = DECISION) -> RecordedResponse:
    return RecordedResponse(status=status, body=payload, content_type="application/json")


# ---------------------------------------------------------------------------
# The store
# ---------------------------------------------------------------------------


def test_the_first_request_proceeds_and_a_finished_one_replays() -> None:
    store = IdempotencyStore()
    digest = fingerprint(body())

    assert store.begin(SCOPE, digest).kind == "proceed"

    store.complete(SCOPE, response(201, b'{"decision_id":"dec_1"}'))

    replay = store.begin(SCOPE, digest)
    assert replay.kind == "replay"
    assert replay.response is not None
    assert replay.response.body == b'{"decision_id":"dec_1"}'


def test_the_same_key_with_a_different_payload_is_a_conflict() -> None:
    store = IdempotencyStore()
    store.begin(SCOPE, fingerprint(body(rationale="first")))

    outcome = store.begin(SCOPE, fingerprint(body(rationale="second")))

    assert outcome.kind == "conflict"
    assert outcome.reason == "payload_mismatch"


def test_a_key_is_scoped_by_tenant_and_endpoint() -> None:
    """§3.5: `tenant_id + endpoint + key`. Neither may leak into the other."""
    store = IdempotencyStore()
    digest = fingerprint(body())
    store.begin(SCOPE, digest)

    assert store.begin(OTHER_TENANT, digest).kind == "proceed"
    assert store.begin(OTHER_ENDPOINT, digest).kind == "proceed"


def test_two_concurrent_copies_of_one_write_conflict() -> None:
    store = IdempotencyStore()
    digest = fingerprint(body())
    store.begin(SCOPE, digest)

    outcome = store.begin(SCOPE, digest)

    assert outcome.kind == "conflict"
    assert outcome.reason == "in_flight"


def test_a_failed_attempt_lets_the_same_payload_retry_but_keeps_the_key() -> None:
    """A 500 wrote nothing, so the retry must run; the key still names one payload."""
    store = IdempotencyStore()
    digest = fingerprint(body())
    store.begin(SCOPE, digest)
    store.abandon(SCOPE)

    assert store.begin(SCOPE, digest).kind == "proceed"
    store.abandon(SCOPE)
    assert store.begin(SCOPE, fingerprint(body(rationale="other"))).kind == "conflict"


def test_a_key_keeps_its_meaning_for_a_day() -> None:
    clock = Clock(1_000.0)
    store = IdempotencyStore(now=clock, retention=RETENTION_SECONDS)
    digest = fingerprint(body())
    store.begin(SCOPE, digest)
    store.complete(SCOPE, response())

    clock.now += RETENTION_SECONDS - 1
    assert store.begin(SCOPE, digest).kind == "replay"

    clock.now += 2
    assert store.begin(SCOPE, digest).kind == "proceed"


def test_expired_entries_are_swept_rather_than_accumulating() -> None:
    clock = Clock(1_000.0)
    store = IdempotencyStore(now=clock, retention=60)
    store.begin(SCOPE, fingerprint(body()))
    assert len(store) == 1

    clock.now += 61
    store.begin(OTHER_TENANT, fingerprint(body()))

    assert len(store) == 1


def test_the_fingerprint_is_the_payload_not_its_bytes() -> None:
    """Reordered keys and whitespace are transport; the same Decision is the same write."""
    first = b'{"a": 1, "b": [2, 3]}'
    second = b'{"b":[2,3],"a":1}'

    assert fingerprint(first) == fingerprint(second)
    assert fingerprint(first) != fingerprint(b'{"a": 2, "b": [3, 4]}')


def test_a_body_that_is_not_json_still_fingerprints_stably() -> None:
    assert fingerprint(b"not json") == hashlib.sha256(b"not json").hexdigest()
    assert fingerprint(b"not json") == fingerprint(b"not json")


def test_the_replay_flag_is_set_where_the_schema_declares_it() -> None:
    """`DecisionResponse` declares `idempotent_replay`; `Approval` does not."""
    recorded = response(201, b'{"decision_id":"dec_1","idempotent_replay":false}')

    assert declares_replay_flag(OPERATIONS_BY_ID["recordDecision"])
    assert not declares_replay_flag(OPERATIONS_BY_ID["createApproval"])

    replayed = json.loads(replay_body(OPERATIONS_BY_ID["recordDecision"], recorded))
    assert replayed["idempotent_replay"] is True
    assert replayed["decision_id"] == "dec_1"

    # A closed object the schema does not give a flag to is replayed verbatim.
    assert replay_body(OPERATIONS_BY_ID["createApproval"], recorded) == recorded.body


def test_the_replay_status_is_the_one_the_contract_declares() -> None:
    assert OPERATIONS_BY_ID["recordDecision"].replay_status == 200
    assert OPERATIONS_BY_ID["createApproval"].replay_status == 200
    assert OPERATIONS_BY_ID["decideApproval"].replay_status == 200


# ---------------------------------------------------------------------------
# The middleware, on the wire
# ---------------------------------------------------------------------------

KEY = "idempotency-key-for-one-write"

#: Every request the middleware is allowed to see needs an identity; this is a
#: verified one, so the middleware's tenant scoping has something to scope by.
def identity() -> VerifiedIdentity:
    now = int(time.time())
    return VerifiedIdentity(
        kind="runtime",
        context=ExecutionContext.model_validate(
            {
                "iss": f"fde://{DEPLOYMENT_ID}",
                "aud": "context-service",
                "sub": "user-42",
                "actor": {"type": "user", "id": "u-42"},
                "tenant_id": TENANT_ID,
                "deployment_id": DEPLOYMENT_ID,
                "solution_id": SOLUTION_ID,
                "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
                "roles": ["service"],
                "scopes": ["decision:write"],
                "iat": now,
                "exp": now + 60,
                "jti": "e" * 32,
                "kid": "a-kid",
            }
        ),
    )


class Identify:
    """Stand-in for `IdentityMiddleware`: publish a verified identity, nothing more."""

    def __init__(self, app: ASGIApp, *, verified: VerifiedIdentity) -> None:
        self.app = app
        self.verified = verified

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            scope.setdefault("state", {})[IDENTITY_STATE_KEY] = self.verified
        await self.app(scope, receive, send)


def write_app(calls: list[dict[str, Any]]) -> FastAPI:
    """A one-route app behind the real middleware, logging what it was asked to write."""
    application = FastAPI()

    @application.post("/v1/decisions", status_code=201)
    async def record(request: Request) -> JSONResponse:
        payload = json.loads(await request.body())
        calls.append(payload)
        if payload.get("phase") == "explode":
            return JSONResponse(status_code=500, content={"error": {"code": "internal"}})
        return JSONResponse(
            status_code=201,
            content={"decision_id": payload["decision_id"], "idempotent_replay": False},
        )

    application.add_middleware(IdempotencyMiddleware)
    application.add_middleware(Identify, verified=identity())
    return application


def run(scenario: Any, *, application: FastAPI | None = None) -> tuple[Any, list[dict[str, Any]]]:
    """Run one async scenario against the app and hand back its result and the call log."""
    import asyncio

    calls: list[dict[str, Any]] = []
    app = application if application is not None else write_app(calls)

    async def call() -> Any:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await scenario(client)

    return asyncio.run(call()), calls


def a_decision(**overrides: Any) -> dict[str, Any]:
    return {"decision_id": "dec_01ARZ3NDEKTSV4RRFFQ69G5FAV", **overrides}


def test_a_replay_answers_200_with_the_original_body_and_the_flag() -> None:
    async def scenario(client: httpx.AsyncClient) -> tuple[httpx.Response, httpx.Response]:
        key = {"idempotency-key": KEY}
        first = await client.post("/v1/decisions", json=a_decision(), headers=key)
        second = await client.post("/v1/decisions", json=a_decision(), headers=key)
        return first, second

    (first, second), calls = run(scenario)

    assert first.status_code == 201
    assert second.status_code == 200, second.text
    assert second.json()["idempotent_replay"] is True
    assert second.json()["decision_id"] == first.json()["decision_id"]
    assert len(calls) == 1, "the handler must not run twice for one write"


def test_a_retry_with_a_different_payload_after_a_failure_is_a_conflict() -> None:
    """Nothing was written, but the key still names one payload — not one attempt."""
    async def scenario(client: httpx.AsyncClient) -> tuple[httpx.Response, httpx.Response]:
        key = {"idempotency-key": KEY}
        first = await client.post("/v1/decisions", json=a_decision(phase="explode"), headers=key)
        second = await client.post("/v1/decisions", json=a_decision(), headers=key)
        return first, second

    (first, second), calls = run(scenario)

    assert first.status_code == 500
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "idempotency_conflict"
    assert len(calls) == 1


def test_a_retry_with_the_same_payload_after_a_failure_runs_again() -> None:
    async def scenario(client: httpx.AsyncClient) -> tuple[httpx.Response, httpx.Response]:
        key = {"idempotency-key": KEY}
        first = await client.post("/v1/decisions", json=a_decision(phase="explode"), headers=key)
        second = await client.post("/v1/decisions", json=a_decision(phase="explode"), headers=key)
        return first, second

    (first, second), calls = run(scenario)

    assert (first.status_code, second.status_code) == (500, 500)
    assert len(calls) == 2, "a failed attempt wrote nothing, so the retry must run"


def test_a_missing_key_is_a_400() -> None:
    async def scenario(client: httpx.AsyncClient) -> httpx.Response:
        return await client.post("/v1/decisions", json=a_decision())

    response, calls = run(scenario)

    assert response.status_code == 400
    assert response.json()["error"]["details"]["reason"] == "missing_idempotency_key"
    assert calls == []


def test_a_key_outside_the_contract_s_length_is_a_400() -> None:
    async def scenario(client: httpx.AsyncClient) -> httpx.Response:
        return await client.post("/v1/decisions", json=a_decision(), headers={"idempotency-key": "short"})

    response, calls = run(scenario)

    assert response.status_code == 400
    assert response.json()["error"]["details"]["reason"] == "invalid_idempotency_key"
    assert calls == []


def test_a_read_operation_is_not_touched_by_the_middleware() -> None:
    """Only the operations the contract marks with `Idempotency-Key` are affected."""
    application = FastAPI()

    @application.get("/v1/approvals")
    async def list_approvals() -> dict[str, Any]:
        return {"items": []}

    application.add_middleware(IdempotencyMiddleware)
    application.add_middleware(Identify, verified=identity())

    async def scenario(client: httpx.AsyncClient) -> httpx.Response:
        return await client.get("/v1/approvals")

    response, calls = run(scenario, application=application)

    assert response.status_code == 200
    assert calls == []
