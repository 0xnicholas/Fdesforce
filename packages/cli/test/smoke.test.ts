// Seam: `deploy/smoke.mjs` — the post-deploy acceptance script a bundle ships (#34).
//
// The script is a deliverable, so it is executed rather than inspected: a stub
// runtime app and a stub context-service are served over loopback, and the script
// from a real bundle walks the five steps an operator runs after `docker compose
// up` — healthz, readyz, runtime-info, `POST /v1/runs`, provenance. Asserting the
// requests the stub saw is what makes "it covers those five" a fact rather than a
// comment: a script that quietly stopped calling an endpoint would still exit 0.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeSandbox, type Sandbox } from './support/sandbox.js';

const DEPLOYMENT_ID = 'dep_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TOKEN = 'header.payload.signature';

let sandbox: Sandbox;

beforeAll(async () => {
  sandbox = makeSandbox();
  const built = await sandbox.run([
    'build',
    '--spec',
    sandbox.specDir,
    '--out',
    sandbox.path('bundle'),
    '--target',
    'compose',
    '--environment',
    'acme-prod',
    '--deployment',
    DEPLOYMENT_ID,
    '--workspace',
    sandbox.workspace,
  ]);
  if (built.code !== 0) throw new Error(`build failed: ${built.err}`);
}, 120_000);

afterAll(() => sandbox?.cleanup());

const script = (): string => sandbox.path('bundle/deploy/smoke.mjs');

interface Captured {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

interface Stub {
  url: string;
  requests: Captured[];
  close(): Promise<void>;
}

interface RouteReply {
  status: number;
  body: unknown;
}

type Handler = (request: Captured) => RouteReply;

/** A loopback server keyed by `"<METHOD> <path prefix>"`. */
async function startStub(routes: Record<string, Handler>, fallback?: RouteReply): Promise<Stub> {
  const requests: Captured[] = [];
  const server: Server = createServer((request: IncomingMessage, reply: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const captured: Captured = {
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(captured);

      const match = Object.entries(routes).find(([key]) => {
        const [method, prefix] = key.split(' ') as [string, string];
        return method === captured.method && captured.path.startsWith(prefix);
      });
      const answer = match === undefined ? (fallback ?? { status: 404, body: { error: { code: 'not_found' } } }) : match[1](captured);
      reply.writeHead(answer.status, { 'content-type': 'application/json' });
      reply.end(JSON.stringify(answer.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const RUNTIME_INFO = {
  contract_version: '1.4.0',
  service: 'runtime-app',
  service_version: '0.1.0',
  graph_schema_version: '1',
  audit_schema_version: '1',
  backend: { graph: 'embedded', audit: 'sqlite' },
  capabilities: ['shared-graph', 'semantic-ingest'],
  limits: { max_nodes: 10_000, max_edges: 50_000, max_request_timeout_ms: 30_000, max_run_deadline_ms: 1_800_000 },
  runtime: { family: 'mastra', language: 'typescript', profile: 'mastra-1.83-node22@1.0.0' },
  components: [
    { name: 'runtime-app', version: '0.1.0', contract_version: '1.4.0', status: 'ready' },
    { name: 'context-service', version: '0.1.0', contract_version: '1.4.0', status: 'ready' },
  ],
  started_at: '2026-11-15T09:00:00.000Z',
};

const RUN_ID = `run_${'A'.repeat(26)}`;
const TRACE_ID = 'a'.repeat(32);
const DECISION_ID = `dec_${'B'.repeat(26)}`;

const runStatus = (overrides: Record<string, unknown> = {}): RouteReply => ({
  status: 200,
  body: {
    run_id: RUN_ID,
    trace_id: TRACE_ID,
    capability_id: 'document-triage',
    // The contract's terminal-and-successful status (`run.schema.json`); the SSE
    // event is `run.finished`, the status is `succeeded`.
    status: 'succeeded',
    started_at: '2026-11-15T09:00:00.000Z',
    finished_at: '2026-11-15T09:00:04.000Z',
    output: { summary: 'read-only smoke' },
    decisions: [DECISION_ID],
    ...overrides,
  },
});

const provenance = (): RouteReply => ({
  status: 200,
  body: {
    decision_id: DECISION_ID,
    provenance_id: `prov_${'C'.repeat(26)}`,
    trace_id: TRACE_ID,
    created_at: '2026-11-15T09:00:04.000Z',
    decision: { decision_id: DECISION_ID, phase: 'run', status: 'succeeded' },
    prov_o: { '@context': 'https://www.w3.org/ns/prov#' },
    lineage: [],
    verification: { status: 'valid' },
  },
});

/** The deployed bundle, as the smoke sees it. */
function healthyRoutes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /healthz': () => ({ status: 200, body: { status: 'ok' } }),
    'GET /readyz': () => ({ status: 200, body: { status: 'ready', reasons: [] } }),
    'GET /v1/runtime-info': () => ({ status: 200, body: RUNTIME_INFO }),
    'POST /v1/runs': () => ({
      status: 201,
      body: { run_id: RUN_ID, trace_id: TRACE_ID, status: 'queued', stream_url: `/v1/runs/${RUN_ID}/stream` },
    }),
    'GET /v1/runs/': () => runStatus(),
    'GET /v1/provenance/': provenance,
    ...overrides,
  };
}

interface ScriptResult {
  code: number;
  out: string;
  err: string;
}

function runScript(args: string[], env: Record<string, string> = {}): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script(), ...args], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
    });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, out: out.join(''), err: err.join('') }));
  });
}

