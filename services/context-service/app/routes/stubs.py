"""The unimplemented half of the contract surface, and who owns each handler.

A skeleton that registered only the routes it had implemented would leave C10 —
422 normalization — with nothing real to assert against, and would hide the size
of what is missing. So every operation in
`contracts/context-service-v1.openapi.yaml` is registered, and an unimplemented
one answers with an enveloped `500 internal` whose `details` name the ticket
that fills it. The response is contract-valid (every operation declares 500) and
unmistakably temporary.

`IMPLEMENTED` is the other half of the ledger: the route-parity test asserts that
every operation is either there or in `STUBS`, so a new endpoint cannot appear
without someone deciding whether it is real.
"""

from __future__ import annotations

from typing import NoReturn

from starlette.requests import Request

from app.contract import operation_for
from app.errors import FdeError

#: `operationId` → the ticket that replaces this handler.
STUBS: dict[str, str] = {
    "retrieveContext": "#39",
    "recordDecision": "#37",
    "getProvenance": "#37",
    "createApproval": "#40",
    "listApprovals": "#40",
    "decideApproval": "#40",
    "consumeApproval": "#40",
    "startIngestJob": "#39",
}

#: The operations this slice really serves.
IMPLEMENTED: frozenset[str] = frozenset({"healthz", "readyz", "getRuntimeInfo"})


def unimplemented(request: Request) -> NoReturn:
    """Refuse an operation this slice does not implement, naming its owner."""
    operation = operation_for(request)
    owner = STUBS.get(operation.operation_id)
    if owner is None:
        raise RuntimeError(
            f"{operation.operation_id} is not implemented and no ticket owns it; add it to STUBS"
        )
    raise FdeError(
        "internal",
        f"{operation.operation_id} is not implemented in this build of context-service",
        details={"reason": "not_implemented", "ticket": owner},
    )
