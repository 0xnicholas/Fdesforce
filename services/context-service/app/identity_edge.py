"""The request edge: the only place an `ExecutionContext` becomes an identity.

`app.identity` verifies a token in isolation. This module applies the other half
of §5.1/§5.3 — the checks that are about *this request* rather than the token:

| Check | Failure |
| --- | --- |
| `traceparent` is present and well-formed where the contract requires it | `400 invalid_request` |
| `Authorization: Bearer <jwt>` is present | `401 unauthenticated` |
| the JWT verifies (`app.identity`) | `401 unauthenticated` |
| the JWT `trace_id` equals the `traceparent` trace-id | `403 forbidden` |
| the operation accepts this issuer kind (`runtime` vs `jobs`) | `403 forbidden` |
| the token holds the operation's `x-fde-required-scope` | `403 forbidden` |
| a Run-scoped operation's token carries `run_id` (§5.1) | `401 unauthenticated` |
| `X-Tenant-Id` / `X-Actor`, if sent, agree with the token | `403 forbidden` |

A middleware, not a per-route dependency, because every authenticated operation
needs the same treatment and a route that forgot the dependency would be an
unauthenticated hole nobody notices. Nothing is read from a client-asserted field:
the token is the only identity source, and the request may only *agree* with it.

The tenant and scope decisions are made here, before the handler — so a handler
that reads `identity_of(request)` is reading a decision, not an argument.

One consequence is worth naming: a token is *spent* once it verifies, even if a
later check refuses the request (a wrong trace, a missing scope). That is the
fail-closed direction — a token that reached the service has been on the wire —
and it is why the harness, and mastra-app, mint one per call.
"""

from __future__ import annotations

from collections.abc import Mapping

from starlette.types import ASGIApp, Receive, Scope, Send

from app.contract import OPERATION_INDEX, OperationIndex
from app.errors import FdeError, forbidden, send_error, unauthenticated
from app.identity import IDENTITY_STATE_KEY, JwtVerifier, VerifiedIdentity
from app.tracing import trace_id_from
from app.wire import Operation

#: Plaintext identity headers the contract keeps for compatibility (§5.3). They
#: are never a source of identity: if present they must agree with the token.
LEGACY_IDENTITY_HEADERS: Mapping[bytes, str] = {
    b"x-tenant-id": "tenant",
    b"x-actor": "actor",
}


def bearer_token(authorization: str | None) -> str:
    """The token in an `Authorization: Bearer …` header, or a 401 explaining what is missing."""
    if not authorization:
        raise unauthenticated(
            "missing_token",
            "the request carries no Authorization header; this operation requires a signed ExecutionContext",
        )
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise unauthenticated(
            "malformed_authorization",
            "the Authorization header is not `Bearer <ExecutionContext>`; no other credential is accepted",
        )
    return token.strip()


class IdentityMiddleware:
    """Verify every authenticated request before it reaches a handler."""

    def __init__(self, app: ASGIApp, *, verifier: JwtVerifier, index: OperationIndex | None = None) -> None:
        self.app = app
        self.verifier = verifier
        self.index = index if index is not None else OPERATION_INDEX

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        operation = self.index.match(scope["method"], scope["path"])
        if operation is None or (not operation.auth and not operation.traceparent):
            # Not a contract operation (the router answers 404) or a public probe.
            await self.app(scope, receive, send)
            return

        try:
            identity = self._admit(scope, operation)
        except FdeError as error:
            await send_error(scope, receive, send, error)
            return

        if identity is not None:
            scope.setdefault("state", {})[IDENTITY_STATE_KEY] = identity
        await self.app(scope, receive, send)

    def _admit(self, scope: Scope, operation: Operation) -> VerifiedIdentity | None:
        """The request's identity, or the failure that refuses it."""
        headers = dict(scope.get("headers") or [])
        trace_id = self._trace_id(headers, operation)
        if not operation.auth:
            return None

        identity = self.verifier.verify(bearer_token(_text(headers.get(b"authorization"))))
        self._check_trace(identity, trace_id)
        self._check_issuer(identity, operation)
        self._check_scope(identity, operation)
        self._check_run_scope(identity, operation)
        self._check_plaintext_headers(identity, headers)
        return identity

    def _trace_id(self, headers: Mapping[bytes, bytes], operation: Operation) -> str | None:
        """The caller's trace, which the token's `trace_id` must repeat (§5.1, C6)."""
        if not operation.traceparent:
            return None
        trace_id = trace_id_from(_text(headers.get(b"traceparent")))
        if trace_id is None:
            raise FdeError(
                "invalid_request",
                f"{operation.operation_id} requires a W3C traceparent header "
                "(`00-<32 hex trace id>-<16 hex span id>-<flags>`)",
                details={"reason": "missing_traceparent"},
            )
        return trace_id

    def _check_trace(self, identity: VerifiedIdentity, trace_id: str | None) -> None:
        if trace_id is None:
            return
        claimed = identity.context.trace_id
        if claimed != trace_id:
            raise forbidden(
                "trace_mismatch",
                "the ExecutionContext's `trace_id` does not match the traceparent of this request; "
                "a token minted for another call cannot be replayed onto this one",
                token_trace_id=claimed,
                request_trace_id=trace_id,
            )

    def _check_issuer(self, identity: VerifiedIdentity, operation: Operation) -> None:
        if operation.issuer is None or identity.kind == operation.issuer:
            return
        raise forbidden(
            "issuer_not_allowed",
            f"{operation.operation_id} is served to the {operation.issuer!r} issuer only; "
            f"this token was signed by the {identity.kind!r} issuer",
            required_issuer=operation.issuer,
            token_issuer=identity.kind,
        )

    def _check_scope(self, identity: VerifiedIdentity, operation: Operation) -> None:
        if identity.has_scope(operation.required_scope):
            return
        raise forbidden(
            "missing_scope",
            f"{operation.operation_id} requires the {operation.required_scope!r} scope, "
            "which this ExecutionContext does not carry",
            required_scope=operation.required_scope,
        )

    def _check_run_scope(self, identity: VerifiedIdentity, operation: Operation) -> None:
        """§5.1: a Run-scoped call carries the Run it acts for."""
        if not operation.run_scoped or identity.context.run_id is not None:
            return
        raise unauthenticated(
            "missing_run_id",
            f"{operation.operation_id} is Run-scoped, and this ExecutionContext carries no `run_id`; "
            "a decision, a retrieval or an approval that names no Run cannot be attributed to one",
        )

    def _check_plaintext_headers(self, identity: VerifiedIdentity, headers: Mapping[bytes, bytes]) -> None:
        expected = {"tenant": identity.context.tenant_id, "actor": identity.context.actor.id}
        for name, field in LEGACY_IDENTITY_HEADERS.items():
            asserted = _text(headers.get(name))
            if asserted is not None and asserted != expected[field]:
                raise forbidden(
                    f"{field}_header_mismatch",
                    f"the {name.decode('ascii')} header disagrees with the ExecutionContext; "
                    "a plaintext header is never the identity, and a request that contradicts the "
                    "token is refused rather than resolved (§5.3)",
                    header=asserted,
                )


def _text(value: bytes | None) -> str | None:
    return None if value is None else value.decode("latin-1")
