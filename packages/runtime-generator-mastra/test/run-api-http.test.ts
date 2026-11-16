// Seam: the generated Run API over real HTTP, with the real state store.
//
// #28's acceptance criteria are protocol behaviour: `POST /v1/runs` under an
// `Idempotency-Key`, `409 idempotency_conflict` on a different payload, a `202`
// cancel that aborts the run's signal, and an SSE stream whose `seq` starts at 1,
// carries `run_id`/`trace_id` and heartbeats inside 15s. The test starts the
// emitted router on a loopback port, drives it with `fetch`, and substitutes only
// the workflow executor — the workflow itself is #42's end-to-end test.
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MaterializedTree } from './support/generated-app.js';
import { materialize, statePath } from './support/generated-app.js';

interface RunRecord {
  run_id: string;
  trace_id: string;
  capability_id: string;
  status: string;
  started_at: string;
  finished_at?: string;
  output?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean; trace_id: string };
}

interface StateStore {
  migrate(now?: string): string[];
  getRun(runId: string): RunRecord | undefined;
  close(): void;
}

interface Registry {
  get(runId: string): RunRecord | undefined;
  emit(runId: string, type: string, payload: Record<string, unknown>): void;
  markRunning(runId: string): void;
  finish(runId: string, status: string, patch?: Record<string, unknown>): void;
  fail(runId: string, error: RunRecord['error']): void;
  close(): void;
}

interface ExecuteInput {
  run: RunRecord;
  request: { capability_id: string; input: Record<string, unknown> };
  signal: AbortSignal;
}

type Execute = (input: ExecuteInput, registry: Registry) => Promise<void>;

interface ServerModule {
  PROBE_PATH: string;
  createRuntimeServer(options: {
    registry: Registry;
    tenantId: string;
    capabilities: string[];
    execute: Execute;
    maxBodyBytes?: number;
  }): Server;
}

interface RegistryModule {
  RunRegistry: new (options: {
    store: StateStore;
    tenantId: string;
    runDeadlineMs?: number;
    heartbeatIntervalMs?: number;
  }) => Registry;
}

interface SseEvent {
  id: string;
  type: string;
  data: {
    run_id: string;
    trace_id: string;
    seq: number;
    type: string;
    timestamp: string;
    payload: Record<string, unknown>;
  };
}

interface Runtime {
  tree: MaterializedTree;
  server: Server;
  baseUrl: string;
  registry: Registry;
  requests: ExecuteInput[];
  close(): Promise<void>;
}

let runtime: Runtime | undefined;

/**
 * Async on purpose: the server under test runs in this process, so a synchronous
 * spawn would block the event loop that has to answer the smoke script's requests.
 */
const run = promisify(execFile);

const start = async (execute: Execute, options: { heartbeatIntervalMs?: number; runDeadlineMs?: number } = {}): Promise<Runtime> => {
  const tree = materialize();
  const serverModule = await tree.load<ServerModule>('runtime/router.ts');
  const registryModule = await tree.load<RegistryModule>('runtime/run-registry.ts');
  const storeModule = await tree.load<{ StateStore: new (path: string) => StateStore }>('runtime/state-store.ts');

  const store = new storeModule.StateStore(statePath(tree));
  store.migrate('2026-01-01T00:00:00.000Z');
  const registry = new registryModule.RunRegistry({
    store,
    tenantId: 'acme',
    runDeadlineMs: options.runDeadlineMs ?? 300_000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
  });

  const requests: ExecuteInput[] = [];
  const server = serverModule.createRuntimeServer({
    registry,
    tenantId: 'acme',
    capabilities: ['document-triage'],
    execute: async (input) => {
      requests.push(input);
      await execute(input, registry);
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    tree,
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    registry,
    requests,
    close: async () => {
      registry.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      tree.cleanup();
    },
  };
};

const body = { capability_id: 'document-triage', input: { query: 'triage claim 1001' } };
const key = (suffix = 'a'): string => `smoke-${suffix}-0123456789abcdef`;

interface Call {
  status: number;
  headers: Headers;
  json: Record<string, any>;
}

const call = async (target: Runtime, path: string, init: RequestInit = {}): Promise<Call> => {
  const response = await fetch(`${target.baseUrl}${path}`, init);
  const text = await response.text();
  return { status: response.status, headers: response.headers, json: text === '' ? {} : (JSON.parse(text) as Record<string, any>) };
};

const create = (target: Runtime, overrides: { key?: string | null; body?: unknown } = {}): Promise<Call> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const idempotency = overrides.key === undefined ? key() : overrides.key;
  if (idempotency !== null) headers['Idempotency-Key'] = idempotency;
  return call(target, '/v1/runs', {
    method: 'POST',
    headers,
    body: JSON.stringify(overrides.body ?? body),
  });
};

/** Read SSE frames until `until` returns true or the stream ends. */
async function stream(
  target: Runtime,
  runId: string,
  options: { lastEventId?: string; until?: (event: SseEvent) => boolean; timeoutMs?: number } = {},
): Promise<SseEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (options.lastEventId !== undefined) headers['Last-Event-ID'] = options.lastEventId;

  const response = await fetch(`${target.baseUrl}/v1/runs/${runId}/stream`, { headers, signal: controller.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');

  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('the stream has no body');
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
        if (frame.trim() === '') continue;

        const fields = new Map<string, string>();
        for (const line of frame.split('\n')) {
          const separator = line.indexOf(': ');
          if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 2));
        }
        events.push({
          id: fields.get('id') ?? '',
          type: fields.get('event') ?? '',
          data: JSON.parse(fields.get('data') ?? '{}') as SseEvent['data'],
        });
        if (options.until?.(events[events.length - 1] as SseEvent) === true) return events;
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
}

