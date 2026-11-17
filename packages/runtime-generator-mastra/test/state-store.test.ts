// Seam: the generated libsql/SQLite state store and its migration entrypoint.
//
// The runtime state store is the only runtime state the generated app keeps
// (contract §9.2, A6): the Run registry, the SSE event log a reconnecting client
// replays from, and the idempotency index that makes `POST /v1/runs` safe to
// retry. It is a volume-backed SQLite database, so the tests open a real database
// file in a scratch directory and, where it matters, reopen it — a store that
// cannot survive a process restart is not a state store.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
}

interface StateStore {
  migrate(now?: string): string[];
  schemaVersion(): string;
  putRun(record: RunRecord): void;
  getRun(runId: string): RunRecord | undefined;
  appendEvent(input: { runId: string; traceId: string; type: string; payload: Record<string, unknown>; timestamp?: string }): {
    run_id: string;
    trace_id: string;
    seq: number;
    type: string;
    timestamp: string;
    payload: Record<string, unknown>;
  };
  getEvents(runId: string, afterSeq?: number): Array<{ seq: number; type: string }>;
  reserveRun(input: {
    tenantId: string;
    endpoint: string;
    key: string;
    requestDigest: string;
    record: RunRecord;
    response: Record<string, unknown>;
  }): { outcome: 'created' | 'replayed' | 'conflict'; run_id: string; response?: Record<string, unknown> };
  close(): void;
}

interface StateStoreModule {
  STATE_SCHEMA_VERSION: string;
  StateStore: new (path: string) => StateStore;
}

interface ConfigModule {
  DEFAULT_RUN_DEADLINE_MS: number;
  TENANT_ID: string;
  SOLUTION_ID: string;
  ENVIRONMENT_NAME: string;
  loadConfig(env?: Record<string, string | undefined>): {
    tenantId: string;
    port: number;
    stateStorePath: string;
    runDeadlineMs: number;
    heartbeatIntervalMs: number;
  };
  loadIdentityEnv(env?: Record<string, string | undefined>): {
    deploymentId?: string;
    configPath?: string;
    configJson?: string;
    signingKeyPem?: string;
    signingKeyFile?: string;
  };
}

let tree: MaterializedTree;
beforeEach(() => {
  tree = materialize();
});
afterEach(() => {
  tree.cleanup();
});

const open = async (): Promise<{ module: StateStoreModule; store: StateStore }> => {
  const module = await tree.load<StateStoreModule>('runtime/state-store.ts');
  const store = new module.StateStore(statePath(tree));
  store.migrate('2026-01-01T00:00:00.000Z');
  return { module, store };
};

const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  run_id: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
  capability_id: 'document-triage',
  status: 'running',
  started_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('the migration', () => {
  it('applies once and reports the Profile schema version', async () => {
    const { module, store } = await open();

    expect(store.schemaVersion()).toBe(module.STATE_SCHEMA_VERSION);
    expect(module.STATE_SCHEMA_VERSION).toBe('1');
    expect(store.migrate('2026-01-01T00:00:01.000Z')).toEqual([]);
    store.close();
  });

  it('reports an unmigrated store instead of throwing, so the app can fail closed', async () => {
    const module = await tree.load<StateStoreModule>('runtime/state-store.ts');
    const store = new module.StateStore(statePath(tree));

    expect(store.schemaVersion()).toBe('');
    store.close();
  });

  it('runs through the job entrypoint the topology declares, against the mounted volume', async () => {
    // Spawned, so the tree lives outside `node_modules`: Node will not type-strip a
    // file under it. That is the container's situation too (`/app`, not a package).
    const spawned = materialize(undefined, { location: 'tmp' });
    try {
      const dbPath = join(spawned.root, 'volume/mastra.db');
      // The volume is mounted by the deployer; the app must not create it (a missing
      // volume has to fail the migration, not be papered over inside the image).
      mkdirSync(dirname(dbPath), { recursive: true });
      execFileSync(process.execPath, ['--experimental-strip-types', 'src/migrate.ts'], {
        cwd: spawned.root,
        env: { ...process.env, FDE_STATE_STORE_PATH: dbPath },
        stdio: 'pipe',
      });

      expect(existsSync(dbPath)).toBe(true);

      const module = await tree.load<StateStoreModule>('runtime/state-store.ts');
      const store = new module.StateStore(dbPath);
      expect(store.schemaVersion()).toBe(module.STATE_SCHEMA_VERSION);
      store.close();
    } finally {
      spawned.cleanup();
    }
  });
});

