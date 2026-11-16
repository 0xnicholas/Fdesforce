// Seam: the generator's build gate (`mastraGenerator.validate`).
//
// The v0 Mastra generator emits a read-only app skeleton. Everything it cannot
// emit must fail the build with an explicit diagnostic — never a silently
// dropped construct and never a degraded stand-in — because the full Acme
// scenario declares an approval gate, a write Tool and a memory declaration, and
// a Spec that carries them must not look buildable in this slice
// (`docs/runtime-adapter.md` §7, #27).
//
// Failures are diagnostics, not exceptions: an expected refusal is data the CLI
// can print, and there is no `--force` to get past it.
import { describe, expect, it } from 'vitest';

import type { RuntimeGenerateInput, RuntimeValidationResult } from '@fde/runtime-generator';

import { mastraGenerator } from '../src/index.js';
import { generateInput, group, mutatedGenerateInput, specBody } from './support/fixtures.js';
import type { Mutable } from './support/fixtures.js';

const codes = (result: RuntimeValidationResult): string[] => result.errors.map((error) => error.code);
const grammarErrors = (result: RuntimeValidationResult) =>
  result.errors.filter((error) => error.code === 'runtime_grammar_unsupported');

/** Insert the full Acme scenario's approval gate between `context` and `triage`. */
const insertApprovalStep = (input: Mutable): void => {
  (specBody(input)['workflows']['document-triage-flow'].steps as Mutable[]).splice(1, 0, {
    id: 'approve',
    type: 'approval',
    gates: 'triage',
    approverRoles: ['claims-adjuster'],
    expiresAfter: 'PT1H',
    evidenceFrom: ['context'],
  });
};

/** The write Tool the full Acme scenario commits through. */
const declareWriteTool = (input: Mutable): void => {
  specBody(input)['tools']['claim-decision'] = {
    connectorRef: 'claims-db',
    operation: 'recordDecision',
    sideEffects: 'write',
  };
};

const withApprovalStep = (): RuntimeGenerateInput => mutatedGenerateInput(insertApprovalStep);

describe('the read-only reference path', () => {
  it('is buildable: no errors and no warnings', () => {
    const result = mastraGenerator.validate(generateInput());

    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.warnings, JSON.stringify(result.warnings, null, 2)).toEqual([]);
    expect(result.requirements.length).toBeGreaterThan(0);
  });

  it('accepts a Connector Extension: context-service loads it, not the generated app', () => {
    const input = generateInput();

    expect(input.extensions?.[0]?.interface).toBe('connector');
    expect(codes(mastraGenerator.validate(input))).toEqual([]);
  });
});

describe('runtime_grammar_unsupported: approval step', () => {
  it('refuses the gate the read-only slice leaves out', () => {
    const result = mastraGenerator.validate(withApprovalStep());
    const [error] = grammarErrors(result);

    expect(error?.path).toBe('spec.workflows.document-triage-flow.steps[1]');
    expect(error?.message).toContain('approval');
    expect(error?.message).toContain('approve');
    expect(error?.remediation).toBeDefined();
  });

  it('is an error, never a warning: the build does not proceed', () => {
    const result = mastraGenerator.validate(withApprovalStep());

    expect(result.warnings.map((warning) => warning.code)).not.toContain('runtime_grammar_unsupported');
    expect(codes(result)).toContain('runtime_grammar_unsupported');
  });
});

