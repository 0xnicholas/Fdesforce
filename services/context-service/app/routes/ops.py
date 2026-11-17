"""The ops surface (§3.3, §9.2).

`/healthz` is liveness: the process is up and can answer a request at all. It
never checks a dependency, because "restart me" is the only action a liveness
failure implies and restarting a healthy process that lost its graph helps nobody.

`/readyz` is serviceability. It reports `ready` or `degraded` with a reason (200)
while the process can serve, and `not_ready` (503) when it cannot.

The 503 body is the one place where the unified error envelope does **not** apply:
`contracts/context-service-v1.openapi.yaml` defines `/readyz`'s 503 as
`{status: not_ready, reasons: []}`, and the bundled healthcheck reads only the
status code. Every other non-2xx response is an envelope (`app.errors`).
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.runtime_info import build_runtime_info

router = APIRouter(tags=["ops"])


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    """The process is alive."""
    return {"status": "ok"}


@router.get("/readyz", response_model=None)
async def readyz(request: Request) -> JSONResponse:
    """Whether this process can serve, and why not when it cannot."""
    report = request.app.state.readiness.evaluate()
    return JSONResponse(
        status_code=503 if report.not_ready else 200,
        content={"status": report.status, "reasons": list(report.reasons)},
    )


@router.get("/v1/runtime-info", response_model=None)
async def runtime_info(request: Request) -> JSONResponse:
    """This component's handshake document: what it is, not what the bundle is."""
    document = build_runtime_info(
        settings=request.app.state.settings,
        readiness=request.app.state.readiness,
        started_at=request.app.state.started_at,
    )
    return JSONResponse(content=document.model_dump(mode="json", exclude_none=True))
