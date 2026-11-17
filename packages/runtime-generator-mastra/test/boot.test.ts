// Seam: the generated entrypoint, booted as a process.
//
// Everything else in this suite tests a module or a router. This one starts the
// app the way the bundle does — `runtime-migrate` first, then `src/index.ts` —
// and talks to it over HTTP, because three promises only hold if the real
// entrypoint holds them: the app verifies its state store schema before serving
// (A6), it refuses to serve without an ExecutionContext key and identity source
// instead of becoming a Run API that can never call context-service (#29), and
// with both injected a Run gets past issuance and reaches the context-service seam.
import { execFile, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MaterializedTree } from './support/generated-app.js';
import { materialize } from './support/generated-app.js';
import { packageRoot } from './support/repo.js';

interface Running {
  baseUrl: string;
  stop(): Promise<void>;
}

/**
 * context-service of this release, as far as the handshake can tell: its own
 * runtime-info and nothing else (§9.1). A real bundle is deployed *after*
 * context-service is ready (§8.3), so every boot here has one — the fail-closed
 * cases point the app at a peer that disagrees, or at nothing at all.
 */
interface Peer {
  url: string;
  /** Every request the app made, so "it reached context-service" is observed, not inferred. */
  requests: Array<{ method: string; path: string; authorization: string; traceparent: string }>;
  stop(): Promise<void>;
}

const CONTEXT_SERVICE_INFO = {
  contract_version: '1.4.0',
  service: 'context-service',
  service_version: '0.1.0',
  graph_schema_version: '1',
  audit_schema_version: '1',
  backend: { graph: 'embedded', audit: 'sqlite' },
  capabilities: ['shared-graph', 'semantic-ingest'],
  limits: { max_nodes: 10_000, max_edges: 50_000, max_request_timeout_ms: 30_000, max_run_deadline_ms: 1_800_000 },
  components: [{ name: 'context-service', version: '0.1.0', contract_version: '1.4.0', status: 'ready' }],
  started_at: '2026-11-15T09:00:00.000Z',
};

const startPeer = async (document: Record<string, unknown> = CONTEXT_SERVICE_INFO): Promise<Peer> => {
  const requests: Peer['requests'] = [];
  const server: Server = createServer((request, response) => {
    requests.push({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      authorization: String(request.headers['authorization'] ?? ''),
      traceparent: String(request.headers['traceparent'] ?? ''),
    });
    if (request.url === '/v1/runtime-info') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(document));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'not_found' } }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

/** A port nothing is listening on: the handshake is then `unavailable`, not a mismatch. */
const closedPort = async (): Promise<string> => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
};

const DEPLOYMENT_ID = 'dep_01ARZ3NDEKTSV4RRFFQ69G5FAV';

/**
 * What a deployment injects (§5.4): a per-Deployment ES256 key and the mounted
 * static identity source. Generated here because a test key that is checked in
 * would be exactly the thing the slice forbids. The profile names the Customer the
 * bundle serves, because a token asserts this customer's tenant and the app refuses
 * a profile for anyone else.
 */
const identityEnv = (): Record<string, string> => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  return {
    FDE_DEPLOYMENT_ID: DEPLOYMENT_ID,
    FDE_IDENTITY_CONFIG_JSON: JSON.stringify({
      apiVersion: 'fde.dev/v0',
      kind: 'IdentityProfile',
      metadata: { customer: 'acme', environment: 'acme-prod' },
      spec: {
        source: 'static',
        defaultSubject: 'adjuster-1',
        subjects: [{ subject: 'adjuster-1', platformRoles: ['end_user'], businessRoles: ['claims-adjuster'] }],
      },
    }),
    FDE_SIGNING_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
};

/** Async: the app under test runs in this process, so a blocking spawn would deadlock it. */
const run = promisify(execFile);

let tree: MaterializedTree;
beforeEach(() => {
  tree = materialize(undefined, { location: 'tmp' });
  // The image runs `npm install` from the Profile's package set; the test borrows
  // this package's pinned `node_modules` so the app resolves the same @mastra/core.
  symlinkSync(join(packageRoot, 'node_modules'), join(tree.root, 'node_modules'), 'dir');
});
afterEach(() => {
  tree.cleanup();
});

