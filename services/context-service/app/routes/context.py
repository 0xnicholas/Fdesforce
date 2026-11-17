"""The `context` tag: `POST /v1/context/retrieve` (§3.3, §4.1, §4.3).

The handler is deliberately thin: read the body through the contract (which also
binds `subject` to the token), hand the validated request to `app.retrieval` together
with the frozen package it names and what the ingest ledger says, store the Retrieval
Snapshot, and answer with the generated `RetrieveResponse`. Everything interesting —
the recipe's stages, the mask, the snapshot's digest, the degradation reasons — lives in
those modules, so a customer's package changes the pipeline without touching the wire
surface.

Three things this layer alone decides:

- **the tenant and the scopes are the token's** (`app.contract` already refuses a body
  that names another tenant; the mask stage and the recipe's source filters read the
  verified identity, never the body);
- **the trace is the caller's**, so the snapshot it stores and the response it
  returns name the same call (C6);
- **the snapshot is stored before it is returned.** A `retrieval_id` is a promise
  that a Decision can cite evidence an auditor can read back (§4.1); handing one out
  for a manifest the store refused would make the citation a dead reference, so a
  failed append is a failed request (`503 unavailable`, which is retryable).
"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from starlette.requests import Request

from app.audit import AuditStore, AuditStoreError, StoredSnapshot
from app.context_package import PackageError
from app.contract import read_json_body
from app.errors import FdeError
from app.generated.models import RetrieveResponse
from app.identity import identity_of
from app.retrieval import Snapshot, retrieve
from app.routes import audit_store, frozen_package, graph_store, ingest_status
from app.tracing import trace_id_of

router = APIRouter(tags=["context"])


@router.post("/v1/context/retrieve", response_model=None)
async def retrieve_context(request: Request) -> JSONResponse:
    """Execute the v0 retrieval pipeline and return its Retrieval Snapshot."""
    body = await read_json_body(request)
    identity = identity_of(request)
    try:
        snapshot = retrieve(
            frozen_package(request),
            graph_store(request),
            tenant_id=identity.context.tenant_id,
            trace_id=trace_id_of(request),
            request=body,
            scopes=identity.context.scopes,
            ingest_complete=ingest_status(request).complete(),
        )
    except PackageError as error:
        # The caller can only choose a recipe that was frozen: the model selects a plan,
        # it never writes one (§6.1), so an unknown id is a 404 rather than a guess.
        raise FdeError(
            "not_found",
            str(error),
            details={"reason": "recipe_not_found", "recipe_id": body.get("recipe_id")},
        ) from error
    _store(audit_store(request), snapshot)
    response = RetrieveResponse(
        retrieval_id=snapshot.retrieval_id,
        items=list(snapshot.items),
        degraded=snapshot.degraded,
        **{"reason": snapshot.reason} if snapshot.reason is not None else {},
        trace_id=snapshot.trace_id,
        snapshot_digest=snapshot.digest,
        budget_used=snapshot.budget_used,
        index=snapshot.index,
        **(
            {"policy_evaluations": [evaluation.model_dump(mode="json") for evaluation in snapshot.policy_evaluations]}
            if snapshot.policy_evaluations
            else {}
        ),
    )
    return JSONResponse(content=response.model_dump(mode="json", exclude_none=True))


def _store(store: AuditStore, snapshot: Snapshot) -> None:
    """Append the snapshot, or refuse the answer it belongs to."""
    try:
        store.append_retrieval_snapshot(
            StoredSnapshot(
                retrieval_id=snapshot.retrieval_id,
                tenant_id=snapshot.tenant_id,
                trace_id=snapshot.trace_id,
                created_at=snapshot.created_at,
                digest=snapshot.digest,
                manifest=snapshot.manifest,
            )
        )
    except (AuditStoreError, sqlite3.Error) as error:
        raise FdeError(
            "unavailable",
            "the Retrieval Snapshot could not be recorded, so this retrieval is not evidence yet",
            details={"reason": "snapshot_not_stored"},
        ) from error
