// GENERATED from contracts/context-service-v1.openapi.yaml — do not edit.
// Regenerate with `pnpm generate`; CI runs `pnpm generate:check`.

import type { ApiResult, Transport } from '../transport.js';
import { send } from '../transport.js';
import type { Approval, ApprovalCreateRequest, ApprovalDecisionRequest, ApprovalDecisionResponse, ApprovalId, ApprovalList, CapabilityId, DecisionId, DecisionRequest, DecisionResponse, Error, IngestJobRequest, IngestJobResult, ProvenanceResponse, RetrieveRequest, RetrieveResponse, RunId, RuntimeInfo } from './schemas.js';

export const CONTEXT_SERVICE_OPERATIONS = {
  retrieveContext: { method: 'post', path: '/v1/context/retrieve' },
  recordDecision: { method: 'post', path: '/v1/decisions' },
  getProvenance: { method: 'get', path: '/v1/provenance/{decision_id}' },
  listApprovals: { method: 'get', path: '/v1/approvals' },
  createApproval: { method: 'post', path: '/v1/approvals' },
  decideApproval: { method: 'post', path: '/v1/approvals/{approval_id}/decisions' },
  consumeApproval: { method: 'post', path: '/v1/approvals/{approval_id}/consume' },
  getRuntimeInfo: { method: 'get', path: '/v1/runtime-info' },
  startIngestJob: { method: 'post', path: '/internal/v1/jobs/ingest' },
  healthz: { method: 'get', path: '/healthz' },
  readyz: { method: 'get', path: '/readyz' },
} as const;

export type ContextServiceOperation = keyof typeof CONTEXT_SERVICE_OPERATIONS;

export interface ContextServicePathParams {
  getProvenance: { decision_id: DecisionId };
  decideApproval: { approval_id: ApprovalId };
  consumeApproval: { approval_id: ApprovalId };
}

export interface ContextServiceHeaders {
  retrieveContext: { traceparent: string };
  recordDecision: { traceparent: string; 'Idempotency-Key': string };
  getProvenance: { traceparent: string };
  listApprovals: { traceparent: string };
  createApproval: { traceparent: string; 'Idempotency-Key': string };
  decideApproval: { traceparent: string; 'Idempotency-Key': string };
  consumeApproval: { traceparent: string; 'Idempotency-Key': string };
  startIngestJob: { traceparent: string };
}

export interface ContextServiceQuery {
  listApprovals: { status?: "pending" | "approved" | "rejected" | "expired" | "consumed"; run_id?: RunId; capability_id?: CapabilityId; limit?: number; cursor?: string };
}

export interface ContextServiceBodies {
  retrieveContext: RetrieveRequest;
  recordDecision: DecisionRequest;
  createApproval: ApprovalCreateRequest;
  decideApproval: ApprovalDecisionRequest;
  startIngestJob: IngestJobRequest;
}

export interface ContextServiceResponses {
  retrieveContext: { 200: RetrieveResponse; 400: Error; 401: Error; 403: Error; 404: Error; 422: Error; 429: Error; 500: Error; 503: Error; 504: Error };
  recordDecision: { 200: DecisionResponse; 201: DecisionResponse; 400: Error; 401: Error; 403: Error; 409: Error; 422: Error; 429: Error; 500: Error; 503: Error; 504: Error };
  getProvenance: { 200: ProvenanceResponse; 401: Error; 403: Error; 404: Error; 429: Error; 500: Error; 503: Error; 504: Error };
  listApprovals: { 200: ApprovalList; 401: Error; 403: Error; 422: Error; 429: Error; 500: Error; 503: Error };
  createApproval: { 200: Approval; 201: Approval; 400: Error; 401: Error; 403: Error; 409: Error; 422: Error; 429: Error; 500: Error; 503: Error; 504: Error };
  decideApproval: { 200: ApprovalDecisionResponse; 400: Error; 401: Error; 403: Error; 404: Error; 409: Error; 422: Error; 429: Error; 500: Error; 503: Error; 504: Error };
  consumeApproval: { 200: Approval; 401: Error; 403: Error; 404: Error; 409: Error; 429: Error; 500: Error; 503: Error; 504: Error };
  getRuntimeInfo: { 200: RuntimeInfo };
  startIngestJob: { 200: IngestJobResult; 400: Error; 401: Error; 403: Error; 409: Error; 422: Error; 429: Error; 500: Error; 503: Error; 504: Error };
  healthz: { 200: {
  status: "ok";
} };
  readyz: { 200: {
  status: "ready" | "degraded";
  reasons: Array<string>;
}; 503: {
  status: "not_ready";
  reasons: Array<string>;
} };
}

