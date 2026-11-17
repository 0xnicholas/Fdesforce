"""Write idempotency (§3.5, C4/C5): one key, one outcome, for a day.

Every write operation the contract marks with `Idempotency-Key` promises the same
thing: a retry of the same logical write returns the first result instead of
writing twice, and a *different* write under the same key is a client bug the
service refuses rather than guesses at. The key is scoped by
`tenant_id + endpoint + key`, so one tenant's key space is not another's and two
operations cannot collide.

What is remembered, and for how long:

- the **payload fingerprint**, from the first request and for 24 hours: the same
  key with a different body is a conflict even when the first attempt failed,
  because the key names one operation, not one attempt;
- the **response** (status and body), only for a 2xx: a failed attempt did not
  happen, so a retry is allowed to succeed;
- **"being handled now"**, until the response is written: two concurrent copies
  of one write are a conflict, not two writes.

The store is keyed in memory. That is enough because the Decision write's durable
identity is `decision_id` in the audit store (`app.audit`): a restart forgets the
key, the retry reaches the handler, and the handler returns the entry the id
already names instead of appending a second one. This store is therefore a fast
path that replays the original HTTP response byte for byte — it is not the
mechanism a restart could undo. When the approval store lands (#40) it gets the
same two layers.

A replay answers `200` with the original body (§3.5). When the operation's
response schema declares `idempotent_replay`, the flag is flipped to `true` in the
replayed body; the approval responses do not declare it, and the contract is a
closed object, so they are replayed exactly as recorded.

The recorded body is replayed verbatim, `trace_id` included — and that is C6-safe
because a legitimate retry *is* the same trace: the body's `trace_id` must equal
the `ExecutionContext`'s, which must equal the request's `traceparent`, so the
original body already names the caller's trace.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from starlette.requests import Request
from starlette.types import ASGIApp, Receive, Scope, Send

from app.canonical import canonical_json
from app.contract import OPERATION_INDEX, OperationIndex
from app.errors import FdeError, send_error
from app.expiry import ExpiringRecords
from app.generated.api import IDEMPOTENCY_KEY_LENGTH
from app.generated.schemas import SCHEMAS
from app.identity import identity_of
from app.wire import Operation

#: The `Idempotency-Key` length the contract declares (generated from the parameter).
MIN_KEY_LENGTH, MAX_KEY_LENGTH = IDEMPOTENCY_KEY_LENGTH

#: How long a key keeps its meaning. At least 24 hours, per §3.5.
RETENTION_SECONDS = 24 * 60 * 60

#: The response field that marks a replay, when the schema declares it.
REPLAY_FLAG = "idempotent_replay"

OutcomeKind = Literal["proceed", "replay", "conflict"]


@dataclass(frozen=True)
class KeyScope:
    """One tenant's one operation's one key: the unit a replay is looked up by."""

    tenant_id: str
    endpoint: str
    key: str


@dataclass(frozen=True)
class RecordedResponse:
    """What the first attempt answered, replayed byte for byte."""

    status: int
    body: bytes
    content_type: str


@dataclass(frozen=True)
class Entry:
    """What the store knows about one key. The retention window is the store's."""

    fingerprint: str
    response: RecordedResponse | None = None
    in_flight: bool = False


@dataclass(frozen=True)
class Outcome:
    """The store's answer: go ahead, replay this, or refuse with this reason."""

    kind: OutcomeKind
    response: RecordedResponse | None = None
    reason: str | None = None


PROCEED = Outcome("proceed")


def conflict(reason: str) -> Outcome:
    return Outcome("conflict", reason=reason)


class IdempotencyStore:
    """`KeyScope` → `Entry`, retained for `RETENTION_SECONDS`."""

    def __init__(self, *, now: Callable[[], float] | None = None, retention: float = RETENTION_SECONDS) -> None:
        self._entries: ExpiringRecords[KeyScope, Entry] = ExpiringRecords(now=now)
        self._retention = retention

    def begin(self, scope: KeyScope, fingerprint: str) -> Outcome:
        """Reserve the key, or answer with what the first attempt already did."""
        entry = self._entries.get(scope)
        if entry is None:
            self._reserve(scope, fingerprint)
            return PROCEED

        if entry.fingerprint != fingerprint:
            return conflict("payload_mismatch")
        if entry.response is not None:
            return Outcome("replay", response=entry.response)
        if entry.in_flight:
            # No response and still running: a second copy would be a second write.
            return conflict("in_flight")
        self._reserve(scope, entry.fingerprint)
        return PROCEED

    def complete(self, scope: KeyScope, response: RecordedResponse) -> None:
        """Remember a success, so a retry replays it."""
        entry = self._entries.get(scope)
        self._record(
            scope,
            Entry(fingerprint=entry.fingerprint if entry is not None else "", response=response, in_flight=False),
        )

    def abandon(self, scope: KeyScope) -> None:
        """A failed attempt: keep the fingerprint, forget that it was running."""
        entry = self._entries.get(scope)
        if entry is None:
            return
        self._record(scope, Entry(fingerprint=entry.fingerprint, response=None, in_flight=False))

    def _reserve(self, scope: KeyScope, fingerprint: str) -> None:
        self._record(scope, Entry(fingerprint=fingerprint, in_flight=True))

    def _record(self, scope: KeyScope, entry: Entry) -> None:
        """Store `entry` with a fresh retention window, stamped on the store's clock."""
        self._entries.put(scope, entry, expires_at=self._entries.now + self._retention)

    def __len__(self) -> int:
        return len(self._entries)


