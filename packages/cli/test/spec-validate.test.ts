// Seam: `fde spec validate` — one pass over schema, cross-document references,
// grammar and artifact resolution; every error is reported, each with a
// remediation (#25 acceptance criterion 2).
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { parse, stringify } from 'yaml';
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

const specPath = (sb: Sandbox): string => join(sb.specDir, 'solution.yaml');

const loadSpec = (sb: Sandbox): Loose => parse(readFileSync(specPath(sb), 'utf8')) as Loose;

const saveSpec = (sb: Sandbox, spec: Loose): void => {
  sb.write('examples/spec/acme/claims-triage/solution.yaml', stringify(spec));
};

describe('fde spec validate', () => {
  it('passes the checked-in Acme Spec and shows the one known warning', async () => {
    const sb = fresh();
    const result = await sb.run(['spec', 'validate', '--workspace', sb.workspace, '--spec', sb.specDir]);

    expect(result.code, result.err).toBe(0);
    expect(result.out).toMatch(/ok/i);
    expect(result.err).toMatch(/builtin_tool_field/);
  });

  it('reports schema, artifact and predicate errors in a single run', async () => {
    const sb = fresh();
    const spec = loadSpec(sb);
    spec.spec.capabilities['document-triage'].template = 'ghost-capability@^1.0.0';
    spec.spec.workflows['document-triage-flow'].steps.push(
      {
        id: 'approval',
        type: 'approval',
        gates: 'commit',
        approverRoles: ['approver'],
        expiresAfter: 'PT24H',
        evidenceFrom: ['context'],
        requiredWhen: { predicate: 'pii-redaction@^1.0.0' },
      },
      { id: 'commit', type: 'tool', tool: 'claims-lookup' },
    );
    saveSpec(sb, spec);

    const result = await sb.run(['spec', 'validate', '--workspace', sb.workspace, '--spec', sb.specDir]);

    expect(result.code).toBe(1);
    // Schema: a platform role cannot be granted as a business approver.
    expect(result.err).toMatch(/solution_spec_invalid/);
    expect(result.err).toMatch(/approverRoles\[0\]/);
    expect(result.err).toMatch(/business roles are Customer-defined/);
    // Resolution: the capability template is not vendored.
    expect(result.err).toMatch(/template_missing/);
    expect(result.err).toMatch(/ghost-capability/);
    expect(result.err).toMatch(/vendor/);
    // Grammar: the bound Policy declares no predicate.
    expect(result.err).toMatch(/predicate_unknown/);
    expect(result.err).toMatch(/pii-redaction/);
  });

  it('reports reference and grammar errors together on a parseable document', async () => {
    const sb = fresh();
    const spec = loadSpec(sb);
    spec.spec.workflows['document-triage-flow'].steps[1].agent = 'ghost-agent';
    spec.spec.tools['claims-lookup'].operation = 'deleteClaim';
    spec.spec.tools['claim-decision'] = {
      connectorRef: 'claims-db',
      operation: 'recordDecision',
      sideEffects: 'write',
      audit: { classification: 'confidential', retentionClass: 'standard' },
      rateLimit: { perRunMax: 10, perActorPerHourMax: 30 },
    };
    spec.spec.workflows['document-triage-flow'].steps.push(
      {
        id: 'approval',
        type: 'approval',
        gates: 'commit',
        approverRoles: ['claims-supervisor'],
        expiresAfter: 'PT24H',
        evidenceFrom: ['context'],
        requiredWhen: { predicate: 'data-retention@^2.0.0' },
      },
      { id: 'commit', type: 'tool', tool: 'claim-decision' },
    );
    saveSpec(sb, spec);

    const result = await sb.run(['spec', 'validate', '--workspace', sb.workspace, '--spec', sb.specDir]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/unresolved_reference/);
    expect(result.err).toMatch(/ghost-agent/);
    expect(result.err).toMatch(/connector_operation_not_allowed/);
    expect(result.err).toMatch(/deleteClaim/);
    expect(result.err).toMatch(/predicate_unknown/);
    expect(result.err).toMatch(/data-retention/);
  });

  it('fails when the lock is missing and says how to create it', async () => {
    const sb = fresh();
    rmSync(join(sb.specDir, 'solution.lock'));

    const result = await sb.run(['spec', 'validate', '--workspace', sb.workspace, '--spec', sb.specDir]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/solution_lock_missing/);
    expect(result.err).toMatch(/fde spec lock/);
  });

  it('fails when a referenced Spec file drifts after locking', async () => {
    const sb = fresh();
    sb.write(
      'examples/spec/acme/claims-triage/files/prompts/triage.md',
      `${sb.read('examples/spec/acme/claims-triage/files/prompts/triage.md')}\nExtra rule.\n`,
    );

    const result = await sb.run(['spec', 'validate', '--workspace', sb.workspace, '--spec', sb.specDir]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/lock_digest_mismatch/);
    expect(result.err).toMatch(/fde spec lock/);
  });

  it('fails when a Spec file is a symlink outside the Solution', async () => {
    const sb = fresh();
    const { symlinkSync, writeFileSync } = await import('node:fs');
    writeFileSync(join(sb.root, 'outside-secret.md'), 'not part of the Solution');
    symlinkSync(join(sb.root, 'outside-secret.md'), join(sb.specDir, 'files/prompts/leaked.md'));

    const result = await sb.run(['spec', 'validate', '--workspace', sb.workspace, '--spec', sb.specDir]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/spec_file_invalid/);
    expect(result.err).toMatch(/symlink/);
    expect(result.err).toMatch(/files\/prompts\/leaked\.md/);
  });

  it('still fails when a referenced Spec file is missing', async () => {
    const sb = fresh();
    rmSync(join(sb.specDir, 'files/prompts/triage.md'));

    const result = await sb.run(['spec', 'validate', '--workspace', sb.workspace, '--spec', sb.specDir]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/spec_file_missing/);
    expect(result.err).toMatch(/files\/prompts\/triage\.md/);
  });

  it('emits machine-readable diagnostics for a missing Spec directory', async () => {
    const sb = fresh();
    const result = await sb.run([
      'spec',
      'validate',
      '--workspace',
      sb.workspace,
      '--spec',
      join(sb.root, 'no-such-solution'),
      '--json',
    ]);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.out) as { ok: boolean; errors: Array<{ code: string }> };
    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toContain('spec_missing');
  });

  it('keeps working against the checked-in example from the repo root', async () => {
    const sb = fresh();
    const result = await sb.run(
      ['spec', 'validate', '--workspace', sb.workspace, '--spec', sb.specDir, '--json'],
      sb.root,
    );

    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(result.out) as { command: string; ok: boolean; errors: unknown[]; warnings: unknown[] };
    expect(report.command).toBe('spec validate');
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.length).toBe(1);
  });

});