export class ContextServiceClient {
  constructor(
    private readonly transport: Transport,
    private readonly baseUrl: string,
    private readonly defaultHeaders: Record<string, string> = {},
  ) {}

  private async call<K extends ContextServiceOperation>(
    operation: K,
    input: { pathParams?: Record<string, string>; headers?: Record<string, string | undefined>; query?: Record<string, unknown>; body?: unknown },
  ): Promise<ApiResult<ContextServiceResponses[K]>> {
    const { method, path } = CONTEXT_SERVICE_OPERATIONS[operation];
    return (await send(this.transport, {
      method,
      baseUrl: this.baseUrl,
      path,
      pathParams: input.pathParams as Record<string, string> | undefined,
      query: input.query as Record<string, unknown> | undefined,
      headers: { ...this.defaultHeaders, ...(input.headers as Record<string, string | undefined> | undefined) },
      body: input.body,
    })) as ApiResult<ContextServiceResponses[K]>;
  }

  async retrieveContext(input: { headers: ContextServiceHeaders['retrieveContext']; body: ContextServiceBodies['retrieveContext'] }): Promise<ApiResult<ContextServiceResponses['retrieveContext']>> {
    return this.call('retrieveContext', input);
  }

  async recordDecision(input: { headers: ContextServiceHeaders['recordDecision']; body: ContextServiceBodies['recordDecision'] }): Promise<ApiResult<ContextServiceResponses['recordDecision']>> {
    return this.call('recordDecision', input);
  }

  async getProvenance(input: { pathParams: ContextServicePathParams['getProvenance']; headers: ContextServiceHeaders['getProvenance'] }): Promise<ApiResult<ContextServiceResponses['getProvenance']>> {
    return this.call('getProvenance', input);
  }

  async listApprovals(input: { headers: ContextServiceHeaders['listApprovals']; query?: ContextServiceQuery['listApprovals'] }): Promise<ApiResult<ContextServiceResponses['listApprovals']>> {
    return this.call('listApprovals', input);
  }

  async createApproval(input: { headers: ContextServiceHeaders['createApproval']; body: ContextServiceBodies['createApproval'] }): Promise<ApiResult<ContextServiceResponses['createApproval']>> {
    return this.call('createApproval', input);
  }

  async decideApproval(input: { pathParams: ContextServicePathParams['decideApproval']; headers: ContextServiceHeaders['decideApproval']; body: ContextServiceBodies['decideApproval'] }): Promise<ApiResult<ContextServiceResponses['decideApproval']>> {
    return this.call('decideApproval', input);
  }

  async consumeApproval(input: { pathParams: ContextServicePathParams['consumeApproval']; headers: ContextServiceHeaders['consumeApproval'] }): Promise<ApiResult<ContextServiceResponses['consumeApproval']>> {
    return this.call('consumeApproval', input);
  }

  async getRuntimeInfo(): Promise<ApiResult<ContextServiceResponses['getRuntimeInfo']>> {
    return this.call('getRuntimeInfo', {});
  }

  async startIngestJob(input: { headers: ContextServiceHeaders['startIngestJob']; body: ContextServiceBodies['startIngestJob'] }): Promise<ApiResult<ContextServiceResponses['startIngestJob']>> {
    return this.call('startIngestJob', input);
  }

  async healthz(): Promise<ApiResult<ContextServiceResponses['healthz']>> {
    return this.call('healthz', {});
  }

  async readyz(): Promise<ApiResult<ContextServiceResponses['readyz']>> {
    return this.call('readyz', {});
  }
}
