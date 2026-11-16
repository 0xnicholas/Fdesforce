// Seam: the generated app's dependency-free runtime modules, executed.
//
// The Run API's guarantees start below HTTP: stable Run ids and trace ids, a
// canonical digest for idempotency, one error envelope for every non-2xx
// response, and the SSE envelope's `seq`/`run_id`/`trace_id`/event-type rules.
// These modules are emitted into the customer bundle, so the tests load the
// emitted tree and exercise it rather than reading the generator's source.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MaterializedTree } from './support/generated-app.js';
import { materialize } from './support/generated-app.js';

interface Ids {
  ulid(now?: number): string;
  runId(): string;
  traceId(): string;
  spanId(): string;
  traceparent(trace: string, span?: string): string;
  nowIso(): string;
}

interface Canonical {
  canonicalJson(value: unknown): string;
  sha256Digest(value: unknown): string;
}

interface Wire {
  ERROR_CODES: Record<string, { status: number; retryable: boolean }>;
  RUN_EVENT_TYPES: string[];
  SLICE_EVENT_TYPES: string[];
  RUN_STATUSES: string[];
  ID_PATTERNS: Record<string, string>;
  IDEMPOTENCY_KEY: { minLength: number; maxLength: number };
  RUN_API_OPERATIONS: Array<{ operationId: string; method: string; path: string; success: number[] }>;
  streamUrl(runId: string): string;
  validateRunCreate(body: unknown): { ok: true; value: Record<string, any> } | { ok: false; issues: Array<{ path: string; message: string }> };
}

