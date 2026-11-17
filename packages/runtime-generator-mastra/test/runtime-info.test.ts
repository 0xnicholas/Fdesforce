// Seam: the emitted `runtime/runtime-info.ts`, loaded from the materialised tree.
//
// #30's acceptance criteria are properties of a *document* and of a decision: the
// descriptor reports the build the lock pins, every `must` the Spec derives is
// satisfiable, and a peer that disagrees makes the app refuse to serve. So the
// test loads the module the bundle ships and drives it — with a stub
// context-service for the happy path, with mismatched documents and mismatched
// build blocks for the fail-closed paths — rather than asserting on the emitter's
// string literals.
//
// Nothing here recomputes what the code computes: the expectations come from
// `contracts/schemas/runtime-info.schema.json` (the shape), from the example lock
// and Profile (the pinned values) and from hand-written documents (the peers).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSolutionLock, parseRuntimeProfile } from '@fde/spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MaterializedTree } from './support/generated-app.js';
import { materialize } from './support/generated-app.js';
import { exampleLock, exampleProfile, generateInput } from './support/fixtures.js';
import { paths, readText, readYaml, repoRoot } from './support/repo.js';

interface CapabilityNode {
  support: string;
  limitations?: string[];
}

interface ComponentInfo {
  name: string;
  version: string;
  contract_version: string;
  status: string;
  schema_version?: string;
}

interface RuntimeInfo {
  contract_version: string;
  service: string;
  service_version: string;
  runtime?: Record<string, unknown>;
  capability_details?: Record<string, CapabilityNode>;
  graph_schema_version: string;
  audit_schema_version: string;
  backend: { graph: string; audit: string };
  capabilities: string[];
  limits: Record<string, number>;
  components?: ComponentInfo[];
  started_at: string;
}

interface HandshakeFailure {
  code: string;
  reason: string;
  message: string;
  details: Record<string, unknown>;
}

interface BuildBlocks {
  lock: Record<string, unknown>;
  profile: Record<string, unknown>;
  generator: Record<string, unknown>;
  environment: Record<string, unknown>;
  runtime: Record<string, any>;
  details: Record<string, CapabilityNode>;
  requirements: Array<{ capability: string; level: string; source: string }>;
  storeKind: string;
}

type RuntimeInfoState =
  | { ready: true; info: RuntimeInfo; degradations: Array<{ capability: string; support: string }> }
  | { ready: false; failure: HandshakeFailure; failures: HandshakeFailure[] };

interface RuntimeInfoModule {
  SERVICE: string;
  SERVICE_VERSION: string;
  CONTEXT_SERVICE_NAME: string;
  LOCK_PINS: Record<string, string>;
  PROFILE_IDENTITY: Record<string, string>;
  GENERATOR_IDENTITY: Record<string, string>;
  ENVIRONMENT: Record<string, unknown>;
  RUNTIME: Record<string, any>;
  CAPABILITY_DETAILS: Record<string, CapabilityNode>;
  capabilityNames(details: Record<string, CapabilityNode>): string[];
  REQUIREMENTS: Array<{ capability: string; level: string; source: string }>;
  LIMITS: Record<string, number>;
  BUILD: BuildBlocks;
  handshake(options?: {
    build?: BuildBlocks;
    baseUrl?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }): Promise<RuntimeInfoState>;
  verifyBuild(build?: BuildBlocks): HandshakeFailure[];
  verifyComponent(document: unknown, build?: BuildBlocks): HandshakeFailure[];
  aggregate(peer: RuntimeInfo, build?: BuildBlocks): RuntimeInfo;
  ownComponentCount(peer: RuntimeInfo): number;
  RUNTIME_COMPONENTS: readonly string[];
  MAX_COMPONENTS: number;
  OWN_COMPONENTS: number;
  readiness(state: RuntimeInfoState): { status: string; reasons: string[] };
  degradations(build?: BuildBlocks): Array<{ capability: string; support: string }>;
}

const schema = JSON.parse(
  readFileSync(join(repoRoot, 'contracts/schemas/runtime-info.schema.json'), 'utf8'),
) as {
  $defs: Record<
    string,
    {
      required?: string[];
      properties?: Record<string, { enum?: string[]; pattern?: string; allOf?: unknown[] }>;
      propertyNames?: { pattern?: string };
      additionalProperties?: boolean;
    }
  >;
};

