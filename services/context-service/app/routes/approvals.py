"""The `approvals` tag: the approval resource and its state machine (§3.3, §8).

Handlers land in #40. `consumeApproval` declares no 422, so the stub leaves
`approval_id` a plain string rather than serve a status the operation never
promised; #40 decides the id's failure mode with the handler that reads it.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.routes.stubs import unimplemented, unimplemented_after_validation

router = APIRouter(tags=["approvals"])


@router.post("/v1/approvals", response_model=None)
async def create_approval(request: Request) -> JSONResponse:
    await unimplemented_after_validation(request)


@router.get("/v1/approvals", response_model=None)
async def list_approvals(request: Request) -> JSONResponse:
    raise unimplemented(request)


@router.post("/v1/approvals/{approval_id}/decisions", response_model=None)
async def decide_approval(approval_id: str, request: Request) -> JSONResponse:
    await unimplemented_after_validation(request)


@router.post("/v1/approvals/{approval_id}/consume", response_model=None)
async def consume_approval(approval_id: str, request: Request) -> JSONResponse:
    raise unimplemented(request)
