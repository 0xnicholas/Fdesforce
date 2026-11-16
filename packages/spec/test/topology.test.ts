// Seam: topology invariants (`checkTopology`).
//
// `BundleTopology` is the single deployment-topology source (#17 D7). These are
// the assumptions the Compose/Helm renderers (#32) will make, checked once here:
// reference integrity, one exposed runtime app, startup order, naming, volumes.
import { describe, expect, it } from 'vitest';

import { checkTopology, parseBundleTopology } from '../src/index.js';
import type { BundleTopology, TopologyReport } from '../src/index.js';

type Mutable = Record<string, any>; // test mutations are intentionally loose

const document = (): Record<string, unknown> => ({
  apiVersion: 'fde.dev/v0',
  kind: 'BundleTopology',
  metadata: {
    solution: 'claims-triage',
    revision: 1,
    profile: 'mastra-1.83-node22@1.0.0',
    profileDigest: `sha256:${'a'.repeat(64)}`,
  },
  spec: {
    components: [
      {
        name: 'mastra-app',
        role: 'runtime-app',
        image: { build: { context: 'generated/claims-triage/mastra-app', dockerfile: 'Dockerfile' } },
        ports: [{ name: 'http', containerPort: 4111, expose: true }],
        volumes: [{ name: 'mastra-state', mountPath: '/app/state' }],
        env: [
          { name: 'NODE_ENV', value: 'production' },
          { name: 'CONTEXT_TOKEN', secretRef: { store: 'vault', key: 'mastra-app' } },
        ],
        healthCheck: { path: '/readyz', port: 4111 },
        dependsOn: ['context-service'],
        resources: { cpu: '1', memory: '1Gi' },
      },
      {
        name: 'context-service',
        role: 'context-service',
        image: { image: 'ghcr.io/acme/fde-context-service@sha256:abc' },
        ports: [{ name: 'internal', containerPort: 8011 }],
        volumes: [
          { name: 'graph', mountPath: '/data/graph' },
          { name: 'audit', mountPath: '/data/audit' },
        ],
        dependsOn: ['graph-migrate'],
      },
    ],
    volumes: [
      { name: 'mastra-state', backup: true },
      { name: 'graph', size: '20Gi' },
      { name: 'audit', size: '10Gi', backup: true },
    ],
    jobs: [
      {
        name: 'graph-migrate',
        owner: 'context-service',
        steps: [{ id: 'audit-schema', command: ['python', '-m', 'app.migrate'], runBefore: ['context-service'] }],
      },
      {
        name: 'ingest',
        owner: 'context-service',
        steps: [{ id: 'ingest', command: ['python', '-m', 'app.ingest'], runAfter: ['graph-migrate'] }],
      },
    ],
    startupOrder: ['graph-migrate', 'context-service', 'mastra-app'],
    secretBindings: [
      { secretRef: { store: 'vault', key: 'mastra-app' }, target: 'env', name: 'CONTEXT_TOKEN', required: true },
    ],
    deploymentNaming: {
      componentNameTemplate: 'fde-{{deployment_id}}-{{component}}',
      namespaceTemplate: 'fde-{{deployment_id}}',
    },
    networks: [{ name: 'internal', internal: true }],
    ingress: { component: 'mastra-app', port: 4111, hostTemplate: '{{host}}', tls: true },
  },
});

const topology = (): BundleTopology => {
  const parsed = parseBundleTopology(document());
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
};

const mutate = (change: (document: Mutable) => void): BundleTopology => {
  const copy = document() as Mutable;
  change(copy);
  return topology2(copy);
};

const topology2 = (document: Mutable): BundleTopology => {
  const parsed = parseBundleTopology(document);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
};

const codes = (report: TopologyReport): string[] => report.errors.map((error) => error.code);

const spec = (document: Mutable): Mutable => document['spec'] as Mutable;
const components = (document: Mutable): Mutable[] => spec(document)['components'] as Mutable[];

describe('split topology for the read-only slice', () => {
  it('accepts one runtime app, one context service and ordered jobs', () => {
    const report = checkTopology(topology());

    expect(report.errors, JSON.stringify(report.errors, null, 2)).toEqual([]);
    // `ingest` is deliberately not in the startup order: it must not block readiness.
    expect(report.warnings.map((warning) => warning.code)).toEqual(['topology_startup_order_incomplete']);
  });
});

