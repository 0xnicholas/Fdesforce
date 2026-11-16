// Seam: the build gate (`validateRuntime`).
//
// `docs/runtime-adapter.md` §7.3 is the fail-closed contract: an expected failure
// is a diagnostic with a stable code, never a thrown exception, and there is no
// `--force` and no waiver to get past it. Tests drive the gate through its public
// input; they assert codes, capability paths and diagnostic paths, not the order
// checks happen to run in.
import { describe, expect, it } from 'vitest';

import { digestOf } from '@fde/spec';

import { validateRuntime } from '../src/index.js';
import type { RuntimeValidationInput, RuntimeValidationResult } from '../src/index.js';
import { validationInput } from './support/fixtures.js';

const codes = (result: RuntimeValidationResult): string[] => result.errors.map((error) => error.code);
const warningCodes = (result: RuntimeValidationResult): string[] => result.warnings.map((warning) => warning.code);

/** Mutate a copy of the reference build input so each test starts from a clean tree. */
const inputWith = (change: (input: RuntimeValidationInput) => void): RuntimeValidationInput => {
  const input = structuredClone(validationInput());
  change(input);
  return input;
};

/** Re-pin the (mutated) Profile, so its content address stays honest. */
const pinned = (input: RuntimeValidationInput): RuntimeValidationInput => {
  const profile = input.profile!;
  input.lock.runtime.profile = `${profile.metadata.name}@${profile.metadata.version}@${digestOf(profile)}`;
  delete input.lock.runtime.profileDigest;
  return input;
};

const withProfile = (change: (input: RuntimeValidationInput) => void): RuntimeValidationInput =>
  pinned(inputWith(change));

/** Insert the approval gate the full Acme scenario has; the read-only slice omits it. */
const withApprovalStep = (change: (input: RuntimeValidationInput) => void = () => {}): RuntimeValidationInput =>
  pinned(
    inputWith((input) => {
      input.spec.spec.workflows!['document-triage-flow']!.steps.splice(1, 0, {
        id: 'approve',
        type: 'approval',
        gates: 'triage',
        approverRoles: ['claims-adjuster'],
        expiresAfter: 'PT1H',
        evidenceFrom: ['context'],
      });
      change(input);
    }),
  );

const otherDigest = `sha256:${'b'.repeat(64)}`;

describe('the reference path', () => {
  it('passes with no errors and nothing to warn about', () => {
    const result = validateRuntime(validationInput());

    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.warnings, JSON.stringify(result.warnings, null, 2)).toEqual([]);
    expect(result.requirements.length).toBeGreaterThan(0);
  });
});

describe('runtime_profile_missing', () => {
  it('fails when no Profile could be resolved, still reporting requirements', () => {
    const result = validateRuntime(inputWith((input) => delete input.profile));

    expect(codes(result)).toEqual(['runtime_profile_missing']);
    expect(result.errors[0]?.path).toBe('spec.build.runtimeProfile');
    expect(result.errors[0]?.remediation).toBeDefined();
    expect(result.requirements.map((requirement) => requirement.capability)).toContain('streaming');
  });

  it('fails when the artifact does not hash to the pinned digest', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.lock.runtime.profile = `mastra-1.83-node22@1.0.0@${otherDigest}`;
      }),
    );

    expect(codes(result)).toEqual(['runtime_profile_missing']);
    expect(result.errors[0]?.message).toContain(otherDigest);
  });

  it('fails when the separate profileDigest does not match', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.lock.runtime.profile = 'mastra-1.83-node22@1.0.0';
        input.lock.runtime.profileDigest = otherDigest;
      }),
    );

    expect(codes(result)).toEqual(['runtime_profile_missing']);
  });

  it('accepts a digest pinned beside the reference rather than folded into it', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.lock.runtime.profileDigest = digestOf(input.profile!);
        input.lock.runtime.profile = 'mastra-1.83-node22@1.0.0';
      }),
    );

    expect(codes(result)).toEqual([]);
  });
});

