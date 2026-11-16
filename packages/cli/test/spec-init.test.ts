// Seam: `fde spec init` — materialize a versioned Solution Template into a
// complete, editable Solution directory that validates and locks without hand
// edits (#25 acceptance criterion 1).
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

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

/** Every file under a directory, relative and sorted. */
const tree = (root: string): string[] => {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else entries.push(relative(root, path));
    }
  };
  walk(root);
  return entries.sort();
};

describe('fde spec init', () => {
  it('materializes the Acme read-only Spec from the versioned template', async () => {
    const sb = fresh();
    const out = join(sb.root, 'materialized');
    const result = await sb.run([
      'spec',
      'init',
      '--workspace',
      sb.workspace,
      '--template',
      'fde-solution@1.2.0',
      '--out',
      out,
    ]);

    expect(result.err, result.out).toBe('');
    expect(result.code, result.out).toBe(0);

    // Byte-for-byte: the checked-in example is the materialization, lock included.
    const expected = tree(sb.specDir);
    expect(tree(out).sort()).toEqual(expected);
    for (const file of expected) {
      expect(readFileSync(join(out, file), 'utf8'), file).toBe(
        readFileSync(join(sb.specDir, file), 'utf8'),
      );
    }
  });

  it('writes a lock, so the fresh materialization validates as-is', async () => {
    const sb = fresh();
    const out = join(sb.root, 'materialized');
    await sb.run(['spec', 'init', '--workspace', sb.workspace, '--template', 'fde-solution@1.2.0', '--out', out]);

    const validate = await sb.run(['spec', 'validate', '--workspace', sb.workspace, '--spec', out]);
    expect(validate.code, validate.out).toBe(0);

    const check = await sb.run(['spec', 'lock', '--check', '--workspace', sb.workspace, '--spec', out]);
    expect(check.code, check.out).toBe(0);
  });

  it('records the solution template as lock provenance', async () => {
    const sb = fresh();
    const out = join(sb.root, 'materialized');
    await sb.run(['spec', 'init', '--workspace', sb.workspace, '--template', 'fde-solution@1.2.0', '--out', out]);

    expect(readFileSync(join(out, 'solution.lock'), 'utf8')).toMatch(/fde-solution: 1\.2\.0@sha256:[0-9a-f]{64}/);
  });

  it('refuses to overwrite a non-empty directory', async () => {
    const sb = fresh();
    const out = join(sb.root, 'materialized');
    sb.write('materialized/notes.md', 'hand-written');

    const result = await sb.run([
      'spec',
      'init',
      '--workspace',
      sb.workspace,
      '--template',
      'fde-solution@1.2.0',
      '--out',
      out,
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/output_not_empty/);
    expect(result.err).toMatch(/fde spec init/);
    expect(sb.read('materialized/notes.md')).toBe('hand-written');
  });

  it('fails closed when the template is not vendored', async () => {
    const sb = fresh();
    const out = join(sb.root, 'materialized');

    const result = await sb.run([
      'spec',
      'init',
      '--workspace',
      sb.workspace,
      '--template',
      'no-such-template@^1.0.0',
      '--out',
      out,
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/template_missing/);
    expect(result.err).toMatch(/vendor|platform\/templates/);
    expect(sb.exists('materialized/solution.yaml')).toBe(false);
  });

  it('writes nothing when the materialized tree cannot be locked', async () => {
    const sb = fresh();
    rmSync(sb.path('platform/templates/solution/fde-solution/1.2.0/files/prompts/triage.md'));

    const out = join(sb.root, 'materialized');
    const result = await sb.run([
      'spec',
      'init',
      '--workspace',
      sb.workspace,
      '--template',
      'fde-solution@1.2.0',
      '--out',
      out,
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/spec_file_missing/);
    expect(sb.exists('materialized')).toBe(false);
  });
});
