// Seam: the CLI itself — usage errors, exit codes, help and JSON output.
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

describe('fde CLI', () => {
  it('prints usage for --help and exits 0', async () => {
    const sb = fresh();
    const result = await sb.run(['--help']);

    expect(result.code).toBe(0);
    expect(result.out).toMatch(/fde spec init/);
    expect(result.out).toMatch(/fde spec validate/);
    expect(result.out).toMatch(/fde spec lock/);
  });

  it('exits 2 with usage for an unknown command', async () => {
    const sb = fresh();
    const result = await sb.run(['spec', 'frobnicate']);

    expect(result.code).toBe(2);
    expect(result.err).toMatch(/unknown command/i);
    expect(result.err).toMatch(/fde spec/);
  });

  it('exits 2 with usage for a missing required flag', async () => {
    const sb = fresh();
    const result = await sb.run(['spec', 'lock']);

    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--spec/);
  });

  it('exits 2 with usage for an unknown flag', async () => {
    const sb = fresh();
    const result = await sb.run(['spec', 'validate', '--spec', sb.specDir, '--force']);

    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--force/);
  });

  it('prints machine-readable diagnostics with --json', async () => {
    const sb = fresh();
    const result = await sb.run(['spec', 'validate', '--spec', sb.specDir, '--workspace', sb.workspace, '--json']);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.out) as {
      command: string;
      ok: boolean;
      errors: unknown[];
      warnings: Array<{ code: string; remediation?: string }>;
    };
    expect(report.command).toBe('spec validate');
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.map((warning) => warning.code)).toEqual(['builtin_tool_field']);
  });

  it('prints diagnostics as text with a remediation line', async () => {
    const sb = fresh();
    const result = await sb.run(['spec', 'validate', '--spec', sb.specDir, '--workspace', sb.workspace]);

    expect(result.code).toBe(0);
    expect(result.err).toMatch(/warning\[builtin_tool_field\]/);
    expect(result.err).toMatch(/remediation:/);
  });
});
