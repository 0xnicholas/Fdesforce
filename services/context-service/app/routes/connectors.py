"""The `connectors` tag: `POST /v1/connectors/{connector_id}/operations` (§3.3, D6).

A Connector-backed Tool has exactly one seam, and this is it. The generated Tool calls
here; context-service calls the Connector. The Tool therefore never holds Connector
credentials, never learns the data source's address, and cannot reach a tenant it was
not signed for — the three things that make "the runtime app talks to the customer's
database" an acceptable sentence.

Four refusals, each answering a different question:

| Refusal | Status | Meaning |
| --- | --- | --- |
| `connector_not_found` | 404 | this deployment does not serve that Connector |
| `operation_not_found` | 404 | it serves the Connector, not that operation |
| `record_not_found` | 404 | the operation ran and the row does not exist |
| `missing_data_scope` | 403 | the caller may use the Tool, not see this class of data |

The last one is the permission baseline's, not the platform scope matrix's: the
operation's `x-fde-required-scope` authorizes *context access*, and `permissions.yaml`
authorizes *this data* (the same `scopes` map the retrieval's mask stage applies). One
baseline, two readers — a Tool call and a retrieval cannot disagree about who may see a
claim.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from starlette.requests import Request

from app.canonical import canonical_json, sha256_digest
from app.connectors import ConnectorNotFound
from app.connectors.port import (
    ConnectorUnavailable,
    InvalidArguments,
    OperationNotFound,
    RecordNotFound,
)
from app.contract import read_json_body
from app.errors import FdeError, forbidden
from app.generated.models import ConnectorOperationResponse
from app.identity import identity_of
from app.mask import missing_scopes
from app.routes import connector_registry, frozen_package
from app.tracing import trace_id_of

router = APIRouter(tags=["connectors"])


@router.post("/v1/connectors/{connector_id}/operations", response_model=None)
async def invoke_connector_operation(request: Request) -> JSONResponse:
    """Invoke one typed operation, with the class gate the permission baseline declares."""
    body = await read_json_body(request)
    connector_id = str(request.path_params["connector_id"])
    if body["connector_id"] != connector_id:
        raise FdeError(
            "invalid_request",
            "the body's `connector_id` and the path's disagree; a Tool calls one Connector, named once",
            details={"path": connector_id, "body": body["connector_id"]},
        )

    registry = connector_registry(request)
    try:
        connector = registry.require(connector_id)
    except ConnectorNotFound as error:
        raise FdeError(
            "not_found",
            str(error),
            details={"reason": "connector_not_found", "connector_id": connector_id},
        ) from error

    try:
        outcome = connector.invoke(str(body["operation"]), dict(body["input"]))
    except OperationNotFound as error:
        raise FdeError(
            "not_found",
            str(error),
            details={"reason": "operation_not_found", "operation": body["operation"]},
        ) from error
    except RecordNotFound as error:
        raise FdeError("not_found", str(error), details={"reason": "record_not_found"}) from error
    except InvalidArguments as error:
        raise FdeError(
            "validation_failed",
            str(error),
            details={"reason": "invalid_arguments", "operation": body["operation"]},
        ) from error
    except ConnectorUnavailable as error:
        raise FdeError(
            "unavailable",
            str(error),
            details={"reason": "connector_unavailable", "connector_id": connector_id},
        ) from error

    profile = frozen_package(request).permissions
    missing = missing_scopes(profile, outcome.term, identity_of(request).context.scopes)
    if missing:
        raise forbidden(
            "missing_data_scope",
            f"{outcome.term} requires {', '.join(missing)}; the Tool may run and this class of data is not served",
            **{"class": outcome.term, "required_scopes": list(missing)},
        )

    result = dict(outcome.result)
    classification = profile.classifications.get(outcome.term) or outcome.classification
    response = ConnectorOperationResponse(
        connector_id=connector_id,
        operation=str(body["operation"]),
        result=result,
        # The digest of what the Tool returned, so a Decision's outcome can cite it
        # without the audit store keeping a second copy (§6.5).
        output_digest=sha256_digest(canonical_json(result)),
        trace_id=trace_id_of(request),
        **({"classification": classification} if classification else {}),
    )
    return JSONResponse(content=response.model_dump(mode="json", exclude_none=True))
