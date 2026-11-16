// Seam: document parsing. Every test asserts on diagnostics, never on Zod
// internals — the codes, paths and remediation survive any parser rewrite.
import { describe, expect, it } from 'vitest';

import {
  parseBundleTopology,
  parseModelProfile,
  parseRuntimeProfile,
  parseSolutionLock,
  parseSolutionSpec,
} from '../src/index.js';

const minimalSpec = {
  apiVersion: 'fde.dev/v0',
  kind: 'SolutionSpec',
  metadata: { customer: 'acme', solution: 'claims-triage' },
  spec: {
    capabilities: {
      'document-triage': {
        template: 'document-triage@^1.0.0',
        implementation: { type: 'workflow', ref: 'document-triage-flow' },
      },
    },
    build: { runtimeProfile: 'mastra-1.83-node22@^1.0.0' },
  },
};

type Loose = Record<string, unknown>;

/** The minimal Spec with its `spec` section patched, ready to be parsed. */
const specWith = (patch: (spec: Loose) => void): unknown => {
  const spec = structuredClone(minimalSpec.spec) as Loose;
  patch(spec);
  return { ...minimalSpec, spec };
};

const approvalStep = (overrides: Loose = {}): Loose => ({
  id: 'gate',
  type: 'approval',
  gates: 'commit',
  approverRoles: ['claims-supervisor'],
  expiresAfter: 'PT24H',
  evidenceFrom: ['context'],
  ...overrides,
});

const pathOf = (errors: ReadonlyArray<{ path?: string }>): string[] =>
  errors.map((error) => error.path ?? '');

