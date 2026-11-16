// Seam: the checked-in artifacts.
//
// The platform Runtime Profile and the Acme Spec are the reference path
// `fde build` will consume. These tests are what keeps them honest together: the
// artifact declares the ten groups, its own levels agree with its members, and
// every `must` the reference Spec derives is answered by it — including through
// the flat `capability_details` map the generated app will report (#30).
import { describe, expect, it } from 'vitest';

import { CAPABILITY_GROUPS } from '@fde/spec';

import { capabilityDetails, capabilityInconsistencies, capabilitySupport, deriveRequirements } from '../src/index.js';
import { resolveRuntimeProfile } from '../src/index.js';
import { exampleProfile, validationInput } from './support/fixtures.js';

describe('the platform Runtime Profile artifact', () => {
  it('declares every capability group the contract enumerates', () => {
    expect(Object.keys(exampleProfile().spec.capabilities)).toEqual([...CAPABILITY_GROUPS]);
  });

  it('does not let a group level mask one of its members', () => {
    const inconsistencies = capabilityInconsistencies(exampleProfile().spec.capabilities);

    expect(inconsistencies, JSON.stringify(inconsistencies, null, 2)).toEqual([]);
  });
});

describe('the reference path', () => {
  const input = validationInput();
  const resolved = resolveRuntimeProfile(input.profile!);
  const requirements = deriveRequirements({ spec: input.spec, environment: input.environment });

  it('derives the requirements the Slice 1 read-only Spec needs', () => {
    const must = requirements.filter((requirement) => requirement.level === 'must');

    expect(must.map((requirement) => requirement.capability).sort()).toEqual([
      'durableWorkflow',
      'extensions',
      'offline',
      'stateStore',
      'streaming',
      'tools.connectorOperations',
      'tools.native',
      'topology',
    ]);
  });

  it('answers every must with a capability that is neither missing nor degraded', () => {
    const unsatisfied = requirements
      .filter((requirement) => requirement.level === 'must')
      .flatMap((requirement) => {
        const support = capabilitySupport(resolved.capabilities, requirement.capability);
        if (!support.found) return [`${requirement.capability}: not declared`];
        return support.support === 'none' || support.support === 'degraded'
          ? [`${requirement.capability}: ${support.support}`]
          : [];
      });

    expect(unsatisfied).toEqual([]);
  });

  it('reports every must in the flat map the runtime-info handshake sends', () => {
    const details = capabilityDetails(resolved.capabilities);
    const missing = requirements
      .filter((requirement) => requirement.level === 'must')
      .map((requirement) => requirement.capability)
      .filter((capability) => details[capability] === undefined);

    expect(missing).toEqual([]);
  });

  it('profiles a state store the reference Environment selects', () => {
    expect(resolved.capabilities.stateStore.kinds).toContain(input.environment.stateStore?.kind);
    expect(resolved.capabilities.stateStore.schemaVersion).toBe(input.environment.stateStore?.schemaVersion);
  });
});