const runtimeCapabilities = JSON.parse(readText('contracts/schemas/runtime-capabilities.schema.json')) as {
  $defs: Record<string, { propertyNames?: { pattern?: string }; enum?: string[] }>;
};

/** `Licensing` is defined by the Profile artifact, and the handshake reports it verbatim. */
const runtimeProfileSchema = JSON.parse(readText('contracts/schemas/runtime-profile.schema.json')) as {
  $defs: Record<string, { required?: string[]; properties?: Record<string, { enum?: string[] }> }>;
};

const lock = exampleLock();
const profile = exampleProfile();

/** The pinned Profile digest, from the lock's own pin. */
const lockedDigest = (): string => /@(sha256:[a-f0-9]{64})$/.exec(lock.runtime.profile)?.[1] ?? '';

let tree: MaterializedTree;
let module: RuntimeInfoModule;

beforeAll(async () => {
  tree = materialize();
  module = await tree.load<RuntimeInfoModule>('runtime/runtime-info.ts');
});
afterAll(() => {
  tree.cleanup();
});

/**
 * What context-service of this release answers: its own component information and
 * nothing else (§9.1). The schema versions come from the lock, because that is what
 * a matching deployment pins; everything else is the document on the wire.
 */
const contextServiceInfo = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  contract_version: lock.runtime.contractVersion,
  service: 'context-service',
  service_version: lock.runtime.contextService,
  graph_schema_version: String(lock.runtime.graphSchema),
  audit_schema_version: String(lock.runtime.auditSchema),
  backend: { graph: 'embedded', audit: 'sqlite' },
  capabilities: ['shared-graph', 'semantic-ingest', 'audit-append'],
  limits: { max_nodes: 10_000, max_edges: 50_000, max_request_timeout_ms: 30_000, max_run_deadline_ms: 1_800_000 },
  components: [
    { name: 'context-service', version: lock.runtime.contextService, contract_version: lock.runtime.contractVersion, status: 'ready' },
    { name: 'graph-store', version: '0.7.0', contract_version: lock.runtime.contractVersion, status: 'ready' },
  ],
  started_at: '2026-11-15T09:00:00.000Z',
  ...overrides,
});

/** A `fetch` that answers with one document, and records the URLs it was asked for. */
const answering = (body: unknown, init: { status?: number } = {}): { fetch: typeof fetch; urls: string[] } => {
  const urls: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: impl as unknown as typeof fetch, urls };
};

const clone = <T>(value: T): T => structuredClone(value);

const mutation = (change: (draft: BuildBlocks) => void): BuildBlocks => {
  const draft = clone(module.BUILD);
  change(draft);
  return draft;
};

