"""The ASGI application (`docs/runtime-contract.md` §9.1).

`create_app` is the one place the service is assembled, and it takes its
dependencies as arguments so a test can hand it a readiness registry without
patching module state. `app` is what uvicorn serves.

The implicit FastAPI surface is off on purpose: `/docs`, `/redoc` and
`/openapi.json` are not in `contracts/`, and a wire surface that includes routes
the contract does not describe is a surface the conformance runner cannot check.
"""

from __future__ import annotations

from fastapi import FastAPI

from app.clock import isoformat_z, utc_now
from app.errors import install_error_handlers
from app.readiness import Readiness
from app.routes import approvals, context, decisions, jobs, ops
from app.settings import Settings
from app.tracing import TraceMiddleware


def create_app(*, settings: Settings | None = None, readiness: Readiness | None = None) -> FastAPI:
    """Build the service. Missing required configuration fails here, at startup."""
    service_settings = settings if settings is not None else Settings.from_env()

    application = FastAPI(
        title="FDE Context Service",
        # The contract in `contracts/` is the documentation; nothing here may
        # publish a second description of the surface.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    application.state.settings = service_settings
    application.state.readiness = readiness if readiness is not None else Readiness()
    application.state.started_at = isoformat_z(utc_now())

    application.add_middleware(TraceMiddleware)
    install_error_handlers(application)
    for router in (ops.router, context.router, decisions.router, approvals.router, jobs.router):
        application.include_router(router)
    return application


app = create_app()