describe('runtime_profile_mismatch', () => {
  it('fails when the lock pins another version of the artifact', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.lock.runtime.profile = `mastra-1.83-node22@1.0.1@${digestOf(input.profile!)}`;
      }),
    );

    expect(codes(result)).toEqual(['runtime_profile_mismatch']);
    expect(result.errors[0]?.path).toBe('runtime.profile');
  });

  it('fails when the lock pins another runtime family', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.lock.runtime.profile = `langgraph-1.7-node22@1.0.0@${digestOf(input.profile!)}`;
      }),
    );

    expect(codes(result)).toEqual(['runtime_profile_mismatch']);
  });

  it('fails when the Spec asks for a profile version the artifact does not satisfy', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.spec.spec.build.runtimeProfile = 'mastra-1.83-node22@^2.0.0';
      }),
    );

    expect(codes(result)).toEqual(['runtime_profile_mismatch']);
    expect(result.errors[0]?.path).toBe('spec.build.runtimeProfile');
  });

  it('fails when the generator asking is another family', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.generator = { family: 'langgraph', version: '1.0.0' };
      }),
    );

    expect(codes(result)).toEqual(['runtime_profile_mismatch']);
    expect(result.errors[0]?.path).toBe('profile.spec.family');
  });

  it('fails when the generator emits another language than the profile', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.generator = { family: 'mastra', version: '1.0.0', language: 'python' };
      }),
    );

    expect(codes(result)).toEqual(['runtime_profile_mismatch']);
    expect(result.errors[0]?.path).toBe('profile.spec.language');
  });

  it('fails when the generator version is not the one the profile declares', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.generator = { family: 'mastra', version: '2.0.0' };
      }),
    );

    expect(codes(result)).toEqual(['runtime_profile_mismatch']);
    expect(result.errors[0]?.path).toBe('profile.spec.generator.version');
  });

  it('fails when a pinned package disagrees with the lock', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.profile!.spec.packages['@mastra/core'] = '1.84.0';
      }),
    );

    expect(codes(result)).toEqual(['runtime_profile_mismatch']);
    expect(result.errors[0]?.path).toBe('profile.spec.packages.@mastra/core');
  });

  it('fails when the profile contract drifts within the same major', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.profile!.spec.contractVersion = '1.3.0';
      }),
    );

    expect(codes(result)).toEqual(['runtime_profile_mismatch']);
    expect(result.errors[0]?.path).toBe('profile.spec.contractVersion');
  });
});

describe('runtime_contract_mismatch', () => {
  it('fails when the profile speaks another contract major than the lock', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.profile!.spec.contractVersion = '2.0.0';
      }),
    );

    expect(codes(result)).toEqual(['runtime_contract_mismatch']);
    expect(result.errors[0]?.path).toBe('profile.spec.contractVersion');
  });

  it('fails when the lock pins a contract major this port does not speak', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.profile!.spec.contractVersion = '2.0.0';
        input.lock.runtime.contractVersion = '2.0.0';
      }),
    );

    expect(codes(result)).toEqual(['runtime_contract_mismatch']);
    expect(result.errors[0]?.path).toBe('runtime.contractVersion');
  });
});

describe('expected failures are diagnostics, not exceptions', () => {
  it('reports every profile error at once instead of stopping at the first', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.profile!.spec.packages['@mastra/core'] = '1.84.0';
        input.generator = { family: 'langgraph', version: '9.9.9' };
      }),
    );

    expect(codes(result)).toEqual(['runtime_profile_mismatch', 'runtime_profile_mismatch', 'runtime_profile_mismatch']);
  });
});

describe('runtime_capability_missing', () => {
  it('fails a must the profile cannot generate at all', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.profile!.spec.capabilities.streaming.support = 'none';
      }),
    );

    expect(codes(result)).toEqual(['runtime_capability_missing']);
    expect(result.errors[0]?.capability).toBe('streaming');
    expect(result.errors[0]?.remediation).toContain('--force');
  });

  it('fails a required sub-item, pointing at the construct that needs it', () => {
    const result = validateRuntime(
      withApprovalStep((input) => {
        input.profile!.spec.capabilities.hitl.support = 'none';
        (input.profile!.spec.capabilities.hitl as Record<string, unknown>)['consume'] = 'none';
      }),
    );

    expect(codes(result)).toEqual(['runtime_capability_missing']);
    expect(result.errors[0]?.capability).toBe('hitl.consume');
    expect(result.errors[0]?.path).toBe('spec.workflows.document-triage-flow.steps[1]');
  });

  it('does not read "not declared" as "available"', () => {
    const result = validateRuntime(
      withApprovalStep((input) => {
        delete (input.profile!.spec.capabilities.hitl as Record<string, unknown>)['consume'];
      }),
    );

    expect(codes(result)).toEqual(['runtime_capability_missing']);
    expect(result.errors[0]?.capability).toBe('hitl.consume');
  });
});

