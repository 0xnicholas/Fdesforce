// Seam: `mastraGenerator.generateTopology` — the runtime-owned topology fragment.
//
// The generator declares only what it owns: the runtime app, its state store
// volume and its migration job (`docs/runtime-adapter.md` §8.1, §12.2). The
// platform composes context-service, the graph/audit volumes and the ingest job
// around this fragment (#32), so the fragment must be schema-valid on its own and
// must not invent platform-owned components.
//
// The fragment is also where the deployment's shape is fixed: the port the app
// listens on, the volume it persists to, the job that runs before it, and the
// startup order. Every one of those is a value the app or the renderer relies on,
// so the tests assert them against the same constants `generateApp` uses.
import { describe, expect, it } from 'vitest';

import { RuntimeTopologySchema, checkTopology } from '@fde/spec';

import { digestOf } from '@fde/spec';

import { mastraGenerator } from '../src/index.js';
import { generateInput } from './support/fixtures.js';

const topology = () => mastraGenerator.generateTopology(generateInput());
const spec = () => topology().spec;

describe('the runtime topology fragment', () => {
  it('validates against the topology schema', () => {
    expect(() => RuntimeTopologySchema.parse(topology())).not.toThrow();
  });

  it('is pinned to the same Profile identity the lock and the app carry', () => {
    const input = generateInput();
    const { metadata } = topology();

    expect(metadata.profile).toBe(`${input.profile.metadata.name}@${input.profile.metadata.version}`);
    expect(metadata.profileDigest).toBe(digestOf(input.profile));
    expect(metadata.generatorVersion).toBe(input.profile.spec.generator.version);
  });
});

describe('the runtime app component', () => {
  it('declares exactly one runtime app, built from the generated tree', () => {
    const components = spec().components;

    expect(components.map((component) => component.name)).toEqual(['mastra-app']);
    expect(components[0]?.role).toBe('runtime-app');
    expect(components[0]?.image).toEqual({ build: { context: 'mastra-app', dockerfile: 'Dockerfile' } });
  });

  it('exposes the app port to the ingress and nothing else', () => {
    const app = mastraGenerator.generateApp(generateInput());
    const [component] = spec().components;

    expect(component?.ports).toEqual([{ name: 'http', containerPort: 4111, expose: true }]);
    // The app component and the topology are two views of one port; a drift here
    // renders an ingress nobody listens on.
    expect(component?.ports).toEqual(app.components[0]?.ports);
  });

  it('mounts its own state volume and lets the app find it', () => {
    const [component] = spec().components;

    expect(component?.volumes).toEqual([{ name: 'mastra-state', mountPath: '/app/state' }]);
    expect(component?.env).toContainEqual({ name: 'FDE_STATE_STORE_PATH', value: '/app/state/mastra.db' });
  });

  it('depends on the platform-owned context-service, the only cross-language seam', () => {
    expect(spec().components[0]?.dependsOn).toEqual(['context-service']);
  });

  it('declares a health check that the generated entrypoint actually serves', () => {
    const app = mastraGenerator.generateApp(generateInput());
    const [component] = spec().components;

    // Readiness, not liveness: a container that is alive but failed the startup
    // handshake must not be sent traffic (§9.3). And the path is the one the emitted
    // router actually serves, not one the topology invented.
    expect(component?.healthCheck).toEqual({
      path: '/readyz',
      port: 4111,
      command: [
        'node',
        '-e',
        "fetch('http://127.0.0.1:4111/readyz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))",
      ],
    });
    const router = app.files.find((entry) => entry.path === 'mastra-app/src/runtime/router.ts')?.content ?? '';
    expect(router).toContain(`export const READY_PATH = '${component?.healthCheck?.path}';`);
    expect(router).toContain("export const LIVENESS_PATH = '/healthz';");
    expect(router).toContain('export const RUNS_PATH');
  });

  it('probes the readiness path on the port the app listens on, in the app\'s own runtime', () => {
    // The probe is exec form run inside the container, so it can only use what the
    // image has: a Node entrypoint and the port the topology declares. A probe that
    // names another runtime or another port is a container that never turns healthy,
    // which turns the whole startup order into a timeout.
    const command = spec().components[0]?.healthCheck?.command ?? [];

    expect(command[0]).toBe('node');
    expect(command[1]).toBe('-e');
    expect(command.slice(2).join(' ')).toContain('http://127.0.0.1:4111/readyz');
  });

  it('reserves the resource envelope the contract states for the runtime app', () => {
    expect(spec().components[0]?.resources).toEqual({ cpu: '1', memory: '1Gi' });
  });

  it('claims the app signing key as a mounted secret and tells the app where it is', () => {
    // §5.4: the private half is the app's alone. The topology claims it and mounts
    // it; the app is told the path, never the key. `fde install keys` (#34) is what
    // puts a key at that path, and the context-service half gets only the public key.
    const [component] = spec().components;

    expect(component?.secretRefs).toEqual([{ store: 'customer', key: 'fde/execution-context-signing-key' }]);
    expect(component?.env).toContainEqual({ name: 'FDE_SIGNING_KEY_FILE', value: '/run/secrets/execution-context-signing-key' });
    expect(spec().secretBindings).toEqual([
      {
        secretRef: { store: 'customer', key: 'fde/execution-context-signing-key' },
        target: 'file',
        name: '/run/secrets/execution-context-signing-key',
        required: true,
      },
    ]);
  });

  it('mounts the signing key nowhere else', () => {
    // The migration job shares the app's image but not its identity: a key in a
    // one-shot job is a private key with no reason to leave the app.
    const job = spec().jobs[0];

    expect(job?.secretRefs).toBeUndefined();
    expect(job?.steps[0]?.secretRefs).toBeUndefined();
  });

  it('refuses to render an identity setting from Environment values', () => {
    // `Environment.values` becomes topology `env`, and the topology is a signed
    // artifact. A signing key or a subject list there is a key or a subject list in
    // the Bundle, which §5.4 forbids — so the build stops instead of shipping it.
    for (const name of ['FDE_SIGNING_KEY', 'FDE_SIGNING_KEY_FILE', 'FDE_IDENTITY_CONFIG', 'FDE_IDENTITY_CONFIG_JSON']) {
      const input = generateInput();
      input.environment = { ...input.environment, values: { [name]: 'value' } };

      expect(() => mastraGenerator.generateTopology(input), name).toThrow(/injected at deploy time/);
    }

    const input = generateInput();
    input.environment = { ...input.environment, values: { FDE_DEPLOYMENT_ID: 'dep_01ARZ3NDEKTSV4RRFFQ69G5FAV' } };
    expect(() => mastraGenerator.generateTopology(input)).toThrow(/FDE_DEPLOYMENT_ID/);
  });

  it('bakes the Environment values, sorted, as non-secret configuration', () => {
    const input = generateInput();
    input.environment = { ...input.environment, values: { FDE_LOG_LEVEL: 'info', FDE_REGION: 'eu-west-1' } };

    const env = mastraGenerator.generateTopology(input).spec.components[0]?.env ?? [];

    expect(env).toEqual([
      { name: 'FDE_LOG_LEVEL', value: 'info' },
      { name: 'FDE_REGION', value: 'eu-west-1' },
      { name: 'FDE_SIGNING_KEY_FILE', value: '/run/secrets/execution-context-signing-key' },
      { name: 'FDE_STATE_STORE_PATH', value: '/app/state/mastra.db' },
      { name: 'NODE_ENV', value: 'production' },
    ]);
  });
});

