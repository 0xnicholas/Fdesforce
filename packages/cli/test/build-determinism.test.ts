// Seam: A11 — a bundle's address is a function of its locked inputs, not of when
// it was built or what entropy the process happened to draw (#33).
//
// Two levels are checked here. The CLI level proves the whole command is
// reproducible; the `buildBundle` level injects a clock and a random source so a
// regression that starts reading either one fails even if the wall clock happens
// to be stable in CI.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mastraGenerator } from '@fde/runtime-generator-mastra';
import type { RuntimeGenerator } from '@fde/runtime-generator';
import type { RuntimeTopology } from '@fde/spec';

import { buildBundle, loadLockedBuildInput, type BuildEntropy, type LockedBuildInput } from '../src/index.js';
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
  vi.restoreAllMocks();
});

const buildArgs = (sb: Sandbox, out: string): string[] => [
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

/** The resolved workspace a direct `loadLockedBuildInput` call needs. */
const workspaceOf = (sb: Sandbox) => ({
  root: sb.workspace,
  platformRoot: sb.platform,
  assets: {
    connectors: sb.path('examples/spec/acme/customer/connectors'),
    contextPackages: sb.path('examples/semantic'),
    evalSuites: sb.path('examples/eval'),
    datasets: sb.path('examples/eval'),
  },
});

const lockedInput = (sb: Sandbox): LockedBuildInput => {
  const loaded = loadLockedBuildInput({ specDir: sb.specDir, workspace: workspaceOf(sb), environment: 'acme-prod' });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors, null, 2));
  return loaded.value;
};

const entropy = (iso: string, random: string): BuildEntropy => ({
  now: () => new Date(iso),
  random: () => random,
});

const payload = (result: ReturnType<typeof buildBundle>): Map<string, string> => {
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return new Map(
    result.value.files
      .filter((file) => file.path !== 'bundle.json' && file.path !== 'build-provenance.json' && file.path !== 'sbom/spdx.json')
      .map((file) => [file.path, file.content]),
  );
};

describe('A11 at the CLI seam', () => {
  it('builds the same bundle manifest and payload twice', async () => {
    const sb = fresh();
    const first = await sb.run(buildArgs(sb, 'bundle-a'));
    const second = await sb.run(buildArgs(sb, 'bundle-b'));

    expect(first.code, first.err).toBe(0);
    expect(second.code, second.err).toBe(0);

    // `bundle.json` carries the digest, the file manifest and provenance that is
    // itself deterministic; only the evidence files carry a timestamp.
    expect(sb.read('bundle-b/bundle.json')).toBe(sb.read('bundle-a/bundle.json'));

    for (const path of ['mastra-app/Dockerfile', 'deploy/compose.yaml', 'deploy/bundle-topology.json', 'NOTICE']) {
      expect(sb.read(`bundle-b/${path}`)).toBe(sb.read(`bundle-a/${path}`));
    }
  });
});

describe('A11 with an injected clock and random source', () => {
  it('keeps the digest and the payload while provenance records the clock', () => {
    const sb = fresh();
    const input = lockedInput(sb);

    const first = buildBundle(input, {
      deploymentId: DEPLOYMENT_ID,
      entropy: entropy('2020-01-01T00:00:00.000Z', 'first-entropy'),
    });
    const second = buildBundle(input, {
      deploymentId: DEPLOYMENT_ID,
      entropy: entropy('2031-12-31T23:59:59.000Z', 'second-entropy'),
    });

    if (!first.ok || !second.ok) throw new Error('both builds must succeed');
    expect(first.value.digest).toBe(second.value.digest);
    expect(first.value.sourceDigest).toBe(second.value.sourceDigest);
    expect(payload(first)).toEqual(payload(second));

    // The clock is allowed to reach provenance (and only provenance).
    expect(first.value.provenance.builtAt).toBe('2020-01-01T00:00:00.000Z');
    expect(second.value.provenance.builtAt).toBe('2031-12-31T23:59:59.000Z');
  });

  it('never draws from the injected random source', () => {
    const sb = fresh();
    const random = vi.fn(() => 'drawn');
    const result = buildBundle(lockedInput(sb), {
      deploymentId: DEPLOYMENT_ID,
      entropy: { now: () => new Date('2026-01-01T00:00:00.000Z'), random },
    });

    expect(result.ok, result.ok ? '' : JSON.stringify(result.errors, null, 2)).toBe(true);
    expect(random).not.toHaveBeenCalled();
  });
});

describe('A11 refuses a generator that is not a pure function', () => {
  it('reports runtime_generation_nondeterministic when the second pass differs', () => {
    const sb = fresh();
    let calls = 0;
    const drifting: RuntimeGenerator = {
      ...mastraGenerator,
      generateApp: (input) => {
        calls += 1;
        const app = mastraGenerator.generateApp(input);
        if (calls === 1) return app;
        // A second pass that changes one byte is exactly the regression A11 exists
        // to catch: same inputs, different artifact.
        return {
          ...app,
          files: app.files.map((file, index) =>
            index === 0 ? { ...file, content: `${file.content}\n// drift\n` } : file,
          ),
        };
      },
    };

    const result = buildBundle(lockedInput(sb), { deploymentId: DEPLOYMENT_ID, generator: drifting });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.code)).toContain('runtime_generation_nondeterministic');
    expect(result.errors[0]?.message).toMatch(/mastra-app\//);
  });

  it('reports runtime_manifest_invalid for a topology the schema rejects', () => {
    const sb = fresh();
    const broken: RuntimeGenerator = {
      ...mastraGenerator,
      generateTopology: () =>
        ({
          apiVersion: 'fde.dev/v0',
          kind: 'RuntimeTopology',
          metadata: { profile: 'mastra-1.83-node22@1.0.0', profileDigest: 'sha256:' + 'a'.repeat(64), generatorVersion: '1.0.0' },
          spec: { components: 'not-an-array' },
        }) as unknown as RuntimeTopology,
    };

    const result = buildBundle(lockedInput(sb), { deploymentId: DEPLOYMENT_ID, generator: broken });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.code)).toContain('runtime_manifest_invalid');
  });

  it('reports runtime_manifest_invalid for a tree whose digest does not describe it', () => {
    const sb = fresh();
    const dishonest: RuntimeGenerator = {
      ...mastraGenerator,
      generateApp: (input) => ({
        ...mastraGenerator.generateApp(input),
        sourceDigest: `sha256:${'0'.repeat(64)}` as const,
      }),
    };

    const result = buildBundle(lockedInput(sb), { deploymentId: DEPLOYMENT_ID, generator: dishonest });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.code)).toContain('runtime_manifest_invalid');
  });
});