describe('runtime_capability_degraded', () => {
  it('fails a must the profile can only provide with a declared loss', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.profile!.spec.capabilities.durableWorkflow.support = 'degraded';
        input.profile!.spec.capabilities.durableWorkflow.limitations = ['no resume after a restart'];
      }),
    );

    expect(codes(result)).toEqual(['runtime_capability_degraded']);
    expect(result.errors[0]?.capability).toBe('durableWorkflow');
    expect(result.errors[0]?.message).toContain('no resume after a restart');
  });
});

describe('should requirements warn instead of failing', () => {
  it('warns when a should capability is missing', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.profile!.spec.capabilities.observability.support = 'none';
      }),
    );

    expect(codes(result)).toEqual([]);
    expect(warningCodes(result)).toEqual(['runtime_capability_missing']);
    expect(result.warnings[0]?.capability).toBe('observability');
  });

  it('warns when a should capability is degraded', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.profile!.spec.capabilities.observability.support = 'degraded';
        input.profile!.spec.capabilities.observability.limitations = ['otel-only path unverified'];
        input.profile!.spec.capabilities.observability.otel = 'degraded';
      }),
    );

    expect(codes(result)).toEqual([]);
    expect(warningCodes(result)).toEqual(['runtime_capability_degraded']);
    expect(result.warnings[0]?.message).toContain('otel-only path unverified');
  });

  it('fails once build.requirements promotes the same capability to must', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.spec.spec.build.requirements = { observability: { otel: 'required' } };
        input.profile!.spec.capabilities.observability.support = 'none';
        input.profile!.spec.capabilities.observability.otel = 'none';
      }),
    );

    expect(codes(result)).toEqual(['runtime_capability_missing']);
    expect(result.errors[0]?.capability).toBe('observability.otel');
  });
});

describe('runtime_capability_inconsistent', () => {
  it('fails a satisfied group masking a degraded member', () => {
    const result = validateRuntime(
      withProfile((input) => {
        (input.profile!.spec.capabilities.hitl as Record<string, unknown>)['consume'] = 'degraded';
      }),
    );

    expect(codes(result)).toEqual(['runtime_capability_inconsistent']);
    expect(result.errors[0]?.path).toBe('profile.spec.capabilities.hitl.support');
    expect(result.errors[0]?.message).toContain('hitl.consume');
  });
});

describe('runtime_state_store_unsupported', () => {
  it('fails a state store kind the profile does not provide', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.environment.stateStore = { kind: 'libsql', schemaVersion: '1' };
      }),
    );

    expect(codes(result)).toEqual(['runtime_state_store_unsupported']);
    expect(result.errors[0]?.path).toBe('environment.acme-prod.stateStore.kind');
  });

  it('fails a state store schema the profile does not declare', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.environment.stateStore = { kind: 'sqlite', schemaVersion: '2' };
      }),
    );

    expect(codes(result)).toEqual(['runtime_state_store_unsupported']);
    expect(result.errors[0]?.path).toBe('profile.spec.capabilities.stateStore.schemaVersion');
  });

  it('fails when the Environment and the lock select different stores', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.lock.runtime.stateStore = { kind: 'postgres', schemaVersion: '1' };
      }),
    );

    expect(codes(result)).toEqual(['runtime_state_store_unsupported']);
    expect(result.errors[0]?.path).toBe('environment.acme-prod.stateStore.kind');
  });

  it('accepts a numeric schema version from a legacy lock', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.lock.runtime.stateStore = { kind: 'sqlite', schemaVersion: 1 };
      }),
    );

    expect(codes(result)).toEqual([]);
  });

  it('leaves an environment that selects nothing to the platform default', () => {
    const result = validateRuntime(
      inputWith((input) => {
        delete input.environment.stateStore;
      }),
    );

    expect(codes(result)).toEqual([]);
  });
});

describe('runtime_topology_unsupported', () => {
  it('fails a profile that cannot build the split topology v0 selects', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.profile!.spec.capabilities.topology.modes = ['merged-container'];
      }),
    );

    expect(codes(result)).toEqual(['runtime_topology_unsupported']);
    expect(result.errors[0]?.path).toBe('profile.spec.capabilities.topology.modes');
  });

  it('fails a runtime that needs more than one writer', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.profile!.spec.capabilities.topology.singleWriter = false;
      }),
    );

    expect(codes(result)).toEqual(['runtime_topology_unsupported']);
    expect(result.errors[0]?.path).toBe('profile.spec.capabilities.topology.singleWriter');
  });

  it('warns about modes v0 declares but does not render', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.profile!.spec.capabilities.topology.modes = ['split', 'merged-container'];
      }),
    );

    expect(codes(result)).toEqual([]);
    expect(warningCodes(result)).toEqual(['runtime_topology_unused_mode']);
    expect(result.warnings[0]?.message).toContain('merged-container');
  });
});