describe('the bundle smoke script', () => {
  it('ships in the payload, executable, and addressed by the manifest', () => {
    expect(existsSync(script())).toBe(true);
    expect(statSync(script()).mode & 0o777).toBe(0o755);

    const manifest = JSON.parse(sandbox.read('bundle/bundle.json')) as {
      artifacts: string[];
      files: Record<string, string>;
    };
    expect(manifest.artifacts).toContain('deploy/smoke.mjs');
    expect(manifest.files['deploy/smoke.mjs']).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('takes its endpoints and its credential from flags and the environment, not from the artifact', () => {
    const text = sandbox.read('bundle/deploy/smoke.mjs');

    // Nothing a deployment would have to be rebuilt to change: no address, no token
    // and no key is baked into the script (#34 acceptance criterion 4).
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain('BEGIN PRIVATE KEY');
    expect(text).not.toContain('fde/execution-context');
    expect(text).toContain('FDE_SMOKE_BASE_URL');
    expect(text).toContain('FDE_SMOKE_CONTEXT_SERVICE_URL');
    expect(text).toContain('FDE_SMOKE_TOKEN');
  });

  it('walks healthz, readyz, runtime-info, POST runs and provenance against a deployed bundle', async () => {
    const runtime = await startStub(healthyRoutes());
    const contextService = await startStub(healthyRoutes());
    try {
      const result = await runScript([
        '--base-url',
        runtime.url,
        '--context-service-url',
        contextService.url,
        '--token',
        TOKEN,
        '--json',
      ]);

      expect(result.code, result.err).toBe(0);
      const summary = JSON.parse(result.out) as {
        ok: boolean;
        steps: Array<{ step: string; status: string }>;
        errors: unknown[];
      };
      expect(summary.ok).toBe(true);
      expect(summary.steps.map((step) => step.step)).toEqual([
        'healthz',
        'readyz',
        'runtime-info',
        'run',
        'provenance',
      ]);
      expect(summary.steps.every((step) => step.status === 'passed')).toBe(true);

      // The Run was started for this Spec's capability, under an idempotency key, and
      // replayed with the same key and payload: a network retry must return the first
      // Run rather than start a second one.
      const creates = runtime.requests.filter((request) => request.method === 'POST' && request.path === '/v1/runs');
      expect(creates).toHaveLength(2);
      expect(creates.map((request) => request.headers['idempotency-key'])).toEqual([
        creates[0]?.headers['idempotency-key'],
        creates[0]?.headers['idempotency-key'],
      ]);
      expect(creates[0]?.headers['idempotency-key']).toBeTruthy();
      expect(JSON.parse(creates[0]?.body ?? '{}')).toMatchObject({ capability_id: 'document-triage' });

      // The Run API is authenticated: every Run call carries the caller's credential.
      for (const request of runtime.requests.filter((entry) => entry.path.startsWith('/v1/runs'))) {
        expect(request.headers['authorization'], `${request.method} ${request.path}`).toBe(`Bearer ${TOKEN}`);
      }

      // The provenance read went to context-service, addressed to this deployment's
      // tenant, carrying the audit credential and a traceparent.
      const read = contextService.requests.find((request) => request.path === `/v1/provenance/${DECISION_ID}`);
      expect(read?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      expect(read?.headers['traceparent']).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    } finally {
      await runtime.close();
      await contextService.close();
    }
  });

  it('reports a degraded readiness as a warning rather than a failure', async () => {
    const runtime = await startStub(
      healthyRoutes({
        'GET /readyz': () => ({ status: 200, body: { status: 'degraded', reasons: ['ingest_partial'] } }),
      }),
    );
    const contextService = await startStub(healthyRoutes());
    try {
      const result = await runScript([
        '--base-url',
        runtime.url,
        '--context-service-url',
        contextService.url,
        '--token',
        TOKEN,
        '--json',
      ]);

      expect(result.code, result.err).toBe(0);
      const summary = JSON.parse(result.out) as { ok: boolean; warnings: Array<{ step: string; message: string }> };
      expect(summary.warnings.map((warning) => warning.step)).toContain('readyz');
      expect(summary.warnings.map((warning) => warning.message).join(' ')).toContain('ingest_partial');
    } finally {
      await runtime.close();
      await contextService.close();
    }
  });

  it('fails with the reason when readiness is 503', async () => {
    const runtime = await startStub(
      healthyRoutes({
        'GET /readyz': () => ({ status: 503, body: { status: 'not_ready', reasons: ['handshake_failed'] } }),
      }),
    );
    const contextService = await startStub(healthyRoutes());
    try {
      const result = await runScript([
        '--base-url',
        runtime.url,
        '--context-service-url',
        contextService.url,
        '--token',
        TOKEN,
        '--json',
      ]);

      expect(result.code).toBe(1);
      const summary = JSON.parse(result.out) as { ok: boolean; errors: Array<{ step: string; message: string }> };
      expect(summary.ok).toBe(false);
      expect(summary.errors[0]?.step).toBe('readyz');
      expect(summary.errors[0]?.message).toContain('handshake_failed');
      // Nothing after the failed step runs: a script that kept going would report
      // five steps for a deployment that cannot serve.
      expect(runtime.requests.some((request) => request.method === 'POST' && request.path === '/v1/runs')).toBe(false);
    } finally {
      await runtime.close();
      await contextService.close();
    }
  });

  it('fails when the Run terminates without a Decision to read back', async () => {
    const runtime = await startStub(
      healthyRoutes({ 'GET /v1/runs/': () => runStatus({ status: 'failed', decisions: [], error: { code: 'model_unavailable' } }) }),
    );
    const contextService = await startStub(healthyRoutes());
    try {
      const result = await runScript([
        '--base-url',
        runtime.url,
        '--context-service-url',
        contextService.url,
        '--token',
        TOKEN,
        '--json',
      ]);

      expect(result.code).toBe(1);
      const summary = JSON.parse(result.out) as { errors: Array<{ step: string; message: string }> };
      expect(summary.errors[0]?.step).toBe('run');
      expect(summary.errors.map((error) => error.message).join(' ')).toMatch(/no Decision/);
      expect(contextService.requests).toEqual([]);
    } finally {
      await runtime.close();
      await contextService.close();
    }
  });

  it('presents the audit credential separately when a deployment issues one', async () => {
    const runtime = await startStub(healthyRoutes());
    const contextService = await startStub(healthyRoutes());
    try {
      const result = await runScript([
        '--base-url',
        runtime.url,
        '--context-service-url',
        contextService.url,
        '--token',
        TOKEN,
        '--audit-token',
        'auditor.context.token',
        '--json',
      ]);

      expect(result.code, result.err).toBe(0);
      const read = contextService.requests.find((request) => request.path === `/v1/provenance/${DECISION_ID}`);
      expect(read?.headers['authorization']).toBe('Bearer auditor.context.token');
      const create = runtime.requests.find((request) => request.method === 'POST');
      expect(create?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    } finally {
      await runtime.close();
      await contextService.close();
    }
  });

  it('fails when provenance does not answer for the Run\'s Decision', async () => {
    const runtime = await startStub(healthyRoutes());
    const contextService = await startStub(
      healthyRoutes({ 'GET /v1/provenance/': () => ({ status: 404, body: { error: { code: 'not_found' } } }) }),
    );
    try {
      const result = await runScript([
        '--base-url',
        runtime.url,
        '--context-service-url',
        contextService.url,
        '--token',
        TOKEN,
        '--json',
      ]);

      expect(result.code).toBe(1);
      const summary = JSON.parse(result.out) as { errors: Array<{ step: string; message: string }> };
      expect(summary.errors[0]?.step).toBe('provenance');
      expect(summary.errors[0]?.message).toContain('404');
    } finally {
      await runtime.close();
      await contextService.close();
    }
  });

  it('reads the same inputs from the environment, and refuses to guess a missing one', async () => {
    const runtime = await startStub(healthyRoutes());
    const contextService = await startStub(healthyRoutes());
    try {
      const result = await runScript([], {
        FDE_SMOKE_BASE_URL: runtime.url,
        FDE_SMOKE_CONTEXT_SERVICE_URL: contextService.url,
        FDE_SMOKE_TOKEN: TOKEN,
        FDE_SMOKE_CAPABILITY: 'document-triage',
      });

      expect(result.code, result.err).toBe(0);
      expect(result.out).toContain('smoke: 5 passed');

      const missing = await runScript([], {});
      expect(missing.code).toBe(2);
      expect(missing.err).toContain('--base-url');
    } finally {
      await runtime.close();
      await contextService.close();
    }
  });
});
