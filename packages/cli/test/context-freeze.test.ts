// Seam: `fde context freeze` — the content-addressed, immutable revision
// (#31 acceptance criterion 1).
//
// Three properties carry the criterion, and each is a test: the recorded digest is
// the package content digest (and the same value `solution.lock` pins), re-freezing
// unchanged content changes nothing, and changing content at a frozen version is
// refused. The status flip is tested through the author's own file, comments and all,
// because freeze is the only command that edits a document.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

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

const PACKAGE = 'examples/semantic/acme';

const freeze = (sb: Sandbox, extra: string[] = []) =>
  sb.run(['context', 'freeze', '--package', sb.contextPackage, '--actor', 'fde://acme/fde-lead', '--workspace', sb.workspace, ...extra]);

const revision = (sb: Sandbox, version = '1.0.0'): Record<string, any> =>
  parseYaml(sb.read(`${PACKAGE}/revisions/${version}.yaml`)) as Record<string, any>;

describe('fde context freeze', () => {
  it('re-freezes unchanged content as a no-op', async () => {
    const sb = fresh();
    const before = sb.read(`${PACKAGE}/revisions/1.0.0.yaml`);

    const result = await freeze(sb);

    expect(result.code, result.err).toBe(0);
    expect(result.out).toMatch(/already frozen/);
    expect(sb.read(`${PACKAGE}/revisions/1.0.0.yaml`)).toBe(before);
  });

  it('records the digest the lock pins, so one value names the artifact everywhere', async () => {
    const sb = fresh();
    rmSync(join(sb.contextPackage, 'revisions/1.0.0.yaml'));

    const result = await freeze(sb, ['--json']);

    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(result.out) as { status: string; digest: string; revision: string };
    expect(report.status).toBe('frozen');
    expect(report.revision).toBe('revisions/1.0.0.yaml');

    const lock = parseYaml(sb.read('examples/spec/acme/claims-triage/solution.lock')) as Record<string, any>;
    expect(lock['assets']['customerContextPackage']['acme-claims-context']).toBe(`1.0.0@${report.digest}`);
    expect(revision(sb)['spec']['digest']).toBe(report.digest);
  });

  it('lists every content file but the revisions themselves', async () => {
    const sb = fresh();
    const files = Object.keys(revision(sb)['spec']['files'] as Record<string, string>);

    expect(files).toContain('manifest.yaml');
    expect(files).toContain('recipes/claims-context.yaml');
    expect(files).toContain('mappings/claims-db-customers.yaml');
    expect(files.some((path) => path.startsWith('revisions/'))).toBe(false);
  });

  it('refuses to rewrite a frozen version whose content moved', async () => {
    const sb = fresh();
    sb.write(`${PACKAGE}/recipes/claims-context.yaml`, `${sb.read(`${PACKAGE}/recipes/claims-context.yaml`)}\n# moved\n`);

    const result = await freeze(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_package_modified/);
    expect(result.err).toMatch(/recipes\/claims-context\.yaml/);
    expect(result.err).toMatch(/bump metadata\.version/);
    // The recorded revision is untouched: refusing means not writing.
    expect(revision(sb)['spec']['digest']).not.toBe('');
  });

  it('freezes a new version alongside the old one, leaving the old record alone', async () => {
    const sb = fresh();
    const before = sb.read(`${PACKAGE}/revisions/1.0.0.yaml`);
    // A version bump moves every document that names a version, which is exactly
    // the drift `validate` refuses to let through.
    const setVersion = (path: string, change: (document: Record<string, any>) => void): void => {
      const document = parseYaml(sb.read(`${PACKAGE}/${path}`)) as Record<string, any>;
      document['metadata']['version'] = '1.1.0';
      change(document);
      sb.write(`${PACKAGE}/${path}`, stringifyYaml(document, { lineWidth: 0 }));
    };
    setVersion('manifest.yaml', () => undefined);
    setVersion('semantic-model.yaml', () => undefined);
    setVersion('recipes/claims-context.yaml', (document) => {
      document['spec']['semanticModelRef'] = 'acme-claims@1.1.0';
    });
    setVersion('evals/claims-context.golden.yaml', (document) => {
      document['spec']['recipeRef'] = 'claims-context@1.1.0';
    });

    const result = await freeze(sb);

    expect(result.code, result.err).toBe(0);
    expect(revision(sb, '1.1.0')['metadata']['version']).toBe('1.1.0');
    expect(sb.read(`${PACKAGE}/revisions/1.0.0.yaml`)).toBe(before);
  });

  it('flips metadata.status to frozen and keeps the author comments', async () => {
    const sb = fresh();
    rmSync(join(sb.contextPackage, 'revisions/1.0.0.yaml'));
    const manifest = parseYaml(sb.read(`${PACKAGE}/manifest.yaml`)) as Record<string, any>;
    manifest['metadata']['status'] = 'validated';
    const withComment = `# Acme Claims Context Package — signed off by the claims ops owner.\n${stringifyYaml(manifest, { lineWidth: 0 })}`;
    sb.write(`${PACKAGE}/manifest.yaml`, withComment);

    const result = await freeze(sb);

    expect(result.code, result.err).toBe(0);
    const written = sb.read(`${PACKAGE}/manifest.yaml`);
    expect(written).toMatch(/signed off by the claims ops owner/);
    expect((parseYaml(written) as Record<string, any>)['metadata']['status']).toBe('frozen');
    // The digest describes the frozen manifest, not the draft it replaced.
    const validate = await sb.run(['context', 'validate', '--package', sb.contextPackage, '--workspace', sb.workspace]);
    expect(validate.code, validate.err).toBe(0);
  });

  it('records the source commit and the actor it was given', async () => {
    const sb = fresh();
    rmSync(join(sb.contextPackage, 'revisions/1.0.0.yaml'));

    const result = await freeze(sb, ['--source-commit', 'a'.repeat(40)]);

    expect(result.code, result.err).toBe(0);
    expect(revision(sb)['spec']['sourceCommit']).toBe('a'.repeat(40));
    expect(revision(sb)['spec']['frozenBy']).toBe('fde://acme/fde-lead');
    expect(revision(sb)['spec']['frozenAt']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses to freeze a package that does not validate', async () => {
    const sb = fresh();
    rmSync(join(sb.contextPackage, 'revisions/1.0.0.yaml'));
    sb.write(`${PACKAGE}/recipes/claims-context.yaml`, sb.read(`${PACKAGE}/recipes/claims-context.yaml`).replace('type: mask', 'type: masking'));

    const result = await freeze(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_recipe_invalid/);
    expect(existsSync(join(sb.contextPackage, 'revisions/1.0.0.yaml'))).toBe(false);
  });

  it('requires --actor, because a freeze is a sign-off', async () => {
    const sb = fresh();
    const result = await sb.run(['context', 'freeze', '--package', sb.contextPackage]);

    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--actor/);
  });

  it('rejects a source commit that is not a commit id', async () => {
    const sb = fresh();
    const result = await freeze(sb, ['--source-commit', 'HEAD']);

    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--source-commit/);
  });

  it('writes a revision the documented grammar accepts', async () => {
    const sb = fresh();
    const document = revision(sb);

    expect(document['apiVersion']).toBe('fde.dev/v0');
    expect(document['kind']).toBe('ContextPackageRevision');
    expect(document['metadata']).toEqual({ customer: 'acme', name: 'acme-claims-context', version: '1.0.0' });
    expect(readFileSync(join(sb.contextPackage, 'revisions/1.0.0.yaml'), 'utf8')).toMatch(/do not hand-edit/);
  });
});
