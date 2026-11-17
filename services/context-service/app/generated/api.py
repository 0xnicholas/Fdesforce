# GENERATED from contracts/context-service-v1.openapi.yaml — do not edit.
# Regenerate with `python scripts/generate.py`; CI runs `python scripts/generate.py --check`.

from app.wire import Operation, SchemaRef

#: The version of this API document. It is *not* the `fde.runtime/v1` minor:
#: `versions.RUNTIME_CONTRACT_VERSION` is what `runtime-info.contract_version` reports.
CONTEXT_SERVICE_API_VERSION = '1.1.0'

#: Schema files the operation table refers to.
SCHEMA_FILES = ('approval.schema.json', 'common.schema.json', 'decision.schema.json', 'error.schema.json', 'execution-context.schema.json', 'ingest-job.schema.json', 'retrieval.schema.json', 'runtime-capabilities.schema.json', 'runtime-info.schema.json', 'runtime-profile.schema.json')

OPERATIONS: tuple[Operation, ...] = (
    Operation(
        method='post',
        path='/v1/context/retrieve',
        operation_id='retrieveContext',
        auth=True,
        traceparent=True,
        idempotency_key=False,
        request=SchemaRef('retrieval.schema.json', '/$defs/RetrieveRequest'),
        success_status=200,
        response_ref=SchemaRef('retrieval.schema.json', '/$defs/RetrieveResponse'),
        response_inline=None,
    ),
    Operation(
        method='post',
        path='/v1/decisions',
        operation_id='recordDecision',
        auth=True,
        traceparent=True,
        idempotency_key=True,
        request=SchemaRef('decision.schema.json', '/$defs/DecisionRequest'),
        success_status=201,
        response_ref=SchemaRef('decision.schema.json', '/$defs/DecisionResponse'),
        response_inline=None,
    ),
    Operation(
        method='get',
        path='/v1/provenance/{decision_id}',
        operation_id='getProvenance',
        auth=True,
        traceparent=True,
        idempotency_key=False,
        request=None,
        success_status=200,
        response_ref=SchemaRef('decision.schema.json', '/$defs/ProvenanceResponse'),
        response_inline=None,
    ),
    Operation(
        method='get',
        path='/v1/approvals',
        operation_id='listApprovals',
        auth=True,
        traceparent=True,
        idempotency_key=False,
        request=None,
        success_status=200,
        response_ref=SchemaRef('approval.schema.json', '/$defs/ApprovalList'),
        response_inline=None,
    ),
    Operation(
        method='post',
        path='/v1/approvals',
        operation_id='createApproval',
        auth=True,
        traceparent=True,
        idempotency_key=True,
        request=SchemaRef('approval.schema.json', '/$defs/ApprovalCreateRequest'),
        success_status=201,
        response_ref=SchemaRef('approval.schema.json', '/$defs/Approval'),
        response_inline=None,
    ),
    Operation(
        method='post',
        path='/v1/approvals/{approval_id}/decisions',
        operation_id='decideApproval',
        auth=True,
        traceparent=True,
        idempotency_key=True,
        request=SchemaRef('approval.schema.json', '/$defs/ApprovalDecisionRequest'),
        success_status=200,
        response_ref=SchemaRef('approval.schema.json', '/$defs/ApprovalDecisionResponse'),
        response_inline=None,
    ),
    Operation(
        method='post',
        path='/v1/approvals/{approval_id}/consume',
        operation_id='consumeApproval',
        auth=True,
        traceparent=True,
        idempotency_key=True,
        request=None,
        success_status=200,
        response_ref=SchemaRef('approval.schema.json', '/$defs/Approval'),
        response_inline=None,
    ),
    Operation(
        method='get',
        path='/v1/runtime-info',
        operation_id='getRuntimeInfo',
        auth=False,
        traceparent=False,
        idempotency_key=False,
        request=None,
        success_status=200,
        response_ref=SchemaRef('runtime-info.schema.json', '/$defs/RuntimeInfo'),
        response_inline=None,
    ),
    Operation(
        method='post',
        path='/internal/v1/jobs/ingest',
        operation_id='startIngestJob',
        auth=True,
        traceparent=True,
        idempotency_key=False,
        request=SchemaRef('ingest-job.schema.json', '/$defs/IngestJobRequest'),
        success_status=200,
        response_ref=SchemaRef('ingest-job.schema.json', '/$defs/IngestJobResult'),
        response_inline=None,
    ),
    Operation(
        method='get',
        path='/healthz',
        operation_id='healthz',
        auth=False,
        traceparent=False,
        idempotency_key=False,
        request=None,
        success_status=200,
        response_ref=None,
        response_inline={'type': 'object', 'required': ['status'], 'properties': {'status': {'type': 'string', 'const': 'ok'}}},
    ),
    Operation(
        method='get',
        path='/readyz',
        operation_id='readyz',
        auth=False,
        traceparent=False,
        idempotency_key=False,
        request=None,
        success_status=200,
        response_ref=None,
        response_inline={'type': 'object',
 'required': ['status', 'reasons'],
 'properties': {'status': {'type': 'string', 'enum': ['ready', 'degraded']},
                'reasons': {'type': 'array', 'items': {'type': 'string'}}}},
    ),
)

OPERATIONS_BY_ID: dict[str, Operation] = {operation.operation_id: operation for operation in OPERATIONS}

#: Keyed by the (METHOD, path template) a FastAPI route matches on.
OPERATIONS_BY_ROUTE: dict[tuple[str, str], Operation] = {
    (operation.method.upper(), operation.path): operation for operation in OPERATIONS
}
