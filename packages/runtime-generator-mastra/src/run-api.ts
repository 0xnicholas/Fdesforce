/**
 * The Run API contract, as data the generator emits from.
 *
 * `contracts/` is the wire source of truth (`README.md`), but the generated app is
 * a standalone bundle: it cannot import `@fde/contracts-client`, a private
 * workspace package. So the app's copy of the Run API lives here — one catalogue
 * that feeds the generated wire module, the contract-test parity fixture and the
 * generator's own tests. `test/contract-drift.test.ts` compares every entry with
 * `contracts/runtime-api-v1.openapi.yaml` and the JSON Schemas, so a contract
 * change cannot leave this table behind.
 */

/** One Run API operation, with the responses the contract declares for it. */
export interface ContractOperation {
  operationId: string;
  method: 'get' | 'post';
  path: string;
  success: ReadonlyArray<number>;
  errors: ReadonlyArray<number>;
  idempotencyKey: boolean;
}

/**
 * Every route this slice serves: the four Run operations plus the three `ops`
 * routes the handshake added (#30). `/readyz` and `/v1/runtime-info` declare a 503
 * because the startup handshake can fail closed (§9.3); `/healthz` never does.
 * `POST /v1/approvals…` is the context-service proxy (#29, Slice 2 HITL), not a Run
 * API route the app owns: context-service serves the approval resource (#40), but a
 * workflow that suspends on `approval.required` is not generated in this slice.
 */
export const RUN_API_OPERATIONS: ReadonlyArray<ContractOperation> = [
  {
    operationId: 'createRun',
    method: 'post',
    path: '/v1/runs',
    success: [201],
    errors: [400, 401, 403, 409, 422, 429, 500, 503, 504],
    idempotencyKey: true,
  },
  {
    operationId: 'getRun',
    method: 'get',
    path: '/v1/runs/{run_id}',
    success: [200],
    errors: [401, 403, 404, 429, 500, 503],
    idempotencyKey: false,
  },
  {
    operationId: 'streamRun',
    method: 'get',
    path: '/v1/runs/{run_id}/stream',
    success: [200],
    errors: [401, 403, 404, 409, 429, 500, 503],
    idempotencyKey: false,
  },
  {
    operationId: 'cancelRun',
    method: 'post',
    path: '/v1/runs/{run_id}/cancel',
    success: [202],
    errors: [401, 403, 404, 409, 500, 503],
    idempotencyKey: false,
  },
  {
    operationId: 'getRuntimeInfo',
    method: 'get',
    path: '/v1/runtime-info',
    success: [200],
    errors: [503],
    idempotencyKey: false,
  },
  {
    operationId: 'healthz',
    method: 'get',
    path: '/healthz',
    success: [200],
    errors: [],
    idempotencyKey: false,
  },
  {
    operationId: 'readyz',
    method: 'get',
    path: '/readyz',
    success: [200],
    errors: [503],
    idempotencyKey: false,
  },
];

/**
 * Every event type the contract defines. `approval.*` is defined but is not
 * produced by this slice (HITL is C16–C25); the generated app must never emit an
 * event outside `SLICE_EVENT_TYPES`.
 */
export const RUN_EVENT_TYPES = [
  'run.started',
  'text.delta',
  'text.done',
  'tool.call',
  'tool.result',
  'approval.required',
  'approval.decided',
  'run.finished',
  'run.failed',
  'run.cancelled',
  'heartbeat',
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/** The event types this build produces (`#28`). */
export const SLICE_EVENT_TYPES: ReadonlyArray<RunEventType> = [
  'run.started',
  'text.delta',
  'text.done',
  'tool.call',
  'tool.result',
  'run.finished',
  'run.failed',
  'run.cancelled',
  'heartbeat',
];

export const RUN_STATUSES = ['queued', 'running', 'waiting_for_human', 'succeeded', 'failed', 'cancelled'] as const;

/**
 * The unified error envelope (`docs/runtime-contract.md` §3.4): every non-2xx
 * response carries one of these codes, its HTTP status and whether a client may
 * retry it. The generated router never invents a status; it looks it up.
 */
export const ERROR_CODES: Readonly<Record<string, { status: number; retryable: boolean }>> = {
  invalid_request: { status: 400, retryable: false },
  unauthenticated: { status: 401, retryable: false },
  forbidden: { status: 403, retryable: false },
  not_found: { status: 404, retryable: false },
  thread_not_found: { status: 404, retryable: false },
  conflict: { status: 409, retryable: false },
  idempotency_conflict: { status: 409, retryable: false },
  approval_already_decided: { status: 409, retryable: false },
  run_not_suspended: { status: 409, retryable: false },
  stream_not_resumable: { status: 409, retryable: false },
  validation_failed: { status: 422, retryable: false },
  rate_limited: { status: 429, retryable: true },
  bad_gateway: { status: 502, retryable: true },
  unavailable: { status: 503, retryable: true },
  timeout: { status: 504, retryable: true },
  internal: { status: 500, retryable: false },
  contract_mismatch: { status: 503, retryable: false },
  runtime_capability_mismatch: { status: 503, retryable: false },
  graph_schema_mismatch: { status: 503, retryable: false },
  audit_schema_mismatch: { status: 503, retryable: false },
};

export type ErrorCode = keyof typeof ERROR_CODES;

/** `CapabilityId` from `common.schema.json`, used to validate a `RunCreateRequest`. */
export const CAPABILITY_ID_PATTERN = '^[a-z0-9][a-z0-9-]{1,62}$';

/** The fields `RunCreateRequest` declares; the schema closes the object. */
export const RUN_CREATE_FIELDS = ['capability_id', 'input', 'thread_id', 'metadata'] as const;

/** `thread_id` bounds from `run.schema.json`. */
export const THREAD_ID_BOUNDS = { minLength: 1, maxLength: 200 } as const;

/** Stable identifier shapes (`contracts/schemas/common.schema.json`). */
export const ID_PATTERNS = {
  run_id: '^run_[0-9A-HJKMNP-TV-Z]{26}$',
  trace_id: '^[0-9a-f]{32}$',
} as const;

/** The contract's `Idempotency-Key` bounds. */
export const IDEMPOTENCY_KEY = { minLength: 16, maxLength: 128 } as const;
