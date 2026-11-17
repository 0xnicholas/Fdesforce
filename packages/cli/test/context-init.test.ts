// Seam: `fde context init` — scaffold a draft package.
//
// The scaffold is deliberately *not* modelled: no ontology module, no source, no
// mapping, no eval question. So the acceptance test is a pair — `validate` accepts
// it (it is a well-formed draft) and `freeze` refuses it (a draft is not a release,
// and a package nothing measured cannot be frozen).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const scaffold = async (sb: Sandbox, out = join(sb.root, 'acme-claims-context')) => {
  const result = await sb.run([
    'context',
    'init',
    '--customer',
    'acme',
    '--name',
    'acme-claims-context',
    '--out',
    out,
    '--workspace',
    sb.workspace,
  ]);
  return { result, out };
};

/** Give the scaffolded eval suite the one golden question a freeze gate needs. */
function addQuestion(out: string): void {
  const path = join(out, 'evals/acme-claims-context.golden.yaml');
  const suite = parseYaml(readFileSync(path, 'utf8')) as { spec: { questions: unknown[] } };
  suite.spec.questions.push({
    id: 'q1',
    question: 'What is the premium customer refund policy?',
    input: { query: 'refund policy for a premium customer' },
    expectedEntities: [],
    requiredCitations: [],
  });
  writeFileSync(path, stringifyYaml(suite, { lineWidth: 0 }));
}

describe('fde context init', () => {
  it('scaffolds the package documents a CCP is made of', async () => {
    const sb = fresh();
    const { result, out } = await scaffold(sb);

    expect(result.code, result.err).toBe(0);
    expect(readdirSync(out).sort()).toEqual([
      'evals',
      'manifest.yaml',
      'permissions.yaml',
      'recipes',
      'semantic-model.yaml',
    ]);
    expect(readdirSync(join(out, 'recipes'))).toEqual(['acme-claims-context.yaml']);
    expect(readdirSync(join(out, 'evals'))).toEqual(['acme-claims-context.golden.yaml']);
    expect(sb.run(['--help'])).toBeDefined();
  });

  it('writes a draft whose compatibility comes from the pinned toolchain', async () => {
    const sb = fresh();
    const { out } = await scaffold(sb);

    const manifest = (await import('yaml')).parse(
      (await import('node:fs')).readFileSync(join(out, 'manifest.yaml'), 'utf8'),
    ) as { metadata: { status: string; customer: string }; spec: { compatibility: Record<string, unknown> } };

    expect(manifest.metadata.status).toBe('draft');
    expect(manifest.metadata.customer).toBe('acme');
    expect(manifest.spec.compatibility).toEqual({
      specMajor: 'v0',
      runtimeContract: 'fde.runtime/v1',
      graphSchema: 1,
      auditSchema: 1,
    });
  });

  it('produces a package that validates, with the eval gate still open', async () => {
    const sb = fresh();
    const { out } = await scaffold(sb);

    const result = await sb.run(['context', 'validate', '--package', out, '--workspace', sb.workspace]);

    expect(result.code, result.err).toBe(0);
    expect(result.out).toMatch(/ok \(1 warning\)/);
    expect(result.err).toMatch(/context_eval_missing/);
  });

  it('refuses to freeze a package nothing measured', async () => {
    const sb = fresh();
    const { out } = await scaffold(sb);

    const result = await sb.run([
      'context',
      'freeze',
      '--package',
      out,
      '--actor',
      'fde://acme/fde-lead',
      '--workspace',
      sb.workspace,
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_eval_missing/);
    expect(sb.exists(join(out, 'revisions/0.1.0.yaml'))).toBe(false);
  });

  it('refuses to freeze a draft even once it has a golden question', async () => {
    const sb = fresh();
    const { out } = await scaffold(sb);
    addQuestion(out);

    const result = await sb.run([
      'context',
      'freeze',
      '--package',
      out,
      '--actor',
      'fde://acme/fde-lead',
      '--workspace',
      sb.workspace,
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_package_not_validated/);
    expect(result.err).toMatch(/status: validated/);
  });

  it('refuses a non-empty --out instead of overwriting a package', async () => {
    const sb = fresh();
    const first = await scaffold(sb);
    expect(first.result.code).toBe(0);

    const second = await scaffold(sb);

    expect(second.result.code).toBe(1);
    expect(second.result.err).toMatch(/output_not_empty/);
  });

  it('prints a machine-readable summary with --json', async () => {
    const sb = fresh();
    const result = await sb.run([
      'context',
      'init',
      '--customer',
      'acme',
      '--name',
      'acme-claims-context',
      '--out',
      join(sb.root, 'pkg'),
      '--workspace',
      sb.workspace,
      '--json',
    ]);

    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(result.out) as { command: string; ok: boolean; package: string; files: string[] };
    expect(report.command).toBe('context init');
    expect(report.ok).toBe(true);
    expect(report.package).toBe('acme/acme-claims-context@0.1.0');
    expect(report.files).toContain('manifest.yaml');
  });

  it('rejects a malformed --version before writing anything', async () => {
    const sb = fresh();
    const result = await sb.run([
      'context',
      'init',
      '--customer',
      'acme',
      '--name',
      'pkg',
      '--out',
      join(sb.root, 'pkg'),
      '--version',
      'v1',
      '--workspace',
      sb.workspace,
    ]);

    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--version/);
    expect(sb.exists('pkg')).toBe(false);
  });
});
