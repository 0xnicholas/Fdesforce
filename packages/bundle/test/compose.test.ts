// Seam: `renderCompose` — a `BundleTopology` plus one deployment id becomes the
// single-node Compose file the customer runs (`docs/runtime-adapter.md` §8.1,
// `docs/runtime-contract.md` §9).
//
// The tests read the rendered YAML back, not the renderer's internals: what matters
// is the manifest the customer's `docker compose up` sees. Startup gating, network
// placement, published ports, volume names and secret handling are all asserted
// through the document.
import { describe, expect, it } from 'vitest';

import { parse as parseYaml } from 'yaml';

import type { BundleTopology } from '@fde/spec';

import { deployment, bundleTopology, DEPLOYMENT_ID } from './support/fixtures.js';
import { COMPOSE_PATH, renderCompose } from '../src/index.js';

type Compose = Record<string, any>; // the manifest is the assertion surface

const rendered = (topology: BundleTopology = bundleTopology(), deploymentId = DEPLOYMENT_ID) => {
  const result = renderCompose(topology, deployment(topology, deploymentId));
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result;
};

const compose = (topology: BundleTopology = bundleTopology()): Compose =>
  parseYaml(rendered(topology).file.content) as Compose;

const services = (topology: BundleTopology = bundleTopology()): Compose => compose(topology)['services'] as Compose;

const service = (name: string, topology: BundleTopology = bundleTopology()): Compose =>
  services(topology)[`fde-dep-01arz3ndektsv4rrffq69g5fav-${name}`] as Compose;

describe('the rendered file', () => {
  it('is a Compose file at the path the bundle carries it under', () => {
    expect(rendered().file.path).toBe(COMPOSE_PATH);
    expect(COMPOSE_PATH).toBe('deploy/compose.yaml');
    expect(() => parseYaml(rendered().file.content)).not.toThrow();
  });

  it('is deterministic: one topology and one deployment id render the same bytes', () => {
    expect(rendered().file.content).toBe(rendered().file.content);
  });

  it('names the project after the deployment, so two deployments are two stacks', () => {
    expect(compose()['name']).toBe('fde-dep-01arz3ndektsv4rrffq69g5fav');
  });

  it('carries the provenance an operator needs to say what is running', () => {
    expect(compose()['x-fde-bundle']).toEqual({
      solution: 'claims-triage',
      revision: 1,
      deployment_id: DEPLOYMENT_ID,
      profile: 'mastra-1.83-node22@1.0.0',
      profile_digest: bundleTopology().metadata.profileDigest,
    });
  });

  it('renders a service for every component and every job, and nothing else', () => {
    expect(Object.keys(services()).sort()).toEqual([
      'fde-dep-01arz3ndektsv4rrffq69g5fav-context-service',
      'fde-dep-01arz3ndektsv4rrffq69g5fav-ingest',
      'fde-dep-01arz3ndektsv4rrffq69g5fav-mastra-app',
      'fde-dep-01arz3ndektsv4rrffq69g5fav-migrate',
      'fde-dep-01arz3ndektsv4rrffq69g5fav-runtime-migrate',
    ]);
  });
});

describe('the split topology in Compose terms', () => {
  it('publishes the runtime app on the derived host port and on loopback only', () => {
    expect(service('mastra-app')['ports']).toEqual(['127.0.0.1:35312:4111']);
  });

  it('publishes no port for context-service', () => {
    expect(service('context-service')['ports']).toBeUndefined();
  });

  it('keeps context-service off the one network that leaves the bundle', () => {
    // `bundle` is internal: nothing on it is reachable from the host. `edge` is the
    // rendered topology's single non-internal network, and only the ingress component
    // joins it — that is what "context-service is bundle-internal" means in Compose.
    expect(Object.keys(service('context-service')['networks'] as Compose)).toEqual(['bundle']);
    expect(Object.keys(service('mastra-app')['networks'] as Compose).sort()).toEqual(['bundle', 'edge']);
    expect((compose()['networks'] as Compose)['bundle']).toEqual({
      name: 'fde-dep-01arz3ndektsv4rrffq69g5fav-bundle',
      internal: true,
    });
    expect((compose()['networks'] as Compose)['edge']).toEqual({
      name: 'fde-dep-01arz3ndektsv4rrffq69g5fav-edge',
      internal: false,
    });
  });

  it('aliases every service by its topology name, so bundle-internal URLs survive the prefix', () => {
    // The generated app addresses `http://context-service:8011` (a constant in the
    // emitted config). The deployment name is `fde-<id>-context-service`, so without
    // the alias every Run would fail to resolve its own context service.
    expect((service('context-service')['networks'] as Compose)['bundle']).toEqual({
      aliases: ['context-service'],
    });
  });

  it('declares the three volumes with their deployment-derived names, so a backup finds them', () => {
    const volumes = compose()['volumes'] as Compose;

    expect(Object.keys(volumes).sort()).toEqual(['audit', 'graph', 'mastra-state']);
    expect(volumes['audit']).toEqual({ name: 'fde-dep-01arz3ndektsv4rrffq69g5fav-audit' });
    expect(volumes['graph']).toEqual({ name: 'fde-dep-01arz3ndektsv4rrffq69g5fav-graph' });
    expect(volumes['mastra-state']).toEqual({ name: 'fde-dep-01arz3ndektsv4rrffq69g5fav-mastra-state' });
    expect(service('context-service')['volumes']).toEqual(['graph:/data/graph', 'audit:/data/audit']);
  });
});

