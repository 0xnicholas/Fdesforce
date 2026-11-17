// Seam: `deploymentInstance` — the one place a `BundleTopology` becomes concrete
// deployment names and ports.
//
// `BundleTopology` says `{{deployment_id}}` and `{{component}}`; a deployment says
// which id. Everything a renderer or an operator needs to name — service names,
// volume names, the ingress host port — is derived here, deterministically, so two
// deployments of the same bundle never collide and the same deployment id always
// renders the same manifest (#32, `docs/runtime-adapter.md` §8.3).
import { describe, expect, it } from 'vitest';

import { bundleTopology, deployment } from './support/fixtures.js';

const instance = () => deployment(bundleTopology(), 'dep_01ARZ3NDEKTSV4RRFFQ69G5FAV');

describe('names derive from the deployment id', () => {
  it('names every component, job and volume through the topology template', () => {
    const rendered = instance();

    expect(rendered.services['mastra-app']).toBe('fde-dep-01arz3ndektsv4rrffq69g5fav-mastra-app');
    expect(rendered.services['context-service']).toBe('fde-dep-01arz3ndektsv4rrffq69g5fav-context-service');
    expect(rendered.services['ingest']).toBe('fde-dep-01arz3ndektsv4rrffq69g5fav-ingest');
    expect(rendered.volumes['graph']).toBe('fde-dep-01arz3ndektsv4rrffq69g5fav-graph');
    expect(rendered.volumes['mastra-state']).toBe('fde-dep-01arz3ndektsv4rrffq69g5fav-mastra-state');
  });

  it('keeps the deployment id inside the name, so two deployments cannot share one', () => {
    const other = deployment(bundleTopology(), 'dep_01BX5ZZKBKACTAV9WEVGEMMVRZ');

    expect(other.services['mastra-app']).not.toBe(instance().services['mastra-app']);
    expect(other.volumes['audit']).not.toBe(instance().volumes['audit']);
  });

  it('carries a project name the whole manifest hangs off', () => {
    expect(instance().project).toBe('fde-dep-01arz3ndektsv4rrffq69g5fav');
  });

  it('sanitizes the deployment id into the lowercase alphabet a Docker name allows', () => {
    // `deployment_id` is `dep_<ULID>`: uppercase, with an underscore. Both are legal
    // in the id and illegal in a Compose/Helm name, so the derivation lowercases and
    // replaces the separator instead of letting the templates do it per call site.
    expect(instance().project).not.toMatch(/[A-Z_]/);
    expect(instance().services['mastra-app']).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('refuses names a renderer could not accept', () => {
    const long = bundleTopology();
    long.spec.components[0]!.name = 'mastra-app-application-server-for-claims-triage-eu-west-1-prod';

    expect(() => deployment(long, 'dep_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toThrow(/too long/);
  });

  it('refuses a deployment id the contract would reject', () => {
    expect(() => deployment(bundleTopology(), 'deployment-1')).toThrow(/dep_<ULID>/);
  });
});

describe('the ingress host port', () => {
  it('is derived from the deployment id, in a range that cannot collide with a container port', () => {
    const { ingress } = instance();

    // 30000 + sha256('dep_01ARZ3NDEKTSV4RRFFQ69G5FAV')[0..4] % 20000, computed
    // outside this codebase.
    expect(ingress?.hostPort).toBe(35312);
    expect(ingress?.containerPort).toBe(4111);
  });

  it('is stable for one deployment and different for the next', () => {
    expect(instance().ingress?.hostPort).toBe(instance().ingress?.hostPort);
    expect(deployment(bundleTopology(), 'dep_01BX5ZZKBKACTAV9WEVGEMMVRZ').ingress?.hostPort).not.toBe(
      instance().ingress?.hostPort,
    );
  });

  it('binds to loopback: the customer terminates TLS in front of the bundle', () => {
    expect(instance().ingress?.hostIp).toBe('127.0.0.1');
  });

  it('publishes nothing when the topology has no ingress', () => {
    const topology = bundleTopology();
    delete topology.spec.ingress;

    expect(deployment(topology, 'dep_01ARZ3NDEKTSV4RRFFQ69G5FAV').ingress).toBeUndefined();
  });
});