describe('the state volume and the migration job', () => {
  it('declares a backed-up runtime state volume, separate from graph and audit', () => {
    expect(spec().volumes).toEqual([
      {
        name: 'mastra-state',
        backup: true,
        description: expect.stringMatching(/Run registry/),
      },
    ]);
  });

  it('runs the state migration before the app starts', () => {
    const jobs = spec().jobs;

    expect(jobs.map((job) => job.name)).toEqual(['runtime-migrate']);
    expect(jobs[0]?.owner).toBe('runtime');
    expect(jobs[0]?.steps.map((step) => step.id)).toEqual(['runtime-state']);
    expect(jobs[0]?.steps[0]?.runBefore).toEqual(['mastra-app']);
    expect(jobs[0]?.volumes).toEqual([{ name: 'mastra-state', mountPath: '/app/state' }]);
  });

  it('runs the migration entrypoint the generated tree ships', () => {
    const generated = mastraGenerator.generateApp(generateInput());
    const command = spec().jobs[0]?.steps[0]?.command ?? [];

    expect(command).toEqual(['node', '--experimental-strip-types', 'src/migrate.ts']);
    expect(generated.files.map((entry) => entry.path)).toContain('mastra-app/src/migrate.ts');
    expect(generated.entrypoint).toEqual(['node', '--experimental-strip-types', 'src/index.ts']);
  });

  it('migrates the state store the app opens, not whatever the image defaults to', () => {
    // The job and the app must agree on the file: a migration that created its schema
    // in `./state/mastra.db` while the app opens `/app/state/mastra.db` is a deployment
    // that starts and then fails every Run.
    const appStorePath = spec().components[0]?.env?.find((entry) => entry.name === 'FDE_STATE_STORE_PATH');

    expect(spec().jobs[0]?.env).toEqual([appStorePath]);
    expect(appStorePath).toEqual({ name: 'FDE_STATE_STORE_PATH', value: '/app/state/mastra.db' });
  });

  it('puts the job first in the startup order', () => {
    expect(spec().startupOrder).toEqual(['runtime-migrate', 'mastra-app']);
  });

  it('leaves the ingress host and the platform-owned secrets to the platform', () => {
    // The app's own signing key is the one secret the runtime owns; context-service's
    // public keys and the jobs key are the platform fragment's (#32).
    expect(spec().secretBindings.map((binding) => binding.name)).toEqual(['/run/secrets/execution-context-signing-key']);
    expect(spec().deploymentNaming).toEqual({
      componentNameTemplate: 'fde-{{deployment_id}}-{{component}}',
      namespaceTemplate: 'fde-{{deployment_id}}',
    });
  });
});

describe('what the fragment deliberately leaves out', () => {
  it('reports only the platform-owned gap: context-service and its dependency edge', () => {
    const report = checkTopology(topology());

    // The composed BundleTopology is #32's; the fragment is complete for the
    // components the generator owns, and every remaining complaint is the one the
    // platform fragment answers.
    expect(report.errors.map((error) => error.code).sort()).toEqual([
      'topology_context_service_missing',
      'topology_reference_missing',
    ]);
    expect(report.warnings).toEqual([]);
  });
});

describe('the fragment is deterministic', () => {
  it('is byte-identical for the same input', () => {
    expect(JSON.stringify(mastraGenerator.generateTopology(generateInput()))).toBe(
      JSON.stringify(mastraGenerator.generateTopology(generateInput())),
    );
  });
});