describe('startup gating', () => {
  it('waits for the platform migration to complete before context-service starts', () => {
    expect(service('context-service')['depends_on']).toEqual({
      'fde-dep-01arz3ndektsv4rrffq69g5fav-migrate': { condition: 'service_completed_successfully' },
    });
  });

  it('waits for context-service to be healthy before the app starts', () => {
    // Readiness, not start: the app's first act is a handshake (§9.3).
    expect(service('mastra-app')['depends_on']).toEqual({
      'fde-dep-01arz3ndektsv4rrffq69g5fav-runtime-migrate': { condition: 'service_completed_successfully' },
      'fde-dep-01arz3ndektsv4rrffq69g5fav-context-service': { condition: 'service_healthy' },
    });
  });

  it('runs ingest after the service it calls, without gating the app on it', () => {
    expect(service('ingest')['depends_on']).toEqual({
      'fde-dep-01arz3ndektsv4rrffq69g5fav-migrate': { condition: 'service_completed_successfully' },
      'fde-dep-01arz3ndektsv4rrffq69g5fav-context-service': { condition: 'service_healthy' },
    });
    expect(service('mastra-app')['depends_on']).not.toHaveProperty('fde-dep-01arz3ndektsv4rrffq69g5fav-ingest');
  });

  it('runs the one-shot jobs once and the services until stopped', () => {
    for (const job of ['migrate', 'ingest', 'runtime-migrate']) {
      expect(service(job)['restart'], job).toBe('no');
    }
    for (const longRunning of ['context-service', 'mastra-app']) {
      expect(service(longRunning)['restart'], longRunning).toBe('unless-stopped');
    }
  });

  it('renders one container per service, with no replica knob to disagree with the single writer', () => {
    // The embedded graph and the SQLite state store are single-writer stores; a Compose
    // `deploy.replicas`/`scale` would be a second writer, not capacity (§9.4). The
    // topology has no replica field at all, and the renderer must not invent one.
    for (const name of Object.keys(services())) {
      expect(services()[name]['deploy'], name).toBeUndefined();
      expect(services()[name]['scale'], name).toBeUndefined();
    }
  });

  it('spells the job restart policy so a YAML 1.1 reader does not see a boolean', () => {
    // Unquoted `no` is `false` to every YAML 1.1 parser; Compose is not the only
    // reader of this file. Read it the way an older tool would.
    const manifest = parseYaml(rendered().file.content, { version: '1.1' }) as Compose;

    expect(manifest['services']['fde-dep-01arz3ndektsv4rrffq69g5fav-migrate']['restart']).toBe('no');
  });

  it('turns the topology health check into the probe Compose runs in the container', () => {
    expect(service('mastra-app')['healthcheck']).toEqual({
      test: [
        'CMD',
        'node',
        '-e',
        "fetch('http://127.0.0.1:4111/readyz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))",
      ],
    });
    expect(service('ingest')['healthcheck']).toBeUndefined();
  });
});

describe('which image a service runs', () => {
  it('builds the runtime app from its own tree and the jobs from the service they maintain', () => {
    // A job does not carry an image of its own: it runs in the image of the service it
    // maintains, so one digest bump moves the service and its migrations together.
    expect(service('mastra-app')['build']).toEqual({ context: '../mastra-app', dockerfile: 'Dockerfile' });
    expect(service('migrate')['build']).toEqual({ context: '../context-service', dockerfile: 'Dockerfile' });
    expect(service('ingest')['build']).toEqual({ context: '../context-service', dockerfile: 'Dockerfile' });
    expect(service('runtime-migrate')['build']).toEqual({ context: '../mastra-app', dockerfile: 'Dockerfile' });
  });

  it('pins a component that already names its image by reference', () => {
    const topology = bundleTopology();
    const contextService = topology.spec.components.find((component) => component.name === 'context-service');
    if (contextService !== undefined) contextService.image = { image: 'ghcr.io/acme/fde-context-service@sha256:abc' };

    expect(service('context-service', topology)['image']).toBe('ghcr.io/acme/fde-context-service@sha256:abc');
    expect(service('context-service', topology)['build']).toBeUndefined();
  });
});

