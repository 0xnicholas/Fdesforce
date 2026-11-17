"""The `decisions` tag: the audit surface (§3.3, §6.2).

Handlers land in #37 (append-only store, idempotent writes, PROV-O). The path
parameter is validated with the generated `DecisionId`, so a malformed id is a
422 in the contract's envelope rather than a 500 from a stub that never looked.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from starlette.requests import Request

from app.contract import read_json_body
from app.generated.models import DecisionId
from app.routes.stubs import unimplemented

router = APIRouter(tags=["decisions"])


@router.post("/v1/decisions", response_model=None)
async def record_decision(request: Request) -> JSONResponse:
    await read_json_body(request)
    raise unimplemented(request)


@router.get("/v1/provenance/{decision_id}", response_model=None)
async def get_provenance(decision_id: DecisionId, request: Request) -> JSONResponse:
    raise unimplemented(request)
