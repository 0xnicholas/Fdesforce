// Seam: the generated context client, executed against a fake transport.
//
// `docs/runtime-contract.md` §7.1 is a client policy, and a policy is only worth
// what it does on the wire: retry only `retryable=true`, at most twice, with
// exponential backoff and jitter, inside `Retry-After` and inside the Run
// deadline — and when the call is a write, the retry must carry the same
// `Idempotency-Key` and the same `decision_id` so it cannot create a second audit
// entry. The tests drive the emitted client with a recording transport, so every
// assertion is about requests the client actually made.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MaterializedTree } from './support/generated-app.js';
import { materialize } from './support/generated-app.js';

interface CallOptions {
  idempotencyKey?: string;
  deadline?: number;
  timeoutMs?: number;
}

interface RunContext {
  runId: string;
  traceId: string;
  token: string;
  traceparent: string;
  signal?: AbortSignal;
  deadline?: number;
}

interface ContextClient {
  retrieve(context: RunContext, request: Record<string, unknown>, options?: CallOptions): Promise<unknown>;
  connectorOperation(context: RunContext, request: Record<string, unknown>, options?: CallOptions): Promise<unknown>;
  recordDecision(
    context: RunContext,
    request: { decision_id: string } & Record<string, unknown>,
    options: CallOptions & { idempotencyKey: string },
  ): Promise<unknown>;
}

interface ClientModule {
  CONTEXT_SERVICE_URL: string;
  MAX_RETRIES: number;
  BASE_RETRY_DELAY_MS: number;
  ContextClient: new (options?: {
    baseUrl?: string;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    random?: () => number;
  }) => ContextClient;
}

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal | undefined;
}

let tree: MaterializedTree;
beforeEach(() => {
  tree = materialize();
});
afterEach(() => {
  tree.cleanup();
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const errorBody = (code: string, retryable: boolean, message = 'upstream said no'): unknown => ({
  error: { code, message, retryable, trace_id: '4bf92f3577b34da6a3ce929d0e0e4736' },
});

interface Harness {
  module: ClientModule;
  client: ContextClient;
  calls: Recorded[];
  sleeps: number[];
  now: () => number;
  advance: (ms: number) => void;
}

async function harness(
  responses: Array<Response | Error>,
  options: { now?: number; random?: () => number } = {},
): Promise<Harness> {
  const module = await tree.load<ClientModule>('runtime/context-client.ts');
  const calls: Recorded[] = [];
  const sleeps: number[] = [];
  let clock = options.now ?? 1_000_000;
  let index = 0;

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
      signal: init?.signal ?? undefined,
    });
    const next = responses[index];
    index += 1;
    if (next === undefined) throw new Error(`unexpected request ${index}: ${String(input)}`);
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;

  const client = new module.ContextClient({
    baseUrl: 'http://context-service:8011',
    fetch: fakeFetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: options.random ?? (() => 0),
  });

  return { module, client, calls, sleeps, now: () => clock, advance: (ms) => (clock += ms) };
}

const context = (overrides: Partial<RunContext> = {}): RunContext => ({
  runId: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  token: 'header.payload.signature',
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  ...overrides,
});

const retrieve = { recipe_id: 'claims-context', query: 'claim 1001' };

describe('one seam to context-service', () => {
  it('carries the Run identity on every call', async () => {
    const probe = await harness([json(200, { retrieval_id: 'ret_01ARZ3NDEKTSV4RRFFQ69G5FAV', items: [] })]);

    await probe.client.retrieve(context(), retrieve);

    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.url).toBe('http://context-service:8011/v1/context/retrieve');
    expect(probe.calls[0]?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer header.payload.signature',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    expect(JSON.parse(probe.calls[0]?.body ?? '{}')).toEqual(retrieve);
  });

  it('posts connector operations to the typed-operation endpoint', async () => {
    const probe = await harness([json(200, { claim_id: '1001' })]);

    await probe.client.connectorOperation(context(), {
      connector_id: 'claims-db',
      operation: 'lookupClaim',
      input: { claim_id: '1001' },
    });

    expect(probe.calls[0]?.url).toBe('http://context-service:8011/v1/connectors/claims-db/operations');
  });
});

