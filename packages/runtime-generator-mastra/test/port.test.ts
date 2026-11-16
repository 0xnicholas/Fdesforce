// Seam: the `RuntimeGenerator` port, as this package implements it.
//
// The port is shared by every runtime; a generator that skips a method, renames
// its family or answers `capabilities()` with something the handshake cannot
// report breaks the CLI and the startup check at once. Every `generate*` method
// re-checks the gate and throws rather than emitting an artifact for a Spec the
// build would have refused.
import { describe, expect, it } from 'vitest';

import { resolveRuntimeProfile } from '@fde/runtime-generator';

import { mastraGenerator } from '../src/index.js';
import { exampleProfile, mutatedGenerateInput } from './support/fixtures.js';

describe('identity', () => {
  it('is the mastra family at the version the Runtime Profile pins', () => {
    const profile = exampleProfile();

    expect(mastraGenerator.family).toBe('mastra');
    expect(mastraGenerator.version).toBe(profile.spec.generator.version);
  });
});

describe('capabilities', () => {
  it('is the normalized Profile declaration, before any Spec is read', () => {
    const profile = exampleProfile();

    expect(mastraGenerator.capabilities(profile)).toEqual(resolveRuntimeProfile(profile).capabilities);
  });
});

describe('generation is gated', () => {
  const input = mutatedGenerateInput((draft) => {
    draft['spec']['spec']['agents']['triage-agent'].memory = { thread: { lastMessages: 20 } };
  });

  it.each([
    ['generateApp', () => mastraGenerator.generateApp(input)],
    ['generateTopology', () => mastraGenerator.generateTopology(input)],
    ['generateMigrations', () => mastraGenerator.generateMigrations(input)],
    ['generateContractTests', () => mastraGenerator.generateContractTests(input)],
  ])('%s refuses a Spec the gate rejects', (_name, call) => {
    expect(call).toThrow(/runtime_grammar_unsupported/);
  });
});
