// Seam: cross-document validation (`checkSolution`).
//
// This is the port of `prototype/11-solution-spec/inspect.rb`: the checks that
// decide whether two documents agree — references resolve, build inputs are
// pinned, the lock is fresh, approval gates block the right step, side-effecting
// Tools carry evidence and coverage. Tests drive it through its public input, so
// a check can move between modules without rewriting them.
import { describe, expect, it } from 'vitest';

import {
  checkSolution,
  digestFiles,
  parseSolutionLock,
  parseSolutionSpec,
  resolveSchemaPath,
} from '../src/index.js';
import type {
  CheckSolutionInput,
  ConnectorView,
  ContextPackageView,
  RuntimeProfile,
  EvalSuiteView,
  ModelProfile,
  PolicyTemplateView,
  SolutionLock,
  SolutionSpec,
  ValidationReport,
} from '../src/index.js';
import { paths, readSpecFiles, readText, readYaml } from './support/repo.js';

const exampleSpec = (): SolutionSpec => {
  const result = parseSolutionSpec(readYaml(paths.exampleSpec));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
};

const exampleLock = (): SolutionLock => {
  const result = parseSolutionLock(readYaml(paths.exampleLock));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
};

const codes = (report: ValidationReport): string[] => report.errors.map((error) => error.code);

/** The Customer Context Package that both samples bind (`acme-claims-context@^1.0.0`). */
const readContextPackage = (): ContextPackageView => ({
  manifest: readYaml(`${paths.exampleContextPackage}/manifest.yaml`) as ContextPackageView['manifest'],
  recipes: {
    'claims-context': readYaml(`${paths.exampleContextPackage}/recipes/claims-context.yaml`) as NonNullable<
      ContextPackageView['recipes']
    >[string],
  },
});

const exampleTree = (): CheckSolutionInput => {
  const lock = exampleLock();
  return {
    spec: exampleSpec(),
    lock,
    specFiles: readSpecFiles(paths.exampleSpecDir, Object.keys(lock.spec.files)),
    connectors: { 'claims-db': readYaml<ConnectorView>(paths.exampleConnector) },
    modelProfiles: {
      standard: readYaml<ModelProfile>(paths.exampleModelProfile),
      'standard-fallback': readYaml<ModelProfile>(paths.exampleFallbackProfile),
    },
    policies: {},
    evalSuites: { 'claims-triage-quality': readYaml(paths.exampleEvalSuite) as EvalSuiteView },
    contextPackage: readContextPackage(),
    runtimeProfile: readYaml<RuntimeProfile>(paths.exampleRuntimeProfile),
  };
};

/** The full-grammar prototype Spec plus a lock whose digests are real. */
const prototypeTree = (): CheckSolutionInput => {
  const spec = parseSolutionSpec(readYaml(paths.prototypeSpec));
  if (!spec.ok) throw new Error(JSON.stringify(spec.errors));
  const lock = parseSolutionLock(readYaml(paths.prototypeLock));
  if (!lock.ok) throw new Error(JSON.stringify(lock.errors));

  const specFiles = readSpecFiles(paths.prototypeSpecDir, Object.keys(lock.value.spec.files));
  const recomputed = digestFiles(Object.entries(specFiles).map(([path, content]) => ({ path, content })));

  return {
    spec: spec.value,
    lock: { ...lock.value, spec: { digest: recomputed.digest, files: recomputed.files } },
    specFiles,
    connectors: { 'claims-db': readYaml<ConnectorView>(paths.prototypeConnector) },
    modelProfiles: {
      standard: readYaml<ModelProfile>(paths.prototypeModelProfile),
      'standard-fallback': readYaml<ModelProfile>(paths.prototypeFallbackProfile),
    },
    policies: { 'tool-allowlist': readYaml<PolicyTemplateView>(paths.prototypePolicyAllowlist) },
    evalSuites: { 'claims-triage-quality': readYaml(paths.exampleEvalSuite) as EvalSuiteView },
    contextPackage: readContextPackage(),
  };
};

/** Apply a mutation to a deep copy so each test starts from a clean tree. */
const mutate = (input: CheckSolutionInput, change: (tree: CheckSolutionInput) => void): CheckSolutionInput => {
  const copy = structuredClone(input);
  change(copy);
  return copy;
};

