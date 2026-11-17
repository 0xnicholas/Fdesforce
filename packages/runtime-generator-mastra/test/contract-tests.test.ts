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
import { ERROR_CODES } from '../src/run-api.js';
import { generateInput } from './support/fixtures.js';
import { materialize } from './support/generated-app.js';

const plan = () => mastraGenerator.generateContractTests(generateInput());

const file = (files: ReadonlyArray<GeneratedFile>, path: string): GeneratedFile => {
  const found = files.find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error(`${path} was not generated; got:\n${files.map((entry) => entry.path).join('\n')}`);
  return found;
};

describe('the A-case plan', () => {
  it('maps the cases this slice can satisfy: handshake, Run API, SSE envelope, identity and determinism', () => {
    expect(plan().cases.map((entry) => [entry.caseId, entry.tier])).toEqual([
      ['A1', 'smoke'],
      ['A2', 'smoke'],
      ['A5', 'smoke'],
      ['A8', 'smoke'],
      ['A11', 'static'],
    ]);
  });

  it('does not claim cases the slice does not generate', () => {
    const claimed = new Set(plan().cases.map((entry) => entry.caseId));

    // A3/A4 are HITL and record-before-act, A6 restart resume, A7 approval expiry,
    // A9 extension load, A10 offline install, A12 memory.
    for (const caseId of ['A3', 'A4', 'A6', 'A7', 'A9', 'A10', 'A12'] as const) {
      expect(claimed.has(caseId)).toBe(false);
    }
  });

  it('runs the HTTP cases through one emitted script, A1 and A8 through the modules they assert', () => {
    const cases = plan().cases.filter((entry) => entry.tier === 'smoke');

    expect(cases.map((entry) => entry.command)).toEqual([
      ['node', '--experimental-strip-types', 'contract-tests/runtime-info-smoke.mjs'],
      ['node', 'contract-tests/run-api-smoke.mjs', '--case', 'A2'],
      ['node', 'contract-tests/run-api-smoke.mjs', '--case', 'A5'],
      ['node', '--experimental-strip-types', 'contract-tests/identity-smoke.mjs'],
    ]);
    expect(cases.map((entry) => entry.fixtures)).toEqual([
      ['contract-tests/fixtures/runtime-info.json', 'contract-tests/fixtures/runtime-info-mismatch.json'],
      ['contract-tests/fixtures/run-api-parity.json'],
      ['contract-tests/fixtures/run-api-parity.json'],
      [],
    ]);
  });

  it('says which part of A1 the bundle can prove, and which is the platform\'s', () => {
    const a1 = plan().cases.find((entry) => entry.caseId === 'A1');

    // C9 spans both sides. This bundle proves the runtime half (the app reports itself
    // and fails closed); that context-service enforces its half is #32's fragment.
    expect(a1?.notes).toMatch(/#32/);
    expect(a1?.notes).toMatch(/runtime_capability_mismatch/);
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

  it('the A1 smoke script is valid ESM and refuses every mismatch in the fixture', () => {
    // The fail-closed half needs no deployment: a build that is not the one the lock
    // describes refuses before it speaks to a peer. So the case is executed here, and
    // the fixture it reads is the one the bundle ships.
    const tree = materialize(undefined, { location: 'tmp' });
    try {
      const script = join(tree.bundle, 'contract-tests/runtime-info-smoke.mjs');
      expect(() => execFileSync(process.execPath, ['--check', script], { stdio: 'pipe' })).not.toThrow();

      const output = execFileSync(process.execPath, ['--experimental-strip-types', script], {
        cwd: tree.bundle,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      expect(output).toContain('A1: ok');
      expect(output).not.toContain('FAIL');
    } finally {
      tree.cleanup();
    }
  });

  it('the A1 fixture peers with context-service, reporting only itself', () => {
    const peer = JSON.parse(file(plan().generatedFiles, 'contract-tests/fixtures/runtime-info.json').content) as {
      service: string;
      contract_version: string;
      graph_schema_version: string;
      audit_schema_version: string;
      runtime?: unknown;
      capability_details?: unknown;
      components: Array<{ name: string }>;
      started_at: string;
    };
    const lock = generateInput().lock;

    expect(peer.service).toBe('context-service');
    expect(peer.contract_version).toBe(lock.runtime.contractVersion);
    expect(peer.graph_schema_version).toBe(String(lock.runtime.graphSchema));
    expect(peer.audit_schema_version).toBe(String(lock.runtime.auditSchema));
    // §9.1: it does not report a runtime descriptor or capabilities — it does not read
    // the Profile — so the app has to aggregate the two documents to answer.
    expect(peer.runtime).toBeUndefined();
    expect(peer.capability_details).toBeUndefined();
    expect(peer.components.map((component) => component.name)).toEqual(['context-service', 'graph-store', 'audit-store']);
    expect(peer.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('the A1 mismatch fixture names codes the contract declares, non-retryable and 503', () => {
    const mismatches = JSON.parse(
      file(plan().generatedFiles, 'contract-tests/fixtures/runtime-info-mismatch.json').content,
    ) as {
      cases: Array<{
        name: string;
        expect: { code: string; reason: string };
        peer?: unknown;
        build?: unknown;
        peerStatus?: number;
      }>;
    };

    expect(mismatches.cases.length).toBeGreaterThanOrEqual(12);
    for (const entry of mismatches.cases) {
      // A1's mismatch codes are the contract's error table: 503, and non-retryable
      // because a mismatch is not a transient condition a client should retry (§9.3).
      expect(['contract_mismatch', 'runtime_capability_mismatch']).toContain(entry.expect.code);
      expect(ERROR_CODES[entry.expect.code]).toEqual({ status: 503, retryable: false });
      expect(entry.expect.reason).toMatch(/^[a-z0-9_]+$/);
      // One mutation each: a case with both sides changed would not say which check fired.
      const mutated = [entry.peer, entry.build, entry.peerStatus].filter((side) => side !== undefined);
      expect(mutated).toHaveLength(1);
    }

    // Every check §9.3 lists, one case each.
    const reasons = mismatches.cases.map((entry) => entry.expect.reason);
    for (const reason of [
      'contract_major_mismatch',
      'graph_schema_mismatch',
      'audit_schema_mismatch',
      'context_service_identity',
      'runtime_info_invalid',
      'runtime_info_missing',
      'runtime_profile_mismatch',
      'runtime_version_mismatch',
      'runtime_family_mismatch',
      'runtime_language_mismatch',
      'runtime_generator_mismatch',
      'runtime_state_store_mismatch',
      'runtime_capability_missing',
      'runtime_capability_degraded',
      'runtime_license_blocked',
    ]) {
      expect(reasons, reason).toContain(reason);
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
      'getRuntimeInfo',
      'healthz',
      'readyz',
    ]);
    expect(parity.operations.map((operation) => [operation.method, operation.path])).toEqual([
      ['post', '/v1/runs'],
      ['get', '/v1/runs/{run_id}'],
      ['get', '/v1/runs/{run_id}/stream'],
      ['post', '/v1/runs/{run_id}/cancel'],
      ['get', '/v1/runtime-info'],
      ['get', '/healthz'],
      ['get', '/readyz'],
    ]);
    expect(parity.operations.map((operation) => operation.success)).toEqual([
      [201],
      [200],
      [200],
      [202],
      [200],
      [200],
      [200],
    ]);
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
