"""The `jobs` tag: the internal maintenance surface (§3.3, §5.5).

Only the `fde-jobs` issuer reaches it (enforced by `app.identity_edge` from the
contract's `x-fde-issuer`), with the `context:ingest` maintenance scope, and the call is
not Run-scoped — a maintenance job does not act for a Run.

`POST /internal/v1/jobs/ingest` runs `app.ingest` synchronously and answers with the
finished job, which is what this slice's contract says ("synchronous in this slice: the
response is the outcome, not a handle to poll"). The job runs in the request's turn on
purpose: the graph store is single-writer by contract (§4.3) and has no lock of its own,
so a background thread would trade a millisecond of latency at v0's 10k-node ceiling for
a read/write race against `retrieve`. When the job outgrows a request, it moves to a
worker **with** a writer lock — not before.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from starlette.requests import Request

from app.contract import read_json_body
from app.errors import FdeError
from app.identity import identity_of
from app.ingest import IngestError, IngestRequest, PackageNotFrozen, UnknownSource, run
from app.routes import connector_registry, frozen_package, graph_store, ingest_status

router = APIRouter(tags=["jobs"])


@router.post("/internal/v1/jobs/ingest", response_model=None)
async def start_ingest_job(request: Request) -> JSONResponse:
    """Materialize a frozen Context Package revision, and answer with the finished job."""
    body = await read_json_body(request)
    job_request = IngestRequest.from_wire(body)
    try:
        result = run(
            frozen_package(request),
            connector_registry(request),
            graph_store(request),
            ingest_status(request).store,
            tenant_id=identity_of(request).context.tenant_id,
            request=job_request,
        )
    except PackageNotFrozen as error:
        # §5.5: only frozen semantics are materializable. The lock pinned a digest; a job
        # that materialized another revision would serve semantics nobody signed off.
        raise FdeError(
            "conflict",
            str(error),
            details={"reason": "package_not_frozen", "package": job_request.package.as_dict()},
        ) from error
    except UnknownSource as error:
        raise FdeError(
            "validation_failed",
            str(error),
            details={"reason": "unknown_source", "sources": list(job_request.sources or ())},
        ) from error
    except IngestError as error:
        raise FdeError("conflict", str(error), details={"reason": "ingest_conflict"}) from error
    return JSONResponse(content=result.as_dict())
