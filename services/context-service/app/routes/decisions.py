"""The `decisions` tag: the audit surface (§3.3, §6.2).

Handlers land in #37 (append-only store, idempotent writes, PROV-O).

The stub leaves `decision_id` a plain string: `getProvenance` does not declare a
422 (or a 400), so validating the id here would serve a status the contract
never promised. #37 owns the decision — malformed id → `404 not_found` (a stable
id that does not parse cannot name an existing decision) or a contract change,
decided with the handler that reads it.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from starlette.requests import Request

from app.routes.stubs import unimplemented, unimplemented_after_validation

router = APIRouter(tags=["decisions"])


@router.post("/v1/decisions", response_model=None)
async def record_decision(request: Request) -> JSONResponse:
    await unimplemented_after_validation(request)


@router.get("/v1/provenance/{decision_id}", response_model=None)
async def get_provenance(decision_id: str, request: Request) -> JSONResponse:
    raise unimplemented(request)