describe('Acme read-only example', () => {
  it('reports no errors', () => {
    const report = checkSolution(exampleTree());
    expect(report.errors, JSON.stringify(report.errors, null, 2)).toEqual([]);
  });

  it('warns about the prototype-only `builtin` tool field and nothing else', () => {
    const report = checkSolution(exampleTree());
    expect(report.warnings.map((warning) => warning.code)).toEqual(['builtin_tool_field']);
  });
});

describe('lock freshness', () => {
  it('fails when a Spec file changed after locking', () => {
    const report = checkSolution(
      mutate(exampleTree(), (tree) => {
        tree.specFiles!['files/prompts/triage.md'] = 'changed prompt\n';
      }),
    );

    expect(codes(report)).toEqual(['lock_digest_mismatch', 'lock_digest_mismatch']);
    expect(report.errors.every((error) => error.code === 'lock_digest_mismatch')).toBe(true);
    expect(report.errors.some((error) => error.path === 'spec.files.files/prompts/triage.md')).toBe(true);
    expect(report.errors.some((error) => error.path === 'spec.digest')).toBe(true);
  });

  it('fails when a locked file is missing from the Spec tree', () => {
    const report = checkSolution(
      mutate(exampleTree(), (tree) => {
        delete tree.specFiles!['files/schemas/claims-lookup.output.json'];
      }),
    );

    expect(codes(report)).toContain('lock_file_missing');
    expect(report.errors.find((error) => error.code === 'lock_file_missing')?.path).toBe(
      'spec.files.files/schemas/claims-lookup.output.json',
    );
  });

  it('fails when a referenced file is outside the digest', () => {
    const report = checkSolution(
      mutate(exampleTree(), (tree) => {
        tree.specFiles!['files/prompts/extra.md'] = 'not in the lock\n';
      }),
    );

    expect(codes(report)).toContain('spec_file_unpinned');
  });
});

describe('reference resolution', () => {
  it('fails when the capability implementation does not exist', () => {
    const report = checkSolution(
      mutate(exampleTree(), (tree) => {
        tree.spec.spec.capabilities['document-triage']!.implementation = { type: 'workflow', ref: 'missing-flow' };
      }),
    );

    expect(report.errors.find((error) => error.code === 'unresolved_reference')?.path).toBe(
      'spec.capabilities.document-triage.implementation.ref',
    );
  });

  it('fails when a context step uses an unbound recipe', () => {
    const report = checkSolution(
      mutate(exampleTree(), (tree) => {
        const step = tree.spec.spec.workflows!['document-triage-flow']!.steps[0]!;
        tree.spec.spec.workflows!['document-triage-flow']!.steps[0] = { ...step, recipe: 'kyc-context' } as typeof step;
      }),
    );

    expect(report.errors.find((error) => error.code === 'unresolved_reference')?.path).toBe(
      'spec.workflows.document-triage-flow.steps[0].recipe',
    );
  });

  it('fails when the connector does not allow the tool operation', () => {
    const report = checkSolution(
      mutate(exampleTree(), (tree) => {
        tree.spec.spec.tools!['claims-lookup']!.operation = 'deleteClaim';
      }),
    );

    expect(codes(report)).toContain('connector_operation_not_allowed');
  });

  it('fails when the Runtime Profile artifact no longer matches its pinned digest', () => {
    const report = checkSolution(
      mutate(exampleTree(), (tree) => {
        tree.runtimeProfile!.spec.licensing.egress = true;
      }),
    );

    expect(report.errors.find((error) => error.code === 'lock_digest_mismatch')?.path).toBe('runtime.profile');
  });

  it('fails when the pinned Runtime Profile version is not the artifact version', () => {
    const report = checkSolution(
      mutate(exampleTree(), (tree) => {
        tree.runtimeProfile!.metadata.version = '1.0.1';
      }),
    );

    expect(codes(report)).toEqual(['lock_pin_mismatch', 'lock_digest_mismatch']);
  });

  it('fails when the runtime profile pin leaves the declared range', () => {
    const report = checkSolution(
      mutate(exampleTree(), (tree) => {
        tree.lock.runtime.profile = 'mastra-1.83-node22@2.0.0';
      }),
    );

    // Out of range, and no longer the pinned artifact version either.
    expect(codes(report)).toEqual(['lock_pin_mismatch', 'lock_pin_mismatch']);
    expect(report.errors.map((error) => error.path)).toEqual(['runtime.profile', 'runtime.profile']);
  });

  it('fails when a referenced artifact is not pinned at all', () => {
    const report = checkSolution(
      mutate(exampleTree(), (tree) => {
        tree.spec.spec.capabilities['document-triage']!.policyRefs = ['unpinned-policy@^1.0.0'];
      }),
    );

    expect(report.errors.find((error) => error.code === 'lock_pin_missing')?.path).toBe(
      'spec.capabilities.document-triage.policyRefs[0]',
    );
  });
});

