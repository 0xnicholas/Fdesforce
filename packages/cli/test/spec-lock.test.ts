// Seam: `fde spec lock` / `fde spec lock --check` — the lock is the complete
// build-input manifest, every pin is exact, and any drift fails closed with the
// drifted item named (#25 acceptance criteria 3 and 4).
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse, stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { repoRoot } from './support/sandbox.js';
import { makeSandbox, type Sandbox } from './support/sandbox.js';

let sandbox: Sandbox | undefined;

const fresh = (): Sandbox => {
  sandbox = makeSandbox();
  return sandbox;
};

afterEach(() => {
  sandbox?.cleanup();
  sandbox = undefined;
});

type Loose = Record<string, any>;

const lockPath = (sb: Sandbox): string => join(sb.specDir, 'solution.lock');

const readLock = (sb: Sandbox): Loose => parse(readFileSync(lockPath(sb), 'utf8')) as Loose;

const specs = (sb: Sandbox): string[] => [
  'spec',
  'lock',
  '--workspace',
  sb.workspace,
  '--spec',
  sb.specDir,
  '--template',
  'fde-solution@1.2.0',
];

const pinned = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+@sha256:[a-f0-9]{64}$/.test(value);

describe('fde spec lock', () => {
  it('reproduces the checked-in example lock exactly', async () => {
    const sb = fresh();
    const result = await sb.run(specs(sb));

    expect(result.code, result.err).toBe(0);
    const regenerated = readLock(sb);
    const checkedIn = parse(
      readFileSync(join(repoRoot, 'examples/spec/acme/claims-triage/solution.lock'), 'utf8'),
    ) as Loose;
    expect(regenerated).toEqual(checkedIn);
  });

  it('pins every build input to an exact version and a digest', async () => {
    const sb = fresh();
    await sb.run(specs(sb));
    const lock = readLock(sb);

    // No floating ranges anywhere in the generated lock.
    expect(JSON.stringify(lock)).not.toMatch(/[\^~*]/);

    // Template provenance and every Template category the Spec references.
    expect(pinned(lock.templates.solution['fde-solution'])).toBe(true);
    expect(pinned(lock.templates.capability['document-triage'])).toBe(true);
    expect(pinned(lock.templates.policy['pii-redaction'])).toBe(true);
    expect(pinned(lock.templates.policy['data-retention'])).toBe(true);
    expect(pinned(lock.templates.eval['claims-context'])).toBe(true);
    expect(pinned(lock.templates.ontology['insurance-claims'])).toBe(true);
    expect(pinned(lock.templates.deploymentProfile['standard'])).toBe(true);
    expect(pinned(lock.overlays['acme-baseline'])).toBe(true);
    expect(pinned(lock.overlays['claims-triage-tuning'])).toBe(true);
    expect(pinned(lock.extensions['acme-claims-connector'])).toBe(true);

    // Concrete Customer assets carry a file manifest, not just a version.
    expect(lock.assets.customerContextPackage['acme-claims-context']).toMatch(/^1\.0\.0@sha256:/);
    expect(Object.keys(lock.assets.evalSuites['claims-triage-quality'].files)).toEqual(['eval-suite.yaml']);
    expect(lock.assets.evalSuites['claims-triage-quality'].digest).toBe(
      lock.assets.evalSuites['claims-triage-quality'].files['eval-suite.yaml'],
    );
    expect(Object.keys(lock.assets.connectors['claims-db'].files).sort()).toEqual([
      'claims-db.yaml',
      'contracts/claims-db.md',
    ]);

    // Model Profiles, the Eval Dataset and the runtime/toolchain are build inputs.
    expect(pinned(lock.modelProfiles['standard'])).toBe(true);
    expect(pinned(lock.modelProfiles['standard-fallback'])).toBe(true);
    expect(pinned(lock.evalDatasets['acme-claims-triage'])).toBe(true);
    expect(lock.runtime.profile).toMatch(/^mastra-1\.83-node22@1\.0\.0@sha256:[a-f0-9]{64}$/);
    expect(lock.runtime.mastra).toBe('1.83.0');
    expect(lock.runtime.node).toBe('22.13.0');
    expect(lock.toolchain.image).toMatch(/^ghcr\.io\/fde-workbench\/toolchain@sha256:[a-f0-9]{64}$/);
  });

  it('is idempotent and does not depend on where the Spec lives', async () => {
    const sb = fresh();
    await sb.run(specs(sb));
    const first = readFileSync(lockPath(sb), 'utf8');

    const moved = join(sb.root, 'elsewhere', 'claims-triage');
    mkdirSync(join(moved, '..'), { recursive: true });
    cpSync(sb.specDir, moved, { recursive: true });
    await sb.run(['spec', 'lock', '--workspace', sb.workspace, '--spec', moved]);

    expect(readFileSync(join(moved, 'solution.lock'), 'utf8')).toBe(first);
  });

  it('refuses a toolchain image that already carries a digest', async () => {
    const sb = fresh();
    sb.write(
      'platform/toolchain.yaml',
      sb
        .read('platform/toolchain.yaml')
        .replace('image: ghcr.io/fde-workbench/toolchain', `image: ghcr.io/fde-workbench/toolchain@sha256:${'d'.repeat(64)}`),
    );

    const result = await sb.run(specs(sb));

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/toolchain_invalid/);
    expect(result.err).toMatch(/platform\/toolchain\.yaml/);
  });

  it('fails when a concrete asset points at an unvendored template', async () => {
    const sb = fresh();
    sb.write(
      'examples/eval/acme/eval-suite.yaml',
      sb
        .read('examples/eval/acme/eval-suite.yaml')
        .replace('materializedFrom: eval/triage-quality@1.0.0', 'materializedFrom: eval/missing-template@1.0.0'),
    );

    const result = await sb.run(specs(sb));

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/template_missing/);
    expect(result.err).toMatch(/missing-template/);
  });

  it('records solution-template provenance when asked', async () => {
    const sb = fresh();
    rmSync(lockPath(sb));

    const result = await sb.run([...specs(sb), '--template', 'fde-solution@1.2.0']);

    expect(result.code, result.err).toBe(0);
    expect(readLock(sb).templates.solution['fde-solution']).toMatch(/^1\.2\.0@sha256:/);
  });

  it('refuses to regenerate a lock whose provenance is not restated', async () => {
    const sb = fresh();
    const result = await sb.run(['spec', 'lock', '--workspace', sb.workspace, '--spec', sb.specDir]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/solution_template_unresolved/);
    expect(result.err).toMatch(/--template fde-solution@1\.2\.0/);
  });
});

