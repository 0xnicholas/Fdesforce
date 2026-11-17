"""The `jobs` tag: the internal maintenance surface (§3.3, §5.5).

Only the `fde-jobs` issuer reaches it, and #36 enforces that. The ingest pipeline
itself is #39's; the route exists here so the contract's surface is complete.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.contract import read_json_body
from app.routes.stubs import unimplemented

router = APIRouter(tags=["jobs"])


@router.post("/internal/v1/jobs/ingest", response_model=None)
async def start_ingest_job(request: Request) -> JSONResponse:
    await read_json_body(request)
    raise unimplemented(request)
