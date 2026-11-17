"""The `context` tag: `POST /v1/context/retrieve` (§3.3).

The handler is #39's (the deterministic Recipe pipeline). This slice registers
the route and validates its body against the contract, which is what makes C10 a
real claim: the 422 is produced by the shipped surface, not by a test fixture.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from starlette.requests import Request

from app.contract import read_json_body
from app.routes.stubs import unimplemented

router = APIRouter(tags=["context"])


@router.post("/v1/context/retrieve", response_model=None)
async def retrieve_context(request: Request) -> JSONResponse:
    await read_json_body(request)
    raise unimplemented(request)
