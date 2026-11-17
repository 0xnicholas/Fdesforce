// Seam: `fde build --target compose` — one bundle from the locked inputs, in the
// order `docs/runtime-adapter.md` §4.4 fixes (#33).
//
// The build is the highest build-time seam: everything below it (profile
// resolution, capabilities, the gate, generation, topology composition, the
// renderer) is already tested at its own seam. What this file owns is the
// orchestration and the bundle: what is in it, what its digest covers, and which
// inputs the build is allowed to read.
import { existsSync } from 'node:fs';

import { describe, expect, it, afterEach } from 'vitest';

import { makeSandbox, type Sandbox } from './support/sandbox.js';

const DEPLOYMENT_ID = 'dep_01ARZ3NDEKTSV4RRFFQ69G5FAV';

let sandbox: Sandbox | undefined;

const fresh = (): Sandbox => {
  sandbox = makeSandbox();
  return sandbox;
};

afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

const buildArgs = (sb: Sandbox, out = 'bundle'): string[] => [
  'build',
  '--spec',
  sb.specDir,
  '--out',
  sb.path(out),
  '--target',
  'compose',
  '--environment',
  'acme-prod',
  '--deployment',
  DEPLOYMENT_ID,
  '--workspace',
  sb.workspace,
];

interface BundleManifest {
  bundleVersion: number;
  solution: { customer: string; solution: string; environment: string; deploymentId: string };
  sourceDigest: string;
  digest: string;
  artifacts: string[];
  files: Record<string, string>;
  licenseGate: { ok: boolean; components: Array<{ name: string; license: string }> };
}

describe('fde build', () => {
  it('writes the locked app, topology, compose file, migrations, CCP and evidence', async () => {
    const sb = fresh();
    const result = await sb.run(buildArgs(sb));

    expect(result.code, result.err).toBe(0);

    // The generated app is the bundle payload, not a copy of the Spec.
    expect(sb.exists('bundle/mastra-app/Dockerfile')).toBe(true);
    expect(sb.exists('bundle/mastra-app/src/index.ts')).toBe(true);
    expect(sb.exists('bundle/deploy/compose.yaml')).toBe(true);
    expect(sb.exists('bundle/deploy/bundle-topology.json')).toBe(true);
    expect(sb.exists('bundle/deploy/migration-plan.json')).toBe(true);
    // The post-deploy acceptance action ships with the bundle (#34).
    expect(sb.exists('bundle/deploy/smoke.mjs')).toBe(true);
    expect(sb.exists('bundle/contract-tests/fixtures/run-api-parity.json')).toBe(true);
    expect(sb.exists('bundle/sbom/spdx.json')).toBe(true);
    expect(sb.exists('bundle/NOTICE')).toBe(true);
    expect(sb.exists('bundle/build-provenance.json')).toBe(true);
    expect(sb.exists('bundle/bundle.json')).toBe(true);

    // The frozen CCP ships in the bundle with the revision that addresses it.
    expect(sb.exists('bundle/context/acme-claims-context/manifest.yaml')).toBe(true);
    expect(sb.exists('bundle/context/acme-claims-context/revisions/1.0.0.yaml')).toBe(true);

    const manifest = JSON.parse(sb.read('bundle/bundle.json')) as BundleManifest;
    expect(manifest.bundleVersion).toBe(1);
    expect(manifest.solution).toEqual({
      customer: 'acme',
      solution: 'claims-triage',
      environment: 'acme-prod',
      deploymentId: DEPLOYMENT_ID,
      deploymentBound: true,
    });
    expect(manifest.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.artifacts).toEqual(
      [...manifest.artifacts].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    );
    expect(manifest.artifacts).toContain('mastra-app/Dockerfile');
    expect(manifest.artifacts).toContain('deploy/compose.yaml');
    expect(manifest.artifacts).toContain('deploy/smoke.mjs');
    expect(manifest.files['bundle.json']).toBeUndefined();
    expect(manifest.licenseGate.ok).toBe(true);
    expect(manifest.licenseGate.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '@mastra/core', license: 'Apache-2.0' }),
        expect.objectContaining({ name: 'semantica', license: 'MIT' }),
      ]),
    );
  });

  it('builds an unbound bundle before a deployment exists', async () => {
    const sb = fresh();
    const withoutDeployment = buildArgs(sb);
    withoutDeployment.splice(withoutDeployment.indexOf('--deployment'), 2);
    const result = await sb.run(withoutDeployment);

    expect(result.code, result.err).toBe(0);
    const manifest = JSON.parse(sb.read('bundle/bundle.json')) as BundleManifest & {
      solution: { deploymentBound: boolean; deploymentId?: string };
    };
    expect(manifest.solution.deploymentBound).toBe(false);
    expect(manifest.solution.deploymentId).toBeUndefined();
    // The names in the rendered file are the reserved placeholder instance, not
    // a deployment identity the build invented.
    expect(sb.read('bundle/deploy/compose.yaml')).toMatch(/fde-dep-0+-mastra-app/);
  });

  it('reports the bundle in --json output', async () => {
    const sb = fresh();
    const result = await sb.run([...buildArgs(sb), '--json']);

    expect(result.code, result.err).toBe(0);
    const output = JSON.parse(result.out) as {
      command: string;
      ok: boolean;
      bundle: { digest: string; sourceDigest: string; out: string };
      errors: unknown[];
      warnings: unknown[];
    };
    expect(output.command).toBe('build');
    expect(output.ok).toBe(true);
    expect(output.bundle.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(output.bundle.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(output.errors).toEqual([]);
    expect(existsSync(output.bundle.out)).toBe(true);
  });
});
