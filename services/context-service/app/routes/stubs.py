"""The implementation ledger for the contract surface.

`IMPLEMENTED` names the operations this build really serves; `STUBS` names the
ones that are registered but answer with an enveloped `500` naming the ticket that
fills them. The route-parity test asserts that every operation in
`contracts/context-service-v1.openapi.yaml` is in exactly one of the two, so a
route cannot be registered without a decision about whether it is real.

Since #40 the ledger is one-sided — approvals were the last stubbed tag — but the
mechanism stays for the Slices that follow: a stub's `500 internal` is
contract-valid (every operation declares 500) and says who owns it, which is what
kept the skeleton from quietly shrinking the surface it claimed.
"""

from __future__ import annotations

#: `operationId` → the ticket that will implement this handler.
STUBS: dict[str, str] = {}

#: The operations this slice really serves.
IMPLEMENTED: frozenset[str] = frozenset(
    {
        "healthz",
        "readyz",
        "getRuntimeInfo",
        "recordDecision",
        "getProvenance",
        "retrieveContext",
        "invokeConnectorOperation",
        "startIngestJob",
        "createApproval",
        "listApprovals",
        "decideApproval",
        "consumeApproval",
    }
)