describe('runtime_grammar_unsupported: side-effecting Tool', () => {
  it('refuses a declared write Tool: record-before-act is not generated in this slice', () => {
    const result = mastraGenerator.validate(mutatedGenerateInput(declareWriteTool));
    const [error] = grammarErrors(result);

    expect(error?.path).toBe('spec.tools.claim-decision');
    expect(error?.message).toContain('write');
    expect(error?.remediation).toBeDefined();
  });

  it('refuses a workflow tool step that would call a side-effecting Tool', () => {
    const input = mutatedGenerateInput((draft) => {
      declareWriteTool(draft);
      (specBody(draft)['workflows']['document-triage-flow'].steps as Mutable[]).push({
        id: 'commit',
        type: 'tool',
        tool: 'claim-decision',
      });
    });

    const stepError = grammarErrors(mastraGenerator.validate(input)).find((error) => error.path?.includes('.steps['));

    expect(stepError?.path).toBe('spec.workflows.document-triage-flow.steps[2]');
    expect(stepError?.message).toContain('claim-decision');
  });

  it('refuses an "external" side effect, not only a write', () => {
    const input = mutatedGenerateInput((draft) => {
      specBody(draft)['tools']['claims-lookup'].sideEffects = 'external';
    });

    const [error] = grammarErrors(mastraGenerator.validate(input));

    expect(error?.path).toBe('spec.tools.claims-lookup');
    expect(error?.message).toContain('external');
  });
});

describe('runtime_grammar_unsupported: memory declaration', () => {
  it('refuses thread memory, which needs a state store the slice does not wire', () => {
    const input = mutatedGenerateInput((draft) => {
      specBody(draft)['agents']['triage-agent'].memory = { thread: { lastMessages: 20 } };
    });

    const [error] = grammarErrors(mastraGenerator.validate(input));

    expect(error?.path).toBe('spec.agents.triage-agent.memory');
    expect(error?.message).toContain('memory');
    expect(error?.remediation).toBeDefined();
  });

  it('refuses long-term memory too', () => {
    const input = mutatedGenerateInput((draft) => {
      specBody(draft)['agents']['triage-agent'].memory = { longTerm: { write: 'explicit' } };
    });

    const [error] = grammarErrors(mastraGenerator.validate(input));

    expect(error?.path).toBe('spec.agents.triage-agent.memory');
  });
});

describe('runtime_extension_unsupported: an Extension the app would have to load', () => {
  it('refuses a tool-interface Extension: v0 emits no artifact loader', () => {
    const input = mutatedGenerateInput((draft) => {
      (draft['extensions'] as Mutable[])[0] = { ...(draft['extensions'] as Mutable[])[0], interface: 'tool' };
    });

    const result = mastraGenerator.validate(input);
    const [error] = result.errors;

    expect(codes(result)).toEqual(['runtime_extension_unsupported']);
    expect(error?.path).toBe('spec.extensions[0]');
    expect(error?.message).toContain('acme-claims-connector');
    expect(error?.remediation).toBeDefined();
  });

  it('applies the same rule to a capability-level extensionRef', () => {
    const input = mutatedGenerateInput((draft) => {
      (draft['extensions'] as Mutable[])[0] = { ...(draft['extensions'] as Mutable[])[0], interface: 'tool' };
      specBody(draft)['capabilities']['document-triage'].extensionRefs = ['acme-claims-connector@^1.0.0'];
    });

    const result = mastraGenerator.validate(input);

    expect(codes(result)).toEqual(['runtime_extension_unsupported', 'runtime_extension_unsupported']);
    expect(result.errors.map((error) => error.path)).toEqual([
      'spec.extensions[0]',
      'spec.capabilities.document-triage.extensionRefs[0]',
    ]);
  });

  it('accepts a capability-level reference to a connector Extension, like the top-level list', () => {
    const input = mutatedGenerateInput((draft) => {
      specBody(draft)['capabilities']['document-triage'].extensionRefs = ['acme-claims-connector@^1.0.0'];
    });

    expect(codes(mastraGenerator.validate(input))).toEqual([]);
  });

  it('refuses an Extension the build never resolved: nothing can load an unknown artifact', () => {
    const input = mutatedGenerateInput((draft) => {
      draft['extensions'] = [];
    });

    const result = mastraGenerator.validate(input);
    const [error] = result.errors;

    expect(codes(result)).toEqual(['runtime_extension_unsupported']);
    expect(error?.path).toBe('spec.extensions[0]');
    expect(error?.message).toContain('did not resolve');
  });
});

