// Seam: `must / should` derivation (`deriveRequirements`).
//
// `docs/runtime-adapter.md` §7.1 is the table: every construct a Spec can carry
// either needs a runtime capability (`must`) or is worth recording as one
// (`should`). Each requirement keeps its `capability / level / source`, which is
// what `fde build` writes into build provenance — so the source has to point at
// the construct, not at a summary.
import { describe, expect, it } from 'vitest';

import { parseSolutionSpec } from '@fde/spec';
import type { SolutionSpec } from '@fde/spec';

import { deriveRequirements } from '../src/index.js';
import type { RuntimeRequirement } from '../src/index.js';
import { exampleSpec, mutatedSpec, specBody } from './support/fixtures.js';

const rows = (requirements: ReadonlyArray<RuntimeRequirement>): string[] =>
  requirements.map((requirement) => `${requirement.level} ${requirement.capability} <- ${requirement.source}`);

const capabilityPaths = (requirements: ReadonlyArray<RuntimeRequirement>): string[] =>
  requirements.map((requirement) => requirement.capability);

const minimalSpec = (): SolutionSpec => {
  const parsed = parseSolutionSpec({
    apiVersion: 'fde.dev/v0',
    kind: 'SolutionSpec',
    metadata: { customer: 'acme', solution: 'minimal' },
    spec: { capabilities: {}, build: { runtimeProfile: 'mastra-1.83-node22@^1.0.0' } },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
};

describe('requirements the wire contract always implies', () => {
  it('requires streaming and the split topology for a Spec that declares nothing', () => {
    expect(rows(deriveRequirements({ spec: minimalSpec() }))).toEqual([
      'should observability <- build:observability',
      'should offline <- build:offline',
      'must streaming <- contract:fde.runtime/v1#run-api-sse',
      'must topology <- contract:fde.runtime/v1#split-topology',
    ]);
  });
});

describe('requirements the Acme read-only Spec derives', () => {
  it('derives one requirement per construct, with the construct as its source', () => {
    expect(rows(deriveRequirements({ spec: exampleSpec(), environment: { name: 'acme-prod' } }))).toEqual([
      'must durableWorkflow <- spec.workflows.document-triage-flow',
      'must extensions <- spec.extensions',
      'should observability <- build:observability',
      'must offline <- spec.environments.acme-prod.networkClass',
      'must stateStore <- spec.workflows.document-triage-flow',
      'must streaming <- contract:fde.runtime/v1#run-api-sse',
      'must tools.connectorOperations <- spec.tools.claims-lookup',
      'must tools.native <- spec.tools.retrieve-context',
      'must topology <- contract:fde.runtime/v1#split-topology',
    ]);
  });

  it('says what a side-effecting tool adds to the build', () => {
    const spec = mutatedSpec((document) => {
      (specBody(document)['tools'] as Record<string, Record<string, unknown>>)['claims-lookup']!['sideEffects'] =
        'write';
    });

    const requirement = deriveRequirements({ spec }).find(
      (item) => item.capability === 'tools.connectorOperations',
    );

    expect(requirement?.note).toContain('record-before-act');
  });
});

describe('grammar constructs', () => {
  it('requires the five approval paths for an approval step', () => {
    const spec = mutatedSpec((document) => {
      const steps = (specBody(document)['workflows'] as Record<string, Record<string, unknown>>)[
        'document-triage-flow'
      ]!['steps'] as Array<Record<string, unknown>>;
      steps.splice(1, 0, {
        id: 'approve',
        type: 'approval',
        gates: 'triage',
        approverRoles: ['claims-adjuster'],
        expiresAfter: 'PT1H',
        evidenceFrom: ['context'],
      });
    });

    expect(
      rows(deriveRequirements({ spec }).filter((requirement) => requirement.capability.startsWith('hitl'))),
    ).toEqual([
      'must hitl.approvalResource <- spec.workflows.document-triage-flow.steps[1]',
      'must hitl.consume <- spec.workflows.document-triage-flow.steps[1]',
      'must hitl.expiry <- spec.workflows.document-triage-flow.steps[1]',
      'must hitl.interrupt <- spec.workflows.document-triage-flow.steps[1]',
      'must hitl.resume <- spec.workflows.document-triage-flow.steps[1]',
    ]);
  });

  it('requires the memory paths an Agent declares, and the store they persist in', () => {
    const spec = mutatedSpec((document) => {
      const agent = (specBody(document)['agents'] as Record<string, Record<string, unknown>>)['triage-agent']!;
      agent['memory'] = {
        thread: { lastMessages: 20 },
        longTerm: { write: 'explicit', recall: 'semantic', embeddingProfile: 'standard@^1.0.0' },
      };
    });

    expect(
      rows(deriveRequirements({ spec }).filter((requirement) => requirement.capability.startsWith('memory'))),
    ).toEqual([
      'must memory.longTerm <- spec.agents.triage-agent.memory',
      'must memory.thread <- spec.agents.triage-agent.memory',
    ]);
    expect(
      rows(deriveRequirements({ spec }).filter((requirement) => requirement.capability === 'stateStore')),
    ).toContain('must stateStore <- spec.agents.triage-agent.memory');
  });
});

describe('promotion through build.requirements', () => {
  it('makes observability.otel a must, replacing the group-level should', () => {
    const spec = mutatedSpec((document) => {
      specBody(document)['build']['requirements'] = { observability: { otel: 'required' } };
    });

    const requirements = deriveRequirements({ spec });

    expect(rows(requirements).filter((row) => row.includes('observability'))).toEqual([
      'must observability.otel <- spec.build.requirements.observability.otel',
    ]);
  });

  it('promotes offline for an offline bundle without leaving a duplicate should', () => {
    const spec = mutatedSpec((document) => {
      specBody(document)['build']['delivery'] = 'offline-bundle';
      delete specBody(document)['environments'];
    });

    expect(rows(deriveRequirements({ spec })).filter((row) => row.includes('offline'))).toEqual([
      'must offline <- spec.build.delivery',
    ]);
  });

  it('promotes offline for an air-gapped legacy target', () => {
    const spec = mutatedSpec((document) => {
      delete specBody(document)['environments'];
      delete specBody(document)['build']['platform'];
      delete specBody(document)['build']['delivery'];
      specBody(document)['build']['targets'] = ['compose', 'airgap'];
    });

    expect(rows(deriveRequirements({ spec })).filter((row) => row.includes('offline'))).toEqual([
      'must offline <- spec.build.targets',
    ]);
  });

  it('promotes offline when the build declares it required', () => {
    const spec = mutatedSpec((document) => {
      delete specBody(document)['environments'];
      specBody(document)['build']['requirements'] = { offline: true };
    });

    expect(rows(deriveRequirements({ spec })).filter((row) => row.includes('offline'))).toEqual([
      'must offline <- spec.build.requirements.offline',
    ]);
  });
});

describe('determinism', () => {
  it('orders requirements by capability and source, whatever order the Spec declares', () => {
    const withFlows = (order: ReadonlyArray<string>): SolutionSpec =>
      mutatedSpec((document) => {
        const workflows = specBody(document)['workflows'] as Record<string, unknown>;
        for (const name of order) {
          workflows[name] = { durable: true, steps: [{ id: 'context', type: 'context', recipe: 'claims-context' }] };
        }
      });

    const forwards = withFlows(['a-flow', 'z-flow']);
    const backwards = withFlows(['z-flow', 'a-flow']);

    expect(deriveRequirements({ spec: backwards })).toEqual(deriveRequirements({ spec: forwards }));
    expect(capabilityPaths(deriveRequirements({ spec: forwards }))).toEqual(
      [...capabilityPaths(deriveRequirements({ spec: forwards }))].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  });
});