describe('approval grammar (prototype sample)', () => {
  it('accepts the prototype approval chain apart from the pre-#21 rate limit', () => {
    const report = checkSolution(prototypeTree());

    expect(codes(report)).toEqual(['tool_rate_limit_missing']);
    expect(report.errors[0]?.path).toBe('spec.tools.claim-decision.rateLimit');
    expect(report.warnings.map((warning) => warning.code).sort()).toEqual(['build_targets_legacy', 'builtin_tool_field']);
  });

  it('fails when the gate does not block the immediately following step', () => {
    const report = checkSolution(
      mutate(prototypeTree(), (tree) => {
        const steps = tree.spec.spec.workflows!['document-triage-flow']!.steps;
        tree.spec.spec.workflows!['document-triage-flow']!.steps = [steps[0]!, steps[1]!, steps[3]!, steps[2]!];
      }),
    );

    expect(codes(report)).toContain('approval_gate_invalid');
  });

  it('fails when the workflow is not durable', () => {
    const report = checkSolution(
      mutate(prototypeTree(), (tree) => {
        tree.spec.spec.workflows!['document-triage-flow']!.durable = false;
      }),
    );

    expect(codes(report)).toContain('approval_gate_invalid');
  });

  it('fails when the predicate is not bound to the owning capability', () => {
    const report = checkSolution(
      mutate(prototypeTree(), (tree) => {
        tree.spec.spec.capabilities['document-triage']!.policyRefs = ['pii-redaction@^1.0.0'];
      }),
    );

    expect(codes(report)).toContain('approval_gate_invalid');
  });

  it('fails when approval evidence comes from an agent step', () => {
    const report = checkSolution(
      mutate(prototypeTree(), (tree) => {
        const step = tree.spec.spec.workflows!['document-triage-flow']!.steps[2]!;
        if (step.type !== 'approval') throw new Error('expected an approval step');
        step.evidenceFrom = ['triage'];
      }),
    );

    expect(report.errors.find((error) => error.code === 'approval_gate_invalid')?.path).toBe(
      'spec.workflows.document-triage-flow.steps[2].evidenceFrom[0]',
    );
  });

  it('fails when the approver summary path is not a string', () => {
    const report = checkSolution(
      mutate(prototypeTree(), (tree) => {
        const step = tree.spec.spec.workflows!['document-triage-flow']!.steps[2]!;
        if (step.type !== 'approval') throw new Error('expected an approval step');
        step.summaryFrom = { step: 'triage', path: 'output.citedSources' };
      }),
    );

    expect(report.errors.find((error) => error.code === 'approval_gate_invalid')?.path).toBe(
      'spec.workflows.document-triage-flow.steps[2].summaryFrom.path',
    );
  });

  it('fails when a side-effecting tool has no evidence selector', () => {
    const report = checkSolution(
      mutate(prototypeTree(), (tree) => {
        delete tree.spec.spec.capabilities['document-triage']!.audit!.evidence;
      }),
    );

    expect(report.errors.find((error) => error.code === 'audit_evidence_missing')?.path).toBe(
      'spec.capabilities.document-triage.audit.evidence.claim-decision',
    );
  });

  it('fails when the run outcome Decision is omitted for a side-effecting capability', () => {
    const report = checkSolution(
      mutate(prototypeTree(), (tree) => {
        tree.spec.spec.capabilities['document-triage']!.audit!.runOutcomeDecision = 'omitted';
      }),
    );

    expect(report.errors.find((error) => error.code === 'audit_binding_invalid')?.path).toBe(
      'spec.capabilities.document-triage.audit.runOutcomeDecision',
    );
  });

  it('fails when a side-effecting tool declares no audit metadata', () => {
    const report = checkSolution(
      mutate(prototypeTree(), (tree) => {
        delete tree.spec.spec.tools!['claim-decision']!.audit;
      }),
    );

    expect(report.errors.find((error) => error.code === 'tool_audit_missing')?.path).toBe(
      'spec.tools.claim-decision.audit',
    );
  });

  it('fails when no tool.pre_invoke policy covers the side-effecting tool', () => {
    const report = checkSolution(
      mutate(prototypeTree(), (tree) => {
        tree.policies = {};
      }),
    );

    expect(codes(report)).toContain('policy_coverage_missing');
  });

  it('fails when an evidence selector points at a path the step does not output', () => {
    const report = checkSolution(
      mutate(prototypeTree(), (tree) => {
        const evidence = tree.spec.spec.capabilities['document-triage']!.audit!.evidence!['claim-decision']!;
        evidence[1] = { from: 'step', step: 'triage', path: 'output.missingField' };
      }),
    );

    expect(report.errors.find((error) => error.code === 'audit_binding_invalid')?.path).toBe(
      'spec.capabilities.document-triage.audit.evidence.claim-decision[1].path',
    );
  });
});

