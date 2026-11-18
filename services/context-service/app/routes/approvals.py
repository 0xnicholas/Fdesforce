"""The `approvals` tag: the approval resource and its state machine (§3.3, §8, C8).

Thin handlers over `app.approvals`, which owns the statuses, the Decisions and
the idempotency. This module decides only what belongs to the wire:

- **which identity is acting** — the requester (`requested_by`), the approver
  (`actor`), the tenant and the Run all come from the verified token; a body that
  disagrees never reached here (`app.contract.bind_identity` refused it);
- **what a page is** — the query declarations below are the one place the handler
  names parameters, and `LIST_QUERY` is asserted against the OpenAPI in
  `tests/test_approvals_http.py` so the two cannot drift;
- **what a response is** — every document is built through the generated model, so
  a field the contract does not define cannot be emitted.

`getProvenance` is where an approval becomes auditable: `Approval.decision_id`
names the Decision that put the resource in its current state — the request while
pending, the approval (or expiry) Decision afterwards.
"""

from __future__ import annotations

from collections.abc import Mapping

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from starlette.requests import Request

from app.approvals import ApprovalPage, ApprovalRecord
from app.contract import read_json_body, read_query, violations
from app.errors import FdeError
from app.generated.models import Approval, ApprovalDecisionResponse, ApprovalList
from app.idempotency import key_of
from app.identity import identity_of
from app.routes import approval_store
from app.tracing import trace_id_of
from app.wire import SchemaRef

router = APIRouter(tags=["approvals"])

#: The `GET /v1/approvals` parameters the handler reads. Each schema is the one
#: the OpenAPI parameter references, so the enum, the bounds and the cursor's
#: length are the contract's — not a second copy here.
LIST_QUERY: Mapping[str, SchemaRef] = {
    "status": SchemaRef("approval.schema.json", "/$defs/ApprovalStatus"),
    "run_id": SchemaRef("common.schema.json", "/$defs/RunId"),
    "capability_id": SchemaRef("common.schema.json", "/$defs/CapabilityId"),
    "limit": SchemaRef("approval.schema.json", "/$defs/ApprovalListLimit"),
    "cursor": SchemaRef("approval.schema.json", "/$defs/ApprovalListCursor"),
}

APPROVAL_ID = SchemaRef("common.schema.json", "/$defs/ApprovalId")


@router.post("/v1/approvals", response_model=None)
async def create_approval(request: Request) -> JSONResponse:
    """Create a pending approval, or replay the one this key already created."""
    body = await read_json_body(request)
    identity = identity_of(request)
    result = approval_store(request).create(
        body,
        tenant_id=identity.context.tenant_id,
        key=key_of(request),
        trace_id=trace_id_of(request),
    )
    return _approval(result.record, status_code=201 if result.created else 200)


@router.get("/v1/approvals", response_model=None)
async def list_approvals(request: Request) -> JSONResponse:
    """One page of the caller's tenant's approval queue, newest first."""
    query = read_query(request, LIST_QUERY)
    page: ApprovalPage = approval_store(request).approvals(
        tenant_id=identity_of(request).context.tenant_id,
        status=query.get("status"),
        run_id=query.get("run_id"),
        capability_id=query.get("capability_id"),
        limit=int(query.get("limit", 50)),
        cursor=query.get("cursor"),
    )
    document = ApprovalList(**page.wire())
    return JSONResponse(content=document.model_dump(mode="json", exclude_none=True))


@router.post("/v1/approvals/{approval_id}/decisions", response_model=None)
async def decide_approval(approval_id: str, request: Request) -> JSONResponse:
    """Approve or reject a pending approval, writing the Decision that says so."""
    body = await read_json_body(request)
    identity = identity_of(request)
    record = approval_store(request).decide(
        _approval_id(approval_id),
        tenant_id=identity.context.tenant_id,
        run_id=_run_of(identity.context.run_id),
        request=body,
        actor={"type": identity.context.actor.type, "id": identity.context.actor.id},
        roles=identity.context.roles,
        trace_id=trace_id_of(request),
        key=key_of(request),
    ).record
    outcome = record.outcome
    if outcome is None or record.decided_decision_id is None or record.decided_at is None:
        raise RuntimeError(f"approval {record.approval_id} answered a decision without a recorded outcome")
    response = ApprovalDecisionResponse(
        approval_id=record.approval_id,
        status=outcome,
        decision_id=record.decided_decision_id,
        provenance_id=record.decided_provenance_id,
        decided_at=record.decided_at,
    )
    return JSONResponse(content=response.model_dump(mode="json", exclude_none=True))


@router.post("/v1/approvals/{approval_id}/consume", response_model=None)
async def consume_approval(approval_id: str, request: Request) -> JSONResponse:
    """Mark an approved approval consumed, idempotently (§8.2 step 6)."""
    identity = identity_of(request)
    record = approval_store(request).consume(
        _approval_id(approval_id),
        tenant_id=identity.context.tenant_id,
        run_id=_run_of(identity.context.run_id),
    )
    return _approval(record, status_code=200)


def _approval(record: ApprovalRecord, *, status_code: int) -> JSONResponse:
    """The contract's `Approval`, validated by the generated model before it is sent."""
    document = Approval(**record.wire())
    return JSONResponse(status_code=status_code, content=document.model_dump(mode="json", exclude_none=True))


def _approval_id(value: str) -> str:
    """A path id that cannot name an approval is absent, not malformed.

    `getProvenance` answers the same way for the same reason: `decideApproval` and
    `consumeApproval` both declare a 404 and neither declares a 422 for their path
    parameter, so an id that is not an `appr_<ULID>` cannot be one that exists.
    """
    if violations(value, APPROVAL_ID):
        raise FdeError(
            "not_found",
            f"{value!r} is not an approval id; no approval can carry it",
            details={"reason": "approval_not_found"},
        )
    return value


def _run_of(run_id: str | None) -> str:
    """The Run a Run-scoped call acts for; the identity middleware guarantees one (§5.1)."""
    if run_id is None:
        raise RuntimeError(
            "an approval operation is Run-scoped and reached its handler without `run_id`; "
            "the identity middleware refuses such a token"
        )
    return run_id
