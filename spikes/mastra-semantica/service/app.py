"""Minimal context-service over Semantica 0.7.0 for the Mastra integration spike.

Contract exercised by the Mastra agent:
  POST /v1/context/retrieve
  POST /v1/decisions
  GET  /v1/provenance/{entity_id}

Identity propagation: X-Tenant-Id, X-Trace-Id, X-Actor are required on every
/v1 call and are written into both graph decision metadata and PROV-O entries.
"""

from __future__ import annotations

import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field

from semantica.context.context_graph import ContextGraph
from semantica.provenance import ProvenanceManager

DATA_DIR = Path(os.environ.get("SPIKE_DATA_DIR", Path(__file__).parent / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
GRAPH_PATH = DATA_DIR / "graph.json"
PROV_PATH = DATA_DIR / "provenance.db"
STARTED_AT = time.time()
VERIFY_ON_READ = os.environ.get("PROVENANCE_VERIFY_ON_READ", "true").lower() not in ("0", "false", "no")

graph = ContextGraph(advanced_analytics=False)
prov = ProvenanceManager(storage_path=str(PROV_PATH))
save_seconds = 0.0


class Ctx:
    def __init__(self, tenant_id: str, trace_id: str, actor: str):
        self.tenant_id = tenant_id
        self.trace_id = trace_id
        self.actor = actor


def get_ctx(request: Request) -> Ctx:
    tenant = request.headers.get("x-tenant-id", "").strip()
    actor = request.headers.get("x-actor", "").strip()
    trace = request.headers.get("x-trace-id", "").strip() or f"tr-{uuid.uuid4()}"
    if not tenant:
        raise HTTPException(400, detail={"code": "missing_tenant", "message": "X-Tenant-Id is required"})
    if not actor:
        raise HTTPException(400, detail={"code": "missing_actor", "message": "X-Actor is required"})
    return Ctx(tenant, trace, actor)


def node_tenant(node_id: str) -> Optional[str]:
    node = graph.nodes.get(node_id)
    if not node:
        return None
    props = getattr(node, "properties", {}) or {}
    meta = getattr(node, "metadata", {}) or {}
    return props.get("tenant_id") or meta.get("tenant_id")


def node_dict(node_id: str) -> Dict[str, Any]:
    node = graph.nodes[node_id]
    return node.to_dict()


def save_graph() -> float:
    global save_seconds
    started = time.perf_counter()
    graph.save_to_file(GRAPH_PATH)
    save_seconds = time.perf_counter() - started
    return save_seconds


def seed_graph() -> None:
    nodes = [
        ("acme:policy:refund", "Policy", "Acme refund policy: refunds allowed within 30 days of delivery; exceptions require manager approval.", "policy/refund-v3.pdf"),
        ("acme:policy:premium", "Policy", "Acme premium customers get a 45-day refund window under the customer success addendum.", "policy/premium-addendum.pdf"),
        ("acme:order:1001", "Order", "Order 1001 delivered 2026-10-01; customer tier premium; total $420.", "erp/orders/1001"),
        ("acme:customer:42", "Customer", "Customer 42 (Acme Corp), premium tier since 2024, account owner Dana.", "crm/customers/42"),
        ("acme:exception:manual", "Policy", "Manager approval exception is required after the standard refund window.", "policy/exceptions.md"),
        ("globex:policy:refund", "Policy", "Globex refund policy: 14 days, no exceptions.", "globex/policy/refund-v1.pdf"),
        ("globex:order:9001", "Order", "Globex order 9001 delivered 2026-11-01; standard tier.", "globex/erp/orders/9001"),
        ("globex:customer:7", "Customer", "Globex customer 7, standard tier, account owner Alex.", "globex/crm/customers/7"),
    ]
    for node_id, node_type, content, source in nodes:
        tenant = node_id.split(":")[0]
        graph.add_node(node_id, node_type, content=content, tenant_id=tenant, source=source)
        prov.track_entity(
            node_id,
            source=source,
            metadata={"tenant_id": tenant, "trace_id": "seed", "actor": "seed-script"},
            entity_type=node_type,
            agent_id="seed-script",
            activity_id="seed",
            confidence=1.0,
        )
    edges = [
        ("acme:policy:refund", "acme:order:1001", "APPLIES_TO"),
        ("acme:policy:premium", "acme:policy:refund", "AUGMENTS"),
        ("acme:order:1001", "acme:customer:42", "PLACED_BY"),
        ("acme:exception:manual", "acme:policy:refund", "CONSTRAINS"),
        ("globex:policy:refund", "globex:order:9001", "APPLIES_TO"),
        ("globex:order:9001", "globex:customer:7", "PLACED_BY"),
    ]
    for source, target, rel in edges:
        graph.add_edge(source, target, rel)
    save_graph()


@asynccontextmanager
async def lifespan(app: FastAPI):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if GRAPH_PATH.exists():
        graph.load_from_file(GRAPH_PATH)
    else:
        seed_graph()
    yield


app = FastAPI(title="fde-context-service-spike", version="0.1.0", lifespan=lifespan)


@app.exception_handler(HTTPException)
async def http_exc_handler(request: Request, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "http_error", "message": str(exc.detail)}
    detail.setdefault("trace_id", request.headers.get("x-trace-id") or None)
    return JSONResponse(status_code=exc.status_code, content={"error": detail})


class RetrieveBody(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    max_hops: int = Field(default=1, ge=0, le=3)
    top_k: int = Field(default=5, ge=1, le=20)


class DecisionBody(BaseModel):
    category: str
    scenario: str
    reasoning: str
    outcome: str
    confidence: float = Field(ge=0.0, le=1.0)
    entities: List[str] = []
    evidence_ids: List[str] = []
    metadata: Dict[str, Any] = {}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "pid": os.getpid(),
        "uptime_s": round(time.time() - STARTED_AT, 3),
        "graph": graph.get_graph_summary(),
        "save_seconds_last": round(save_seconds, 4),
        "data_dir": str(DATA_DIR),
    }


@app.post("/v1/context/retrieve")
def retrieve(body: RetrieveBody, ctx: Ctx = Depends(get_ctx), response: Response = Response()):
    started = time.perf_counter()
    hits = graph.query(body.query, limit=body.top_k * 3)
    items: List[Dict[str, Any]] = []
    seen = set()
    for hit in hits:
        node = hit["node"]
        if node_tenant(node["id"]) != ctx.tenant_id:
            continue
        if node["id"] not in seen:
            seen.add(node["id"])
            props = node.get("properties") or {}
            items.append({
                "entity_id": node["id"],
                "type": node["type"],
                "content": hit.get("content") or props.get("content", ""),
                "score": round(float(hit["score"]), 4),
                "hop": 0,
                "source": props.get("source"),
            })
        if body.max_hops > 0:
            for neighbor in graph.get_neighbors(node["id"], hops=body.max_hops):
                if node_tenant(neighbor["id"]) != ctx.tenant_id or neighbor["id"] in seen:
                    continue
                seen.add(neighbor["id"])
                items.append({
                    "entity_id": neighbor["id"],
                    "type": neighbor["type"],
                    "content": neighbor["content"],
                    "score": round(float(neighbor.get("weight", 0.0)), 4),
                    "hop": neighbor.get("hop", 1),
                    "source": (neighbor.get("metadata") or {}).get("source"),
                })
    items = items[: body.top_k]

    provenance = []
    for item in items:
        entry = prov.get_provenance(item["entity_id"])
        if entry and (entry.get("metadata") or {}).get("tenant_id") == ctx.tenant_id:
            provenance.append({
                "entity_id": item["entity_id"],
                "source_document": entry.get("source_document"),
                "checksum": entry.get("checksum"),
                "activity_id": entry.get("activity_id"),
                "agent_id": entry.get("agent_id"),
            })

    # One auditable PROV-O row per retrieval, keyed by the propagated trace id.
    retrieval_id = f"retrieval:{ctx.trace_id}"
    prov.track_entity(
        retrieval_id,
        source="context-service:retrieve",
        metadata={
            "tenant_id": ctx.tenant_id,
            "trace_id": ctx.trace_id,
            "actor": ctx.actor,
            "query": body.query,
            "returned": [item["entity_id"] for item in items],
        },
        entity_type="retrieval",
        agent_id=ctx.actor,
        activity_id=ctx.trace_id,
    )
    if response is not None:
        response.headers["X-Trace-Id"] = ctx.trace_id
    return {
        "items": items,
        "provenance": provenance,
        "trace_id": ctx.trace_id,
        "tenant_id": ctx.tenant_id,
        "latency_ms": round((time.perf_counter() - started) * 1000, 2),
    }


@app.post("/v1/decisions")
def record_decision(body: DecisionBody, ctx: Ctx = Depends(get_ctx), response: Response = Response()):
    started = time.perf_counter()
    evidence = list(dict.fromkeys(body.evidence_ids or body.entities))
    for entity_id in evidence:
        tenant = node_tenant(entity_id)
        if tenant is None:
            raise HTTPException(404, detail={"code": "entity_not_found", "entity_id": entity_id})
        if tenant != ctx.tenant_id:
            raise HTTPException(403, detail={"code": "tenant_mismatch", "entity_id": entity_id})
    decision_id = graph.record_decision(
        category=body.category,
        scenario=body.scenario,
        reasoning=body.reasoning,
        outcome=body.outcome,
        confidence=body.confidence,
        entities=evidence,
        decision_maker=ctx.actor,
        metadata={
            "tenant_id": ctx.tenant_id,
            "trace_id": ctx.trace_id,
            "actor": ctx.actor,
            "evidence_ids": evidence,
            **body.metadata,
        },
    )
    prov.track_entity(
        decision_id,
        source="context-service:decision",
        metadata={
            "tenant_id": ctx.tenant_id,
            "trace_id": ctx.trace_id,
            "actor": ctx.actor,
            "category": body.category,
            "evidence_ids": evidence,
        },
        entity_type="decision",
        agent_id=ctx.actor,
        activity_id=ctx.trace_id,
        used_entities=evidence,
    )
    save_s = save_graph()
    if response is not None:
        response.headers["X-Trace-Id"] = ctx.trace_id
    return {
        "decision_id": decision_id,
        "provenance_id": decision_id,
        "trace_id": ctx.trace_id,
        "tenant_id": ctx.tenant_id,
        "latency_ms": round((time.perf_counter() - started) * 1000, 2),
        "graph_save_ms": round(save_s * 1000, 2),
    }


@app.get("/v1/provenance/{entity_id:path}")
def provenance(entity_id: str, ctx: Ctx = Depends(get_ctx), response: Response = Response()):
    started = time.perf_counter()
    entry = prov.get_provenance(entity_id)
    if not entry:
        raise HTTPException(404, detail={"code": "provenance_not_found", "entity_id": entity_id})
    if (entry.get("metadata") or {}).get("tenant_id") != ctx.tenant_id:
        raise HTTPException(403, detail={"code": "tenant_mismatch", "entity_id": entity_id})
    lineage = prov.get_lineage(entity_id)
    if response is not None:
        response.headers["X-Trace-Id"] = ctx.trace_id
    return {
        "entity_id": entity_id,
        "entry": entry,
        "lineage": lineage,
        "chain": prov.verify_chain() if VERIFY_ON_READ else {"skipped": True},
        "trace_id": ctx.trace_id,
        "latency_ms": round((time.perf_counter() - started) * 1000, 2),
    }


@app.get("/v1/admin/graph-summary")
def graph_summary(ctx: Ctx = Depends(get_ctx)):
    return {
        "tenant_id": ctx.tenant_id,
        "graph": graph.get_graph_summary(),
        "provenance_entries": len(prov.storage.retrieve_all()) if hasattr(prov.storage, "retrieve_all") else None,
    }