describe('model profile and memory rules', () => {
  it('fails when the Model Profile artifact version and the lock disagree', () => {
    const report = checkSolution(
      mutate(exampleTree(), (tree) => {
        (tree.modelProfiles!['standard'] as { metadata: { version: string } }).metadata.version = '1.1.0';
      }),
    );

    expect(codes(report)).toContain('lock_pin_mismatch');
  });

  it('accepts thread memory when a durable workflow runs the agent', () => {
    const report = checkSolution(
      mutate(exampleTree(), (tree) => {
        tree.spec.spec.agents!['triage-agent']!.memory = { thread: { lastMessages: 20 } };
      }),
    );

    expect(codes(report)).toEqual([]);
  });

  it('fails when thread memory is used without a durable workflow', () => {
    const report = checkSolution(
      mutate(exampleTree(), (tree) => {
        tree.spec.spec.agents!['triage-agent']!.memory = { thread: { lastMessages: 20 } };
        tree.spec.spec.workflows!['document-triage-flow']!.durable = false;
      }),
    );

    expect(codes(report)).toEqual(['memory_thread_unsupported']);
    expect(report.errors[0]?.path).toBe('spec.agents.triage-agent.memory.thread');
  });

  it('warns when long-term memory opts out of per-user isolation', () => {
    const report = checkSolution(
      mutate(exampleTree(), (tree) => {
        tree.spec.spec.agents!['triage-agent']!.memory = {
          longTerm: { write: 'explicit', recall: 'none', scope: 'agent' },
        };
      }),
    );

    expect(report.warnings.map((warning) => warning.code)).toContain('memory_scope_agent');
  });
});

describe('resolveSchemaPath', () => {
  const schema = {
    type: 'object',
    properties: {
      amount: { type: 'number' },
      citedSources: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' } } } },
    },
  };

  it('resolves properties, array indices and wildcards', () => {
    expect(resolveSchemaPath(schema, 'output.amount')).toEqual({ type: 'number' });
    expect(resolveSchemaPath(schema, 'output.citedSources')).toEqual({ type: 'array', items: { type: 'object', properties: { ref: { type: 'string' } } } });
    expect(resolveSchemaPath(schema, 'output.citedSources[0].ref')).toEqual({ type: 'string' });
    expect(resolveSchemaPath(schema, 'output.citedSources[*].ref')).toEqual({ type: 'string' });
  });

  it('returns undefined for a path the schema does not describe', () => {
    expect(resolveSchemaPath(schema, 'output.nope')).toBeUndefined();
    expect(resolveSchemaPath(schema, 'output.amount.deeper')).toBeUndefined();
  });
});

describe('fixture integrity', () => {
  it('keeps the prototype connector file readable through the example tree', () => {
    expect(readText(paths.exampleConnector)).toContain('allowedOperations');
  });
});
