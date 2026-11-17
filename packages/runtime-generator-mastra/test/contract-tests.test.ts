// Seam: `mastraGenerator.generateContractTests` — the A-case mapping.
//
// The plan is a mapping, not a runner (`contracts/conformance/adapter-cases.md`):
// each case names a command and the bundle-relative fixtures that command reads.
// The cases listed must be the ones this slice's app can actually satisfy; a plan
// that claimed A3 (HITL) or A4 (record-before-act) would be a conformance claim the
// generated app cannot keep, and `fde verify` would fail on a bundle that is
// correct for the slice it was built from.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { GeneratedFile } from '@fde/runtime-generator';

import { mastraGenerator } from '../src/index.js';
import { generateInput } from './support/fixtures.js';
import { materialize } from './support/generated-app.js';

const plan = () => mastraGenerator.generateContractTests(generateInput());

const file = (files: ReadonlyArray<GeneratedFile>, path: string): GeneratedFile => {
  const found = files.find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error(`${path} was not generated; got:\n${files.map((entry) => entry.path).join('\n')}`);
  return found;
};

describe('the A-case plan', () => {
  it('maps the cases this slice can satisfy: Run API, SSE envelope, identity and determinism', () => {
    expect(plan().cases.map((entry) => [entry.caseId, entry.tier])).toEqual([
      ['A2', 'smoke'],
      ['A5', 'smoke'],
      ['A8', 'smoke'],
      ['A11', 'static'],
    ]);
  });

  it('does not claim cases the slice does not generate', () => {
    const claimed = new Set(plan().cases.map((entry) => entry.caseId));

    // A3/A4 are HITL and record-before-act, A6 restart resume, A7 approval expiry,
    // A9 extension load, A10 offline install, A12 memory; A1's runtime half is the
    // handshake slice (#30).
    for (const caseId of ['A1', 'A3', 'A4', 'A6', 'A7', 'A9', 'A10', 'A12'] as const) {
      expect(claimed.has(caseId)).toBe(false);
    }
  });

  it('runs the HTTP cases through one emitted script, and A8 through the identity one', () => {
    const cases = plan().cases.filter((entry) => entry.tier === 'smoke');

    expect(cases.map((entry) => entry.command)).toEqual([
      ['node', 'contract-tests/run-api-smoke.mjs', '--case', 'A2'],
      ['node', 'contract-tests/run-api-smoke.mjs', '--case', 'A5'],
      ['node', '--experimental-strip-types', 'contract-tests/identity-smoke.mjs'],
    ]);
    expect(cases.map((entry) => entry.fixtures)).toEqual([
      ['contract-tests/fixtures/run-api-parity.json'],
      ['contract-tests/fixtures/run-api-parity.json'],
      [],
    ]);
  });

  it('says which half of A8 the bundle can prove', () => {
    const a8 = plan().cases.find((entry) => entry.caseId === 'A8');

    // Tenant/trace propagation is only half the case: context-service enforcing the
    // tenant and the scopes is the platform's fragment (#32). A plan that claimed the
    // whole case would be a conformance claim this bundle cannot keep.
    expect(a8?.notes).toMatch(/#32/);
    expect(a8?.notes).toMatch(/platform/i);
  });

  it('maps A11 to the static rebuild check the CLI already runs', () => {
    expect(plan().cases.find((entry) => entry.caseId === 'A11')?.command).toEqual(['fde', 'verify', '--case', 'A11']);
  });

  it('ships every fixture a case reads', () => {
    const shipped = new Set(plan().generatedFiles.map((entry) => entry.path));
    const referenced = plan().cases.flatMap((entry) => entry.fixtures);

    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((fixture) => !shipped.has(fixture))).toEqual([]);
    for (const entry of plan().cases.filter((candidate) => candidate.tier === 'smoke')) {
      // `node [--flag] <script>` — the script is the first argument that is not a flag.
      const script = entry.command.find((part) => part.endsWith('.mjs'));
      expect(shipped.has(script ?? ''), JSON.stringify(entry.command)).toBe(true);
    }
  });

  it('emits sorted, mode-explicit, deterministic bundle files', () => {
    const generated = plan().generatedFiles;
    const paths = generated.map((entry) => entry.path);

    expect(paths).toEqual([...paths].sort());
    expect(generated.every((entry) => entry.mode === 0o644)).toBe(true);
    expect(JSON.stringify(mastraGenerator.generateContractTests(generateInput()))).toBe(JSON.stringify(plan()));
  });
});

describe('the emitted assets', () => {
  it('the smoke script is valid ESM', () => {
    // The bundle seam writes the app tree and the contract-test assets together, so
    // the script is checked where it will actually live.
    const tree = materialize();
    try {
      expect(() =>
        execFileSync(process.execPath, ['--check', join(tree.bundle, 'contract-tests/run-api-smoke.mjs')], {
          stdio: 'pipe',
        }),
      ).not.toThrow();
    } finally {
      tree.cleanup();
    }
  });

  it('the identity smoke script is valid ESM and passes against the bundle it ships in', () => {
    // `tmp`, not `cache`: the script imports the app's `.ts` sources, and Node refuses
    // type stripping under `node_modules` — the same situation as the container.
    const tree = materialize(undefined, { location: 'tmp' });
    try {
      const script = join(tree.bundle, 'contract-tests/identity-smoke.mjs');
      expect(() => execFileSync(process.execPath, ['--check', script], { stdio: 'pipe' })).not.toThrow();

      const output = execFileSync(process.execPath, ['--experimental-strip-types', script], {
        cwd: tree.bundle,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      expect(output).toContain('A8: ok');
    } finally {
      tree.cleanup();
    }
  });

  it('the parity fixture lists the operations, statuses and event types the case asserts', () => {
    const parity = JSON.parse(file(plan().generatedFiles, 'contract-tests/fixtures/run-api-parity.json').content) as {
      capabilities: string[];
      operations: Array<{ operationId: string; method: string; path: string; success: number[] }>;
      eventTypes: string[];
      errorCodes: Record<string, { status: number; retryable: boolean }>;
    };

    expect(parity.capabilities).toEqual(['document-triage']);

    expect(parity.operations.map((operation) => operation.operationId)).toEqual([
      'createRun',
      'getRun',
      'streamRun',
      'cancelRun',
    ]);
    expect(parity.operations.map((operation) => [operation.method, operation.path])).toEqual([
      ['post', '/v1/runs'],
      ['get', '/v1/runs/{run_id}'],
      ['get', '/v1/runs/{run_id}/stream'],
      ['post', '/v1/runs/{run_id}/cancel'],
    ]);
    expect(parity.operations.map((operation) => operation.success)).toEqual([[201], [200], [200], [202]]);
    expect(parity.eventTypes).toEqual([
      'run.started',
      'text.delta',
      'text.done',
      'tool.call',
      'tool.result',
      'run.finished',
      'run.failed',
      'run.cancelled',
      'heartbeat',
    ]);
    expect(parity.errorCodes['idempotency_conflict']).toEqual({ status: 409, retryable: false });
    expect(parity.errorCodes['validation_failed']).toEqual({ status: 422, retryable: false });
    expect(parity.errorCodes['unavailable']).toEqual({ status: 503, retryable: true });
  });

  it('the fixture is canonical JSON, so two builds diff to nothing', () => {
    const body = file(plan().generatedFiles, 'contract-tests/fixtures/run-api-parity.json').content;
    const parsed = JSON.parse(body) as Record<string, unknown>;

    expect(body.endsWith('}\n')).toBe(true);
    expect(body).not.toMatch(/\r/);
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
  });
});