const migrate = async (): Promise<string> => {
  const dbPath = join(tree.root, 'state/mastra.db');
  mkdirSync(join(tree.root, 'state'), { recursive: true });
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/migrate.ts'], {
    cwd: tree.root,
    env: { ...process.env, FDE_STATE_STORE_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  expect(code, 'runtime-migrate must exit 0').toBe(0);
  return dbPath;
};

const boot = async (
  dbPath: string,
  extraEnv: Record<string, string> = identityEnv(),
  contextServiceUrl = 'http://127.0.0.1:1',
): Promise<Running> => {
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    cwd: tree.root,
    env: {
      ...process.env,
      FDE_STATE_STORE_PATH: dbPath,
      FDE_PORT: '0',
      FDE_CONTEXT_SERVICE_URL: contextServiceUrl,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the app did not start listening:\n${output}`)), 20_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = /listening on :(\d+)/.exec(output);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the app exited with ${code}:\n${output}`));
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.on('exit', () => resolve());
      });
    },
  };
};

/** Spawn the entrypoint and wait for it to exit; the identity failures exit before serving. */
const exitOf = async (extraEnv: Record<string, string>): Promise<{ code: number | null; output: string }> => {
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    cwd: tree.root,
    env: { ...process.env, FDE_PORT: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

  return { code, output };
};

describe('the generated app boots', () => {
  it('serves liveness and readiness after the migration job, and starts a Run that reaches context-service', { timeout: 60_000 }, async () => {
    const dbPath = await migrate();
    const peer = await startPeer();
    const app = await boot(dbPath, identityEnv(), peer.url);
    try {
      const health = await fetch(`${app.baseUrl}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });

      // The handshake ran before the listener bound (§9.3), so readiness is already
      // `ready` — and the aggregate is context-service's document plus this app's.
      const ready = await fetch(`${app.baseUrl}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: 'ready', reasons: [] });

      const info = (await (await fetch(`${app.baseUrl}/v1/runtime-info`)).json()) as Record<string, any>;
      expect(info['service']).toBe('runtime-app');
      expect(info['runtime']).toMatchObject({ family: 'mastra', language: 'typescript', state_store: 'sqlite' });
      expect(info['capability_details']['hitl.consume']).toEqual({ support: 'adapter' });
      expect((info['components'] as Array<{ name: string }>).map((component) => component.name)).toEqual([
        'runtime-app',
        'runtime-state',
        'context-service',
      ]);

      const created = await fetch(`${app.baseUrl}/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': 'boot-0123456789abcdef' },
        body: JSON.stringify({ capability_id: 'document-triage', input: { query: 'triage claim 1001' } }),
      });
      expect(created.status).toBe(201);
      const run = (await created.json()) as { run_id: string; trace_id: string };

      const deadline = Date.now() + 20_000;
      let status: Record<string, unknown> = {};
      while (Date.now() < deadline) {
        status = (await (await fetch(`${app.baseUrl}/v1/runs/${run.run_id}`)).json()) as Record<string, unknown>;
        if (status['status'] === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // The Run was minted an ExecutionContext and got as far as context-service: the
      // peer here answers `runtime-info` and 404s everything else, so what proves
      // issuance worked is the request it *received*, not the failure it caused.
      expect(status['status']).toBe('failed');
      const retrieve = peer.requests.filter((entry) => entry.path === '/v1/context/retrieve');
      expect(retrieve).toHaveLength(1);
      expect(retrieve[0]?.method).toBe('POST');
      // §5.1/§5.3: a bearer ExecutionContext, and a `traceparent` carrying the Run trace.
      expect(retrieve[0]?.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      expect(retrieve[0]?.traceparent.split('-')[1]).toBe(run.trace_id);
      // Asserted on the trace id, not the code: how a workflow failure is mapped onto
      // the error table is the executor's (#28/#37), and this test is about identity.
      expect((status['error'] as { trace_id: string }).trace_id).toBe(run.trace_id);
    } finally {
      await app.stop();
      await peer.stop();
    }
  });

  it('refuses to serve when context-service is on another contract major', { timeout: 60_000 }, async () => {
    const dbPath = await migrate();
    const peer = await startPeer({ ...CONTEXT_SERVICE_INFO, contract_version: '2.0.0' });
    const app = await boot(dbPath, identityEnv(), peer.url);
    try {
      const ready = await fetch(`${app.baseUrl}/readyz`);
      expect(ready.status).toBe(503);
      const report = (await ready.json()) as { status: string; reasons: string[] };
      expect(report.status).toBe('not_ready');
      expect(report.reasons[0]).toMatch(/^contract_mismatch: .*v2.*v1/);

      // Fail closed: the Run API does not serve, and says which mismatch it was.
      const created = await fetch(`${app.baseUrl}/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': 'mismatch-0123456789abcdef' },
        body: JSON.stringify({ capability_id: 'document-triage', input: {} }),
      });
      expect(created.status).toBe(503);
      const envelope = (await created.json()) as { error: { code: string; retryable: boolean; details: any } };
      expect(envelope.error.code).toBe('contract_mismatch');
      expect(envelope.error.retryable).toBe(false);
      expect(envelope.error.details.reason).toBe('contract_major_mismatch');

      const info = await fetch(`${app.baseUrl}/v1/runtime-info`);
      expect(info.status).toBe(503);
      expect(((await info.json()) as { error: { code: string } }).error.code).toBe('contract_mismatch');

      // Liveness still answers: a container that cannot report why it is not ready is
      // a container nobody can debug.
      expect((await fetch(`${app.baseUrl}/healthz`)).status).toBe(200);
    } finally {
      await app.stop();
      await peer.stop();
    }
  });

  it('refuses to serve when context-service never answers', { timeout: 60_000 }, async () => {
    const dbPath = await migrate();
    const app = await boot(dbPath, identityEnv(), await closedPort());
    try {
      const ready = await fetch(`${app.baseUrl}/readyz`);
      expect(ready.status).toBe(503);
      const report = (await ready.json()) as { status: string; reasons: string[] };
      expect(report.reasons[0]).toMatch(/^unavailable: GET http:\/\/.+\/v1\/runtime-info did not answer/);
    } finally {
      await app.stop();
    }
  });

  it('passes the emitted A2/A5 contract tests against the real bundle', { timeout: 90_000 }, async () => {
    const dbPath = await migrate();
    const peer = await startPeer();
    const app = await boot(dbPath, identityEnv(), peer.url);
    try {
      const script = join(tree.bundle, 'contract-tests/run-api-smoke.mjs');
      for (const caseId of ['A2', 'A5']) {
        const { stdout } = await run(process.execPath, [script, '--case', caseId, '--base-url', app.baseUrl]);
        expect(stdout).toContain(`${caseId}: ok`);
      }
    } finally {
      await app.stop();
      await peer.stop();
    }
  });

  it('refuses to serve an unmigrated state store', { timeout: 30_000 }, async () => {
    mkdirSync(join(tree.root, 'empty'), { recursive: true });

    const { code, output } = await exitOf({
      FDE_STATE_STORE_PATH: join(tree.root, 'empty/mastra.db'),
      ...identityEnv(),
    });

    expect(code).toBe(1);
    expect(output).toMatch(/unmigrated/);
  });

  it('refuses to start without a signing key, instead of serving a Run API that cannot sign', { timeout: 30_000 }, async () => {
    const dbPath = await migrate();
    const env = identityEnv();
    delete env['FDE_SIGNING_KEY'];

    const { code, output } = await exitOf({ FDE_STATE_STORE_PATH: dbPath, ...env });

    expect(code).toBe(1);
    expect(output).toMatch(/FDE_SIGNING_KEY/);
  });

  it('refuses to start without an identity source mounted', { timeout: 30_000 }, async () => {
    const dbPath = await migrate();
    const env = identityEnv();
    delete env['FDE_IDENTITY_CONFIG_JSON'];

    const { code, output } = await exitOf({ FDE_STATE_STORE_PATH: dbPath, ...env });

    expect(code).toBe(1);
    expect(output).toMatch(/FDE_IDENTITY_CONFIG/);
  });
});
