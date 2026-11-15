# PROTOTYPE — generated skeleton.
# Source: contracts/context-service-v1.openapi.yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from . import approvals, decisions, retrieval, runtime_info

app = FastAPI(title="context-service (prototype)", version="0.1.0")


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.get("/readyz")
def readyz() -> dict:
    return {"status": "ready", "reasons": []}


@app.get("/v1/runtime-info")
def get_runtime_info() -> dict:
    return runtime_info.runtime_info()


@app.post("/v1/context/retrieve")
async def retrieve(request: Request) -> dict:
    body = await request.json()
    if not body.get("recipe_id") or not body.get("query"):
        raise HTTPException(
            status_code=422,
            detail={"code": "validation_failed", "message": "recipe_id and query are required"},
        )
    return retrieval.retrieve(body)


@app.post("/v1/decisions")
async def write_decision(request: Request) -> dict:
    body = await request.json()
    return decisions.write(body)


@app.get("/v1/provenance/{decision_id}")
def get_provenance(decision_id: str) -> dict:
    result = decisions.provenance(decision_id)
    if result is None:
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    return result


@app.post("/v1/approvals")
async def create_approval(request: Request) -> dict:
    return approvals.create(await request.json())


@app.get("/v1/approvals")
def list_approvals() -> dict:
    return {"approvals": approvals.list_pending()}


@app.post("/v1/approvals/{approval_id}/decisions")
async def decide_approval(approval_id: str, request: Request) -> dict:
    result = approvals.decide(approval_id, await request.json())
    if result is None:
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    if result.get("error"):
        raise HTTPException(status_code=409, detail={"code": result["error"]})
    return result


@app.post("/v1/approvals/{approval_id}/consume")
def consume_approval(approval_id: str) -> dict:
    result = approvals.consume(approval_id)
    if result is None:
        raise HTTPException(status_code=409, detail={"code": "conflict"})
    return result


@app.post("/v1/connectors/{connector_id}/operations/{operation}")
def invoke_connector(connector_id: str, operation: str) -> JSONResponse:
    # GAP: this endpoint is proposed, not in fde.runtime/v1. It exists here only
    # to show what the generated Mastra Tool would need.
    return JSONResponse(
        status_code=501,
        content={
            "error": {
                "code": "internal",
                "message": f"connector operation {connector_id}/{operation} not implemented",
                "retryable": False,
                "trace_id": "0" * 32,
            }
        },
    )