describe('runtime_extension_unsupported', () => {
  it('fails an artifact kind the profile cannot load', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.extensions![0]!.artifactKind = 'python-wheel';
      }),
    );

    expect(codes(result)).toEqual(['runtime_extension_unsupported']);
    expect(result.errors[0]?.path).toBe('spec.extensions');
    expect(result.errors[0]?.message).toContain('python-wheel');
  });

  it('fails an artifact that does not support this runtime family and language', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.extensions![0]!.runtimeCompatibility = [{ family: 'langgraph', language: 'python' }];
      }),
    );

    expect(codes(result)).toEqual(['runtime_extension_unsupported']);
    expect(result.errors[0]?.message).toContain('langgraph');
  });

  it('accepts an artifact that declares this runtime combination', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.extensions![0]!.runtimeCompatibility = [{ family: 'mastra', language: 'typescript' }];
      }),
    );

    expect(codes(result)).toEqual([]);
  });
});

describe('runtime_license_blocked', () => {
  it('fails a license key an air-gapped target cannot carry', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.profile!.spec.licensing.requiresLicenseKey = true;
      }),
    );

    expect(codes(result)).toEqual(['runtime_license_blocked']);
    expect(result.errors[0]?.path).toBe('profile.spec.licensing.requiresLicenseKey');
  });

  it('fails egress for a restricted network', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.profile!.spec.licensing.egress = true;
      }),
    );

    expect(codes(result)).toEqual(['runtime_license_blocked']);
    expect(result.errors[0]?.path).toBe('profile.spec.licensing.egress');
  });

  it('does not gate licensing for an online target', () => {
    const result = validateRuntime(
      withProfile((input) => {
        input.environment.networkClass = 'private';
        input.profile!.spec.licensing.egress = true;
        input.profile!.spec.licensing.requiresLicenseKey = true;
      }),
    );

    expect(codes(result)).toEqual([]);
  });
});

describe('runtime_connector_contract_missing', () => {
  it('fails a connector-backed Tool whose Connector is not resolved', () => {
    const result = validateRuntime(
      inputWith((input) => {
        delete input.connectors!['claims-db'];
      }),
    );

    expect(codes(result)).toEqual(['runtime_connector_contract_missing']);
    expect(result.errors[0]?.path).toBe('spec.tools.claims-lookup');
    expect(result.errors[0]?.remediation).toBeDefined();
  });

  it('fails a Tool whose typed operation the Connector does not declare', () => {
    const result = validateRuntime(
      inputWith((input) => {
        delete input.connectors!['claims-db']!.operations['lookupClaim'];
      }),
    );

    expect(codes(result)).toEqual(['runtime_connector_contract_missing']);
    expect(result.errors[0]?.message).toContain('lookupClaim');
  });

  it('warns when neither the Connector nor the Tool declares the operation schema', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.connectors!['claims-db']!.operations['lookupClaim'] = {};
        const tool = input.spec.spec.tools!['claims-lookup']!;
        delete tool.inputSchema;
        delete tool.outputSchema;
      }),
    );

    expect(codes(result)).toEqual([]);
    expect(warningCodes(result)).toEqual(['runtime_connector_operation_untyped']);
  });

  it('accepts a Tool that pins the operation schema itself (GAP-1 today)', () => {
    const result = validateRuntime(
      inputWith((input) => {
        input.connectors!['claims-db']!.operations['lookupClaim'] = {};
      }),
    );

    expect(codes(result)).toEqual([]);
    expect(warningCodes(result)).toEqual([]);
  });
});

describe('runtime_capability_inconsistent', () => {
  it('fails a degraded group that never says what is lost', () => {
    const result = validateRuntime(
      withProfile((input) => {
        const observability = input.profile!.spec.capabilities.observability as Record<string, unknown>;
        observability['support'] = 'degraded';
        observability['otel'] = 'degraded';
        delete observability['limitations'];
      }),
    );

    expect(codes(result)).toEqual(['runtime_capability_inconsistent']);
    expect(result.errors[0]?.message).toContain('lists no limitations');
  });
});

describe('a lock-selected state store', () => {
  it('is checked when the Environment selects none', () => {
    const result = validateRuntime(
      inputWith((input) => {
        delete input.environment.stateStore;
        input.lock.runtime.stateStore = { kind: 'libsql', schemaVersion: '1' };
      }),
    );

    expect(codes(result)).toEqual(['runtime_state_store_unsupported']);
    expect(result.errors[0]?.path).toBe('runtime.stateStore.kind');
  });
});