interface Errors {
  ApiError: new (code: string, message: string, options?: { retryable?: boolean; details?: Record<string, unknown> }) => Error & {
    code: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  statusOf(error: { code: string }): number;
  toEnvelope(error: unknown, traceId: string): { error: { code: string; message: string; retryable: boolean; details?: unknown; trace_id: string } };
  normalizeError(error: unknown, traceId: string): { status: number; envelope: { error: { code: string; trace_id: string } } };
  isRetryableStatus(status: number): boolean;
}

interface Sse {
  HEARTBEAT_INTERVAL_MS: number;
  isTerminalEvent(type: string): boolean;
  encodeEvent(event: Record<string, unknown>): string;
  RunEventStream: new () => {
    publish(event: Record<string, unknown>): void;
    subscribe(listener: (event: Record<string, unknown>) => void): () => void;
    close(): void;
    size: number;
  };
}

let tree: MaterializedTree;
beforeEach(() => {
  tree = materialize();
});
afterEach(() => {
  tree.cleanup();
});

describe('identity helpers', () => {
  it('mint contract-shaped Run and trace ids', async () => {
    const ids = await tree.load<Ids>('runtime/ids.ts');

    expect(ids.runId()).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ids.traceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(ids.spanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(ids.traceparent('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7')).toBe(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );
    expect(ids.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('mints unique ids that sort by time', async () => {
    const ids = await tree.load<Ids>('runtime/ids.ts');

    expect(new Set(Array.from({ length: 50 }, () => ids.runId())).size).toBe(50);
    expect(ids.ulid(1_700_000_000_000) < ids.ulid(1_700_000_001_000)).toBe(true);
  });
});

describe('canonical digests', () => {
  it('orders keys so the same payload digests the same regardless of key order', async () => {
    const { canonicalJson, sha256Digest } = await tree.load<Canonical>('runtime/canonical.ts');

    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalJson({ list: [{ y: 2, x: 1 }] })).toBe('{"list":[{"x":1,"y":2}]}');
    expect(sha256Digest({ b: 2, a: 1 })).toBe('sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
    expect(sha256Digest({ a: 1, b: 2 })).toBe(sha256Digest({ b: 2, a: 1 }));
  });
});

describe('the Run API contract copy', () => {
  it('carries the four operations, the slice event subset and the error table', async () => {
    const wire = await tree.load<Wire>('runtime/wire.ts');

    expect(wire.RUN_API_OPERATIONS.map((operation) => operation.operationId)).toEqual([
      'createRun',
      'getRun',
      'streamRun',
      'cancelRun',
    ]);
    expect(wire.SLICE_EVENT_TYPES).toEqual([
      'run.started',
      'text.delta',
      'text.done',
      'tool.call',
      'tool.result',
      'run.finished',
      'run.failed',
      'run.cancelled',
      'heartbeat',
    ]);
    // `approval.*` is defined by the contract but is not produced by this slice.
    expect(wire.RUN_EVENT_TYPES).toContain('approval.required');
    expect(wire.SLICE_EVENT_TYPES).not.toContain('approval.required');
    expect(wire.ERROR_CODES['idempotency_conflict']).toEqual({ status: 409, retryable: false });
    expect(wire.ERROR_CODES['unavailable']).toEqual({ status: 503, retryable: true });
    expect(wire.RUN_STATUSES).toEqual(['queued', 'running', 'waiting_for_human', 'succeeded', 'failed', 'cancelled']);
    expect(wire.streamUrl('run_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('/v1/runs/run_01ARZ3NDEKTSV4RRFFQ69G5FAV/stream');
  });

  it('accepts a valid RunCreateRequest and narrows it', async () => {
    const wire = await tree.load<Wire>('runtime/wire.ts');

    const parsed = wire.validateRunCreate({
      capability_id: 'document-triage',
      input: { query: 'triage claim 1001' },
      metadata: { channel: 'web' },
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value['capability_id']).toBe('document-triage');
  });

  it('normalises request-body problems into field-level issues, never a thrown schema error', async () => {
    const wire = await tree.load<Wire>('runtime/wire.ts');

    const notObject = wire.validateRunCreate('nope');
    expect(notObject.ok).toBe(false);
    if (!notObject.ok) expect(notObject.issues[0]?.path).toBe('');

    const missing = wire.validateRunCreate({ input: {} });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues.map((issue) => issue.path)).toContain('capability_id');

    const badCapability = wire.validateRunCreate({ capability_id: 'Document Triage!', input: {} });
    expect(badCapability.ok).toBe(false);
    if (!badCapability.ok) expect(badCapability.issues.map((issue) => issue.path)).toContain('capability_id');

    const badInput = wire.validateRunCreate({ capability_id: 'document-triage', input: [] });
    expect(badInput.ok).toBe(false);
    if (!badInput.ok) expect(badInput.issues.map((issue) => issue.path)).toContain('input');

    const extra = wire.validateRunCreate({ capability_id: 'document-triage', input: {}, extra: true });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.issues.map((issue) => issue.path)).toContain('extra');
  });
});

describe('the error envelope', () => {
  it('looks up the contract status and retryability, and carries the trace id', async () => {
    const errors = await tree.load<Errors>('runtime/errors.ts');
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';

    const conflict = new errors.ApiError('idempotency_conflict', 'key reused with a different payload');
    expect(errors.statusOf(conflict)).toBe(409);
    expect(errors.toEnvelope(conflict, traceId)).toEqual({
      error: {
        code: 'idempotency_conflict',
        message: 'key reused with a different payload',
        retryable: false,
        trace_id: traceId,
      },
    });
  });

  it('never leaks an unknown failure as anything but a 500 internal envelope', async () => {
    const errors = await tree.load<Errors>('runtime/errors.ts');
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';

    const normalized = errors.normalizeError(new Error('pg: connection string leaked'), traceId);
    expect(normalized.status).toBe(500);
    expect(normalized.envelope.error.code).toBe('internal');
    expect(normalized.envelope.error.trace_id).toBe(traceId);
    expect(JSON.stringify(normalized)).not.toContain('connection string');
  });

  it('knows which statuses a client may retry', async () => {
    const errors = await tree.load<Errors>('runtime/errors.ts');

    expect([429, 502, 503, 504].every((status) => errors.isRetryableStatus(status))).toBe(true);
    expect([400, 401, 403, 404, 409, 422, 500].some((status) => errors.isRetryableStatus(status))).toBe(false);
  });
});

describe('the SSE envelope', () => {
  it('frames an event with its id, type and JSON data', async () => {
    const sse = await tree.load<Sse>('runtime/sse.ts');
    const event = {
      run_id: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
      seq: 1,
      type: 'run.started',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {},
    };

    expect(sse.encodeEvent(event)).toBe(
      `id: 1\nevent: run.started\ndata: ${JSON.stringify(event)}\n\n`,
    );
  });

  it('keeps a heartbeat inside the contract ceiling', async () => {
    const sse = await tree.load<Sse>('runtime/sse.ts');

    expect(sse.HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
    expect(sse.HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(15_000);
  });

  it('knows which events terminate a Run', async () => {
    const sse = await tree.load<Sse>('runtime/sse.ts');

    expect(['run.finished', 'run.failed', 'run.cancelled'].every((type) => sse.isTerminalEvent(type))).toBe(true);
    expect(['run.started', 'text.delta', 'heartbeat'].some((type) => sse.isTerminalEvent(type))).toBe(false);
  });

  it('publishes to live subscribers and refuses an event type this build does not produce', async () => {
    const sse = await tree.load<Sse>('runtime/sse.ts');
    const stream = new sse.RunEventStream();
    const seen: string[] = [];
    const unsubscribe = stream.subscribe((event) => seen.push(String(event['type'])));

    stream.publish({ seq: 1, type: 'run.started' });
    stream.publish({ seq: 2, type: 'heartbeat' });
    unsubscribe();
    stream.publish({ seq: 3, type: 'text.delta' });

    expect(seen).toEqual(['run.started', 'heartbeat']);
    expect(stream.size).toBe(0);
    expect(() => stream.publish({ seq: 4, type: 'approval.required' })).toThrow(/approval\.required/);
  });
});

interface ExecutionContextConstants {
  EXECUTION_CONTEXT_TOKEN: string;
  TRACEPARENT: string;
  RUN_ID: string;
  TRACE_ID: string;
  RUN_DEADLINE: string;
  RUN_EVENTS: string;
  runContext(
    source: { get(key: string): unknown } | undefined,
    signal?: AbortSignal,
  ): {
    runId: string;
    traceId: string;
    token: string;
    traceparent: string;
    signal?: AbortSignal;
    deadline?: number;
    emit?: (type: 'tool.call' | 'tool.result', payload: Record<string, unknown>) => void;
  };
}

describe('the Run context', () => {
  const source = (values: Record<string, unknown>) => ({ get: (key: string): unknown => values[key] });

  it('reads identity, trace and budget from the request context the Run service filled', async () => {
    const module = await tree.load<ExecutionContextConstants>('runtime/execution-context.ts');
    const emitted: Array<[string, Record<string, unknown>]> = [];
    const run = module.runContext(
      source({
        [module.RUN_ID]: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        [module.TRACE_ID]: '4bf92f3577b34da6a3ce929d0e0e4736',
        [module.EXECUTION_CONTEXT_TOKEN]: 'header.payload.signature',
        [module.TRACEPARENT]: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        [module.RUN_DEADLINE]: 1_700_000_000_000,
        [module.RUN_EVENTS]: (type: string, payload: Record<string, unknown>) => emitted.push([type, payload]),
      }),
    );

    expect(run).toMatchObject({
      runId: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      token: 'header.payload.signature',
      deadline: 1_700_000_000_000,
    });
    run.emit?.('tool.call', { tool: 'retrieve-context' });
    expect(emitted).toEqual([['tool.call', { tool: 'retrieve-context' }]]);
  });

  it('carries the abort signal the cancelled Run aborted', async () => {
    const module = await tree.load<ExecutionContextConstants>('runtime/execution-context.ts');
    const controller = new AbortController();
    const run = module.runContext(
      source({
        [module.RUN_ID]: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        [module.TRACE_ID]: '4bf92f3577b34da6a3ce929d0e0e4736',
        [module.EXECUTION_CONTEXT_TOKEN]: 'token',
        [module.TRACEPARENT]: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      }),
      controller.signal,
    );

    controller.abort();
    expect(run.signal?.aborted).toBe(true);
  });

  it('fails a call that has no token instead of calling context-service untraced or unauthenticated', async () => {
    const module = await tree.load<ExecutionContextConstants>('runtime/execution-context.ts');

    expect(() => module.runContext(undefined)).toThrow(/request context/);
    expect(() =>
      module.runContext(
        source({
          [module.RUN_ID]: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          [module.TRACE_ID]: '4bf92f3577b34da6a3ce929d0e0e4736',
          [module.TRACEPARENT]: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        }),
      ),
    ).toThrow(/executionContextToken/);
    expect(() =>
      module.runContext(
        source({
          [module.RUN_ID]: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          [module.TRACE_ID]: '4bf92f3577b34da6a3ce929d0e0e4736',
          [module.EXECUTION_CONTEXT_TOKEN]: 'token',
          [module.TRACEPARENT]: 'not-a-traceparent',
        }),
      ),
    ).toThrow(/malformed/);
  });
});