describe('the reported document is the contract', () => {
  const ready = async (): Promise<RuntimeInfo> => {
    const state = await module.handshake({ fetch: answering(contextServiceInfo()).fetch });
    if (!state.ready) throw new Error(`expected a ready handshake, got ${JSON.stringify(state.failure)}`);
    return state.info;
  };

  it('carries every required RuntimeInfo property, and nothing the schema does not declare', async () => {
    const info = (await ready()) as unknown as Record<string, unknown>;
    const declared = schema.$defs['RuntimeInfo'];

    expect(declared?.additionalProperties).toBe(false);
    expect([...(declared?.required ?? [])].filter((name) => info[name] === undefined)).toEqual([]);
    expect(Object.keys(info).filter((name) => !Object.hasOwn(declared?.properties ?? {}, name))).toEqual([]);
    expect(info['service']).toBe('runtime-app');
    expect((declared?.properties?.['service']?.enum ?? []).includes('runtime-app' as never)).toBe(true);
  });

  it('carries every required RuntimeDescriptor property, and nothing else', async () => {
    const descriptor = module.RUNTIME;
    const declared = schema.$defs['RuntimeDescriptor'];

    expect([...(declared?.required ?? [])].filter((name) => descriptor[name as never] === undefined)).toEqual([]);
    expect(Object.keys(descriptor).filter((name) => !Object.hasOwn(declared?.properties ?? {}, name))).toEqual([]);

    const licensing = runtimeProfileSchema.$defs['Licensing'] ?? {};
    expect(Object.keys(descriptor['licensing']).sort()).toEqual(Object.keys(licensing.properties ?? {}).sort());
    expect([...(licensing.required ?? [])].filter((name) => descriptor['licensing'][name] === undefined)).toEqual([]);
    expect((licensing.properties?.['runtime']?.enum ?? []).includes(descriptor['licensing']['runtime'])).toBe(true);
  });

  it('reports the component names and statuses the schemas enumerate', async () => {
    const info = await ready();
    const component = schema.$defs['ComponentInfo'] as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    const names = component.properties['name']?.enum ?? [];
    const statuses = component.properties['status']?.enum ?? [];

    expect(info.components?.length).toBeGreaterThan(0);
    expect(info.components?.length).toBeLessThanOrEqual(module.MAX_COMPONENTS);
    for (const entry of info.components ?? []) {
      expect(names, entry.name).toContain(entry.name);
      expect(statuses, entry.status).toContain(entry.status);
      expect([...component.required].filter((field) => entry[field as never] === undefined)).toEqual([]);
    }
  });

  it('reports a `capability_details` map the capabilities schema accepts', async () => {
    const pattern = new RegExp(runtimeCapabilities.$defs['CapabilityDetails']?.propertyNames?.pattern ?? '');
    const declaredPaths = Object.keys(module.CAPABILITY_DETAILS);

    expect(declaredPaths.length).toBeGreaterThan(0);
    expect(declaredPaths.filter((path) => !pattern.test(path))).toEqual([]);

    const levels = runtimeCapabilities.$defs['Support']?.enum ?? [];
    for (const [capability, node] of Object.entries(module.CAPABILITY_DETAILS)) {
      expect(levels, capability).toContain(node.support);
    }
  });

  it('reports the limits §7.2 states, in the shape the contract requires', async () => {
    const required = schema.$defs['Limits']?.required ?? [];
    const info = await ready();

    expect(Object.keys(info.limits).sort()).toEqual([...required].sort());
    // §7.2: a context retrieval times out at 5s by default and 30s at most; a Run
    // deadline defaults to 5 minutes and is capped at 30. The embedded graph store's
    // envelope is 10k nodes / 50k edges.
    expect(info.limits).toEqual({
      max_nodes: 10_000,
      max_edges: 50_000,
      max_request_timeout_ms: 30_000,
      max_run_deadline_ms: 1_800_000,
    });
  });
});

describe('the descriptor is the build the lock pins', () => {
  it('takes the contract, the schema versions and the Profile digest from the lock', () => {
    expect(module.LOCK_PINS['contractVersion']).toBe(lock.runtime.contractVersion);
    expect(module.LOCK_PINS['graphSchemaVersion']).toBe(String(lock.runtime.graphSchema));
    expect(module.LOCK_PINS['auditSchemaVersion']).toBe(String(lock.runtime.auditSchema));
    expect(module.LOCK_PINS['profileDigest']).toBe(lockedDigest());
    expect(module.LOCK_PINS['runtimeVersion']).toBe(lock.runtime.mastra);
  });

  it('takes the descriptor from the Profile and the build Environment', () => {
    expect(module.RUNTIME['family']).toBe(profile.spec.family);
    expect(module.RUNTIME['language']).toBe(profile.spec.language);
    expect(module.RUNTIME['version']).toBe(profile.spec.runtimeVersion);
    expect(module.RUNTIME['profile_digest']).toBe(lockedDigest());
    expect(module.RUNTIME['generator_version']).toBe(profile.spec.generator.version);
    expect(module.RUNTIME['licensing']).toEqual(profile.spec.licensing);
    // v0 renders the split topology and nothing else (§8.3).
    expect(module.RUNTIME['topology']).toBe('split');
  });

  it('reports the state store the Environment selects, and the one the tree implements', () => {
    expect(module.ENVIRONMENT['stateStoreKind']).toBe(generateInput().environment.stateStore?.kind);
    expect(module.RUNTIME['state_store']).toBe(module.ENVIRONMENT['stateStoreKind']);
    expect(module.BUILD.storeKind).toBe('sqlite');
    expect(module.ENVIRONMENT['offlineTarget']).toBe(true);
  });

  it('summarizes the ten groups, and omits a group the Profile cannot generate', async () => {
    const state = await module.handshake({ fetch: answering(contextServiceInfo()).fetch });
    if (!state.ready) throw new Error('expected ready');

    const generated = Object.entries(profile.spec.capabilities)
      .filter(([, node]) => (node as { support: string }).support !== 'none')
      .map(([group]) => group);

    // The pre-1.3 array is the same block as `capability_details`, minus the members and
    // the groups the Profile cannot generate: an old client and a new one cannot disagree.
    expect(state.info.capabilities).toEqual(generated);
    expect(state.info.capabilities).toEqual(module.capabilityNames(module.CAPABILITY_DETAILS));
    for (const [group, node] of Object.entries(profile.spec.capabilities)) {
      expect(module.CAPABILITY_DETAILS[group]?.support, group).toBe((node as { support: string }).support);
    }
  });

  it('carries every `must` and `should` the Spec derives, with its source', () => {
    const byLevel = (level: string): string[] =>
      module.REQUIREMENTS.filter((requirement) => requirement.level === level).map((requirement) => requirement.capability);

    // The Acme Spec: a durable workflow, a Connector-backed Tool, a builtin Tool, an
    // Extension, two environments' worth of offline delivery and the contract's own
    // streaming + split-topology requirements.
    expect(byLevel('must').sort()).toEqual([
      'durableWorkflow',
      'extensions',
      'offline',
      'stateStore',
      'streaming',
      'tools.connectorOperations',
      'tools.native',
      'topology',
    ]);
    expect(byLevel('should')).toEqual(['observability']);
    expect(module.REQUIREMENTS.every((requirement) => requirement.source.length > 0)).toBe(true);
  });
});

