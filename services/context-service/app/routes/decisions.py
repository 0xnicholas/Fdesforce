"""The `decisions` tag: the audit surface (§3.4, §3.5, §6.2–6.4, C4/C13/C14).

Two operations, one store:

- `POST /v1/decisions` appends the caller's Decision to the append-only chain.
  `decision_id` is the durable idempotency key (§4.2): a repeated write returns the
  entry that already exists — `200` with `idempotent_replay: true` — instead of
  appending a second link, and a repeated id with a *different* payload is a
  `409 idempotency_conflict`. The `Idempotency-Key` middleware in front of this
  handler is a fast path for the same key; it is not what makes the write
  idempotent, which is why a restart cannot turn one write into two.
- `GET /v1/provenance/{decision_id}` returns the original Decision, its PROV-O
  document and a lineage summary, from the tenant the token names. The read does
  not verify the chain: it reports the last background verification (§6.4), so a
  provenance read costs the same at 10 entries and at 100 000.

The response models are the generated ones, so a field the contract does not
define cannot be emitted, and every value it does define is validated here rather
than by the client.

A malformed `decision_id` is a `404`, not a `422`: `getProvenance` declares no
422, and a stable id that does not parse cannot name an entry.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from starlette.requests import Request

from app.audit import AuditStore, DecisionConflict
from app.contract import read_json_body
from app.errors import FdeError
from app.generated.models import DecisionResponse, ProvenanceResponse, ProvenanceResponseVerification
from app.identity import identity_of
from app.provenance import lineage, prov_o
from app.tracing import trace_id_of

router = APIRouter(tags=["decisions"])


def audit_store(request: Request) -> AuditStore:
    """The store `create_app` opened for this process."""
    store = getattr(request.app.state, "audit", None)
    if not isinstance(store, AuditStore):
        raise RuntimeError(
            "this process has no audit store; `create_app` attaches one and opens it in the lifespan"
        )
    return store


@router.post("/v1/decisions", response_model=None)
async def record_decision(request: Request) -> JSONResponse:
    """Record one immutable Decision, or replay the entry its id already names."""
    decision = await read_json_body(request)
    try:
        result = audit_store(request).append_decision(decision)
    except DecisionConflict as conflict:
        raise FdeError(
            "idempotency_conflict",
            str(conflict),
            details={"reason": "decision_id_conflict"},
        ) from conflict

    body = DecisionResponse(
        decision_id=result.entry.decision_id,
        provenance_id=result.entry.provenance_id,
        trace_id=trace_id_of(request),
        created_at=result.entry.created_at,
        idempotent_replay=not result.created,
        chain_head=result.entry.hash,
    )
    return JSONResponse(
        status_code=201 if result.created else 200,
        content=body.model_dump(mode="json", exclude_none=True),
    )


@router.get("/v1/provenance/{decision_id}", response_model=None)
async def get_provenance(decision_id: str, request: Request) -> JSONResponse:
    """The Decision and its provenance, scoped to the caller's tenant."""
    store = audit_store(request)
    tenant_id = identity_of(request).context.tenant_id
    entry = store.decision(decision_id, tenant_id=tenant_id)
    if entry is None:
        raise FdeError(
            "not_found",
            f"no Decision {decision_id!r} is recorded for this tenant",
            details={"reason": "decision_not_found"},
        )

    verification = store.verification()
    body = ProvenanceResponse(
        decision_id=entry.decision_id,
        provenance_id=entry.provenance_id,
        trace_id=trace_id_of(request),
        decision=entry.decision,
        prov_o=prov_o(entry.decision),
        lineage=lineage(entry.decision),
        verification=ProvenanceResponseVerification(
            status=verification.status,
            checked_at=verification.checked_at,
            chain_head=verification.chain_head,
        ),
    )
    return JSONResponse(content=body.model_dump(mode="json", exclude_none=True))
