"""The `approvals` tag: the approval resource and its state machine (§3.3, §8).

Handlers land in #40. `approval_id` is validated with the generated `ApprovalId`
so a malformed path is a 422 in the unified envelope.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.contract import read_json_body
from app.generated.models import ApprovalId
from app.routes.stubs import unimplemented

router = APIRouter(tags=["approvals"])


@router.post("/v1/approvals", response_model=None)
async def create_approval(request: Request) -> JSONResponse:
    await read_json_body(request)
    raise unimplemented(request)


@router.get("/v1/approvals", response_model=None)
async def list_approvals(request: Request) -> JSONResponse:
    raise unimplemented(request)


@router.post("/v1/approvals/{approval_id}/decisions", response_model=None)
async def decide_approval(approval_id: ApprovalId, request: Request) -> JSONResponse:
    await read_json_body(request)
    raise unimplemented(request)


@router.post("/v1/approvals/{approval_id}/consume", response_model=None)
async def consume_approval(approval_id: ApprovalId, request: Request) -> JSONResponse:
    raise unimplemented(request)