describe('the retry policy', () => {
  it('retries a retryable failure and succeeds on a later attempt', async () => {
    const probe = await harness([
      json(503, errorBody('unavailable', true)),
      json(503, errorBody('unavailable', true)),
      json(200, { ok: true }),
    ]);

    await expect(probe.client.retrieve(context(), retrieve)).resolves.toEqual({ ok: true });
    expect(probe.calls).toHaveLength(3);
    expect(probe.sleeps).toEqual([200, 400]);
  });

  it('never retries a non-retryable failure', async () => {
    const probe = await harness([json(422, errorBody('validation_failed', false))]);

    await expect(probe.client.retrieve(context(), retrieve)).rejects.toMatchObject({
      code: 'validation_failed',
      retryable: false,
    });
    expect(probe.calls).toHaveLength(1);
    expect(probe.sleeps).toEqual([]);
  });

  it('treats an envelope that says retryable=false as final, whatever the status', async () => {
    const probe = await harness([json(503, errorBody('runtime_capability_mismatch', false))]);

    await expect(probe.client.retrieve(context(), retrieve)).rejects.toMatchObject({ retryable: false });
    expect(probe.calls).toHaveLength(1);
  });

  it('stops after two retries (three attempts in total)', async () => {
    const probe = await harness([
      json(503, errorBody('unavailable', true)),
      json(503, errorBody('unavailable', true)),
      json(503, errorBody('unavailable', true)),
      json(200, { ok: true }),
    ]);

    await expect(probe.client.retrieve(context(), retrieve)).rejects.toMatchObject({ retryable: true });
    expect(probe.module.MAX_RETRIES).toBe(2);
    expect(probe.calls).toHaveLength(3);
  });

  it('adds jitter to the exponential backoff', async () => {
    const probe = await harness(
      [json(503, errorBody('unavailable', true)), json(503, errorBody('unavailable', true)), json(200, { ok: true })],
      { random: () => 0.5 },
    );

    await probe.client.retrieve(context(), retrieve);

    // 200ms and 400ms exponential, each plus up to 50% jitter.
    expect(probe.sleeps).toEqual([250, 500]);
  });

  it('honours Retry-After over the backoff', async () => {
    const probe = await harness([
      json(429, errorBody('rate_limited', true), { 'retry-after': '1' }),
      json(200, { ok: true }),
    ]);

    await probe.client.retrieve(context(), retrieve);

    expect(probe.sleeps).toEqual([1000]);
  });

  it('gives up when the next attempt would pass the Run deadline', async () => {
    const probe = await harness([json(503, errorBody('unavailable', true)), json(200, { ok: true })]);
    const deadline = probe.now() + 100;

    await expect(probe.client.retrieve(context({ deadline }), retrieve)).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });
    expect(probe.calls).toHaveLength(1);
  });

  it('fails immediately when the Run deadline has already passed', async () => {
    const probe = await harness([json(200, { ok: true })]);

    await expect(probe.client.retrieve(context({ deadline: probe.now() - 1 }), retrieve)).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(probe.calls).toEqual([]);
  });

  it('passes an abort signal to fetch, so a cancelled Run stops the call', async () => {
    const probe = await harness([json(200, { ok: true })]);
    const controller = new AbortController();

    await probe.client.retrieve(context({ signal: controller.signal }), retrieve);

    expect(probe.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not retry a fetch that failed because the Run was cancelled', async () => {
    const probe = await harness([new DOMException('This operation was aborted', 'AbortError')]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      probe.client.retrieve(context({ signal: controller.signal }), retrieve),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(probe.calls).toHaveLength(0);
  });

  it('retries a transport failure that was not a cancellation', async () => {
    const probe = await harness([new TypeError('fetch failed'), json(200, { ok: true })]);

    await expect(probe.client.retrieve(context(), retrieve)).resolves.toEqual({ ok: true });
    expect(probe.calls).toHaveLength(2);
  });
});

describe('the write path', () => {
  it('reuses the same Idempotency-Key and decision_id on every retry', async () => {
    const probe = await harness([
      json(503, errorBody('unavailable', true)),
      json(200, { decision_id: 'dec_01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
    ]);
    const decision = {
      decision_id: 'dec_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      run_id: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      phase: 'run',
    };

    await probe.client.recordDecision(context(), decision, { idempotencyKey: 'decision-1-decision-1' });

    expect(probe.calls).toHaveLength(2);
    expect(probe.calls.map((call) => call.headers['Idempotency-Key'])).toEqual([
      'decision-1-decision-1',
      'decision-1-decision-1',
    ]);
    expect(probe.calls.map((call) => JSON.parse(call.body)['decision_id'])).toEqual([
      'dec_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      'dec_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ]);
    expect(probe.calls[0]?.url).toBe('http://context-service:8011/v1/decisions');
  });
});
