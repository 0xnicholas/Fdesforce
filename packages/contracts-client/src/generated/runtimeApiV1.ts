// GENERATED from contracts/runtime-api-v1.openapi.yaml — do not edit.
// Regenerate with `pnpm generate`; CI runs `pnpm generate:check`.

import type { ApiResult, Transport } from '../transport.js';
import { send } from '../transport.js';
import type { ApprovalDecisionRequest, ApprovalDecisionResponse, ApprovalId, ApprovalList, CapabilityId, Error, RunCreateRequest, RunCreateResponse, RunId, RunStatus, RuntimeInfo } from './schemas.js';

export const RUNTIME_API_OPERATIONS = {
  createRun: { method: 'post', path: '/v1/runs' },
  getRun: { method: 'get', path: '/v1/runs/{run_id}' },
  streamRun: { method: 'get', path: '/v1/runs/{run_id}/stream' },
  cancelRun: { method: 'post', path: '/v1/runs/{run_id}/cancel' },
  listApprovals: { method: 'get', path: '/v1/approvals' },
  decideApproval: { method: 'post', path: '/v1/approvals/{approval_id}/decisions' },
  getRuntimeInfo: { method: 'get', path: '/v1/runtime-info' },
  healthz: { method: 'get', path: '/healthz' },
  readyz: { method: 'get', path: '/readyz' },
} as const;

export type RuntimeApiOperation = keyof typeof RUNTIME_API_OPERATIONS;

export interface RuntimeApiPathParams {
  getRun: { run_id: RunId };
  streamRun: { run_id: RunId };
  cancelRun: { run_id: RunId };
  decideApproval: { approval_id: ApprovalId };
}

export interface RuntimeApiHeaders {
  createRun: { traceparent?: string; 'Idempotency-Key': string };
  getRun: { traceparent?: string };
  streamRun: { traceparent?: string; 'Last-Event-ID'?: string };
  cancelRun: { traceparent?: string };
  listApprovals: { traceparent?: string };
  decideApproval: { traceparent?: string; 'Idempotency-Key': string };
}

export interface RuntimeApiQuery {
  listApprovals: { status?: "pending" | "approved" | "rejected" | "expired" | "consumed"; run_id?: RunId; capability_id?: CapabilityId; limit?: number; cursor?: string };
}

export interface RuntimeApiBodies {
  createRun: RunCreateRequest;
  decideApproval: ApprovalDecisionRequest;
}

export interface RuntimeApiResponses {
  createRun: { 201: RunCreateResponse; 400: Error; 401: Error; 403: Error; 409: Error; 422: Error; 429: Error; 500: Error; 503: Error; 504: Error };
  getRun: { 200: RunStatus; 401: Error; 403: Error; 404: Error; 429: Error; 500: Error; 503: Error };
  streamRun: { 200: string; 401: Error; 403: Error; 404: Error; 409: Error; 429: Error; 500: Error; 503: Error };
  cancelRun: { 202: RunStatus; 401: Error; 403: Error; 404: Error; 409: Error; 500: Error; 503: Error };
  listApprovals: { 200: ApprovalList; 401: Error; 403: Error; 422: Error; 429: Error; 500: Error; 503: Error };
  decideApproval: { 200: ApprovalDecisionResponse; 400: Error; 401: Error; 403: Error; 404: Error; 409: Error; 422: Error; 429: Error; 500: Error; 503: Error; 504: Error };
  getRuntimeInfo: { 200: RuntimeInfo };
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

export class RuntimeApiClient {
  constructor(
    private readonly transport: Transport,
    private readonly baseUrl: string,
    private readonly defaultHeaders: Record<string, string> = {},
  ) {}

  private async call<K extends RuntimeApiOperation>(
    operation: K,
    input: { pathParams?: Record<string, string>; headers?: Record<string, string | undefined>; query?: Record<string, unknown>; body?: unknown },
  ): Promise<ApiResult<RuntimeApiResponses[K]>> {
    const { method, path } = RUNTIME_API_OPERATIONS[operation];
    return (await send(this.transport, {
      method,
      baseUrl: this.baseUrl,
      path,
      pathParams: input.pathParams as Record<string, string> | undefined,
      query: input.query as Record<string, unknown> | undefined,
      headers: { ...this.defaultHeaders, ...(input.headers as Record<string, string | undefined> | undefined) },
      body: input.body,
    })) as ApiResult<RuntimeApiResponses[K]>;
  }

  async createRun(input: { headers: RuntimeApiHeaders['createRun']; body: RuntimeApiBodies['createRun'] }): Promise<ApiResult<RuntimeApiResponses['createRun']>> {
    return this.call('createRun', input);
  }

  async getRun(input: { pathParams: RuntimeApiPathParams['getRun']; headers: RuntimeApiHeaders['getRun'] }): Promise<ApiResult<RuntimeApiResponses['getRun']>> {
    return this.call('getRun', input);
  }

  async streamRun(input: { pathParams: RuntimeApiPathParams['streamRun']; headers: RuntimeApiHeaders['streamRun'] }): Promise<ApiResult<RuntimeApiResponses['streamRun']>> {
    return this.call('streamRun', input);
  }

  async cancelRun(input: { pathParams: RuntimeApiPathParams['cancelRun']; headers: RuntimeApiHeaders['cancelRun'] }): Promise<ApiResult<RuntimeApiResponses['cancelRun']>> {
    return this.call('cancelRun', input);
  }

  async listApprovals(input: { headers: RuntimeApiHeaders['listApprovals']; query?: RuntimeApiQuery['listApprovals'] }): Promise<ApiResult<RuntimeApiResponses['listApprovals']>> {
    return this.call('listApprovals', input);
  }

  async decideApproval(input: { pathParams: RuntimeApiPathParams['decideApproval']; headers: RuntimeApiHeaders['decideApproval']; body: RuntimeApiBodies['decideApproval'] }): Promise<ApiResult<RuntimeApiResponses['decideApproval']>> {
    return this.call('decideApproval', input);
  }

  async getRuntimeInfo(): Promise<ApiResult<RuntimeApiResponses['getRuntimeInfo']>> {
    return this.call('getRuntimeInfo', {});
  }

  async healthz(): Promise<ApiResult<RuntimeApiResponses['healthz']>> {
    return this.call('healthz', {});
  }

  async readyz(): Promise<ApiResult<RuntimeApiResponses['readyz']>> {
    return this.call('readyz', {});
  }
}
