// Seam: the generated entrypoint, booted as a process.
//
// Everything else in this suite tests a module or a router. This one starts the
// app the way the bundle does — `runtime-migrate` first, then `src/index.ts` —
// and talks to it over HTTP, because two promises only hold if the real entrypoint
// holds them: the app verifies its state store schema before serving (A6), and a
// Run fails closed while ExecutionContext issuance is still the identity slice's
// seam (#29) instead of calling context-service unauthenticated.
import { execFile, spawn } from 'node:child_process';
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

const boot = async (dbPath: string): Promise<Running> => {
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    cwd: tree.root,
    env: { ...process.env, FDE_STATE_STORE_PATH: dbPath, FDE_PORT: '0' },
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

describe('the generated app boots', () => {
  it('serves liveness after the migration job, and fails a Run closed until identity lands', { timeout: 60_000 }, async () => {
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

      expect(status['status']).toBe('failed');
      expect(status['error']).toMatchObject({ code: 'unavailable', retryable: false, trace_id: run.trace_id });
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
    const child = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
      cwd: tree.root,
      env: { ...process.env, FDE_STATE_STORE_PATH: join(tree.root, 'empty/mastra.db'), FDE_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

    expect(code).toBe(1);
    expect(output).toMatch(/unmigrated/);
  });
});