describe('exposure', () => {
  it('rejects a second runtime app', () => {
    const report = checkTopology(
      mutate((document) => {
        const app = components(document)[0]!;
        components(document).push({ ...app, name: 'mastra-app-2' });
      }),
    );

    expect(codes(report)).toContain('topology_runtime_app_invalid');
  });

  it('rejects exposing context-service to the customer ingress', () => {
    const report = checkTopology(
      mutate((document) => {
        (components(document)[1]!['ports'] as Mutable[])[0]!['expose'] = true;
      }),
    );

    expect(codes(report)).toContain('topology_exposure_invalid');
  });

  it('rejects an ingress that targets something other than the runtime app', () => {
    const report = checkTopology(
      mutate((document) => {
        spec(document)['ingress'] = { component: 'context-service', port: 8011 };
      }),
    );

    expect(codes(report)).toContain('topology_exposure_invalid');
  });

  it('rejects an ingress port the runtime app does not expose', () => {
    const report = checkTopology(
      mutate((document) => {
        spec(document)['ingress'] = { component: 'mastra-app', port: 9999 };
      }),
    );

    expect(codes(report)).toContain('topology_exposure_invalid');
  });
});

describe('reference integrity', () => {
  it('rejects a dependency on an undeclared component or job', () => {
    const report = checkTopology(
      mutate((document) => {
        (components(document)[0]!['dependsOn'] as string[]).push('audit-service');
      }),
    );

    expect(codes(report)).toEqual(['topology_reference_missing']);
  });

  it('rejects a startup order entry that does not exist', () => {
    const report = checkTopology(
      mutate((document) => {
        (spec(document)['startupOrder'] as string[]).push('ingest-2');
      }),
    );

    expect(codes(report)).toEqual(['topology_reference_missing']);
  });

  it('rejects a mount of an undeclared volume', () => {
    const report = checkTopology(
      mutate((document) => {
        (components(document)[1]!['volumes'] as Mutable[]).push({ name: 'cache', mountPath: '/cache' });
      }),
    );

    expect(codes(report)).toEqual(['topology_reference_missing']);
  });

  it('rejects a duplicated component name', () => {
    const report = checkTopology(
      mutate((document) => {
        const service = components(document)[1]!;
        components(document).push({ ...service });
      }),
    );

    expect(codes(report)).toContain('topology_name_conflict');
  });

  it('rejects a job reusing a component name', () => {
    const report = checkTopology(
      mutate((document) => {
        (spec(document)['jobs'] as Mutable[])[1]!['name'] = 'context-service';
      }),
    );

    expect(codes(report)).toContain('topology_name_conflict');
  });

  it('rejects a component that depends on itself', () => {
    const report = checkTopology(
      mutate((document) => {
        (components(document)[0]!['dependsOn'] as string[]).push('mastra-app');
      }),
    );

    expect(codes(report)).toContain('topology_reference_cycle');
  });
});

describe('volumes and naming', () => {
  it('rejects graph and audit sharing one volume', () => {
    const report = checkTopology(
      mutate((document) => {
        components(document).push(
          { name: 'graph-db', role: 'graph-store', image: { image: 'x' }, volumes: [{ name: 'shared', mountPath: '/g' }] },
          { name: 'audit-db', role: 'audit-store', image: { image: 'x' }, volumes: [{ name: 'shared', mountPath: '/a' }] },
        );
        (spec(document)['volumes'] as Mutable[]).push({ name: 'shared' });
        (spec(document)['startupOrder'] as string[]).push('graph-db', 'audit-db');
      }),
    );

    expect(codes(report)).toContain('topology_volume_shared');
  });

  it('rejects names that do not derive from the deployment id', () => {
    const report = checkTopology(
      mutate((document) => {
        spec(document)['deploymentNaming'] = { componentNameTemplate: '{{component}}' };
      }),
    );

    expect(codes(report)).toContain('topology_naming_invalid');
  });

  it('warns about a declared volume nothing mounts', () => {
    const report = checkTopology(
      mutate((document) => {
        (spec(document)['volumes'] as Mutable[]).push({ name: 'spare', size: '1Gi' });
      }),
    );

    expect(report.warnings.map((warning) => warning.code)).toContain('topology_volume_unused');
  });
});