def fingerprint(body: bytes) -> str:
    """A stable digest of the *payload*, not of its bytes.

    Key order and whitespace are transport, not meaning: the same decision
    written with reordered keys is the same decision, and a retry must replay it
    rather than conflict. The canonical form is shared with the audit chain
    (`app.canonical`), so "same payload" means the same thing at both seams.
    """
    try:
        parsed = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return hashlib.sha256(body).hexdigest()
    return hashlib.sha256(canonical_json(parsed).encode("utf-8")).hexdigest()


def declares_replay_flag(operation: Operation) -> bool:
    """Whether the operation's response schema has somewhere to put `idempotent_replay`."""
    reference = operation.response_ref
    if reference is None:
        return False
    schema: Any = SCHEMAS.get(reference.file)
    for part in [piece for piece in reference.pointer.split("/") if piece]:
        if not isinstance(schema, dict) or part not in schema:
            return False
        schema = schema[part]
    properties = schema.get("properties") if isinstance(schema, dict) else None
    return isinstance(properties, dict) and REPLAY_FLAG in properties


def replay_body(operation: Operation, response: RecordedResponse) -> bytes:
    """The recorded body, with the replay flag set where the contract has one."""
    if not declares_replay_flag(operation):
        return response.body
    try:
        document = json.loads(response.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return response.body
    if not isinstance(document, dict):
        return response.body
    document[REPLAY_FLAG] = True
    return json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class IdempotencyMiddleware:
    """Require, scope, and honour `Idempotency-Key` on the operations that declare it."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        store: IdempotencyStore | None = None,
        index: OperationIndex | None = None,
    ) -> None:
        self.app = app
        self.store = store if store is not None else IdempotencyStore()
        self.index = index if index is not None else OPERATION_INDEX

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        operation = self.index.match(scope["method"], scope["path"])
        if operation is None or not operation.idempotency_key:
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        body = await _read_body(receive)
        try:
            key_scope = _key_scope(scope, headers, operation)
            outcome = self.store.begin(key_scope, fingerprint(body))
        except FdeError as error:
            await send_error(scope, receive, send, error)
            return

        if outcome.kind == "conflict":
            await send_error(scope, receive, send, _conflict_error(outcome.reason))
            return
        if outcome.kind == "replay" and outcome.response is not None:
            await _send(send, operation.replay_status, outcome.response, replay_body(operation, outcome.response))
            return

        recorder = _Capture(send)
        await self.app(scope, _replay_receive(body), recorder)
        recorded = recorder.response
        if recorded is None:
            self.store.abandon(key_scope)
            return
        if 200 <= recorded.status < 300:
            self.store.complete(key_scope, recorded)
        else:
            self.store.abandon(key_scope)


def _key_scope(scope: Scope, headers: Mapping[bytes, bytes], operation: Operation) -> KeyScope:
    raw = headers.get(b"idempotency-key")
    key = raw.decode("latin-1").strip() if raw is not None else ""
    if not key:
        raise FdeError(
            "invalid_request",
            f"{operation.operation_id} is a write and requires an Idempotency-Key header; "
            "a retry must reuse the key, not mint one",
            details={"reason": "missing_idempotency_key"},
        )
    if not MIN_KEY_LENGTH <= len(key) <= MAX_KEY_LENGTH:
        raise FdeError(
            "invalid_request",
            f"the Idempotency-Key is {len(key)} characters; the contract allows "
            f"{MIN_KEY_LENGTH}–{MAX_KEY_LENGTH}",
            details={"reason": "invalid_idempotency_key"},
        )
    tenant_id = identity_of(Request(scope)).context.tenant_id
    return KeyScope(tenant_id=tenant_id, endpoint=operation.operation_id, key=key)


def _conflict_error(reason: str | None) -> FdeError:
    if reason == "in_flight":
        # `conflict` is 409/not-retryable in §3.4's table, and a code's retryable
        # value is the contract's, not this call's. The same key with the same body
        # answers with the recorded result once the first attempt finishes.
        return FdeError(
            "conflict",
            "an identical request with this Idempotency-Key is already being handled; "
            "this key will answer with that attempt's result",
            details={"reason": "idempotency_in_flight"},
        )
    return FdeError(
        "idempotency_conflict",
        "this Idempotency-Key was already used with a different payload; "
        "a key identifies one write, so a different body needs a new key",
        details={"reason": "idempotency_conflict"},
    )


async def _read_body(receive: Receive) -> bytes:
    """Buffer the request body so it can be fingerprinted and still be read downstream."""
    body = b""
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            break
        body += message.get("body", b"")
        if not message.get("more_body", False):
            break
    return body


def _replay_receive(body: bytes) -> Receive:
    """A `receive` that hands the buffered body downstream once, then disconnects."""
    delivered = False

    async def receive() -> dict[str, Any]:
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return receive


class _Capture:
    """A `send` that records what the handler answered while passing it through."""

    def __init__(self, send: Send) -> None:
        self.send = send
        self.status: int | None = None
        self.body = b""
        self.content_type = "application/json"
        self.complete = False

    @property
    def response(self) -> RecordedResponse | None:
        if self.status is None or not self.complete:
            return None
        return RecordedResponse(status=self.status, body=self.body, content_type=self.content_type)

    async def __call__(self, message: dict[str, Any]) -> None:
        if message["type"] == "http.response.start":
            self.status = int(message["status"])
            for name, value in message.get("headers") or []:
                if name.lower() == b"content-type":
                    self.content_type = value.decode("latin-1")
        elif message["type"] == "http.response.body":
            self.body += message.get("body", b"")
            self.complete = not message.get("more_body", False)
        await self.send(message)


async def _send(send: Send, status: int, recorded: RecordedResponse, body: bytes) -> None:
    headers = [
        (b"content-type", recorded.content_type.encode("latin-1")),
        (b"content-length", str(len(body)).encode("ascii")),
    ]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})