describe('runtime_grammar_unsupported: constructs the generator cannot resolve', () => {
  it('refuses a step whose Tool the Spec does not declare', () => {
    const input = mutatedGenerateInput((draft) => {
      (specBody(draft)['workflows']['document-triage-flow'].steps as Mutable[]).push({
        id: 'lookup',
        type: 'tool',
        tool: 'missing-tool',
      });
    });

    const [error] = grammarErrors(mastraGenerator.validate(input));

    expect(error?.path).toBe('spec.workflows.document-triage-flow.steps[2]');
    expect(error?.message).toContain('missing-tool');
  });

  it('refuses a step whose Agent the Spec does not declare', () => {
    const input = mutatedGenerateInput((draft) => {
      ((specBody(draft)['workflows']['document-triage-flow'].steps as Mutable[])[1] as Mutable).agent =
        'missing-agent';
    });

    const [error] = grammarErrors(mastraGenerator.validate(input));

    expect(error?.path).toBe('spec.workflows.document-triage-flow.steps[1]');
    expect(error?.message).toContain('missing-agent');
  });

  it('refuses a context step whose recipe has no recipeBinding (no budget to bake)', () => {
    const input = mutatedGenerateInput((draft) => {
      ((specBody(draft)['workflows']['document-triage-flow'].steps as Mutable[])[0] as Mutable).recipe =
        'unknown-recipe';
    });

    const [error] = grammarErrors(mastraGenerator.validate(input));

    expect(error?.path).toBe('spec.workflows.document-triage-flow.steps[0]');
    expect(error?.message).toContain('unknown-recipe');
  });

  it('refuses an Agent Tool the Spec does not declare', () => {
    const input = mutatedGenerateInput((draft) => {
      (specBody(draft)['agents']['triage-agent'].tools as string[]).push('missing-tool');
    });

    const [error] = grammarErrors(mastraGenerator.validate(input));

    expect(error?.path).toBe('spec.agents.triage-agent.tools[2]');
    expect(error?.message).toContain('missing-tool');
  });

  it('refuses a Tool that is neither a builtin nor connector-backed', () => {
    const input = mutatedGenerateInput((draft) => {
      specBody(draft)['tools']['scratch'] = { sideEffects: 'read' };
    });

    const [error] = grammarErrors(mastraGenerator.validate(input));

    expect(error?.path).toBe('spec.tools.scratch');
    expect(error?.message).toContain('connectorRef');
  });

  it('refuses a builtin this generator does not know', () => {
    const input = mutatedGenerateInput((draft) => {
      specBody(draft)['tools']['retrieve-context'].builtin = 'web_search';
    });

    const [error] = grammarErrors(mastraGenerator.validate(input));

    expect(error?.path).toBe('spec.tools.retrieve-context.builtin');
    expect(error?.message).toContain('web_search');
  });
});

describe('runtime_grammar_unsupported: identifier collisions', () => {
  it('refuses an Agent and a Workflow that would generate one identifier', () => {
    const input = mutatedGenerateInput((draft) => {
      // `triage-agent` and `triage--agent` both camel-case to `triageAgent`.
      specBody(draft)['workflows']['triage--agent'] = {
        steps: [{ id: 'context', type: 'context', recipe: 'claims-context' }],
      };
    });

    const [error] = grammarErrors(mastraGenerator.validate(input));

    expect(error?.path).toBe('spec.workflows.triage--agent');
    expect(error?.message).toContain('triageAgent');
  });
});

describe('the gate composes with the shared one', () => {
  it('reports capability errors and grammar errors in one result', () => {
    const input = mutatedGenerateInput((draft) => {
      insertApprovalStep(draft);
      group(draft, 'hitl')['consume'] = 'none';
    });

    const result = mastraGenerator.validate(input);

    expect(codes(result)).toContain('runtime_capability_missing');
    expect(codes(result)).toContain('runtime_grammar_unsupported');
  });

  it('keeps requirements in the result: they are provenance, not only failures', () => {
    const result = mastraGenerator.validate(withApprovalStep());

    expect(result.requirements.map((requirement) => requirement.capability)).toContain('streaming');
  });
});
