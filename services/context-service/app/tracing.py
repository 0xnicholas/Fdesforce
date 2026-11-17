"""W3C trace context and the service's trace id (§3.4, C6).

Every error envelope carries `trace_id`, and the value must be the trace the
caller started — not an id this service invented — when the caller supplied a
valid `traceparent`. A malformed or absent header gets a fresh trace here, so even
a probe answered without one is correlatable; whether *this* operation may go
without it is the request edge's question (`app.identity_edge`: a missing
`traceparent` is a 400, and a JWT `trace_id` that disagrees with it is a 403).
"""

from __future__ import annotations

import re
import secrets

from starlette.requests import Request
from starlette.types import ASGIApp, Receive, Scope, Send

#: `version-trace_id-parent_id-flags`, all lowercase hex, no `00` all-zero ids.
TRACEPARENT_PATTERN = re.compile(r"^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$")
_ALL_ZERO_TRACE_ID = "0" * 32

STATE_KEY = "trace_id"


def new_trace_id() -> str:
    """A fresh 128-bit trace id, the width `TraceId` requires."""
    return secrets.token_hex(16)


def trace_id_from(traceparent: str | None) -> str | None:
    """The trace id in a `traceparent`, or None when it is absent or unusable."""
    if traceparent is None:
        return None
    match = TRACEPARENT_PATTERN.match(traceparent.strip())
    if match is None:
        return None
    trace_id = match.group(1)
    return None if trace_id == _ALL_ZERO_TRACE_ID else trace_id


def trace_id_of(request: Request) -> str:
    """The request's trace id, established by `TraceMiddleware`."""
    trace_id = getattr(request.state, STATE_KEY, None)
    if isinstance(trace_id, str):
        return trace_id
    # Defensive: an error handler can run outside the middleware (a request that
    # never reached it). Deriving again keeps the envelope's trace_id valid.
    return trace_id_from(request.headers.get("traceparent")) or new_trace_id()


class TraceMiddleware:
    """Attach the caller's trace id (or a fresh one) to every request."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        raw = headers.get(b"traceparent")
        traceparent = raw.decode("latin-1") if raw is not None else None
        scope.setdefault("state", {})[STATE_KEY] = trace_id_from(traceparent) or new_trace_id()
        await self.app(scope, receive, send)