describe('resources', () => {
  it('renders the documented envelope in the units Compose accepts', () => {
    // §9.4: context-service 0.5 CPU / 1 GiB, the app 1 CPU / 1 GiB. `m`/`g` are
    // powers of 1024 in Compose, so this is the same envelope, not a rounding.
    expect(service('context-service')['cpus']).toBe('0.5');
    expect(service('context-service')['mem_limit']).toBe('1g');
    expect(service('mastra-app')['cpus']).toBe('1');
    expect(service('mastra-app')['mem_limit']).toBe('1g');
  });
});

describe('configuration and secrets', () => {
  it('injects configuration as environment variables', () => {
    expect(service('mastra-app')['environment']).toEqual({
      FDE_SIGNING_KEY_FILE: '/run/secrets/execution-context-signing-key',
      FDE_STATE_STORE_PATH: '/app/state/mastra.db',
      NODE_ENV: 'production',
    });
    expect(service('migrate')['environment']).toEqual({
      GRAPH_PATH: '/data/graph/graph.json',
      AUDIT_PATH: '/data/audit/audit.sqlite',
    });
  });

  it('resolves a secret binding to a required install-time variable, never a value', () => {
    expect(service('context-service')['environment']).toEqual({
      GRAPH_BACKEND: 'embedded',
      GRAPH_PATH: '/data/graph/graph.json',
      AUDIT_PATH: '/data/audit/audit.sqlite',
      EXECUTION_CONTEXT_PUBLIC_KEY: '${EXECUTION_CONTEXT_PUBLIC_KEY:?}',
      FDE_JOBS_PUBLIC_KEY: '${FDE_JOBS_PUBLIC_KEY:?}',
    });
  });

  it('mounts a file binding from an install-time path instead of inlining the secret', () => {
    const manifest = compose();
    expect((manifest['secrets'] as Compose)['fde-jobs-signing-key']).toEqual({
      file: '${FDE_JOBS_SIGNING_KEY_FILE:?}',
    });
    expect(service('ingest')['secrets']).toEqual([
      { source: 'fde-jobs-signing-key', target: '/run/secrets/fde-jobs-signing-key' },
    ]);
  });

  it('gives each issuer key to the component that needs it and nobody else', () => {
    // §5.4: the app signs with its own private key and context-service only ever
    // verifies; the jobs private key stays in the maintenance container. A mount on
    // the wrong service is a key where it cannot be used and must not be.
    const manifest = compose();

    expect((manifest['secrets'] as Compose)['execution-context-signing-key']).toEqual({
      file: '${EXECUTION_CONTEXT_SIGNING_KEY_FILE:?}',
    });
    expect(service('mastra-app')['secrets']).toEqual([
      { source: 'execution-context-signing-key', target: '/run/secrets/execution-context-signing-key' },
    ]);
    expect(service('context-service')['secrets']).toBeUndefined();
    expect(service('mastra-app')['environment']).not.toHaveProperty('FDE_JOBS_SIGNING_KEY_FILE');
  });

  it('carries no secret value: the manifest mentions neither the store nor the key', () => {
    const { file } = rendered();

    expect(file.content).not.toContain('fde/jobs/signing-key');
    expect(file.content).not.toContain('fde/jobs/public-key');
    expect(file.content).not.toContain('fde/execution-context-public-key');
    expect(file.content).not.toContain('fde/execution-context-signing-key');
    expect(file.content).not.toContain('customer:');
  });
});

describe('what the renderer refuses to guess', () => {
  it('refuses a job with more than one step, instead of inventing a shell pipeline', () => {
    const topology = bundleTopology();
    topology.spec.jobs[0]?.steps.push({ id: 'second', command: ['python', '-m', 'app.migrate.again'] });

    const result = renderCompose(topology, deployment(topology, DEPLOYMENT_ID));

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.map((error) => error.code)).toContain('renderer_multistep_job');
  });

  it('refuses a job with no component image to run in', () => {
    const topology = bundleTopology();
    const job = topology.spec.jobs[0];
    if (job !== undefined) job.owner = 'platform';

    const result = renderCompose(topology, deployment(topology, DEPLOYMENT_ID));

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.map((error) => error.code)).toContain('renderer_job_image_missing');
  });

  it('refuses a health check without the exec probe a health gate needs', () => {
    const topology = bundleTopology();
    const contextService = topology.spec.components.find((component) => component.name === 'context-service');
    if (contextService?.healthCheck !== undefined) delete contextService.healthCheck.command;

    const result = renderCompose(topology, deployment(topology, DEPLOYMENT_ID));

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.map((error) => error.code)).toContain('renderer_probe_missing');
  });
});

describe('the Acme pair', () => {
  it('composes and renders with nothing left to warn about', () => {
    expect(rendered().warnings).toEqual([]);
  });
});
