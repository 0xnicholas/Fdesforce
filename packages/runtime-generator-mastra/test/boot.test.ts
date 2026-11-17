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

const boot = async (dbPath: string, extraEnv: Record<string, string> = identityEnv()): Promise<Running> => {
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    cwd: tree.root,
    env: { ...process.env, FDE_STATE_STORE_PATH: dbPath, FDE_PORT: '0', ...extraEnv },
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
  it('serves liveness after the migration job, and starts a Run that reaches context-service', { timeout: 60_000 }, async () => {
    const dbPath = await migrate();
    const app = await boot(dbPath);
    try {
      const health = await fetch(`${app.baseUrl}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });

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

      // The Run was minted an ExecutionContext and got as far as `POST
      // /v1/context/retrieve`; there is no context-service in this test, so the
      // transport failure is what proves issuance worked. Before #29 the same Run
      // failed with `unavailable` *because* issuance was the seam.
      expect(status['status']).toBe('failed');
      // Asserted on the message, not the code: how a workflow failure is mapped onto
      // the error table is the executor's (#28/#37), and this test is about identity.
      expect((status['error'] as { message: string }).message).toMatch(/\/v1\/context\/retrieve did not answer/);
      expect((status['error'] as { trace_id: string }).trace_id).toBe(run.trace_id);
    } finally {
      await app.stop();
    }
  });

  it('passes the emitted A2/A5 contract tests against the real bundle', { timeout: 90_000 }, async () => {
    const dbPath = await migrate();
    const app = await boot(dbPath);
    try {
      const script = join(tree.bundle, 'contract-tests/run-api-smoke.mjs');
      for (const caseId of ['A2', 'A5']) {
        const { stdout } = await run(process.execPath, [script, '--case', caseId, '--base-url', app.baseUrl]);
        expect(stdout).toContain(`${caseId}: ok`);
      }
    } finally {
      await app.stop();
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