describe('fde spec lock --check', () => {
  const check = (sb: Sandbox): Promise<{ code: number; out: string; err: string }> =>
    sb.run([...specs(sb), '--check']);

  it('passes on the checked-in example without rewriting it', async () => {
    const sb = fresh();
    const before = readFileSync(lockPath(sb), 'utf8');
    const beforeStat = statSync(lockPath(sb)).mtimeMs;

    const result = await check(sb);

    expect(result.code, result.err).toBe(0);
    expect(result.out).toMatch(/current|ok/i);
    expect(readFileSync(lockPath(sb), 'utf8')).toBe(before);
    expect(statSync(lockPath(sb)).mtimeMs).toBe(beforeStat);
  });

  it('fails when a referenced Spec file drifts and names the file', async () => {
    const sb = fresh();
    sb.write(
      'examples/spec/acme/claims-triage/files/prompts/triage.md',
      `${sb.read('examples/spec/acme/claims-triage/files/prompts/triage.md')}\nAdded rule.\n`,
    );

    const result = await check(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/lock_stale/);
    expect(result.err).toMatch(/spec\.files\.files\/prompts\/triage\.md/);
    expect(result.err).toMatch(/fde spec lock/);
  });

  it('fails when a vendored Template drifts and names the pin', async () => {
    const sb = fresh();
    sb.write(
      'platform/templates/policy/pii-redaction/1.0.0/policy.yaml',
      `${sb.read('platform/templates/policy/pii-redaction/1.0.0/policy.yaml')}\n# drift\n`,
    );

    const result = await check(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/templates\.policy\.pii-redaction/);
  });

  it('fails when the Runtime Profile artifact drifts', async () => {
    const sb = fresh();
    sb.write(
      'platform/runtime-profiles/mastra-1.83-node22.yaml',
      sb
        .read('platform/runtime-profiles/mastra-1.83-node22.yaml')
        .replace('description: Mastra 1.83', 'description: Drifted Mastra 1.83'),
    );

    const result = await check(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/runtime\.profile/);
  });

  it('fails when the toolchain image contents drift', async () => {
    const sb = fresh();
    sb.write('platform/toolchain/Dockerfile', `${sb.read('platform/toolchain/Dockerfile')}\n# drift\n`);

    const result = await check(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/toolchain\.image/);
  });

  it('fails when the lock was hand-edited and names the edited pin', async () => {
    const sb = fresh();
    const lock = readLock(sb);
    lock.modelProfiles['standard'] = '1.1.0@sha256:' + 'a'.repeat(64);
    writeFileSync(lockPath(sb), stringify(lock));

    const result = await check(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/modelProfiles\.standard/);
  });

  it('fails when an extra pin was added by hand', async () => {
    const sb = fresh();
    const lock = readLock(sb);
    lock.templates.eval['unused-suite'] = '9.9.9@sha256:' + 'b'.repeat(64);
    writeFileSync(lockPath(sb), stringify(lock));

    const result = await check(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/templates\.eval\.unused-suite/);
  });

  it('fails when the lock is missing', async () => {
    const sb = fresh();
    rmSync(lockPath(sb));

    const result = await check(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/solution_lock_missing/);
    expect(result.err).toMatch(/fde spec lock/);
  });

  it('fails when the lock lost its materialization provenance', async () => {
    const sb = fresh();
    const lock = readLock(sb);
    delete lock.templates.solution;
    writeFileSync(lockPath(sb), stringify(lock));

    const result = await check(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/templates\.solution\.fde-solution/);
  });

  it('does not fold a floating runtime profile version into the lock', async () => {
    const sb = fresh();
    const lock = readLock(sb);
    // The schema accepts partial versions for compatibility; --check must not.
    lock.runtime.profile = 'mastra-1.83-node22@1@sha256:' + 'c'.repeat(64);
    writeFileSync(lockPath(sb), stringify(lock));

    const result = await check(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/runtime\.profile/);
  });

  it('discovers the workspace by walking up from the Spec directory', async () => {
    const sb = fresh();
    const result = await sb.run(
      ['spec', 'lock', '--check', '--spec', 'claims-triage', '--template', 'fde-solution@1.2.0'],
      sb.workspace,
    );

    expect(result.code, result.err).toBe(0);
  });
});
