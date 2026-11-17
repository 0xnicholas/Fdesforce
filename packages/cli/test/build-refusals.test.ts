// Seam: what `fde build` refuses (#33).
//
// The build is the last place before a bundle is signed and shipped, so each
// refusal here is a boundary the customer's redistribution, reproducibility or
// schema story depends on. The tests drive the public CLI and mutate the
// disposable copy of the reference artifacts — the checked-in example never
// moves.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const buildArgs = (sb: Sandbox, out: string, extra: string[] = []): string[] => [
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
  ...extra,
];

type Loose = Record<string, any>;

const digestOf = (sb: Sandbox, out: string): string => (JSON.parse(sb.read(`${out}/bundle.json`)) as Loose)['digest'];

/** Re-pin the lock after a platform mutation, so the gate is what fails next. */
const relock = async (sb: Sandbox): Promise<void> => {
  const result = await sb.run([
    'spec',
    'lock',
    '--spec',
    sb.specDir,
    '--workspace',
    sb.workspace,
    '--template',
    'fde-solution@1.2.0',
  ]);
  expect(result.code, result.err).toBe(0);
};

describe('build reads the lock, not the ranges', () => {
  it('ignores a newer vendored Runtime Profile that the Spec range would also accept', async () => {
    const sb = fresh();
    const baseline = await sb.run(buildArgs(sb, 'bundle-locked'));
    expect(baseline.code, baseline.err).toBe(0);

    // `mastra-1.83-node22@^1.0.0` would resolve to 1.1.0 if the build re-resolved
    // the Spec's range. The lock pins 1.0.0, so the bundle must not move.
    const profile = parse(sb.read('platform/runtime-profiles/mastra-1.83-node22.yaml')) as Loose;
    profile['metadata']['version'] = '1.1.0';
    profile['spec']['runtimeVersion'] = '1.99.0';
    sb.write('platform/runtime-profiles/mastra-1.83-node22-1.1.0.yaml', stringify(profile));

    const rebuilt = await sb.run(buildArgs(sb, 'bundle-range'));
    expect(rebuilt.code, rebuilt.err).toBe(0);
    expect(digestOf(sb, 'bundle-range')).toBe(digestOf(sb, 'bundle-locked'));
  });

  it('refuses a vendored profile whose bytes moved after the lock', async () => {
    const sb = fresh();
    const profile = parse(sb.read('platform/runtime-profiles/mastra-1.83-node22.yaml')) as Loose;
    profile['spec']['runtimeVersion'] = '1.84.0';
    sb.write('platform/runtime-profiles/mastra-1.83-node22.yaml', stringify(profile));

    const result = await sb.run(buildArgs(sb, 'bundle'));

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/runtime_profile_missing/);
    expect(result.err).toMatch(/solution\.lock pins/);
  });

  it('refuses a pinned Template that moved, even one the generator does not read', async () => {
    const sb = fresh();
    const template = parse(sb.read('platform/templates/capability/document-triage/1.0.0/capability.yaml')) as Loose;
    template['metadata']['description'] = 'changed after the lock';
    sb.write('platform/templates/capability/document-triage/1.0.0/capability.yaml', stringify(template));

    const result = await sb.run(buildArgs(sb, 'bundle'));

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/artifact_digest_mismatch/);
    expect(result.err).toMatch(/Capability Template/);
  });

  it('refuses a Spec file that moved after the lock', async () => {
    const sb = fresh();
    sb.write('examples/spec/acme/claims-triage/files/prompts/triage.md', `${sb.read('examples/spec/acme/claims-triage/files/prompts/triage.md')}\nA new rule.\n`);

    const result = await sb.run(buildArgs(sb, 'bundle'));

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/spec_digest_mismatch/);
  });

  it('does not reach the network', async () => {
    const sb = fresh();
    const fetch = vi.fn(() => {
      throw new Error('the build must not call fetch');
    });
    vi.stubGlobal('fetch', fetch);

    const result = await sb.run(buildArgs(sb, 'bundle'));

    expect(result.code, result.err).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the license gate', () => {
  it('fails closed on a denied license', async () => {
    const sb = fresh();
    const catalog = parse(sb.read('platform/licenses.yaml')) as Loose;
    catalog['spec']['components']['semantica']['license'] = 'GPL-3.0-only';
    sb.write('platform/licenses.yaml', stringify(catalog));
    await relock(sb);

    const result = await sb.run(buildArgs(sb, 'bundle'));

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/license_blocked/);
    expect(result.err).toMatch(/semantica/);
  });

  it('fails closed on a denied license inside an SPDX expression', async () => {
    const sb = fresh();
    const catalog = parse(sb.read('platform/licenses.yaml')) as Loose;
    catalog['spec']['components']['semantica']['license'] = 'MIT AND GPL-3.0-only';
    sb.write('platform/licenses.yaml', stringify(catalog));
    await relock(sb);

    const result = await sb.run(buildArgs(sb, 'bundle'));

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/license_blocked/);
  });

  it('fails closed on an undeclared component', async () => {
    const sb = fresh();
    const catalog = parse(sb.read('platform/licenses.yaml')) as Loose;
    delete catalog['spec']['components']['semantica'];
    sb.write('platform/licenses.yaml', stringify(catalog));
    await relock(sb);

    const result = await sb.run(buildArgs(sb, 'bundle'));

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/license_undeclared/);
  });

  it('bundles Mastra core only', async () => {
    const sb = fresh();
    const profile = parse(sb.read('platform/runtime-profiles/mastra-1.83-node22.yaml')) as Loose;
    profile['spec']['packages']['@mastra/ee'] = '1.83.0';
    sb.write('platform/runtime-profiles/mastra-1.83-node22.yaml', stringify(profile));

    await relock(sb);

    const result = await sb.run(buildArgs(sb, 'bundle'));

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/license_blocked/);
    expect(result.err).toMatch(/@mastra\/ee/);
  });

  it('reports the license verdict even when the catalog moved after the lock', async () => {
    const sb = fresh();
    const catalog = parse(sb.read('platform/licenses.yaml')) as Loose;
    catalog['spec']['components']['semantica']['license'] = 'GPL-3.0-only';
    sb.write('platform/licenses.yaml', stringify(catalog));

    const result = await sb.run(buildArgs(sb, 'bundle'));

    expect(result.code).toBe(1);
    // The gate runs before the address check, so the operator sees why the
    // bundle is not redistributable, not just that the catalog drifted.
    expect(result.err).toMatch(/license_blocked/);
    expect(result.err).toMatch(/license_catalog_mismatch/);
  });

  it('refuses a catalog that moved after the lock', async () => {
    const sb = fresh();
    sb.write('platform/licenses.yaml', `${sb.read('platform/licenses.yaml')}\n# moved\n`);

    const result = await sb.run(buildArgs(sb, 'bundle'));

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/license_catalog_mismatch/);
  });

  it('refuses a context-service fragment that moved after the lock', async () => {
    const sb = fresh();
    // A comment is not identity (`digestOf` over the parsed document), so move a
    // real field: the composed payload would otherwise describe another bundle.
    const fragment = parse(sb.read('platform/context-service/1.1.0/topology.yaml')) as Loose;
    fragment['spec']['components'][0]['env'][0]['value'] = 'changed-after-lock';
    sb.write('platform/context-service/1.1.0/topology.yaml', stringify(fragment));

    const result = await sb.run(buildArgs(sb, 'bundle'));

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/platform_fragment_mismatch/);
  });
});

describe('schema and target refusals', () => {
  it('reports runtime_schema_mismatch when the toolchain compiles another schema', async () => {
    const sb = fresh();
    const toolchain = parse(sb.read('platform/toolchain.yaml')) as Loose;
    toolchain['spec']['schemas']['graph'] = 2;
    sb.write('platform/toolchain.yaml', stringify(toolchain));

    const result = await sb.run(buildArgs(sb, 'bundle'));

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/runtime_schema_mismatch/);
  });

  it('refuses a target v0 does not render', async () => {
    const sb = fresh();
    const result = await sb.run([
      'build',
      '--spec',
      sb.specDir,
      '--out',
      sb.path('bundle'),
      '--target',
      'helm',
      '--deployment',
      DEPLOYMENT_ID,
      '--workspace',
      sb.workspace,
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/build_target_unsupported/);
  });

  it('refuses an Environment the Spec does not declare', async () => {
    const sb = fresh();
    const result = await sb.run(buildArgs(sb, 'bundle').map((arg) => (arg === 'acme-prod' ? 'acme-staging' : arg)));

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/environment_unknown/);
  });
});
