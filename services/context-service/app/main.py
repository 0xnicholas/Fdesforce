"""The ASGI application (`docs/runtime-contract.md` §9.1).

`create_app` is the one place the service is assembled, and it takes its
dependencies as arguments so a test can hand it a readiness registry (or an
identity verifier, or an idempotency store) without patching module state.

There is no module-level `app` on purpose: uvicorn is started with `--factory`,
so configuration is read when the process starts (and a missing key stops it
there) instead of when the module is imported. A test can therefore import this
module without a deployment's environment.

The lifespan is where the volumes become real: `AuditStore.open()` and
`EmbeddedGraphStore.open()` **verify** the schemas `python -m app.migrate`
established (§9.2 — the job migrates, the service refuses), and a background
`ChainVerifier` records one `verify_chain` pass at startup and then periodically.
The **Context Package**, the **Connectors** and the **ingest ledger** are assembled
here too: a service with no package has no recipe to execute, and one whose ledger says
the graph is not this package's current materialization must say `partial` rather than
answer as if it were.
An unopenable, unmigrated or foreign-schema volume stops the process — a context
service that cannot keep evidence, or cannot see the graph, must not accept a
request it will then answer wrongly.

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

from app.approvals import ApprovalStore, ApprovalSweeper
from app.audit import AuditStore
from app.audit_verifier import ChainVerifier
from app.clock import isoformat_z, utc_now
from app.connectors import ConnectorRegistry
from app.context_package import ContextPackage, PackageError
from app.errors import install_error_handlers
from app.graph.embedded import EmbeddedGraphStore
from app.graph.port import GraphStore
from app.graph.probes import GraphProbe
from app.idempotency import IdempotencyMiddleware, IdempotencyStore
from app.identity import JwtVerifier
from app.identity_edge import IdentityMiddleware
from app.ingest_ledger import IngestLedgerStore, IngestStatus
from app.readiness import Readiness
from app.routes import approvals, connectors, context, decisions, jobs, ops
from app.settings import ConfigurationError, Settings
from app.tracing import TraceMiddleware


def create_app(
    *,
    settings: Settings | None = None,
    readiness: Readiness | None = None,
    verifier: JwtVerifier | None = None,
    idempotency: IdempotencyStore | None = None,
    audit: AuditStore | None = None,
    graph: GraphStore | None = None,
    package: ContextPackage | None = None,
    connector_registry: ConnectorRegistry | None = None,
    ingest_ledger_store: IngestLedgerStore | None = None,
    approvals_store: ApprovalStore | None = None,
) -> FastAPI:
    """Build the service. Missing required configuration fails here, at startup."""
    service_settings = settings if settings is not None else Settings.from_env()
    audit_store = audit if audit is not None else AuditStore(service_settings.audit_path)
    approval_machine = approvals_store if approvals_store is not None else ApprovalStore(audit_store)
    graph_store = graph if graph is not None else EmbeddedGraphStore(service_settings.graph_path)
    context_pkg = package if package is not None else _load_package(service_settings)
    connector_registry = connector_registry if connector_registry is not None else ConnectorRegistry.reference()
    ledger = (
        ingest_ledger_store
        if ingest_ledger_store is not None
        else IngestLedgerStore.for_graph(service_settings.graph_path)
    )
    ingest_status = IngestStatus.for_package(ledger, context_pkg)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        """Open both volumes, start the chain verifier, and close them on shutdown.

        Opening here rather than in `create_app` keeps app construction side-effect
        free (a test can inspect the routes without a data volume), while a real
        process still fails closed: an unreadable or unmigrated volume stops uvicorn
        before it serves a request that would need one. Both volumes are opened
        before the first request, and both refusals are fatal — a service that kept
        evidence but had no graph (or the reverse) would answer half a question.
        """
        audit_store.open()
        graph_store.open()
        chain_verifier = ChainVerifier(audit_store)
        task = asyncio.create_task(chain_verifier.run())
        # Expiry is lazy on every read (§8.1, #40); this pass is what makes it true
        # for a queue nobody is reading, so an approval does not sit `pending` past
        # its deadline just because no request happened to look at it.
        expiry_sweeper = ApprovalSweeper(approval_machine)
        sweep_task = asyncio.create_task(expiry_sweeper.run())
        try:
            yield
        finally:
            await chain_verifier.stop()
            await expiry_sweeper.stop()
            with suppress(asyncio.CancelledError):
                await task
                await sweep_task
            graph_store.close()
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
    application.state.readiness = (
        readiness if readiness is not None else Readiness([GraphProbe(graph_store), ingest_status])
    )
    application.state.started_at = isoformat_z(utc_now())
    application.state.audit = audit_store
    application.state.graph = graph_store
    application.state.context_package = context_pkg
    application.state.connectors = connector_registry
    application.state.ingest_status = ingest_status
    application.state.approvals = approval_machine

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
    for router in (
        ops.router,
        context.router,
        connectors.router,
        decisions.router,
        approvals.router,
        jobs.router,
    ):
        application.include_router(router)
    return application


def _load_package(settings: Settings) -> ContextPackage:
    """The frozen package this deployment serves, or a startup failure naming why not.

    Fail closed, like the volumes: a service that booted without a package would accept
    `POST /v1/context/retrieve` and answer 404 to every recipe, which is an outage an
    operator would only find from the caller's side.
    """
    try:
        return ContextPackage.load(settings.context_package_path)
    except PackageError as error:
        raise ConfigurationError(
            f"CONTEXT_PACKAGE_PATH={settings.context_package_path!r} is not a servable Context Package: "
            f"{error}; the bundle mounts the frozen package read-only"
        ) from error
