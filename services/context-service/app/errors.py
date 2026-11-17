"""The one error shape every non-2xx response has (§3.4).

`docs/runtime-contract.md` §3.4 fixes both the envelope and the code → status /
retryable table; FastAPI's defaults (`{"detail": ...}`) are not that shape, and
C10 exists because a client must not have to parse two error formats. So every
framework failure is translated here: routing 404/405, request validation 422,
our own `FdeError`, and the unclassified 500.

The envelope itself is built with the *generated* `Error` model, so an error code
the contract does not define cannot be emitted — `ErrorDetail` would refuse it.

`/readyz` is the documented exception: its 503 body is the probe document (§9.2).
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import Request
from starlette.types import Receive, Scope, Send

from app.generated.models import Error, ErrorDetail
from app.tracing import trace_id_of

logger = logging.getLogger("fde.context_service")

#: §3.4's table. A code that is not here has no HTTP meaning, so `FdeError`
#: refuses to construct it rather than inventing a status at the response edge.
ERROR_HTTP_STATUS: Mapping[str, int] = {
    "invalid_request": 400,
    "unauthenticated": 401,
    "forbidden": 403,
    "not_found": 404,
    "thread_not_found": 404,
    "conflict": 409,
    "idempotency_conflict": 409,
    "approval_already_decided": 409,
    "run_not_suspended": 409,
    "stream_not_resumable": 409,
    "validation_failed": 422,
    "rate_limited": 429,
    "bad_gateway": 502,
    "unavailable": 503,
    "timeout": 504,
    "internal": 500,
    "contract_mismatch": 503,
    "runtime_capability_mismatch": 503,
    "graph_schema_mismatch": 503,
    "audit_schema_mismatch": 503,
}

#: The codes a client may retry. Only a transient dependency failure qualifies;
#: a validation or authorization failure retried is the same failure.
RETRYABLE_CODES = frozenset({"rate_limited", "bad_gateway", "unavailable", "timeout"})

#: How a status the framework produced maps to a contract code. 405 keeps its
#: status — the method is wrong, and a 400 would hide that — while `invalid_request`
#: names the class of failure the table describes.
HTTP_STATUS_TO_ERROR: Mapping[int, str] = {
    400: "invalid_request",
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    405: "invalid_request",
    406: "invalid_request",
    409: "conflict",
    413: "invalid_request",
    415: "invalid_request",
    422: "validation_failed",
    429: "rate_limited",
    500: "internal",
    501: "internal",
    502: "bad_gateway",
    503: "unavailable",
    504: "timeout",
}


class FdeError(Exception):
    """A failure the service chose, with the contract code a client reads."""
    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: Mapping[str, Any] | None = None,
        status: int | None = None,
        retryable: bool | None = None,
    ) -> None:
        if code not in ERROR_HTTP_STATUS:
            raise ValueError(f"{code!r} is not a contract error code")
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = dict(details) if details is not None else None
        self.status = ERROR_HTTP_STATUS[code] if status is None else status
        self.retryable = (code in RETRYABLE_CODES) if retryable is None else retryable


def unauthenticated(reason: str, message: str) -> FdeError:
    """401: there is no identity here, and the reason says which check failed."""
    return FdeError("unauthenticated", message, details={"reason": reason})


def forbidden(reason: str, message: str, **details: object) -> FdeError:
    """403: the identity is real, but not allowed to do *this*."""
    return FdeError("forbidden", message, details={"reason": reason, **details})


def envelope(
    request: Request,
    *,
    code: str,
    message: str,
    status: int | None = None,
    details: Mapping[str, Any] | None = None,
    retryable: bool | None = None,
) -> JSONResponse:
    """The one response body every failure produces.

    `status` overrides the table's status only for a framework status that has an
    exact contract code but a different number (405 with `invalid_request`).
    """
    detail = ErrorDetail(
        code=code,  # type: ignore[arg-type]  # the generated model validates the enum
        message=message,
        retryable=(code in RETRYABLE_CODES) if retryable is None else retryable,
        trace_id=trace_id_of(request),
        details=dict(details) if details is not None else None,
    )
    body = Error(error=detail).model_dump(mode="json", exclude_none=True)
    return JSONResponse(status_code=ERROR_HTTP_STATUS[code] if status is None else status, content=body)


async def _fde_error(request: Request, exc: FdeError) -> JSONResponse:
    return envelope(
        request,
        code=exc.code,
        message=exc.message,
        status=exc.status,
        details=exc.details,
        retryable=exc.retryable,
    )


async def send_error(scope: Scope, receive: Receive, send: Send, error: FdeError) -> None:
    """Write a failure raised *outside* the router as the same envelope.

    Middleware sits outside Starlette's `ExceptionMiddleware`, so an `FdeError`
    raised there would reach the catch-all and lose its code. The request edge
    therefore sends the response itself — through the same `envelope`, so both
    paths cannot drift.
    """
    response = envelope(
        Request(scope, receive),
        code=error.code,
        message=error.message,
        status=error.status,
        details=error.details,
        retryable=error.retryable,
    )
    await response(scope, receive, send)


async def _request_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    """FastAPI's 422, normalized (C10).

    The request *body* is validated against `contracts/` before FastAPI sees it
    (`app.contract`), so this handler covers the framework's own path/query
    parsing — the other place a 422 can be born.
    """
    details = {
        "errors": [
            {
                "path": ".".join(str(part) for part in error.get("loc", ())),
                "message": error.get("msg", "invalid value"),
            }
            for error in exc.errors()
        ]
    }
    return envelope(request, code="validation_failed", message="the request is not valid", details=details)


async def _http_exception(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    code = HTTP_STATUS_TO_ERROR.get(exc.status_code)
    if code is None:
        # No contract code describes this status; report it as the unclassified
        # internal failure rather than emit a code/status pair the table forbids.
        code = "internal"
    if exc.status_code == 404:
        message = f"{request.method} {request.url.path} is not a route this service serves"
    elif exc.status_code == 405:
        message = f"{request.method} is not allowed on {request.url.path}"
    else:
        message = exc.detail if isinstance(exc.detail, str) else f"HTTP {exc.status_code}"
    return envelope(request, code=code, message=message, status=exc.status_code)


async def _unexpected(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("unhandled error trace_id=%s", trace_id_of(request), exc_info=exc)
    return envelope(request, code="internal", message="an unexpected internal error occurred")


def install_error_handlers(app: FastAPI) -> None:
    """Make every failure leave through `app.errors`, not FastAPI's defaults."""
    app.add_exception_handler(FdeError, _fde_error)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, _request_validation_error)  # type: ignore[arg-type]
    app.add_exception_handler(StarletteHTTPException, _http_exception)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, _unexpected)
