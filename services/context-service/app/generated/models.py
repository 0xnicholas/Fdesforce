# GENERATED from contracts/ (the context-service OpenAPI schema closure) — do not edit.
# Regenerate with `python scripts/generate.py`; CI runs `python scripts/generate.py --check`.

from __future__ import annotations

from functools import partial
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field, model_validator
from app.wire import Rfc3339, WireModel, check_key_pattern


class ProposedAction(WireModel):
    tool: str = Field(min_length=1, max_length=200)
    operation: str | None = Field(default=None, max_length=200)
    input_digest: Digest
    summary: str | None = Field(default=None, max_length=4000)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('operation', 'summary'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class ApprovalCreateRequest(WireModel):
    run_id: RunId
    capability_id: CapabilityId
    proposed_action: ProposedAction
    requested_by: Actor
    approver_roles: list[str] = Field(min_length=1, max_length=32)
    expires_at: Timestamp
    evidence: list[Evidence] | None = Field(default=None, max_length=200)
    policy_refs: list[str] | None = Field(default=None, max_length=100)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('evidence', 'policy_refs'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class Approval(WireModel):
    approval_id: ApprovalId
    run_id: RunId
    tenant_id: TenantId
    capability_id: CapabilityId
    status: Literal['pending', 'approved', 'rejected', 'expired', 'consumed']
    proposed_action: ProposedAction
    requested_by: Actor
    approver_roles: list[str] = Field(max_length=32)
    created_at: Timestamp
    expires_at: Timestamp
    decided_at: Timestamp | None = Field(default=None)
    decision_id: DecisionId | None = Field(default=None)
    provenance_id: ProvenanceId | None = Field(default=None)
    evidence: list[Evidence] | None = Field(default=None, max_length=200)
    policy_refs: list[str] | None = Field(default=None, max_length=100)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('decided_at', 'decision_id', 'provenance_id', 'evidence', 'policy_refs'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class ApprovalDecisionRequest(WireModel):
    approved: bool
    rationale: str = Field(min_length=1, max_length=8000)
    actor: Actor
    trace_id: TraceId | None = Field(default=None)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('trace_id'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class ApprovalDecisionResponse(WireModel):
    approval_id: ApprovalId
    status: Literal['approved', 'rejected']
    decision_id: DecisionId
    provenance_id: ProvenanceId
    decided_at: Timestamp


class ApprovalList(WireModel):
    items: list[Approval] = Field(max_length=200)
    next_cursor: str | None = Field(default=None, max_length=500)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('next_cursor'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


Ulid = Annotated[str, Field(pattern='^[0-9A-HJKMNP-TV-Z]{26}$')]


RunId = Annotated[str, Field(pattern='^run_[0-9A-HJKMNP-TV-Z]{26}$')]


RetrievalId = Annotated[str, Field(pattern='^ret_[0-9A-HJKMNP-TV-Z]{26}$')]


DecisionId = Annotated[str, Field(pattern='^dec_[0-9A-HJKMNP-TV-Z]{26}$')]


InvocationId = Annotated[str, Field(pattern='^inv_[0-9A-HJKMNP-TV-Z]{26}$')]


ProvenanceId = Annotated[str, Field(pattern='^prov_[0-9A-HJKMNP-TV-Z]{26}$')]


ApprovalId = Annotated[str, Field(pattern='^appr_[0-9A-HJKMNP-TV-Z]{26}$')]


DeploymentId = Annotated[str, Field(pattern='^dep_[0-9A-HJKMNP-TV-Z]{26}$')]


TenantId = Annotated[str, Field(pattern='^[a-z0-9][a-z0-9-]{1,62}$')]


SolutionId = Annotated[str, Field(pattern='^[a-z0-9][a-z0-9-]{1,62}$')]


CapabilityId = Annotated[str, Field(pattern='^[a-z0-9][a-z0-9-]{1,62}$')]


EntityId = Annotated[str, Field(pattern='^fde:[A-Za-z0-9._~:-]{1,200}$')]


TraceId = Annotated[str, Field(pattern='^[0-9a-f]{32}$')]


Digest = Annotated[str, Field(pattern='^sha256:[a-f0-9]{64}$')]


Timestamp = Rfc3339


Semver = Annotated[str, Field(pattern='^[0-9]+\\.[0-9]+\\.[0-9]+([-+][A-Za-z0-9.-]+)?$')]


SchemaVersion = Annotated[str, Field(pattern='^[0-9]+(\\.[0-9]+)*$')]


class Actor(WireModel):
    type: Literal['user', 'service', 'system']
    id: str = Field(min_length=1, max_length=200)
    display: str | None = Field(default=None, max_length=200)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('display'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


Classification = Literal['public', 'internal', 'confidential', 'restricted']


RetentionClass = Literal['ephemeral', 'standard', 'extended', 'legal_hold']


class PolicyEvaluation(WireModel):
    policy_id: str = Field(min_length=1, max_length=200)
    version: str = Field(min_length=1, max_length=100)
    outcome: Literal['allow', 'deny', 'waived']
    reason: str | None = Field(default=None, max_length=2000)
    enforcement_point: Literal['context.retrieve', 'tool.pre_invoke', 'agent.pre_invoke', 'approval.request', 'run.post', 'output.emit'] | None = Field(default=None)
    evaluated_by: Literal['mastra-app', 'context-service'] | None = Field(default=None)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('reason', 'enforcement_point', 'evaluated_by'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


ErrorCode = Literal['invalid_request', 'unauthenticated', 'forbidden', 'not_found', 'thread_not_found', 'conflict', 'idempotency_conflict', 'approval_already_decided', 'run_not_suspended', 'stream_not_resumable', 'validation_failed', 'rate_limited', 'bad_gateway', 'unavailable', 'timeout', 'internal', 'contract_mismatch', 'runtime_capability_mismatch', 'graph_schema_mismatch', 'audit_schema_mismatch']


class ErrorDetail(WireModel):
    code: ErrorCode
    message: str
    retryable: bool
    details: dict[str, Any] | None = Field(default=None)
    trace_id: TraceId

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('details'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class Error(WireModel):
    error: ErrorDetail


class ConnectorOperationRequest(WireModel):
    connector_id: str = Field(pattern='^[a-z0-9][a-z0-9-]{1,62}$')
    operation: str = Field(pattern='^[a-z][A-Za-z0-9]{1,62}$')
    input: dict[str, Any]


class ConnectorOperationResponse(WireModel):
    connector_id: str = Field(pattern='^[a-z0-9][a-z0-9-]{1,62}$')
    operation: str = Field(pattern='^[a-z][A-Za-z0-9]{1,62}$')
    result: dict[str, Any]
    output_digest: Digest
    classification: Classification | None = Field(default=None)
    trace_id: TraceId

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('classification'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class GraphEntityEvidence(WireModel):
    type: Literal['graph_entity'] | None = Field(default=None)
    entity_id: EntityId
    version: str | None = Field(default=None, max_length=100)
    retrieval_id: RetrievalId | None = Field(default=None)
    source_ref: str | None = Field(default=None, max_length=500)
    relationship: str | None = Field(default=None, max_length=100)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('type', 'version', 'retrieval_id', 'source_ref', 'relationship'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class RetrievalEvidence(WireModel):
    type: Literal['retrieval']
    retrieval_id: RetrievalId
    snapshot_digest: Digest


class RunArtifactEvidence(WireModel):
    type: Literal['run_artifact']
    run_id: RunId | None = Field(default=None)
    step_id: str | None = Field(default=None, min_length=1, max_length=200)
    path: str | None = Field(default=None, min_length=1, max_length=500)
    digest: Digest

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('run_id', 'step_id', 'path'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class ApprovalEvidence(WireModel):
    type: Literal['approval']
    approval_id: ApprovalId
    decision_id: DecisionId


Evidence = GraphEntityEvidence | RetrievalEvidence | RunArtifactEvidence | ApprovalEvidence


class Action(WireModel):
    tool_id: str = Field(min_length=1, max_length=200)
    connector_id: str | None = Field(default=None, min_length=1, max_length=200)
    operation: str | None = Field(default=None, min_length=1, max_length=200)
    side_effects: Literal['read', 'write', 'external']

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('connector_id', 'operation'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class ModelRef(WireModel):
    provider: str = Field(min_length=1, max_length=100)
    model: str = Field(min_length=1, max_length=200)
    version: str | None = Field(default=None, max_length=100)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('version'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class DecisionRequest(WireModel):
    decision_id: DecisionId
    parent_decision_id: DecisionId | None = Field(default=None)
    invocation_id: InvocationId | None = Field(default=None)
    run_id: RunId
    tenant_id: TenantId
    capability_id: CapabilityId
    decision_type: Literal['runtime', 'governance', 'configuration', 'approval']
    phase: Literal['intent', 'outcome', 'retrieval', 'approval', 'run']
    action: Action | None = Field(default=None)
    status: Literal['proposed', 'succeeded', 'failed', 'denied', 'unknown', 'cancelled'] | None = Field(default=None)
    actor: Actor
    rationale: str = Field(min_length=1, max_length=8000)
    evidence: list[Evidence] | None = Field(default=None, max_length=200)
    policy_evaluations: list[PolicyEvaluation] | None = Field(default=None, max_length=100)
    model: ModelRef | None = Field(default=None)
    prompt_version: str | None = Field(default=None, max_length=200)
    input_digest: Digest | None = Field(default=None)
    output_digest: Digest | None = Field(default=None)
    classification: Classification | None = Field(default=None)
    redaction_applied: bool | None = Field(default=None)
    retention_class: RetentionClass | None = Field(default=None)
    bundle_digest: Digest | None = Field(default=None)
    release_version: Semver | None = Field(default=None)
    fallback_used: bool | None = Field(default=None)
    trace_id: TraceId
    timestamp: Timestamp

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('parent_decision_id', 'invocation_id', 'action', 'status', 'evidence', 'policy_evaluations', 'model', 'prompt_version', 'input_digest', 'output_digest', 'classification', 'redaction_applied', 'retention_class', 'bundle_digest', 'release_version', 'fallback_used'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class DecisionResponse(WireModel):
    decision_id: DecisionId
    provenance_id: ProvenanceId
    trace_id: TraceId
    created_at: Timestamp
    idempotent_replay: bool
    chain_head: Digest | None = Field(default=None)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('chain_head'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class ProvenanceResponse(WireModel):
    decision_id: DecisionId
    provenance_id: ProvenanceId
    trace_id: TraceId
    decision: DecisionRequest
    prov_o: dict[str, Any]
    lineage: list[ProvenanceResponseLineageItem] = Field(max_length=1000)
    verification: ProvenanceResponseVerification


class ProvenanceResponseLineageItem(WireModel):
    type: str = Field(max_length=100)
    id: str = Field(max_length=500)
    relationship: str | None = Field(default=None, max_length=100)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('relationship'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class ProvenanceResponseVerification(WireModel):
    status: Literal['valid', 'pending', 'stale', 'invalid']
    checked_at: Timestamp | None = Field(default=None)
    chain_head: Digest | None = Field(default=None)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('checked_at', 'chain_head'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


JobId = Annotated[str, Field(pattern='^job_[0-9A-HJKMNP-TV-Z]{26}$')]


IngestMode = Literal['incremental', 'backfill', 'rebuild']


class IngestPackageRef(WireModel):
    """The frozen Context Package revision the job compiles. The digest is the one the revision recorded and `solution.lock` pinned, so a job can only ever materialize semantics that were frozen."""
    name: str = Field(pattern='^[a-z0-9][a-z0-9.-]{1,62}$')
    version: Semver
    digest: Digest


class IngestJobRequest(WireModel):
    package: IngestPackageRef
    mode: IngestMode
    sources: list[str] | None = Field(default=None)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('sources'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class IngestSourceResult(WireModel):
    source: str = Field(min_length=1, max_length=63)
    status: Literal['ok', 'degraded', 'failed']
    entities: int | None = Field(default=None, ge=0)
    edges: int | None = Field(default=None, ge=0)
    watermark: str | None = Field(default=None)
    reason: str | None = Field(default=None)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('entities', 'edges', 'watermark', 'reason'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class IngestJobResult(WireModel):
    """The finished job. Synchronous in this slice: the response is the outcome, not a handle to poll."""
    job_id: JobId
    status: Literal['succeeded', 'degraded', 'failed']
    package: IngestPackageRef
    mode: IngestMode
    started_at: Timestamp
    finished_at: Timestamp
    sources: list[IngestSourceResult]
    message: str | None = Field(default=None)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('message'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class Subject(WireModel):
    type: Literal['user', 'service']
    id: str = Field(min_length=1, max_length=200)
    roles: list[str] | None = Field(default=None, max_length=64)
    scopes: list[str] | None = Field(default=None, max_length=64)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('roles', 'scopes'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class Budget(WireModel):
    max_nodes: int | None = Field(default=None, ge=1, le=1000)
    max_tokens: int | None = Field(default=None, ge=1, le=100000)
    max_hops: int | None = Field(default=None, ge=1, le=4)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('max_nodes', 'max_tokens', 'max_hops'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class BudgetUsed(WireModel):
    nodes: int | None = Field(default=None, ge=0)
    tokens: int | None = Field(default=None, ge=0)
    hops: int | None = Field(default=None, ge=0)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('nodes', 'tokens', 'hops'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class RetrieveRequest(WireModel):
    recipe_id: str = Field(pattern='^[a-z0-9][a-z0-9-]{1,62}$')
    query: str = Field(min_length=1, max_length=8000)
    subject: Subject | None = Field(default=None)
    filters: dict[str, Any] | None = Field(default=None)
    budget: Budget | None = Field(default=None)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('subject', 'filters', 'budget'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class RetrievalItem(WireModel):
    entity_id: EntityId
    type: str = Field(min_length=1, max_length=100)
    content: str = Field(max_length=20000)
    score: float = Field(ge=0, le=1)
    source_ref: str = Field(min_length=1, max_length=500)
    version: str = Field(min_length=1, max_length=100)
    classification: Classification | None = Field(default=None)
    trust: Literal['untrusted'] | None = Field(default=None)
    source_kind: Literal['structured', 'document', 'web', 'derived', 'other'] | None = Field(default=None)
    provenance_id: ProvenanceId | None = Field(default=None)
    metadata: dict[str, Any] | None = Field(default=None)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('classification', 'trust', 'source_kind', 'provenance_id', 'metadata'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class RetrieveResponse(WireModel):
    retrieval_id: RetrievalId
    items: list[RetrievalItem] = Field(max_length=1000)
    degraded: bool
    reason: Literal['scale_limit', 'index_unavailable', 'timeout', 'partial', 'empty'] | None = Field(default=None)
    trace_id: TraceId
    snapshot_digest: Digest
    policy_evaluations: list[PolicyEvaluation] | None = Field(default=None, max_length=100)
    budget_used: BudgetUsed | None = Field(default=None)
    index: Literal['lexical', 'graph', 'fulltext', 'vector', 'hybrid'] | None = Field(default=None)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('reason', 'policy_evaluations', 'budget_used', 'index'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


Support = Literal['native', 'adapter', 'degraded', 'none']


EvalHooks = Literal['native', 'external', 'none']


StateStoreKind = Literal['sqlite', 'libsql', 'postgres']


DurabilityMode = Literal['sync', 'async', 'exit']


ExtensionArtifactKind = Literal['ts-package', 'python-wheel', 'http']


TopologyMode = Literal['split', 'merged-container', 'agent-server']


Limitations = Annotated[list[str], Field(max_length=10)]


class DegradedRequiresLimitations(WireModel):
    pass


class CapabilityNode(DegradedRequiresLimitations):
    support: Support
    limitations: Limitations | None = Field(default=None)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('limitations'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class DurableWorkflow(DegradedRequiresLimitations):
    support: Support
    limitations: Limitations | None = Field(default=None)
    durabilityModes: list[DurabilityMode] = Field(min_length=1)
    autoResume: Support

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('limitations'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class Hitl(DegradedRequiresLimitations):
    support: Support
    limitations: Limitations | None = Field(default=None)
    interrupt: Support
    resume: Support
    approvalResource: Support
    expiry: Support
    multipleInterrupts: Support
    consume: Support

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('limitations'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class Streaming(DegradedRequiresLimitations):
    support: Support
    limitations: Limitations | None = Field(default=None)
    tokenStream: Support
    toolEvents: Support
    interruptEvents: Support
    transport: Support

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('limitations'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class Observability(DegradedRequiresLimitations):
    support: Support
    limitations: Limitations | None = Field(default=None)
    otel: Support
    evalHooks: EvalHooks

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('limitations'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class Memory(DegradedRequiresLimitations):
    support: Support
    limitations: Limitations | None = Field(default=None)
    thread: Support
    longTerm: Support
    ttl: Support

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('limitations'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class Tools(DegradedRequiresLimitations):
    support: Support
    limitations: Limitations | None = Field(default=None)
    native: Support
    mcp: Support
    connectorOperations: Support

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('limitations'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class Extensions(DegradedRequiresLimitations):
    support: Support
    limitations: Limitations | None = Field(default=None)
    artifactKinds: list[ExtensionArtifactKind] = Field(min_length=1)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('limitations'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class StateStore(DegradedRequiresLimitations):
    support: Support
    limitations: Limitations | None = Field(default=None)
    kinds: list[StateStoreKind] = Field(min_length=1)
    schemaVersion: SchemaVersion
    encryption: Support
    retention: Support

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('limitations'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class Topology(DegradedRequiresLimitations):
    support: Support
    limitations: Limitations | None = Field(default=None)
    modes: list[TopologyMode] = Field(min_length=1)
    singleWriter: bool

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('limitations'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class Offline(DegradedRequiresLimitations):
    support: Support
    limitations: Limitations | None = Field(default=None)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('limitations'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class RuntimeCapabilities(WireModel):
    durableWorkflow: DurableWorkflow
    hitl: Hitl
    streaming: Streaming
    observability: Observability
    memory: Memory
    tools: Tools
    extensions: Extensions
    stateStore: StateStore
    topology: Topology
    offline: Offline


CapabilityDetails = Annotated[dict[str, CapabilityNode], Field(min_length=1), AfterValidator(partial(check_key_pattern, pattern='^(durableWorkflow|hitl|streaming|observability|memory|tools|extensions|stateStore|topology|offline)(\\.[a-zA-Z][a-zA-Z0-9]*)?$'))]


class ComponentInfo(WireModel):
    name: Literal['runtime-app', 'runtime-state', 'mastra-app', 'mastra-state', 'context-service', 'graph-store', 'audit-store']
    version: str = Field(min_length=1, max_length=100)
    contract_version: Semver
    status: Literal['ready', 'degraded', 'starting', 'failed']
    schema_version: SchemaVersion | None = Field(default=None)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('schema_version'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class RuntimeDescriptor(WireModel):
    family: str = Field(min_length=1, max_length=100)
    language: Literal['typescript', 'python']
    version: Semver
    profile_digest: Digest
    generator_version: Semver
    state_store: StateStoreKind
    topology: TopologyMode
    licensing: Licensing


class Limits(WireModel):
    max_nodes: int = Field(ge=1)
    max_edges: int = Field(ge=1)
    max_request_timeout_ms: int = Field(ge=1)
    max_run_deadline_ms: int = Field(ge=1)


class RuntimeInfo(WireModel):
    contract_version: Semver
    service: Literal['runtime-app', 'mastra-app', 'context-service']
    service_version: str = Field(min_length=1, max_length=100)
    runtime: RuntimeDescriptor | None = Field(default=None)
    capability_details: CapabilityDetails | None = Field(default=None)
    graph_schema_version: SchemaVersion
    audit_schema_version: SchemaVersion
    backend: RuntimeInfoBackend
    capabilities: list[str] = Field(min_length=1)
    limits: Limits
    components: list[ComponentInfo] | None = Field(default=None, max_length=10)
    started_at: Timestamp

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('runtime', 'capability_details', 'components'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class RuntimeInfoBackend(WireModel):
    graph: Literal['embedded', 'neo4j', 'postgres']
    audit: Literal['sqlite', 'postgres']


Name = Annotated[str, Field(pattern='^[a-z0-9][a-z0-9-]{1,62}$')]


ProfileName = Annotated[str, Field(pattern='^[a-z0-9][a-z0-9.-]{1,62}$')]


RuntimeFamily = Annotated[str, Field(pattern='^[a-z][a-z0-9-]{1,62}$')]


RuntimeLanguage = Literal['typescript', 'python']


class Metadata(WireModel):
    name: ProfileName
    version: Semver
    description: str | None = Field(default=None, max_length=500)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('description'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


class Generator(WireModel):
    name: Name
    version: Semver


PackagePins = Annotated[dict[str, Semver], Field(min_length=1), AfterValidator(partial(check_key_pattern, pattern='^[A-Za-z0-9@/._-]{1,200}$'))]


class Licensing(WireModel):
    runtime: Literal['Apache-2.0', 'MIT', 'Elastic-2.0', 'other']
    requiresLicenseKey: bool
    egress: bool


class ProfileSpec(WireModel):
    generator: Generator
    family: RuntimeFamily
    language: RuntimeLanguage
    runtimeVersion: Semver
    contractVersion: Semver
    packages: PackagePins
    capabilities: RuntimeCapabilities
    licensing: Licensing


class RuntimeProfile(WireModel):
    apiVersion: Literal['fde.dev/v0']
    kind: Literal['RuntimeProfile']
    metadata: Metadata
    spec: ProfileSpec


class ExecutionContext(WireModel):
    """Signed, short-lived assertion propagated from mastra-app to context-service."""
    iss: str = Field(pattern='^fde://')
    aud: Literal['context-service']
    sub: str = Field(min_length=1, max_length=200)
    actor: Actor
    tenant_id: TenantId
    deployment_id: DeploymentId
    solution_id: SolutionId
    run_id: RunId | None = Field(default=None)
    trace_id: TraceId
    roles: list[str] = Field(max_length=64)
    scopes: list[str] = Field(max_length=64)
    iat: int = Field(ge=0)
    exp: int = Field(ge=0)
    jti: str = Field(min_length=16, max_length=128)
    kid: str = Field(min_length=1, max_length=64)
    on_behalf_of: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode='before')
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ('run_id', 'on_behalf_of'):
                if key in data and data[key] is None:
                    raise ValueError(f'{cls.__name__}.{key} must not be null')
        return data


# `from __future__ import annotations` makes every reference a string; resolve
# them once, after the whole closure exists.
for _model in (
    ProposedAction,
    ApprovalCreateRequest,
    Approval,
    ApprovalDecisionRequest,
    ApprovalDecisionResponse,
    ApprovalList,
    Actor,
    PolicyEvaluation,
    ErrorDetail,
    Error,
    ConnectorOperationRequest,
    ConnectorOperationResponse,
    GraphEntityEvidence,
    RetrievalEvidence,
    RunArtifactEvidence,
    ApprovalEvidence,
    Action,
    ModelRef,
    DecisionRequest,
    DecisionResponse,
    ProvenanceResponse,
    ProvenanceResponseLineageItem,
    ProvenanceResponseVerification,
    IngestPackageRef,
    IngestJobRequest,
    IngestSourceResult,
    IngestJobResult,
    Subject,
    Budget,
    BudgetUsed,
    RetrieveRequest,
    RetrievalItem,
    RetrieveResponse,
    DegradedRequiresLimitations,
    CapabilityNode,
    DurableWorkflow,
    Hitl,
    Streaming,
    Observability,
    Memory,
    Tools,
    Extensions,
    StateStore,
    Topology,
    Offline,
    RuntimeCapabilities,
    ComponentInfo,
    RuntimeDescriptor,
    Limits,
    RuntimeInfo,
    RuntimeInfoBackend,
    Metadata,
    Generator,
    Licensing,
    ProfileSpec,
    RuntimeProfile,
    ExecutionContext,
):
    _model.model_rebuild()
