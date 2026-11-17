// Seam: `composeTopology` — the platform's fragment plus the generator's fragment
// become one `BundleTopology` (`docs/runtime-adapter.md` §8.1).
//
// The composed document is what a renderer consumes, so these tests assert the two
// things a renderer needs and neither fragment can answer alone: the split shape
// (one exposed app, one bundle-internal service, three volumes, the jobs in order)
// and the reference integrity that only exists once both halves are present.
import { describe, expect, it } from 'vitest';

import { checkTopology, parseBundleTopology } from '@fde/spec';

import { bundleTopology, compose, platformFragment, runtimeFragment, DEPLOYMENT_ID, deployment } from './support/fixtures.js';

const spec = () => bundleTopology().spec;

describe('the composed bundle', () => {
  it('is a grammar-valid BundleTopology with no invariant left to complain about', () => {
    const composed = compose();
    if (!composed.ok) throw new Error(JSON.stringify(composed.errors, null, 2));

    expect(parseBundleTopology(composed.topology).ok).toBe(true);
    expect(checkTopology(composed.topology).errors).toEqual([]);
    expect(composed.warnings).toEqual([]);
  });

  it('carries the Solution revision and the Profile identity the runtime fragment pinned', () => {
    const runtime = runtimeFragment();

    expect(bundleTopology().metadata).toEqual({
      solution: 'claims-triage',
      revision: 1,
      profile: runtime.metadata.profile,
      profileDigest: runtime.metadata.profileDigest,
    });
  });

  it('composes what the two halves declare, and nothing else', () => {
    const runtime = runtimeFragment();
    const platform = platformFragment();

    expect(spec().components.map((component) => component.name)).toEqual(['context-service', 'mastra-app']);
    expect(spec().jobs.map((job) => job.name)).toEqual(['migrate', 'ingest', 'runtime-migrate']);
    expect(spec().volumes.map((volume) => volume.name)).toEqual(['graph', 'audit', 'mastra-state']);
    expect(spec().secretBindings).toEqual(platform.spec.secretBindings);
    expect(spec().components[1]).toEqual(runtime.spec.components[0]);
  });

  it('is deterministic: the same fragments compose to the same document', () => {
    expect(JSON.stringify(compose())).toBe(JSON.stringify(compose()));
  });
});

describe('the split topology (v0)', () => {
  it('exposes the runtime app and nothing else', () => {
    const exposed = spec().components.flatMap((component) =>
      (component.ports ?? []).filter((port) => port.expose === true).map((port) => `${component.name}:${port.containerPort}`),
    );

    expect(exposed).toEqual(['mastra-app:4111']);
    expect(spec().ingress).toEqual({ component: 'mastra-app', port: 4111 });
  });

  it('keeps context-service on the bundle network, with no port to reach it from outside', () => {
    const contextService = spec().components.find((component) => component.name === 'context-service');

    expect(contextService?.ports).toEqual([{ name: 'internal', containerPort: 8011 }]);
    expect(contextService?.ports?.some((port) => port.expose === true)).toBe(false);
  });

  it('gives the graph, the audit store and the runtime state three volumes, graph and audit distinct', () => {
    const names = spec().volumes.map((volume) => volume.name);

    expect(new Set(names).size).toBe(3);
    expect(names).toContain('graph');
    expect(names).toContain('audit');
    expect(names).toContain('mastra-state');
    // Only the audit store carries the backup marker: graph facts are rebuildable,
    // audit evidence is not (§9.5).
    expect(spec().volumes.filter((volume) => volume.backup === true).map((volume) => volume.name).sort()).toEqual([
      'audit',
      'mastra-state',
    ]);
  });

  it('orders startup platform migration → runtime migration → context-service → app, leaving ingest out', () => {
    // §9.2. Ingest runs after the service is healthy and must not block readiness,
    // which is why it is a job and not a startup step.
    expect(spec().startupOrder).toEqual(['migrate', 'runtime-migrate', 'context-service', 'mastra-app']);
  });

  it('keeps one network pair: an internal bundle network and one ingress/egress network', () => {
    expect(spec().networks).toEqual([
      { name: 'bundle', internal: true },
      { name: 'edge', internal: false },
    ]);
  });
});

describe('reference integrity after composition', () => {
  it('refuses a runtime app whose dependency no fragment provides', () => {
    const platform = platformFragment();
    platform.spec.components = platform.spec.components.filter((component) => component.name !== 'context-service');

    const composed = compose({ platform });

    expect(composed.ok).toBe(false);
    expect(composed.ok ? [] : composed.errors.map((error) => error.code)).toContain('topology_reference_missing');
  });

  it('refuses a fragment pair that declares one volume twice', () => {
    const platform = platformFragment();
    platform.spec.volumes.push({ name: 'mastra-state', size: '10Gi' });

    const composed = compose({ platform });

    expect(composed.ok).toBe(false);
    expect(composed.ok ? [] : composed.errors.map((error) => error.code)).toContain('topology_name_conflict');
  });

  it('refuses a runtime app that exposes two ports, because the ingress has one entry', () => {
    const runtime = runtimeFragment();
    runtime.spec.components[0]?.ports?.push({ name: 'admin', containerPort: 4112, expose: true });

    const composed = compose({ runtime });

    expect(composed.ok).toBe(false);
    expect(composed.ok ? [] : composed.errors.map((error) => error.code)).toContain('topology_exposure_invalid');
  });

  it('refuses a pair with no runtime app at all', () => {
    const runtime = runtimeFragment();
    runtime.spec.components = [];

    const composed = compose({ runtime });

    expect(composed.ok).toBe(false);
  });
});

describe('the composed bundle is deployable', () => {
  it('derives names and a publishable port from one deployment id', () => {
    const instance = deployment(bundleTopology(), DEPLOYMENT_ID);

    expect(instance.services['mastra-app']).toBe('fde-dep-01arz3ndektsv4rrffq69g5fav-mastra-app');
    expect(instance.ingress?.containerPort).toBe(4111);
  });
});
