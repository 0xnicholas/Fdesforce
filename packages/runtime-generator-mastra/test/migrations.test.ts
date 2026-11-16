// Seam: `mastraGenerator.generateMigrations` — the runtime-owned state migration.
//
// The migration plan is what the deployer runs before the app starts (contract
// §9.2). It has to name the same command the topology's `runtime-migrate` job
// runs, and it has to carry the schema version the Runtime Profile declares: a
// plan that migrates the store to a schema the app was not built for is a startup
// failure that the build could have caught.
import { describe, expect, it } from 'vitest';

import { mastraGenerator } from '../src/index.js';
import { generateInput, mutatedGenerateInput } from './support/fixtures.js';

const plan = () => mastraGenerator.generateMigrations(generateInput());

describe('the runtime migration plan', () => {
  it('has exactly one forward-only runtime step', () => {
    expect(plan()).toEqual({
      steps: [
        {
          id: 'runtime-state',
          owner: 'runtime',
          phase: 'runtime-state',
          reversible: false,
          command: ['node', '--experimental-strip-types', 'src/migrate.ts'],
          dependsOn: [],
          schemaVersion: '1',
        },
      ],
    });
  });

  it('carries the schema version the Runtime Profile declares', () => {
    const input = mutatedGenerateInput((draft) => {
      draft['profile'].spec.capabilities.stateStore.schemaVersion = '2';
      draft['environment'].stateStore = { kind: 'sqlite', schemaVersion: '2' };
    });

    expect(mastraGenerator.generateMigrations(input).steps[0]?.schemaVersion).toBe('2');
  });

  it('names the same command and step the topology job runs', () => {
    const topology = mastraGenerator.generateTopology(generateInput());
    const [step] = topology.spec.jobs[0]?.steps ?? [];
    const [migration] = plan().steps;

    expect(migration?.id).toBe(step?.id);
    expect(migration?.command).toEqual(step?.command);
    expect(topology.spec.startupOrder[0]).toBe(topology.spec.jobs[0]?.name);
  });

  it('leaves context-service migrations to the platform', () => {
    // One owner per schema: a generator that emitted graph/audit statements would
    // own a schema it never reads.
    expect(plan().steps.every((step) => step.owner === 'runtime' && step.phase === 'runtime-state')).toBe(true);
  });

  it('is byte-identical for the same input', () => {
    expect(JSON.stringify(mastraGenerator.generateMigrations(generateInput()))).toBe(JSON.stringify(plan()));
  });

  it('refuses a Spec the gate rejects, like every other generate method', () => {
    const input = mutatedGenerateInput((draft) => {
      draft['spec']['spec']['tools']['claims-lookup'].sideEffects = 'write';
    });

    expect(() => mastraGenerator.generateMigrations(input)).toThrow(/runtime_grammar_unsupported/);
    expect(() => mastraGenerator.generateTopology(input)).toThrow(/runtime_grammar_unsupported/);
  });
});
