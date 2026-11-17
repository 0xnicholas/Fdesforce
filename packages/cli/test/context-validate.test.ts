// Seam: `fde context validate` — one pass over the CCP's schema, references, recipe
// pipeline, permission baseline and frozen state (#31 acceptance criterion 2).
//
// The mutations below go through the CLI, not the pure function, so what is tested
// is the diagnostic an author actually sees: the code, the document path, and the
// remediation.
import { rmSync } from 'node:fs';
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

type Loose = Record<string, any>;

const PACKAGE = 'examples/semantic/acme';

const validate = (sb: Sandbox, extra: string[] = []) =>
  sb.run(['context', 'validate', '--package', sb.contextPackage, '--workspace', sb.workspace, ...extra]);

const edit = (sb: Sandbox, relative: string, change: (document: Loose) => void): void => {
  const document = parseYaml(sb.read(relative)) as Loose;
  change(document);
  sb.write(relative, stringifyYaml(document, { lineWidth: 0 }));
};

const recipe = (sb: Sandbox, change: (document: Loose) => void): void =>
  edit(sb, `${PACKAGE}/recipes/claims-context.yaml`, change);

describe('fde context validate', () => {
  it('passes the checked-in Acme package with nothing to warn about', async () => {
    const sb = fresh();
    const result = await validate(sb);

    expect(result.code, result.err).toBe(0);
    expect(result.out).toMatch(/ok$/);
    expect(result.err).toBe('');
  });

  it('prints machine-readable diagnostics', async () => {
    const sb = fresh();
    recipe(sb, (document) => {
      document['spec']['stages'] = document['spec']['stages'].filter((stage: Loose) => stage['type'] !== 'mask');
    });

    const result = await validate(sb, ['--json']);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.out) as { command: string; ok: boolean; errors: Array<{ code: string; path: string; remediation?: string }> };
    expect(report.command).toBe('context validate');
    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toContain('context_recipe_invalid');
    expect(report.errors.find((error) => error.code === 'context_recipe_invalid')?.remediation).toMatch(/mask/);
  });

  it('reports a declared document that is not in the package', async () => {
    const sb = fresh();
    edit(sb, `${PACKAGE}/manifest.yaml`, (document) => {
      document['spec']['evals'] = ['evals/claims-context.ghost.yaml'];
    });
    edit(sb, `${PACKAGE}/semantic-model.yaml`, (document) => {
      document['spec']['evals'] = [{ ref: 'evals/claims-context.ghost.yaml' }];
    });

    const result = await validate(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_file_missing/);
    expect(result.err).toMatch(/claims-context\.ghost\.yaml/);
  });

  it('reports a schema error in one document without hiding the rest', async () => {
    const sb = fresh();
    edit(sb, `${PACKAGE}/context-sources/claims-db.yaml`, (document) => {
      delete document['spec']['classification'];
    });
    recipe(sb, (document) => {
      document['spec']['stages'] = [];
    });

    const result = await validate(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_source_invalid/);
    expect(result.err).toMatch(/context_recipe_invalid/);
  });

  it('reports a recipe that names a term no mapping produces, with the fix', async () => {
    const sb = fresh();
    recipe(sb, (document) => {
      const graph = document['spec']['stages'].find((stage: Loose) => stage['type'] === 'graph');
      graph['relations'].push('ic:hasClaim');
    });

    const result = await validate(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_reference_unknown/);
    expect(result.err).toMatch(/ic:hasClaim/);
    expect(result.err).toMatch(/remediation: map the relation/);
  });

  it('reports a permission annotation on a property no mapping declares', async () => {
    const sb = fresh();
    edit(sb, `${PACKAGE}/permissions.yaml`, (document) => {
      document['spec']['properties']['ic:customerPhone'] = { columnMask: 'hash' };
    });

    const result = await validate(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_reference_unknown/);
    expect(result.err).toMatch(/ic:customerPhone/);
    expect(result.err).toMatch(/never applies/);
  });

  it('reports an ontology module that is not vendored', async () => {
    const sb = fresh();
    edit(sb, `${PACKAGE}/semantic-model.yaml`, (document) => {
      document['spec']['ontology']['modules'][0]['ref'] = 'healthcare-claims@1.0.0';
    });

    const result = await validate(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_reference_unknown/);
    expect(result.err).toMatch(/healthcare-claims@1\.0\.0/);
    expect(result.err).toMatch(/platform\/templates\/ontology/);
  });

  it('reports source content that moved after the freeze', async () => {
    const sb = fresh();
    sb.write(`${PACKAGE}/context-sources/claims-db.yaml`, `${sb.read(`${PACKAGE}/context-sources/claims-db.yaml`)}\n# edited after freeze\n`);

    const result = await validate(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_package_modified/);
    expect(result.err).toMatch(/claims-db\.yaml/);
    expect(result.err).toMatch(/bump metadata\.version/);
  });

  it('reports a package that claims to be frozen without a revision', async () => {
    const sb = fresh();
    rmSync(join(sb.contextPackage, 'revisions/1.0.0.yaml'));

    const result = await validate(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_package_not_frozen/);
  });

  it('reports a Context Source whose connector is not vendored in the workspace', async () => {
    const sb = fresh();
    rmSync(join(sb.root, 'examples/spec/acme/customer/connectors/sharepoint-claims.yaml'));

    const result = await validate(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/connector sharepoint-claims is not in the workspace/);
  });

  it('reports a compatibility claim the pinned toolchain does not satisfy', async () => {
    const sb = fresh();
    edit(sb, `${PACKAGE}/manifest.yaml`, (document) => {
      document['spec']['compatibility']['graphSchema'] = 2;
    });

    const result = await validate(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_compatibility_mismatch/);
    expect(result.err).toMatch(/graphSchema/);
  });

  it('ignores hidden files, so a digest does not depend on who checked the package out', async () => {
    const sb = fresh();
    sb.write(`${PACKAGE}/.DS_Store`, 'junk');
    sb.write(`${PACKAGE}/recipes/.gitkeep`, '');

    const result = await validate(sb);

    expect(result.code, result.err).toBe(0);
  });

  it('reports a declared document of the wrong kind as a schema error', async () => {
    const sb = fresh();
    edit(sb, `${PACKAGE}/manifest.yaml`, (document) => {
      document['spec']['permissionsRef'] = 'recipes/claims-context.yaml';
    });
    edit(sb, `${PACKAGE}/semantic-model.yaml`, (document) => {
      document['spec']['permissions']['ref'] = 'recipes/claims-context.yaml';
    });

    const result = await validate(sb);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/permission_profile_invalid/);
  });

  it('reports a package directory that does not exist', async () => {
    const sb = fresh();
    const result = await sb.run(['context', 'validate', '--package', join(sb.root, 'ghost')]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_package_missing/);
  });

  it('rejects an unknown flag with a usage error', async () => {
    const sb = fresh();
    const result = await sb.run(['context', 'validate', '--package', sb.contextPackage, '--force']);

    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--force/);
  });
});
