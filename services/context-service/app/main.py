"""The ASGI application (`docs/runtime-contract.md` §9.1).

`create_app` is the one place the service is assembled, and it takes its
dependencies as arguments so a test can hand it a readiness registry (or an
identity verifier, or an idempotency store) without patching module state.

There is no module-level `app` on purpose: uvicorn is started with `--factory`,
so configuration is read when the process starts (and a missing key stops it
there) instead of when the module is imported. A test can therefore import this
module without a deployment's environment.

The lifespan is where the audit volume becomes real: `AuditStore.open()`
migrates or verifies the schema before the first request, and a background
`ChainVerifier` records one `verify_chain` pass at startup and then periodically.
An unopenable or foreign-schema audit store stops the process — a context service
that cannot keep evidence must not accept a Decision it will then fail to write.

The request edge is a stack of three middlewares, outermost first:

1. `TraceMiddleware` establishes the trace id every envelope and log line
   carries — so a failure from a middleware below still names its trace;
2. `IdentityMiddleware` verifies the `ExecutionContext` and refuses the request;
3. `IdempotencyMiddleware` scopes the write's `Idempotency-Key` to the tenant the
   identity just proved, then replays or forwards.

The implicit FastAPI surface is off on purpose: `/docs`, `/redoc` and
`/openapi.json` are not in `contracts/`, and a wire surface that includes routes
the contract does not describe is a surface the conformance runner cannot check.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI

from app.audit import AuditStore
from app.audit_verifier import ChainVerifier
from app.clock import isoformat_z, utc_now
from app.errors import install_error_handlers
from app.idempotency import IdempotencyMiddleware, IdempotencyStore
from app.identity import JwtVerifier
from app.identity_edge import IdentityMiddleware
from app.readiness import Readiness
from app.routes import approvals, context, decisions, jobs, ops
from app.settings import Settings
from app.tracing import TraceMiddleware


def create_app(
    *,
    settings: Settings | None = None,
    readiness: Readiness | None = None,
    verifier: JwtVerifier | None = None,
    idempotency: IdempotencyStore | None = None,
    audit: AuditStore | None = None,
) -> FastAPI:
    """Build the service. Missing required configuration fails here, at startup."""
    service_settings = settings if settings is not None else Settings.from_env()
    audit_store = audit if audit is not None else AuditStore(service_settings.audit_path)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        """Open the audit volume, start the chain verifier, and close both on shutdown.

        Opening here rather than in `create_app` keeps app construction side-effect
        free (a test can inspect the routes without a data volume), while a real
        process still fails closed: an unreadable or unmigrated audit store stops
        uvicorn before it serves a request that would need one.
        """
        audit_store.open()
        chain_verifier = ChainVerifier(audit_store)
        task = asyncio.create_task(chain_verifier.run())
        try:
            yield
        finally:
            await chain_verifier.stop()
            with suppress(asyncio.CancelledError):
                await task
            audit_store.close()

    application = FastAPI(
        title="FDE Context Service",
        # The contract in `contracts/` is the documentation; nothing here may
        # publish a second description of the surface.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    application.state.settings = service_settings
    application.state.readiness = readiness if readiness is not None else Readiness()
    application.state.started_at = isoformat_z(utc_now())
    application.state.audit = audit_store

    # `add_middleware` prepends, so this order is the *reverse* of the call order:
    # the last one added is the outermost.
    application.add_middleware(
        IdempotencyMiddleware,
        store=idempotency if idempotency is not None else IdempotencyStore(),
    )
    application.add_middleware(
        IdentityMiddleware,
        verifier=verifier if verifier is not None else JwtVerifier.from_settings(service_settings),
    )
    application.add_middleware(TraceMiddleware)

    install_error_handlers(application)
    for router in (ops.router, context.router, decisions.router, approvals.router, jobs.router):
        application.include_router(router)
    return application