describe('the Run registry table', () => {
  it('round-trips a Run record and survives a reopen', async () => {
    const { module, store } = await open();
    const record = run({ output: { recommendation: 'approve' }, finished_at: '2026-01-01T00:00:05.000Z' });
    store.putRun(record);
    store.close();

    const reopened = new module.StateStore(statePath(tree));
    expect(reopened.getRun(record.run_id)).toEqual(record);
    expect(reopened.getRun('run_00000000000000000000000000')).toBeUndefined();
    reopened.close();
  });

  it('updates a Run in place instead of appending a second row', async () => {
    const { module, store } = await open();
    store.putRun(run());
    store.putRun(run({ status: 'succeeded', finished_at: '2026-01-01T00:00:05.000Z' }));
    store.close();

    const reopened = new module.StateStore(statePath(tree));
    expect(reopened.getRun(run().run_id)?.status).toBe('succeeded');
    reopened.close();
  });
});

describe('the event log', () => {
  it('numbers events from 1, per Run, and replays from a given seq', async () => {
    const { store } = await open();
    const started = store.appendEvent({ runId: run().run_id, traceId: run().trace_id, type: 'run.started', payload: {} });
    store.appendEvent({ runId: run().run_id, traceId: run().trace_id, type: 'tool.call', payload: { tool: 'retrieve-context' } });
    store.appendEvent({ runId: run().run_id, traceId: run().trace_id, type: 'run.finished', payload: {} });
    store.appendEvent({
      runId: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4737',
      type: 'run.started',
      payload: {},
    });

    expect(started).toEqual({
      run_id: run().run_id,
      trace_id: run().trace_id,
      seq: 1,
      type: 'run.started',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      payload: {},
    });
    expect(store.getEvents(run().run_id).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(store.getEvents(run().run_id, 1).map((event) => event.seq)).toEqual([2, 3]);
    expect(store.getEvents('run_01ARZ3NDEKTSV4RRFFQ69G5FAW').map((event) => event.seq)).toEqual([1]);
    expect(store.getEvents('run_01ARZ3NDEKTSV4RRFFQ69G5FAX')).toEqual([]);
    store.close();
  });

  it('keeps the log across a restart, so Last-Event-ID still replays', async () => {
    const { module, store } = await open();
    store.appendEvent({ runId: run().run_id, traceId: run().trace_id, type: 'run.started', payload: {} });
    store.close();

    const reopened = new module.StateStore(statePath(tree));
    expect(reopened.getEvents(run().run_id).map((event) => event.seq)).toEqual([1]);
    const next = reopened.appendEvent({ runId: run().run_id, traceId: run().trace_id, type: 'run.finished', payload: {} });
    expect(next.seq).toBe(2);
    reopened.close();
  });
});

describe('the idempotency index', () => {
  const response = {
    run_id: run().run_id,
    trace_id: run().trace_id,
    status: 'queued',
    stream_url: `/v1/runs/${run().run_id}/stream`,
  };
  const base = {
    tenantId: 'acme',
    endpoint: 'POST /v1/runs',
    key: 'smoke-a2-0000000000000000',
    requestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    record: run({ status: 'queued' }),
    response,
  };

  it('records the first request and creates its Run in the same transaction', async () => {
    const { store } = await open();

    expect(store.reserveRun(base)).toEqual({ outcome: 'created', run_id: base.record.run_id });
    expect(store.getRun(base.record.run_id)).toEqual(base.record);

    const replay = store.reserveRun(base);
    expect(replay.outcome).toBe('replayed');
    expect(replay.run_id).toBe(base.record.run_id);
    expect(replay.response).toEqual(base.response);
    store.close();
  });

  it('refuses the same key with a different payload', async () => {
    const { store } = await open();
    store.reserveRun(base);

    const conflict = store.reserveRun({
      ...base,
      record: run({ run_id: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAW', status: 'queued' }),
      requestDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });

    expect(conflict.outcome).toBe('conflict');
    expect(conflict.run_id).toBe(base.record.run_id);
    // A conflicting reservation must not create the second Run.
    expect(store.getRun('run_01ARZ3NDEKTSV4RRFFQ69G5FAW')).toBeUndefined();
    store.close();
  });

  it('scopes the key by tenant and endpoint, not globally', async () => {
    const { store } = await open();
    store.reserveRun(base);

    expect(store.reserveRun({ ...base, tenantId: 'beta' }).outcome).toBe('created');
    expect(store.reserveRun({ ...base, endpoint: 'POST /v1/approvals' }).outcome).toBe('created');
    store.close();
  });

  it('keeps the reservation across a restart', async () => {
    const { module, store } = await open();
    store.reserveRun(base);
    store.close();

    const reopened = new module.StateStore(statePath(tree));
    expect(reopened.reserveRun(base).outcome).toBe('replayed');
    reopened.close();
  });
});

describe('the deployment configuration', () => {
  it('defaults the state store path and the Run deadline, and bakes the tenant', async () => {
    const config = await tree.load<ConfigModule>('runtime/config.ts');

    expect(config.loadConfig({})).toEqual({
      tenantId: 'acme',
      port: 4111,
      stateStorePath: './state/mastra.db',
      runDeadlineMs: config.DEFAULT_RUN_DEADLINE_MS,
      heartbeatIntervalMs: expect.any(Number),
    });
  });

  it('takes the deployment values from the environment and ignores a malformed deadline', async () => {
    const config = await tree.load<ConfigModule>('runtime/config.ts');

    const loaded = config.loadConfig({
      FDE_STATE_STORE_PATH: '/app/state/mastra.db',
      FDE_RUN_DEADLINE_MS: '90000',
    });
    expect(loaded.stateStorePath).toBe('/app/state/mastra.db');
    expect(loaded.runDeadlineMs).toBe(90_000);
    expect(config.loadConfig({ FDE_RUN_DEADLINE_MS: 'soon' }).runDeadlineMs).toBe(config.DEFAULT_RUN_DEADLINE_MS);
    expect(config.loadConfig({ FDE_RUN_DEADLINE_MS: '-5' }).runDeadlineMs).toBe(config.DEFAULT_RUN_DEADLINE_MS);
    expect(config.loadConfig({ FDE_PORT: '8080' }).port).toBe(8080);
  });

  it('does not let an install change the tenant, because the tenant is the Customer (ADR-0006 §4.5)', async () => {
    const config = await tree.load<ConfigModule>('runtime/config.ts');

    // One bundle is one Customer: `tenant_id` is the immutable customer id, not a
    // deployment knob, so an Environment that sets one anyway gets the baked value.
    expect(config.loadConfig({ FDE_TENANT_ID: 'beta' }).tenantId).toBe('acme');
    expect(config.TENANT_ID).toBe('acme');
    expect(config.SOLUTION_ID).toBe('claims-triage');
    // The Environment is baked for the identity-source check, not for a token claim.
    expect(config.ENVIRONMENT_NAME).toBe('acme-prod');
  });
});

describe('the identity settings', () => {
  it('reads the injected profile and signing key, and leaves absent settings absent', async () => {
    const config = await tree.load<ConfigModule>('runtime/config.ts');

    expect(config.loadIdentityEnv({})).toEqual({
      deploymentId: undefined,
      configPath: undefined,
      configJson: undefined,
      signingKeyPem: undefined,
      signingKeyFile: undefined,
    });
    expect(
      config.loadIdentityEnv({
        FDE_DEPLOYMENT_ID: 'dep_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        FDE_IDENTITY_CONFIG: '/app/identity/identity.json',
        FDE_IDENTITY_CONFIG_JSON: '{}',
        FDE_SIGNING_KEY: '-----BEGIN PRIVATE KEY-----',
        FDE_SIGNING_KEY_FILE: '/run/secrets/mastra-app-key.pem',
      }),
    ).toEqual({
      deploymentId: 'dep_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      configPath: '/app/identity/identity.json',
      configJson: '{}',
      signingKeyPem: '-----BEGIN PRIVATE KEY-----',
      signingKeyFile: '/run/secrets/mastra-app-key.pem',
    });
  });
});