const terminal = (event: SseEvent): boolean =>
  ['run.finished', 'run.failed', 'run.cancelled'].includes(event.data.type);

beforeEach(() => {
  runtime = undefined;
});
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe('POST /v1/runs', () => {
  it('accepts a Run and returns the contract response', async () => {
      runtime = await start(async ({ run }, registry) => {
      registry.finish(run.run_id, 'succeeded', { output: { recommendation: 'approve' } });
    });

    const created = await create(runtime);

    expect(created.status).toBe(201);
    expect(created.json).toEqual({
      run_id: expect.stringMatching(/^run_[0-9A-HJKMNP-TV-Z]{26}$/),
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      status: 'queued',
      stream_url: `/v1/runs/${created.json['run_id']}/stream`,
    });
  });

  it('replays the original result for the same key and payload', async () => {
    runtime = await start(async () => {});
    const idempotency = key('replay');

    const first = await create(runtime, { key: idempotency });
    const second = await create(runtime, { key: idempotency });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.json).toEqual(first.json);
  });

  it('refuses the same key with a different payload', async () => {
    runtime = await start(async () => {});
    const idempotency = key('conflict');

    await create(runtime, { key: idempotency });
    const conflict = await create(runtime, {
      key: idempotency,
      body: { capability_id: 'document-triage', input: { query: 'a different claim' } },
    });

    expect(conflict.status).toBe(409);
    expect(conflict.json['error']).toMatchObject({ code: 'idempotency_conflict', retryable: false });
    expect(conflict.json['error']?.['trace_id']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('requires an Idempotency-Key', async () => {
    runtime = await start(async () => {});

    const missing = await create(runtime, { key: null });

    expect(missing.status).toBe(400);
    expect(missing.json['error']).toMatchObject({ code: 'invalid_request', retryable: false });
  });

  it('rejects a short Idempotency-Key', async () => {
    runtime = await start(async () => {});

    const short = await create(runtime, { key: 'too-short' });

    expect(short.status).toBe(400);
    expect(short.json['error']?.['code']).toBe('invalid_request');
  });

  it('normalises a bad body into a 422 envelope with field issues', async () => {
    runtime = await start(async () => {});

    const invalid = await create(runtime, { body: { capability_id: '' } });

    expect(invalid.status).toBe(422);
    expect(invalid.json['error']?.['code']).toBe('validation_failed');
    expect(invalid.json['error']?.['details']?.['issues']).toContainEqual({
      path: 'capability_id',
      message: expect.any(String),
    });
  });

  it('rejects a capability this build does not generate', async () => {
    runtime = await start(async () => {});

    const unknown = await create(runtime, { body: { capability_id: 'refund-approval', input: {} } });

    expect(unknown.status).toBe(422);
    expect(unknown.json['error']?.['code']).toBe('validation_failed');
  });
});

describe('GET /v1/runs/{run_id}', () => {
  it('reports a Run that is executing as running, not queued', async () => {
    runtime = await start(async ({ run }, registry) => {
      registry.markRunning(run.run_id);
      await new Promise<void>(() => {});
    });
    const created = await create(runtime);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const status = await call(runtime, `/v1/runs/${created.json['run_id']}`);

    expect(status.json['status']).toBe('running');
  });

  it('returns the contract RunStatus and 404s an unknown Run', async () => {
    runtime = await start(async () => {});
    const created = await create(runtime);

    const status = await call(runtime, `/v1/runs/${created.json['run_id']}`);
    expect(status.status).toBe(200);
    expect(status.json).toEqual({
      run_id: created.json['run_id'],
      trace_id: created.json['trace_id'],
      capability_id: 'document-triage',
      status: 'queued',
      started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });

    const unknown = await call(runtime, '/v1/runs/run_00000000000000000000000000');
    expect(unknown.status).toBe(404);
    expect(unknown.json['error']).toMatchObject({ code: 'not_found', retryable: false });
  });
});

describe('POST /v1/runs/{run_id}/cancel', () => {
  it('returns 202, aborts the run signal and streams run.cancelled', async () => {
    let aborted: Promise<void> = Promise.resolve();
    runtime = await start(async ({ signal }) => {
      aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      await aborted;
    });
    const created = await create(runtime);
    const runId = created.json['run_id'] as string;

    const cancelled = await call(runtime, `/v1/runs/${runId}/cancel`, { method: 'POST' });

    expect(cancelled.status).toBe(202);
    expect(cancelled.json).toMatchObject({ run_id: runId, status: 'cancelled' });
    await aborted;
    expect(runtime.requests[0]?.signal.aborted).toBe(true);

    const events = await stream(runtime, runId, { until: terminal });
    expect(events.map((event) => event.data.type)).toContain('run.cancelled');
  });

  it('409s a Run that already finished and 404s an unknown Run', async () => {
    runtime = await start(async ({ run }, registry) => {
      registry.finish(run.run_id, 'succeeded', { output: {} });
    });
    const created = await create(runtime);
    const runId = created.json['run_id'] as string;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const late = await call(runtime, `/v1/runs/${runId}/cancel`, { method: 'POST' });
    expect(late.status).toBe(409);
    expect(late.json['error']?.['code']).toBe('conflict');

    const unknown = await call(runtime, '/v1/runs/run_00000000000000000000000000/cancel', { method: 'POST' });
    expect(unknown.status).toBe(404);
  });
});

describe('GET /v1/runs/{run_id}/stream', () => {
  it('frames the contract envelope: seq from 1, run_id and trace_id on every event', async () => {
    runtime = await start(async ({ run }, registry) => {
      registry.emit(run.run_id, 'tool.call', { tool: 'retrieve-context' });
      registry.emit(run.run_id, 'tool.result', { tool: 'retrieve-context' });
      registry.finish(run.run_id, 'succeeded', { output: { recommendation: 'approve' } });
    });
    const created = await create(runtime);
    const runId = created.json['run_id'] as string;

    const events = await stream(runtime, runId, { until: terminal });

    expect(events.map((event) => event.data.type)).toEqual([
      'run.started',
      'tool.call',
      'tool.result',
      'run.finished',
    ]);
    expect(events.map((event) => event.data.seq)).toEqual([1, 2, 3, 4]);
    for (const event of events) {
      expect(event.id).toBe(String(event.data.seq));
      expect(event.data.run_id).toBe(runId);
      expect(event.data.trace_id).toBe(created.json['trace_id']);
      expect(event.data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    }
    expect(events.at(-1)?.data.payload).toMatchObject({ output: { recommendation: 'approve' } });
  });

  it('replays from Last-Event-ID', async () => {
    runtime = await start(async ({ run }, registry) => {
      registry.finish(run.run_id, 'succeeded', { output: {} });
    });
    const created = await create(runtime);
    const runId = created.json['run_id'] as string;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const events = await stream(runtime, runId, { lastEventId: '1', until: terminal });

    expect(events[0]?.data.seq).toBe(2);
    expect(events.at(-1)?.data.type).toBe('run.finished');
  });

  it('heartbeats while a Run is still going', async () => {
    let release: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime = await start(async () => {
      await finished;
    }, { heartbeatIntervalMs: 20 });
    const created = await create(runtime);
    const runId = created.json['run_id'] as string;

    const events = await stream(runtime, runId, {
      timeoutMs: 2_000,
      until: (event) => event.data.type === 'heartbeat',
    });
    release();

    expect(events.filter((event) => event.data.type === 'heartbeat').length).toBeGreaterThanOrEqual(1);
    expect(events.map((event) => event.data.seq)).toEqual([...events.map((event) => event.data.seq)].sort((a, b) => a - b));
  });

  it('ends immediately when a finished Run is resumed past its last event', async () => {
    runtime = await start(async ({ run }, registry) => {
      registry.finish(run.run_id, 'succeeded', { output: {} });
    });
    const created = await create(runtime);
    const runId = created.json['run_id'] as string;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const events = await stream(runtime, runId, { lastEventId: '2', timeoutMs: 2_000 });

    expect(events).toEqual([]);
  });

  it('404s an unknown Run instead of opening a stream', async () => {
    runtime = await start(async () => {});

    const unknown = await call(runtime, '/v1/runs/run_00000000000000000000000000/stream');

    expect(unknown.status).toBe(404);
    expect(unknown.json['error']?.['code']).toBe('not_found');
  });
});

describe('the Run lifecycle', () => {
  it('reports a failed Run with the contract error detail', async () => {
    runtime = await start(async ({ run }, registry) => {
      registry.fail(run.run_id, {
        code: 'unavailable',
        message: 'context-service unreachable',
        retryable: true,
        trace_id: run.trace_id,
      });
    });
    const created = await create(runtime);
    const runId = created.json['run_id'] as string;

    const events = await stream(runtime, runId, { until: terminal });
    expect(events.at(-1)?.data.type).toBe('run.failed');
    expect(events.at(-1)?.data.payload).toMatchObject({ error: { code: 'unavailable', retryable: true } });

    const status = await call(runtime, `/v1/runs/${runId}`);
    expect(status.json['status']).toBe('failed');
    expect(status.json['error']).toMatchObject({ code: 'unavailable', retryable: true, trace_id: created.json['trace_id'] });
  });

  it('fails a Run whose executor throws, instead of leaving it running forever', async () => {
    runtime = await start(async () => {
      throw new Error('identity is not generated yet');
    });
    const created = await create(runtime);
    const runId = created.json['run_id'] as string;

    const events = await stream(runtime, runId, { until: terminal, timeoutMs: 3_000 });

    expect(events.at(-1)?.data.type).toBe('run.failed');
    expect(events.at(-1)?.data.payload).toMatchObject({ error: { code: 'internal' } });
  });

  it('fails a Run that outlives its deadline', async () => {
    runtime = await start(async () => new Promise<void>(() => {}), { runDeadlineMs: 30 });
    const created = await create(runtime);
    const runId = created.json['run_id'] as string;

    const events = await stream(runtime, runId, { until: terminal, timeoutMs: 3_000 });

    expect(events.at(-1)?.data.type).toBe('run.failed');
    expect(events.at(-1)?.data.payload).toMatchObject({ error: { code: 'timeout' } });
  });
});

describe('the surface itself', () => {
  it('serves liveness at the probe path the topology declares', async () => {
    runtime = await start(async () => {});
    const serverModule = await runtime.tree.load<ServerModule>('runtime/router.ts');

    const health = await call(runtime, serverModule.PROBE_PATH);

    expect(serverModule.PROBE_PATH).toBe('/healthz');
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ status: 'ok' });
  });

  it('answers every unknown route with the error envelope', async () => {
    runtime = await start(async () => {});

    for (const path of ['/v1/workflows', '/v2/runs', '/v1/runs/not-a-run']) {
      const response = await call(runtime, path);
      expect(response.status).toBe(404);
      expect(response.json['error']).toMatchObject({ code: 'not_found', retryable: false });
      expect(response.json['error']?.['trace_id']).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe('the A2/A5 contract-test mapping', () => {
  it('runs the emitted smoke against this surface and passes', async () => {
    // A2 cancels a Run, so the executor stays pending; a Run that finished on its
    // own would make cancel a 409 and the case would not exercise the 202 path.
    runtime = await start(async () => new Promise<void>(() => {}));
    const script = join(runtime.tree.bundle, 'contract-tests/run-api-smoke.mjs');

    const { stdout } = await run(process.execPath, [script, '--case', 'A2', '--base-url', runtime.baseUrl]);

    expect(stdout).toContain('A2: ok');
    expect(stdout).not.toContain('FAIL');
  });

  it('validates the SSE envelope the app actually emits', async () => {
    runtime = await start(async ({ run }, registry) => {
      registry.emit(run.run_id, 'tool.call', { tool: 'retrieve-context' });
      registry.emit(run.run_id, 'tool.result', { tool: 'retrieve-context' });
      registry.finish(run.run_id, 'succeeded', { output: { recommendation: 'approve' } });
    });
    const script = join(runtime.tree.bundle, 'contract-tests/run-api-smoke.mjs');

    const { stdout } = await run(process.execPath, [script, '--case', 'A5', '--base-url', runtime.baseUrl]);

    expect(stdout).toContain('A5: ok');
  });

  it('fails the smoke when the surface stops matching the contract', async () => {
    // Without this, a smoke script that asserts nothing would also pass.
    runtime = await start(async () => new Promise<void>(() => {}));
    const script = join(runtime.tree.bundle, 'contract-tests/run-api-smoke.mjs');

    await expect(
      run(process.execPath, [script, '--case', 'A2', '--base-url', `${runtime?.baseUrl}/nope`]),
    ).rejects.toMatchObject({ code: 1 });
  });
});