describe('a matching deployment aggregates', () => {
  it('asks context-service for its own runtime-info at the configured address', async () => {
    const peer = answering(contextServiceInfo());

    const state = await module.handshake({ baseUrl: 'http://context-service.invalid:8011/', fetch: peer.fetch });

    expect(state.ready).toBe(true);
    expect(peer.urls).toEqual(['http://context-service.invalid:8011/v1/runtime-info']);
  });

  it('serves the aggregated document: this app, its store, and every peer component', async () => {
    const state = await module.handshake({ fetch: answering(contextServiceInfo()).fetch });
    if (!state.ready) throw new Error('expected ready');

    expect(state.info.service).toBe('runtime-app');
    expect(state.info.service_version).toBe(module.SERVICE_VERSION);
    expect(state.info.runtime).toEqual(module.RUNTIME);
    expect(state.info.capability_details).toEqual(module.CAPABILITY_DETAILS);
    // The graph and audit stores are context-service's, so their versions come from it.
    expect(state.info.graph_schema_version).toBe(String(lock.runtime.graphSchema));
    expect(state.info.audit_schema_version).toBe(String(lock.runtime.auditSchema));
    expect(state.info.backend).toEqual({ graph: 'embedded', audit: 'sqlite' });
    // Every component either side declared, each named once: context-service lists
    // itself, so the aggregate does not add a second entry for it.
    expect(state.info.components?.map((entry) => entry.name)).toEqual([
      'runtime-app',
      'runtime-state',
      'context-service',
      'graph-store',
    ]);
    expect(state.info.components?.[1]?.schema_version).toBe('1');
  });

  it('stamps the document with the handshake time, in the contract Timestamp shape', async () => {
    const state = await module.handshake({ fetch: answering(contextServiceInfo()).fetch });
    if (!state.ready) throw new Error('expected ready');

    expect(state.info.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('is ready, with no reasons and no degradations', async () => {
    const state = await module.handshake({ fetch: answering(contextServiceInfo()).fetch });

    expect(module.readiness(state)).toEqual({ status: 'ready', reasons: [] });
  });
});

describe('a peer that disagrees fails closed', () => {
  const failuresFor = async (peer: Record<string, unknown>): Promise<HandshakeFailure[]> => {
    const state = await module.handshake({ fetch: answering(peer).fetch });
    if (state.ready) throw new Error(`the handshake accepted ${JSON.stringify(peer)}`);
    return state.failures;
  };

  it.each([
    ['a contract major this app does not speak', { contract_version: '2.0.0' }, 'contract_mismatch', 'contract_major_mismatch'],
    ['another graph schema', { graph_schema_version: '2' }, 'contract_mismatch', 'graph_schema_mismatch'],
    ['another audit schema', { audit_schema_version: '2' }, 'contract_mismatch', 'audit_schema_mismatch'],
    // §9.1: context-service reports only itself. A peer claiming to be the runtime app
    // is a wiring mistake, and aggregating it would publish a document with two runtimes.
    ['a peer that is not context-service', { service: 'runtime-app' }, 'contract_mismatch', 'context_service_identity'],
  ])('refuses %s', async (_label, peer, code, reason) => {
    const [failure] = await failuresFor(contextServiceInfo(peer));

    expect(failure?.code).toBe(code);
    expect(failure?.reason).toBe(reason);
  });

  it.each([
    ['a missing document field', { limits: undefined }],
    ['a component the schema does not name', { components: [{ name: 'semantica', version: '1.0.0', contract_version: '1.4.0', status: 'ready' }] }],
    ['a backend outside the schema enums', { backend: { graph: 'bedrock', audit: 'sqlite' } }],
    ['no capabilities at all', { capabilities: [] }],
  ])('refuses %s as a contract mismatch', async (_label, peer) => {
    const [failure] = await failuresFor(contextServiceInfo(peer));

    expect(failure?.code).toBe('contract_mismatch');
    expect(failure?.reason).toBe('runtime_info_invalid');
  });

  it('refuses a peer that reports a component only the runtime may report', async () => {
    // §9.1: context-service reports only itself. A `runtime-app` in its component list is
    // a peer claiming to be the runtime, and aggregating it would publish a second one.
    const [failure] = await failuresFor(
      contextServiceInfo({
        components: [
          { name: 'context-service', version: '0.1.0', contract_version: lock.runtime.contractVersion, status: 'ready' },
          { name: 'runtime-app', version: '1.0.0', contract_version: lock.runtime.contractVersion, status: 'ready' },
        ],
      }),
    );

    expect(failure?.code).toBe('contract_mismatch');
    expect(failure?.reason).toBe('context_service_identity');
    expect(failure?.details['claimed']).toEqual(['runtime-app']);
  });

  it('counts the aggregate it will really build when bounding `components`', async () => {
    const component = (name: string) => ({
      name,
      version: '1.0.0',
      contract_version: lock.runtime.contractVersion,
      status: 'ready',
    });

    // A peer that names itself: two entries of ours plus its eight is exactly the cap.
    const named = Array.from({ length: module.MAX_COMPONENTS - 2 }, (_, index) =>
      component(index === 0 ? 'context-service' : 'graph-store'),
    );
    const namedState = await module.handshake({ fetch: answering(contextServiceInfo({ components: named })).fetch });
    expect(namedState.ready).toBe(true);
    if (namedState.ready) {
      expect(namedState.info.components).toHaveLength(module.MAX_COMPONENTS);
      expect(module.ownComponentCount(contextServiceInfo({ components: named }) as unknown as RuntimeInfo)).toBe(2);
    }

    // A peer that does not: the aggregate would add a third of ours, so eight overflows.
    const unnamed = Array.from({ length: module.MAX_COMPONENTS - 2 }, () => component('graph-store'));
    const [failure] = await failuresFor(contextServiceInfo({ components: unnamed }));

    expect(failure?.reason).toBe('runtime_info_invalid');
    expect(failure?.details).toEqual({ reported: unnamed.length, own: 3, max: module.MAX_COMPONENTS });
  });

  it('refuses more components than the aggregate can carry', async () => {
    const components = Array.from({ length: module.MAX_COMPONENTS - module.OWN_COMPONENTS + 1 }, () => ({
      name: 'graph-store',
      version: '1.0.0',
      contract_version: lock.runtime.contractVersion,
      status: 'ready',
    }));
    const [failure] = await failuresFor(contextServiceInfo({ components }));

    expect(failure?.reason).toBe('runtime_info_invalid');
    expect(failure?.details).toEqual({
      reported: components.length,
      own: module.OWN_COMPONENTS,
      max: module.MAX_COMPONENTS,
    });
  });

  it('is unavailable, not mismatched, when context-service does not answer', async () => {
    const failing = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;

    const state = await module.handshake({ fetch: failing });
    if (state.ready) throw new Error('expected not ready');

    expect(state.failure.code).toBe('unavailable');
    expect(state.failure.reason).toBe('context_service_unreachable');
    expect(state.failure.message).toContain('ECONNREFUSED');
  });

  it('is unavailable when context-service is up but not serving yet (5xx)', async () => {
    const state = await module.handshake({ fetch: answering({ error: 'not ready' }, { status: 503 }).fetch });
    if (state.ready) throw new Error('expected not ready');

    expect(state.failure.code).toBe('unavailable');
    expect(state.failure.reason).toBe('context_service_unreachable');
    expect(state.failure.details).toEqual({ url: 'http://context-service:8011/v1/runtime-info', status: 503 });
  });

  it('is a contract mismatch when context-service does not serve the route (4xx)', async () => {
    // A peer that answers 404 is up and refusing it: the two sides disagree about what
    // `runtime-info` is, which is not a transient condition a client should retry.
    const state = await module.handshake({ fetch: answering({ error: 'not found' }, { status: 404 }).fetch });
    if (state.ready) throw new Error('expected not ready');

    expect(state.failure.code).toBe('contract_mismatch');
    expect(state.failure.reason).toBe('runtime_info_missing');
    expect(state.failure.details).toEqual({ url: 'http://context-service:8011/v1/runtime-info', status: 404 });
  });

  it('is a contract mismatch when the answer is not JSON', async () => {
    const html = (async () => new Response('<html>proxy error</html>', { status: 200 })) as unknown as typeof fetch;
    const state = await module.handshake({ fetch: html });
    if (state.ready) throw new Error('expected not ready');

    expect(state.failure.code).toBe('contract_mismatch');
    expect(state.failure.reason).toBe('runtime_info_invalid');
  });

  it('reports `/readyz` reasons that name the code, so a probe log and the envelope agree', async () => {
    const state = await module.handshake({ fetch: answering(contextServiceInfo({ contract_version: '2.0.0' })).fetch });
    const report = module.readiness(state);

    expect(report.status).toBe('not_ready');
    expect(report.reasons.length).toBeGreaterThan(0);
    expect(report.reasons.every((reason) => reason.startsWith('contract_mismatch: '))).toBe(true);
  });
});

describe('a build that is not the one the lock describes fails closed', () => {
  const failuresOf = (build: BuildBlocks): HandshakeFailure[] => module.verifyBuild(build);

  const reasons = (build: BuildBlocks): string[] => failuresOf(build).map((failure) => failure.reason);

  it('accepts the blocks this tree carries', () => {
    expect(module.verifyBuild()).toEqual([]);
  });

  it('refuses a descriptor whose Profile digest is not the pinned one', () => {
    const build = mutation((draft) => {
      draft.runtime['profile_digest'] = `sha256:${'0'.repeat(64)}`;
    });

    expect(reasons(build)).toContain('runtime_profile_mismatch');
    expect(failuresOf(build).every((failure) => failure.code === 'runtime_capability_mismatch')).toBe(true);
  });

  it('refuses a Profile artifact that is not the one the app reports', () => {
    const build = mutation((draft) => {
      draft.profile['digest'] = `sha256:${'1'.repeat(64)}`;
    });

    expect(reasons(build)).toContain('runtime_profile_mismatch');
  });

  it.each([
    ['runtime version', (draft: BuildBlocks) => (draft.runtime['version'] = '9.9.9'), 'runtime_version_mismatch'],
    ['runtime family', (draft: BuildBlocks) => (draft.runtime['family'] = 'langgraph'), 'runtime_family_mismatch'],
    ['runtime language', (draft: BuildBlocks) => (draft.runtime['language'] = 'python'), 'runtime_language_mismatch'],
    ['generator version', (draft: BuildBlocks) => (draft.runtime['generator_version'] = '0.0.1'), 'runtime_generator_mismatch'],
    ['topology', (draft: BuildBlocks) => (draft.runtime['topology'] = 'merged-container'), 'runtime_topology_mismatch'],
  ])('refuses a %s that is not the locked one', (_label, change, reason) => {
    expect(reasons(mutation(change))).toContain(reason);
  });

  it('refuses a state store the Environment did not select, or one the tree does not implement', () => {
    const wrongSelection = mutation((draft) => {
      draft.runtime['state_store'] = 'postgres';
    });
    const wrongImplementation = mutation((draft) => {
      draft.environment['stateStoreKind'] = 'libsql';
    });

    expect(reasons(wrongSelection)).toContain('runtime_state_store_mismatch');
    expect(reasons(wrongImplementation)).toContain('runtime_state_store_mismatch');
  });

  it('refuses a state schema the Environment did not pin', () => {
    const build = mutation((draft) => {
      draft.environment['stateStoreSchemaVersion'] = '2';
    });

    expect(reasons(build)).toContain('runtime_state_store_mismatch');
  });

  it('refuses a contract major the Profile does not speak', () => {
    const build = mutation((draft) => {
      draft.profile['contractVersion'] = '2.0.0';
    });
    const failures = failuresOf(build);

    expect(failures.map((failure) => failure.reason)).toEqual(['contract_major_mismatch']);
    expect(failures[0]?.code).toBe('contract_mismatch');
  });

  it('refuses a `must` capability the Profile does not declare at all', () => {
    const build = mutation((draft) => {
      delete draft.details['extensions'];
    });
    const [failure] = failuresOf(build);

    expect(failure?.reason).toBe('runtime_capability_missing');
    expect(failure?.details['capability']).toBe('extensions');
  });

  it('refuses a `must` capability the Profile declares as none, or as degraded', () => {
    const missing = mutation((draft) => {
      draft.details['stateStore'] = { support: 'none' };
    });
    const degraded = mutation((draft) => {
      draft.details['streaming'] = { support: 'degraded', limitations: ['token streaming unverified'] };
    });

    expect(reasons(missing)).toContain('runtime_capability_missing');
    expect(reasons(degraded)).toContain('runtime_capability_degraded');
    expect(failuresOf(degraded)[0]?.details['limitations']).toEqual(['token streaming unverified']);
  });

  it('refuses licensing that an offline target cannot honour', () => {
    const egress = mutation((draft) => {
      draft.runtime['licensing'] = { ...draft.runtime['licensing'], egress: true };
    });
    const keyed = mutation((draft) => {
      draft.runtime['licensing'] = { ...draft.runtime['licensing'], requiresLicenseKey: true };
      draft.environment['offlineTarget'] = true;
    });

    expect(reasons(egress)).toContain('runtime_license_blocked');
    expect(reasons(keyed)).toContain('runtime_license_blocked');
  });

  it('serves degraded, not failed, when only a `should` is missing', async () => {
    const build = mutation((draft) => {
      draft.details['observability'] = { support: 'degraded', limitations: ['otel-only path unverified'] };
    });
    const state = await module.handshake({ build, fetch: answering(contextServiceInfo()).fetch });

    expect(state.ready).toBe(true);
    expect(module.readiness(state)).toEqual({
      status: 'degraded',
      reasons: ['observability is degraded, which build:observability only asks for'],
    });
  });

  it('never contacts context-service when the build itself is wrong', async () => {
    const peer = answering(contextServiceInfo());
    const build = mutation((draft) => {
      draft.runtime['version'] = '9.9.9';
    });

    const state = await module.handshake({ build, fetch: peer.fetch });

    expect(state.ready).toBe(false);
    expect(peer.urls).toEqual([]);
  });
});

describe('the contract the app carries is not re-typed by hand', () => {
  it('finds the Profile the lock pins in the example documents', () => {
    // The fixture is the lock's own pin, parsed back: if `spec lock` and this module
    // disagree, the descriptor's digest check is asserting the wrong thing.
    const reparsed = parseRuntimeProfile(readYaml(paths.exampleRuntimeProfile));
    const relocked = parseSolutionLock(readYaml(paths.exampleLock));

    expect(reparsed.ok && relocked.ok).toBe(true);
    expect(module.PROFILE_IDENTITY['ref']).toBe(`${profile.metadata.name}@${profile.metadata.version}`);
    expect(module.SERVICE_VERSION).toBe(profile.spec.generator.version);
    expect(module.GENERATOR_IDENTITY).toEqual({ family: 'mastra', language: 'typescript', version: module.SERVICE_VERSION });
    expect(lock.runtime.profile).toContain(lockedDigest());
  });
});