describe('Solution Spec grammar', () => {
  it('accepts a minimal Spec and keeps it unmodified', () => {
    const result = parseSolutionSpec(minimalSpec);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.spec.capabilities['document-triage']).toBeDefined();
  });

  it('rejects unknown fields instead of dropping them', () => {
    const result = parseSolutionSpec(
      specWith((spec) => {
        spec['capabilties'] = {};
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.code)).toContain('solution_spec_invalid');
      expect(pathOf(result.errors)).toContain('spec');
      expect(result.errors.find((error) => error.path === 'spec')?.remediation).toMatch(/unknown field/i);
    }
  });

  it('rejects an unknown workflow step type', () => {
    const result = parseSolutionSpec(
      specWith((spec) => {
        spec['workflows'] = { flow: { steps: [{ id: 'a', type: 'branch' }] } };
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(pathOf(result.errors)).toContain('spec.workflows.flow.steps[0].type');
  });

  it('rejects a platform role reused as an approval business role', () => {
    const result = parseSolutionSpec(
      specWith((spec) => {
        spec['workflows'] = { flow: { steps: [approvalStep({ approverRoles: ['approver'] })] } };
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(pathOf(result.errors)).toContain('spec.workflows.flow.steps[0].approverRoles[0]');
      expect(result.errors.some((error) => /platform role/.test(error.message))).toBe(true);
      expect(result.errors.find((error) => /platform role/.test(error.message))?.remediation).toMatch(/business role/i);
    }
  });

  it('rejects duplicate approver roles', () => {
    const result = parseSolutionSpec(
      specWith((spec) => {
        spec['workflows'] = {
          flow: { steps: [approvalStep({ approverRoles: ['claims-supervisor', 'claims-supervisor'] })] },
        };
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(pathOf(result.errors)).toContain('spec.workflows.flow.steps[0].approverRoles');
  });

  it('rejects an approval gate that expires "immediately"', () => {
    const result = parseSolutionSpec(
      specWith((spec) => {
        spec['workflows'] = { flow: { steps: [approvalStep({ expiresAfter: 'PT' })] } };
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(pathOf(result.errors)).toContain('spec.workflows.flow.steps[0].expiresAfter');
  });

  it('requires an operation when a tool is connector-backed', () => {
    const result = parseSolutionSpec(
      specWith((spec) => {
        spec['tools'] = { 'claims-lookup': { connectorRef: 'claims-db', sideEffects: 'read' } };
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(pathOf(result.errors)).toContain('spec.tools.claims-lookup.operation');
  });

  it('accepts a side-effecting tool without audit here; that is a build gate', () => {
    // Audit and rate limit are governance gates enforced by `checkSolution`
    // (#21 D5), not document grammar: a Tool may be described and still fail build.
    const result = parseSolutionSpec(
      specWith((spec) => {
        spec['tools'] = {
          'claim-decision': { connectorRef: 'claims-db', operation: 'recordDecision', sideEffects: 'write' },
        };
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('requires an embedding profile once long-term recall is semantic', () => {
    const result = parseSolutionSpec(
      specWith((spec) => {
        spec['agents'] = {
          'triage-agent': {
            modelProfile: 'standard@^1.0.0',
            memory: { longTerm: { write: 'explicit', recall: 'semantic' } },
          },
        };
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(pathOf(result.errors)).toContain(
        'spec.agents.triage-agent.memory.longTerm.embeddingProfile',
      );
    }
  });

  it('rejects build.targets mixed with the #17 platform/delivery split', () => {
    const result = parseSolutionSpec(
      specWith((spec) => {
        spec['build'] = { runtimeProfile: 'mastra-1.83-node22@^1.0.0', platform: 'compose', targets: ['compose'] };
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(pathOf(result.errors)).toContain('spec.build.targets');
  });
});

describe('solution.lock shape', () => {
  const lock = {
    lockVersion: 1,
    spec: { digest: `sha256:${'a'.repeat(64)}`, files: { 'solution.yaml': `sha256:${'b'.repeat(64)}` } },
    templates: { policy: { 'pii-redaction': `1.0.0@sha256:${'c'.repeat(64)}` } },
    runtime: {
      profile: `mastra-1.83-node22@1.0.0@sha256:${'e'.repeat(64)}`,
      contractVersion: '1.4.0',
      graphSchema: 1,
      auditSchema: 1,
      mastra: '1.83.0',
      node: '22.13.0',
      python: '3.12.2',
      semantica: '0.7.0',
      contextService: '0.1.0',
    },
    toolchain: { generator: '0.1.0', image: `ghcr.io/acme-fde/toolchain@sha256:${'d'.repeat(64)}` },
  };

  it('accepts exact pins only', () => {
    expect(parseSolutionLock(lock).ok).toBe(true);

    const floating = {
      ...lock,
      templates: { policy: { 'pii-redaction': '^1.0.0' } },
    };
    expect(parseSolutionLock(floating).ok).toBe(false);
  });

  it('rejects a runtime pin with no digest anywhere', () => {
    const digestless = { ...lock, runtime: { ...lock.runtime, profile: 'mastra-1.83-node22@1.0.0' } };
    const result = parseSolutionLock(digestless);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(pathOf(result.errors)).toContain('runtime.profile');
  });

  it('rejects a profileDigest that disagrees with the folded digest', () => {
    const conflicting = {
      ...lock,
      runtime: { ...lock.runtime, profileDigest: `sha256:${'f'.repeat(64)}` },
    };

    expect(parseSolutionLock(conflicting).ok).toBe(false);
  });

  it('rejects a file path that escapes the Spec directory', () => {
    const escaping = {
      ...lock,
      spec: { ...lock.spec, files: { '../../etc/passwd': `sha256:${'b'.repeat(64)}` } },
    };

    expect(parseSolutionLock(escaping).ok).toBe(false);
  });
});

describe('Runtime Profile and Capabilities', () => {
  const capabilities = {
    durableWorkflow: { support: 'native', durabilityModes: ['sync'], autoResume: 'native' },
    hitl: {
      support: 'native',
      interrupt: 'native',
      resume: 'native',
      approvalResource: 'adapter',
      expiry: 'adapter',
      multipleInterrupts: 'native',
      consume: 'adapter',
    },
    streaming: { support: 'native', tokenStream: 'native', toolEvents: 'native', interruptEvents: 'adapter', transport: 'native' },
    observability: { support: 'native', otel: 'native', evalHooks: 'native' },
    memory: { support: 'native', thread: 'native', longTerm: 'native', ttl: 'adapter' },
    tools: { support: 'native', native: 'native', mcp: 'adapter', connectorOperations: 'adapter' },
    extensions: { support: 'adapter', artifactKinds: ['ts-package'] },
    stateStore: { support: 'native', kinds: ['sqlite'], schemaVersion: '1', encryption: 'adapter', retention: 'adapter' },
    topology: { support: 'native', modes: ['split'], singleWriter: true },
    offline: { support: 'native' },
  };

  const profile = {
    apiVersion: 'fde.dev/v0',
    kind: 'RuntimeProfile',
    metadata: { name: 'mastra-1.83-node22', version: '1.0.0' },
    spec: {
      generator: { name: 'mastra', version: '1.0.0' },
      family: 'mastra',
      language: 'typescript',
      runtimeVersion: '1.83.0',
      contractVersion: '1.4.0',
      packages: { '@mastra/core': '1.83.0', node: '22.13.0' },
      capabilities,
      licensing: { runtime: 'Apache-2.0', requiresLicenseKey: false, egress: false },
    },
  };

  /** The valid profile with its `spec` section patched. */
  const profileWith = (patch: (spec: Loose) => void): unknown => {
    const spec = structuredClone(profile.spec) as Loose;
    patch(spec);
    return { ...profile, spec };
  };

  it('accepts a profile whose groups cover the ten capabilities', () => {
    expect(parseRuntimeProfile(profile).ok).toBe(true);
  });

  it('rejects a degraded group that hides what is lost', () => {
    const result = parseRuntimeProfile(
      profileWith((spec) => {
        spec['capabilities'] = { ...capabilities, hitl: { ...capabilities.hitl, support: 'degraded' } };
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(pathOf(result.errors)).toContain('spec.capabilities.hitl.limitations');
  });

  it('rejects a floating package pin', () => {
    const result = parseRuntimeProfile(
      profileWith((spec) => {
        spec['packages'] = { '@mastra/core': '^1.83.0' };
      }),
    );

    expect(result.ok).toBe(false);
  });

  it('rejects an unknown capability group', () => {
    const result = parseRuntimeProfile(
      profileWith((spec) => {
        spec['capabilities'] = { ...capabilities, telepathy: { support: 'native' } };
      }),
    );

    expect(result.ok).toBe(false);
  });
});

describe('Model Profile rules', () => {
  const chat = {
    apiVersion: 'fde.dev/v0',
    kind: 'ModelProfile',
    metadata: { name: 'standard', version: '1.2.0', owner: 'platform' },
    spec: {
      kind: 'chat',
      provider: 'azure-openai',
      model: 'gpt-5.1',
      modelVersion: '2026-10-01',
      compatibility: { runtimeContract: 'fde.runtime/v1', specMajor: 'v0' },
    },
  };

  /** The valid chat profile with its `spec` section patched. */
  const chatWith = (patch: (spec: Loose) => void): unknown => {
    const spec = structuredClone(chat.spec) as Loose;
    patch(spec);
    return { ...chat, spec };
  };

  it('accepts a pinned chat profile', () => {
    expect(parseModelProfile(chat).ok).toBe(true);
  });

  it('rejects a floating model version', () => {
    const result = parseModelProfile(
      chatWith((spec) => {
        spec['modelVersion'] = 'latest';
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(pathOf(result.errors)).toContain('spec.modelVersion');
  });

  it('rejects an embedding profile without dimensions', () => {
    const result = parseModelProfile(
      chatWith((spec) => {
        spec['kind'] = 'embedding';
        spec['modelVersion'] = 'v3';
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(pathOf(result.errors)).toContain('spec.dimensions');
  });
});

describe('Bundle Topology shape', () => {
  const topology = {
    apiVersion: 'fde.dev/v0',
    kind: 'BundleTopology',
    metadata: {
      solution: 'claims-triage',
      revision: 1,
      profile: 'mastra-1.83-node22@1.0.0',
      profileDigest: `sha256:${'a'.repeat(64)}`,
    },
    spec: {
      components: [
        {
          name: 'mastra-app',
          role: 'runtime-app',
          image: { image: 'ghcr.io/acme/fde-mastra@sha256:abc' },
          env: [{ name: 'LOG_LEVEL', value: 'info' }],
        },
      ],
      volumes: [],
      jobs: [],
      startupOrder: ['mastra-app'],
      secretBindings: [],
      deploymentNaming: { componentNameTemplate: 'fde-{{deployment_id}}-{{component}}' },
      networks: [{ name: 'internal', internal: true }],
    },
  };

  /** The valid bundle topology with its `spec` section patched. */
  const topologyWith = (patch: (spec: Loose) => void): unknown => {
    const spec = structuredClone(topology.spec) as Loose;
    patch(spec);
    return { ...topology, spec };
  };

  it('accepts a composed bundle topology', () => {
    expect(parseBundleTopology(topology).ok).toBe(true);
  });

  it('rejects an env var that carries both a value and a secret ref', () => {
    const result = parseBundleTopology(
      topologyWith((spec) => {
        spec['components'] = [
          {
            name: 'mastra-app',
            role: 'runtime-app',
            image: { image: 'ghcr.io/acme/fde-mastra@sha256:abc' },
            env: [{ name: 'TOKEN', value: 'x', secretRef: { store: 'vault', key: 'token' } }],
          },
        ];
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(pathOf(result.errors)).toContain('spec.components[0].env[0]');
  });

  it('rejects a startup order that names a component twice', () => {
    const result = parseBundleTopology(
      topologyWith((spec) => {
        spec['startupOrder'] = ['mastra-app', 'mastra-app'];
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(pathOf(result.errors)).toContain('spec.startupOrder');
  });
});
